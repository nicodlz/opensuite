import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";

const run = promisify(execFile);
const env = {
  ...process.env,
  COMPOSE_PROFILES: "",
  DRIVE_S3_ENDPOINT: "http://fixture.invalid",
  DRIVE_S3_PUBLIC_ENDPOINT: "http://fixture.invalid",
  DRIVE_S3_BUCKET: "fixture",
  DRIVE_S3_REGION: "fixture",
  DRIVE_S3_ACCESS_KEY: "fixture",
  DRIVE_S3_SECRET_FILE: "/dev/null",
};
const config = async (profile: boolean) => {
  const args = [
    "compose",
    "--env-file",
    "deploy/env.example",
    "-f",
    "compose.yaml",
  ];
  if (profile) args.push("--profile", "vault");
  const { stdout } = await run(
    "docker",
    [...args, "config", "--format", "json"],
    { env },
  );
  return z
    .object({
      services: z.record(
        z.string(),
        z
          .object({ depends_on: z.record(z.string(), z.unknown()).optional() })
          .passthrough(),
      ),
    })
    .parse(JSON.parse(stdout));
};
test("Compose profiles and Vault dependencies", async () => {
  const normal = await config(false);
  const enabled = await config(true);
  expect(normal.services["vault"]).toBeUndefined();
  expect(normal.services["vault-provision"]).toBeUndefined();
  const vault = enabled.services["vault"];
  const provision = enabled.services["vault-provision"];
  const postgres = enabled.services["postgres"];
  expect(Object.keys(vault?.depends_on ?? {}).toSorted()).toEqual([
    "postgres",
    "secrets",
    "vault-provision",
  ]);
  expect(Object.keys(provision?.depends_on ?? {}).toSorted()).toEqual([
    "postgres",
    "secrets",
  ]);
  expect(Object.keys(postgres?.depends_on ?? {})).toEqual(["secrets"]);
});
test("Caddyfile validates", async () => {
  const result = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${process.cwd()}/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro`,
      "--entrypoint",
      "caddy",
      "caddy:2.11.7@sha256:5e5286cb37d44086d651a5363f05f43a692ce4d649d88fb1bd844579f45fa9e8",
      "validate",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ],
    { env },
  );
  expect(result.stderr + result.stdout).toContain("Valid configuration");
}, 60_000);

// The branded shell names the bundle files of one web-vault build.
test("Vault image pins match the generated web-vault shell", async () => {
  const pin = /vaultwarden\/server:[^\s"'}]+/;
  const [compose, example, generator] = await Promise.all(
    [
      "compose.yaml",
      "deploy/env.example",
      "scripts/generate-vault-brand.mjs",
    ].map(async (path) => (await readFile(path, "utf8")).match(pin)?.[0]),
  );
  expect(compose).toBeDefined();
  expect(example).toBe(compose);
  expect(generator).toBe(compose);
});
