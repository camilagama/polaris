import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import {
  listFiles,
  ONLINE_ONLY_CHUNK,
  precacheList,
} from "./service-worker-plugin";

/**
 * The bundle budget of the interface base (ADR 0103, decision 4 and section 4), in six lines, over what the
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
 * - the charts chunk (`charts-*.js`), gzipped, 8 KB as the reference of the line, which only warns (like the
 *   others, by the user's decision: the charts are Bklit UI as distributed and size is no criterion
 *   until the cut step), a line of its own: the drawing code of the charts, `@visx/*` and d3. It is in the precache so
 *   a chart opens offline, loaded on demand by the screen that asks for it and never with the shell's first script; it
 *   counts here and in no other line, so the baseline of the rest does not move for it. A guard fails the build when a
 *   module of `src/ui/charts/` or `src/ui/bklit/`, or one of the libraries only they bring (`CHARTS_MODULE`) is in any
 *   other chunk (`chartsPlacementProblems`).
 * - the motion chunk (`motion-*.js`), gzipped, 56 KB as the reference of the line, which only warns, a line
 *   of its own, as the calendar's is: `motion` and what only it brings, which the charts and the filter bar share, each
 *   loaded on demand. It is in the precache so a chart or the bar animates offline, and it counts here and in no other
 *   line. Two guards fail the build: `motion` in a chunk that is neither the charts chunk nor the motion chunk
 *   (`chartsPlacementProblems`), and the motion chunk reachable by static imports from the entry, which would put it in
 *   the shell's first load, or from a screen, which would load it on a phone (`motionLoadProblems`); only
 *   the `import()` of the charts or of the bar's motion layer (at the `full` level of motion) may load it. A phone still
 *   downloads it with the precache (the charts need it offline), but does not run it outside a chart.
 * - the calendar chunk (`calendar-*.js`), gzipped, at most 26 KB, a line of its own, as the charts' is
 *   (by the precedent of the charts): react-day-picker, date-fns and `calendar.tsx`, the month grid
 *   of the date pickers. It is in the precache so a picker shows its month offline (without it a shopkeeper with no
 *   connection would have only "Hoje"), loaded on demand by the first picker that opens and never with the shell's
 *   first script; it counts here and in no other line. The worker does not change: it precaches every file of the
 *   build, and no screen asks for a picker yet, so a production build has no such chunk until one does. A guard fails
 *   the build when a module of the calendar is in any other chunk (`calendarPlacementProblems`).
 * - the heat map chunk (`heatmap-*.js`), gzipped, 16 KB as the reference of the line (the estimate of the v7
 *   review was 12 to 16 KB), which only warns, a line of its own, as the calendar's is: the map of the Início (Bklit
 *   UI's `HeatmapChart`, its cells and patterns, `@visx/heatmap`) and the bars of the mean by weekday, loaded on demand
 *   by the Início. What it shares with the charts (the sparkline, d3, `@visx/group`) stays in the charts chunk (the
 *   group `charts` of the Vite configs, `SHARED_CHART_MODULE`), and `motion` in its own. A guard fails the build when
 *   a module of the map is in any other chunk, as for the charts (`chartsPlacementProblems`).
 * What going past a line does is one mode for the six of them, `BUDGET_MODE`: "warn" until the cut step, the build
 * prints the total, the line and the excess and passes; "block" fails the build. No technical limit stands behind any
 * of the numbers (the Cache API has no per-shell size cap; the browser's storage quota is orders of magnitude above
 * the shell), so they are marks. What fails the build in any mode is structure, not size: the placement guards of the
 * charts (`chartsPlacementProblems`) and of the calendar of the date pickers (`calendarPlacementProblems`), the
 * guard of who loads `motion` (`motionLoadProblems`) and the guard of the chunks that exist for the browser checks only (`testOnlyChunkProblems`).
 */
export const FONT_BUDGET_BYTES = 55_000;
export const PRIMITIVES_BUDGET_GZIP_BYTES = 95_000;
export const CHARTS_BUDGET_GZIP_BYTES = 8000;
/** The calendar chunk measured 22 645 B gzip at its first build; a line like the charts', with some room. */
export const CALENDAR_BUDGET_GZIP_BYTES = 26_000;
/** The motion chunk measures about 49.5 KB gzip (without the React that its first build had put in it); a line like the calendar's, with some room. */
export const MOTION_BUDGET_GZIP_BYTES = 56_000;
/** The heat map chunk: the estimate of the v7 review, 12 to 16 KB gzip; a reference that only warns. */
export const HEATMAP_BUDGET_GZIP_BYTES = 16_000;
export type BudgetMode = "warn" | "block";

/**
 * Reference ceiling of the rest line: 44 000 after batch 6.
 * Batch 6 took the old CSS out: the shell v5.1 is interface infrastructure paid once (it replaced the old
 * shell, about +5.1 KB gzip) and the offline runtime of F7 (connection with proof, about +4.0 KB gzip) came after
 * the 40 KB of ADR 0103, section 4. Taking `@layer legacy` out freed only about 1.3 KB gzip (the CSS went from
 * 17 305 to 16 139 B); the rest of the growth is JS of the screens.
 * Whether going past it fails the build is `BUDGET_MODE`.
 */
export const REST_GROWTH_BUDGET_GZIP_BYTES = 44_000;
/**
 * The second mark of the rest line: past it the build still passes in "warn", and the warning says so.
 * It was a cap that failed the build; the user's rule is that no byte ceiling fails the build until
 * the cut step, so it only keeps the measure in the log for that step.
 */
export const REST_GROWTH_MARK_GZIP_BYTES = 80_000;
/**
 * What going past any of the size lines does (the rest at +44 000 B and its +80 000 B mark, the fonts, the
 * primitives, the charts, the motion chunk and the calendar). "warn" until the cut step before the go-live (Phase 5 of the execution plan), by
 * decision of the user (ADR 0103, amendments): the build prints the total, the line and
 * the excess and passes. The cut step takes `tailwind-merge` out (about -8 KB), trims the JS of the
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
/** The path of a module of the app up to `apps/web/`, for the messages. */
const PROJECT_PREFIX = /^.*[\\/]apps[\\/]web[\\/]/;
/** The chunk the charts live in: the one the `import()` of `src/ui/charts/charts.ts` makes, named after that file. */
const CHARTS_CHUNK = /(^|\/)assets\/charts-[\w-]+\.js$/;
/** The chunk `motion` lives in, shared by the charts and the filter bar: the one the group named `motion` of the Vite configs makes; a line of its own. */
const MOTION_CHUNK = /(^|\/)assets\/motion-[\w-]+\.js$/;
/**
 * The two chunks that may import the motion chunk statically: the charts and the animated layer of the filter
 * bar (`src/ui/filter-bar-motion.tsx`, loaded only at the `full` level of motion). Each comes by an `import()` of its own.
 */
const MOTION_LOADER_CHUNK =
  /(^|\/)assets\/(?:charts|filter-bar-motion|heatmap)-[\w-]+\.js$/;
/** The chunk of the map of the Início: the one the `import()` of `src/ui/charts/heatmap.ts` makes. */
const HEATMAP_CHUNK = /(^|\/)assets\/heatmap-[\w-]+\.js$/;
/**
 * What belongs to the heat map chunk and to nothing else: its entry and the two components of `src/ui/charts/`, the
 * heat map blocks of Bklit UI with the patterns only they use, and `@visx/heatmap`.
 */
export const HEATMAP_MODULE =
  /(?:[\\/]apps[\\/]web[\\/]src[\\/]ui[\\/](?:charts[\\/](?:heatmap|sales-heatmap|weekday-bars)|bklit[\\/]charts[\\/](?:heatmap[\\/][^\\/]+|patterns[\\/][^\\/]+|pattern-preset|visx-pattern|chart-scale))\.tsx?$|[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?@visx[\\/]heatmap[\\/])/;
/**
 * What belongs to the charts chunk and to nothing else: the modules of `src/ui/charts/` (not `on-demand.tsx`, the
 * loader that every screen imports), the blocks of Bklit UI in `src/ui/bklit/` and the libraries only they bring.
 */
const CHARTS_MODULE =
  /(?:[\\/]apps[\\/]web[\\/]src[\\/]ui[\\/](?:charts[\\/](?!on-demand\.tsx$)[^\\/]+|bklit[\\/].+)\.tsx?$|[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@visx|d3-[a-z-]+|internmap|classnames)[\\/])/;
/**
 * The animation library and what only it brings (`motion`, `framer-motion`, `motion-dom`, `motion-utils`). The charts draw
 * with it and so does the filter bar (`src/ui/filter-bar.tsx`), so it cannot sit in the charts chunk alone: it has
 * a chunk of its own, `motion-*.js`, which the charts chunk and the filter bar import. It belongs to that chunk or to the
 * charts chunk and to no other, so it never comes with the shell's first script.
 */
/** A module of the charts that is not the map's: the charts chunk keeps it, even when the map imports it too. */
export function isSharedChartModule(id: string): boolean {
  return CHARTS_MODULE.test(id) && !HEATMAP_MODULE.test(id);
}
export const MOTION_MODULE =
  /[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:motion|framer-motion|motion-dom|motion-utils)[\\/]/;
/** The chunk of the date pickers' month grid: the one the `import()` of `src/ui/calendar.tsx` makes. */
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
  /** The heat map chunk (`HEATMAP_CHUNK`): a line of its own, apart from the charts and the rest. */
  heatmap: number;
  /** The interface infrastructure (see `INTERFACE_MODULE`); counts in the +40 KB line with `rest`. */
  interface: number;
  /** The motion chunk (`MOTION_CHUNK`): a line of its own, apart from the charts and the rest. */
  motion: number;
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
  /** The chunks this one imports statically (`import ... from`), by file name; a dynamic `import()` is not here. */
  imports?: readonly string[];
  /** Whether the chunk is an entry of the build (the shell's first script). */
  isEntry?: boolean;
  /** Whether the chunk is loaded by an `import()` (a screen of `lazyScreen`, the gallery, the charts, a picker). */
  isDynamicEntry?: boolean;
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
  let heatmap = 0;
  let motion = 0;
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
    if (MOTION_CHUNK.test(path)) {
      motion += gzip;
      continue;
    }
    if (HEATMAP_CHUNK.test(path)) {
      heatmap += gzip;
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
    heatmap,
    interface: infrastructure,
    motion,
    primitives,
    rest,
  };
}

/**
 * One problem for each module of the charts that is in a chunk other than the charts chunk, and for each module of
 * `motion` that is in a chunk other than the charts chunk or the motion chunk (the ids are those of the modules of the
 * bundle). A static import of a chart from a screen would put d3 in the shell's first script, outside the 8 KB line that
 * was set for the chunk and with no way to see it there; the same for `motion`, which only the charts and the filter
 * bar use, each loaded on demand.
 */
export function chartsPlacementProblems(
  chunks: readonly ChunkModules[]
): string[] {
  return chunks.flatMap((chunk) => {
    const inCharts = CHARTS_CHUNK.test(chunk.fileName);
    const inMotion = MOTION_CHUNK.test(chunk.fileName);
    const inHeatmap = HEATMAP_CHUNK.test(chunk.fileName);
    return Object.keys(chunk.modules).flatMap((id) => {
      const name = id.replace(NODE_MODULES_PREFIX, "");
      if (HEATMAP_MODULE.test(id)) {
        return inHeatmap
          ? []
          : [
              `heat map module ${name} is in ${chunk.fileName}, outside the heat map chunk`,
            ];
      }
      if (!inCharts && CHARTS_MODULE.test(id)) {
        return [
          `chart module ${name} is in ${chunk.fileName}, outside the charts chunk`,
        ];
      }
      if (!(inCharts || inMotion) && MOTION_MODULE.test(id)) {
        return [
          `motion module ${name} is in ${chunk.fileName}, outside the charts and motion chunks`,
        ];
      }
      return [];
    });
  });
}

/** A chunk loaded by `import()` that is neither the charts nor the bar's motion layer: a screen, the gallery, a picker. */
const isLazyNonLoader = (chunk: ChunkModules) =>
  chunk.isDynamicEntry === true && !MOTION_LOADER_CHUNK.test(chunk.fileName);

/**
 * One problem when the motion chunk can be reached by static imports from an entry of the build or from a chunk
 * loaded by `import()` other than the charts and the animated layer of the filter bar: a screen of `lazyScreen`,
 * the gallery, a picker. The chunk is made to load on demand, with a chart or with the bar at the `full` level of motion,
 * and a static import on the way from the entry would make it part of the shell's first load, as one from a screen
 * would load it on a phone that opens the screen. Only the `import()` of the charts or of the layer may load it, and an
 * `import()` is not an edge of this graph. The problem names the path, from where it starts to the chunk.
 */
export function motionLoadProblems(chunks: readonly ChunkModules[]): string[] {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const queue = chunks
    .filter((chunk) => chunk.isEntry || isLazyNonLoader(chunk))
    .map((chunk) => chunk.fileName);
  const via = new Map<string, string | null>(queue.map((name) => [name, null]));
  // a graph with a motion chunk and no entry would pass for lack of a starting point: that is a fault of the proof, not a pass
  if (
    queue.length === 0 &&
    chunks.some((chunk) => MOTION_CHUNK.test(chunk.fileName))
  ) {
    return [
      "the motion chunk is in the bundle but no chunk is an entry (`isEntry`), so who loads it cannot be checked",
    ];
  }
  const problems: string[] = [];
  // the queue grows while it is read: a `for...of` over an array visits what is pushed to it meanwhile
  for (const name of queue) {
    for (const imported of byName.get(name)?.imports ?? []) {
      if (via.has(imported)) {
        continue;
      }
      via.set(imported, name);
      queue.push(imported);
      if (MOTION_CHUNK.test(imported)) {
        const path = [imported];
        for (let from = name; from; ) {
          path.unshift(from);
          from = via.get(from) ?? "";
        }
        problems.push(
          `the motion chunk is reachable by static imports (${path.join(" -> ")}); only the import() of the charts or of the filter bar's motion layer may load it`
        );
      }
    }
  }
  return problems;
}

/**
 * The same guard for the calendar of the date pickers: react-day-picker and date-fns load on demand, when a
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

/**
 * What belongs to the chunk of the import of a spreadsheet and to nothing else (corte 2.5, AC-11): the screen of the
 * import (`src/catalog/product-import/`) and the reading, the sending and the CSV of the import
 * (`src/catalog/product-import-*.ts` and `.tsx`), in any folder under it, with or without a query of the bundler. The CSV
 * writer of the domain is shared with the server's data export only.
 */
const ONLINE_ONLY_MODULE =
  /[\\/]apps[\\/]web[\\/]src[\\/]catalog[\\/]product-import(?:[\\/].+|-[\w-]+\.tsx?)(?:\?.*)?$/;

/**
 * The guard of the chunk kept out of the precache (`ONLINE_ONLY_CHUNK`): a module of the import in a precached chunk
 * would cost the shell its bytes, and a chunk that imports the import's chunk statically would load, offline, a file
 * the worker never kept (the shell would break with no connection). Only an `import()` may load it.
 */
export function onlineOnlyPlacementProblems(
  chunks: readonly ChunkModules[]
): string[] {
  const outside = chunks
    .filter((chunk) => !ONLINE_ONLY_CHUNK.test(chunk.fileName))
    .flatMap((chunk) => {
      const misplaced = Object.keys(chunk.modules)
        .filter((id) => ONLINE_ONLY_MODULE.test(id))
        .map(
          (id) =>
            `module of the import ${id.replace(PROJECT_PREFIX, "")} is in ${chunk.fileName}, a precached chunk`
        );
      const importing = (chunk.imports ?? [])
        .filter((name) => ONLINE_ONLY_CHUNK.test(name))
        .map(
          (name) =>
            `${chunk.fileName} imports ${name} statically: the chunk out of the precache loads only by import()`
        );
      return [...misplaced, ...importing];
    });
  return outside;
}

/** The line the build prints for the chunk out of the precache: its size, which no line of the budget counts. */
export function onlineOnlyLine(gzipBytes: number): string {
  return gzipBytes === 0
    ? "PRODUCT-IMPORT no import chunk in this build"
    : `PRODUCT-IMPORT chunk ${gzipBytes} B gzip, out of the precache (loaded online, when the import opens)`;
}

/** The line the build prints for the charts chunk: how much of the budget it uses, or that this build has none. */
export function chartsLine(size: PrecacheSize): string {
  if (size.charts === 0) {
    return `CHARTS no charts chunk in this build (no screen asks for a chart yet), 0 B of ${CHARTS_BUDGET_GZIP_BYTES} B gzip`;
  }
  const left = CHARTS_BUDGET_GZIP_BYTES - size.charts;
  return `CHARTS chunk ${size.charts} B gzip of ${CHARTS_BUDGET_GZIP_BYTES} B (${left >= 0 ? `${left} B left` : `over by ${-left} B`})`;
}

/** The line the build prints for the motion chunk: how much of its budget it uses, or that this build has none. */
export function motionLine(size: PrecacheSize): string {
  if (size.motion === 0) {
    return `MOTION no motion chunk in this build, 0 B of ${MOTION_BUDGET_GZIP_BYTES} B gzip`;
  }
  const left = MOTION_BUDGET_GZIP_BYTES - size.motion;
  return `MOTION chunk ${size.motion} B gzip of ${MOTION_BUDGET_GZIP_BYTES} B (${left >= 0 ? `${left} B left` : `over by ${-left} B`})`;
}

/** The line the build prints for the heat map chunk: how much of its line it uses, or that this build has none. */
export function heatmapLine(size: PrecacheSize): string {
  if (size.heatmap === 0) {
    return `HEATMAP no heat map chunk in this build, 0 B of ${HEATMAP_BUDGET_GZIP_BYTES} B gzip`;
  }
  const left = HEATMAP_BUDGET_GZIP_BYTES - size.heatmap;
  return `HEATMAP chunk ${size.heatmap} B gzip of ${HEATMAP_BUDGET_GZIP_BYTES} B (${left >= 0 ? `${left} B left` : `over by ${-left} B`})`;
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

/** The fonts, primitives, charts, motion and calendar lines past their numbers (the rest line has its own text and its mark). */
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
      name: "motion chunk",
      total: size.motion,
      unit: MOTION_BUDGET_GZIP_BYTES,
    },
    {
      name: "calendar chunk",
      total: size.calendar,
      unit: CALENDAR_BUDGET_GZIP_BYTES,
    },
    {
      name: "heat map chunk",
      total: size.heatmap,
      unit: HEATMAP_BUDGET_GZIP_BYTES,
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

/** The lines of the chunks that load on demand (charts, motion and calendar), for the build of the browser checks. */
const CHUNK_LINES = [
  "charts chunk",
  "motion chunk",
  "calendar chunk",
  "heat map chunk",
];

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
 * Fails the production build of the shell for structure (the placement of the charts and of the calendar, who loads `motion`, the chunks of the browser
 * checks) and, with `BUDGET_MODE` in "block", when the precache goes past the budget; in "warn" the size lines only
 * warn. With `only: "chunks"` it checks the charts, motion and calendar lines and the placement guards and nothing else:
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
          ? [
              {
                fileName: item.fileName,
                imports: item.imports,
                isDynamicEntry: item.isDynamicEntry,
                isEntry: item.isEntry,
                modules: item.modules,
              },
            ]
          : []
      );
      shares = {
        interface: interfaceShares(chunks),
        primitives: primitiveShares(chunks),
      };
      placement = [
        ...chartsPlacementProblems(chunks),
        ...motionLoadProblems(chunks),
        ...calendarPlacementProblems(chunks),
        ...onlineOnlyPlacementProblems(chunks),
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
      const onlineOnly = listFiles(directory)
        .filter((file) => ONLINE_ONLY_CHUNK.test(file))
        .reduce(
          (total, file) =>
            total +
            gzipSync(readFileSync(join(directory, file)), { level: 9 })
              .byteLength,
          0
        );
      if (options.only === "chunks") {
        this.info(chartsLine(size));
        this.info(motionLine(size));
        this.info(calendarLine(size));
        this.info(heatmapLine(size));
        this.info(onlineOnlyLine(onlineOnly));
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
      this.info(motionLine(size));
      this.info(calendarLine(size));
      this.info(heatmapLine(size));
      this.info(onlineOnlyLine(onlineOnly));
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
