import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tailwind only generates the classes of the files the `@source` lines of the CSS entry name: a `.tsx` of a
 * migrated screen left out of them ships without its utilities (PR 229: `md:w-fit` of the row buttons of the
 * stock list was never generated). A file counts as migrated when it imports a component of `src/ui` or
 * uses `data-ui`; it must be covered by some `@source`. The list stays file by file, not a folder glob: a
 * folder such as `sales/` or `sign-in/` still holds old screens, and utilities generated from them would
 * restyle those screens (ADR 0103, section 3).
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "styles/index.css";
const COMMENT = /\/\*[\s\S]*?\*\//g;
const SOURCE = /^@source\s+"([^"]+)"\s*;/gm;
const PARENT_FOLDER = /^\.\.\//;
const BRACES = /\{([^{}]*)\}/;
const MIGRATED =
  /from\s+["'](?:@\/ui\/|(?:\.\.?\/)+ui\/)|\bdata-ui\b|from\s+["'](?:@\/ui|(?:\.\.?\/)+ui)["']/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
// `src/ui` and the gallery are sources as whole folders and need no listing
const OWN_FOLDERS = ["ui/", "ui-gallery/"];

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(path);
    }
    return entry.name.endsWith(".tsx") && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

/** `a/{b,c}.tsx` becomes `a/b.tsx` and `a/c.tsx`. */
function expandBraces(pattern: string): string[] {
  const match = BRACES.exec(pattern);
  if (!match) {
    return [pattern];
  }
  return (match[1] as string)
    .split(",")
    .flatMap((option) =>
      expandBraces(
        pattern.slice(0, match.index) +
          option +
          pattern.slice(match.index + match[0].length)
      )
    );
}

/** The paths of the `@source` lines of a sheet, relative to `src`, as the sheet is in `src/styles`. */
function sourcePaths(sheet: string): string[] {
  return [...sheet.replace(COMMENT, "").matchAll(SOURCE)]
    .flatMap((match) => expandBraces(match[1] as string))
    .map((path) => path.replace(PARENT_FOLDER, ""));
}

function covered(file: string, sources: string[]): boolean {
  return sources.some(
    (source) => file === source || file.startsWith(`${source}/`)
  );
}

const SIBLING_IMPORT = /from\s+["']\.\/([^"']+)["']/g;

/**
 * The migrated files: those that import a component of `src/ui` or use `data-ui`, and the files of the same
 * folder that import one of those (the pages of the password family import `entry-ui` and carry their own classes).
 */
function migrated(files: Map<string, string>): Set<string> {
  const found = new Set(
    [...files].filter(([, text]) => MIGRATED.test(text)).map(([file]) => file)
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, text] of files) {
      const folder = posix.dirname(file);
      const importsOne = [...text.matchAll(SIBLING_IMPORT)].some((match) =>
        found.has(posix.join(folder, `${match[1]}.tsx`))
      );
      if (importsOne && !found.has(file)) {
        found.add(file);
        grew = true;
      }
    }
  }
  return found;
}

/** The migrated files (by their text) that no source covers. */
function uncovered(files: Map<string, string>, sources: string[]): string[] {
  const found = migrated(files);
  return [...found]
    .filter((file) => !OWN_FOLDERS.some((folder) => file.startsWith(folder)))
    .filter((file) => !covered(file, sources))
    .sort();
}

describe("@source covers every file of a migrated screen (ADR 0103)", () => {
  it("reads the sources of the entry, with braces", () => {
    expect(
      sourcePaths(
        '@source "../ui";\n/* @source "../x" */\n@source "../a/{b,c}.tsx";'
      )
    ).toEqual(["ui", "a/b.tsx", "a/c.tsx"]);
  });

  it("control: a migrated file outside every source is reported, an old one is not", () => {
    const files = new Map([
      ["inventory/page.tsx", 'import { Button } from "@/ui/button";'],
      ["inventory/row-actions.tsx", 'import { Button } from "@/ui/button";'],
      ["inventory/screen.tsx", '<main data-ui className="p-4" />'],
      ["inventory/form.tsx", 'import { Page } from "./page";'],
      ["sales/old-screen.tsx", 'import { x } from "./sale-form-model";'],
      ["lab/lab.tsx", 'import { Page } from "../inventory/page";'],
    ]);
    expect(uncovered(files, ["inventory/page.tsx"])).toEqual([
      "inventory/form.tsx",
      "inventory/row-actions.tsx",
      "inventory/screen.tsx",
    ]);
    expect(
      uncovered(files, [
        "inventory/page.tsx",
        "inventory/form.tsx",
        "inventory/row-actions.tsx",
        "inventory/screen.tsx",
      ])
    ).toEqual([]);
    expect(uncovered(files, ["inventory"])).toEqual([]);
  });

  it("no migrated .tsx of the app is left out of the @source of the entry", () => {
    const sources = sourcePaths(readFileSync(join(src, ENTRY), "utf8"));
    const files = new Map(
      tsxFiles(src).map((path) => [
        relative(src, path).split(sep).join("/"),
        readFileSync(path, "utf8"),
      ])
    );
    // the guard sees the migrated screens at all: the stock row buttons are one of them
    expect(migrated(files).size).toBeGreaterThan(10);
    expect(migrated(files).has("inventory/stock-row-actions.tsx")).toBe(true);
    // the pages of the password family are found through `entry-ui`, not by their own imports
    expect(migrated(files).has("sign-in/unlock-page.tsx")).toBe(true);
    // a line for a file that is gone does nothing (Tailwind ignores it); a folder (other than the two of the
    // interface) would generate the utilities of old screens
    for (const source of sources) {
      expect(existsSync(join(src, source)), source).toBe(true);
      expect(
        OWN_FOLDERS.includes(`${source}/`) || source.endsWith(".tsx"),
        source
      ).toBe(true);
    }
    expect(uncovered(files, sources)).toEqual([]);
  });
});
