import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Do not allow exported DRIVE_* values to hide a broken example file.
const cleanEnv = { PATH: process.env["PATH"], HOME: process.env["HOME"] };
const composeArgs = [
  "compose",
  "--env-file",
  "deploy/env.example",
  "-f",
  "compose.yaml",
  "config",
];
const renderedDrive = () => {
  const result = spawnSync("docker", [...composeArgs, "--format", "json"], {
    cwd: root,
    env: cleanEnv,
    encoding: "utf8",
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({
    status: 0,
  });
  return z
    .object({
      services: z.object({
        drive: z.object({
          environment: z.record(z.string(), z.string()),
          volumes: z.array(
            z.object({ source: z.string(), target: z.string() }),
          ),
        }),
      }),
    })
    .parse(JSON.parse(result.stdout)).services.drive;
};

const configured = {
  DRIVE_S3_ENDPOINT: "https://s3.example.test",
  DRIVE_S3_PUBLIC_ENDPOINT: "https://s3.example.test",
  DRIVE_S3_BUCKET: "private-drive",
  DRIVE_S3_REGION: "region-1",
  DRIVE_S3_ACCESS_KEY: "key-id",
};

describe("Drive Compose example", () => {
  it("renders in a clean environment and refuses to start with the example", () => {
    const quiet = spawnSync("docker", [...composeArgs, "--quiet"], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
    });
    expect({ status: quiet.status, stderr: quiet.stderr }).toMatchObject({
      status: 0,
    });
    const drive = renderedDrive();
    const secret = drive.volumes.find(
      (volume) => volume.target === "/run/opensuite/drive-s3-secret",
    );
    expect(secret?.source).toBe("/dev/null");
    const start = spawnSync(process.execPath, ["apps/drive/src/main.ts"], {
      cwd: root,
      env: {
        ...cleanEnv,
        ...drive.environment,
        DRIVE_DATABASE_URL: "postgresql://user:password@localhost/drive",
        DRIVE_S3_SECRET_KEY_FILE: secret?.source,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(start.status).toBe(1);
    expect(start.stderr).toContain("invalid Drive configuration");
    for (const name of [...Object.keys(configured), "DRIVE_S3_SECRET_KEY"])
      expect(start.stderr).toContain(name);
    expect(start.stderr).toContain("Set DRIVE_S3_SECRET_FILE");
  });

  it("rejects each unchanged placeholder even when the other settings are valid", () => {
    const example = renderedDrive().environment;
    const valid = {
      ...example,
      ...configured,
      DRIVE_DATABASE_URL: "postgresql://user:password@localhost/drive",
      DRIVE_S3_SECRET_KEY: "secret",
    };
    expect(loadConfig(valid).isOk()).toBe(true);
    for (const name of Object.keys(configured)) {
      const result = loadConfig({ ...valid, [name]: example[name] });
      expect(
        result.match(
          () => [],
          (error) => error.issues.map((issue) => issue.path[0]),
        ),
      ).toContain(name);
    }
    expect(loadConfig({ ...valid, DRIVE_S3_SECRET_KEY: "" }).isErr()).toBe(
      true,
    );
  });

  it("keeps Compose's required-variable checks for explicit empty overrides", () => {
    for (const name of [...Object.keys(configured), "DRIVE_S3_SECRET_FILE"]) {
      const result = spawnSync("docker", [...composeArgs, "--quiet"], {
        cwd: root,
        env: { ...cleanEnv, [name]: "" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(name);
    }
  });
});
