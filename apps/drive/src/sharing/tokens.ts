import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Public link tokens are an HMAC of the link ID under a key derived from a
 * service secret, so the owner can copy a link again while the database keeps
 * only token hashes. Without a key, tokens are random and shown only once.
 */
export const linkKey = (secret: string) =>
  Buffer.from(
    hkdfSync("sha256", secret, "", "opensuite drive public link v1", 32),
  );
export const createLinkToken = (key: Buffer | undefined, linkId: string) =>
  key === undefined
    ? randomBytes(32).toString("base64url")
    : createHmac("sha256", key).update(linkId).digest("base64url");
export const hashLinkToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
/** The token of a link, when the current key still produces it. */
export const recoverLinkToken = (
  key: Buffer | undefined,
  link: { id: string; tokenHash: string },
) => {
  if (key === undefined) return null;
  const token = createLinkToken(key, link.id);
  return hashLinkToken(token) === link.tokenHash ? token : null;
};
