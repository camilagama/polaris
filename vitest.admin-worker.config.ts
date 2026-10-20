import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The Admin Worker against PostgreSQL (T-127a). It is not a project of vitest.config.ts: it needs the database
// of the `database` job and the fixtures the `admin-worker` gate makes, so `bun run test` never runs it. The gate
// (packages/db/scripts/verify-admin-worker-gate.ts) starts it with `--config vitest.admin-worker.config.ts`.
// Same `pg` alias as the root config, which has to live in a root config (see scripts/workerd-harness.mjs).
export default defineConfig({
  resolve: { alias: pgWorkerdAliases },
  test: {
    projects: ["apps/admin/vitest.workers-db.config.ts"],
  },
});
