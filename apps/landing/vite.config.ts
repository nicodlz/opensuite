import { defineConfig, loadEnv } from "vite";

// HTML links must also work with JavaScript disabled. Only accept an origin,
// so a build-time value cannot inject markup or alter the checkout path.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const value = env["VITE_ESUNO_APP_ORIGIN"] || "https://mail.esuno.net";
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("VITE_ESUNO_APP_ORIGIN must be an HTTP(S) origin");
  }
  return {
    plugins: [
      {
        name: "esuno-app-origin",
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replaceAll("%VITE_ESUNO_APP_ORIGIN%", url.origin),
        },
      },
    ],
    // Served under a strict CSP: emit every asset as a file, never a data: URI.
    build: { assetsInlineLimit: 0 },
  };
});
