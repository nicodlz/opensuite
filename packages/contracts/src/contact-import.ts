import { z } from "zod";
import { IdSchema } from "./mail.ts";

export const contactPrintable = (value: string, allowLineFeed = false) =>
  Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 32 || (allowLineFeed && code === 10)) && code !== 127;
  });
const vcardToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?$/);
const vcardParameter = z.union([
  z
    .string()
    .refine(
      (value) => contactPrintable(value, true),
      "Invalid vCard parameter",
    ),
  z
    .array(
      z
        .string()
        .refine(
          (value) => contactPrintable(value, true),
          "Invalid vCard parameter",
        ),
    )
    .max(100),
]);
const vcardScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const vcardParameters = z
  .record(vcardToken.toLowerCase(), vcardParameter)
  .refine(
    (parameters) =>
      Object.entries(parameters).every(
        ([key, value]) =>
          key.toLowerCase() !== "group" ||
          (typeof value === "string" && /^[A-Za-z0-9-]+$/.test(value)),
      ),
    "Invalid vCard group identifier",
  );
const vcardValue = z.union([
  vcardScalar,
  z.array(z.union([vcardScalar, z.array(vcardScalar).max(1000)])).max(1000),
]);
const textArray = z.array(z.string());
const textComponents = z.array(z.union([z.string(), textArray]));
const textArrayNames = new Set([
  "org",
  "gender",
  "clientpidmap",
  "categories",
  "nickname",
]);
const validTextValue = (propertyName: string, value: unknown): boolean => {
  if (typeof value === "string") return true;
  const name = propertyName.toLowerCase().split(".").at(-1) ?? propertyName;
  if (["n", "adr"].includes(name))
    return textComponents.safeParse(value).success;
  return textArrayNames.has(name) && textArray.safeParse(value).success;
};
const vcardProperty = z
  .tuple([vcardToken, vcardParameters, vcardToken.toLowerCase(), vcardValue])
  .refine((property) => {
    if (property[2] === "text") return validTextValue(property[0], property[3]);
    if (property[2] === "unknown") return true;
    return [property[3]]
      .flat(3)
      .every((value) => typeof value !== "string" || !/[\r\n]/.test(value));
  }, "Invalid vCard value shape or line breaks");
export const ContactVcardSchema = z.object({
  properties: z.array(vcardProperty).max(1000).optional(),
  convertedProperties: z
    .record(
      z
        .string()
        .min(1)
        .max(2048)
        .refine(contactPrintable, "Invalid conversion path"),
      z.object({
        name: vcardToken.optional(),
        parameters: vcardParameters.optional(),
      }),
    )
    .optional(),
});

export const ContactImportCapabilitiesSchema = z.object({
  phones: z.boolean(),
  addresses: z.boolean(),
  importEnrichment: z.boolean(),
});
export const ContactImportActionSchema = z.enum([
  "create",
  "enrich",
  "unchanged",
  "blocked",
]);
export const ContactImportPreviewMetadataSchema = z.object({
  action: ContactImportActionSchema.optional(),
  existingId: IdSchema.optional(),
  candidateIds: z.array(IdSchema).max(100).optional(),
  reason: z.string().optional(),
});
const importTargetIndex = /^(?:0|[1-9]\d?)$/;
const hasInvalidImportTargetKey = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).some((key) => !importTargetIndex.test(key));
export const ContactImportTargetsSchema = z.preprocess(
  (value: Record<string, string>, context) => {
    if (hasInvalidImportTargetKey(value))
      context.addIssue("Import target index must be between 0 and 99");
    return value;
  },
  z
    .record(z.string().regex(importTargetIndex), IdSchema)
    .refine(
      (targets) => Object.keys(targets).length <= 100,
      "Too many import targets",
    ),
);
export const ContactImportSummarySchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative().optional(),
  merged: z.number().int().nonnegative().optional(),
  failed: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    )
    .optional(),
});
export type ContactImportCapabilities = z.infer<
  typeof ContactImportCapabilitiesSchema
>;
export type ContactImportAction = z.infer<typeof ContactImportActionSchema>;
export type ContactImportTargets = z.infer<typeof ContactImportTargetsSchema>;
export type ContactImportSummary = z.infer<typeof ContactImportSummarySchema>;
