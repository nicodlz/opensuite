import { readFile } from "node:fs/promises";
import { JmapCapability, JmapClient } from "../packages/jmap/src/index.ts";

const [address, accountId] = process.argv.slice(2);
if (!address || !accountId) throw new Error("Usage: ingest ADDRESS ACCOUNT_ID");
const clientIp = process.env["STALWART_MANAGEMENT_CLIENT_IP"];
if (!clientIp) throw new Error("Management network address is required");
const origin = "http://stalwart-management:8080";
const management = (
  await readFile("/run/opensuite/stalwart-management/password", "utf8")
).trim();
const adminAuth = `Basic ${Buffer.from(`management@opensuite.internal:${management}`).toString("base64")}`;
const response = await fetch(`${origin}/jmap/`, {
  method: "POST",
  headers: {
    authorization: adminAuth,
    "content-type": "application/json",
    "x-forwarded-for": clientIp,
  },
  body: JSON.stringify({
    using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    methodCalls: [
      [
        "x:AppPassword/set",
        {
          accountId,
          create: {
            inbound: {
              description: "Esuno inbound worker",
              permissions: { "@type": "Inherit" },
              allowedIps: {},
            },
          },
        },
        "credential",
      ],
    ],
  }),
  signal: AbortSignal.timeout(10_000),
  redirect: "error",
});
if (!response.ok)
  throw new Error(
    "Credential creation failed; inspect the account before retrying",
  );
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** @type {unknown} */
const result = await response.json();
const responses = record(result) ? result["methodResponses"] : undefined;
/** @type {unknown} */
const item = Array.isArray(responses) ? responses[0] : undefined;
/** @type {unknown} */
const body =
  Array.isArray(item) && item[0] === "x:AppPassword/set" ? item[1] : undefined;
const created = record(body) ? body["created"] : undefined;
const credential = record(created) ? created["inbound"] : undefined;
if (
  !record(credential) ||
  typeof credential["id"] !== "string" ||
  typeof credential["secret"] !== "string" ||
  !credential["secret"]
) {
  throw new Error(
    "Credential creation was not confirmed; inspect the account before retrying",
  );
}
const credentialId = credential["id"];
const secret = credential["secret"];
const authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`;
const client = new JmapClient(origin, {
  authorization,
  rewriteSessionUrlsToOrigin: origin,
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        "x-forwarded-for": clientIp,
      },
    }),
});
const session = await client.discover();
if (session.isErr())
  throw new Error(
    `Credential ${credentialId} was created but discovery failed; revoke it before retrying`,
  );
const mailAccount = session.value.primaryAccounts[JmapCapability.mail];
if (mailAccount !== accountId)
  throw new Error(
    `Credential ${credentialId} was created but resolved a different account; revoke it before retrying`,
  );
const mailboxes = await client.mailboxes(session.value, mailAccount);
if (mailboxes.isErr())
  throw new Error(
    `Credential ${credentialId} was created but mailbox listing failed; revoke it before retrying`,
  );
const junk = mailboxes.value.list.find((mailbox) => mailbox.role === "junk");
if (!junk)
  throw new Error(
    `Credential ${credentialId} was created but no junk mailbox exists; revoke it before retrying`,
  );
// The caller must redirect stdout to a private file; never write this to logs.
process.stdout.write(
  `${JSON.stringify({ credentialId, destination: { id: accountId, origin: "http://stalwart:8080", authorization, quarantineMailbox: junk.id, rewriteSessionUrls: true } })}\n`,
);
