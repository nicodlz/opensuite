/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-return -- This standalone fixture is outside the TypeScript project. */
// Disposable fixture only. The CLI performs item and attachment encryption.
import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const [mode, origin, work] = process.argv.slice(2);
const cli = process.env.VAULT_DRILL_BW;
if (!cli) throw new Error("Missing pinned drill CLI");
const email = "recovery-fixture@example.invalid";
const password = "disposable-master-password-only";
const attachment = Buffer.from(
  "Disposable attachment fixture\0with binary bytes\xff",
  "latin1",
);
const env = {
  ...process.env,
  BITWARDENCLI_APPDATA_DIR: `${work}/cli-${mode}`,
  BW_PASSWORD: password,
};
const bw = (...args) =>
  execFileSync(cli, [...args, "--nointeraction"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const seal = (plain, key) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, data]))
    .digest();
  return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
};
if (mode === "create") {
  const verification = await fetch(
    `${origin}/identity/accounts/register/send-verification-email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ email }),
    },
  );
  if (!verification.ok)
    throw new Error(
      `Registration initiation failed: HTTP ${verification.status}`,
    );
  const emailVerificationToken = await verification.json();
  const master = pbkdf2Sync(password, email, 600000, 32, "sha256");
  const hash = pbkdf2Sync(master, password, 1, 32, "sha256").toString("base64");
  const stretch = (info) =>
    createHmac("sha256", master)
      .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
      .digest();
  const userKey = randomBytes(64);
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const response = await fetch(`${origin}/identity/accounts/register/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      emailVerificationToken,
      masterPasswordHash: hash,
      kdf: 0,
      kdfIterations: 600000,
      key: seal(userKey, Buffer.concat([stretch("enc"), stretch("mac")])),
      keys: {
        publicKey: pair.publicKey.toString("base64"),
        encryptedPrivateKey: seal(pair.privateKey, userKey),
      },
    }),
  });
  if (!response.ok)
    throw new Error(
      `Registration failed: HTTP ${response.status}: ${await response.text()}`,
    );
}
bw("config", "server", origin);
env.BW_SESSION = bw("login", email, "--passwordenv", "BW_PASSWORD", "--raw");
if (mode === "create") {
  const item = JSON.parse(bw("get", "template", "item"));
  item.type = 1;
  item.name = "recovery-item";
  item.login = {
    username: "fixture-user",
    password: "fixture-item-secret",
    uris: [],
  };
  const encoded = Buffer.from(JSON.stringify(item)).toString("base64");
  const created = JSON.parse(bw("create", "item", encoded));
  writeFileSync(`${work}/item-id`, created.id);
  writeFileSync(`${work}/attachment-fixture`, attachment);
  bw(
    "create",
    "attachment",
    "--file",
    `${work}/attachment-fixture`,
    "--itemid",
    created.id,
  );
  bw("logout");
} else if (mode === "verify") {
  const id = readFileSync(`${work}/item-id`, "utf8");
  bw("sync");
  const item = JSON.parse(bw("get", "item", id));
  if (
    item.name !== "recovery-item" ||
    item.login?.username !== "fixture-user" ||
    item.login?.password !== "fixture-item-secret"
  )
    throw new Error("Restored item did not decrypt correctly");
  if (item.attachments?.length !== 1)
    throw new Error("Restored attachment missing");
  bw(
    "get",
    "attachment",
    item.attachments[0].id,
    "--itemid",
    id,
    "--output",
    `${work}/downloaded`,
  );
  if (!readFileSync(`${work}/downloaded`).equals(attachment))
    throw new Error("Attachment bytes differ");
  bw("logout");
  rmSync(`${work}/downloaded`);
} else throw new Error("Unknown fixture mode");
