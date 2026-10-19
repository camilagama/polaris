import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { legalBuildGuardPlugin } from "./legal/legal-build-guard-plugin";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";

export default defineConfig({
  plugins: [
    legalBuildGuardPlugin(),
    react(),
    cloudflare(),
    serviceWorkerPlugin({
      source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
    }),
  ],
});
