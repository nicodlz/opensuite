#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cases = execFileSync(
  "sh",
  [fileURLToPath(new URL("./pass-drill.sh", import.meta.url)), "--list"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--report" || !args[1]) {
  process.stderr.write(
    "Usage: node scripts/backup-restore-drill.mjs --report PATH\n",
  );
  process.exit(2);
}
const work = await mkdtemp(join(tmpdir(), "opensuite-drill-report-"));
const results = join(work, "cases");
const script = fileURLToPath(
  new URL("./backup-integration.sh", import.meta.url),
);
const start = Date.now();
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
process.on("SIGINT", () => child?.kill("SIGINT"));
process.on("SIGTERM", () => child?.kill("SIGTERM"));
/** @param {import('node:child_process').ChildProcess} processToWait @returns {Promise<number>} */
const wait = (processToWait) =>
  new Promise((resolve, reject) => {
    processToWait.once("error", reject);
    processToWait.once("close", (status) => resolve(status ?? 1));
  });
let code = 1;
let error = "";
try {
  await Promise.all(
    ["package.json", "package-lock.json"].map((file) =>
      copyFile(
        fileURLToPath(
          new URL(`../test-support/pass-drill-cli/${file}`, import.meta.url),
        ),
        join(work, file),
      ),
    ),
  );
  child = spawn(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", work],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if ((await wait(child)) !== 0)
    throw new Error("Pinned Bitwarden CLI installation failed");
  child = spawn(script, [], {
    env: {
      ...process.env,
      PASS_BACKUP_DRILL: "1",
      PASS_DRILL_CASES: results,
      PASS_DRILL_BW: join(work, "node_modules/.bin/bw"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  code = await wait(child);
} catch (cause) {
  error = String(cause);
}
const completed = new Set(
  (await readFile(results, "utf8").catch(() => "")).split("\n"),
);
const missing = cases.filter((name) => !completed.has(name));
const failed = code !== 0 || missing.length > 0;
/** @param {string} s */
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const entries = cases.map(
  (name) =>
    `  <testcase name="${escape(name)}">${completed.has(name) ? "" : '<failure message="Case did not complete; see drill output"/>'}</testcase>`,
);
if (code !== 0 && missing.length === 0)
  entries.push(
    '  <testcase name="cleanup and integration"><failure message="Integration or cleanup failed"/></testcase>',
  );
const failures = missing.length + (code !== 0 && missing.length === 0 ? 1 : 0);
try {
  await writeFile(
    args[1],
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="backup-restore" tests="${entries.length}" failures="${failures}" time="${(Date.now() - start) / 1000}">\n${entries.join("\n")}\n</testsuite>\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
if (error) process.stderr.write(`${error}\n`);
process.stdout.write(
  `Backup restore drill: ${cases.length - missing.length}/${cases.length} Pass cases completed; report: ${args[1]}\n`,
);
if (failed) process.exitCode = 1;
