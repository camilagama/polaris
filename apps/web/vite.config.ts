import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { legalBuildGuardPlugin } from "./legal/legal-build-guard-plugin";
import { precacheBudgetPlugin } from "./pwa/precache-budget";
import { appShellHeadersPlugin, sentryBuildSettings } from "./pwa/sentry-build";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";
import { uiBuild, uiPlugins } from "./vite.ui";

export default defineConfig(({ mode }) => {
  const sentry = sentryBuildSettings(
    loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_")
  );
  return {
    ...uiBuild,
    define: sentry.define,
    // Source maps of the browser build are hidden: generated for the upload to Sentry (release checklist),
    // never referenced by the bundles and kept out of the static assets by `public/.assetsignore`.
    environments: { client: { build: { sourcemap: "hidden" } } },
    plugins: [
      legalBuildGuardPlugin(),
      uiPlugins(),
      react(),
      cloudflare(),
      appShellHeadersPlugin(sentry.connectSources),
      serviceWorkerPlugin({
        source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
      }),
      precacheBudgetPlugin(),
    ],
  };
});
