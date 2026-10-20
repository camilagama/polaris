import { defineConfig, devices } from "@playwright/test";
import {
  ensureRunEnvironment,
  ownerDatabaseUrl,
  previewEnvironment,
} from "./e2e-real/run-environment";

/**
 * The journeys on the real local stack (T-125a): the deployable bundle in `vite preview` (local workerd), the real
 * `/rpc`, Better Auth, RLS and a PostgreSQL 18 database made for this run. Runbook: docs/runbooks/e2e-real.md.
 *
 * This file is evaluated by the main Playwright process and again by each worker: the run values are made once
 * (`ensureRunEnvironment`) and inherited through `process.env`.
 */
const inCI = Boolean(process.env.CI);
const run = ensureRunEnvironment();
const owner = ownerDatabaseUrl();
const PORTS = { online: 4321, "runtime-ligado": 4322 } as const;
const origin = (project: keyof typeof PORTS) =>
  `http://127.0.0.1:${PORTS[project]}`;
// `E2E_RETRIES=0` for the 10 runs without retry that come before the job is required.
const defaultRetries = inCI ? 1 : 0;
const retries =
  process.env.E2E_RETRIES === undefined
    ? defaultRetries
    : Number(process.env.E2E_RETRIES);

const desktop = {
  ...devices["Desktop Chrome"],
  browserName: "chromium" as const,
};

export default defineConfig({
  forbidOnly: inCI,
  fullyParallel: false,
  globalSetup: "./e2e-real/global-setup.ts",
  globalTeardown: "./e2e-real/global-teardown.ts",
  outputDir: "test-results/e2e-real",
  projects: [
    // the stack itself, before any journey: the preview reads the run's environment, the seven roles, the guards
    {
      name: "pilha",
      testMatch: "pilha/*.e2e.ts",
      use: { ...desktop, baseURL: origin("online") },
    },
    // a harness test that must see a retry (T0 is the same after it); retried even when E2E_RETRIES=0
    {
      dependencies: ["pilha"],
      name: "relogio-retry",
      retries: 1,
      testMatch: "harness/relogio-retry.e2e.ts",
      use: { ...desktop, baseURL: origin("online") },
    },
    {
      dependencies: ["pilha"],
      name: "online",
      testMatch: [
        "jornadas/*.e2e.ts",
        "harness/relogio.e2e.ts",
        "harness/chave-do-runtime.e2e.ts",
      ],
      use: { ...desktop, baseURL: origin("online") },
    },
    {
      dependencies: ["pilha"],
      name: "runtime-ligado",
      testMatch: [
        "jornadas/cliente.e2e.ts",
        "jornadas/venda.e2e.ts",
        "harness/chave-do-runtime.e2e.ts",
      ],
      use: { ...desktop, baseURL: origin("runtime-ligado") },
    },
  ],
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/e2e-real-report.json" }],
  ],
  retries,
  testDir: "./e2e-real",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  use: { trace: "retain-on-failure" },
  // one after another: each preview reads its own build before the next build rewrites the deploy pointer (serve.ts)
  webServer: (Object.keys(PORTS) as (keyof typeof PORTS)[]).map((project) => ({
    command: `node e2e-real/serve.ts ${project} ${PORTS[project]}`,
    env: previewEnvironment(
      owner,
      run,
      origin(project),
      project === "runtime-ligado"
    ),
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
    reuseExistingServer: false,
    stdout: "ignore" as const,
    timeout: 180_000,
    url: `${origin(project)}/health`,
  })),
  workers: 1, // SQLite WASM is memory-intensive and there is one Worker and one PostgreSQL: serial.
});
