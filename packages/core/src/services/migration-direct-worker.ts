import {
  DirectSourceSchema,
  type DirectConnector,
  type DirectSource,
  type MailImportSnapshot,
  type MailImportTools,
} from "@opensuite/contracts";
import {
  type PrismaClient,
  type SecretBox,
  type createDirectImportStore,
} from "@opensuite/db";
import type { Result } from "neverthrow";
import type { Actor } from "./accounts.ts";
import { fail, type createJmapAccess } from "./jmap-access.ts";
import { DirectProcessor } from "./migration-direct-processing.ts";

export const DirectDetails = DirectSourceSchema.omit({ password: true });
export type DirectStore = ReturnType<typeof createDirectImportStore>;
export type DirectJob = NonNullable<Awaited<ReturnType<DirectStore["get"]>>>;
export type DirectAccess = ReturnType<typeof createJmapAccess>;
export type DirectTarget = Awaited<ReturnType<DirectAccess["connect"]>>;
export type DirectTools = MailImportTools<
  DirectTarget["client"],
  DirectTarget["session"],
  DirectJob,
  Buffer
> & {
  createSnapshot(input: {
    client: DirectTarget["client"];
    session: DirectTarget["session"];
    accountId: string;
    messageIds: readonly string[];
    keepAlive: () => Promise<boolean>;
  }): Promise<Result<MailImportSnapshot, { kind: "unavailable" | "limit" }>>;
  stableEmailChanges(client: DirectTarget["client"]): () => void;
};
export type DirectOptions = Parameters<typeof createJmapAccess>[0] & {
  db: PrismaClient;
  key: string;
  connectSource: DirectConnector;
  tools: DirectTools;
  oauthEnabled?: boolean;
  revokeOAuth?: (token: string) => Promise<boolean>;
};
export type DirectRuntime = {
  options: DirectOptions;
  store: DirectStore;
  box: SecretBox;
  access: DirectAccess;
  account(actor: Actor, accountId: string): Promise<string>;
  secret(job: DirectJob): DirectSource;
};
export function directSecret(runtime: DirectRuntime, job: DirectJob) {
  if (
    !job.sourceConfig ||
    !job.sourceExpiresAt ||
    job.sourceExpiresAt <= new Date()
  )
    return fail("validation");
  const password = runtime.box.decrypt(job.sourceConfig, {
    userId: job.userId,
    id: job.id,
  });
  if (password.isErr()) return fail("unavailable");
  const source = DirectSourceSchema.parse({
    ...DirectDetails.parse(job.sourceDetails),
    password: password.value,
  });
  if (source.authKind === "oauth" && !runtime.options.oauthEnabled)
    return fail("validation");
  return source;
}

const revokeError =
  "Google token revocation unconfirmed; revoke access with Google and retry cancellation or resume.";
export class DirectWorker {
  private readonly runtime: DirectRuntime;
  constructor(runtime: DirectRuntime) {
    this.runtime = runtime;
  }
  private async revoke(job: DirectJob) {
    try {
      return await (this.runtime.options.revokeOAuth?.(
        directSecret(this.runtime, job).password,
      ) ?? Promise.resolve(false));
    } catch {
      return false;
    }
  }
  private isOAuth(job: DirectJob) {
    return (
      job.sourceConfig !== null &&
      DirectDetails.parse(job.sourceDetails).authKind === "oauth"
    );
  }
  private async revokeCancellation(job: DirectJob, token: string) {
    const { store } = this.runtime;
    if (!job.cancelRequested || !this.isOAuth(job) || job.sourceConfig === null)
      return job;
    if (!(await this.revoke(job))) {
      await store.settle(job.id, token, revokeError);
      return null;
    }
    if (!(await store.clearClaimedCredential(job.id, token, job.sourceConfig)))
      return null;
    return (
      (await store.get(job.userId, job.accountId, job.id)) ?? fail("not_found")
    );
  }
  private async settle(job: DirectJob, token: string, deferred: boolean) {
    const { store } = this.runtime;
    const current = await store.get(job.userId, job.accountId, job.id);
    if (!current) return;
    const waiting = current.items.some((item) =>
      ["pending", "importing", "uncertain", "failed"].includes(item.status),
    );
    const needsRevoke =
      this.isOAuth(current) &&
      (current.cancelRequested || (!waiting && current.inventoryReady));
    if (needsRevoke && !(await this.revoke(current))) {
      await store.settle(job.id, token, revokeError);
      return;
    }
    await store.settle(
      job.id,
      token,
      null,
      deferred,
      current.cancelRequested || needsRevoke,
    );
  }
  async work() {
    const { store, access } = this.runtime;
    await store.expire(new Date());
    const claimed = await store.claim(new Date());
    if (!claimed) return false;
    const { token } = claimed;
    try {
      const job = await this.revokeCancellation(claimed.job, token);
      if (!job) return true;
      const result = await access.run(() =>
        new DirectProcessor(this.runtime, job, token).run(),
      );
      if (result.isErr())
        await store.settle(
          job.id,
          token,
          "Source or destination unavailable; check credentials and resume.",
        );
      else if (result.value === "limit")
        await store.settle(
          job.id,
          token,
          "Source inventory exceeds the limit of 100 folders, 1,000 messages, or 3,000 inspected occurrences.",
        );
      else await this.settle(job, token, result.value === "defer");
    } catch {
      await store.settle(
        claimed.job.id,
        token,
        "Migration worker unavailable; resume to retry.",
      );
    }
    return true;
  }
}
