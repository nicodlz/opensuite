import { ORPCError } from "@orpc/client";
import type { BillingInterval, BillingOverview } from "@opensuite/contracts";

function money(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}
export function price(amount: number, interval: BillingInterval) {
  return interval === "year"
    ? `${money(amount / 12)}/month, billed ${money(amount)} yearly`
    : `${money(amount)}/month`;
}
export function bytes(value: number) {
  if (value < 1000) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1000;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount)} ${units[index]}`;
}
export function usageState(storage: BillingOverview["storage"]) {
  if (
    !storage.measured ||
    storage.quotaBytes === null ||
    storage.quotaBytes === 0
  )
    return "normal";
  const ratio = storage.usedBytes / storage.quotaBytes;
  return ratio >= 1
    ? "over"
    : ratio >= 0.95
      ? "critical"
      : ratio >= 0.8
        ? "warning"
        : "normal";
}
export function statusText(status: string) {
  switch (status) {
    case "active":
      return "Active";
    case "trialing":
      return "Trial active";
    case "past_due":
      return "Payment issue — update your payment method to keep your plan active.";
    case "unpaid":
    case "canceled":
    case "expired":
    case "incomplete_expired":
      return "Subscription ended or unpaid — your account is read-only. Update billing to restore access.";
    case "incomplete":
      return "Payment pending — complete your payment to activate your plan.";
    case "paused":
      return "Subscription paused — update billing to restore access.";
    default:
      return "Subscription status unavailable — manage billing for details.";
  }
}
export function billingError(error: unknown) {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "BILLING_DISABLED":
        return "Billing is not enabled here. You can self-host Esuno instead.";
      case "CONFLICT":
        return "This billing request conflicts with your current subscription. Refresh and try again, or manage billing.";
      case "SERVICE_UNAVAILABLE":
        return "Billing is temporarily unavailable. Please try again later.";
      case "TOO_MANY_REQUESTS":
        return "Too many requests. Please wait a moment and try again.";
    }
  }
  return "We could not complete your billing request. Please try again.";
}
