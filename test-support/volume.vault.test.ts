import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createVaultFixture } from "./vault-fixture.js";

const run = promisify(execFile);
type Scenario =
  "fresh" | "root-owned" | "already-owned" | "vault-created-first";

async function exerciseVolume(scenario: Scenario) {
  const { compose, chooseSubnets } = createVaultFixture(`volume-${scenario}`);
  // Run a shell in the secrets image to inspect/seed volumes without running
  // the secrets job. The Vaultwarden data mount is the production mount.
  const volumeShell = (script: string) =>
    compose(
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "sh",
      "secrets",
      "-ec",
      script,
    );
  const dataStat = async () =>
    (await volumeShell("stat -c '%u:%g %a' /vault-data")).trim();
  const createVault = () => compose("up", "--no-start", "--no-deps", "vault");
  try {
    await chooseSubnets();
    if (scenario === "vault-created-first") {
      // Docker requires a volume subpath to exist at container creation. This
      // only creates the empty mountpoint; the secrets job has not run yet.
      await volumeShell("mkdir -p /secrets/vault-database");
      await createVault();
    } else if (scenario !== "fresh") {
      const owner = scenario === "root-owned" ? "0:0" : "1000:1000";
      const mode = scenario === "root-owned" ? "0755" : "0700";
      await volumeShell(
        `mkdir -p /vault-data/attachments; printf preserved > /vault-data/attachments/probe; chown -R ${owner} /vault-data; chmod ${mode} /vault-data`,
      );
    }

    await compose("run", "--rm", "--no-deps", "-T", "secrets");
    expect(await dataStat()).toBe("1000:1000 700");
    if (scenario !== "vault-created-first") await createVault();
    // This assertion occurs immediately after container creation, before any
    // second secrets run could conceal Docker's copy-on-first-use behavior.
    expect(await dataStat()).toBe("1000:1000 700");
    const existing = scenario === "root-owned" || scenario === "already-owned";
    const preserved = existing
      ? (
          await volumeShell(
            "stat -c '%u:%g' /vault-data/attachments/probe; cat /vault-data/attachments/probe",
          )
        ).trim()
      : "";
    expect(preserved).toBe(existing ? "1000:1000\npreserved" : "");

    await compose(
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "180",
      "postgres",
    );
    await compose("run", "--rm", "--no-deps", "-T", "vault-provision");
    const container = (await compose("ps", "--all", "-q", "vault")).trim();
    // Start exactly the container created above, without restarting its jobs.
    await run("docker", ["start", container]);
    const awaitHealth = async (remaining: number): Promise<string> => {
      const health = (
        await run("docker", [
          "inspect",
          "--format",
          "{{.State.Status}} {{.State.Health.Status}}",
          container,
        ])
      ).stdout.trim();
      if (
        remaining === 0 ||
        health === "running healthy" ||
        health.startsWith("exited") ||
        health.endsWith("unhealthy")
      )
        return health;
      await delay(2000);
      return awaitHealth(remaining - 1);
    };
    const health = await awaitHealth(90);
    if (health !== "running healthy") {
      throw new Error(
        `Vault did not become healthy (${health}): ${await compose("logs", "--no-color", "vault")}`,
      );
    }
    expect(
      (
        await compose("exec", "-T", "vault", "stat", "-c", "%u:%g %a", "/data")
      ).trim(),
    ).toBe("1000:1000 700");
    expect(
      (
        await compose(
          "exec",
          "-T",
          "vault",
          "stat",
          "-c",
          "%u",
          "/data/rsa_key.pem",
        )
      ).trim(),
    ).toBe("1000");
    await compose("exec", "-T", "vault", "test", "-s", "/data/rsa_key.pem");
  } finally {
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
  }
}

test.each<Scenario>([
  "fresh",
  "root-owned",
  "already-owned",
  "vault-created-first",
])("Vault data permissions and startup: %s", exerciseVolume, 300_000);
