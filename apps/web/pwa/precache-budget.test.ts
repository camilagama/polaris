import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUDGET_MODE,
  CALENDAR_BUDGET_GZIP_BYTES,
  calendarLine,
  budgetProblems,
  budgetWarnings,
  CHARTS_BUDGET_GZIP_BYTES,
  chunkBudgetProblems,
  chunkBudgetWarnings,
  chartsLine,
  calendarPlacementProblems,
  chartsPlacementProblems,
  FONT_BUDGET_BYTES,
  HEATMAP_BUDGET_GZIP_BYTES,
  heatmapLine,
  interfaceShares,
  MOTION_BUDGET_GZIP_BYTES,
  measurePrecache,
  motionLine,
  motionLoadProblems,
  onlineOnlyLine,
  onlineOnlyPlacementProblems,
  PRIMITIVES_BUDGET_GZIP_BYTES,
  precacheBudgetPlugin,
  primitiveShares,
  REST_BASELINE_GZIP_BYTES,
  REST_GROWTH_BUDGET_GZIP_BYTES,
  REST_GROWTH_MARK_GZIP_BYTES,
  restBaseline,
  testOnlyChunkProblems,
} from "./precache-budget";

const GROWTH_LINE =
  /PRECACHE-GROWTH total \d+ B gzip, growth [+-]?\d+ B over the baseline of \d+ B \(reference \+44000 B/;

const CALENDAR_LINE = /CALENDAR chunk \d+ B gzip of 26000 B/;

const MOTION_LINE = /^MOTION chunk \d+ B gzip of 56000 B/;

const CHARTS_LINE = /CHARTS chunk \d+ B gzip of 8000 B \(\d+ B left\)/;

const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;

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

  it("is in warn mode until the cut step, a constant for the four size lines", () => {
    expect(BUDGET_MODE).toBe("warn");
  });

  // one case on each side of each of the four lines, in both modes
  const floor = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
  const empty = {
    calendar: 0,
    charts: 0,
    fonts: 0,
    heatmap: 0,
    interface: 0,
    motion: 0,
    primitives: 0,
    rest: 0,
  };
  const lines = [
    {
      name: "fonts",
      problem: "fonts",
      over: { ...empty, rest: floor, fonts: FONT_BUDGET_BYTES + 1 },
      at: { ...empty, rest: floor, fonts: FONT_BUDGET_BYTES },
      excess: "excess +1 B",
      total: `total ${FONT_BUDGET_BYTES + 1} B,`,
    },
    {
      name: "primitives",
      problem: "primitives",
      over: {
        ...empty,
        rest: floor,
        primitives: PRIMITIVES_BUDGET_GZIP_BYTES + 1,
      },
      at: {
        ...empty,
        rest: floor,
        primitives: PRIMITIVES_BUDGET_GZIP_BYTES,
      },
      excess: "excess +1 B",
      total: `total ${PRIMITIVES_BUDGET_GZIP_BYTES + 1} B gzip`,
    },
    {
      name: "calendar",
      problem: "calendar chunk",
      over: { ...empty, rest: floor, calendar: CALENDAR_BUDGET_GZIP_BYTES + 1 },
      at: { ...empty, rest: floor, calendar: CALENDAR_BUDGET_GZIP_BYTES },
      excess: "excess +1 B",
      total: `total ${CALENDAR_BUDGET_GZIP_BYTES + 1} B gzip`,
    },
    {
      name: "charts",
      problem: "charts chunk",
      over: { ...empty, rest: floor, charts: CHARTS_BUDGET_GZIP_BYTES + 1 },
      at: { ...empty, rest: floor, charts: CHARTS_BUDGET_GZIP_BYTES },
      excess: "excess +1 B",
      total: `total ${CHARTS_BUDGET_GZIP_BYTES + 1} B gzip`,
    },
    {
      name: "rest, past the reference",
      problem: "past the +44000 B budget",
      over: {
        ...empty,
        rest: floor + REST_GROWTH_BUDGET_GZIP_BYTES + 1,
      },
      at: { ...empty, rest: floor + REST_GROWTH_BUDGET_GZIP_BYTES },
      excess: "excess +1 B",
      total: `total ${floor + REST_GROWTH_BUDGET_GZIP_BYTES + 1} B gzip`,
    },
  ];

  for (const line of lines) {
    it(`${line.name}: in "warn" passes at the number and one byte past it, with a warning that carries the total and the excess`, () => {
      expect(budgetProblems(line.at, floor, "warn")).toEqual([]);
      expect(budgetProblems(line.over, floor, "warn")).toEqual([]);
      const atWarnings = budgetWarnings(line.at, floor, "warn");
      expect(atWarnings).toEqual([]);
      const [warning, ...others] = budgetWarnings(line.over, floor, "warn");
      expect(others).toEqual([]);
      expect(warning).toContain(line.total);
      expect(warning).toContain(line.excess);
    });

    it(`${line.name}: in "block" passes at the number and fails one byte past it, with no warning`, () => {
      expect(budgetProblems(line.at, floor, "block")).toEqual([]);
      expect(budgetProblems(line.over, floor, "block")).toEqual([
        expect.stringContaining(line.problem),
      ]);
      expect(budgetWarnings(line.at, floor, "block")).toEqual([]);
      expect(budgetWarnings(line.over, floor, "block")).toEqual([]);
    });
  }

  it("warns for each line past its number, all at once, and the warning for the rest keeps the mark's text (t272, t353)", () => {
    const withGrowth = (growth: number) => ({
      ...empty,
      rest: floor + growth,
    });
    // in the middle of the way (+60 000 B): a warning without the mark
    const [middle] = budgetWarnings(withGrowth(60_000), floor, "warn");
    expect(middle).toContain("excess +16000 B");
    expect(middle).not.toContain("mark by");
    // at the +80 000 B mark: the text of the mark is not there; one byte past it, it is
    expect(
      budgetWarnings(withGrowth(REST_GROWTH_MARK_GZIP_BYTES), floor, "warn")[0]
    ).not.toContain("mark by");
    expect(
      budgetWarnings(withGrowth(REST_GROWTH_MARK_GZIP_BYTES + 1), floor, "warn")
    ).toEqual([expect.stringContaining("+80000 B mark by 1 B")]);
    // far past (+83 007 B, the main at +77 520 B): passes in "warn", fails in "block" (the reviewer's number)
    const pr306 = withGrowth(83_007);
    expect(budgetProblems(pr306, floor, "warn")).toEqual([]);
    const [pr306Warning] = budgetWarnings(pr306, floor, "warn");
    expect(pr306Warning).toContain("growth +83007 B");
    expect(pr306Warning).toContain("excess +39007 B");
    expect(pr306Warning).toContain("+80000 B mark by 3007 B");
    expect(budgetProblems(pr306, floor, "block")).toEqual([
      expect.stringContaining("past the +44000 B budget"),
    ]);
    // all six lines at once
    const all = {
      calendar: CALENDAR_BUDGET_GZIP_BYTES + 5,
      charts: CHARTS_BUDGET_GZIP_BYTES + 10,
      fonts: FONT_BUDGET_BYTES + 20,
      heatmap: 0,
      interface: 0,
      motion: MOTION_BUDGET_GZIP_BYTES + 15,
      primitives: PRIMITIVES_BUDGET_GZIP_BYTES + 30,
      rest: floor + REST_GROWTH_BUDGET_GZIP_BYTES + 40,
    };
    expect(budgetProblems(all, floor, "warn")).toEqual([]);
    expect(budgetWarnings(all, floor, "warn")).toHaveLength(6);
    expect(budgetProblems(all, floor, "block")).toHaveLength(6);
    expect(budgetProblems(all, floor, "block")).toContainEqual(
      expect.stringContaining("calendar chunk")
    );
  });

  it('the chunk lines alone: a warning in "warn", a problem in "block"', () => {
    const size = { ...empty, charts: CHARTS_BUDGET_GZIP_BYTES + 1 };
    expect(chunkBudgetProblems(size, "warn")).toEqual([]);
    expect(chunkBudgetWarnings(size, "warn")).toEqual([
      expect.stringContaining("excess +1 B"),
    ]);
    expect(chunkBudgetProblems(size, "block")).toEqual([
      expect.stringContaining("charts chunk"),
    ]);
    expect(chunkBudgetWarnings(size, "block")).toEqual([]);
    const calendar = { ...empty, calendar: CALENDAR_BUDGET_GZIP_BYTES + 1 };
    expect(chunkBudgetWarnings(calendar, "warn")).toEqual([
      expect.stringContaining("calendar chunk"),
    ]);
    expect(chunkBudgetProblems(calendar, "block")).toEqual([
      expect.stringContaining("calendar chunk"),
    ]);
    const fonts = { ...empty, fonts: FONT_BUDGET_BYTES + 1 };
    expect(chunkBudgetWarnings(fonts, "warn")).toEqual([]);
  });

  it("measures each kind of build against its own baseline (the offline runtime is in the shell or not)", () => {
    expect(restBaseline(false)).toBe(
      REST_BASELINE_GZIP_BYTES.offlineRuntimeOff
    );
    expect(restBaseline(true)).toBe(REST_BASELINE_GZIP_BYTES.offlineRuntimeOn);
    // the build of the e2e on the real stack with the runtime on: +87 KB against the other baseline, +9 KB against its own
    const runtimeOn = {
      calendar: 0,
      charts: 0,
      fonts: 52_528,
      heatmap: 0,
      interface: 0,
      motion: 0,
      primitives: 0,
      rest: 1_105_454,
    };
    expect(budgetProblems(runtimeOn, restBaseline(false))).toEqual([]);
    expect(budgetWarnings(runtimeOn, restBaseline(false))).toEqual([
      expect.stringContaining("growth +87127 B"),
    ]);
    expect(budgetWarnings(runtimeOn, restBaseline(true))).toEqual([]);
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
      calendar: 0,
      charts: 0,
      fonts: 0,
      heatmap: 0,
      interface: 15_000,
      motion: 0,
      primitives: 0,
      rest: baseline + REST_GROWTH_BUDGET_GZIP_BYTES - 15_000,
    };
    expect(budgetWarnings(atLimit, baseline)).toEqual([]);
    const past = budgetWarnings(
      { ...atLimit, interface: atLimit.interface + 1 },
      baseline
    );
    expect(past).toEqual([expect.stringContaining("excess +1 B")]);
    const far = {
      ...atLimit,
      interface: atLimit.interface + REST_GROWTH_MARK_GZIP_BYTES,
    };
    expect(budgetProblems(far, baseline)).toEqual([]);
    expect(budgetWarnings(far, baseline)).toEqual([
      expect.stringContaining("mark by 44000 B"),
    ]);
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

  it("warns, without failing, past the reference and past the +80 000 B mark (the build, over a real output directory)", () => {
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    // random bytes do not compress: the gzip size is the size, plus a few hundred bytes
    const build = (growth: number, mode?: "block") => {
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
      const plugin = precacheBudgetPlugin(mode ? { mode } : {});
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
    expect(past.error).toEqual([]);
    expect(past.warn).toEqual([expect.stringContaining("mark by")]);
    expect(past.info.join("\n")).toMatch(GROWTH_LINE);
    // the same build in "block" (the cut step) fails and does not warn
    const blocked = build(90_000, "block");
    expect(blocked.error).toEqual([
      expect.stringContaining("past the +44000 B"),
    ]);
    expect(blocked.warn).toEqual([]);
  });

  it('a font file past 55 000 B warns in "warn" and fails in "block" (the build, over a real output directory)', () => {
    const run = (fontBytes: number, mode: "warn" | "block") => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      writeFileSync(
        join(directory, "assets/geist-latin.woff2"),
        bytes(fontBytes)
      );
      const said = { error: [] as string[], warn: [] as string[] };
      const plugin = precacheBudgetPlugin({ mode });
      (plugin.configResolved as (config: unknown) => void)({ env: {} });
      try {
        (
          plugin.writeBundle as (this: unknown, output: { dir: string }) => void
        ).call(
          {
            error: (message: string) => said.error.push(message),
            info: () => undefined,
            warn: (message: string) => said.warn.push(message),
          },
          { dir: directory }
        );
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return said;
    };
    expect(run(FONT_BUDGET_BYTES, "block")).toEqual({ error: [], warn: [] });
    expect(run(FONT_BUDGET_BYTES + 1, "warn")).toEqual({
      error: [],
      warn: [expect.stringContaining("fonts over its line")],
    });
    const blocked = run(FONT_BUDGET_BYTES + 1, "block");
    expect(blocked.warn).toEqual([]);
    expect(blocked.error).toEqual([expect.stringContaining("fonts: 55001 B")]);
  });

  it('fails the production build, in "warn" too, when the gallery or the lab of the screens is in it (control: a build without them passes)', () => {
    const build = (assets: string[]) => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      for (const asset of assets) {
        writeFileSync(join(directory, "assets", asset), bytes(100, 1));
      }
      const errors: string[] = [];
      const plugin = precacheBudgetPlugin({ mode: "warn" });
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

  it("keeps the ceilings of the ADR: 55 KB of fonts, 95 KB gzip of primitives, +44 KB gzip of reference and the +80 KB mark for the rest (all four only warn)", () => {
    expect(FONT_BUDGET_BYTES).toBe(55_000);
    expect(PRIMITIVES_BUDGET_GZIP_BYTES).toBe(95_000);
    expect(REST_GROWTH_BUDGET_GZIP_BYTES).toBe(44_000);
    expect(REST_GROWTH_MARK_GZIP_BYTES).toBe(80_000);
  });
});

describe("the charts line (ADR 0103, amendment Gráficos, t285)", () => {
  const random = (length: number) =>
    new Uint8Array(length).map((_, index) => (index * 7919) % 251);
  const asSize = (charts: number) => ({
    calendar: 0,
    charts,
    fonts: 0,
    heatmap: 0,
    interface: 0,
    motion: 0,
    primitives: 0,
    rest: 0,
  });

  it("counts the charts chunk in a line of its own: not in the rest, not in the interface share", () => {
    const files: Record<string, Uint8Array> = {
      "assets/charts-Dk3jf9.js": random(10_000),
      "assets/index-abc.js": random(10_000),
    };
    const size = measurePrecache(
      Object.keys(files),
      (path) => files[path] as Uint8Array,
      {
        // even a share that says the chunk is all interface code does not move it to the rest line
        interface: new Map([["assets/charts-Dk3jf9.js", 1]]),
      }
    );
    expect(size.charts).toBeGreaterThan(0);
    expect(size.interface).toBe(0);
    const withoutCharts = measurePrecache(["assets/index-abc.js"], (path) =>
      path === "assets/index-abc.js" ? random(10_000) : bytes(0)
    );
    expect(size.rest).toBe(withoutCharts.rest);
    // a name that only starts like it is another chunk
    const other = measurePrecache(["assets/charts-page-abc.css"], () =>
      random(1000)
    );
    expect(other.charts).toBe(0);
  });

  it('passes at 8 000 B gzip; one byte past it warns in "warn" and fails in "block", in any build that has the chunk', () => {
    expect(CHARTS_BUDGET_GZIP_BYTES).toBe(8000);
    expect(chunkBudgetProblems(asSize(8000), "block")).toEqual([]);
    expect(chunkBudgetProblems(asSize(8001), "block")).toEqual([
      expect.stringContaining("charts chunk: 8001 B gzip, over the 8000 B"),
    ]);
    expect(chunkBudgetProblems(asSize(8001), "warn")).toEqual([]);
    const baseline = REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
    expect(
      budgetProblems({ ...asSize(8001), rest: baseline }, baseline, "block")
    ).toEqual([expect.stringContaining("charts chunk")]);
    expect(
      budgetProblems({ ...asSize(8000), rest: baseline }, baseline, "block")
    ).toEqual([]);
  });

  it("prints the line the review greps for, with the bytes left or the excess, or that the build has no chunk", () => {
    expect(chartsLine(asSize(0))).toBe(
      "CHARTS no charts chunk in this build (no screen asks for a chart yet), 0 B of 8000 B gzip"
    );
    expect(chartsLine(asSize(5321))).toBe(
      "CHARTS chunk 5321 B gzip of 8000 B (2679 B left)"
    );
    expect(chartsLine(asSize(8000))).toContain("(0 B left)");
    expect(chartsLine(asSize(8100))).toContain("over by 100 B");
  });

  it("fails a chart module, d3-shape or d3-path in a chunk that is not the charts chunk (control: in its own chunk it passes)", () => {
    const chart = "/repo/apps/web/src/ui/charts/area-chart.tsx";
    const d3 =
      "/repo/node_modules/.bun/d3-shape@3.2.0/node_modules/d3-shape/src/line.js";
    const loader = "/repo/apps/web/src/ui/charts/on-demand.tsx";
    expect(
      chartsPlacementProblems([
        {
          fileName: "assets/charts-Dk3jf9.js",
          modules: {
            [chart]: { renderedLength: 1 },
            [d3]: { renderedLength: 1 },
          },
        },
        {
          fileName: "assets/index-abc.js",
          modules: { [loader]: { renderedLength: 1 } },
        },
      ])
    ).toEqual([]);
    expect(
      chartsPlacementProblems([
        {
          fileName: "assets/sale-def.js",
          modules: {
            [chart]: { renderedLength: 1 },
            [d3]: { renderedLength: 1 },
          },
        },
      ])
    ).toEqual([
      expect.stringContaining(
        "chart module /repo/apps/web/src/ui/charts/area-chart.tsx is in assets/sale-def.js"
      ),
      expect.stringContaining(
        "chart module d3-shape/src/line.js is in assets/sale-def.js"
      ),
    ]);
  });

  it("fails motion, framer-motion or motion-utils in a chunk that is neither the charts nor the motion chunk (control: in either of them it passes; a chart module still cannot sit in the motion chunk)", () => {
    const motion =
      "/repo/node_modules/.bun/motion@14.3.0/node_modules/motion/dist/es/react.mjs";
    const framer =
      "/repo/node_modules/.bun/framer-motion@14.3.0/node_modules/framer-motion/dist/es/context/PresenceContext.mjs";
    const utils =
      "/repo/node_modules/.bun/motion-utils@14.3.0/node_modules/motion-utils/dist/es/noop.mjs";
    const heavy = {
      [framer]: { renderedLength: 1 },
      [motion]: { renderedLength: 1 },
      [utils]: { renderedLength: 1 },
    };
    expect(
      chartsPlacementProblems([
        { fileName: "assets/motion-B0SXIb_6.js", modules: heavy },
        { fileName: "assets/charts-Dk3jf9.js", modules: heavy },
        {
          fileName: "assets/index-abc.js",
          modules: {
            "/repo/apps/web/src/ui/filter-bar.tsx": { renderedLength: 1 },
          },
        },
      ])
    ).toEqual([]);
    expect(
      chartsPlacementProblems([
        { fileName: "assets/react-Ds8upiYS.js", modules: heavy },
      ])
    ).toEqual([
      expect.stringContaining(
        "motion module framer-motion/dist/es/context/PresenceContext.mjs is in assets/react-Ds8upiYS.js, outside the charts and motion chunks"
      ),
      expect.stringContaining("motion module motion/dist/es/react.mjs"),
      expect.stringContaining("motion module motion-utils/dist/es/noop.mjs"),
    ]);
    expect(
      chartsPlacementProblems([
        {
          fileName: "assets/motion-B0SXIb_6.js",
          modules: {
            "/repo/apps/web/src/ui/charts/area-chart.tsx": {
              renderedLength: 1,
            },
          },
        },
      ])
    ).toEqual([
      expect.stringContaining(
        "chart module /repo/apps/web/src/ui/charts/area-chart.tsx is in assets/motion-B0SXIb_6.js, outside the charts chunk"
      ),
    ]);
  });

  it("takes every file of the import in the source tree for a module of its chunk: none escapes the guard by its name", () => {
    const catalog = fileURLToPath(new URL("../src/catalog", import.meta.url));
    const files = [
      ...readdirSync(catalog)
        .filter((name) => name.startsWith("product-import-"))
        .map((name) => join(catalog, name)),
      ...readdirSync(join(catalog, "product-import"), { recursive: true })
        .map(String)
        .map((name) => join(catalog, "product-import", name)),
    ].filter((path) => SOURCE_FILE.test(path) && !TEST_FILE.test(path));
    // the tree as it is: the reading, the sending, the CSV and the screen (a new file joins this list, and the guard)
    expect(
      files.map((path) => path.slice(path.indexOf("src/catalog/"))).sort()
    ).toEqual([
      "src/catalog/product-import-csv.ts",
      "src/catalog/product-import-failed-csv.ts",
      "src/catalog/product-import-rows.ts",
      "src/catalog/product-import-send.ts",
      "src/catalog/product-import/import-file-step.tsx",
      "src/catalog/product-import/import-frame.tsx",
      "src/catalog/product-import/import-model.ts",
      "src/catalog/product-import/import-preview-step.tsx",
      "src/catalog/product-import/import-result-step.tsx",
      "src/catalog/product-import/import-rows-table.tsx",
      "src/catalog/product-import/import-run-step.tsx",
      "src/catalog/product-import/product-import-dialog.tsx",
      "src/catalog/product-import/use-product-import.ts",
    ]);
    const misplaced = onlineOnlyPlacementProblems([
      {
        fileName: "assets/index-abc.js",
        modules: Object.fromEntries(
          files.map((path) => [path, { renderedLength: 1 }])
        ),
      },
    ]);
    expect(misplaced).toHaveLength(files.length);
  });

  it("fails a module of the import of a spreadsheet in a precached chunk, or a static import of its chunk (control: alone in its chunk, loaded by import(), it passes)", () => {
    const screen = "/repo/apps/web/src/catalog/product-import/import-model.ts";
    const reading = "/repo/apps/web/src/catalog/product-import-csv.ts";
    const page = "/repo/apps/web/src/catalog/products-page.tsx";
    const form = "/repo/apps/web/src/catalog/product-opening-model.ts";
    const importChunk = "assets/product-import-dialog-Ab12_x.js";
    const own = {
      fileName: importChunk,
      isDynamicEntry: true,
      modules: {
        [reading]: { renderedLength: 1 },
        [screen]: { renderedLength: 1 },
      },
    };
    const pageChunk = {
      fileName: "assets/products-page-abc.js",
      imports: ["assets/index-abc.js"],
      modules: {
        [form]: { renderedLength: 1 },
        [page]: { renderedLength: 1 },
      },
    };
    expect(onlineOnlyPlacementProblems([own, pageChunk])).toEqual([]);
    // a module of the import pulled into the page's chunk
    expect(
      onlineOnlyPlacementProblems([
        own,
        {
          ...pageChunk,
          modules: { ...pageChunk.modules, [reading]: { renderedLength: 1 } },
        },
      ])
    ).toEqual([
      "module of the import src/catalog/product-import-csv.ts is in assets/products-page-abc.js, a precached chunk",
    ]);
    // the screen of the import in the shell's first script
    expect(
      onlineOnlyPlacementProblems([
        own,
        {
          fileName: "assets/index-abc.js",
          isEntry: true,
          modules: { [screen]: { renderedLength: 1 } },
        },
      ])
    ).toEqual([
      "module of the import src/catalog/product-import/import-model.ts is in assets/index-abc.js, a precached chunk",
    ]);
    // a static import of the chunk out of the precache
    expect(
      onlineOnlyPlacementProblems([
        own,
        { ...pageChunk, imports: ["assets/index-abc.js", importChunk] },
      ])
    ).toEqual([
      `assets/products-page-abc.js imports ${importChunk} statically: the chunk out of the precache loads only by import()`,
    ]);
    // a screen file next to the reading, a folder under the screen, a module id with the query of the bundler
    for (const id of [
      "/repo/apps/web/src/catalog/product-import-summary.tsx",
      "/repo/apps/web/src/catalog/product-import/steps/preview.tsx",
      "/repo/apps/web/src/catalog/product-import/import-model.ts?used",
    ]) {
      expect(
        onlineOnlyPlacementProblems([
          own,
          { ...pageChunk, modules: { [id]: { renderedLength: 1 } } },
        ])
      ).toHaveLength(1);
    }
    expect(onlineOnlyLine(12_410)).toBe(
      "PRODUCT-IMPORT chunk 12410 B gzip, out of the precache (loaded online, when the import opens)"
    );
  });

  it("fails the calendar, react-day-picker or date-fns in a chunk that is not the calendar chunk (control: in its own chunk, and the loader and the pickers anywhere, it passes)", () => {
    const calendar = "/repo/apps/web/src/ui/calendar.tsx";
    const dayPicker =
      "/repo/node_modules/.bun/react-day-picker@10.0.2+0ac650c0/node_modules/react-day-picker/dist/esm/DayPicker.js";
    const dateFns =
      "/repo/node_modules/.bun/date-fns@4.4.0/node_modules/date-fns/format.js";
    const tz =
      "/repo/node_modules/.bun/@date-fns+tz@1.5.0/node_modules/@date-fns/tz/date/index.js";
    const loader = "/repo/apps/web/src/ui/calendar-on-demand.tsx";
    const picker = "/repo/apps/web/src/ui/date-picker.tsx";
    const values = "/repo/apps/web/src/ui/date-values.ts";
    const heavy = {
      [calendar]: { renderedLength: 1 },
      [dateFns]: { renderedLength: 1 },
      [dayPicker]: { renderedLength: 1 },
      [tz]: { renderedLength: 1 },
    };
    expect(
      calendarPlacementProblems([
        { fileName: "assets/calendar-Ab12_x.js", modules: heavy },
        {
          fileName: "assets/index-abc.js",
          modules: {
            [loader]: { renderedLength: 1 },
            [picker]: { renderedLength: 1 },
            [values]: { renderedLength: 1 },
          },
        },
      ])
    ).toEqual([]);
    expect(
      calendarPlacementProblems([
        { fileName: "assets/index-abc.js", modules: heavy },
      ])
    ).toEqual([
      expect.stringContaining(
        "calendar module /repo/apps/web/src/ui/calendar.tsx is in assets/index-abc.js"
      ),
      expect.stringContaining(
        "calendar module date-fns/format.js is in assets/index-abc.js"
      ),
      expect.stringContaining(
        "calendar module react-day-picker/dist/esm/DayPicker.js is in assets/index-abc.js"
      ),
      expect.stringContaining(
        "calendar module @date-fns/tz/date/index.js is in assets/index-abc.js"
      ),
    ]);
  });

  it('the plugin warns over 8 KB in "warn" and fails in "block"; with d3 outside the chunk it fails in both modes; it prints the line (over a real output directory)', () => {
    const run = (
      options: { mode?: "warn" | "block"; only?: "chunks" },
      files: Record<string, Uint8Array>,
      bundle: {
        fileName: string;
        imports?: string[];
        isEntry?: boolean;
        modules: Record<string, unknown>;
      }[] = []
    ) => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(directory, "assets", name), content);
      }
      const said = {
        error: [] as string[],
        info: [] as string[],
        warn: [] as string[],
      };
      const plugin = precacheBudgetPlugin(options);
      (plugin.configResolved as (config: unknown) => void)({ env: {} });
      const context = {
        environment: { name: "client" },
        error: (message: string) => said.error.push(message),
        info: (message: string) => said.info.push(message),
        warn: (message: string) => said.warn.push(message),
      };
      try {
        (
          plugin.generateBundle as (
            this: unknown,
            options: unknown,
            bundle: unknown
          ) => void
        ).call(
          context,
          {},
          Object.fromEntries(
            bundle.map((chunk) => [chunk.fileName, { type: "chunk", ...chunk }])
          )
        );
        (
          plugin.writeBundle as (this: unknown, output: { dir: string }) => void
        ).call(context, { dir: directory });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return said;
    };
    // a build with no chunk says so, and passes
    const none = run({}, { "app-abc.js": random(2000) });
    expect(none.error).toEqual([]);
    expect(none.info.join("\n")).toContain(
      "CHARTS no charts chunk in this build"
    );
    // 3 KB of bytes that do not compress: under the line, printed with what is left
    const small = run({}, { "charts-Dk3jf9.js": randomBytes(3000) });
    expect(small.error).toEqual([]);
    expect(small.info.join("\n")).toMatch(CHARTS_LINE);
    // 9 KB: over the line. In "warn" (the build's mode until the cut step) it passes and warns, in the production
    // build and in the build of the browser checks
    const big = { "charts-Dk3jf9.js": randomBytes(9000) };
    const warned = run({}, big);
    expect(warned.error).toEqual([]);
    expect(warned.warn).toEqual([expect.stringContaining("charts chunk")]);
    const onlyWarned = run({ only: "chunks" }, big);
    expect(onlyWarned.error).toEqual([]);
    expect(onlyWarned.warn).toEqual([expect.stringContaining("excess +")]);
    expect(onlyWarned.info.join("\n")).toContain("over by");
    // in "block" it fails in both builds
    expect(run({ mode: "block" }, big).error).toEqual([
      expect.stringContaining("charts chunk"),
    ]);
    expect(run({ mode: "block", only: "chunks" }, big).error).toEqual([
      expect.stringContaining("charts chunk"),
    ]);
    // the build of the browser checks looks at nothing else: a rest far past the marks is not its business
    expect(
      run(
        { mode: "block", only: "chunks" },
        {
          "app-abc.js": randomBytes(1_200_000),
        }
      ).error
    ).toEqual([]);
    // d3 in the first script: fails in both builds
    const misplaced = [
      {
        fileName: "assets/index-abc.js",
        modules: {
          "/repo/node_modules/d3-shape/src/line.js": { renderedLength: 1 },
        },
      },
    ];
    expect(run({}, { "index-abc.js": random(500) }, misplaced).error).toEqual([
      expect.stringContaining("outside the charts chunk"),
    ]);
    expect(
      run({ only: "chunks" }, { "index-abc.js": random(500) }, misplaced).error
    ).toEqual([expect.stringContaining("outside the charts chunk")]);
    // structure, not size: the guard fails in "warn" too, with the size lines past their numbers
    expect(
      run(
        { mode: "warn" },
        { "charts-Dk3jf9.js": randomBytes(9000) },
        misplaced
      ).error
    ).toEqual([expect.stringContaining("outside the charts chunk")]);
    // motion reached from the entry by a static import fails in both builds and in both modes; by import() only, it passes
    const graph = (imports: string[]) => [
      {
        fileName: "assets/index-abc.js",
        imports,
        isEntry: true,
        modules: {},
      },
      {
        fileName: "assets/motion-B0SXIb_6.js",
        imports: [],
        modules: {},
      },
    ];
    const motionFiles = {
      "index-abc.js": random(500),
      "motion-B0SXIb_6.js": random(500),
    };
    for (const options of [{}, { only: "chunks" as const }]) {
      expect(
        run(options, motionFiles, graph(["assets/motion-B0SXIb_6.js"])).error
      ).toEqual([expect.stringContaining("reachable by static imports")]);
      expect(run(options, motionFiles, graph([])).error).toEqual([]);
    }
  });
});

describe("the motion chunk (ADR 0103, amendment Barra de filtros, t383, t385)", () => {
  const random = (length: number) =>
    new Uint8Array(length).map((_, index) => (index * 7919) % 251);
  const asSize = (motion: number) => ({
    calendar: 0,
    charts: 0,
    fonts: 0,
    heatmap: 0,
    interface: 0,
    motion,
    primitives: 0,
    rest: 0,
  });
  const anyModule = { "/repo/apps/web/src/x.tsx": { renderedLength: 1 } };

  it("counts the motion chunk in a line of its own: not in the charts line, not in the rest", () => {
    const files: Record<string, Uint8Array> = {
      "assets/charts-Dk3jf9.js": random(10_000),
      "assets/index-abc.js": random(10_000),
      "assets/motion-B0SXIb_6.js": random(10_000),
    };
    const size = measurePrecache(
      Object.keys(files),
      (path) => files[path] as Uint8Array
    );
    const chartsOnly = measurePrecache(["assets/charts-Dk3jf9.js"], () =>
      random(10_000)
    );
    const restOnly = measurePrecache(["assets/index-abc.js"], () =>
      random(10_000)
    );
    expect(size.motion).toBeGreaterThan(0);
    expect(size.charts).toBe(chartsOnly.charts);
    expect(size.rest).toBe(restOnly.rest);
    // a name that only starts like it is another file
    expect(
      measurePrecache(["assets/motion-page-abc.css"], () => random(1000)).motion
    ).toBe(0);
  });

  it('passes at 56 000 B gzip; one byte past it warns in "warn" and fails in "block"', () => {
    expect(MOTION_BUDGET_GZIP_BYTES).toBe(56_000);
    expect(chunkBudgetProblems(asSize(56_000), "block")).toEqual([]);
    expect(chunkBudgetProblems(asSize(56_001), "block")).toEqual([
      expect.stringContaining("motion chunk: 56001 B gzip, over the 56000 B"),
    ]);
    expect(chunkBudgetProblems(asSize(56_001), "warn")).toEqual([]);
    expect(chunkBudgetWarnings(asSize(56_001), "warn")).toEqual([
      expect.stringContaining("motion chunk over its line"),
    ]);
    expect(budgetWarnings(asSize(56_001), 0, "warn")).toEqual([
      expect.stringContaining("excess +1 B"),
    ]);
  });

  it("prints the line the review greps for, with the bytes left or the excess, or that the build has no chunk", () => {
    expect(motionLine(asSize(0))).toBe(
      "MOTION no motion chunk in this build, 0 B of 56000 B gzip"
    );
    expect(motionLine(asSize(52_930))).toBe(
      "MOTION chunk 52930 B gzip of 56000 B (3070 B left)"
    );
    expect(motionLine(asSize(56_100))).toContain("over by 100 B");
  });

  it("fails when the entry reaches the motion chunk by static imports, directly or through other chunks (control: the current graph, where charts and the bar come only by import(), passes)", () => {
    const current = [
      {
        fileName: "assets/index-abc.js",
        imports: ["assets/react-def.js"],
        isEntry: true,
        modules: anyModule,
      },
      { fileName: "assets/react-def.js", imports: [], modules: anyModule },
      // the charts and the bar's motion layer import motion statically, but the entry only reaches them by import()
      {
        fileName: "assets/charts-Dk3jf9.js",
        imports: ["assets/motion-B0SXIb_6.js", "assets/react-def.js"],
        isDynamicEntry: true,
        modules: anyModule,
      },
      {
        fileName: "assets/filter-bar-motion-Q1w2e3.js",
        imports: ["assets/motion-B0SXIb_6.js", "assets/react-def.js"],
        isDynamicEntry: true,
        modules: anyModule,
      },
      // a lazy screen with the bar: the bar itself does not import motion
      {
        fileName: "assets/ui-gallery-ghi.js",
        imports: ["assets/react-def.js"],
        isDynamicEntry: true,
        modules: anyModule,
      },
      {
        fileName: "assets/motion-B0SXIb_6.js",
        imports: [],
        modules: anyModule,
      },
    ];
    expect(motionLoadProblems(current)).toEqual([]);
    // the entry imports a module that imports the chunk of motion
    const through = current.map((chunk) =>
      chunk.fileName === "assets/react-def.js"
        ? { ...chunk, imports: ["assets/motion-B0SXIb_6.js"] }
        : chunk
    );
    expect(motionLoadProblems(through)).toEqual([
      expect.stringContaining(
        "assets/index-abc.js -> assets/react-def.js -> assets/motion-B0SXIb_6.js"
      ),
    ]);
    // the entry imports it itself
    const direct = current.map((chunk) =>
      chunk.isEntry
        ? { ...chunk, imports: [...chunk.imports, "assets/motion-B0SXIb_6.js"] }
        : chunk
    );
    expect(motionLoadProblems(direct)).toEqual([
      expect.stringContaining(
        "assets/index-abc.js -> assets/motion-B0SXIb_6.js"
      ),
    ]);
  });

  it("fails when a screen loaded by import() reaches the motion chunk by static imports: a phone would run it with the screen (t386)", () => {
    const graph = (galleryImports: string[]) => [
      {
        fileName: "assets/index-abc.js",
        imports: [],
        isEntry: true,
        modules: anyModule,
      },
      {
        fileName: "assets/ui-gallery-ghi.js",
        imports: galleryImports,
        isDynamicEntry: true,
        modules: anyModule,
      },
      {
        fileName: "assets/filter-bar-ab1.js",
        imports: ["assets/motion-B0SXIb_6.js"],
        modules: anyModule,
      },
      {
        fileName: "assets/charts-Dk3jf9.js",
        imports: ["assets/motion-B0SXIb_6.js"],
        isDynamicEntry: true,
        modules: anyModule,
      },
      {
        fileName: "assets/motion-B0SXIb_6.js",
        imports: [],
        modules: anyModule,
      },
    ];
    // the screen imports a bar that imports motion statically, as the bar did
    expect(motionLoadProblems(graph(["assets/filter-bar-ab1.js"]))).toEqual([
      expect.stringContaining(
        "assets/ui-gallery-ghi.js -> assets/filter-bar-ab1.js -> assets/motion-B0SXIb_6.js"
      ),
    ]);
    // the screen imports the charts chunk statically instead of by import(): it would load motion with the screen
    expect(motionLoadProblems(graph(["assets/charts-Dk3jf9.js"]))).toEqual([
      expect.stringContaining(
        "assets/ui-gallery-ghi.js -> assets/charts-Dk3jf9.js -> assets/motion-B0SXIb_6.js"
      ),
    ]);
    // control: the screen with no static way to motion passes
    expect(motionLoadProblems(graph([]))).toEqual([]);
  });

  it("a bundle with a motion chunk and no entry fails: it cannot be proved that the shell does not load it (a graph with no motion chunk and no entry has nothing to prove)", () => {
    expect(
      motionLoadProblems([
        { fileName: "assets/a.js", imports: [], modules: anyModule },
        { fileName: "assets/motion-B0SXIb_6.js", modules: anyModule },
      ])
    ).toEqual([expect.stringContaining("no chunk is an entry")]);
    expect(
      motionLoadProblems([
        { fileName: "assets/a.js", imports: [], modules: anyModule },
      ])
    ).toEqual([]);
  });

  it("does not loop on a cycle of static imports and reports the chunk once", () => {
    expect(
      motionLoadProblems([
        {
          fileName: "assets/index-abc.js",
          imports: ["assets/a.js", "assets/b.js"],
          isEntry: true,
          modules: anyModule,
        },
        {
          fileName: "assets/a.js",
          imports: ["assets/b.js", "assets/motion-B0SXIb_6.js"],
          modules: anyModule,
        },
        {
          fileName: "assets/b.js",
          imports: ["assets/a.js"],
          modules: anyModule,
        },
        { fileName: "assets/motion-B0SXIb_6.js", modules: anyModule },
      ])
    ).toHaveLength(1);
  });

  it("the plugin prints the MOTION line", () => {
    const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
    try {
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      writeFileSync(
        join(directory, "assets", "motion-B0SXIb_6.js"),
        random(1000)
      );
      const info: string[] = [];
      const plugin = precacheBudgetPlugin({ only: "chunks" });
      const write = plugin.writeBundle as (
        this: unknown,
        options: { dir: string }
      ) => void;
      write.call(
        {
          environment: { name: "client" },
          error: (message: string) => {
            throw new Error(message);
          },
          info: (message: string) => info.push(message),
          warn: () => undefined,
        },
        { dir: directory }
      );
      expect(info).toEqual(
        expect.arrayContaining([expect.stringMatching(MOTION_LINE)])
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("the calendar line (ADR 0103, amendment Datas, t363, t369)", () => {
  const random = (length: number) =>
    new Uint8Array(length).map((_, index) => (index * 7919) % 251);
  const asSize = (calendar: number) => ({
    calendar,
    charts: 0,
    fonts: 0,
    heatmap: 0,
    interface: 0,
    motion: 0,
    primitives: 0,
    rest: 0,
  });

  it("counts the calendar chunk in a line of its own: not in the rest, not in the interface share, not in the charts", () => {
    const files: Record<string, Uint8Array> = {
      "assets/calendar-Ab12_x.js": random(10_000),
      "assets/index-abc.js": random(10_000),
    };
    const size = measurePrecache(
      Object.keys(files),
      (path) => files[path] as Uint8Array,
      {
        // calendar.tsx is in src/ui/: even a share that says the chunk is all interface code does not move it
        interface: new Map([["assets/calendar-Ab12_x.js", 1]]),
      }
    );
    expect(size.calendar).toBeGreaterThan(0);
    expect(size.charts).toBe(0);
    expect(size.interface).toBe(0);
    const withoutCalendar = measurePrecache(["assets/index-abc.js"], () =>
      random(10_000)
    );
    expect(size.rest).toBe(withoutCalendar.rest);
    // a name that only starts like it is another file
    const other = measurePrecache(["assets/calendar-page-abc.css"], () =>
      random(1000)
    );
    expect(other.calendar).toBe(0);
  });

  it('passes at 26 000 B gzip; one byte past it warns in "warn" and fails in "block"', () => {
    expect(CALENDAR_BUDGET_GZIP_BYTES).toBe(26_000);
    expect(chunkBudgetProblems(asSize(26_000), "block")).toEqual([]);
    expect(chunkBudgetProblems(asSize(26_001), "block")).toEqual([
      expect.stringContaining("calendar chunk: 26001 B gzip, over the 26000 B"),
    ]);
    expect(chunkBudgetProblems(asSize(26_001), "warn")).toEqual([]);
    expect(chunkBudgetWarnings(asSize(26_001), "warn")).toEqual([
      expect.stringContaining("excess +1 B"),
    ]);
  });

  it("prints the line the review greps for, with the bytes left or the excess, or that the build has no chunk", () => {
    expect(calendarLine(asSize(0))).toBe(
      "CALENDAR no calendar chunk in this build (no screen asks for a picker yet), 0 B of 26000 B gzip"
    );
    expect(calendarLine(asSize(22_645))).toBe(
      "CALENDAR chunk 22645 B gzip of 26000 B (3355 B left)"
    );
    expect(calendarLine(asSize(26_100))).toContain("over by 100 B");
  });

  it("the plugin over a real output directory: prints the CALENDAR line, warns past 26 KB, fails in block, and with only chunks looks at nothing else", () => {
    const run = (
      options: { mode?: "warn" | "block"; only?: "chunks" },
      files: Record<string, Uint8Array>
    ) => {
      const directory = mkdtempSync(join(tmpdir(), "precache-budget-"));
      mkdirSync(join(directory, "assets"));
      writeFileSync(join(directory, "index.html"), "<!doctype html>");
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(directory, "assets", name), content);
      }
      const said = {
        error: [] as string[],
        info: [] as string[],
        warn: [] as string[],
      };
      const plugin = precacheBudgetPlugin(options);
      (plugin.configResolved as (config: unknown) => void)({ env: {} });
      const context = {
        environment: { name: "client" },
        error: (message: string) => said.error.push(message),
        info: (message: string) => said.info.push(message),
        warn: (message: string) => said.warn.push(message),
      };
      try {
        (
          plugin.generateBundle as (
            this: unknown,
            options: unknown,
            bundle: unknown
          ) => void
        ).call(context, {}, {});
        (
          plugin.writeBundle as (this: unknown, output: { dir: string }) => void
        ).call(context, { dir: directory });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return said;
    };
    const none = run({}, { "app-abc.js": random(2000) });
    expect(none.info.join("\n")).toContain(
      "CALENDAR no calendar chunk in this build"
    );
    const small = run({}, { "calendar-Ab12_x.js": randomBytes(3000) });
    expect(small.error).toEqual([]);
    expect(small.info.join("\n")).toMatch(CALENDAR_LINE);
    const big = { "calendar-Ab12_x.js": randomBytes(27_000) };
    const warned = run({}, big);
    expect(warned.error).toEqual([]);
    expect(warned.warn).toEqual([
      expect.stringContaining("calendar chunk over its line"),
    ]);
    expect(run({ mode: "block" }, big).error).toEqual([
      expect.stringContaining("calendar chunk"),
    ]);
    const only = run({ only: "chunks" }, big);
    expect(only.error).toEqual([]);
    expect(only.warn).toEqual([expect.stringContaining("excess +")]);
    expect(only.info.join("\n")).toContain("over by");
    expect(run({ mode: "block", only: "chunks" }, big).error).toEqual([
      expect.stringContaining("calendar chunk"),
    ]);
    expect(
      run(
        { mode: "block", only: "chunks" },
        { "app-abc.js": randomBytes(1_200_000) }
      ).error
    ).toEqual([]);
  });
});

describe("the heat map line (ADR 0103, amendment of the map of the Início, t394)", () => {
  const random = (length: number) =>
    new Uint8Array(length).map((_, index) => (index * 7919) % 251);
  const asSize = (heatmap: number) => ({
    calendar: 0,
    charts: 0,
    fonts: 0,
    heatmap,
    interface: 0,
    motion: 0,
    primitives: 0,
    rest: 0,
  });

  it("counts the heat map chunk in a line of its own: not in the rest, the interface share nor the charts", () => {
    const files: Record<string, Uint8Array> = {
      "assets/heatmap-Ab12_x.js": random(10_000),
      "assets/index-abc.js": random(10_000),
    };
    const size = measurePrecache(
      Object.keys(files),
      (path) => files[path] as Uint8Array,
      { interface: new Map([["assets/heatmap-Ab12_x.js", 1]]) }
    );
    expect(size.heatmap).toBeGreaterThan(0);
    expect(size.charts).toBe(0);
    expect(size.interface).toBe(0);
    const without = measurePrecache(["assets/index-abc.js"], () =>
      random(10_000)
    );
    expect(size.rest).toBe(without.rest);
  });

  it('passes at 16 000 B gzip; one byte past it warns in "warn" and fails in "block"', () => {
    expect(HEATMAP_BUDGET_GZIP_BYTES).toBe(16_000);
    expect(chunkBudgetProblems(asSize(16_000), "block")).toEqual([]);
    expect(chunkBudgetProblems(asSize(16_001), "block")).toEqual([
      expect.stringContaining("heat map chunk: 16001 B gzip, over the 16000 B"),
    ]);
    expect(chunkBudgetProblems(asSize(16_001), "warn")).toEqual([]);
    expect(chunkBudgetWarnings(asSize(16_001), "warn")).toEqual([
      expect.stringContaining("excess +1 B"),
    ]);
  });

  it("prints the line the review greps for, or that the build has no chunk", () => {
    expect(heatmapLine(asSize(0))).toBe(
      "HEATMAP no heat map chunk in this build, 0 B of 16000 B gzip"
    );
    expect(heatmapLine(asSize(10_041))).toBe(
      "HEATMAP chunk 10041 B gzip of 16000 B (5959 B left)"
    );
    expect(heatmapLine(asSize(16_100))).toContain("over by 100 B");
  });

  it("the heat map chunk may import the motion chunk, as the charts do; a screen may not", () => {
    const chunks = [
      {
        fileName: "assets/index-a.js",
        imports: [],
        isEntry: true,
        modules: {},
      },
      {
        fileName: "assets/heatmap-b.js",
        imports: ["assets/motion-c.js", "assets/charts-d.js"],
        isDynamicEntry: true,
        modules: {},
      },
      { fileName: "assets/motion-c.js", imports: [], modules: {} },
      {
        fileName: "assets/charts-d.js",
        imports: ["assets/motion-c.js"],
        isDynamicEntry: true,
        modules: {},
      },
    ];
    expect(motionLoadProblems(chunks)).toEqual([]);
    expect(
      motionLoadProblems([
        ...chunks,
        {
          fileName: "assets/home-page-e.js",
          imports: ["assets/motion-c.js"],
          isDynamicEntry: true,
          modules: {},
        },
      ])
    ).toHaveLength(1);
  });
});
