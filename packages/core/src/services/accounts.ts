import type { Result } from "neverthrow";

export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly role: "admin" | "user";
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
