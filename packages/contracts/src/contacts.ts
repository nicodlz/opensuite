import { oc } from "@orpc/contract";
import { z } from "zod";
import { IdSchema } from "./mail.ts";

export const ContactContentSchema = z.object({
  name: z.string().trim().min(1).max(500),
  emails: z.array(z.email().max(320)).max(20),
});
export const ContactSchema = ContactContentSchema.extend({
  id: IdSchema,
  addressBookIds: z.array(IdSchema),
});
const account = z.object({ accountId: IdSchema });
const state = z.string().min(1).max(256);
const vcard = z.string().min(1).max(250_000);
const errors = {
  NOT_FOUND: { status: 404, message: "Contact not found" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: { status: 400, message: "Invalid contact data" },
  CONFLICT: { status: 409, message: "Address book changed" },
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
});
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
        contact: ContactContentSchema,
        state,
      }),
    )
    .output(z.object({ id: IdSchema })),
  update: p
    .route({ method: "POST", path: "/contacts/update" })
    .input(
      account.extend({
        contactId: IdSchema,
        contact: ContactContentSchema,
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
    .input(account.extend({ vcard }))
    .output(z.object({ entries: z.array(previewEntry) })),
  import: p
    .route({ method: "POST", path: "/contacts/import" })
    .input(account.extend({ bookId: IdSchema, vcard, state }))
    .output(
      z.object({
        imported: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      }),
    ),
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
            email: z.email(),
            source: z.enum(["contact", "recent"]),
          }),
        ),
      }),
    ),
};
export type ContactContent = z.infer<typeof ContactContentSchema>;
export type Contact = z.infer<typeof ContactSchema>;

export type ContactRecord = {
  id: string;
  addressBookIds: Record<string, boolean>;
  name?:
    | ({ full?: string | undefined } & Record<string, unknown>)
    | null
    | undefined;
  emails?:
    | Record<string, { address: string } & Record<string, unknown>>
    | null
    | undefined;
} & Record<string, unknown>;

export interface ContactCodec {
  parse(
    input: string,
  ): { contact: ContactContent | null; warnings: string[] }[];
  serialize(contacts: readonly ContactContent[]): string;
  content(card: ContactRecord): ContactContent | null;
  project(
    card: ContactRecord,
  ): (ContactContent & { id: string; addressBookIds: string[] }) | null;
  create(contact: ContactContent, bookId: string): object;
  patch(card: ContactRecord, contact: ContactContent): Record<string, unknown>;
  warnings(card: ContactRecord): string[];
  preview(
    parsed: { contact: ContactContent | null; warnings: string[] }[],
    stored: ContactRecord[],
  ): {
    contact: ContactContent | null;
    warnings: string[];
    index: number;
    duplicate: boolean;
  }[];
}
