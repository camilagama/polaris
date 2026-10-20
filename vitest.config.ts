import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// Explicit discovery: an empty or mistyped include must fail the run instead of
// silently passing (the Phase 0 `--passWithNoTests` escape hatch is gone). The
// `node` project keeps that guarantee; a workers project that matches no file
// would pass silently, so scripts/workerd-harness.test.mjs checks that every
// `*.workerd.test.ts` has a workers project listed here.
export default defineConfig({
  // Workers harness (T-121a): `pg` must load and connect inside workerd (the alias is in scripts/workerd-harness.mjs).
  // Needed by every Worker that uses `pg`.
  resolve: { alias: pgWorkerdAliases },
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
            "**/*.workerd-db.test.ts",
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
      // their own root config and run in the `database` job (see vitest.admin-worker.config.ts).
      "apps/admin/vitest.workers.config.ts",
    ],
  },
});
