import { defineConfig } from "vitest/config";

// Explicit discovery: an empty or mistyped include must fail the run instead of
// silently passing (the Phase 0 `--passWithNoTests` escape hatch is gone).
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/e2e/**",
      ".codex-worktrees/**",
    ],
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}"],
  },
});
