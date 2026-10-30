import { oc } from "@orpc/contract";
import { z } from "zod";

export const SetupEmail = z.email().max(254);
const Status = z.enum(["ready", "attention", "unknown"]);
export const SetupStatusSchema = z.object({
  database: Status,
  stalwart: Status,
  drive: Status,
  objectStorage: Status,
  relay: Status,
  backup: Status,
  backupAgeSeconds: z.number().nonnegative().nullable(),
  mailDomain: z.string(),
});
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export const setupContract = {
  status: oc
    .route({ method: "GET", path: "/admin/setup/status" })
    .input(z.object({}).strict())
    .output(SetupStatusSchema),
  createUser: oc
    .route({ method: "POST", path: "/admin/setup/users" })
    .input(
      z
        .object({
          email: SetupEmail,
          name: z.string().trim().min(1).max(100),
          password: z.string().min(12).max(128),
        })
        .strict(),
    )
    .output(z.object({ created: z.literal(true) })),
};
