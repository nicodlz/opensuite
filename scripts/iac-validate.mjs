#!/usr/bin/env node
// Validate the AWS configuration without credentials or a backend.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const image =
  "ghcr.io/opentofu/opentofu:1.9.1@sha256:ea67f099effc220a2a2610dd4dd173154408b473bbebe109129f3800eedb19c6";
const modulePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../deploy/aws",
);
const scratch = mkdtempSync(resolve(tmpdir(), "opensuite-iac-"));

/**
 * @param {string} name
 * @param {boolean} network
 * @param {string[]} command
 * @returns {boolean}
 */
const check = (name, network, command) => {
  process.stdout.write(`\n== ${name} ==\n`);
  const args = [
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--network",
    network ? "bridge" : "none",
    "--user",
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    "--env",
    "HOME=/scratch",
    "--env",
    "TF_DATA_DIR=/scratch/tofu-data",
    "--env",
    "TF_CLI_CONFIG_FILE=/dev/null",
    "--env",
    "AWS_EC2_METADATA_DISABLED=true",
    "--mount",
    `type=bind,src=${modulePath},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${scratch},dst=/scratch`,
    "--workdir",
    "/workspace",
    image,
    ...command,
  ];
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`${name}: ${result.error.message}\n`);
  }
  const ok = result.status === 0;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`);
  return ok;
};

let passed = 0;
try {
  if (check("tofu fmt", false, ["fmt", "-check", "-recursive", "-no-color"])) {
    passed += 1;
  }
  if (
    check("tofu init (provider download only)", true, [
      "init",
      "-backend=false",
      "-lockfile=readonly",
      "-input=false",
      "-no-color",
    ])
  ) {
    passed += 1;
    if (check("tofu validate", false, ["validate", "-no-color"])) passed += 1;
  } else {
    process.stdout.write("SKIP tofu validate: initialization failed\n");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(`\nIaC validation: ${String(passed)}/3 checks passed.\n`);
process.exitCode = passed === 3 ? 0 : 1;
