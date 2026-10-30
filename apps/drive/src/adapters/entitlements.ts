import { z } from "zod";

const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Entitlement = z.object({
  quotaBytes: Bytes.nullable(),
  mailBytes: Bytes,
  uploadsAllowed: z.boolean(),
});

/** Fail closed if the API cannot supply a complete, validated measurement. */
export const httpEntitlements =
  (origin: string, token: string) => async (owner: string) => {
    const response = await fetch(
      new URL(`/internal/storage/${encodeURIComponent(owner)}`, origin),
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("entitlements unavailable");
    return Entitlement.parse(await response.json());
  };
