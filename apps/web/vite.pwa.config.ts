import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";
import { uiBuild, uiPlugins } from "./vite.ui";

/**
 * The production shell without the Worker, only for the browser checks of the
 * service worker (`playwright.pwa.config.ts`): the same client build, the same
 * `sw.js` plugin, served by `scripts/serve-static.mjs` instead of the Cloudflare runtime.
 *
 * `PWA_E2E_VARIANT` stamps a marker into `index.html`, so a test can build "a new
 * version" of the app without touching the source and see which one is running.
 */
const variantMarker: Plugin = {
  name: "polaris:pwa-e2e-variant",
  transformIndexHtml(html) {
    const variant = process.env.PWA_E2E_VARIANT;
    return variant
      ? html.replace(
          "</head>",
          `<meta content="${variant}" name="build-variant"></head>`
        )
      : html;
  },
};

export default defineConfig({
  ...uiBuild,
  build: {
    ...uiBuild.build,
    emptyOutDir: true,
    outDir: "dist/pwa-e2e",
  },
  plugins: [
    uiPlugins(),
    react(),
    variantMarker,
    serviceWorkerPlugin({
      source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
    }),
  ],
});
