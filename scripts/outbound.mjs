import { readFile } from "node:fs/promises";
import { StalwartAdmin } from "../packages/jmap/src/admin.ts";

// Run on a trusted host with network access to the management listener.
const [action, origin, passwordFile, argument] = process.argv.slice(2);
if (
  !action ||
  !origin ||
  !passwordFile ||
  !["apply", "dns", "reset"].includes(action)
) {
  throw new Error(
    "Usage: node --experimental-strip-types scripts/outbound.mjs apply|dns|reset ADMIN_ORIGIN ADMIN_PASSWORD_FILE [USERNAME|DOMAIN_ID]",
  );
}
const password = (await readFile(passwordFile, "utf8")).trim();
if (!password) throw new Error("Administrator password file is empty");
const admin = new StalwartAdmin(origin, { username: "admin", password });
let result;
if (action === "apply") {
  if (!argument) throw new Error("SMTP username is required");
  const secretPath = process.env["MAIL_RELAY_SECRET_FILE"];
  if (!secretPath)
    throw new Error("MAIL_RELAY_SECRET_FILE must name the mounted secret file");
  if ((await readFile(secretPath)).length === 0)
    throw new Error("SMTP secret file is empty");
  result = await admin.configureRelay({
    host: "email-smtp.eu-north-1.amazonaws.com",
    port: 2587,
    username: argument,
    secretFile: "/run/opensuite/smtp-secret",
    tls: "starttls",
  });
} else if (action === "dns") {
  if (!argument) throw new Error("Domain ID is required");
  result = await admin.dkimRecords(argument);
} else {
  result = await admin.resetOutbound();
}
if (result.isErr()) {
  process.stderr.write(`${JSON.stringify(result.error)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify(result.value ?? { applied: true })}\n`,
  );
}
