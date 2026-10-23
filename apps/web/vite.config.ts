import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { legalBuildGuardPlugin } from "./legal/legal-build-guard-plugin";
import { precacheBudgetPlugin } from "./pwa/precache-budget";
import { appShellHeadersPlugin, sentryBuildSettings } from "./pwa/sentry-build";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";
import { uiBuild, uiPlugins } from "./vite.ui";

/**
 * The modules the first chunk shares with many screens: the commands of the offline outbox, the runtime context, the
 * current organization and the legal routes. Each is imported by the first chunk and by several screens, and the
 * default split of Rolldown pulled them out of the first chunk one by one (see the group below).
 */
const APP_CORE =
  /[\\/]apps[\\/]web[\\/]src[\\/](?:offline[\\/](?:customer-create|customer-update|product-create|sale-confirm|stock-commands)|offline[\\/]runtime[\\/]runtime-context|lib[\\/]current-organization|legal[\\/]legal-routes)\.ts$/;

export default defineConfig(({ mode }) => {
  const sentry = sentryBuildSettings(
    loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_")
  );
  return {
    ...uiBuild,
    build: {
      ...uiBuild.build,
      rolldownOptions: {
        output: {
          // Left to the default split, a new import of the interface in the first chunk (a button in the shell's
          // notices) pulled those modules out into chunks of their own, each compressing worse alone: about 7 KB
          // gzip in the precache for no new code (t233). One group keeps them in a single chunk, with what they import.
          codeSplitting: {
            groups: [
              {
                name: "app-core",
                priority: 20,
                test: APP_CORE,
              },
            ],
          },
        },
      },
    },
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
