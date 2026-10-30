import { oc } from "@orpc/contract";
import { z } from "zod";
import { AliasPrefix } from "./aliases.ts";

export const AddressLocalPart = AliasPrefix;
const procedure = oc.errors({
  BAD_REQUEST: { status: 400, message: "Invalid address or domain" },
  RESERVED: { status: 400, message: "This address name is reserved" },
  NOT_FOUND: { status: 404, message: "Address not found" },
  CONFLICT: { status: 409, message: "This address is already taken" },
  ADDRESS_LIMIT_REACHED: { status: 403, message: "Address limit reached" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  SERVICE_UNAVAILABLE: { status: 503, message: "Address service unavailable" },
});
const address = z.object({
  id: z.string(),
  address: z.string(),
  primary: z.boolean(),
  ready: z.boolean(),
  removing: z.boolean(),
  pending: z.boolean(),
});
export const addressesContract = {
  list: procedure
    .route({ method: "GET", path: "/addresses" })
    .input(z.object({}).strict())
    .output(
      z.object({
        addresses: z.array(address),
        limit: z.number().int().nonnegative().nullable(),
        remaining: z.number().int().nonnegative().nullable(),
      }),
    ),
  domains: procedure
    .route({ method: "GET", path: "/addresses/domains" })
    .input(z.object({}).strict())
    .output(z.array(z.object({ id: z.string(), name: z.string() }))),
  create: procedure
    .route({ method: "POST", path: "/addresses" })
    .input(
      z
        .object({ localPart: AddressLocalPart, domainId: z.string().min(1) })
        .strict(),
    )
    .output(address),
  remove: procedure
    .route({ method: "DELETE", path: "/addresses/{id}" })
    .input(z.object({ id: z.string().min(1) }).strict())
    .output(z.object({ removed: z.literal(true) })),
};
