import { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AccountDirectory } from "../domain/accounts.ts";

// The API answers at most this many accounts per request.
const BATCH = 100;
const Resolved = z.object({ userId: z.string().min(1).max(200).nullable() });
const Addresses = z.object({
  accounts: z
    .array(z.object({ userId: z.string().min(1).max(200), address: z.email() }))
    .max(BATCH),
});

/**
 * Looks accounts up on the API's internal routes with the service token.
 * Addresses travel in request bodies so they stay out of URLs and access
 * logs. Any failure is reported, never taken as "no account".
 */
export const httpAccountDirectory = (
  origin: string,
  token: string,
): AccountDirectory => {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("account directory unavailable");
    return response.json();
  };
  return {
    resolve: (address) =>
      ResultAsync.fromPromise(
        (async () =>
          Resolved.parse(await post("/internal/accounts/resolve", { address }))
            .userId)(),
        () => "unavailable" as const,
      ),
    addresses: (userIds) =>
      ResultAsync.fromPromise(
        (async () => {
          const wanted = [...new Set(userIds)];
          const batches = await Promise.all(
            Array.from(
              { length: Math.ceil(wanted.length / BATCH) },
              async (_, index) =>
                Addresses.parse(
                  await post("/internal/accounts/addresses", {
                    userIds: wanted.slice(index * BATCH, (index + 1) * BATCH),
                  }),
                ).accounts,
            ),
          );
          const asked = new Set(wanted);
          return new Map(
            batches
              .flat()
              .filter((account) => asked.has(account.userId))
              .map((account) => [account.userId, account.address]),
          );
        })(),
        () => "unavailable" as const,
      ),
  };
};
