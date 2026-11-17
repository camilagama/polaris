import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFiles } from "./verify-no-lab-in-build.mjs";

/**
 * The browser build writes source maps (`sourcemap: "hidden"`, `apps/web/vite.config.ts`) so they can be sent to
 * Sentry, and the Static Assets deploy keeps them out through `.assetsignore` (`*.map`). Nothing else proved that
 * the file reaches the deploy and that no map slips past it, so this reads a built `apps/web/dist/client` and
 * fails when a source map would be published: a `.map` the ignore file does not cover, a published `.json` that is
 * a source map, or a published script or style sheet that carries one inline.
 * A `sourceMappingURL` that names a file is not a leak by itself: the file is listed when it is published, and a
 * vendored worker bundle keeps such a comment for a file that is not in the build. A map in the ignored set is fine
 * and is counted, not listed; a build with no map at all passes too.
 */

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_CLIENT_DIR = path.join(root, "apps/web/dist/client");

const SCRIPT_OR_STYLE = /\.(?:m?js|css)$/;
const INLINE_MAP = /[#@]\s*sourceMappingURL\s*=\s*data:/;
const SNIFFED_MAP_KEYS = /"mappings"\s*:|"sourcesContent"\s*:/;
const LEADING_SLASH = /^\//;
const SNIFF_LIMIT_BYTES = 20 * 1024 * 1024;

const escapeForRegExp = (value) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** One line of `.assetsignore` as a test on a path relative to the client folder; `null` for a pattern this check does not read. */
function patternTest(line) {
  if (line.includes("**") || line.includes("[") || line.includes("?")) {
    return null;
  }
  const anchored = line.includes("/");
  const source = escapeForRegExp(line.replace(LEADING_SLASH, "")).replaceAll(
    "*",
    "[^/]*"
  );
  const expression = new RegExp(
    anchored ? `^${source}(?:/.*)?$` : `(?:^|/)${source}(?:/.*)?$`
  );
  return (relative) => expression.test(relative);
}

/** What the platform leaves out of the upload: the patterns of `.assetsignore`, and the files that configure it. */
export function readIgnoreRules(text) {
  const tests = [];
  const problems = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const test = line.startsWith("!") ? null : patternTest(line);
    if (test === null) {
      problems.push(
        `.assetsignore: the pattern "${line}" is not one this check reads (only plain names and * globs, no "!"); a map could be re-included by it`
      );
      continue;
    }
    tests.push(test);
  }
  return {
    isIgnored: (relative) =>
      relative === ".assetsignore" ||
      relative === "_headers" ||
      relative === "_redirects" ||
      tests.some((test) => test(relative)),
    problems,
  };
}

function sniffedAsMap(file) {
  if (statSync(file).size > SNIFF_LIMIT_BYTES) {
    return false;
  }
  const text = readFileSync(file, "utf8");
  return text.trimStart().startsWith("{") && SNIFFED_MAP_KEYS.test(text);
}

/** Problems of a built client folder, empty when no source map would be published. */
export function findPublishedMaps(clientDirectory) {
  if (
    !(existsSync(clientDirectory) && statSync(clientDirectory).isDirectory())
  ) {
    return {
      ignoredMaps: 0,
      problems: [
        `${clientDirectory}: no build found (run the build of apps/web first)`,
      ],
      published: 0,
    };
  }
  const files = collectFiles(clientDirectory).map((file) => ({
    file,
    relative: path.relative(clientDirectory, file).split(path.sep).join("/"),
  }));
  const problems = [];
  if (!files.some(({ relative }) => relative === "index.html")) {
    problems.push(
      `${clientDirectory}: no index.html, so this is not the client build of apps/web`
    );
  }
  const ignoreFile = path.join(clientDirectory, ".assetsignore");
  if (!existsSync(ignoreFile)) {
    problems.push(
      ".assetsignore: missing from the build, so nothing keeps the source maps out of the deploy"
    );
  }
  const rules = readIgnoreRules(
    existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : ""
  );
  problems.push(...rules.problems);
  const published = files.filter(({ relative }) => !rules.isIgnored(relative));
  const ignoredMaps = files.filter(
    ({ relative }) => relative.endsWith(".map") && rules.isIgnored(relative)
  ).length;
  for (const { file, relative } of published) {
    if (relative.endsWith(".map")) {
      problems.push(`${relative}: a source map that would be published`);
    } else if (SCRIPT_OR_STYLE.test(relative)) {
      if (INLINE_MAP.test(readFileSync(file, "utf8"))) {
        problems.push(
          `${relative}: carries its source map inline (sourceMappingURL=data:)`
        );
      }
    } else if (relative.endsWith(".json") && sniffedAsMap(file)) {
      problems.push(`${relative}: looks like a source map under another name`);
    }
  }
  return { ignoredMaps, problems, published: published.length };
}

function main() {
  const target = path.resolve(process.argv[2] ?? DEFAULT_CLIENT_DIR);
  const { ignoredMaps, problems, published } = findPublishedMaps(target);
  if (problems.length > 0) {
    console.error(`No-source-map-published check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `No-source-map-published check passed: ${published} files would be published, none a source map (${ignoredMaps} maps kept out by .assetsignore).`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
