import { describe, expect, it } from "vitest";
import {
  budgetProblems,
  FONT_BUDGET_BYTES,
  measurePrecache,
  REST_BASELINE_GZIP_BYTES,
  REST_GROWTH_BUDGET_GZIP_BYTES,
} from "./precache-budget";

const bytes = (length: number, fill = 0) => new Uint8Array(length).fill(fill);

describe("precache budget (ADR 0103, section 4)", () => {
  it("counts fonts by their bytes and the rest gzipped, leaving the Sentry chunk out", () => {
    const files: Record<string, Uint8Array> = {
      "assets/geist-latin.woff2": bytes(30_000, 7),
      "assets/index-abc.js": bytes(100_000),
      "assets/sentry-sdk-Bs_LkrKs.js": bytes(100_000, 1),
      "index.html": bytes(1000),
    };
    const size = measurePrecache(
      Object.keys(files),
      (path) => files[path] as Uint8Array
    );
    expect(size.fonts).toBe(30_000);
    // zeros compress to almost nothing: the rest is gzip, not raw
    expect(size.rest).toBeGreaterThan(0);
    expect(size.rest).toBeLessThan(2000);
  });

  it("passes at the limits and fails one byte past each of them", () => {
    const atLimit = {
      fonts: FONT_BUDGET_BYTES,
      rest: REST_BASELINE_GZIP_BYTES + REST_GROWTH_BUDGET_GZIP_BYTES,
    };
    expect(budgetProblems(atLimit)).toEqual([]);
    expect(budgetProblems({ ...atLimit, fonts: atLimit.fonts + 1 })).toEqual([
      expect.stringContaining("fonts"),
    ]);
    expect(budgetProblems({ ...atLimit, rest: atLimit.rest + 1 })).toEqual([
      expect.stringContaining("rest"),
    ]);
  });

  it("keeps the ceilings of the ADR: 55 KB of fonts, +40 KB gzip for the rest", () => {
    expect(FONT_BUDGET_BYTES).toBe(55_000);
    expect(REST_GROWTH_BUDGET_GZIP_BYTES).toBe(40_000);
  });
});
