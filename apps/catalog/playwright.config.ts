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
  retries: inCI ? 1 : 0,
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  // Servers start in order, and every build points .wrangler/deploy/config.json at its own output: the
  // bare-entry build goes first so that the last build left behind is the real one, never the test-only Worker.
  webServer: [
    {
      command: `bunx vite build --mode bare-entry --outDir dist-bare && bunx vite preview --mode bare-entry --outDir dist-bare --host 127.0.0.1 --port ${BARE_PORT} --strictPort`,
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
