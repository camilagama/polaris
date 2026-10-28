import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  isSharedChartModule,
  MOTION_MODULE,
  precacheBudgetPlugin,
} from "./pwa/precache-budget";
import { serviceWorkerPlugin } from "./pwa/service-worker-plugin";
import { uiBuild, uiPlugins } from "./vite.ui";

/**
 * The production shell without the Worker, only for the browser checks of the
 * service worker (`playwright.pwa.config.ts`): the same client build, the same
 * `sw.js` plugin, served by `scripts/serve-static.mjs` instead of the Cloudflare runtime.
 *
 * `PWA_E2E_VARIANT` stamps a marker into `index.html`, so a test can build "a new
 * version" of the app without touching the source and see which one is running, and
 * into every chunk (a legal comment, which the minifier keeps): each version has its
 * own file names, as a real deploy does, so a tab left on the old one asks for chunks
 * the new build no longer has.
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
    // the same chunk for `motion` as the production build (vite.config.ts)
    rolldownOptions: {
      output: {
        ...(process.env.PWA_E2E_VARIANT
          ? {
              postBanner: `/*! build-variant ${process.env.PWA_E2E_VARIANT} */`,
            }
          : {}),
        codeSplitting: {
          groups: [
            {
              includeDependenciesRecursively: false,
              name: "motion",
              priority: 30,
              test: MOTION_MODULE,
            },
            // the charts and the map of the Início share the sparkline, d3 and visx: they stay in the charts
            // chunk, so the map's chunk has only the map (the guards of `pwa/precache-budget.ts`)
            {
              includeDependenciesRecursively: false,
              name: "charts",
              priority: 25,
              test: isSharedChartModule,
            },
          ],
        },
      },
    },
  },
  // The sale screen is measured in the lab of the screens, over the real offline runtime (the runtime is off in
  // the shell of this build: it needs a session, which the static server does not have).
  define: {
    "import.meta.env.VITE_OFFLINE_RUNTIME_ENABLED": JSON.stringify("true"),
  },
  plugins: [
    uiPlugins(),
    react(),
    variantMarker,
    serviceWorkerPlugin({
      source: fileURLToPath(new URL("./src/pwa/sw.ts", import.meta.url)),
    }),
    // Only the charts and calendar lines and their placement guards: the other lines are those of the production build.
    precacheBudgetPlugin({ only: "chunks" }),
  ],
});
