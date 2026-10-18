import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// "bare-entry" exists only for the browser tests: a Worker whose main skips src/server.ts, the
// misconfiguration the router must refuse (catalog_nonce_missing). It is never deployed.
const bareEntry = { main: "@tanstack/react-start/server-entry" };

export default defineConfig(({ mode }) => ({
  plugins: [
    cloudflare({
      ...(mode === "bare-entry" ? { config: bareEntry } : {}),
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    react(),
  ],
}));
