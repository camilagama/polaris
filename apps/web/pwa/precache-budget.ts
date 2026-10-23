import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { listFiles, precacheList } from "./service-worker-plugin";

/**
 * The bundle budget of the interface base (ADR 0103, decision 4 and section 4), in three lines, over what the
 * service worker precaches (the shell a user downloads):
 * - fonts: the woff2 bytes (already compressed; gzip does not shrink them), at most 55 KB;
 * - the JS of the Base UI primitives, gzipped, at most 95 KB, charged once, in the pull request that brings
 *   them to the production build (until then it is zero: no screen uses them);
 * - the rest (Tailwind, tokens, CSS, the screens' code, HTML, icons, manifest) plus the interface
 *   infrastructure (`src/ui/**`, `cn` and what only it brings), gzipped, at most 40 KB (44.5 KB for now, see
 *   below) over the precache before the base, the baseline of the same kind of build. The build prints the interface infrastructure
 *   and the screen (the rest of the growth over the baseline) apart, so a review sees what a screen costs.
 * The production build fails past any line. Going past needs a reason in the pull request and the approval of
 * the Arrascaeta; raising a ceiling without that is not allowed.
 */
export const FONT_BUDGET_BYTES = 55_000;
export const PRIMITIVES_BUDGET_GZIP_BYTES = 95_000;
/**
 * 44 000 no lote 6 (23/10); cortar JS das telas para voltar a 42 000 é trabalho separado.
 * Batch 6 took the old CSS out (t256): the shell v5.1 is interface infrastructure paid once (it replaced the old
 * shell, about +5.1 KB gzip) and the offline runtime of F7 (connection with proof, about +4.0 KB gzip) came after
 * the 40 KB of ADR 0103, section 4. Taking `@layer legacy` out freed only about 1.3 KB gzip (the CSS went from
 * 17 305 to 16 139 B); the rest of the growth is JS of the screens. The Arrascaeta set 44 KB on 23/10, with the
 * measure of the batch in its pull request.
 * 44 500: aprovado pelo Arrascaeta em 23/10/2026 (t275, bump do zod GHSA-mrhx-c7xc-m3w5); o zod novo soma cerca de
 * 194 B gzip (checagem de limites de array, set e map).
 */
export const REST_GROWTH_BUDGET_GZIP_BYTES = 44_500;

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
    const ofPrimitives = Math.round(gzip * (shares.primitives?.get(path) ?? 0));
    const ofInterface = Math.round(gzip * (shares.interface?.get(path) ?? 0));
    primitives += ofPrimitives;
    infrastructure += ofInterface;
    rest += gzip - ofPrimitives - ofInterface;
  }
  return { fonts, interface: infrastructure, primitives, rest };
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

export function budgetProblems(size: PrecacheSize, baseline: number): string[] {
  const problems: string[] = [];
  if (size.fonts > FONT_BUDGET_BYTES) {
    problems.push(
      `fonts: ${size.fonts} B, over the ${FONT_BUDGET_BYTES} B budget`
    );
  }
  if (size.primitives > PRIMITIVES_BUDGET_GZIP_BYTES) {
    problems.push(
      `Base UI primitives: ${size.primitives} B gzip, over the ${PRIMITIVES_BUDGET_GZIP_BYTES} B budget`
    );
  }
  const growth = size.rest + size.interface - baseline;
  if (growth > REST_GROWTH_BUDGET_GZIP_BYTES) {
    problems.push(
      `rest: ${size.rest + size.interface} B gzip (interface infrastructure ${size.interface} B), +${growth} B over the baseline of ${baseline} B, past the +${REST_GROWTH_BUDGET_GZIP_BYTES} B budget`
    );
  }
  return problems;
}

/** Fails the production build of the shell when the precache goes past the budget. */
export function precacheBudgetPlugin(): Plugin {
  let offlineRuntime = false;
  let shares: PrecacheShares = {
    interface: new Map(),
    primitives: new Map(),
  };
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
      const baseline = restBaseline(offlineRuntime);
      const problems = budgetProblems(size, baseline);
      // The gallery and the screens lab are for the browser checks only (main.tsx): never in the shell.
      problems.push(...testOnlyChunkProblems(paths));
      // The screen is the rest of the growth over the baseline once the interface infrastructure is taken out.
      const growth = size.rest + size.interface - baseline;
      const screen = size.rest - baseline;
      const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
      this.info(
        `precache (offline runtime ${offlineRuntime ? "on" : "off"}, baseline ${baseline} B): fonts ${size.fonts} B, Base UI primitives ${size.primitives} B gzip, interface infrastructure ${size.interface} B gzip, screen and the rest ${size.rest} B gzip (${signed(screen)} B over the baseline); rest line ${size.rest + size.interface} B gzip (${signed(growth)} B)`
      );
      if (problems.length > 0) {
        this.error(
          `Precache check of the shell failed (ADR 0103): ${problems.join("; ")}`
        );
      }
    },
  };
}
