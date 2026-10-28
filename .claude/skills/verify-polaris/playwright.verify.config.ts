import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The drives of verify-polaris against the instance of scripts/verify.sh launch: one drive file per run
 * (VERIFY_DRIVE), one project per screen width and theme, signed in as the store VERIFY_LOJA (default vazia).
 * Started by `verify.sh drive|snap`, which sets the environment.
 */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const stateDir = process.env.VERIFY_STATE_DIR ?? "";
const drive = process.env.VERIFY_DRIVE ?? "";
if (!(stateDir && drive)) {
  throw new Error("Run the drives through scripts/verify.sh drive|snap.");
}
const state = JSON.parse(readFileSync(`${stateDir}/state.json`, "utf8")) as {
  port: number;
  stores: Record<string, { clientIp: string; storageState: string }>;
};
const loja = process.env.VERIFY_LOJA ?? "vazia";
const store = state.stores[loja];
if (!store) {
  throw new Error(
    `The store "${loja}" is not seeded: verify.sh seed ${loja} first.`
  );
}

const SCREENS = {
  celular: {
    ...devices["Pixel 7"],
    viewport: { height: 740, width: 360 },
  },
  "celular-320": {
    ...devices["Pixel 7"],
    viewport: { height: 640, width: 320 },
  },
  desktop: {
    ...devices["Desktop Chrome"],
    viewport: { height: 800, width: 1280 },
  },
} as const;
const THEMES = { claro: "light", escuro: "dark" } as const;

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  // scratch of the runner (Playwright empties it on every run): the proof goes to the evidence directory
  outputDir: `${stateDir}/playwright`,
  projects: Object.entries(SCREENS).flatMap(([screen, device]) =>
    Object.entries(THEMES).map(([theme, colorScheme]) => ({
      name: `${screen}-${theme}`,
      use: { ...device, browserName: "chromium" as const, colorScheme },
    }))
  ),
  reporter: [["list"]],
  retries: 0,
  testDir: dirname(drive),
  // the exact file: drives/local/ may hold a drive with the same name
  testMatch: new RegExp(`^${drive.replace(REGEX_SPECIAL, "\\$&")}$`),
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${state.port}`,
    // one rate limit bucket per store, as each person has in production (e2e-real/journey-names.ts)
    extraHTTPHeaders: { "cf-connecting-ip": store.clientIp },
    locale: "pt-BR",
    storageState: store.storageState,
    timezoneId: "America/Sao_Paulo",
    trace: "off",
  },
  workers: 1,
});
