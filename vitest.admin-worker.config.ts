import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The Admin Worker against PostgreSQL (T-127a). It is not a project of vitest.config.ts: it needs the database
// of the `database` job and the fixtures the `admin-worker` gate makes, so `bun run test` never runs it. The gate
// (packages/db/scripts/verify-admin-worker-gate.ts) starts it with `--config vitest.admin-worker.config.ts`.
// Same `pg` alias as the root config, which has to live in a root config (see scripts/workerd-harness.mjs).

export default defineConfig({
  resolve: { alias: pgWorkerdAliases },
  test: {
    // Random file and test order exposes tests that lean on state another test
    // left behind. The seed is printed on every run (and by the gate on a failure);
    // to replay it, add `seed: <seed>` to this `sequence` in your own copy, because
    // the gate hands no arguments to Vitest. The project below has no `extends`, so
    // it does not inherit the shuffle of the tests: it sets that itself, while the
    // order of the files and the seed come from here.
    sequence: { shuffle: { files: true, tests: true } },
    projects: ["apps/admin/vitest.workers-db.config.ts"],
  },
});
