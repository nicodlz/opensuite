import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const ipNumber = (ip: string) =>
  ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
export function createPassFixture(label: string) {
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
    PASS_PUBLIC_HOST: "pass.localhost",
    PASS_ADMIN_TOKEN_FILE: "/dev/null",
    PASS_ALLOW_SAVED_SIGNUPS: "false",
    PASS_CADDY_IP: `10.239.${String(octet)}.2`,
    PASS_TEST_DOMAIN: "https://pass.localhost",
    PASS_SIGNUPS_ALLOWED: "false",
    PASS_INVITATIONS_ALLOWED: "true",
    PASS_SMTP_HOST: "",
    PASS_TEST_API_SUBNET: `10.240.${String(octet)}.0/24`,
    PASS_TEST_API_IP: `10.240.${String(octet)}.2`,
    PASS_TEST_SUBNET: `10.239.${String(octet)}.0/24`,
    PASS_TEST_DYNAMIC_RANGE: `10.239.${String(octet)}.128/25`,
    PASS_TEST_PROXY_IP: `10.239.${String(octet)}.2`,
  };
  // Select unused /24s from Docker's current IPAM allocations. Each run uses
  // separate networks for the API proxy and the Pass proxy.
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
      const bases = [239, 240].map((second) =>
        ipNumber(`10.${String(second)}.${String(candidate)}.0`),
      );
      if (
        bases.every((base) =>
          ranges.every(({ start, end }) => base > end || base + 255 < start),
        )
      ) {
        env.PASS_TEST_SUBNET = `10.239.${String(candidate)}.0/24`;
        env.PASS_TEST_DYNAMIC_RANGE = `10.239.${String(candidate)}.128/25`;
        env.PASS_TEST_PROXY_IP = `10.239.${String(candidate)}.2`;
        env.PASS_CADDY_IP = env.PASS_TEST_PROXY_IP;
        env.PASS_TEST_API_SUBNET = `10.240.${String(candidate)}.0/24`;
        env.PASS_TEST_API_IP = `10.240.${String(candidate)}.2`;
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
    "pass",
    "--env-file",
    "deploy/env.example",
    "-f",
    "compose.yaml",
    "-f",
    "compose.test.yaml",
    "-f",
    "test-support/pass-compose.yaml",
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
