import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
it("exports Vault Yubico settings only when configured and supports a secret file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-yubico-"));
  const secret = join(directory, "secret");
  const command =
    '. ./deploy/vaultwarden/yubico.sh; configure_yubico "$1" || exit 1; env';
  try {
    const empty = await run("sh", ["-c", command, "sh", secret], {
      env: { PATH: process.env["PATH"] ?? "" },
    });
    expect(empty.stdout).not.toMatch(/^YUBICO_/m);
    await writeFile(secret, "test-secret");
    const configured = await run("sh", ["-c", command, "sh", secret], {
      env: { PATH: process.env["PATH"] ?? "", VAULT_YUBICO_CLIENT_ID: "123" },
    });
    expect(configured.stdout).toContain("YUBICO_CLIENT_ID=123");
    expect(configured.stdout).toContain(`YUBICO_SECRET_KEY_FILE=${secret}`);
    expect(configured.stdout).not.toContain("YUBICO_SECRET_KEY=test-secret");
    await expect(
      run("sh", ["-c", command, "sh", secret], {
        env: {
          PATH: process.env["PATH"] ?? "",
          VAULT_YUBICO_SECRET_KEY: "other",
        },
      }),
    ).rejects.toThrow("Command failed");
  } finally {
    await rm(directory, { recursive: true });
  }
});
