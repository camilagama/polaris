import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { listFiles, precacheList } from "./service-worker-plugin";

/**
 * The bundle budget of the interface base (ADR 0103, decision 4 and section 4), in five lines, over what the
 * service worker precaches (the shell a user downloads):
 * - fonts: the woff2 bytes (already compressed; gzip does not shrink them), at most 55 KB;
 * - the JS of the Base UI primitives, gzipped, at most 95 KB, charged once, in the pull request that brings
 *   them to the production build (until then it is zero: no screen uses them);
 * - the rest (Tailwind, tokens, CSS, the screens' code, HTML, icons, manifest) plus the interface
 *   infrastructure (`src/ui/**`, `cn` and what only it brings), gzipped, over the precache before the base,
 *   the baseline of the same kind of build. While Phases 1 to 3 of the execution plan run, this line only
 *   warns, past 44 KB and past the second mark of 80 KB alike (see `BUDGET_MODE`). The build prints
 *   the interface infrastructure and the screen (the rest of the growth over the baseline) apart, so a review
 *   sees what a screen costs.
 * - the charts chunk (`charts-*.js`, t285, t336), gzipped, 8 KB as the reference of the line, which only warns (like the
 *   others, by the user's decision of 24/10/2026: the charts are Bklit UI as distributed and size is no criterion
 *   until the cut step), a line of its own: the drawing code of the charts, `motion`, `@visx/*` and d3. It is in the
 *   precache so a chart opens offline, loaded on demand by the screen that asks for it and never with the shell's
 *   first script; it counts here and in no other line, so the baseline of the rest does not move for it. A guard fails
 *   the build when a module of `src/ui/charts/` or `src/ui/bklit/`, or one of the libraries only they bring (`CHARTS_MODULE`) is in any other chunk (`chartsPlacementProblems`).
 * - the calendar chunk (`calendar-*.js`, t363, t369), gzipped, at most 26 KB, a line of its own, as the charts' is
 *   (Petković, PR 321, by the precedent of the charts): react-day-picker, date-fns and `calendar.tsx`, the month grid
 *   of the date pickers. It is in the precache so a picker shows its month offline (without it a shopkeeper with no
 *   connection would have only "Hoje"), loaded on demand by the first picker that opens and never with the shell's
 *   first script; it counts here and in no other line. The worker does not change: it precaches every file of the
 *   build, and no screen asks for a picker yet, so a production build has no such chunk until one does. A guard fails
 *   the build when a module of the calendar is in any other chunk (`calendarPlacementProblems`).
 * What going past a line does is one mode for the five of them, `BUDGET_MODE`: "warn" until the cut step, the build
 * prints the total, the line and the excess and passes; "block" fails the build. No technical limit stands behind any
 * of the numbers (the Cache API has no per-shell size cap; the browser's storage quota is orders of magnitude above
 * the shell), so they are marks. What fails the build in any mode is structure, not size: the placement guards of the
 * charts (`chartsPlacementProblems`) and of the calendar of the date pickers (`calendarPlacementProblems`, t363) and
 * the guard of the chunks that exist for the browser checks only (`testOnlyChunkProblems`).
 */
export const FONT_BUDGET_BYTES = 55_000;
export const PRIMITIVES_BUDGET_GZIP_BYTES = 95_000;
export const CHARTS_BUDGET_GZIP_BYTES = 8000;
/** The calendar chunk measured 22 645 B gzip at its first build (t369); a line like the charts', with some room. */
export const CALENDAR_BUDGET_GZIP_BYTES = 26_000;
export type BudgetMode = "warn" | "block";

/**
 * Reference ceiling of the rest line: 44 000 no lote 6 (23/10), medido na t256.
 * Batch 6 took the old CSS out (t256): the shell v5.1 is interface infrastructure paid once (it replaced the old
 * shell, about +5.1 KB gzip) and the offline runtime of F7 (connection with proof, about +4.0 KB gzip) came after
 * the 40 KB of ADR 0103, section 4. Taking `@layer legacy` out freed only about 1.3 KB gzip (the CSS went from
 * 17 305 to 16 139 B); the rest of the growth is JS of the screens. The Arrascaeta set 44 KB on 23/10.
 * Whether going past it fails the build is `BUDGET_MODE`.
 */
export const REST_GROWTH_BUDGET_GZIP_BYTES = 44_000;
/**
 * The second mark of the rest line (t272, t353): past it the build still passes in "warn", and the warning says so.
 * It was a cap that failed the build; the user's rule (24/10/2026) is that no byte ceiling fails the build until
 * the cut step, so it only keeps the measure in the log for that step.
 */
export const REST_GROWTH_MARK_GZIP_BYTES = 80_000;
/**
 * What going past any of the size lines does (the rest at +44 000 B and its +80 000 B mark, the fonts, the
 * primitives, the charts and the calendar). "warn" until the cut step before the go-live (Phase 5 of the execution plan), by
 * decision of the user on 23/10/2026 and 24/10/2026 (ADR 0103, amendments): the build prints the total, the line and
 * the excess and passes. The cut step takes `tailwind-merge` out (about -8 KB, measured in t266), trims the JS of the
 * screens and goes back to "block" with firm ceilings. A constant, not an environment variable: changing it is a
 * reviewed change, and out of the cut step it is a decision of the user.
 */
export const BUDGET_MODE: BudgetMode = "warn";

/**
 * The rest of the precache before the UI base, one number per kind of production build, since the switch of
 * the offline runtime (VITE_OFFLINE_RUNTIME_ENABLED) puts SQLite and the runtime in the shell: the e2e on the
 * real stack builds both. Main at 8c2ef58 (the PR 0 floor), a build without a Sentry DSN, gzip level 9 with
 * Node's zlib, the runtime of the build in CI (Bun's zlib gives about 1% more for the same files). How to
 * update them: ADR 0103, section 4.
 */
export const REST_BASELINE_GZIP_BYTES = {
  offlineRuntimeOff: 1_018_327,
  offlineRuntimeOn: 1_096_252,
} as const;

const FONT = /\.woff2?$/;
const NODE_MODULES_PREFIX = /^.*[\\/]node_modules[\\/]/;
/** The chunk the charts live in: the one the `import()` of `src/ui/charts/charts.ts` makes, named after that file. */
const CHARTS_CHUNK = /(^|\/)assets\/charts-[\w-]+\.js$/;
/**
 * What belongs to the charts chunk and to nothing else: the modules of `src/ui/charts/` (not `on-demand.tsx`, the
 * loader that every screen imports), the blocks of Bklit UI in `src/ui/bklit/` and the libraries only they bring.
 */
const CHARTS_MODULE =
  /(?:[\\/]apps[\\/]web[\\/]src[\\/]ui[\\/](?:charts[\\/](?!on-demand\.tsx$)[^\\/]+|bklit[\\/].+)\.tsx?$|[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@visx|d3-[a-z-]+|internmap|motion|framer-motion|motion-dom|motion-utils|classnames)[\\/])/;
/** The chunk of the date pickers' month grid: the one the `import()` of `src/ui/calendar.tsx` makes (t363). */
const CALENDAR_CHUNK = /(^|\/)assets\/calendar-[\w-]+\.js$/;
/**
 * What belongs to the calendar chunk and to nothing else: `src/ui/calendar.tsx` (not `calendar-on-demand.tsx`, the
 * loader the pickers import) and the libraries only it brings (react-day-picker, date-fns and @date-fns/tz).
 */
const CALENDAR_MODULE =
  /(?:[\\/]apps[\\/]web[\\/]src[\\/]ui[\\/]calendar\.tsx$|[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:react-day-picker|date-fns|@date-fns[\\/]tz)[\\/])/;
/**
 * The chunks that exist for the browser checks only (main.tsx opens them in the `pwa-e2e` build and in the
 * offline PoC): the gallery of the primitives and the lab of the screens (route `/offline-screens-lab`, which
 * the interface guardrails use to measure the sale screen). Never in the production shell.
 */
const TEST_ONLY_CHUNKS = [
  { name: "the UI gallery", pattern: /(^|\/)assets\/ui-gallery-[\w-]+\.js$/ },
  {
    name: "the screens lab",
    pattern: /(^|\/)assets\/screens-lab-[\w-]+\.js$/,
  },
] as const;
/**
 * The Sentry SDK chunk exists only in a build with a DSN (ADR 0098), about 35 KB gzip: it is not interface
 * and it is not in the baseline, which is a build without a DSN, so it stays out of the count.
 */
const OUTSIDE_THE_BUDGET = /(^|\/)assets\/sentry-sdk-[\w-]+\.js$/;
/**
 * The modules of the primitives: Base UI and what only it brings (Floating UI, reselect). Not
 * `use-sync-external-store`, which the router already brings, nor React.
 */
const PRIMITIVE_MODULE =
  /[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@base-ui|@floating-ui|reselect)[\\/]/;

/**
 * The interface infrastructure: the components of `src/ui/`, `cn` (`src/lib/utils.ts`) and the libraries only
 * they bring (tailwind-merge, class-variance-authority, clsx) and the icon library (lucide-react), whose icons
 * count here even when a screen imports them. Paid once, with the base; it counts in the +40 KB line, apart
 * from the screen's own code. Never a primitive module.
 */
const INTERFACE_MODULE =
  /(?:[\\/]apps[\\/]web[\\/]src[\\/](?:ui[\\/]|lib[\\/]utils\.ts$)|[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:tailwind-merge|class-variance-authority|clsx|lucide-react)[\\/])/;

export interface PrecacheSize {
  /** The calendar chunk (`CALENDAR_CHUNK`): a line of its own, apart from the rest. */
  calendar: number;
  /** The charts chunk (`CHARTS_CHUNK`): a line of its own, apart from the rest. */
  charts: number;
  fonts: number;
  /** The interface infrastructure (see `INTERFACE_MODULE`); counts in the +40 KB line with `rest`. */
  interface: number;
  primitives: number;
  rest: number;
}

/** The share of each chunk that is the code of one kind of module, by file name. */
export type ChunkShares = ReadonlyMap<string, number>;

/** The two kinds of module that are measured by a share of their chunk. */
export interface PrecacheShares {
  interface: ChunkShares;
  primitives: ChunkShares;
}

/** What a chunk is made of: the rendered length of each module, by module id. */
export interface ChunkModules {
  fileName: string;
  modules: Record<string, { renderedLength: number }>;
}

function sharesOf(
  chunks: readonly ChunkModules[],
  kind: RegExp
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const chunk of chunks) {
    let total = 0;
    let matching = 0;
    for (const [id, module] of Object.entries(chunk.modules)) {
      total += module.renderedLength;
      if (kind.test(id)) {
        matching += module.renderedLength;
      }
    }
    if (matching > 0 && total > 0) {
      shares.set(chunk.fileName, matching / total);
    }
  }
  return shares;
}

/**
 * The share of each chunk that is the primitives' code (rendered length of their modules over the chunk's),
 * only for the chunks that have some. The build does not change its chunks for the count: grouping Base UI
 * in a chunk of its own would drag shared modules along and change the graph of the shell.
 */
export function primitiveShares(
  chunks: readonly ChunkModules[]
): Map<string, number> {
  return sharesOf(chunks, PRIMITIVE_MODULE);
}

/** The same measure for the interface infrastructure (`INTERFACE_MODULE`). */
export function interfaceShares(
  chunks: readonly ChunkModules[]
): Map<string, number> {
  return sharesOf(chunks, INTERFACE_MODULE);
}

/**
 * Fonts in bytes, the primitives, the interface infrastructure and the rest in gzip bytes, for the files of
 * one precache (paths as in `sw.js`). A chunk with primitives or interface modules splits its gzip size by
 * their shares of it.
 */
export function measurePrecache(
  paths: readonly string[],
  readFile: (path: string) => Uint8Array,
  shares: Partial<PrecacheShares> = {}
): PrecacheSize {
  let calendar = 0;
  let charts = 0;
  let fonts = 0;
  let primitives = 0;
  let infrastructure = 0;
  let rest = 0;
  for (const path of paths.filter((item) => !OUTSIDE_THE_BUDGET.test(item))) {
    const bytes = readFile(path);
    if (FONT.test(path)) {
      fonts += bytes.byteLength;
      continue;
    }
    const gzip = gzipSync(bytes, { level: 9 }).byteLength;
    if (CHARTS_CHUNK.test(path)) {
      charts += gzip;
      continue;
    }
    if (CALENDAR_CHUNK.test(path)) {
      calendar += gzip;
      continue;
    }
    const ofPrimitives = Math.round(gzip * (shares.primitives?.get(path) ?? 0));
    const ofInterface = Math.round(gzip * (shares.interface?.get(path) ?? 0));
    primitives += ofPrimitives;
    infrastructure += ofInterface;
    rest += gzip - ofPrimitives - ofInterface;
  }
  return {
    calendar,
    charts,
    fonts,
    interface: infrastructure,
    primitives,
    rest,
  };
}

/**
 * One problem for each module of the charts that is in a chunk other than the charts chunk (the ids are those of the
 * modules of the bundle). A static import of a chart from a screen would put d3 in the shell's first script, outside
 * the 8 KB line that was set for the chunk and with no way to see it there.
 */
export function chartsPlacementProblems(
  chunks: readonly ChunkModules[]
): string[] {
  return chunks
    .filter((chunk) => !CHARTS_CHUNK.test(chunk.fileName))
    .flatMap((chunk) =>
      Object.keys(chunk.modules)
        .filter((id) => CHARTS_MODULE.test(id))
        .map(
          (id) =>
            `chart module ${id.replace(NODE_MODULES_PREFIX, "")} is in ${chunk.fileName}, outside the charts chunk`
        )
    );
}

/**
 * The same guard for the calendar of the date pickers (t363): react-day-picker and date-fns load on demand, when a
 * picker opens, never with the shell's first script. Its size has a line of its own (`CALENDAR_BUDGET_GZIP_BYTES`; the
 * chunk is precached so a picker opens offline); here only its place is checked.
 */
export function calendarPlacementProblems(
  chunks: readonly ChunkModules[]
): string[] {
  return chunks
    .filter((chunk) => !CALENDAR_CHUNK.test(chunk.fileName))
    .flatMap((chunk) =>
      Object.keys(chunk.modules)
        .filter((id) => CALENDAR_MODULE.test(id))
        .map(
          (id) =>
            `calendar module ${id.replace(NODE_MODULES_PREFIX, "")} is in ${chunk.fileName}, outside the calendar chunk`
        )
    );
}

/** The line the build prints for the charts chunk: how much of the budget it uses, or that this build has none. */
export function chartsLine(size: PrecacheSize): string {
  if (size.charts === 0) {
    return `CHARTS no charts chunk in this build (no screen asks for a chart yet), 0 B of ${CHARTS_BUDGET_GZIP_BYTES} B gzip`;
  }
  const left = CHARTS_BUDGET_GZIP_BYTES - size.charts;
  return `CHARTS chunk ${size.charts} B gzip of ${CHARTS_BUDGET_GZIP_BYTES} B (${left >= 0 ? `${left} B left` : `over by ${-left} B`})`;
}

/** The line the build prints for the calendar chunk: how much of its budget it uses, or that this build has none. */
export function calendarLine(size: PrecacheSize): string {
  if (size.calendar === 0) {
    return `CALENDAR no calendar chunk in this build (no screen asks for a picker yet), 0 B of ${CALENDAR_BUDGET_GZIP_BYTES} B gzip`;
  }
  const left = CALENDAR_BUDGET_GZIP_BYTES - size.calendar;
  return `CALENDAR chunk ${size.calendar} B gzip of ${CALENDAR_BUDGET_GZIP_BYTES} B (${left >= 0 ? `${left} B left` : `over by ${-left} B`})`;
}

export function restBaseline(offlineRuntime: boolean): number {
  return offlineRuntime
    ? REST_BASELINE_GZIP_BYTES.offlineRuntimeOn
    : REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
}

/** One problem for each chunk of the browser checks that reached the production build (paths as in `sw.js`). */
export function testOnlyChunkProblems(paths: readonly string[]): string[] {
  return TEST_ONLY_CHUNKS.flatMap(({ name, pattern }) => {
    const found = paths.filter((path) => pattern.test(path));
    return found.length > 0
      ? [`${name} is in the production build (${found.join(", ")})`]
      : [];
  });
}

function restLine(size: PrecacheSize): number {
  return size.rest + size.interface;
}

/** The growth of the rest line over the baseline, in gzip bytes. */
function restGrowth(size: PrecacheSize, baseline: number): number {
  return restLine(size) - baseline;
}

function restDescription(size: PrecacheSize, baseline: number): string {
  return `rest: ${restLine(size)} B gzip (interface infrastructure ${size.interface} B), +${restGrowth(size, baseline)} B over the baseline of ${baseline} B`;
}

/** A size line past its number: what the build says about it, as a problem in "block" and as a warning in "warn". */
interface LineExcess {
  excess: number;
  name: string;
  total: number;
  unit: number;
}

/** The fonts, primitives, charts and calendar lines past their numbers (the rest line has its own text and its mark). */
function lineExcesses(size: PrecacheSize): LineExcess[] {
  const lines = [
    { name: "fonts", total: size.fonts, unit: FONT_BUDGET_BYTES },
    {
      name: "Base UI primitives",
      total: size.primitives,
      unit: PRIMITIVES_BUDGET_GZIP_BYTES,
    },
    {
      name: "charts chunk",
      total: size.charts,
      unit: CHARTS_BUDGET_GZIP_BYTES,
    },
    {
      name: "calendar chunk",
      total: size.calendar,
      unit: CALENDAR_BUDGET_GZIP_BYTES,
    },
  ];
  return lines
    .filter((line) => line.total > line.unit)
    .map((line) => ({ ...line, excess: line.total - line.unit }));
}

function lineProblem(line: LineExcess, gzip: boolean): string {
  return `${line.name}: ${line.total} B${gzip ? " gzip" : ""}, over the ${line.unit} B budget`;
}

/** Whether a line is measured in gzip bytes (the fonts are raw woff2 bytes). */
const isGzipLine = (line: LineExcess) => line.name !== "fonts";

function lineWarning(line: LineExcess): string {
  return `${line.name} over its line (warning only until the cut step, ADR 0103, amendment of 25/10/2026): total ${line.total} B${isGzipLine(line) ? " gzip" : ""}, line ${line.unit} B, excess +${line.excess} B`;
}

/**
 * What fails the build for size: nothing in "warn"; in "block", every line past its number, the rest line from
 * +44 000 B on (so past the +80 000 B mark too).
 */
export function budgetProblems(
  size: PrecacheSize,
  baseline: number,
  mode: BudgetMode = BUDGET_MODE
): string[] {
  if (mode !== "block") {
    return [];
  }
  const problems = lineExcesses(size).map((line) =>
    lineProblem(line, isGzipLine(line))
  );
  const growth = restGrowth(size, baseline);
  if (growth > REST_GROWTH_BUDGET_GZIP_BYTES) {
    problems.push(
      `${restDescription(size, baseline)}, past the +${REST_GROWTH_BUDGET_GZIP_BYTES} B budget`
    );
  }
  return problems;
}

/**
 * What the build says without failing: each of the size lines past its number while the mode is "warn", with the
 * total, the number and the excess, and the rest line past the 80 KB mark as well when it goes that far.
 */
export function budgetWarnings(
  size: PrecacheSize,
  baseline: number,
  mode: BudgetMode = BUDGET_MODE
): string[] {
  if (mode !== "warn") {
    return [];
  }
  const warnings = lineExcesses(size).map(lineWarning);
  const growth = restGrowth(size, baseline);
  if (growth > REST_GROWTH_BUDGET_GZIP_BYTES) {
    const pastMark =
      growth > REST_GROWTH_MARK_GZIP_BYTES
        ? `, past the +${REST_GROWTH_MARK_GZIP_BYTES} B mark by ${growth - REST_GROWTH_MARK_GZIP_BYTES} B`
        : "";
    warnings.push(
      `precache over the reference ceiling (warning only until the cut step, ADR 0103, amendments of 23/10/2026, 24/10/2026 and 25/10/2026): total ${restLine(size)} B gzip, growth +${growth} B, reference +${REST_GROWTH_BUDGET_GZIP_BYTES} B, excess +${growth - REST_GROWTH_BUDGET_GZIP_BYTES} B${pastMark}`
    );
  }
  return warnings;
}

/** The lines of the chunks that load on demand (charts and calendar), for the build of the browser checks. */
const CHUNK_LINES = ["charts chunk", "calendar chunk"];

/** The chunk lines alone, for the build of the browser checks: a problem in "block", nothing in "warn". */
export function chunkBudgetProblems(
  size: PrecacheSize,
  mode: BudgetMode = BUDGET_MODE
): string[] {
  return mode === "block"
    ? lineExcesses(size)
        .filter((line) => CHUNK_LINES.includes(line.name))
        .map((line) => lineProblem(line, true))
    : [];
}

/** The chunk lines alone, as a warning in "warn". */
export function chunkBudgetWarnings(
  size: PrecacheSize,
  mode: BudgetMode = BUDGET_MODE
): string[] {
  return mode === "warn"
    ? lineExcesses(size)
        .filter((line) => CHUNK_LINES.includes(line.name))
        .map(lineWarning)
    : [];
}

/** The line a review greps for in the CI log: how much the precache has and how much it grew. */
function growthLine(size: PrecacheSize, baseline: number): string {
  const growth = restGrowth(size, baseline);
  return `PRECACHE-GROWTH total ${restLine(size)} B gzip, growth ${growth >= 0 ? "+" : ""}${growth} B over the baseline of ${baseline} B (reference +${REST_GROWTH_BUDGET_GZIP_BYTES} B, ${growth > REST_GROWTH_BUDGET_GZIP_BYTES ? `over by ${growth - REST_GROWTH_BUDGET_GZIP_BYTES} B` : `${REST_GROWTH_BUDGET_GZIP_BYTES - growth} B left`}; mark +${REST_GROWTH_MARK_GZIP_BYTES} B)`;
}

/**
 * Fails the production build of the shell for structure (the placement of the charts and of the calendar, the chunks of the browser
 * checks) and, with `BUDGET_MODE` in "block", when the precache goes past the budget; in "warn" the size lines only
 * warn. With `only: "chunks"` it checks the charts and calendar lines and the placement guards and nothing else:
 * the build of the browser checks (`vite.pwa.config.ts`), which has the gallery and so the chunks that the production
 * build has no screen to ask for yet. `mode` is for the tests of the "block" side; the builds use `BUDGET_MODE`.
 */
export function precacheBudgetPlugin(
  options: { mode?: BudgetMode; only?: "chunks" } = {}
): Plugin {
  const mode = options.mode ?? BUDGET_MODE;
  let offlineRuntime = false;
  let shares: PrecacheShares = {
    interface: new Map(),
    primitives: new Map(),
  };
  let placement: string[] = [];
  return {
    apply: "build",
    configResolved(config) {
      // the same value the app reads (src/offline/runtime/enabled.ts)
      offlineRuntime = config.env.VITE_OFFLINE_RUNTIME_ENABLED === "true";
    },
    generateBundle(_options, bundle) {
      if (this.environment && this.environment.name !== "client") {
        return;
      }
      const chunks = Object.values(bundle).flatMap((item) =>
        item.type === "chunk"
          ? [{ fileName: item.fileName, modules: item.modules }]
          : []
      );
      shares = {
        interface: interfaceShares(chunks),
        primitives: primitiveShares(chunks),
      };
      placement = [
        ...chartsPlacementProblems(chunks),
        ...calendarPlacementProblems(chunks),
      ];
    },
    name: "polaris:precache-budget",
    writeBundle(output) {
      if (this.environment && this.environment.name !== "client") {
        return;
      }
      const directory = output.dir;
      if (!directory) {
        return;
      }
      // "/" is index.html: the shell itself.
      const paths = precacheList({ files: listFiles(directory) }).map((path) =>
        path === "/" ? "index.html" : path.slice(1)
      );
      const size = measurePrecache(
        paths,
        (path) => readFileSync(join(directory, path)),
        shares
      );
      if (options.only === "chunks") {
        this.info(chartsLine(size));
        this.info(calendarLine(size));
        for (const warning of chunkBudgetWarnings(size, mode)) {
          this.warn(warning);
        }
        const chunkProblems = [
          ...placement,
          ...chunkBudgetProblems(size, mode),
        ];
        if (chunkProblems.length > 0) {
          this.error(
            `Chunks check of the browser-check build failed (ADR 0103): ${chunkProblems.join("; ")}`
          );
        }
        return;
      }
      const baseline = restBaseline(offlineRuntime);
      const problems = [...budgetProblems(size, baseline, mode), ...placement];
      // The gallery and the screens lab are for the browser checks only (main.tsx): never in the shell.
      problems.push(...testOnlyChunkProblems(paths));
      // The screen is the rest of the growth over the baseline once the interface infrastructure is taken out.
      const growth = size.rest + size.interface - baseline;
      const screen = size.rest - baseline;
      const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
      this.info(
        `precache (offline runtime ${offlineRuntime ? "on" : "off"}, baseline ${baseline} B): fonts ${size.fonts} B, Base UI primitives ${size.primitives} B gzip, interface infrastructure ${size.interface} B gzip, screen and the rest ${size.rest} B gzip (${signed(screen)} B over the baseline); rest line ${size.rest + size.interface} B gzip (${signed(growth)} B)`
      );
      this.info(growthLine(size, baseline));
      this.info(chartsLine(size));
      this.info(calendarLine(size));
      for (const warning of budgetWarnings(size, baseline, mode)) {
        this.warn(warning);
      }
      if (problems.length > 0) {
        this.error(
          `Precache check of the shell failed (ADR 0103): ${problems.join("; ")}`
        );
      }
    },
  };
}
