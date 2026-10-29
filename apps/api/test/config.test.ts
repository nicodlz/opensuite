import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    expect(loadConfig({})).toEqual(
      ok({
        host: "127.0.0.1",
        port: 3000,
        logLevel: "info",
        readinessTimeoutMs: 2000,
      }),
    );
  });

  it("parses explicit values", () => {
    const config = loadConfig({
      API_HOST: "0.0.0.0",
      API_PORT: "8080",
      LOG_LEVEL: "debug",
      READINESS_TIMEOUT_MS: "500",
    });
    expect(config).toEqual(
      ok({
        host: "0.0.0.0",
        port: 8080,
        logLevel: "debug",
        readinessTimeoutMs: 500,
      }),
    );
  });

  it("rejects invalid values without echoing them", () => {
    const config = loadConfig({ API_PORT: "hunter2", LOG_LEVEL: "loud" });
    expect(config.isErr()).toBe(true);
    const issues = config.isErr() ? config.error.issues : [];
    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("API_PORT");
    expect(issues.join("\n")).not.toContain("hunter2");
  });
});
