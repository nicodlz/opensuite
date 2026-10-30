import { ORPCError } from "@orpc/client";
import type { Message } from "@opensuite/contracts";
import type { Alias } from "./client.ts";

export type AliasFilter = "all" | "enabled" | "disabled" | "suspended";
export function aliasState(alias: Alias): "Suspended" | "Pending" | "Ready" {
  if (alias.suspended || alias.detachedByDomain) return "Suspended";
  return alias.ready ? "Ready" : "Pending";
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
