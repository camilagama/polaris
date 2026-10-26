import { defineConfig, devices } from "@playwright/test";
import {
  PWA_ORIGIN,
  PWA_PORT,
  reuseExistingServer,
  workersFrom,
} from "./e2e/run-settings";

const inCI = Boolean(process.env.CI);
/** The checks that only make sense on a phone, run by the `chromium-celular` project alone. */
const PHONE_ONLY = ["**/motion-level.e2e.ts", "**/dialog-voltar.e2e.ts"];

export default defineConfig({
  forbidOnly: inCI,
  fullyParallel: false,
  projects: [
    {
      name: "chromium-desktop",
      testIgnore: PHONE_ONLY,
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "chromium-mobile-emulated",
      testIgnore: PHONE_ONLY,
      use: { ...devices["Pixel 5"], browserName: "chromium" },
    },
    // The levels of motion on a phone (t386): a touch screen of 360×740, the phone of the design. The file proves
    // `pointer: coarse` before anything else and fails loudly without it; its desktop and tablet controls open their own
    // contexts. The step back that closes the form dialog (t408) is a phone's too.
    {
      name: "chromium-celular",
      testMatch: PHONE_ONLY,
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium",
        viewport: { height: 740, width: 360 },
      },
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
