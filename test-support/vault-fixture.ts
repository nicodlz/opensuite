import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const ipNumber = (ip: string) =>
  ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
export function createVaultFixture(label: string) {
  const suffix = (process.env["OPENSUITE_RUN_ID"] ?? "local")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30);
  const project = `opensuite-${label}-${suffix}-${randomBytes(5).toString("hex")}`;
  const octet = (process.pid % 200) + 20;
  const env = {
    ...process.env,
    COMPOSE_PROFILES: "",
    HTTPS_PORT: "443",
    DRIVE_S3_ENDPOINT: "http://fixture.invalid",
    DRIVE_S3_PUBLIC_ENDPOINT: "http://fixture.invalid",
    DRIVE_S3_BUCKET: "fixture",
    DRIVE_S3_REGION: "fixture",
    DRIVE_S3_ACCESS_KEY: "fixture",
    DRIVE_S3_SECRET_FILE: "/dev/null",
    VAULT_PUBLIC_HOST: "vault.localhost",
    VAULT_ADMIN_TOKEN_FILE: "/dev/null",
    VAULT_ALLOW_SAVED_SIGNUPS: "false",
    VAULT_CADDY_IP: `10.239.${String(octet)}.2`,
    VAULT_TEST_DOMAIN: "https://vault.localhost",
    VAULT_SIGNUPS_ALLOWED: "false",
    VAULT_INVITATIONS_ALLOWED: "true",
    VAULT_SMTP_HOST: "",
    VAULT_TEST_API_SUBNET: `10.240.${String(octet)}.0/24`,
    VAULT_TEST_API_IP: `10.240.${String(octet)}.2`,
    API_PROXY_CADDY_IP: `10.240.${String(octet)}.2`,
    API_PROXY_API_IP: `10.240.${String(octet)}.3`,
    MAIL_MANAGEMENT_SUBNET: `10.238.${String(octet)}.0/24`,
    MAIL_MANAGEMENT_API_IP: `10.238.${String(octet)}.10`,
    MAIL_MANAGEMENT_STALWART_IP: `10.238.${String(octet)}.20`,
    MAIL_MANAGEMENT_SETUP_IP: `10.238.${String(octet)}.21`,
    MAIL_MANAGEMENT_OPS_IP: `10.238.${String(octet)}.22`,
    MAIL_MANAGEMENT_BACKUP_IP: `10.238.${String(octet)}.23`,
    MAIL_MANAGEMENT_BOOTSTRAP_IP: `10.238.${String(octet)}.24`,
    VAULT_TEST_SUBNET: `10.239.${String(octet)}.0/24`,
    VAULT_TEST_DYNAMIC_RANGE: `10.239.${String(octet)}.128/25`,
    VAULT_TEST_PROXY_IP: `10.239.${String(octet)}.2`,
  };
  // Select unused /24s from Docker's current IPAM allocations for the API,
  // Vault proxy and management networks used by disposable fixtures.
  const chooseSubnets = async () => {
    const ids = (await run("docker", ["network", "ls", "-q"])).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const allocated = z
      .array(
        z.object({
          IPAM: z.object({
            Config: z
              .array(z.object({ Subnet: z.string().optional() }))
              .nullable(),
          }),
        }),
      )
      .parse(
        JSON.parse(
          (await run("docker", ["network", "inspect", ...ids])).stdout,
        ),
      );
    const ranges = allocated.flatMap((network) =>
      (network.IPAM.Config ?? []).flatMap(({ Subnet }) => {
        if (!Subnet || Subnet.includes(":")) return [];
        const [ip, bits] = Subnet.split("/");
        if (!ip || !bits) return [];
        const size = 2 ** (32 - Number(bits));
        const start = Math.floor(ipNumber(ip) / size) * size;
        return [{ start, end: start + size - 1 }];
      }),
    );
    for (let offset = 0; offset < 200; offset += 1) {
      const candidate = ((octet + offset - 20) % 200) + 20;
      const bases = [238, 239, 240].map((second) =>
        ipNumber(`10.${String(second)}.${String(candidate)}.0`),
      );
      if (
        bases.every((base) =>
          ranges.every(({ start, end }) => base > end || base + 255 < start),
        )
      ) {
        env.VAULT_TEST_SUBNET = `10.239.${String(candidate)}.0/24`;
        env.VAULT_TEST_DYNAMIC_RANGE = `10.239.${String(candidate)}.128/25`;
        env.VAULT_TEST_PROXY_IP = `10.239.${String(candidate)}.2`;
        env.VAULT_CADDY_IP = env.VAULT_TEST_PROXY_IP;
        env.VAULT_TEST_API_SUBNET = `10.240.${String(candidate)}.0/24`;
        env.VAULT_TEST_API_IP = `10.240.${String(candidate)}.2`;
        env.API_PROXY_CADDY_IP = env.VAULT_TEST_API_IP;
        env.API_PROXY_API_IP = `10.240.${String(candidate)}.3`;
        const management = `10.238.${String(candidate)}`;
        env.MAIL_MANAGEMENT_SUBNET = `${management}.0/24`;
        env.MAIL_MANAGEMENT_API_IP = `${management}.10`;
        env.MAIL_MANAGEMENT_STALWART_IP = `${management}.20`;
        env.MAIL_MANAGEMENT_SETUP_IP = `${management}.21`;
        env.MAIL_MANAGEMENT_OPS_IP = `${management}.22`;
        env.MAIL_MANAGEMENT_BACKUP_IP = `${management}.23`;
        env.MAIL_MANAGEMENT_BOOTSTRAP_IP = `${management}.24`;
        return;
      }
    }
    throw new Error("No free disposable proxy subnets");
  };
  const args = [
    "compose",
    "--project-name",
    project,
    "--profile",
    "vault",
    "--env-file",
    "deploy/env.example",
    "-f",
    "compose.yaml",
    "-f",
    "compose.test.yaml",
    "-f",
    "test-support/vault-compose.yaml",
  ];
  const compose = async (...command: string[]) =>
    (
      await run("docker", [...args, ...command], {
        env,
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  return { project, env, args, compose, chooseSubnets };
}
