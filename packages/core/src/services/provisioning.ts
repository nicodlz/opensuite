import { err, ok, type Result } from "neverthrow";

export interface ProvisionFailure {
  readonly kind: "unavailable" | "disabled" | "forbidden";
  readonly message: string;
}
export interface ProvisioningStore {
  finishDisabled(userId: string): PromiseLike<Result<void, ProvisionFailure>>;
  markDisabled(
    userId: string,
    actorId: string,
  ): PromiseLike<Result<void, ProvisionFailure>>;
  mailboxAccountId(
    userId: string,
  ): PromiseLike<Result<string | null, ProvisionFailure>>;
  prepare(
    userId: string,
  ): PromiseLike<
    Result<{ active: boolean; disabled: boolean }, ProvisionFailure>
  >;
  beginIssuance(
    userId: string,
    account: { accountId: string; address: string },
  ): PromiseLike<Result<void, ProvisionFailure>>;
  activate(
    userId: string,
    account: { accountId: string; address: string },
    credential: { id: string; secret: string },
  ): PromiseLike<Result<void, ProvisionFailure>>;
}
export interface ProvisioningPort {
  ensureAccount(
    userId: string,
  ): PromiseLike<
    Result<{ accountId: string; address: string }, ProvisionFailure>
  >;
  suspend(accountId: string): PromiseLike<Result<void, ProvisionFailure>>;
  revokeApplicationPasswords(
    accountId: string,
  ): PromiseLike<Result<void, ProvisionFailure>>;
  resume(accountId: string): PromiseLike<Result<void, ProvisionFailure>>;
  issue(
    accountId: string,
  ): PromiseLike<Result<{ id: string; secret: string }, ProvisionFailure>>;
}

/** Single-node serialization prevents concurrent recovery for the same user. */
export const createProvisioningService = (
  store: ProvisioningStore,
  port: ProvisioningPort,
) => {
  const pending = new Map<string, Promise<Result<void, ProvisionFailure>>>();
  const ensure = (userId: string): Promise<Result<void, ProvisionFailure>> => {
    const existing = pending.get(userId);
    if (existing !== undefined) return existing;
    const work = async (): Promise<Result<void, ProvisionFailure>> => {
      if (userId.length === 0)
        return err({ kind: "unavailable", message: "invalid user" });
      const state = await store.prepare(userId);
      if (state.isErr()) return err(state.error);
      if (state.value.disabled)
        return err({ kind: "disabled", message: "account disabled" });
      if (state.value.active) return ok(undefined);
      const account = await port.ensureAccount(userId);
      if (account.isErr()) return err(account.error);
      const marked = await store.beginIssuance(userId, account.value);
      if (marked.isErr()) return err(marked.error);
      // Suspend before revoking orphaned credentials; every interrupted stage
      // is safely repeated before issuing a replacement.
      const suspended = await port.suspend(account.value.accountId);
      if (suspended.isErr()) return err(suspended.error);
      const revoked = await port.revokeApplicationPasswords(
        account.value.accountId,
      );
      if (revoked.isErr()) return err(revoked.error);
      const resumed = await port.resume(account.value.accountId);
      if (resumed.isErr()) return err(resumed.error);
      const credential = await port.issue(account.value.accountId);
      if (credential.isErr()) return err(credential.error);
      return store.activate(userId, account.value, credential.value);
    };
    const promise = work().finally(() => {
      pending.delete(userId);
    });
    pending.set(userId, promise);
    return promise;
  };
  const suspend = async (
    userId: string,
  ): Promise<Result<void, ProvisionFailure>> => {
    const inFlight = pending.get(userId);
    if (inFlight !== undefined) await inFlight;
    const accountId = await store.mailboxAccountId(userId);
    if (accountId.isErr()) return err(accountId.error);
    const account =
      accountId.value === null
        ? await port.ensureAccount(userId)
        : ok({ accountId: accountId.value });
    if (account.isErr()) return err(account.error);
    const result = await port.suspend(account.value.accountId);
    if (result.isErr()) return err(result.error);
    return store.finishDisabled(userId);
  };
  const disable = async (
    userId: string,
    actorId: string,
  ): Promise<Result<void, ProvisionFailure>> => {
    const marked = await store.markDisabled(userId, actorId);
    if (marked.isErr()) return err(marked.error);
    return suspend(userId);
  };
  return { ensure, disable, suspend };
};
