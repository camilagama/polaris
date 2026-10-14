import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    serviceWorkerPlugin({
      source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
    }),
  ],
});
