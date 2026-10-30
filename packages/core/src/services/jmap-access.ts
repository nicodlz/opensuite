import { createHash } from "node:crypto";
import {
  JmapClient,
  type JmapError,
  type JmapResult,
  type Session,
} from "@opensuite/jmap";
import { err, ok, type Result } from "neverthrow";
import type { Actor } from "./accounts.ts";

/** Failures shared by the account-scoped JMAP services (mail, calendar). */
export type AccessFailureKind =
  "forbidden" | "not_found" | "validation" | "conflict" | "unavailable";
export interface MailCredentialStore {
  getForOwner(
    userId: string,
    accountId: string,
  ): PromiseLike<
    Result<
      { accountId: string; address: string; secret: string },
      { kind: string }
    >
  >;
}
class Failure extends Error {
  readonly kind: AccessFailureKind;
  constructor(kind: AccessFailureKind) {
    super(kind);
    this.kind = kind;
  }
}
export const fail = (kind: AccessFailureKind): never => {
  throw new Failure(kind);
};
export function value<T>(result: JmapResult<T>): T {
  if (result.isOk()) return result.value;
  const error: JmapError = result.error;
  if (
    (error.kind === "http" || error.kind === "request") &&
    error.status === 404
  )
    return fail("not_found");
  if (
    (error.kind === "http" || error.kind === "request") &&
    error.status === 403
  )
    return fail("forbidden");
  if (
    (error.kind === "set" || error.kind === "method") &&
    ["notFound", "blobNotFound"].includes(error.type)
  )
    return fail("not_found");
  if (
    (error.kind === "set" || error.kind === "method") &&
    [
      "invalidProperties",
      "invalidArguments",
      "invalidEmail",
      "forbiddenFrom",
      "tooLarge",
    ].includes(error.type)
  )
    return fail("validation");
  if (
    (error.kind === "set" || error.kind === "method") &&
    error.type === "stateMismatch"
  )
    return fail("conflict");
  return fail("unavailable");
}

/**
 * Bounded JMAP work queue plus the actor → Stalwart account mapping. One
 * instance per service; credentials and client instances never leave it.
 */
export function createJmapAccess(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  let active = 0;
  const waiting: (() => void)[] = [];
  const run = async <T>(
    work: () => Promise<T>,
  ): Promise<Result<T, { kind: AccessFailureKind }>> => {
    if (active >= 8) {
      if (waiting.length >= 256) return err({ kind: "unavailable" });
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else active += 1;
    try {
      return ok(await work());
    } catch (error) {
      return err({
        kind: error instanceof Failure ? error.kind : "unavailable",
      });
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
  const sessions = new Map<
    string,
    { expires: number; connection: Promise<Session> }
  >();
  const connect = async (
    actor: Actor,
    accountId: string,
    capability: string,
  ) => {
    const credential = await dependencies.store.getForOwner(
      actor.id,
      accountId,
    );
    if (credential.isErr())
      return fail(
        credential.error.kind === "not_found" ||
          credential.error.kind === "forbidden"
          ? "forbidden"
          : "unavailable",
      );
    if (accountId !== "default" && credential.value.accountId !== accountId)
      return fail("forbidden");
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          actor.id,
          credential.value.accountId,
          credential.value.address,
          credential.value.secret,
        ]),
      )
      .digest("hex");
    const current = now();
    for (const [cachedKey, entry] of sessions)
      if (entry.expires <= current) sessions.delete(cachedKey);
    const client =
      dependencies.client?.(credential.value) ??
      new JmapClient(dependencies.origin, {
        authorization: `Basic ${Buffer.from(`${credential.value.address}:${credential.value.secret}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: dependencies.origin,
      });
    let entry = sessions.get(key);
    if (entry === undefined) {
      const connection = (async () => value(await client.discover()))();
      entry = { expires: current + 30_000, connection };
      if (sessions.size >= 256) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      sessions.set(key, entry);
      void connection.catch(() => {
        if (sessions.get(key)?.connection === connection) sessions.delete(key);
      });
    }
    const session = await entry.connection;
    const id = session.primaryAccounts[capability];
    if (id === undefined) return fail("unavailable");
    return {
      client,
      session,
      id,
      address: credential.value.address,
      owner: actor.id,
    };
  };
  return { run, connect, now };
}
