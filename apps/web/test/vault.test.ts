import { globSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  characterClasses,
  classNames,
  generatePassphrase,
  generatePassword,
  randomIndex,
} from "../src/vault/generator.ts";
import { words } from "../src/vault/words.ts";

describe("local generator", () => {
  it("uses the selected classes and requested length", () => {
    const selected = classNames;
    for (let i = 0; i < 30; i++) {
      const password = generatePassword(32, selected);
      expect(password).toHaveLength(32);
      for (const name of selected)
        expect(
          Array.from(password).some((c) => characterClasses[name].includes(c)),
        ).toBe(true);
      expect(generatePassword(16, ["numbers"])).toMatch(/^\d{16}$/);
    }
    expect(() => generatePassword(8, [])).toThrow("Invalid password options");
  });
  it("rejects the incomplete tail and maps accepted samples evenly", () => {
    const samples = [0xffffffff, 0, 1, 2, 3, 4, 5];
    const source = (array: Uint32Array<ArrayBuffer>) => {
      array[0] = samples.shift() ?? 0;
      return array;
    };
    expect(Array.from({ length: 6 }, () => randomIndex(3, source))).toEqual([
      0, 1, 2, 0, 1, 2,
    ]);
    expect(samples).toHaveLength(0);
  });
  it("joins independently selected words with the requested separator", () => {
    const phrase = generatePassphrase(6, "-");
    const parts = phrase.split("-");
    expect(parts).toHaveLength(6);
    expect(parts.every((word) => words.includes(word))).toBe(true);
    expect(generatePassphrase(3, " ").split(" ")).toHaveLength(3);
  });
  it("does not use storage, console or analytics in Vault source", () => {
    const files = globSync("**/*", {
      cwd: fileURLToPath(new URL("../src/vault/", import.meta.url)),
    }).filter((file) =>
      statSync(new URL(`../src/vault/${file}`, import.meta.url)).isFile(),
    );
    expect(files).not.toHaveLength(0);
    for (const file of files) {
      const source = readFileSync(
        new URL(`../src/vault/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(
        /localStorage|sessionStorage|indexedDB|\bconsole\s*\.|\b(?:analytics|gtag|trackEvent)\s*[.(]/i,
      );
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
