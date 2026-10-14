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
  reporter: "list",
  retries: inCI ? 1 : 0,
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bun run build:offline-poc && bunx vite preview --config vite.offline.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    reuseExistingServer: !inCI,
    timeout: 120_000,
    url: "http://127.0.0.1:4173/offline-poc?release=1",
  },
  workers: 1, // SQLite WASM is memory-intensive; keep browser runs serial.
});
