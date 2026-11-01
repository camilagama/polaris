import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "./scripts/workerd-harness.mjs";

// The node suites of apps/admin, apps/catalog and packages/* (minus packages/db), with the optional fixed clock of
// scripts/vitest-relogio-fixo.setup.mjs. Local tool of `bun run test:datas`; not a project of vitest.config.ts and not run by CI.
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
      "packages/db/**",
      ".codex-worktrees/**",
    ],
    include: [
      "apps/admin/**/*.test.{ts,tsx}",
      "apps/catalog/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
    ],
    name: "datas",
    setupFiles: [
      fileURLToPath(
        new URL("./scripts/vitest-relogio-fixo.setup.mjs", import.meta.url)
      ),
    ],
  },
});
