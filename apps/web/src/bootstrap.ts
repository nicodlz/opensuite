import {
  installProduct,
  loadOrigins,
  resolveLayout,
  setActiveLayout,
} from "./origins.ts";

// Select the installation metadata using the same validated origin map as the
// router. The HTML defaults to Mail if the API is unavailable or JavaScript is
// disabled. Do this before loading the React application.
const layout = resolveLayout(await loadOrigins(), window.location.origin);
setActiveLayout(layout);
const product = installProduct(layout);
const links: Record<string, string> = {
  'link[rel="icon"][type="image/svg+xml"]': `/icons/${product}-favicon.svg`,
  'link[rel="icon"][type="image/png"]': `/icons/${product}-32.png`,
  'link[rel="apple-touch-icon"]': `/icons/${product}-180.png`,
  'link[rel="manifest"]': `/manifest-${product}.webmanifest`,
};
for (const [selector, href] of Object.entries(links)) {
  const link = document.querySelector<HTMLLinkElement>(selector);
  if (link) link.href = href;
}
try {
  await import("./main.tsx");
} catch (error) {
  // In development, a failed dynamic import does not emit Vite's preload
  // event. Reuse the bounded recovery in boot.js for startup failures too.
  const event = new Event("vite:preloadError", { cancelable: true });
  if (window.dispatchEvent(event)) throw error;
}
