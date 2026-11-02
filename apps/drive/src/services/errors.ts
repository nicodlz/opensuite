import { ORPCError } from "@orpc/server";

export const missing = () =>
  new ORPCError("NOT_FOUND", { message: "Entry not found" });
export const invalid = (message: string) =>
  new ORPCError("BAD_REQUEST", { message });
