import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { createComposeNetworks } from "./compose-networks.js";

const run = promisify(execFile);
export function createVaultFixture(label: string) {
  const suffix = (process.env["OPENSUITE_RUN_ID"] ?? "local")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30);
  const project = `opensuite-${label}-${suffix}-${randomBytes(5).toString("hex")}`;
  const networks = createComposeNetworks(project);
  const env = {
    ...process.env,
    ...networks.env,
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
    VAULT_TEST_DOMAIN: "https://vault.localhost",
    VAULT_SIGNUPS_ALLOWED: "false",
    VAULT_INVITATIONS_ALLOWED: "true",
    VAULT_SMTP_HOST: "",
  };
  const chooseSubnets = async () => {
    await networks.reserve();
    Object.assign(env, networks.env);
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
  return {
    project,
    env,
    args,
    compose,
    chooseSubnets,
    releaseSubnets: networks.release,
  };
}
