import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The node suites of apps/web, apps/admin, apps/catalog and packages/* (minus packages/db) with the optional frozen clock of
// scripts/test-clock/setup.mjs. Local tool of `bun run test:datas`; not a project of vitest.config.ts and not run by CI.
// scripts/test-clock/setup.test.mjs checks that `exclude` (plus packages/db) and `resolve` match the node project of the root.
export default defineConfig({
  resolve: {
    alias: [
      ...pgWorkerdAliases,
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("./apps/web/src/", import.meta.url)),
      },
    ],
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/e2e/**",
      "**/*.workerd.test.ts",
      "**/*.workerd-db.test.ts",
      ".codex-worktrees/**",
      "packages/db/**",
    ],
    include: [
      "scripts/test-clock/*.test.mjs",
      "apps/web/**/*.test.{ts,tsx}",
      "apps/admin/**/*.test.{ts,tsx}",
      "apps/catalog/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
    ],
    name: "datas",
    setupFiles: [
      fileURLToPath(new URL("./scripts/test-clock/setup.mjs", import.meta.url)),
    ],
  },
});
