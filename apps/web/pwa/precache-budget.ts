import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { listFiles, precacheList } from "./service-worker-plugin";

/**
 * The bundle budget of the interface base (ADR 0103, decision 4 and section 4), in two lines, over what the
 * service worker precaches (the shell a user downloads):
 * - fonts: the woff2 bytes (already compressed; gzip does not shrink them), at most 55 KB;
 * - the rest (JS, CSS, HTML, icons, manifest), gzipped, at most 40 KB over the precache before the base.
 * The production build fails past either line. Going past needs a reason in the pull request and the
 * approval of the Arrascaeta; raising a ceiling without that is not allowed.
 */
export const FONT_BUDGET_BYTES = 55_000;
/**
 * The rest of the precache before the UI base (main at 83f6c33 with the PR 0 floor, a build without a Sentry
 * DSN), gzip level 9 with Node's zlib, the runtime of the build in CI. Bun's zlib gives about 1% more for the
 * same files, so a build run by Bun measures a little high.
 */
export const REST_BASELINE_GZIP_BYTES = 1_018_327;
export const REST_GROWTH_BUDGET_GZIP_BYTES = 40_000;

const FONT = /\.woff2?$/;
/**
 * The Sentry SDK chunk exists only in a build with a DSN (ADR 0098), about 35 KB gzip: it is not interface
 * and it is not in the baseline, which is a build without a DSN, so it stays out of the count.
 */
const OUTSIDE_THE_BUDGET = /(^|\/)assets\/sentry-sdk-[\w-]+\.js$/;

export interface PrecacheSize {
  fonts: number;
  rest: number;
}

/** Fonts in bytes and the rest in gzip bytes, for the files of one precache (paths as in `sw.js`). */
export function measurePrecache(
  paths: readonly string[],
  readFile: (path: string) => Uint8Array
): PrecacheSize {
  let fonts = 0;
  let rest = 0;
  for (const path of paths.filter((item) => !OUTSIDE_THE_BUDGET.test(item))) {
    const bytes = readFile(path);
    if (FONT.test(path)) {
      fonts += bytes.byteLength;
    } else {
      rest += gzipSync(bytes, { level: 9 }).byteLength;
    }
  }
  return { fonts, rest };
}

export function budgetProblems(size: PrecacheSize): string[] {
  const problems: string[] = [];
  if (size.fonts > FONT_BUDGET_BYTES) {
    problems.push(
      `fonts: ${size.fonts} B, over the ${FONT_BUDGET_BYTES} B budget`
    );
  }
  const growth = size.rest - REST_BASELINE_GZIP_BYTES;
  if (growth > REST_GROWTH_BUDGET_GZIP_BYTES) {
    problems.push(
      `rest: ${size.rest} B gzip, +${growth} B over the baseline, past the +${REST_GROWTH_BUDGET_GZIP_BYTES} B budget`
    );
  }
  return problems;
}

/** Fails the production build of the shell when the precache goes past the budget. */
export function precacheBudgetPlugin(): Plugin {
  return {
    apply: "build",
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
      const size = measurePrecache(paths, (path) =>
        readFileSync(join(directory, path))
      );
      const problems = budgetProblems(size);
      this.info(
        `precache: fonts ${size.fonts} B, rest ${size.rest} B gzip (${size.rest - REST_BASELINE_GZIP_BYTES >= 0 ? "+" : ""}${size.rest - REST_BASELINE_GZIP_BYTES} B)`
      );
      if (problems.length > 0) {
        this.error(
          `Precache over the bundle budget (ADR 0103): ${problems.join("; ")}`
        );
      }
    },
  };
}
