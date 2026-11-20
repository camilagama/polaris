import { defineConfig, devices } from "@playwright/test";
import {
  OFFLINE_POC_ORIGIN,
  OFFLINE_POC_PORT,
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
      // files that skip this whole project stay out of its list so skipped tests do not count in `--shard` (reflow-rotas covers touch itself; kill-reopen launches its own desktop Chromium)
      testIgnore: ["**/reflow-rotas.e2e.ts", "**/offline-kill-reopen.e2e.ts"],
      use: { ...devices["Pixel 5"], browserName: "chromium" },
    },
    // Windows Playwright WebKit exposes OPFS but cannot open the sync access handle.
    // Keep it opt-in; only physical iPhone Safari validates the release target.
    ...(process.env.OFFLINE_POC_INCLUDE_WEBKIT === "1"
      ? [
          {
            name: "webkit-desktop",
            use: {
              ...devices["Desktop Safari"],
              browserName: "webkit" as const,
            },
          },
        ]
      : []),
  ],
  reporter: inCI ? [["list"], ["github"]] : "list",
  retries: inCI ? 1 : 0,
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  use: {
    baseURL: OFFLINE_POC_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run build:offline-poc && bunx vite preview --config vite.offline.config.ts --host 127.0.0.1 --port ${OFFLINE_POC_PORT} --strictPort`,
    reuseExistingServer,
    timeout: 120_000,
    url: `${OFFLINE_POC_ORIGIN}/offline-poc?release=1`,
  },
  // SQLite WASM is memory-intensive: in the CI one worker per core but one (2 to 3), not one per core. Each test has
  // its own browser context, so its OPFS and storage are its own. `E2E_WORKERS` sets the number of workers.
  workers: workersFrom(1, 3, 1),
});
