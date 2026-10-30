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
/** Why a message is quarantined; `null` when it goes to the inbox. */
export type QuarantineReason =
  | "spam"
  | "virus"
  | "dmarc_fail"
  | "dmarc_unchecked"
  | "spf_fail"
  | "dkim_fail";
/**
 * Inbox or quarantine, from the SES verdicts. See
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html
 *
 * Content scans must pass: a spam or virus verdict of FAIL, GRAY (scanned
 * but undecided) or PROCESSING_FAILED (not scanned) quarantines.
 *
 * For authentication, AWS documents GRAY as an absence of proof, not a
 * failure: SPF none, softfail or neutral; DKIM unsigned or signed for
 * another domain than From; DMARC for a domain without a policy or with
 * p=none. Real mail from a Google Workspace domain without SPF, DMARC or
 * its own DKIM key arrives with all three GRAY: its signature is valid but
 * made for Google's domain, not aligned with From. GRAY therefore proves
 * nothing about the sender: on its own it does not quarantine, so ordinary
 * mail reaches the inbox, and it is never treated as authentication. A failure
 * quarantines: DMARC FAIL whatever the domain's requested policy; SPF or
 * DKIM FAIL unless DMARC passed, as forwarding and mailing lists break them
 * while the aligned identifier holds. DMARC that could not be checked
 * (PROCESSING_FAILED, for instance a DNS error or a malformed signature)
 * quarantines unless SPF or DKIM passed, so it cannot hide a forged From.
 */
export function quarantineReason(
  notification: Notification,
): QuarantineReason | null {
  const r = notification.receipt;
  if (r.spamVerdict.status !== "PASS") return "spam";
  if (r.virusVerdict.status !== "PASS") return "virus";
  const dmarc = r.dmarcVerdict.status;
  if (dmarc === "FAIL") return "dmarc_fail";
  if (dmarc === "PASS") return null;
  if (r.spfVerdict.status === "FAIL") return "spf_fail";
  if (r.dkimVerdict.status === "FAIL") return "dkim_fail";
  if (
    dmarc === "PROCESSING_FAILED" &&
    r.spfVerdict.status !== "PASS" &&
    r.dkimVerdict.status !== "PASS"
  )
    return "dmarc_unchecked";
  return null;
}
export function verdictPolicy(
  notification: Notification,
): "deliver" | "quarantine" {
  return quarantineReason(notification) === null ? "deliver" : "quarantine";
}
