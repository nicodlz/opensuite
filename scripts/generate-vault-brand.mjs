/* The browser callback runs in Chromium, outside this Node script's type environment.
   PNG generation is sequential to avoid overloading a single canvas page. */
/* oxlint-disable eslint/no-await-in-loop, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
// Regenerate the pinned web-vault shell and Esuno assets: pnpm install, then
// node scripts/generate-vault-brand.mjs (Docker and Playwright Chromium required).
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const image =
  "vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055";
const root = "deploy/vaultwarden/brand";
const images = join(root, "esuno-vault/images");
await mkdir(join(images, "icons"), { recursive: true });
await mkdir(join(images, "register-layout"), { recursive: true });
const original = await readFile("apps/web/public/esuno-logo.svg", "utf8");
const paths = original.match(/<path fill="#f6f4f8"[^>]+\/>/g);
const circle = original.match(/<circle[^>]+\/>/)?.[0];
if (!paths || paths.length !== 2 || !circle)
  throw new Error("Esuno logo paths changed; update generator");
/** @param {string} color */
const symbol = (color) =>
  `${paths.join("").replaceAll("#f6f4f8", color)}${circle}`;
/** @param {string} color */
const icon = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -2 110 104">${symbol(color)}</svg>\n`;
// Same mark as the Esuno logo, arranged beside its wordmark for Vault's wide logo slots.
/** @param {string} color */
const logo = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 86"><g transform="translate(2 3) scale(.78)">${symbol(color)}</g><text x="100" y="65" fill="${color}" font-family="system-ui, sans-serif" font-size="62" font-weight="800" letter-spacing="-3">esuno</text></svg>\n`;
const dark = logo("#1d1727");
const white = logo("#f6f4f8");
// Replace the upstream welcome illustration, which contains a branded vault screenshot.
const welcome = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1220 452"><rect width="1220" height="452" rx="20" fill="#140d1b"/><circle cx="1050" cy="70" r="230" fill="#342649"/><circle cx="140" cy="440" r="210" fill="#5630a8"/><rect x="250" y="62" width="720" height="328" rx="24" fill="#f6f4f8"/><rect x="250" y="62" width="160" height="328" rx="24" fill="#1c1427"/><g transform="translate(275 90) scale(.48)">${symbol("#f6f4f8")}</g><rect x="455" y="110" width="270" height="22" rx="11" fill="#5630a8"/><rect x="455" y="160" width="450" height="48" rx="10" fill="#ebe6f5"/><rect x="455" y="225" width="450" height="48" rx="10" fill="#ebe6f5"/><rect x="455" y="290" width="450" height="48" rx="10" fill="#ebe6f5"/><circle cx="480" cy="184" r="8" fill="#4f9c28"/><circle cx="480" cy="249" r="8" fill="#4f9c28"/><circle cx="480" cy="314" r="8" fill="#4f9c28"/></svg>\n`;
const favicon = await readFile("apps/web/public/favicon.svg", "utf8");
for (const [name, data] of Object.entries({
  "logo.svg": dark,
  "logo-white.svg": white,
  "icon-white.svg": icon("#f6f4f8"),
  "safari-pinned-tab.svg": icon("#000000"),
  "register-layout/logo-horizontal-white.svg": white,
  "welcome-dialog-graphic.svg": welcome,
}))
  await writeFile(join(images, name), data);
await writeFile(join(images, "favicon.svg"), favicon);
await copyFile(
  join(images, "safari-pinned-tab.svg"),
  join(images, "icons/safari-pinned-tab.svg"),
);

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage();
  /** @param {string} svg @param {number} width @param {number} height */
  async function png(svg, width, height) {
    const encoded = Buffer.from(svg).toString("base64");
    const base64 = await page.evaluate(
      async (params) => {
        const img = new Image();
        img.src = `data:image/svg+xml;base64,${params.encoded}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = params.width;
        canvas.height = params.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(img, 0, 0, params.width, params.height);
        return canvas.toDataURL("image/png").split(",")[1] ?? "";
      },
      { encoded, width, height },
    );
    return Buffer.from(base64, "base64");
  }
  /** @type {Array<[string, string, number, number]>} */
  const outputs = [
    ["logo-dark@2x.png", dark, 640, 172],
    ["logo-white@2x.png", white, 640, 172],
    ["register-layout/logo-horizontal-white.png", white, 640, 172],
    ["welcome-dialog-graphic.png", welcome, 2440, 904],
    ["icon-dark.png", icon("#1d1727"), 32, 32],
    ["icon-white.png", icon("#f6f4f8"), 32, 32],
    ...[16, 32].map(
      (size) =>
        /** @type {[string, string, number, number]} */ ([
          `favicon-${size}x${size}.png`,
          favicon,
          size,
          size,
        ]),
    ),
    ["apple-touch-icon.png", favicon, 180, 180],
    ["mstile-150x150.png", favicon, 150, 150],
    ...[192, 512].map(
      (size) =>
        /** @type {[string, string, number, number]} */ ([
          `android-chrome-${size}x${size}.png`,
          favicon,
          size,
          size,
        ]),
    ),
  ];
  for (const [name, svg, width, height] of outputs) {
    const data = await png(svg, width, height);
    await writeFile(join(images, name), data);
    if (/^(favicon-|apple-touch|mstile-|android-chrome-)/.test(name))
      await writeFile(join(images, "icons", name), data);
  }
  // ICO supports embedded PNGs; provide a fallback for browsers requesting /favicon.ico.
  const small = await readFile(join(images, "favicon-32x32.png"));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 32;
  header[7] = 32;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(small.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(
    join(root, "esuno-vault/favicon.ico"),
    Buffer.concat([header, small]),
  );
} finally {
  await browser.close();
}

let index = execFileSync(
  "docker",
  ["run", "--rm", "--entrypoint", "cat", image, "/web-vault/index.html"],
  { encoding: "utf8", maxBuffer: 2_000_000 },
);
/** @param {string} before @param {string} after */
function replaceOnce(before, after) {
  if (index.split(before).length !== 2)
    throw new Error(`Pinned index changed: ${before}`);
  index = index.replace(before, after);
}
replaceOnce(
  "<title page-title>Vaultwarden Web</title>",
  "<title page-title>Esuno Vault</title>",
);
replaceOnce('content="#175DDC"', 'content="#5630a8"');
for (const name of [
  "apple-touch-icon.png",
  "favicon-32x32.png",
  "favicon-16x16.png",
  "safari-pinned-tab.svg",
]) {
  replaceOnce(
    `href="images/${name}"`,
    `href="/esuno-vault/images/${name}?v=1"`,
  );
}
const manifest = index.match(/href="([a-f0-9]+\.json)"/);
if (!manifest) throw new Error("Pinned index manifest not found");
replaceOnce(`href="${manifest[1]}"`, 'href="/esuno-vault/manifest.json?v=1"');
replaceOnce('alt="Vaultwarden"', 'alt="Esuno"');
await writeFile(join(root, "index.html"), index);
await writeFile(
  join(root, "esuno-vault/manifest.json"),
  JSON.stringify(
    {
      name: "Esuno Vault",
      short_name: "Esuno Vault",
      icons: [192, 512].map((size) => ({
        src: `/esuno-vault/images/icons/android-chrome-${size}x${size}.png?v=1`,
        sizes: `${size}x${size}`,
        type: "image/png",
      })),
      theme_color: "#5630a8",
      background_color: "#f6f4f8",
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Generated Vault branding from ${image}; original manifest ${manifest[1]}\n`,
);
