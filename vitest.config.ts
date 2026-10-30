import { defineConfig } from "vitest/config";

/**
 * Test projects are split by the infrastructure they need. File suffixes
 * select the project: `*.test.ts` runs in `unit`, `*.<project>.test.ts` in
 * the matching project.
 */
const suites = ["db", "http", "stalwart", "ingest", "drive", "vault"] as const;
const roots = ["apps/*/test", "packages/*/test"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: roots.map((root) => `${root}/**/*.test.ts`),
          exclude: suites.flatMap((suite) =>
            roots.map((root) => `${root}/**/*.${suite}.test.ts`),
          ),
        },
      },
      ...suites.map((suite) => ({
        test: {
          name: suite,
          ...(suite === "http"
            ? { testTimeout: 30_000, hookTimeout: 120_000 }
            : {}),
          ...(suite === "vault" ? { fileParallelism: false } : {}),
          include: [
            ...roots.map((root) => `${root}/**/*.${suite}.test.ts`),
            ...(suite === "stalwart" || suite === "vault"
              ? [`test-support/**/*.${suite}.test.ts`]
              : []),
          ],
        },
      })),
    ],
  },
});
