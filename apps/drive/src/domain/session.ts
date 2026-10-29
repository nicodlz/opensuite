import type { ResultAsync } from "neverthrow";

export interface SessionVerifier {
  verify(cookie: string | undefined): ResultAsync<string | null, "unavailable">;
}
