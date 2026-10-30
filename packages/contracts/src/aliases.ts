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
export const aliasesContract = {
  domains: oc
    .route({ method: "GET", path: "/aliases/domains" })
    .input(z.object({}).strict())
    .output(z.array(z.object({ id: z.string(), name: z.string() }))),
  list: oc
    .route({ method: "GET", path: "/aliases" })
    .input(z.object({ search: z.string().max(253).optional() }).strict())
    .output(z.array(alias)),
  create: oc
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
  update: oc
    .route({ method: "PATCH", path: "/aliases/{id}" })
    .input(id.extend(details).strict())
    .output(alias),
  enable: oc
    .route({ method: "POST", path: "/aliases/{id}/enable" })
    .input(id)
    .output(alias),
  disable: oc
    .route({ method: "POST", path: "/aliases/{id}/disable" })
    .input(id)
    .output(alias),
  delete: oc
    .route({ method: "DELETE", path: "/aliases/{id}" })
    .input(id)
    .output(z.object({ deleted: z.literal(true) })),
  match: oc
    .route({ method: "POST", path: "/aliases/match" })
    .input(z.object({ addresses: z.array(z.email()).max(200) }).strict())
    .output(z.array(alias)),
  setDefault: oc
    .route({ method: "PUT", path: "/aliases/default-domain" })
    .input(z.object({ domainId: z.string().min(1) }).strict())
    .output(z.object({ domainId: z.string() })),
  getDefault: oc
    .route({ method: "GET", path: "/aliases/default-domain" })
    .input(z.object({}).strict())
    .output(z.object({ domainId: z.string().nullable() })),
  createKey: oc
    .route({ method: "POST", path: "/aliases/keys" })
    .input(z.object({ name: z.string().trim().min(1).max(100) }).strict())
    .output(key.extend({ secret: z.string() })),
  listKeys: oc
    .route({ method: "GET", path: "/aliases/keys" })
    .input(z.object({}).strict())
    .output(z.array(key)),
  revokeKey: oc
    .route({ method: "DELETE", path: "/aliases/keys/{id}" })
    .input(id)
    .output(z.object({ revoked: z.literal(true) })),
};
