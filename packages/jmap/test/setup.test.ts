import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("applies proxy and logging settings before refusing a blob switch without putting credentials in curl arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-setup-test-"));
  try {
    const password = "ExampleSecret1234567890";
    const secret = join(dir, "password");
    const log = join(dir, "calls");
    writeFileSync(secret, password);
    writeFileSync(join(dir, "hostname"), "#!/bin/sh\necho 172.30.248.2\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/sh
printf '%s\\n' "$*" >>"$CALL_LOG"
case "$*" in
  *x:Tracer/get*) printf '%s' '{"methodResponses":[["x:Tracer/get",{"list":[]},"t"]]}' ;;
  *x:Tracer/set*) printf '%s' '{"methodResponses":[["x:Tracer/set",{},"t"],["x:Http/set",{},"h"],["x:Action/set",{},"r"]]}' ;;
  *healthz/live*) printf 400 ;;
  *x:BlobStore/get*) printf '%s' '{"methodResponses":[["x:BlobStore/get",{"list":[{"@type":"S3"}]},"b"]]}' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["deploy/stalwart/setup.sh"], {
      cwd: new URL("../../../", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        CALL_LOG: log,
        STALWART_MANAGEMENT_PASSWORD_FILE: secret,
        MAIL_TLS_ENABLED: "0",
        MAIL_BLOB_STORE: "local",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("stdout logging and proxy trust applied");
    expect(result.stderr).toContain("refusing to switch");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain(password);
    expect(calls.indexOf("x:Http/set")).toBeGreaterThan(-1);
    expect(calls.indexOf("x:Http/set")).toBeLessThan(
      calls.indexOf("x:BlobStore/get"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
