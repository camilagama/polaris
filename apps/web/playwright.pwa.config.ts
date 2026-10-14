import { defineConfig, devices } from "@playwright/test";

const inCI = Boolean(process.env.CI);

export default defineConfig({
  forbidOnly: inCI,
  fullyParallel: false,
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
  testDir: "./e2e-pwa",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bunx vite build --config vite.pwa.config.ts && bunx vite preview --config vite.pwa.config.ts --host 127.0.0.1 --port 4174 --strictPort",
    reuseExistingServer: !inCI,
    timeout: 120_000,
    url: "http://127.0.0.1:4174",
  },
});
