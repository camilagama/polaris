import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Plugin, transformWithEsbuild } from "vite";

/**
 * Builds `sw.js` after the client build (plan PR60): the worker source
 * (`src/pwa/sw.ts`), compiled to a classic script, preceded by the manifest of
 * THIS build: its id, the time it was made and the files the shell needs. The
 * file names carry content hashes, and the id also hashes `index.html` and the
 * unhashed public files, so any change to what a user would download changes the
 * worker, which is what makes the browser install the update.
 */
export interface PrecacheInput {
  /** Files of the build output, relative to it, with forward slashes. */
  files: readonly string[];
}

/** Never part of the shell: the worker itself, source maps and host config files. */
const EXCLUDED = new Set(["sw.js", "_headers", "_redirects", ".assetsignore"]);

/** The paths to precache: `/` (the shell) first, then every static file. */
export function precacheList({ files }: PrecacheInput): string[] {
  const paths = files
    .filter(
      (file) =>
        !(EXCLUDED.has(file) || file.endsWith(".map") || file === "index.html")
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
        builtAt: Date.now(),
        id: buildId(files, (file) => readFileSync(join(directory, file))),
        precache: precacheList({ files }),
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
