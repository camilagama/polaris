import { defineConfig } from "@playwright/test";

// Temporary (t216, not committed).
const port = Number(process.env.CAP_PORT ?? 4185);
const size = (width: number, height: number) => ({ deviceScaleFactor: 1, viewport: { height, width } });
export default defineConfig({
  fullyParallel: false,
  projects: [
    { name: "320-claro", use: { browserName: "chromium", colorScheme: "light", ...size(320, 740), isMobile: true, hasTouch: true } },
    { name: "360-claro", use: { browserName: "chromium", colorScheme: "light", ...size(360, 740), isMobile: true, hasTouch: true } },
    { name: "360-escuro", use: { browserName: "chromium", colorScheme: "dark", ...size(360, 740), isMobile: true, hasTouch: true } },
    { name: "1280-claro", use: { browserName: "chromium", colorScheme: "light", ...size(1280, 800) } },
    { name: "1280-escuro", use: { browserName: "chromium", colorScheme: "dark", ...size(1280, 800) } },
  ],
  reporter: "list",
  testDir: ".",
  testMatch: "**/*.cap.ts",
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `bun run build:offline-poc && bunx vite preview --config vite.offline.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "..",
    reuseExistingServer: false,
    timeout: 180_000,
    url: `http://127.0.0.1:${port}/offline-poc?release=1`,
  },
  workers: 1,
});
