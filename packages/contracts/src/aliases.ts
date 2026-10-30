import { oc } from "@orpc/contract";
import { z } from "zod";
import { DomainName } from "./domains.ts";

export const AliasPrefix = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(39)
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/);
export const AliasWebsite = DomainName;
const id = z.object({ id: z.string().min(1) }).strict();
const details = {
  website: AliasWebsite.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
};
const alias = z.object({
  id: z.string(),
  address: z.string(),
  localPart: z.string(),
  domainId: z.string(),
  website: z.string().nullable(),
  note: z.string().nullable(),
  enabled: z.boolean(),
  ready: z.boolean(),
  detachedByDomain: z.boolean(),
  suspended: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const key = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
const procedure = oc.errors({
  BAD_REQUEST: { status: 400, message: "Invalid alias data" },
  NOT_FOUND: { status: 404, message: "Alias not found" },
  CONFLICT: { status: 409, message: "Alias request conflicts" },
  ALIAS_KEY_CAP_REACHED: { status: 429, message: "Alias key limit reached" },
  ALIAS_CAP_REACHED: { status: 429, message: "Alias limit reached" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  SERVICE_UNAVAILABLE: { status: 503, message: "Alias service unavailable" },
});
export const aliasesContract = {
  domains: procedure
    .route({ method: "GET", path: "/aliases/domains" })
    .input(z.object({}).strict())
    .output(z.array(z.object({ id: z.string(), name: z.string() }))),
  list: procedure
    .route({ method: "GET", path: "/aliases" })
    .input(z.object({ search: z.string().max(253).optional() }).strict())
    .output(z.array(alias)),
  create: procedure
    .route({ method: "POST", path: "/aliases" })
    .input(
      z
        .object({
          domainId: z.string().min(1).optional(),
          prefix: AliasPrefix.optional(),
          requestId: z.string().min(1).max(128),
          ...details,
        })
        .strict(),
    )
    .output(alias),
  update: procedure
    .route({ method: "PATCH", path: "/aliases/{id}" })
    .input(id.extend(details).strict())
    .output(alias),
  enable: procedure
    .route({ method: "POST", path: "/aliases/{id}/enable" })
    .input(id)
    .output(alias),
  disable: procedure
    .route({ method: "POST", path: "/aliases/{id}/disable" })
    .input(id)
    .output(alias),
  delete: procedure
    .route({ method: "DELETE", path: "/aliases/{id}" })
    .input(id)
    .output(z.object({ deleted: z.literal(true) })),
  match: procedure
    .route({ method: "POST", path: "/aliases/match" })
    .input(
      z.object({ addresses: z.array(z.string().max(1000)).max(200) }).strict(),
    )
    .output(z.array(alias)),
  setDefault: procedure
    .route({ method: "PUT", path: "/aliases/default-domain" })
    .input(z.object({ domainId: z.string().min(1) }).strict())
    .output(z.object({ domainId: z.string() })),
  getDefault: procedure
    .route({ method: "GET", path: "/aliases/default-domain" })
    .input(z.object({}).strict())
    .output(z.object({ domainId: z.string().nullable() })),
  createKey: procedure
    .route({ method: "POST", path: "/aliases/keys" })
    .input(z.object({ name: z.string().trim().min(1).max(100) }).strict())
    .output(key.extend({ secret: z.string() })),
  listKeys: procedure
    .route({ method: "GET", path: "/aliases/keys" })
    .input(z.object({}).strict())
    .output(z.array(key)),
  revokeKey: procedure
    .route({ method: "DELETE", path: "/aliases/keys/{id}" })
    .input(id)
    .output(z.object({ revoked: z.literal(true) })),
};
