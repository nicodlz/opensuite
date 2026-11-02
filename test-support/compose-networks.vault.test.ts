import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createComposeNetworks } from "./compose-networks.js";

const run = promisify(execFile);

test("concurrent fixtures reserve distinct subnets and release them", async () => {
  const suffix = randomBytes(5).toString("hex");
  const first = createComposeNetworks(`opensuite-net-a-${suffix}`, 42);
  const second = createComposeNetworks(`opensuite-net-b-${suffix}`, 42);
  try {
    await Promise.all([first.reserve(), second.reserve()]);
    for (const key of [
      "API_PROXY_SUBNET",
      "VAULT_NETWORK_SUBNET",
      "MAIL_MANAGEMENT_SUBNET",
    ] as const) {
      expect(first.env[key]).not.toBe(second.env[key]);
    }
    const names = (
      await run("docker", ["network", "ls", "--format", "{{.Name}}"])
    ).stdout;
    expect(names).toContain(`opensuite-net-a-${suffix}_api-proxy`);
    expect(names).toContain(`opensuite-net-b-${suffix}_api-proxy`);
    // Compose may already have removed some of the reserved networks.
    await run("docker", [
      "network",
      "rm",
      `opensuite-net-a-${suffix}_api-proxy`,
    ]);
  } finally {
    await Promise.all([first.release(), second.release()]);
  }
  const remaining = (
    await run("docker", ["network", "ls", "--format", "{{.Name}}"])
  ).stdout;
  expect(remaining).not.toContain(`opensuite-net-a-${suffix}`);
  expect(remaining).not.toContain(`opensuite-net-b-${suffix}`);
}, 120_000);

test("a failed reservation cleans up its partial networks", async () => {
  const project = `opensuite-net-fail-${randomBytes(5).toString("hex")}`;
  const occupied = `${project}_pass-network`;
  await run("docker", ["network", "create", occupied]);
  const fixture = createComposeNetworks(project, 42);
  try {
    await expect(fixture.reserve()).rejects.toThrow(/already exists/i);
    const names = (
      await run("docker", ["network", "ls", "--format", "{{.Name}}"])
    ).stdout;
    expect(names).not.toContain(`${project}_mail-management`);
    expect(names).toContain(occupied);
  } finally {
    await fixture.release();
    await run("docker", ["network", "rm", occupied]);
  }
}, 120_000);
