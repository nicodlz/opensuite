import { defineConfig } from "vite";

// Served under a strict CSP: emit every asset as a file, never a data: URI.
export default defineConfig({
  build: { assetsInlineLimit: 0 },
});
