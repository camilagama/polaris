import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "../../../scripts/workerd-harness.mjs";

/**
 * The `node` project of the root config (same `exclude` and alias, checked by `test-clock/setup.test.ts`) with
 * `include` restricted to apps/web, plus the optional frozen system clock of `test-clock/setup.ts`. Used by
 * `bun run test:web:datas`; the root run (and CI) does not load it.
 */
export default defineConfig({
  resolve: {
    alias: [
      ...pgWorkerdAliases,
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("../src/", import.meta.url)),
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
    ],
    include: ["apps/web/**/*.test.{ts,tsx}"],
    name: "web-clock",
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { POLARIS_CLOCK_SETUP: "1" },
    setupFiles: ["apps/web/test-clock/setup.ts"],
  },
});
