import { oc } from "@orpc/contract";
import { z } from "zod";

export const DomainName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
export const LocalPart = z
  .string()
  .trim()
  .toLowerCase()
  .max(64)
  .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/)
  .refine((s) => !s.startsWith(".") && !s.endsWith(".") && !s.includes(".."));
export const DnsRecordSchema = z.object({
  type: z.enum(["MX", "TXT", "CNAME"]),
  name: z.string(),
  value: z.string(),
  priority: z.number().int().optional(),
  status: z.enum(["pending", "verified", "failing"]),
});
export const DomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pending", "verified", "failing"]),
  checkedAt: z.string().nullable(),
  records: z.array(DnsRecordSchema),
  addresses: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      localPart: z.string(),
      isAlias: z.boolean(),
    }),
  ),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;
export type ManagedDomain = z.infer<typeof DomainSchema>;
const id = z.object({ domainId: z.string().min(1) }).strict();
export const domainsContract = {
  list: oc
    .route({ method: "GET", path: "/admin/domains", summary: "List domains" })
    .input(z.object({}).strict())
    .output(z.array(DomainSchema)),
  add: oc
    .route({ method: "POST", path: "/admin/domains", summary: "Add a domain" })
    .input(z.object({ name: DomainName }).strict())
    .output(DomainSchema),
  remove: oc
    .route({
      method: "DELETE",
      path: "/admin/domains/{domainId}",
      summary: "Remove a domain",
    })
    .input(id)
    .output(z.object({ removed: z.literal(true) })),
  recheck: oc
    .route({
      method: "POST",
      path: "/admin/domains/{domainId}/recheck",
      summary: "Check domain DNS",
    })
    .input(id)
    .output(DomainSchema),
  addAddress: oc
    .route({
      method: "POST",
      path: "/admin/domains/{domainId}/addresses",
      summary: "Add a mailbox address or alias",
    })
    .input(
      id
        .extend({
          userId: z.string().min(1),
          localPart: LocalPart,
          isAlias: z.boolean(),
        })
        .strict(),
    )
    .output(DomainSchema),
  removeAddress: oc
    .route({
      method: "DELETE",
      path: "/admin/domains/{domainId}/addresses/{addressId}",
      summary: "Remove an address",
    })
    .input(id.extend({ addressId: z.string().min(1) }).strict())
    .output(DomainSchema),
};
