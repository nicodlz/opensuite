import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { z } from "zod";
import { PrismaClient } from "./generated/index.js";

const Env = z.object({
  POSTGRES_USER: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PASSWORD_FILE: z.string().min(1),
});
const MigrationRows = z.array(
  z.object({
    migration_name: z.string(),
    checksum: z.string(),
    finished_at: z.date().nullable(),
    rolled_back_at: z.date().nullable(),
  }),
);
const Exists = z.array(z.object({ exists: z.boolean() })).length(1);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrations = join(packageRoot, "prisma", "migrations");

const run = async () => {
  const env = Env.parse(process.env);
  const password = (await readFile(env.POSTGRES_PASSWORD_FILE, "utf8")).trim();
  if (password.length === 0) throw new Error("empty database password");
  const url = new URL("postgresql://localhost:5432/");
  url.username = env.POSTGRES_USER;
  url.password = password;
  url.hostname = env.POSTGRES_HOST;
  url.pathname = `/${encodeURIComponent(env.POSTGRES_DB)}`;
  const client = new PrismaClient({
    datasources: { db: { url: url.toString() } },
  });
  try {
    const exists = Exists.parse(
      await client.$queryRaw`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS "exists"`,
    );
    if (exists[0]?.exists === true) {
      const rows = MigrationRows.parse(
        await client.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      );
      const names = new Set(await readdir(migrations));
      await Promise.all(
        rows.map(async (row) => {
          if (row.rolled_back_at !== null) return;
          if (
            row.finished_at === null ||
            !names.has(row.migration_name) ||
            !/^[a-zA-Z0-9_-]+$/.test(row.migration_name)
          )
            throw new Error("invalid migration history");
          const file = await readFile(
            join(migrations, row.migration_name, "migration.sql"),
          );
          if (createHash("sha256").update(file).digest("hex") !== row.checksum)
            throw new Error("applied migration checksum mismatch");
        }),
      );
    }
  } finally {
    await client.$disconnect();
  }
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      join(packageRoot, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy"],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
  if (status !== 0) throw new Error("migration deployment failed");
};

try {
  await run();
} catch {
  // Never print driver errors or environment values: they can contain credentials.
  process.stderr.write(
    "Database migration failed; check configuration and migration history.\n",
  );
  process.exitCode = 1;
}
