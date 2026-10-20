import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The Web Worker against PostgreSQL (T-121b). Like vitest.admin-worker.config.ts it is not a project of
// vitest.config.ts: it needs the logins and the fixtures the `web-worker` gate makes, so `bun run test` never
// runs it. The gate (packages/db/scripts/verify-web-worker-gate.ts) starts it with `--config vitest.web-worker.config.ts`.
// Same `pg` alias as the root config, which has to live in a root config (see scripts/workerd-harness.mjs).
export default defineConfig({
  resolve: { alias: pgWorkerdAliases },
  test: {
    projects: ["apps/web/vitest.workers-db.config.ts"],
  },
});
