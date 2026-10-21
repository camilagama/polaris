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
 * - the rest (Tailwind, tokens, CSS, the screens' code, HTML, icons, manifest), gzipped, at most 40 KB over the
 *   precache before the base, the baseline of the same kind of build.
 * The production build fails past any line. Going past needs a reason in the pull request and the approval of
 * the Arrascaeta; raising a ceiling without that is not allowed.
 */
export const FONT_BUDGET_BYTES = 55_000;
export const PRIMITIVES_BUDGET_GZIP_BYTES = 95_000;
export const REST_GROWTH_BUDGET_GZIP_BYTES = 40_000;

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
const GALLERY_CHUNK = /(^|\/)assets\/ui-gallery-[\w-]+\.js$/;
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

export interface PrecacheSize {
  fonts: number;
  primitives: number;
  rest: number;
}

/** What a chunk is made of: the rendered length of each module, by module id. */
export interface ChunkModules {
  fileName: string;
  modules: Record<string, { renderedLength: number }>;
}

/**
 * The share of each chunk that is the primitives' code (rendered length of their modules over the chunk's),
 * only for the chunks that have some. The build does not change its chunks for the count: grouping Base UI
 * in a chunk of its own would drag shared modules along and change the graph of the shell.
 */
export function primitiveShares(
  chunks: readonly ChunkModules[]
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const chunk of chunks) {
    let total = 0;
    let primitives = 0;
    for (const [id, module] of Object.entries(chunk.modules)) {
      total += module.renderedLength;
      if (PRIMITIVE_MODULE.test(id)) {
        primitives += module.renderedLength;
      }
    }
    if (primitives > 0 && total > 0) {
      shares.set(chunk.fileName, primitives / total);
    }
  }
  return shares;
}

/**
 * Fonts in bytes, the primitives and the rest in gzip bytes, for the files of one precache (paths as in
 * `sw.js`). A chunk with primitives splits its gzip size by their share of it.
 */
export function measurePrecache(
  paths: readonly string[],
  readFile: (path: string) => Uint8Array,
  shares: ReadonlyMap<string, number> = new Map()
): PrecacheSize {
  let fonts = 0;
  let primitives = 0;
  let rest = 0;
  for (const path of paths.filter((item) => !OUTSIDE_THE_BUDGET.test(item))) {
    const bytes = readFile(path);
    if (FONT.test(path)) {
      fonts += bytes.byteLength;
      continue;
    }
    const gzip = gzipSync(bytes, { level: 9 }).byteLength;
    const ofPrimitives = Math.round(gzip * (shares.get(path) ?? 0));
    primitives += ofPrimitives;
    rest += gzip - ofPrimitives;
  }
  return { fonts, primitives, rest };
}

export function restBaseline(offlineRuntime: boolean): number {
  return offlineRuntime
    ? REST_BASELINE_GZIP_BYTES.offlineRuntimeOn
    : REST_BASELINE_GZIP_BYTES.offlineRuntimeOff;
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
  const growth = size.rest - baseline;
  if (growth > REST_GROWTH_BUDGET_GZIP_BYTES) {
    problems.push(
      `rest: ${size.rest} B gzip, +${growth} B over the baseline of ${baseline} B, past the +${REST_GROWTH_BUDGET_GZIP_BYTES} B budget`
    );
  }
  return problems;
}

/** Fails the production build of the shell when the precache goes past the budget. */
export function precacheBudgetPlugin(): Plugin {
  let offlineRuntime = false;
  let shares = new Map<string, number>();
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
      shares = primitiveShares(
        Object.values(bundle).flatMap((item) =>
          item.type === "chunk"
            ? [{ fileName: item.fileName, modules: item.modules }]
            : []
        )
      );
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
      // The gallery of the primitives is for the browser checks only (main.tsx): never in the shell.
      const gallery = paths.filter((path) => GALLERY_CHUNK.test(path));
      if (gallery.length > 0) {
        problems.push(
          `the UI gallery is in the production build (${gallery.join(", ")})`
        );
      }
      const growth = size.rest - baseline;
      this.info(
        `precache (offline runtime ${offlineRuntime ? "on" : "off"}, baseline ${baseline} B): fonts ${size.fonts} B, Base UI primitives ${size.primitives} B gzip, rest ${size.rest} B gzip (${growth >= 0 ? "+" : ""}${growth} B)`
      );
      if (problems.length > 0) {
        this.error(
          `Precache check of the shell failed (ADR 0103): ${problems.join("; ")}`
        );
      }
    },
  };
}
