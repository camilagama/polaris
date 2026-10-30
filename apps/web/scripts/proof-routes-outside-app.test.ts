import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The RLS proof route has no on/off variable: it stays out of the app only because no file the app's Worker or
// the SPA builds from imports `apps/web/poc/`.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proofDirectory = join(webRoot, "poc");
const appRoots = ["src", "worker"];
const sourceFile = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/;
const specifierPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : filesUnder(path);
    }
    return sourceFile.test(entry.name) ? [path] : [];
  });
}

function proofImportsOf(file: string, source: string): string[] {
  return [...source.matchAll(specifierPattern)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => {
      if (!specifier.startsWith(".")) {
        return false;
      }
      const target = resolve(dirname(file), specifier);
      return (
        target === proofDirectory || target.startsWith(proofDirectory + sep)
      );
    });
}

describe("the proof routes stay out of the app", () => {
  it("no file under src/ or worker/ imports apps/web/poc/", () => {
    const files = appRoots.flatMap((root) => filesUnder(join(webRoot, root)));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((file) =>
      proofImportsOf(file, readFileSync(file, "utf8")).map(
        (specifier) => `${relative(webRoot, file)}: ${specifier}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it("catches every form of import of the proof directory", () => {
    const worker = join(webRoot, "worker", "index.ts");
    const deep = join(webRoot, "src", "server", "routes", "x.ts");
    expect(
      proofImportsOf(worker, 'import { rlsPocRoutes } from "../poc/rls-poc";')
    ).toEqual(["../poc/rls-poc"]);
    expect(proofImportsOf(worker, 'export * from "../poc/pr11";')).toEqual([
      "../poc/pr11",
    ]);
    expect(
      proofImportsOf(worker, 'await import("../poc/rls-poc.ts");')
    ).toEqual(["../poc/rls-poc.ts"]);
    expect(proofImportsOf(worker, 'import "../poc";')).toEqual(["../poc"]);
    expect(
      proofImportsOf(deep, "import { x } from '../../../poc/rls-poc';")
    ).toEqual(["../../../poc/rls-poc"]);
  });

  it("leaves alone the offline lab and the packages", () => {
    const file = join(webRoot, "src", "main.ts");
    expect(
      proofImportsOf(
        file,
        [
          'import { lab } from "./offline-poc/lab";',
          'import { x } from "../pocket/x";',
          'import { createRlsPocDatabase } from "@polaris/db/rls-poc-client";',
        ].join("\n")
      )
    ).toEqual([]);
  });
});
