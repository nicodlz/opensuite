import { oc } from "@orpc/contract";
import { z } from "zod";

// The identity boundary is Better Auth's documented get-session response.
export const SessionResponseSchema = z
  .object({
    user: z.object({ id: z.string().min(1) }),
    session: z.object({
      userId: z.string().min(1),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  })
  .nullable();

const id = z.string().min(1).max(200);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      s.isWellFormed() &&
      !s.split("").some((c) => c.charCodeAt(0) < 32 || c === "/" || c === "\\"),
  );
const parentId = id.nullable();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const DriveCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    parentId,
    trash: z.boolean().default(false),
  }),
  z.object({ action: z.literal("shared") }),
  z.object({ action: z.literal("folder"), name, parentId }),
  z.object({
    action: z.literal("upload"),
    name,
    parentId,
    size: z.number().int().nonnegative().max(5_000_000_000),
    checksum,
    contentType: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
    multipart: z.boolean(),
  }),
  z.object({
    action: z.literal("part"),
    id,
    partNumber: z.number().int().min(1).max(10000),
  }),
  z.object({
    action: z.literal("finish"),
    id,
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10000),
          etag: z.string().min(1).max(200),
        }),
      )
      .max(10000)
      .optional(),
  }),
  z.object({ action: z.literal("download"), id }),
  z.object({ action: z.literal("rename"), id, name }),
  z.object({ action: z.literal("move"), id, parentId }),
  z.object({ action: z.literal("trash"), id }),
  z.object({ action: z.literal("restore"), id }),
  z.object({ action: z.literal("delete"), id }),
  z.object({
    action: z.literal("share"),
    id,
    userId: id,
    access: z.enum(["read", "write"]),
  }),
  z.object({ action: z.literal("unshare"), id, userId: id }),
  z.object({
    action: z.literal("link"),
    id,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.object({ action: z.literal("unlink"), id, linkId: id }),
]);
export type DriveCommand = z.infer<typeof DriveCommandSchema>;
export const DriveEntrySchema = z.object({
  id,
  ownerId: id,
  parentId,
  name,
  kind: z.string(),
  state: z.string(),
  size: z.number().nonnegative(),
  contentType: z.string().nullable(),
  trashedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const DriveOutputSchema = z.union([
  DriveEntrySchema,
  z.object({ entries: z.array(DriveEntrySchema) }),
  z.object({ id, url: z.url().nullable(), expiresIn: z.number().positive() }),
  z.object({ url: z.url(), expiresIn: z.number().positive() }),
  z.object({ deleted: z.literal(true) }),
  z.object({ shared: z.literal(true) }),
  z.object({ revoked: z.literal(true) }),
  z.object({ id, token: z.string(), expiresAt: z.string() }),
]);
export type DriveOutput = z.infer<typeof DriveOutputSchema>;
export const driveContract = {
  command: oc
    .route({
      method: "POST",
      path: "/v1/command",
      summary: "Drive operations",
      tags: ["drive"],
    })
    .input(DriveCommandSchema)
    .output(DriveOutputSchema),
};
