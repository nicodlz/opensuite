import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createDirectConnector,
  directDestinationPolicy,
  revokeGoogleToken,
} from "../src/adapters/migration-direct.ts";

describe("IMAP destination policy", () => {
  it("rejects malformed operator policies at startup", () => {
    for (const policy of [
      "mail.example.org",
      "mail.example.org:0",
      "mail.example.org:65536",
      "127.0.0.1:993",
      "mail.example.org:993,",
      "mail.example.org:993:123",
    ])
      expect(() => directDestinationPolicy(policy)).toThrow(
        "Invalid IMAP destination policy",
      );
    expect(() => directDestinationPolicy("")).not.toThrow();
  });
  it("requires an exact allowlist, rejects mixed public and private DNS answers, and pins a public IPv4 address", async () => {
    let answers = [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const policy = directDestinationPolicy("mail.example.org:993", () =>
      Promise.resolve(answers),
    );
    await expect(policy("mail.example.org", 995)).rejects.toThrow("denied");
    await expect(policy("127.0.0.1", 993)).rejects.toThrow("denied");
    await expect(policy("mail.example.org", 993)).rejects.toThrow("denied");
    answers = [
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ];
    await expect(policy("mail.example.org", 993)).resolves.toBe("8.8.8.8");
  });
  it("posts OAuth revocation in the body to the fixed endpoint and reports failures", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(revokeGoogleToken("private-token")).resolves.toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(body instanceof URLSearchParams ? body.toString() : undefined).toBe(
      "token=private-token",
    );
    await expect(revokeGoogleToken("private-token")).resolves.toBe(false);
    fetcher.mockRestore();
  });
});

const raw = Buffer.from(
  "Message-ID: <fixture@example.test>\r\nSubject: fixture\r\n\r\nhello\r\n",
);
let dir = "";
let cert: Buffer;
let port = 0;
let server: ReturnType<typeof createServer>;
const commands: string[] = [];
let gmailMode = false;
function handle(socket: TLSSocket) {
  socket.write(
    `* OK [CAPABILITY IMAP4rev1${gmailMode ? " X-GM-EXT-1" : ""}] simulated IMAP ready\r\n`,
  );
  let pending = "";
  socket.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    while (pending.includes("\r\n")) {
      const cut = pending.indexOf("\r\n");
      const line = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      const match = /^(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const tag = match[1];
      const command = match[2];
      if (tag === undefined || command === undefined) continue;
      commands.push(command.replace(/LOGIN.*/i, "LOGIN [redacted]"));
      if (/^CAPABILITY/i.test(command))
        socket.write(
          `* CAPABILITY IMAP4rev1${gmailMode ? " X-GM-EXT-1" : ""}\r\n${tag} OK capability\r\n`,
        );
      else if (/^LOGIN/i.test(command))
        socket.write(
          /bad-password/.test(command)
            ? `${tag} NO authentication failed\r\n`
            : `${tag} OK authenticated\r\n`,
        );
      else if (/^LIST/i.test(command))
        socket.write(
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n${gmailMode ? '* LIST (\\HasNoChildren) "/" "Project"\r\n' : ""}${tag} OK list\r\n`,
        );
      else if (/^EXAMINE/i.test(command))
        socket.write(
          `* FLAGS (\\Seen \\Flagged)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 10] valid\r\n* OK [UIDNEXT 8] next\r\n${tag} OK [READ-ONLY] examined\r\n`,
        );
      else if (/^(UID )?FETCH/i.test(command) && /BODY\.PEEK/i.test(command))
        socket.write(
          Buffer.concat([
            Buffer.from(`* 1 FETCH (UID 7 BODY[] {${raw.length}}\r\n`),
            raw,
            Buffer.from(`)\r\n${tag} OK fetch\r\n`),
          ]),
        );
      else if (/^(UID )?FETCH/i.test(command))
        socket.write(
          `* 1 FETCH (UID 7 RFC822.SIZE ${raw.length} FLAGS (\\Seen) INTERNALDATE "02-Jan-2020 03:04:05 +0000"${gmailMode ? ' X-GM-MSGID 42 X-GM-LABELS ("Project" "Sent")' : ""})\r\n${tag} OK fetch\r\n`,
        );
      else if (/^LOGOUT/i.test(command))
        socket.end(`* BYE bye\r\n${tag} OK logout\r\n`);
      else socket.write(`${tag} OK done\r\n`);
    }
  });
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "direct-imap-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=imap.test",
      "-addext",
      "subjectAltName=DNS:imap.test",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"));
  server = createServer(
    { key: readFileSync(join(dir, "key.pem")), cert },
    handle,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture port unavailable");
  port = address.port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

it("uses verified TLS, read-only selection and PEEK to preserve source bytes and date", async () => {
  commands.length = 0;
  const connect = createDirectConnector(() => Promise.resolve("127.0.0.1"), {
    ca: cert,
  });
  const source = await connect({
    kind: "imap",
    host: "imap.test",
    port,
    username: "owner",
    password: "test-password",
    authKind: "password",
  });
  try {
    const refs = await source.inventory();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      uid: 7,
      validity: "10",
      labels: ["INBOX"],
      date: "2020-01-02T03:04:05.000Z",
    });
    const ref = refs[0];
    if (!ref) throw new Error("Missing source message");
    expect(await source.read(ref)).toEqual(raw);
    expect(commands.some((command) => /^EXAMINE/i.test(command))).toBe(true);
    expect(commands.some((command) => /BODY\.PEEK/i.test(command))).toBe(true);
    expect(
      commands.some((command) =>
        /^(SELECT|STORE|EXPUNGE|COPY|MOVE|APPEND)/i.test(command),
      ),
    ).toBe(false);
  } finally {
    source.close();
  }
}, 30_000);

it("rejects incorrect credentials and an untrusted TLS certificate", async () => {
  const source = {
    kind: "imap" as const,
    host: "imap.test",
    port,
    username: "owner",
    password: "bad-password",
    authKind: "password" as const,
  };
  await expect(
    createDirectConnector(() => Promise.resolve("127.0.0.1"), { ca: cert })(
      source,
    ),
  ).rejects.toThrow("Source connection failed");
  await expect(
    createDirectConnector(() => Promise.resolve("127.0.0.1"))(source),
  ).rejects.toThrow("Source connection failed");
}, 30_000);

it("merges Gmail labels across folders using the server message identifier", async () => {
  gmailMode = true;
  const connect = createDirectConnector(() => Promise.resolve("127.0.0.1"), {
    ca: cert,
  });
  try {
    const source = await connect({
      kind: "gmail",
      host: "imap.test",
      port,
      username: "owner",
      password: "test-password",
      authKind: "password",
    });
    try {
      const refs = await source.inventory();
      expect(refs).toHaveLength(1);
      expect(refs[0]?.labels).toEqual(
        expect.arrayContaining(["INBOX", "Project", "Sent"]),
      );
      expect(refs[0]?.emailId).not.toBeNull();
    } finally {
      source.close();
    }
  } finally {
    gmailMode = false;
  }
}, 30_000);
