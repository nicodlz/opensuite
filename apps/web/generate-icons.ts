// Rebuild the committed browser icons from the product marks with Playwright.
// Run `pnpm icons:generate` after changing a mark; Chromium must be installed.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const directory = new URL("./public/", import.meta.url);
const background = "#1c1427";
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage();
  await Promise.all(
    ["mail", "drive", "calendar"].map(async (product) => {
      const mark = await readFile(
        new URL(`${product}-mark.svg`, directory),
        "utf8",
      );
      // The maskable artwork fits inside the central 80% diameter safe zone,
      // including its corners. The background fills the entire square.
      const icon = (inset: number) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${background}"/><svg x="${inset}" y="${inset}" width="${100 - inset * 2}" height="${100 - inset * 2}" ${mark.replace(/^<svg\s+/, "")}</svg>\n`;
      const normal = icon(14);
      const maskable = icon(24);
      await Promise.all([
        writeFile(new URL(`icons/${product}-favicon.svg`, directory), normal),
        ...(
          [
            ["32", 32, normal],
            ["180", 180, normal],
            ["192", 192, normal],
            ["512", 512, normal],
            ["maskable-512", 512, maskable],
          ] as const
        ).map(async ([name, size, svg]) => {
          const encoded = await page.evaluate(
            async (input) => {
              const image = new Image();
              image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(input.svg)}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = input.size;
              canvas.height = input.size;
              const context = canvas.getContext("2d");
              if (context === null) throw new Error("Canvas is unavailable");
              context.drawImage(image, 0, 0, input.size, input.size);
              return canvas.toDataURL("image/png").split(",")[1] ?? "";
            },
            { svg, size },
          );
          await writeFile(
            new URL(`icons/${product}-${name}.png`, directory),
            Buffer.from(encoded, "base64"),
          );
        }),
      ]);
    }),
  );
} finally {
  await browser.close();
}
