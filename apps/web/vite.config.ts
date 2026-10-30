import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
  "/drive/api": {
    target: process.env["DRIVE_PROXY_TARGET"] ?? "http://127.0.0.1:3001",
    rewrite: (path: string) => path.replace(/^\/drive\/api/, ""),
  },
  "/api": {
    target: process.env["API_PROXY_TARGET"] ?? "http://127.0.0.1:3000",
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
});
