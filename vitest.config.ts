import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

// `pg` is a dependency of @polaris/db, and `pg-protocol` and `pg-cloudflare` are dependencies of `pg`: walk the same path the Worker does.
const fromDb = createRequire(
  new URL("./packages/db/package.json", import.meta.url)
);
const fromPg = createRequire(fromDb.resolve("pg"));

// Explicit discovery: an empty or mistyped include must fail the run instead of
// silently passing (the Phase 0 `--passWithNoTests` escape hatch is gone). The
// `node` project keeps that guarantee; a workers project that matches no file
// would pass silently, so scripts/workerd-harness.test.mjs checks that every
// `*.workerd.test.ts` has a workers project listed here.
export default defineConfig({
  // Workers harness (T-121a): `pg` must load and connect inside workerd, where
  // `pg-protocol` resolves to an ESM file in a CommonJS package and `pg-cloudflare` to a stub. The alias has
  // to live here, in the root config: inside a project it is not applied when
  // the run starts from the repository root. Needed by every Worker that uses `pg`.
  resolve: {
    alias: [
      {
        find: /^pg-protocol$/,
        replacement: fromPg.resolve("pg-protocol/dist/index.js"),
      },
      // the harness does not apply the `workerd` export condition, so `pg-cloudflare` would resolve to its empty Node stub
      {
        find: /^pg-cloudflare$/,
        replacement: join(
          dirname(fromPg.resolve("pg-cloudflare/package.json")),
          "dist/index.js"
        ),
      },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.wrangler/**",
            "**/e2e/**",
            "**/*.workerd.test.ts",
            ".codex-worktrees/**",
          ],
          include: [
            "packages/**/*.test.{ts,tsx}",
            "apps/**/*.test.{ts,tsx}",
            "scripts/**/*.test.mjs",
          ],
          name: "node",
        },
      },
      // Workers that need no database. The ones that do (T-121b, T-127a) get
      // their own config and run in the `database` job.
      "apps/admin/vitest.workers.config.ts",
    ],
  },
});
