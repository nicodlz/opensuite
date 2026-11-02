import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { ImapFlow } from "imapflow";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { createMigrationSnapshot, type JmapClient } from "@opensuite/jmap";
import { ok } from "neverthrow";
import { migrationMailTools } from "./migration-mail.ts";
import {
  DIRECT_SOURCE_LIMIT,
  DirectSourceRefSchema,
  type DirectConnector,
  type DirectConnection,
  type DirectSource,
  type DirectSourceRef,
} from "@opensuite/contracts";

async function* sequential<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* await Promise.resolve(items);
}

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const policyEntry = z
  .string()
  .transform((entry) => entry.trim().toLowerCase().split(":"))
  .pipe(
    z.tuple([
      z
        .string()
        .regex(hostnamePattern)
        .refine((host) => !isIP(host)),
      z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(1).max(65535)),
    ]),
  )
  .transform(([host, port]) => `${host}:${String(port)}`);
const policyConfig = z
  .string()
  .max(28_000)
  .optional()
  .transform((value) => (value?.trim() ? value.split(",") : []))
  .pipe(z.array(policyEntry).max(100));

/** Exact operator allowlist plus public-address checks and DNS pinning. */
export function directDestinationPolicy(
  value: string | undefined,
  resolve: (
    name: string,
  ) => Promise<readonly { address: string; family: number }[]> = (name) =>
    lookup(name, { all: true, order: "verbatim" }),
) {
  const entries = policyConfig.safeParse(value);
  if (!entries.success) throw new Error("Invalid IMAP destination policy");
  const allowed = new Set(entries.data);
  return async (host: string, port: number) => {
    const name = host.toLowerCase();
    if (
      !hostnamePattern.test(name) ||
      isIP(name) ||
      !allowed.has(`${name}:${String(port)}`)
    )
      throw new Error("Destination denied");
    const addresses = await resolve(name);
    if (
      !addresses.length ||
      addresses.some(({ address }) => {
        const parsed = ipaddr.process(address);
        return parsed.range() !== "unicast";
      })
    )
      throw new Error("Destination denied");
    const chosen = addresses.find(({ address }) => isIP(address) === 4);
    if (!chosen) throw new Error("Destination denied");
    return chosen.address;
  };
}

const MAX_MESSAGES = 1000;
const MAX_FOLDERS = 100;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const sourceLimit = () =>
  Object.assign(new Error("Source inventory limit exceeded"), {
    code: DIRECT_SOURCE_LIMIT,
  });

type FetchedMessage = Exclude<Awaited<ReturnType<ImapFlow["fetchOne"]>>, false>;
class ImapInventory {
  private readonly refs: DirectSourceRef[] = [];
  private readonly byEmailId = new Map<string, DirectSourceRef>();
  private inspected = 0;
  private readonly client: ImapFlow;
  private readonly gmail: boolean;
  constructor(client: ImapFlow, gmail: boolean) {
    this.client = client;
    this.gmail = gmail;
  }
  private remember(ref: DirectSourceRef) {
    const prior =
      this.gmail && ref.emailId !== null
        ? this.byEmailId.get(ref.emailId)
        : undefined;
    if (prior) prior.labels = [...new Set([...prior.labels, ...ref.labels])];
    else {
      this.refs.push(ref);
      if (ref.emailId !== null && this.gmail)
        this.byEmailId.set(ref.emailId, ref);
    }
    if (this.refs.length > MAX_MESSAGES) throw sourceLimit();
  }
  private ref(item: FetchedMessage, path: string, validity: string) {
    if (++this.inspected > MAX_MESSAGES * 3) throw sourceLimit();
    if (!item.uid || item.size === undefined)
      throw new Error("Incomplete source metadata");
    const date =
      item.internalDate === undefined ? null : new Date(item.internalDate);
    return DirectSourceRefSchema.parse({
      mailbox: path,
      validity,
      uid: item.uid,
      size: item.size,
      labels: [...new Set([path, ...(item.labels ?? [])])],
      flags: [...(item.flags ?? [])],
      date:
        date !== null && Number.isFinite(date.getTime())
          ? date.toISOString()
          : null,
      emailId: item.emailId ?? null,
    });
  }
  private async folder(path: string) {
    const mailbox = await this.client.mailboxOpen(path, { readOnly: true });
    if (!mailbox.readOnly) throw new Error("Source is not read-only");
    if (
      mailbox.exists > MAX_MESSAGES ||
      this.refs.length + mailbox.exists > MAX_MESSAGES * 3
    )
      throw sourceLimit();
    if (!mailbox.exists) return;
    for await (const item of this.client.fetch("1:*", {
      uid: true,
      size: true,
      flags: true,
      internalDate: true,
      labels: true,
    }))
      this.remember(this.ref(item, path, mailbox.uidValidity.toString()));
  }
  async read() {
    const folders = (await this.client.list()).filter(
      (folder) => !folder.flags.has("\\Noselect"),
    );
    if (folders.length > MAX_FOLDERS) throw sourceLimit();
    for await (const folder of sequential(folders))
      await this.folder(folder.path);
    return this.refs;
  }
}
class ImapSource implements DirectConnection {
  private readonly client: ImapFlow;
  private readonly gmail: boolean;
  constructor(client: ImapFlow, gmail: boolean) {
    this.client = client;
    this.gmail = gmail;
  }
  inventory() {
    return new ImapInventory(this.client, this.gmail).read();
  }
  async read(ref: DirectSourceRef) {
    if (ref.size > MAX_MESSAGE_BYTES)
      throw new Error("Source message exceeds size limit");
    const mailbox = await this.client.mailboxOpen(ref.mailbox, {
      readOnly: true,
    });
    if (!mailbox.readOnly || mailbox.uidValidity.toString() !== ref.validity)
      throw new Error("Source mailbox changed");
    const result = await this.client.download(String(ref.uid), undefined, {
      uid: true,
      maxBytes: MAX_MESSAGE_BYTES + 1,
    });
    if (!result.content) throw new Error("Source message missing");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const part of result.content) {
      const chunk = z.instanceof(Buffer).parse(part);
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES) {
        result.content.destroy();
        throw new Error("Source message exceeds size limit");
      }
      chunks.push(chunk);
    }
    if (total !== ref.size || total === 0)
      throw new Error("Source message changed");
    return Buffer.concat(chunks, total);
  }
  close() {
    this.client.close();
  }
}
function imapClient(
  source: DirectSource,
  address: string,
  tls?: Pick<ConnectionOptions, "ca">,
) {
  const client = new ImapFlow({
    host: address,
    servername: source.host,
    port: source.port,
    secure: true,
    ...(tls === undefined ? {} : { tls }),
    auth:
      source.authKind === "oauth"
        ? { user: source.username, accessToken: source.password }
        : { user: source.username, pass: source.password },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  client.on("error", () => {});
  return client;
}
/** Only EXAMINE, LIST and PEEK reads are used; no source mutations. */
export function createDirectConnector(
  resolve: (host: string, port: number) => Promise<string>,
  tls?: Pick<ConnectionOptions, "ca">,
): DirectConnector {
  return async (source) => {
    const client = imapClient(
      source,
      await resolve(source.host, source.port),
      tls,
    );
    try {
      await client.connect();
    } catch {
      client.close();
      throw new Error("Source connection failed");
    }
    return new ImapSource(client, source.kind === "gmail");
  };
}

function stableEmailChanges(client: JmapClient) {
  const original = client.emailChanges.bind(client);
  client.emailChanges = async (session, accountId, sinceState) => {
    const result = await original(session, accountId, sinceState);
    if (result.isErr()) return result;
    const page = result.value;
    if (
      !page.hasMoreChanges &&
      !page.created.length &&
      !page.updated.length &&
      !page.destroyed.length &&
      page.newState !== sinceState
    ) {
      const current = await client.emailState(session, accountId);
      if (
        current.isOk() &&
        current.value.accountId === accountId &&
        current.value.state === sinceState
      )
        return ok({ ...page, newState: sinceState });
    }
    return result;
  };
  return () => {
    client.emailChanges = original;
  };
}
export const directMigrationTools = {
  ...migrationMailTools,
  createSnapshot: createMigrationSnapshot,
  stableEmailChanges,
};

/** The URL is fixed; tokens are sent in the POST body and are never logged. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
