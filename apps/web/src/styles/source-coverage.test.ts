import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * Tailwind only generates the classes of the files the `@source` lines of the CSS entry name: a `.tsx` of a
 * migrated screen left out of them ships without its utilities (e.g. `md:w-fit` of the row buttons of the
 * stock list was never generated). A file counts as migrated when it imports a component of `src/ui`; it must be
 * covered by some `@source`. The list stays file by file, not a folder glob, as it was written while old screens
 * still lived beside the new ones (ADR 0103, section 3); turning it into a glob of `src` is a decision of its own.
 *
 * A component with no import from `src/ui`, only Tailwind classes, is migrated too once a migrated file imports
 * it: a class of its `className` that Tailwind generates is a utility and needs a source. A component that a
 * migrated screen imports with no utility stays out.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "styles/index.css";
const COMMENT = /\/\*[\s\S]*?\*\//g;
const SOURCE = /^@source\s+"([^"]+)"\s*;/gm;
const PARENT_FOLDER = /^\.\.\//;
const BRACES = /\{([^{}]*)\}/;
const MIGRATED =
  /from\s+["'](?:@\/ui\/|(?:\.\.?\/)+ui\/)|from\s+["'](?:@\/ui|(?:\.\.?\/)+ui)["']/;
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
const ANY_IMPORT = /from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g;
const CLASS_ATTRIBUTE = /\bclassName=/g;
const QUOTED = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
const WHITESPACE = /\s+/;
const CLASS_TOKEN = /^[\w:./[\]%()#&>*=,!-]+$/;
const TEMPLATE_HOLE = /\$\{[^}]*\}/g;
const FAKE_UTILITY = /[:-]/;

/** The text of the value of every `className=` of a file: a string, or a balanced `{ … }` expression. */
function classAttributes(text: string): string[] {
  return [...text.matchAll(CLASS_ATTRIBUTE)].map((match) => {
    const start = (match.index as number) + match[0].length;
    const opener = text[start];
    if (opener === '"' || opener === "'") {
      return text.slice(start + 1, text.indexOf(opener, start + 1));
    }
    let depth = 0;
    let index = start;
    while (index < text.length) {
      if (text[index] === "{") {
        depth += 1;
      } else if (text[index] === "}") {
        depth -= 1;
      }
      index += 1;
      if (depth === 0) {
        break;
      }
    }
    return text.slice(start, index);
  });
}

const IDENTIFIER = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/;

/** `className={LINK}` reads the string of `const LINK = "…"` of the same file (the pattern of a shared class list). */
function constantsOf(value: string, text: string): string[] {
  const name = IDENTIFIER.exec(value.trim())?.[1];
  if (!name) {
    return [];
  }
  for (const keyword of ["const", "let"]) {
    const declared = text.indexOf(`${keyword} ${name} `);
    const equals = declared < 0 ? -1 : text.indexOf("=", declared);
    const opener = equals < 0 ? "" : text.slice(equals + 1).trimStart()[0];
    if (opener === '"' || opener === "'" || opener === "`") {
      const start = text.indexOf(opener, equals) + 1;
      return [`"${text.slice(start, text.indexOf(opener, start))}"`];
    }
  }
  return [];
}

/** The classes of a file's `className`s that are Tailwind utilities (`isUtility`): the ones it relies on. */
function utilityClasses(
  text: string,
  isUtility: (token: string) => boolean
): string[] {
  return classAttributes(text)
    .flatMap((value) => [value, ...constantsOf(value, text)])
    .flatMap((value) =>
      value.includes('"') || value.includes("'") || value.includes("`")
        ? [...value.matchAll(QUOTED)].map(
            (match) => match[1] ?? match[2] ?? match[3] ?? ""
          )
        : [value]
    )
    .flatMap((value) => value.replace(TEMPLATE_HOLE, " ").split(WHITESPACE))
    .filter((token) => CLASS_TOKEN.test(token))
    .filter(isUtility);
}

/** The file an import names (`./x`, `../x`, `@/x`) among the files, as a path relative to `src`. */
function importedFiles(
  file: string,
  text: string,
  files: Map<string, string>
): string[] {
  return [...text.matchAll(ANY_IMPORT)]
    .map((match) => {
      const path = match[1] as string;
      return path.startsWith("@/")
        ? path.slice(2)
        : posix.join(posix.dirname(file), path);
    })
    .flatMap((path) => [`${path}.tsx`, `${path}/index.tsx`])
    .filter((path) => files.has(path));
}

/**
 * The migrated files: those that import a component of `src/ui`, the files of the same
 * folder that import one of those (the pages of the password family import `entry-ui` and carry their own classes),
 * and the files a migrated file imports that carry a Tailwind utility.
 */
function migrated(
  files: Map<string, string>,
  isUtility: (token: string) => boolean
): Set<string> {
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
    // a component a migrated file imports and that carries Tailwind classes (it may import nothing of `src/ui`)
    for (const file of [...found]) {
      for (const imported of importedFiles(
        file,
        files.get(file) ?? "",
        files
      )) {
        const text = files.get(imported) ?? "";
        if (
          !found.has(imported) &&
          utilityClasses(text, isUtility).length > 0
        ) {
          found.add(imported);
          grew = true;
        }
      }
    }
  }
  return found;
}

/** The migrated files (by their text) that no source covers. */
function uncovered(
  files: Map<string, string>,
  sources: string[],
  isUtility: (token: string) => boolean = () => false
): string[] {
  const found = migrated(files, isUtility);
  return [...found]
    .filter((file) => !OWN_FOLDERS.some((folder) => file.startsWith(folder)))
    .filter((file) => !covered(file, sources))
    .sort();
}

/** A stand-in for Tailwind in the controls: a class with a dash or a colon that is not one of `plain`. */
function fakeUtility(plain: string[]): (token: string) => boolean {
  return (token) => !plain.includes(token) && FAKE_UTILITY.test(token);
}

/**
 * What Tailwind would generate for a token, with the theme of the app (the imports of the CSS entry that define
 * utilities; `__unstable__loadDesignSystem` is pinned by the exact version of `tailwindcss`): `candidatesToCss` answers `null` for a
 * name that is no utility (`is-group`, `success`).
 */
/** Where an `@import` of the entry lives: a relative file, the animations package (its file is behind `exports`), or Tailwind's. */
function stylesheetPath(id: string, base: string): string {
  if (id.startsWith(".")) {
    return join(base, id);
  }
  if (id === "tw-animate-css") {
    return join(src, "../node_modules/tw-animate-css/dist/tw-animate.css");
  }
  return fileURLToPath(import.meta.resolve(id));
}

async function appUtility() {
  const design = await __unstable__loadDesignSystem(
    '@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";\n@import "tw-animate-css";\n@import "./shadcn-tailwind.css";\n@import "./theme.css";',
    {
      base: join(src, "styles"),
      loadStylesheet: (id, base) => {
        const path = stylesheetPath(id, base);
        return Promise.resolve({
          base: dirname(path),
          content: readFileSync(path, "utf8"),
          path,
        });
      },
    }
  );
  return (token: string) => design.candidatesToCss([token])[0] !== null;
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
      ["inventory/form.tsx", 'import { Page } from "./page";'],
      ["sales/old-screen.tsx", 'import { x } from "./sale-form-model";'],
      ["lab/lab.tsx", 'import { Page } from "../inventory/page";'],
    ]);
    expect(uncovered(files, ["inventory/page.tsx"])).toEqual([
      "inventory/form.tsx",
      "inventory/row-actions.tsx",
    ]);
    expect(
      uncovered(files, [
        "inventory/page.tsx",
        "inventory/form.tsx",
        "inventory/row-actions.tsx",
      ])
    ).toEqual([]);
    expect(uncovered(files, ["inventory"])).toEqual([]);
  });

  it("control: a component with only Tailwind classes, imported by a migrated file, is reported", () => {
    const files = new Map([
      [
        "inventory/page.tsx",
        'import { Button } from "@/ui/button";\nimport { Row } from "./row";',
      ],
      ["inventory/row.tsx", '<li className="flex md:w-fit old-row" />'],
      ["inventory/old-note.tsx", '<p className="old-row" />'],
      [
        "inventory/dynamic.tsx",
        ["<p className={`old-row $", "{tone}`} />"].join(""),
      ],
      [
        "inventory/cn.tsx",
        '<p className={cn("old-row", open && "md:flex-none")} />',
      ],
      ["sales/alone.tsx", '<p className="p-4" />'],
      [
        "inventory/shared.tsx",
        'const LINK = "underline mb-1!";\n<a className={LINK} />',
      ],
    ]);
    const isUtility = fakeUtility(["old-row"]);
    const page = files.get("inventory/page.tsx") as string;
    files.set(
      "inventory/page.tsx",
      `${page}\nimport { Note } from "./old-note";\nimport { D } from "./dynamic";\nimport { C } from "./cn";\nimport { S } from "./shared";`
    );
    // the old component (old classes only) is not migrated; the ones with a utility are
    expect(uncovered(files, ["inventory/page.tsx"], isUtility)).toEqual([
      "inventory/cn.tsx",
      "inventory/row.tsx",
      "inventory/shared.tsx",
    ]);
    expect(
      uncovered(
        files,
        [
          "inventory/page.tsx",
          "inventory/row.tsx",
          "inventory/cn.tsx",
          "inventory/shared.tsx",
        ],
        isUtility
      )
    ).toEqual([]);
  });

  it("reads the classes of a className that are utilities", () => {
    const isUtility = fakeUtility(["old"]);
    expect(
      utilityClasses(
        '<a className="old md:w-fit" /><b className={cn("old", x && "p-2 hover:bg-x")} />',
        isUtility
      )
    ).toEqual(["md:w-fit", "p-2", "hover:bg-x"]);
    expect(utilityClasses('<a className="old" id="p-4" />', isUtility)).toEqual(
      []
    );
  });

  it("no migrated .tsx of the app is left out of the @source of the entry", async () => {
    const sources = sourcePaths(readFileSync(join(src, ENTRY), "utf8"));
    const files = new Map(
      tsxFiles(src).map((path) => [
        relative(src, path).split(sep).join("/"),
        readFileSync(path, "utf8"),
      ])
    );
    const isUtility = await appUtility();
    expect(isUtility("md:w-fit")).toBe(true);
    expect(isUtility("animate-in")).toBe(true);
    expect(isUtility("is-group")).toBe(false);
    const found = migrated(files, isUtility);
    // the guard sees the migrated screens at all: the stock row buttons are one of them
    expect(found.size).toBeGreaterThan(10);
    expect(found.has("inventory/stock-row-actions.tsx")).toBe(true);
    // the pages of the password family are found through `entry-ui`, not by their own imports
    expect(found.has("sign-in/unlock-page.tsx")).toBe(true);
    // a line for a file that is gone does nothing (Tailwind ignores it); the list is file by file, a folder only for
    // the two of the interface
    for (const source of sources) {
      expect(existsSync(join(src, source)), source).toBe(true);
      expect(
        OWN_FOLDERS.includes(`${source}/`) || source.endsWith(".tsx"),
        source
      ).toBe(true);
    }
    expect(uncovered(files, sources, isUtility)).toEqual([]);
  });
});
