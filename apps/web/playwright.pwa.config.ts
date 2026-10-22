import { defineConfig, devices } from "@playwright/test";
import {
  PWA_ORIGIN,
  PWA_PORT,
  reuseExistingServer,
  workersFrom,
} from "./e2e/run-settings";

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
    baseURL: PWA_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bunx vite build --config vite.pwa.config.ts --mode pwa-e2e && node scripts/serve-static.mjs dist/pwa-e2e ${PWA_PORT}`,
    reuseExistingServer,
    timeout: 120_000,
    url: PWA_ORIGIN,
  },
  // the checks are independent: the update ones build and serve a directory of their own (support.ts); the others
  // only read `dist/pwa-e2e`. In the CI, one worker per core (up to 4); `E2E_WORKERS` sets the number.
  workers: workersFrom(2, 4),
});
