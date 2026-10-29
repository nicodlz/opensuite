import { createHash, randomBytes } from "node:crypto";

export const createLinkToken = () => randomBytes(32).toString("base64url");
export const hashLinkToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
