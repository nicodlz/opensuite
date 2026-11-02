import type { ResultAsync } from "neverthrow";

/** Accounts of this server, as the application API knows them. */
export interface AccountDirectory {
  /** The enabled account that signs in with `address`, else null. */
  resolve(address: string): ResultAsync<string | null, "unavailable">;
  /** Sign-in addresses of the enabled accounts among `userIds`. */
  addresses(
    userIds: readonly string[],
  ): ResultAsync<ReadonlyMap<string, string>, "unavailable">;
}
