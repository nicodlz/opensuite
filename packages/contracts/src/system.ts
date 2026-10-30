import { oc } from "@orpc/contract";
import { z } from "zod";

/** Probes take no parameters; unexpected query keys are rejected. */
const NoInputSchema = z.object({}).strict();

export const HealthSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

export const DependencyNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "lowercase name");

export const DependencyCheckSchema = z.object({
  name: DependencyNameSchema,
  status: z.enum(["up", "down"]),
  durationMs: z.number().nonnegative(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

export const ReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checkedAt: z.iso.datetime(),
  dependencies: z.array(DependencyCheckSchema),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ProductOriginsSchema = z.object({
  mail: z.url().optional(),
  drive: z.url().optional(),
  calendar: z.url().optional(),
  vault: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    })
    .optional(),
});
export type ProductOrigins = z.infer<typeof ProductOriginsSchema>;

export const systemContract = {
  origins: oc
    .route({
      method: "GET",
      path: "/origins",
      summary: "Public origin of each application",
      tags: ["system"],
    })
    .input(NoInputSchema)
    .output(ProductOriginsSchema),
  health: oc
    .route({
      method: "GET",
      path: "/health",
      summary: "Liveness probe",
      tags: ["system"],
    })
    .input(NoInputSchema)
    .output(HealthSchema),
  ready: oc
    .route({
      method: "GET",
      path: "/ready",
      summary: "Readiness probe over declared dependencies",
      tags: ["system"],
    })
    .input(NoInputSchema)
    .errors({
      NOT_READY: {
        status: 503,
        message: "One or more dependencies are unavailable",
        data: ReadinessSchema,
      },
    })
    .output(ReadinessSchema),
};
