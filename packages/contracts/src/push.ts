import { oc } from "@orpc/contract";
import { z } from "zod";

export const PushProduct = z.enum(["mail", "calendar", "drive"]);
export type PushProduct = z.infer<typeof PushProduct>;
const product = z.object({ product: PushProduct }).strict();
const timeZone = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      return (
        new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
          .timeZone.length > 0
      );
    } catch {
      return false;
    }
  });
const endpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      !value
        .slice(value.indexOf("//") + 2)
        .split(/[/?#]/, 1)[0]
        ?.includes(":") &&
      !url.username &&
      !url.password &&
      (host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com" ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".notify.windows.com"))
    );
  });
const subscription = product
  .extend({
    endpoint,
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    userAgent: z.string().max(200),
    timeZone: timeZone.optional(),
  })
  .strict();
const success = z.object({ ok: z.literal(true) });
export const pushContract = {
  publicKey: oc
    .route({ method: "GET", path: "/push/public-key" })
    .input(z.object({}).strict())
    .output(z.object({ publicKey: z.string() })),
  subscribe: oc
    .route({ method: "POST", path: "/push/subscribe" })
    .input(subscription)
    .output(success),
  status: oc
    .route({ method: "POST", path: "/push/status" })
    .input(product.extend({ endpoint, timeZone: timeZone.optional() }).strict())
    .output(z.object({ subscribed: z.boolean() })),
  clearSession: oc
    .route({ method: "POST", path: "/push/clear-session" })
    .input(z.object({}).strict())
    .output(success),
  unsubscribe: oc
    .route({ method: "POST", path: "/push/unsubscribe" })
    .input(product.extend({ endpoint }).strict())
    .output(success),
  test: oc
    .route({ method: "POST", path: "/push/test" })
    .input(product)
    .output(success),
  privacy: oc
    .route({ method: "GET", path: "/push/privacy" })
    .input(z.object({}).strict())
    .output(z.object({ showDetails: z.boolean() })),
  setPrivacy: oc
    .route({ method: "POST", path: "/push/privacy" })
    .input(z.object({ showDetails: z.boolean() }).strict())
    .output(success),
};
