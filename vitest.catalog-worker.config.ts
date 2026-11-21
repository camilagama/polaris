import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The Catalog Worker against PostgreSQL (T-121b). Like vitest.admin-worker.config.ts it is not a project of
// vitest.config.ts: it needs the logins and the fixtures the `catalog-worker` gate makes, so `bun run test` never
// runs it. The gate (packages/db/scripts/verify-catalog-worker-gate.ts) starts it with `--config vitest.catalog-worker.config.ts`.
// Same `pg` alias as the root config, which has to live in a root config (see scripts/workerd-harness.mjs).
export default defineConfig({
  resolve: { alias: pgWorkerdAliases },
  test: {
    // Random order exposes tests that lean on state another test left behind. The seed
    // is the first line of the failure summary of the gate. The order of
    // the tests is set in the project (apps/catalog/vitest.workers-db.config.ts), which
    // the `sequence` of a root config does not reach; there is one test file today.
    sequence: { shuffle: { files: true, tests: true } },
    projects: ["apps/catalog/vitest.workers-db.config.ts"],
  },
});
