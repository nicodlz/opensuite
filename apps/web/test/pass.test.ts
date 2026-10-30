import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterClasses,
  classNames,
  generatePassphrase,
  generatePassword,
  randomIndex,
} from "../src/pass/generator.ts";
import { words } from "../src/pass/words.ts";

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
  it("does not use browser storage APIs", () => {
    const source = readFileSync(
      new URL("../src/pass/generator.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    const page = readFileSync(
      new URL("../src/pass/pass-page.tsx", import.meta.url),
      "utf8",
    );
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });
});
