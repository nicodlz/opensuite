import { execFile } from "node:child_process";
import { isIP } from "node:net";
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
  BACKUP_REPOSITORY: "fixture",
  BACKUP_ACCESS_KEY_ID: "fixture",
  BACKUP_SECRET_ACCESS_KEY: "fixture",
  BACKUP_STAGE: "/tmp",
  BACKUP_PASSWORD_FILE: "/dev/null",
};
const configSchema = z.object({
  services: z.record(
    z.string(),
    z.object({
      networks: z
        .record(
          z.string(),
          z.object({ ipv4_address: z.string().optional() }).nullable(),
        )
        .optional(),
      environment: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  networks: z.record(z.string(), z.unknown()),
});
const subnetOf = (network: unknown) =>
  z
    .object({
      ipam: z.object({ config: z.array(z.object({ subnet: z.string() })) }),
    })
    .parse(network).ipam.config[0]?.subnet;

const numberOf = (ip: string) => {
  expect(isIP(ip)).toBe(4);
  return ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
};

test("all proxy and management endpoints have distinct static addresses in their subnets", async () => {
  const { stdout } = await run(
    "docker",
    [
      "compose",
      "--env-file",
      "deploy/env.example",
      "--profile",
      "*",
      "-f",
      "compose.yaml",
      "-f",
      "deploy/backup/compose.backup.yaml",
      "-f",
      "deploy/stalwart/compose.bootstrap.yaml",
      "config",
      "--format",
      "json",
    ],
    { env },
  );
  const config = configSchema.parse(JSON.parse(stdout));
  const expected = {
    "api-proxy": ["api", "caddy"],
    "mail-management": [
      "api",
      "backup-management",
      "management",
      "stalwart",
      "stalwart-bootstrap",
      "stalwart-setup",
    ],
  };
  for (const [network, services] of Object.entries(expected)) {
    const members = Object.entries(config.services).filter(
      ([, service]) => service.networks?.[network] !== undefined,
    );
    expect(members.map(([name]) => name).toSorted()).toEqual(services);
    const subnet = subnetOf(config.networks[network]);
    expect(subnet).toBeDefined();
    const [base = "", bits = ""] = (subnet ?? "").split("/");
    const prefix = Number(bits);
    expect(prefix).toBeGreaterThanOrEqual(0);
    expect(prefix).toBeLessThanOrEqual(30);
    const size = 2 ** (32 - prefix);
    const start = Math.floor(numberOf(base) / size) * size;
    const addresses = members.map(([name, service]) => {
      const address = service.networks?.[network]?.ipv4_address;
      expect(address, `${name} on ${network}`).toBeDefined();
      const value = numberOf(address ?? "");
      expect(value, `${name} on ${network}`).toBeGreaterThan(start);
      expect(value, `${name} on ${network}`).toBeLessThan(start + size - 1);
      return address;
    });
    expect(new Set(addresses).size).toBe(addresses.length);
  }
  const api = config.services["api"];
  const caddy = config.services["caddy"];
  expect(api?.networks?.["api-proxy"]?.ipv4_address).not.toBe(
    caddy?.networks?.["api-proxy"]?.ipv4_address,
  );
  expect(api?.environment?.["TRUSTED_PROXY_IP"]).toBe(
    caddy?.networks?.["api-proxy"]?.ipv4_address,
  );
  expect(api?.environment?.["STALWART_MANAGEMENT_CLIENT_IP"]).toBe(
    api?.networks?.["mail-management"]?.ipv4_address,
  );
  expect(caddy?.environment?.["MAIL_MANAGEMENT_SUBNET"]).toBe(
    subnetOf(config.networks["mail-management"]),
  );
});
