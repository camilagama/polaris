/**
 * The Vitest configs that must keep the random order on (`verify-vitest-shuffle.mjs`). `needs` says which
 * halves of `sequence.shuffle` the config sets: `["files", "tests"]` for a root config, `["tests"]` for a
 * project loaded from a file, which does not inherit the `sequence` of the config that lists it and sets its
 * own (the order of the files comes from the root config that loads it).
 *
 * The guard fails only for what is listed: a config that turns the shuffle on adds its own line here in the
 * same change, with the `needs` it really sets.
 */
export const VITEST_SHUFFLE_LIST = {
  "apps/admin/vitest.workers-db.config.ts": { needs: ["tests"] },
  "apps/catalog/vitest.workers-db.config.ts": { needs: ["tests"] },
  "apps/web/vitest.workers-db.config.ts": { needs: ["files", "tests"] },
  "vitest.admin-worker.config.ts": { needs: ["files", "tests"] },
  "vitest.catalog-worker.config.ts": { needs: ["files", "tests"] },
  "vitest.config.ts": { needs: ["files", "tests"] },
  "vitest.datas.config.ts": { needs: ["files", "tests"] },
  "vitest.web-worker.config.ts": { needs: ["files", "tests"] },
};
