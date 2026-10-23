import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  budgetProblems,
  budgetWarnings,
  FONT_BUDGET_BYTES,
  interfaceShares,
  measurePrecache,
  PRIMITIVES_BUDGET_GZIP_BYTES,
  precacheBudgetPlugin,
  primitiveShares,
  REST_BASELINE_GZIP_BYTES,
  REST_GROWTH_BUDGET_GZIP_BYTES,
  REST_GROWTH_HARD_CAP_GZIP_BYTES,
  REST_GROWTH_MODE,
  restBaseline,
  testOnlyChunkProblems,
} from "./precache-budget";

const GROWTH_LINE =
  /PRECACHE-GROWTH total \d+ B gzip, growth [+-]?\d+ B over the baseline of \d+ B \(reference \+44000 B/;

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
    expect(size.primitives).toBe(0);
    expect(size.interface).toBe(0);
    // zeros compress to almost nothing: the rest is gzip, not raw
    expect(size.rest).toBeGreaterThan(0);
    expect(size.rest).toBeLessThan(2000);
  });

  it("takes the primitives' share of a chunk out of the rest", () => {
    const random = new Uint8Array(10_000).map(
      (_, index) => (index * 7919) % 251
    );
    const files: Record<string, Uint8Array> = {
      "assets/index-abc.js": random,
      "assets/sale-def.js": random,
    };
    const read = (path: string) => files[path] as Uint8Array;
    const whole = measurePrecache(Object.keys(files), read);
    const shares = primitiveShares([
      {
        fileName: "assets/sale-def.js",
        modules: {
          "/repo/apps/web/src/sales/sale-page.tsx": { renderedLength: 300 },
          "/repo/node_modules/.bun/@base-ui+react@1.9.0+x/node_modules/@base-ui/react/esm/dialog/index.js":
            { renderedLength: 500 },
          "/repo/node_modules/.bun/@floating-ui+dom@1.8.0/node_modules/@floating-ui/dom/dist/index.mjs":
            { renderedLength: 200 },
        },
      },
      {
        fileName: "assets/index-abc.js",
        modules: {
          "/repo/node_modules/react/index.js": { renderedLength: 900 },
          "/repo/node_modules/use-sync-external-store/shim/index.js": {
            renderedLength: 100,
          },
        },
      },
    ]);
    expect([...shares]).toEqual([["assets/sale-def.js", 0.7]]);
    const split = measurePrecache(Object.keys(files), read, {
      primitives: shares,
    });
    expect(split.primitives + split.rest).toBe(whole.rest);
    expect(split.primitives / (whole.rest / 2)).toBeCloseTo(0.7, 2);
  });

  it("passes at the limits and fails one byte past each of them", () => {
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    const atLimit = {
      fonts: FONT_BUDGET_BYTES,
      interface: 0,
      primitives: PRIMITIVES_BUDGET_GZIP_BYTES,
      rest: baseline + REST_GROWTH_BUDGET_GZIP_BYTES,
    };
    expect(budgetProblems(atLimit, baseline)).toEqual([]);
    expect(
      budgetProblems({ ...atLimit, fonts: atLimit.fonts + 1 }, baseline)
    ).toEqual([expect.stringContaining("fonts")]);
    expect(
      budgetProblems(
        { ...atLimit, primitives: atLimit.primitives + 1 },
        baseline
      )
    ).toEqual([expect.stringContaining("primitives")]);
  });

  it("passes with a warning above +44 000 B and below the hard cap, and fails past the hard cap (t272)", () => {
    expect(REST_GROWTH_MODE).toBe("warn");
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    const withGrowth = (growth: number) => ({
      fonts: 0,
      interface: 0,
      primitives: 0,
      rest: baseline + growth,
    });
    // at the reference: no problem, no warning
    expect(
      budgetProblems(withGrowth(REST_GROWTH_BUDGET_GZIP_BYTES), baseline)
    ).toEqual([]);
    expect(
      budgetWarnings(withGrowth(REST_GROWTH_BUDGET_GZIP_BYTES), baseline)
    ).toEqual([]);
    // one byte over the reference: passes, with a warning that says the total, the reference and the excess
    const over = withGrowth(REST_GROWTH_BUDGET_GZIP_BYTES + 1);
    expect(budgetProblems(over, baseline)).toEqual([]);
    const [warning] = budgetWarnings(over, baseline);
    expect(budgetWarnings(over, baseline)).toHaveLength(1);
    expect(warning).toContain(`total ${baseline + 44_001} B gzip`);
    expect(warning).toContain("reference +44000 B");
    expect(warning).toContain("excess +1 B");
    // in the middle of the way (+60 000 B): still passes, with the warning
    expect(budgetProblems(withGrowth(60_000), baseline)).toEqual([]);
    expect(budgetWarnings(withGrowth(60_000), baseline)).toHaveLength(1);
    // at the hard cap: passes; one byte past it: fails, and it is a problem, not a warning
    expect(
      budgetProblems(withGrowth(REST_GROWTH_HARD_CAP_GZIP_BYTES), baseline)
    ).toEqual([]);
    const past = withGrowth(REST_GROWTH_HARD_CAP_GZIP_BYTES + 1);
    expect(budgetProblems(past, baseline)).toEqual([
      expect.stringContaining("hard cap of +80000 B"),
    ]);
    expect(budgetWarnings(past, baseline)).toEqual([]);
    // the fonts and the primitives keep blocking in this mode
    expect(
      budgetProblems(
        { ...withGrowth(60_000), fonts: FONT_BUDGET_BYTES + 1 },
        baseline
      )
    ).toEqual([expect.stringContaining("fonts")]);
  });

  it("blocks past the reference when the mode goes back to block (the cut step)", () => {
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    const over = {
      fonts: 0,
      interface: 0,
      primitives: 0,
      rest: baseline + REST_GROWTH_BUDGET_GZIP_BYTES + 1,
    };
    expect(budgetProblems(over, baseline, "block")).toEqual([
      expect.stringContaining("past the +44000 B budget"),
    ]);
    expect(budgetWarnings(over, baseline, "block")).toEqual([]);
  });

  it("measures each kind of build against its own baseline (the offline runtime is in the shell or not)", () => {
    expect(restBaseline(false)).toBe(
      REST_BASELINE_GZIP_BYTES.offlineRuntimeOff
    );
    expect(restBaseline(true)).toBe(REST_BASELINE_GZIP_BYTES.offlineRuntimeOn);
    // the build of the e2e on the real stack with the runtime on: +87 KB against the other baseline, +9 KB against its own
    const runtimeOn = {
      fonts: 52_528,
      interface: 0,
      primitives: 0,
      rest: 1_105_454,
    };
    expect(budgetProblems(runtimeOn, restBaseline(false))).toEqual([
      expect.stringContaining("hard cap"),
    ]);
    expect(budgetProblems(runtimeOn, restBaseline(true))).toEqual([]);
  });

  it("reads the switch of the offline runtime from the build's env, as the app does", () => {
    const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
    writeFileSync(join(directory, "index.html"), "<!doctype html>");
    const logFor = (flag: string | undefined) => {
      const logged: string[] = [];
      const plugin = precacheBudgetPlugin();
      (plugin.configResolved as (config: unknown) => void)({
        env: { VITE_OFFLINE_RUNTIME_ENABLED: flag },
      });
      (
        plugin.writeBundle as (this: unknown, output: { dir: string }) => void
      ).call(
        {
          error: (message: string) => logged.push(message),
          info: (message: string) => logged.push(message),
          warn: (message: string) => logged.push(message),
        },
        { dir: directory }
      );
      return logged.join("\n");
    };
    try {
      expect(logFor("true")).toContain(
        `offline runtime on, baseline ${REST_BASELINE_GZIP_BYTES.offlineRuntimeOn} B`
      );
      expect(logFor("false")).toContain(
        `offline runtime off, baseline ${REST_BASELINE_GZIP_BYTES.offlineRuntimeOff} B`
      );
      expect(logFor(undefined)).toContain("offline runtime off");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("counts the interface infrastructure by its share of a chunk, apart from the primitives and the screen", () => {
    const random = new Uint8Array(10_000).map(
      (_, index) => (index * 7919) % 251
    );
    const files: Record<string, Uint8Array> = {
      "assets/sale-def.js": random,
    };
    const read = (path: string) => files[path] as Uint8Array;
    const chunks = [
      {
        fileName: "assets/sale-def.js",
        modules: {
          "/repo/apps/web/src/lib/utils.test.ts": { renderedLength: 50 },
          "/repo/apps/web/src/lib/utils.ts": { renderedLength: 50 },
          "/repo/apps/web/src/sales/sale-page.tsx": { renderedLength: 400 },
          "/repo/apps/web/src/ui/field.tsx": { renderedLength: 200 },
          "/repo/node_modules/.bun/@base-ui+react@1.9.0+x/node_modules/@base-ui/react/esm/dialog/index.js":
            { renderedLength: 200 },
          "/repo/node_modules/.bun/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs":
            { renderedLength: 50 },
          "/repo/node_modules/lucide-react/dist/esm/icons/check.js": {
            renderedLength: 50,
          },
        },
      },
    ];
    // src/ui, cn and its libraries: 350 of 1000; a lookalike path (utils.test.ts) is the screen's
    expect([...interfaceShares(chunks)]).toEqual([
      ["assets/sale-def.js", 0.35],
    ]);
    expect([...primitiveShares(chunks)]).toEqual([["assets/sale-def.js", 0.2]]);
    const whole = measurePrecache(Object.keys(files), read);
    const split = measurePrecache(Object.keys(files), read, {
      interface: interfaceShares(chunks),
      primitives: primitiveShares(chunks),
    });
    expect(split.interface / whole.rest).toBeCloseTo(0.35, 2);
    expect(split.primitives / whole.rest).toBeCloseTo(0.2, 2);
    expect(split.primitives + split.interface + split.rest).toBe(whole.rest);
  });

  it("counts the interface infrastructure in the rest line (control: it does not escape it by moving out of the rest)", () => {
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    const atLimit = {
      fonts: 0,
      interface: 15_000,
      primitives: 0,
      rest: baseline + REST_GROWTH_BUDGET_GZIP_BYTES - 15_000,
    };
    expect(budgetWarnings(atLimit, baseline)).toEqual([]);
    const past = budgetWarnings(
      { ...atLimit, interface: atLimit.interface + 1 },
      baseline
    );
    expect(past).toEqual([expect.stringContaining("excess +1 B")]);
    const hard = budgetProblems(
      {
        ...atLimit,
        interface: atLimit.interface + REST_GROWTH_HARD_CAP_GZIP_BYTES,
      },
      baseline
    );
    expect(hard).toEqual([expect.stringContaining("hard cap")]);
    expect(hard[0]).toContain("interface infrastructure 95000 B");
  });

  it("prints the primitives, the interface infrastructure and the screen apart, over a real output directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<!doctype html>");
    const chunk = new Uint8Array(20_000).map(
      (_, index) => (index * 7919) % 251
    );
    writeFileSync(join(directory, "assets/sale-def.js"), chunk);
    const logged: string[] = [];
    const plugin = precacheBudgetPlugin();
    (plugin.configResolved as (config: unknown) => void)({ env: {} });
    (
      plugin.generateBundle as (
        this: unknown,
        options: unknown,
        bundle: unknown
      ) => void
    ).call(
      {},
      {},
      {
        "assets/sale-def.js": {
          fileName: "assets/sale-def.js",
          modules: {
            "/repo/apps/web/src/sales/sale-page.tsx": { renderedLength: 500 },
            "/repo/apps/web/src/ui/field.tsx": { renderedLength: 300 },
            "/repo/node_modules/@base-ui/react/esm/dialog/index.js": {
              renderedLength: 200,
            },
          },
          type: "chunk",
        },
      }
    );
    try {
      (
        plugin.writeBundle as (this: unknown, output: { dir: string }) => void
      ).call(
        {
          error: (message: string) => logged.push(message),
          info: (message: string) => logged.push(message),
        },
        { dir: directory }
      );
      const size = measurePrecache(
        ["index.html", "assets/sale-def.js"],
        (path) => readFileSync(join(directory, path)),
        {
          interface: new Map([["assets/sale-def.js", 0.3]]),
          primitives: new Map([["assets/sale-def.js", 0.2]]),
        }
      );
      expect(size.interface).toBeGreaterThan(0);
      expect(size.primitives).toBeGreaterThan(0);
      const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
      expect(logged.join("\n")).toContain(
        `Base UI primitives ${size.primitives} B gzip, interface infrastructure ${size.interface} B gzip, screen and the rest ${size.rest} B gzip (${size.rest - baseline} B over the baseline); rest line ${size.rest + size.interface} B gzip`
      );
      // the line a review greps for in the CI log is always printed
      expect(logged.join("\n")).toMatch(GROWTH_LINE);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("warns, without failing, between the reference and the hard cap, and fails past the hard cap (the build, over a real output directory)", () => {
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    // random bytes do not compress: the gzip size is the size, plus a few hundred bytes
    const build = (growth: number) => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      writeFileSync(
        join(directory, "assets/app-abc.js"),
        randomBytes(baseline + growth)
      );
      const said = {
        error: [] as string[],
        info: [] as string[],
        warn: [] as string[],
      };
      const plugin = precacheBudgetPlugin();
      (plugin.configResolved as (config: unknown) => void)({ env: {} });
      try {
        (
          plugin.writeBundle as (this: unknown, output: { dir: string }) => void
        ).call(
          {
            error: (message: string) => said.error.push(message),
            info: (message: string) => said.info.push(message),
            warn: (message: string) => said.warn.push(message),
          },
          { dir: directory }
        );
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return said;
    };
    const inBetween = build(55_000);
    expect(inBetween.error).toEqual([]);
    expect(inBetween.warn).toEqual([expect.stringContaining("excess +")]);
    expect(inBetween.info.join("\n")).toMatch(GROWTH_LINE);
    const past = build(90_000);
    expect(past.warn).toEqual([]);
    expect(past.error).toEqual([expect.stringContaining("hard cap")]);
    expect(past.info.join("\n")).toMatch(GROWTH_LINE);
  });

  it("fails the production build when the gallery or the lab of the screens is in it (control: a build without them passes)", () => {
    const build = (assets: string[]) => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      for (const asset of assets) {
        writeFileSync(join(directory, "assets", asset), bytes(100, 1));
      }
      const errors: string[] = [];
      const plugin = precacheBudgetPlugin();
      (plugin.configResolved as (config: unknown) => void)({ env: {} });
      try {
        (
          plugin.writeBundle as (this: unknown, output: { dir: string }) => void
        ).call(
          {
            error: (message: string) => errors.push(message),
            info: () => undefined,
          },
          { dir: directory }
        );
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return errors.join("\n");
    };
    expect(build(["index-abc123.js", "sale-page-def456.js"])).toBe("");
    expect(build(["index-abc123.js", "screens-lab-Dk3_x9.js"])).toContain(
      "the screens lab is in the production build (assets/screens-lab-Dk3_x9.js)"
    );
    expect(build(["ui-gallery-Dk3_x9.js"])).toContain(
      "the UI gallery is in the production build"
    );
    // a name that only starts like the lab is another chunk
    expect(testOnlyChunkProblems(["assets/screens-lab-helpers.css"])).toEqual(
      []
    );
    expect(
      testOnlyChunkProblems([
        "assets/screens-lab-aaa.js",
        "assets/ui-gallery-bbb.js",
      ])
    ).toHaveLength(2);
  });

  it("keeps the ceilings of the ADR: 55 KB of fonts, 95 KB gzip of primitives, +44 KB gzip of reference (warning) and +80 KB hard cap for the rest", () => {
    expect(FONT_BUDGET_BYTES).toBe(55_000);
    expect(PRIMITIVES_BUDGET_GZIP_BYTES).toBe(95_000);
    expect(REST_GROWTH_BUDGET_GZIP_BYTES).toBe(44_000);
    expect(REST_GROWTH_HARD_CAP_GZIP_BYTES).toBe(80_000);
  });
});
