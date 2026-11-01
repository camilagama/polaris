import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pgWorkerdAliases } from "../../scripts/workerd-harness.mjs";

/**
 * Same discovery as the `node` project of the root config, restricted to apps/web, plus the optional frozen system
 * clock of `vitest.clock.setup.ts`. Used by `bun run test:web:datas`; the root run (and CI) does not load it.
 */
export default defineConfig({
  resolve: {
    alias: [
      ...pgWorkerdAliases,
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("./src/", import.meta.url)),
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
    ],
    include: ["apps/web/**/*.test.{ts,tsx}"],
    name: "web-clock",
    root: fileURLToPath(new URL("../..", import.meta.url)),
    setupFiles: ["apps/web/vitest.clock.setup.ts"],
  },
});
