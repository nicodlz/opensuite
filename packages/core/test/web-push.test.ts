import { execFile } from "node:child_process";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Agent, createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createWebPushTransport } from "../src/adapters/web-push.ts";
import {
  createNotificationDispatcher,
  type NotificationStore,
} from "../src/services/notifications.ts";

it("signs and encrypts a real push request and purges a 410 endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "esuno-push-test-"));
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const [key, cert] = await Promise.all([
    readFile(keyFile),
    readFile(certFile),
  ]);
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  let received:
    | {
        auth: string;
        encoding: string;
        ttl: string;
        urgency: string;
        body: Buffer;
      }
    | undefined;
  const server = createServer({ key, cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        auth: request.headers.authorization ?? "",
        encoding: request.headers["content-encoding"] ?? "",
        ttl: String(request.headers["ttl"] ?? ""),
        urgency: String(request.headers["urgency"] ?? ""),
        body: Buffer.concat(chunks),
      };
      response.writeHead(410).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mock server address unavailable");
  const endpoint = `https://127.0.0.1:${address.port}/push`;
  const agent = new Agent({ ca: cert });
  const purge = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
  const store: NotificationStore = {
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    showDetails: () => Promise.resolve(true),
    eligible: () =>
      Promise.resolve([
        {
          id: "one",
          endpoint,
          p256dh: receiver.getPublicKey().toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
          failureCount: 0,
        },
      ]),
    success: () => Promise.resolve(),
    purge,
    failure: () => Promise.resolve(),
  };
  try {
    const dispatcher = createNotificationDispatcher(
      store,
      createWebPushTransport(
        vapid.getPublicKey().toString("base64url"),
        vapid.getPrivateKey().toString("base64url"),
        "https://example.test",
        agent,
      ),
    );
    const result = await dispatcher.notifyWithResult(
      "user",
      "calendar",
      { title: "Private test content", url: "/calendar", tag: "test" },
      { ttl: 3600, urgency: "high" },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      delivered: 0,
      failed: 1,
    });
    expect(purge).toHaveBeenCalledWith("one");
    expect(received).toBeDefined();
    if (!received) throw new Error("no request received");
    expect(received).toMatchObject({
      encoding: "aes128gcm",
      ttl: "3600",
      urgency: "high",
    });
    expect(received.body.length).toBeGreaterThan(86);
    expect(received.body.includes(Buffer.from("Private test content"))).toBe(
      false,
    );
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(received.auth);
    if (!match?.[1] || !match[2]) throw new Error("invalid VAPID header");
    expect(match[2]).toBe(vapid.getPublicKey().toString("base64url"));
    const parts = match[1].split(".");
    const [header, claims, signature] = parts;
    if (!header || !claims || !signature) throw new Error("invalid JWT");
    const publicBytes = vapid.getPublicKey();
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: publicBytes.subarray(1, 33).toString("base64url"),
        y: publicBytes.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(claims, "base64url").toString()),
    ).toMatchObject({
      aud: `https://127.0.0.1:${address.port}`,
      sub: "https://example.test",
    });
  } finally {
    agent.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
