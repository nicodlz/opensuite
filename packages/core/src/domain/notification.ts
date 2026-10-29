import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

// AWS: https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html
// S3 action: https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
const verdict = z
  .object({ status: z.enum(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED"]) })
  .passthrough();
const timestamp = z.iso.datetime({ offset: true });
const email = z.email();
export const NotificationSchema = z
  .object({
    notificationType: z.literal("Received"),
    receipt: z
      .object({
        timestamp,
        processingTimeMillis: z.union([
          z.number().nonnegative(),
          z.string().regex(/^\d+$/),
        ]),
        recipients: z.array(email).min(1),
        spamVerdict: verdict,
        virusVerdict: verdict,
        spfVerdict: verdict,
        dkimVerdict: verdict,
        dmarcVerdict: verdict,
        dmarcPolicy: z.enum(["none", "quarantine", "reject"]).optional(),
        action: z
          .object({
            type: z.literal("S3"),
            topicArn: z.string().min(1),
            bucketName: z.string().min(1),
            objectKey: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
    mail: z
      .object({
        timestamp,
        source: z.string(),
        messageId: z.string().min(1),
        destination: z.array(email),
        headersTruncated: z.boolean().optional(),
        headers: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional(),
        commonHeaders: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type Notification = z.infer<typeof NotificationSchema>;
export const parseNotification = (
  text: string,
): Result<Notification, string> => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return err("Notification is not JSON");
  }
  const parsed = NotificationSchema.safeParse(data);
  return parsed.success ? ok(parsed.data) : err(parsed.error.message);
};

export interface Route {
  address: string;
  destination: string;
}
export interface Recipient {
  destination: string;
  addresses: string[];
  known: boolean;
}
export function resolveRecipients(
  addresses: string[],
  routes: Route[],
): Recipient[] {
  const byAddress = new Map(
    routes.map((route) => [route.address.toLowerCase(), route.destination]),
  );
  const result = new Map<string, Recipient>();
  for (const input of addresses) {
    const address = input.toLowerCase();
    const destination = byAddress.get(address);
    const key =
      destination === undefined ? `unknown:${address}` : `known:${destination}`;
    const current = result.get(key);
    if (current === undefined)
      result.set(key, {
        destination: destination ?? address,
        addresses: [address],
        known: destination !== undefined,
      });
    else if (!current.addresses.includes(address))
      current.addresses.push(address);
  }
  return [...result.values()];
}
export function verdictPolicy(
  notification: Notification,
): "deliver" | "quarantine" {
  const r = notification.receipt;
  return [
    r.spamVerdict,
    r.virusVerdict,
    r.spfVerdict,
    r.dkimVerdict,
    r.dmarcVerdict,
  ].every((v) => v.status === "PASS")
    ? "deliver"
    : "quarantine";
}
