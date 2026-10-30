// These checks exercise sequential ownership and release of fixed addresses.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { createVaultFixture } from "./vault-fixture.js";

const run = promisify(execFile);
const alpine =
  "alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a";

test("API before Caddy and one-off management containers retain distinct addresses", async () => {
  const fixture = createVaultFixture("network");
  const directory = await mkdtemp(join(tmpdir(), "opensuite-network-"));
  const overlay = join(directory, "compose.yaml");
  Object.assign(fixture.env, {
    BACKUP_REPOSITORY: "fixture",
    BACKUP_ACCESS_KEY_ID: "fixture",
    BACKUP_SECRET_ACCESS_KEY: "fixture",
    BACKUP_STAGE: directory,
    BACKUP_PASSWORD_FILE: "/dev/null",
  });
  await writeFile(
    overlay,
    `services:
  caddy:
    volumes: !override
      - ${process.cwd()}/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
  api:
    image: ${alpine}
    entrypoint: ["sh", "-c"]
    command: ["sleep 300"]
    depends_on: !override {}
    volumes: !override []
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 2s
      retries: 10
      start_period: 0s
  stalwart:
    image: ${alpine}
    entrypoint: ["sh", "-c"]
    command: ["sleep 300"]
    depends_on: !override {}
    ports: !override []
    volumes: !override []
    healthcheck: {disable: true}
  stalwart-setup:
    image: ${alpine}
    volumes: !override []
  management:
    image: ${alpine}
    volumes: !override []
  backup-management:
    volumes: !override []
`,
  );
  const args = [
    ...fixture.args,
    "-f",
    "deploy/backup/compose.backup.yaml",
    "-f",
    overlay,
    "--profile",
    "ops",
  ];
  const docker = async (...command: string[]) =>
    (
      await run("docker", command, {
        env: fixture.env,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  const compose = (...command: string[]) => docker(...args, ...command);
  try {
    await fixture.chooseSubnets();
    await compose("up", "-d", "--no-deps", "--wait", "api");
    await compose("up", "-d", "--no-deps", "--wait", "caddy");
    await compose("up", "-d", "--no-deps", "stalwart");
    for (const [service, network, ip] of [
      ["api", "api-proxy", fixture.env.API_PROXY_API_IP],
      ["caddy", "api-proxy", fixture.env.API_PROXY_CADDY_IP],
      ["stalwart", "mail-management", fixture.env.MAIL_MANAGEMENT_STALWART_IP],
    ]) {
      const id = await compose("ps", "-q", service ?? "");
      const inspected = z
        .array(
          z.object({
            State: z.object({ Running: z.boolean() }),
            NetworkSettings: z.object({
              Networks: z.record(
                z.string(),
                z.object({ IPAddress: z.string() }),
              ),
            }),
          }),
        )
        .parse(JSON.parse(await docker("inspect", id)));
      expect(inspected[0]?.State.Running).toBe(true);
      expect(
        inspected[0]?.NetworkSettings.Networks[`${fixture.project}_${network}`]
          ?.IPAddress,
        `${service}: ${JSON.stringify(inspected[0])}`,
      ).toBe(ip);
    }
    const address = await compose(
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "sh",
      "backup-management",
      "-c",
      "hostname -i",
    );
    expect(address).toBe(fixture.env.MAIL_MANAGEMENT_BACKUP_IP);

    // An active one-off owns its fixed address until it exits; operators must
    // serialize invocations of each service (backup.sh uses a host flock).
    for (const service of [
      "backup-management",
      "stalwart-setup",
      "management",
    ]) {
      const id = await compose(
        "run",
        "-d",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "sh",
        service,
        "-c",
        "sleep 300",
      );
      try {
        await expect(
          compose(
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "--entrypoint",
            "sh",
            service,
            "-c",
            "true",
          ),
        ).rejects.toThrow(/address already in use/i);
      } finally {
        await docker("rm", "-f", id);
      }
      await compose(
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "sh",
        service,
        "-c",
        "true",
      );
    }
  } finally {
    try {
      const leftovers = await docker(
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${fixture.project}`,
      );
      if (leftovers) await docker("rm", "-f", ...leftovers.split(/\s+/));
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 180_000);
