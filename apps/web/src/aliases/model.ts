import { ORPCError } from "@orpc/client";
import type { Message } from "@opensuite/contracts";
import type { Alias } from "./client.ts";

export type AliasFilter = "all" | "enabled" | "disabled" | "suspended";
export function aliasState(alias: Alias): "Suspended" | "Pending" | "Ready" {
  if (alias.suspended || alias.detachedByDomain) return "Suspended";
  return alias.ready ? "Ready" : "Pending";
}
export type AliasStatus = "active" | "pending" | "disabled" | "suspended";
/**
 * One status for the list, combining the owner's switch with delivery: a
 * suspension outranks the switch, and a disabled alias never receives mail.
 */
export function aliasStatus(alias: Alias): AliasStatus {
  if (aliasState(alias) === "Suspended") return "suspended";
  if (!alias.enabled) return "disabled";
  return alias.ready ? "active" : "pending";
}
/** What the status means for incoming mail, in one sentence or two. */
export function aliasStatusDetail(alias: Alias): string {
  const status = aliasStatus(alias);
  if (status === "active") return "Receiving mail.";
  if (status === "pending")
    return "Being set up. Mail is delivered once it is ready.";
  // Mail accepted while disabled is held and arrives if the alias is
  // re-enabled within the hold window; deliveries already routed still land.
  if (status === "disabled")
    return `New mail is held instead of delivered, and arrives if you re-enable it in time. Messages already on their way may still arrive.${alias.ready ? "" : " Setup is still pending."}`;
  const reason = alias.detachedByDomain
    ? "Its domain is no longer available."
    : "Suspended by your administrator.";
  return `New mail is not delivered. ${reason}${alias.enabled ? "" : " You have also disabled it."}`;
}
export function canSendFrom(alias: Alias) {
  return (
    alias.enabled && alias.ready && !alias.suspended && !alias.detachedByDomain
  );
}
export function filterAliases(aliases: Alias[], filter: AliasFilter) {
  return aliases.filter((alias) =>
    filter === "all"
      ? true
      : filter === "suspended"
        ? aliasState(alias) === "Suspended"
        : filter === "enabled"
          ? alias.enabled && aliasState(alias) !== "Suspended"
          : !alias.enabled && aliasState(alias) !== "Suspended",
  );
}

/** Header matches are hints, not trusted envelope-recipient evidence. */
export function recipientAddresses(
  message: Pick<Message, "to" | "cc" | "headers">,
): string[] {
  const headers = message.headers
    .filter((header) =>
      ["to", "cc", "delivered-to", "x-original-to"].includes(
        header.name.toLowerCase(),
      ),
    )
    .flatMap(
      (header) =>
        header.value.match(/[A-Z0-9.!#$%&'*+\x2f=?^_`{|}~-]+@[A-Z0-9.-]+/gi) ??
        [],
    );
  return [
    ...new Set(
      [
        ...message.to.map((item) => item.email),
        ...message.cc.map((item) => item.email),
        ...headers,
      ]
        .map((address) => address.trim().toLowerCase())
        .filter((address) => address.length <= 1000),
    ),
  ].slice(0, 200);
}
/** "your aliases and API keys": the parts of the page that failed to load. */
export function failedParts(parts: { label: string; failed: boolean }[]) {
  return new Intl.ListFormat("en", { type: "conjunction" }).format(
    parts.filter((part) => part.failed).map((part) => part.label),
  );
}
export function aliasError(error: unknown): string {
  if (error instanceof ORPCError) {
    const messages: Record<string, string> = {
      BAD_REQUEST: "Invalid alias data. Check the details and try again.",
      NOT_FOUND: "Alias or domain not found. Refresh and try again.",
      CONFLICT: "This alias request conflicts with an existing reservation.",
      ALIAS_KEY_CAP_REACHED: "Alias key limit reached.",
      ALIAS_CAP_REACHED: "Alias limit reached.",
      TOO_MANY_REQUESTS: "Too many requests. Please try again later.",
      SERVICE_UNAVAILABLE: "Alias service unavailable. Please try again.",
    };
    return (
      messages[String(error.code)] ??
      "Could not complete the request. Please try again."
    );
  }
  return "Could not reach the alias service. Please try again.";
}
