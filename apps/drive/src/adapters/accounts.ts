import { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AccountDirectory } from "../domain/accounts.ts";

// The API answers at most this many accounts per request, which keeps the
// query string well below the server's header size limit.
const BATCH = 50;
const Resolved = z.object({ userId: z.string().min(1).max(200).nullable() });
const Addresses = z.object({
  accounts: z
    .array(z.object({ userId: z.string().min(1).max(200), address: z.email() }))
    .max(BATCH),
});

/**
 * Looks accounts up on the API's internal routes with the service token. Any
 * failure is reported, never taken as "no account".
 */
export const httpAccountDirectory = (
  origin: string,
  token: string,
): AccountDirectory => {
  const get = async (path: string, query: Record<string, string>) => {
    const url = new URL(path, origin);
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
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
          Resolved.parse(await get("/internal/accounts/resolve", { address }))
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
                  await get("/internal/accounts/addresses", {
                    userIds: JSON.stringify(
                      wanted.slice(index * BATCH, (index + 1) * BATCH),
                    ),
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
