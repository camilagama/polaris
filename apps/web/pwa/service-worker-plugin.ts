import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Plugin, transformWithEsbuild } from "vite";

/**
 * Builds `sw.js` after the client build (plan PR60): the worker source
 * (`src/pwa/sw.ts`), compiled to a classic script, preceded by the manifest of
 * THIS build: its id and the files the shell needs. The file names carry content
 * hashes, and the id also hashes `index.html` and the unhashed public files, so any
 * change to what a user would download changes the worker, which is what makes the
 * browser install the update. The only other thing is when the build was published,
 * which is the time of the commit it was built from (`publishedAtOf`), not the time
 * of the build: the same commit built again is the same worker. A new commit with the
 * same content is a new worker with the same id, which the page takes without a
 * reload (`update-store.ts`).
 */
export interface PrecacheInput {
  /** Files of the build output, relative to it, with forward slashes. */
  files: readonly string[];
}

/** Never part of the shell: the worker itself, source maps and host config files. */
const EXCLUDED = new Set(["sw.js", "_headers", "_redirects", ".assetsignore"]);

/**
 * The chunks that load only online and stay out of the precache (and so out of the budget of `precache-budget.ts`):
 * the import of a spreadsheet (corte 2.5, AC-11), its screen and the reading of the CSV, loaded by an `import()` when
 * the person opens it. There is no import offline (the button is off without a connection), so a phone never
 * downloads it with the shell. The worker does not serve what it did not precache: the request goes to the network.
 * A guard of the budget fails the build when one of its modules is in another chunk or a chunk imports it statically
 * (`onlineOnlyPlacementProblems`).
 */
export const ONLINE_ONLY_CHUNK = /^assets\/product-import-dialog-[\w-]+\.js$/;

/** The paths to precache: `/` (the shell) first, then every static file but the online-only chunks. */
export function precacheList({ files }: PrecacheInput): string[] {
  const paths = files
    .filter(
      (file) =>
        !(
          EXCLUDED.has(file) ||
          file.endsWith(".map") ||
          file === "index.html" ||
          ONLINE_ONLY_CHUNK.test(file)
        )
    )
    .map((file) => `/${file}`)
    .sort();
  return ["/", ...paths];
}

export function listFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(root, path)
      : [relative(root, path).split(sep).join("/")];
  });
}

/** A short id that changes whenever anything a user would download changes. */
export function buildId(
  files: readonly string[],
  readFile: (file: string) => Uint8Array
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file);
    // Hashed assets are named after their content; the rest is read.
    if (!file.startsWith("assets/")) {
      hash.update(readFile(file));
    }
  }
  return hash.digest("hex").slice(0, 12);
}

/** What the worker is built with: the same files give the same manifest, whenever and wherever it is made. */
export function buildManifest(
  files: readonly string[],
  readFile: (file: string) => Uint8Array
) {
  return {
    id: buildId(files, readFile),
    precache: precacheList({ files }),
  };
}

const DIGITS = /^\d+$/;

/**
 * When the build was published, in ms: `POLARIS_BUILD_TIME` (ms or an ISO date) when the pipeline sets it, otherwise
 * the time of the commit built, otherwise null (the page then counts the age from when it first saw the build).
 */
export function publishedAtOf(
  environment: Record<string, string | undefined>,
  commitSeconds: () => string | null
): number | null {
  const given = environment.POLARIS_BUILD_TIME?.trim();
  if (given) {
    const parsed = DIGITS.test(given) ? Number(given) : Date.parse(given);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const seconds = Number(commitSeconds()?.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function commitSecondsOfHead(): string | null {
  try {
    return execFileSync("git", ["log", "-1", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function serviceWorkerPlugin(options: { source: string }): Plugin {
  return {
    apply: "build",
    name: "polaris:service-worker",
    async writeBundle(output) {
      // Only the browser build ships a shell; the Worker build does not.
      if (this.environment && this.environment.name !== "client") {
        return;
      }
      const directory = output.dir;
      if (!directory) {
        return;
      }
      const files = listFiles(directory).filter((file) => file !== "sw.js");
      const manifest = {
        ...buildManifest(files, (file) => readFileSync(join(directory, file))),
        publishedAt: publishedAtOf(process.env, commitSecondsOfHead),
      };
      const compiled = await transformWithEsbuild(
        readFileSync(options.source, "utf8"),
        options.source,
        { format: "iife", loader: "ts", minify: true, target: "es2020" }
      );
      writeFileSync(
        join(directory, "sw.js"),
        `const POLARIS_BUILD=${JSON.stringify(manifest)};\n${compiled.code}`
      );
    },
  };
}
