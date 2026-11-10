import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import { ContactSchema } from "@opensuite/contracts";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { type JmapResult } from "@opensuite/jmap";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const project = `contact-phones-${randomBytes(8).toString("hex")}`;
const origin = "https://phone-import.example.test";
const monotonicMs = () => performance.now();
const account = { accountId: "default" };
const compose = async (...args: string[]) =>
  (
    await run(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "deploy/stalwart/compose.stalwart-test.yaml",
        ...args,
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        maxBuffer: 4_000_000,
        timeout: 150_000,
      },
    )
  ).stdout;
const value = <T>(result: JmapResult<T>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const listSchema = z.object({
  state: z.string(),
  contacts: z.array(ContactSchema),
});
const importSchema = z.object({
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative().default(0),
  merged: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative(),
  failed: z
    .array(z.object({ index: z.number().int(), reason: z.string() }))
    .default([]),
});
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let httpOrigin = "";
let bookId = "";
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    await app?.close();
  } finally {
    await compose("down", "-v", "--remove-orphans");
  }
}
async function ready(base: string, remaining = 120): Promise<void> {
  try {
    if (
      (
        await fetch(`${base}/healthz/ready`, {
          signal: AbortSignal.timeout(2_000),
        })
      ).ok
    )
      return;
  } catch {
    // The isolated server may still be booting.
  }
  if (!remaining) throw new Error("Isolated Stalwart did not become ready");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await ready(base, remaining - 1);
}
async function post(path: string, payload: object, user = "alice") {
  const response = await fetch(`${httpOrigin}/contacts/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: user,
    },
    body: JSON.stringify({ ...account, ...payload }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}
async function success<T>(path: string, payload: object, schema: z.ZodType<T>) {
  const response = await post(path, payload);
  if (response.status !== 200)
    throw new Error(
      `HTTP ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  return schema.parse(response.body);
}
const list = () => success("list", {}, listSchema);
const phones = (contact: z.infer<typeof ContactSchema>) =>
  Object.values(contact.phones ?? {});
function vcard(email: string, properties: string[], name = "Nom source") {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `EMAIL:${email}`,
    ...properties,
    "END:VCARD",
    "",
  ].join("\r\n");
}
async function create(contact: object) {
  const snapshot = await list();
  return success(
    "create",
    { bookId, state: snapshot.state, contact },
    z.object({ id: z.string() }),
  );
}
async function importCard(text: string) {
  const snapshot = await list();
  return success(
    "import",
    { bookId, state: snapshot.state, vcard: text, enrichExisting: true },
    importSchema,
  );
}

beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port || !/^\d+$/.test(port)) throw new Error("Missing test port");
    const stalwartOrigin = `http://127.0.0.1:${port}`;
    await ready(stalwartOrigin);
    const admin = new StalwartAdmin(stalwartOrigin, {
      username: "admin",
      password: "integration-password",
    });
    const domain = value(await admin.createDomain("example.test"));
    const aliceId = value(
      await admin.createAccount("alice", domain.id, "unused-test-password"),
    ).id;
    const secret = value(await admin.createAppPassword(aliceId)).secret;
    const contacts = createContactsService({
      codec: contactVcardCodec,
      origin: stalwartOrigin,
      store: {
        getForOwner: (userId, accountId) =>
          Promise.resolve(
            userId === "alice" && accountId === "default"
              ? ok({
                  accountId: aliceId,
                  address: "alice@example.test",
                  secret,
                })
              : err({ kind: "not_found" }),
          ),
      },
    });
    app = await buildServer({
      config: { logLevel: "silent" },
      monotonicMs,
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs,
      }),
      contacts,
      identity: {
        publicOrigin: origin,
        handler: () => Promise.resolve(new Response()),
        actor: (headers) =>
          Promise.resolve(
            headers.get("cookie") === "alice"
              ? {
                  id: "alice",
                  email: "alice@example.test",
                  role: "user" as const,
                }
              : null,
          ),
      },
    });
    httpOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    const books = await success(
      "books",
      {},
      z.object({ books: z.array(z.object({ id: z.string() })).min(1) }),
    );
    bookId = books.books[0]?.id ?? "";
    if (!bookId) throw new Error("Missing test address book");
  } catch (error) {
    await cleanup();
    throw error;
  }
}, 180_000);
afterAll(cleanup, 180_000);

describe("contact phone preservation over real HTTP and pinned Stalwart", () => {
  it("imports TEL over TCP, returns phones and exports TEL without loss", async () => {
    const email = "tcp-tel@example.test";
    const result = await importCard(
      vcard(email, [
        "TEL;TYPE=CELL:+33611223344",
        "TEL;TYPE=WORK:+33122334455",
      ]),
    );
    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    const snapshot = await list();
    const found = snapshot.contacts.filter((item) =>
      item.emails.includes(email),
    );
    expect(found).toHaveLength(1);
    const contact = found[0];
    if (!contact) throw new Error("Imported contact missing");
    expect(
      phones(contact)
        .map((phone) => phone.number)
        .toSorted(),
    ).toEqual(["+33122334455", "+33611223344"]);
    const exported = await success(
      "export",
      { ids: [contact.id] },
      z.object({ vcard: z.string(), warnings: z.array(z.string()) }),
    );
    expect(exported.warnings).toEqual([]);
    expect(exported.vcard).toMatch(/TEL[^\r\n]*\+33611223344/);
    expect(exported.vcard).toMatch(/TEL[^\r\n]*\+33122334455/);
  }, 30_000);

  it("enriches the same legacy name/email ID and makes reimport a no-op", async () => {
    const email = "legacy-tcp@example.test";
    const legacy = await create({
      name: "Nom choisi par utilisateur",
      emails: [email],
    });
    const before = await list();
    const text = vcard(email, [
      "UID:7f771fb9-c903-4cd3-9708-32bd8d8a7660",
      "TEL;TYPE=CELL:+33622334455",
    ]);
    const enriched = await importCard(text);
    expect(enriched).toMatchObject({
      imported: 0,
      updated: 1,
      skipped: 0,
      failed: [],
    });
    const first = await list();
    expect(first.contacts).toHaveLength(before.contacts.length);
    const contact = first.contacts.find((item) => item.id === legacy.id);
    if (!contact) throw new Error("Historical contact replaced");
    expect(contact.name).toBe("Nom choisi par utilisateur");
    expect(phones(contact).map((phone) => phone.number)).toContain(
      "+33622334455",
    );
    const again = await importCard(text);
    expect(again).toMatchObject({
      imported: 0,
      updated: 0,
      merged: 0,
      skipped: 1,
      failed: [],
    });
    const second = await list();
    expect(second.state).toBe(first.state);
    expect(second.contacts).toEqual(first.contacts);
    const exported = await success(
      "export",
      { ids: [legacy.id] },
      z.object({ vcard: z.string() }),
    );
    expect(exported.vcard).toMatch(/TEL[^\r\n]*\+33622334455/);
  }, 30_000);

  it("adds multiple numbers while preserving an existing user phone label", async () => {
    const email = "labels-tcp@example.test";
    const legacy = await create({
      name: "Contact corrigé",
      emails: [email],
      phones: {
        user: {
          number: "+33633445566",
          label: "Choix utilisateur",
          features: { mobile: true },
        },
      },
    });
    const result = await importCard(
      vcard(email, [
        "item1.TEL;TYPE=CELL:+33633445566",
        "item1.X-ABLabel:Libellé source",
        "item2.TEL;TYPE=WORK:+33133445566",
        "item2.X-ABLabel:Bureau source",
        "TEL;TYPE=HOME:+33433445566",
      ]),
    );
    expect(result).toMatchObject({ imported: 0, updated: 1, failed: [] });
    const snapshot = await list();
    const contact = snapshot.contacts.find((item) => item.id === legacy.id);
    if (!contact) throw new Error("Enriched contact missing");
    const values = phones(contact);
    expect(values).toHaveLength(3);
    expect(
      values.find((phone) => phone.number === "+33633445566"),
    ).toMatchObject({ label: "Choix utilisateur" });
    expect(
      values.find((phone) => phone.number === "+33133445566"),
    ).toMatchObject({ label: "Bureau source" });
    expect(contact.name).toBe("Contact corrigé");
  }, 30_000);

  it("does not merge or duplicate contacts when one email identifies two existing cards", async () => {
    const email = "ambiguous-tcp@example.test";
    await create({ name: "Première personne", emails: [email] });
    await create({ name: "Deuxième personne", emails: [email] });
    const before = await list();
    const result = await importCard(
      vcard(email, ["TEL;TYPE=CELL:+33644556677"]),
    );
    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(0);
    expect(result.failed[0]?.reason).toMatch(/ambig/i);
    const after = await list();
    expect(after.state).toBe(before.state);
    expect(after.contacts).toEqual(before.contacts);
  }, 30_000);

  it("rejects stale import state and unauthenticated HTTP without adding a contact", async () => {
    const before = await list();
    await create({
      name: "Concurrent edit",
      emails: ["concurrent-tcp@example.test"],
    });
    const text = vcard("stale-tcp@example.test", ["TEL:+33655667788"]);
    const stale = await post("import", {
      bookId,
      state: before.state,
      vcard: text,
    });
    expect(stale.status).toBe(409);
    const unauthenticated = await post(
      "import",
      { bookId, state: (await list()).state, vcard: text },
      "unknown",
    );
    expect(unauthenticated.status).toBe(401);
    expect(
      (await list()).contacts.some((item) =>
        item.emails.includes("stale-tcp@example.test"),
      ),
    ).toBe(false);
  }, 30_000);

  it("rejects a stale explicit target index before any HTTP import mutation", async () => {
    const legacy = await create({
      name: "Nom corrigé sans e-mail",
      emails: [],
    });
    const before = await list();
    const response = await post("import", {
      bookId,
      state: before.state,
      vcard: vcard("wrong-index@example.test", ["TEL:+33666778899"]),
      targets: { "1": legacy.id },
    });
    expect(response.status).toBe(400);
    const after = await list();
    expect(after.state).toBe(before.state);
    expect(after.contacts).toEqual(before.contacts);
  }, 30_000);

  it("keeps a new note and organization when enriching a legacy contact over HTTP", async () => {
    const email = "note-upgrade@example.test";
    const legacy = await create({
      name: "Nom utilisateur",
      emails: [email],
      notes: { user: { note: "Note utilisateur" } },
    });
    const result = await importCard(
      vcard(email, [
        "TEL:+33677889900",
        "NOTE:Note importée",
        "ORG:Entreprise importée",
        "TITLE:Architecte",
      ]),
    );
    expect(result).toMatchObject({ imported: 0, updated: 1, failed: [] });
    const exported = await success(
      "export",
      { ids: [legacy.id] },
      z.object({ vcard: z.string() }),
    );
    expect(exported.vcard).toContain("Note utilisateur");
    expect(exported.vcard).toContain("Note importée");
    expect(exported.vcard).toContain("Entreprise importée");
    expect(exported.vcard).toContain("Architecte");
    expect(exported.vcard).toMatch(/TEL[^\r\n]*\+33677889900/);
  }, 30_000);

  it("reimports a metadata-free telephone without another native write", async () => {
    const email = "bare-tel-replay@example.test";
    await create({ name: "Nom utilisateur", emails: [email] });
    const text = vcard(email, ["TEL:+33688990011"]);
    expect(await importCard(text)).toMatchObject({ updated: 1 });
    const first = await list();
    expect(await importCard(text)).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: [],
    });
    const second = await list();
    expect(second).toEqual(first);
  }, 30_000);

  it("preserves an incoming custom vCard property when enriching a legacy card", async () => {
    const email = "custom-upgrade@example.test";
    const legacy = await create({ name: "Nom utilisateur", emails: [email] });
    const text = vcard(email, [
      "TEL:+33699001122",
      "X-ESUNO-REFERENCE:Référence importée",
    ]);
    expect(await importCard(text)).toMatchObject({ updated: 1, failed: [] });
    const exported = await success(
      "export",
      { ids: [legacy.id] },
      z.object({ vcard: z.string() }),
    );
    expect(exported.vcard).toMatch(/X-ESUNO-REFERENCE:Référence importée/);
    const first = await list();
    expect(await importCard(text)).toMatchObject({ updated: 0, skipped: 1 });
    expect(await list()).toEqual(first);
  }, 30_000);

  it("does not silently drop an unsupported photo during historical enrichment", async () => {
    const email = "photo-upgrade@example.test";
    await create({ name: "Nom utilisateur", emails: [email] });
    const before = await list();
    const result = await importCard(
      vcard(email, [
        "TEL:+33600112233",
        "PHOTO;VALUE=URI:https://images.example.test/avatar.jpg",
      ]),
    );
    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.failed).toEqual([{ index: 0, reason: "unsupported_fields" }]);
    expect(await list()).toEqual(before);
  }, 30_000);

  it("keeps old import clients create-only unless enrichment is explicitly requested", async () => {
    const email = "legacy-create-only@example.test";
    await create({ name: "Nom utilisateur", emails: [email] });
    const before = await list();
    const result = await success(
      "import",
      {
        bookId,
        state: before.state,
        vcard: vcard(email, ["TEL:+33611220099"]),
      },
      importSchema,
    );
    expect(result).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: [],
    });
    expect(await list()).toEqual(before);
  }, 30_000);

  it("adds an extension parameter to an existing phone without replacing its ID or label", async () => {
    const email = "existing-phone-parameter@example.test";
    const legacy = await create({
      name: "Nom utilisateur",
      emails: [email],
      phones: {
        user: {
          number: "+33622110099",
          features: { mobile: true },
          label: "Mon libellé",
        },
      },
    });
    const text = vcard(email, ["TEL;TYPE=CELL;X-CUSTOM=portable:+33622110099"]);
    expect(await importCard(text)).toMatchObject({ updated: 1, failed: [] });
    const first = await list();
    const contact = first.contacts.find((item) => item.id === legacy.id);
    expect(contact?.phones?.["user"]).toMatchObject({
      number: "+33622110099",
      label: "Mon libellé",
    });
    const exported = await success(
      "export",
      { ids: [legacy.id] },
      z.object({ vcard: z.string() }),
    );
    expect(exported.vcard).toMatch(
      /TEL[^\r\n]*X-CUSTOM=portable[^\r\n]*\+33622110099/,
    );
    expect(await importCard(text)).toMatchObject({ updated: 0, skipped: 1 });
    expect(await list()).toEqual(first);
  }, 30_000);

  it("keeps email parameters aligned with retained and newly allocated native email IDs", async () => {
    const email = "existing-email-parameter@example.test";
    const added = "additional-email-parameter@example.test";
    const legacy = await create({ name: "Nom utilisateur", emails: [email] });
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Nom source",
      `EMAIL;X-CUSTOM=kept:${email}`,
      `EMAIL;X-OTHER=added:${added}`,
      "TEL:+33622330099",
      "END:VCARD",
      "",
    ].join("\r\n");
    expect(await importCard(text)).toMatchObject({ updated: 1, failed: [] });
    const first = await list();
    const contact = first.contacts.find((item) => item.id === legacy.id);
    expect(contact?.emails).toEqual(expect.arrayContaining([email, added]));
    const exported = await success(
      "export",
      { ids: [legacy.id] },
      z.object({ vcard: z.string() }),
    );
    expect(exported.vcard).toMatch(
      /EMAIL[^\r\n]*X-CUSTOM=kept[^\r\n]*:existing-email-parameter@example.test/,
    );
    expect(exported.vcard).toMatch(
      /EMAIL[^\r\n]*X-OTHER=added[^\r\n]*:additional-email-parameter@example.test/,
    );
    expect(await importCard(text)).toMatchObject({ updated: 0, skipped: 1 });
    expect(await list()).toEqual(first);
  }, 30_000);

  it("blocks conflicting raw note parameters instead of silently losing the second language", async () => {
    const email = "note-languages@example.test";
    await create({ name: "Nom utilisateur", emails: [email] });
    const before = await list();
    const result = await importCard(
      vcard(email, [
        "TEL:+33622440099",
        "NOTE;LANGUAGE=en:Hello",
        "NOTE;LANGUAGE=fr:Hello",
      ]),
    );
    expect(result).toMatchObject({
      imported: 0,
      updated: 0,
      failed: [{ index: 0, reason: "unsupported_fields" }],
    });
    expect(await list()).toEqual(before);
  }, 30_000);
});
