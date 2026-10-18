import { defineConfig, devices } from "@playwright/test";

const inCI = Boolean(process.env.CI);

// Two Workers built from the catalog: the real one (src/server.ts as main) and one whose main skips it,
// to prove the router refuses to render a page without a nonce. Both run in workerd, like a deploy.
const PORT = 5174;
const BARE_PORT = 5175;

export default defineConfig({
  forbidOnly: inCI,
  fullyParallel: true,
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "chromium-mobile-emulated",
      use: { ...devices["Pixel 5"], browserName: "chromium" },
    },
  ],
  reporter: "list",
  // no retry on purpose: a retry would hide flakiness in the hydration test (CSP violations are timing-free)
  retries: 0,
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  // Servers start in order. The bare-entry build puts .wrangler/deploy/config.json back as it found it as
  // soon as its preview is up (see vite.config.ts) and the real build runs last, so a deploy after the
  // run follows the real Worker, even when a server is reused. e2e/csp.e2e.ts fails if the file points
  // at dist-bare. The Cloudflare Worker runtime needs Node 24 (.node-version): under Bun requests hang.
  webServer: [
    {
      command: `bunx vite build --mode bare-entry --outDir dist-bare && bunx vite preview --mode bare-entry --outDir dist-bare --host 127.0.0.1 --port ${BARE_PORT} --strictPort`,
      env: { POLARIS_CATALOG_E2E: "1" },
      reuseExistingServer: !inCI,
      timeout: 180_000,
      // /__debug is served by the Cloudflare plugin itself, outside the router that refuses the page
      url: `http://127.0.0.1:${BARE_PORT}/__debug`,
    },
    {
      command: `bun run build && bun run preview --port ${PORT} --strictPort`,
      reuseExistingServer: !inCI,
      timeout: 180_000,
      url: `http://127.0.0.1:${PORT}/robots.txt`,
    },
  ],
});
