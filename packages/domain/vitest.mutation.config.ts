import { defineConfig } from "vitest/config";

// The mutation run only needs the tests of the four mutated folders; the other
// folders' tests would only lengthen the dry run.
export default defineConfig({
  test: {
    include: [
      "src/money/**/*.test.ts",
      "src/sales/**/*.test.ts",
      "src/inventory/**/*.test.ts",
      "src/economics/**/*.test.ts",
    ],
  },
});
