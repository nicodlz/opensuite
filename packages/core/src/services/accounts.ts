import type { Result } from "neverthrow";

export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly role: "admin" | "user";
  /** Internal session identifier; never an authentication token. */
  readonly sessionId?: string;
}
export interface AccountFailure {
  readonly kind: "forbidden" | "unavailable";
  readonly message: string;
}
export interface AccountService {
  mailbox(
    actor: Actor,
    accountId: string,
  ): PromiseLike<
    Result<{ accountId: string; address: string }, AccountFailure>
  >;
  list(actor: Actor): PromiseLike<Result<Actor[], AccountFailure>>;
  disable(
    actor: Actor,
    userId: string,
  ): PromiseLike<Result<void, AccountFailure>>;
}
