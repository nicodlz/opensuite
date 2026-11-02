import {
  PortableExportInputSchema,
  PortableExportOutputSchema,
} from "@opensuite/contracts";
import { expect, it } from "vitest";

it("bounds message selection and rejects malformed export responses", () => {
  expect(
    PortableExportInputSchema.safeParse({
      format: "eml",
      accountId: "default",
      ids: ["one", "two"],
    }).success,
  ).toBe(false);
  expect(
    PortableExportInputSchema.safeParse({
      format: "mbox",
      accountId: "default",
      ids: Array.from({ length: 101 }, (_, i) => String(i)),
    }).success,
  ).toBe(false);
  expect(
    PortableExportOutputSchema.safeParse({
      filename: "message.eml",
      contentType: "message/rfc822",
      content: "!",
      exported: 1,
      warnings: [],
      failures: [],
    }).success,
  ).toBe(false);
});
