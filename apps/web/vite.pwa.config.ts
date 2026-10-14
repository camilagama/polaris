import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";

/**
 * The production shell without the Worker, only for the browser check of the
 * service worker (`playwright.pwa.config.ts`): the same client build, the same
 * `sw.js` plugin, served by `vite preview` instead of the Cloudflare runtime.
 */
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist/pwa-e2e",
  },
  plugins: [
    react(),
    serviceWorkerPlugin({
      source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
    }),
  ],
});
