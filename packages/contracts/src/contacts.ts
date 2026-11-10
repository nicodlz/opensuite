import { oc, type InferContractRouterInputs } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";
import {
  ContactImportCapabilitiesSchema,
  ContactImportPreviewMetadataSchema,
  ContactImportSummarySchema,
  ContactImportTargetsSchema,
  ContactVcardSchema,
  contactPrintable as printable,
  type ContactImportCapabilities,
} from "./contact-import.ts";
export {
  ContactImportActionSchema,
  ContactImportCapabilitiesSchema,
  ContactImportPreviewMetadataSchema,
  ContactImportSummarySchema,
  ContactImportTargetsSchema,
  ContactVcardSchema,
} from "./contact-import.ts";
export type {
  ContactImportCapabilities,
  ContactImportAction,
  ContactImportTargets,
  ContactImportSummary,
} from "./contact-import.ts";

const contactEmail = z.email({ pattern: z.regexes.unicodeEmail }).max(320);
const contexts = z.record(z.string().min(1).max(128), z.boolean());
const metadata = {
  label: z.string().max(1000).optional(),
  contexts: contexts.optional(),
  pref: z.number().int().min(1).max(100).optional(),
};
const text = z.string().max(20_000);
export const ContactPhoneSchema = z.looseObject({
  number: text.refine(printable, "Invalid phone number"),
  features: contexts.optional(),
  ...metadata,
});
export const ContactAddressSchema = z.looseObject({
  full: text.optional(),
  defaultSeparator: text.optional(),
  components: z
    .array(z.looseObject({ kind: z.string().max(128), value: text }))
    .max(100)
    .optional(),
  countryCode: z.string().max(16).optional(),
  ...metadata,
});
const fieldMap = <T extends z.ZodType>(entry: T) =>
  z.record(z.string().min(1).max(256), entry).nullable().optional();
export const ContactAnniversaryDateSchema = z.union([
  z
    .looseObject({
      "@type": z.literal("PartialDate"),
      year: z.number().int().min(1).max(9999).optional(),
      month: z.number().int().min(1).max(12).optional(),
      day: z.number().int().min(1).max(31).optional(),
    })
    .refine(
      ({ year, month, day }) =>
        [year, month, day].some((part) => part !== undefined) &&
        (day === undefined || year === undefined || month !== undefined) &&
        new Date(
          Date.UTC(year ?? 2000, (month ?? 1) - 1, day ?? 1),
        ).getUTCDate() === (day ?? 1),
      "Invalid partial date",
    ),
  z.looseObject({ "@type": z.literal("Timestamp"), utc: z.iso.datetime() }),
]);
/** Native JSContact maps retain stable IDs and metadata; omitted fields are untouched. */
export const ContactFieldsSchema = z.object({
  uid: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) => printable(value) && !value.includes(" "),
      "Invalid contact UID",
    )
    .optional(),
  phones: fieldMap(ContactPhoneSchema),
  addresses: fieldMap(ContactAddressSchema),
  organizations: fieldMap(
    z.looseObject({
      name: text.optional(),
      units: z
        .array(z.looseObject({ name: text }))
        .max(100)
        .optional(),
      ...metadata,
    }),
  ),
  titles: fieldMap(
    z.looseObject({
      name: text,
      kind: z.enum(["title", "role"]).optional(),
      organizationId: z.string().optional(),
    }),
  ),
  notes: fieldMap(z.looseObject({ note: text })),
  links: fieldMap(
    z.looseObject({ uri: text, kind: z.string().optional(), ...metadata }),
  ),
  nicknames: fieldMap(z.looseObject({ name: text, ...metadata })),
  anniversaries: fieldMap(
    z.looseObject({
      kind: z.string(),
      date: ContactAnniversaryDateSchema,
      label: text.optional(),
    }),
  ),
  nameDetails: z.record(z.string(), z.unknown()).optional(),
  emailDetails: fieldMap(z.looseObject({ address: z.string(), ...metadata })),
  vCard: ContactVcardSchema.optional(),
});
export type ContactFields = z.infer<typeof ContactFieldsSchema>;
export const contactHasNativeLayout = (
  contact: Pick<ContactFields, "addresses" | "vCard">,
) =>
  !contact.vCard?.properties?.some((property) =>
    Object.entries(property[1]).some(
      ([name, value]) =>
        name.toLowerCase() === "jscomps" && String(value).includes("\\;"),
    ),
  ) &&
  Object.values(contact.addresses ?? {}).every(
    (address) =>
      !address.defaultSeparator?.includes(";") &&
      !address.components?.some(
        (part) => part.kind === "separator" && part.value.includes(";"),
      ),
  );
export const ContactContentSchema = z.object({
  name: z.string().trim().min(1).max(500),
  emails: z.array(contactEmail).max(1000),
  ...ContactFieldsSchema.shape,
});
const nativeMap = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .nullish();
// Contacts can also be written by CardDAV clients with fields outside our
// create/import limits. Return those values without treating them as an outage.
export const ContactSchema = z.object({
  name: z.string(),
  emails: z.array(z.string()),
  id: IdSchema,
  addressBookIds: z.array(IdSchema),
  // Existing CardDAV data must not be rejected by input limits or future extensions.
  uid: z.string().optional(),
  phones: z.record(z.string(), z.looseObject({ number: z.string() })).nullish(),
  addresses: z
    .record(
      z.string(),
      z.looseObject({
        full: z.string().optional(),
        components: z
          .array(z.looseObject({ kind: z.string(), value: z.string() }))
          .optional(),
      }),
    )
    .nullish(),
  organizations: nativeMap,
  titles: nativeMap,
  notes: z.record(z.string(), z.looseObject({ note: z.string() })).nullish(),
  links: z.record(z.string(), z.looseObject({ uri: z.string() })).nullish(),
  nicknames: z
    .record(z.string(), z.looseObject({ name: z.string() }))
    .nullish(),
  anniversaries: nativeMap,
  nameDetails: z.record(z.string(), z.unknown()).optional(),
  emailDetails: z
    .record(z.string(), z.looseObject({ address: z.string() }))
    .nullish(),
  vCard: z.record(z.string(), z.unknown()).optional(),
});
const ContactUpdateSchema = z.object({
  name: z.string().max(250_000),
  emails: z.array(contactEmail).max(1000),
  ...ContactFieldsSchema.shape,
});
const account = z.object({ accountId: IdSchema });
const state = z.string().min(1).max(256);
const vcard = z.string().min(1).max(250_000);
const errors = {
  NOT_FOUND: { status: 404, message: "Contact not found" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: { status: 400, message: "Invalid contact data" },
  CONFLICT: { status: 409, message: "Address book changed" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many contacts requests" },
  UPSTREAM_UNAVAILABLE: {
    status: 503,
    message: "Contacts service unavailable",
  },
};
const p = oc.errors(errors);
const previewEntry = z.object({
  index: z.number().int().nonnegative(),
  contact: ContactContentSchema.nullable(),
  duplicate: z.boolean(),
  warnings: z.array(z.string()),
  expectedContact: ContactSchema.optional(),
  ...ContactImportPreviewMetadataSchema.shape,
});
/** Native ACLs can change independently of contact state; observation is not a lock. */
export const ContactBookPrivacySchema = z.object({
  status: z.enum(["private", "shared", "unknown"]),
  assurance: z.literal("observed"),
  state: z.string(),
  observedAt: z.iso.datetime(),
  sharingAllowed: z.boolean().nullable(),
  bccEligible: z.literal(false),
});
export type ContactBookPrivacy = z.infer<typeof ContactBookPrivacySchema>;
export const contactsContract = {
  books: p
    .route({ method: "POST", path: "/contacts/books" })
    .input(account)
    .output(
      z.object({
        books: z.array(
          z.object({
            id: IdSchema,
            name: z.string(),
            isDefault: z.boolean(),
            mayRead: z.boolean(),
            mayWrite: z.boolean(),
            mayDelete: z.boolean(),
            privacy: ContactBookPrivacySchema.optional(),
          }),
        ),
      }),
    ),
  list: p
    .route({ method: "POST", path: "/contacts/list" })
    .input(
      account.extend({
        query: z.string().max(200).default(""),
        position: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .output(
      z.object({
        contacts: z.array(ContactSchema),
        state,
        position: z.number().int(),
        total: z.number().int().nonnegative(),
      }),
    ),
  create: p
    .route({ method: "POST", path: "/contacts/create" })
    .input(
      account.extend({
        bookId: IdSchema,
        contact: ContactContentSchema.refine(
          contactHasNativeLayout,
          "The native server cannot preserve a literal semicolon in postal separators",
        ),
        state,
      }),
    )
    .output(z.object({ id: IdSchema })),
  update: p
    .route({ method: "POST", path: "/contacts/update" })
    .input(
      account.extend({
        contactId: IdSchema,
        contact: ContactUpdateSchema.refine(
          contactHasNativeLayout,
          "The native server cannot preserve a literal semicolon in postal separators",
        ),
        state,
      }),
    )
    .output(z.object({ success: z.literal(true) })),
  delete: p
    .route({ method: "POST", path: "/contacts/delete" })
    .input(account.extend({ contactId: IdSchema, state }))
    .output(z.object({ success: z.literal(true) })),
  previewImport: p
    .route({ method: "POST", path: "/contacts/import/preview" })
    .input(
      account.extend({
        vcard,
        bookId: IdSchema.optional(),
        targets: ContactImportTargetsSchema.optional(),
      }),
    )
    .output(
      z.object({
        entries: z.array(previewEntry),
        capabilities: ContactImportCapabilitiesSchema.optional(),
        state: state.optional(),
      }),
    ),
  import: p
    .route({ method: "POST", path: "/contacts/import" })
    .input(
      account.extend({
        bookId: IdSchema,
        vcard,
        state,
        targets: ContactImportTargetsSchema.optional(),
        enrichExisting: z.boolean().optional(),
      }),
    )
    .output(ContactImportSummarySchema),
  export: p
    .route({ method: "POST", path: "/contacts/export" })
    .input(account.extend({ ids: z.array(IdSchema).min(1).max(100) }))
    .output(z.object({ vcard: z.string(), warnings: z.array(z.string()) })),
  suggest: p
    .route({ method: "POST", path: "/contacts/suggest" })
    .input(
      account.extend({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .output(
      z.object({
        suggestions: z.array(
          z.object({
            name: z.string(),
            email: z.string(),
            source: z.enum(["contact", "recent"]),
          }),
        ),
      }),
    ),
};
export type ContactContent = z.infer<typeof ContactContentSchema>;
export type ContactsInputs = InferContractRouterInputs<typeof contactsContract>;
export type Contact = z.infer<typeof ContactSchema>;
export const contactEmailKey = (email: string) => email.trim().toLowerCase();
type ParsedContact = Pick<z.infer<typeof previewEntry>, "contact" | "warnings">;
type NullableField<T> = T | null | undefined;
export type ContactRecord = {
  id: string;
  addressBookIds: Record<string, boolean>;
  name?: NullableField<{ full?: string | undefined } & Record<string, unknown>>;
  emails?: NullableField<
    Record<string, { address: string } & Record<string, unknown>>
  >;
} & Record<string, unknown>;
export interface ContactCodec {
  capabilities?: ContactImportCapabilities | undefined;
  prepareImport?(contact: ContactContent): {
    contact: ContactContent;
    unsupported: string[];
  };
  parse(
    input: string,
  ): { ok: true; cards: ParsedContact[] } | { ok: false; reason: "limit" };
  serialize(contacts: readonly ContactContent[]): string;
  content(card: ContactRecord): ContactContent;
  project(card: ContactRecord): Contact;
  /** Optional native-provider projection; absence must not enable import enrichment. */
  projectImport?(
    card: ContactRecord,
    original: ContactRecord,
  ): Contact | undefined;
  create(contact: ContactContent, bookId: string): object;
  patch(card: ContactRecord, contact: ContactContent): Record<string, unknown>;
  warnings(card: ContactRecord): string[];
  preview(
    parsed: ParsedContact[],
    stored: ContactRecord[],
  ): z.infer<typeof previewEntry>[];
}
