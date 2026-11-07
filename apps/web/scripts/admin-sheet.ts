import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { transformWithEsbuild } from "vite";

/**
 * The Admin's sheet, compiled by the dash's Tailwind (ADR 0070, emenda da convergência visual): the Admin has no
 * framework and no build of its own for CSS, so its sheet is a file written here from `apps/admin/ui/admin.source.css`
 * and kept in the repository. The Admin's build copies it as it is; `admin-sheet.test.ts` fails when it differs from
 * what this script writes now. Run `bun run admin:sheet` after changing the source, a class of `apps/admin/src/ui/page.ts`
 * or a token of `@polaris/ui`.
 *
 * Two things differ from the dash's build, both because the Admin has no script before the first paint: the dark theme
 * follows `prefers-color-scheme` (the dash's `.dark` block and variant are rewritten to the media query), and the
 * nesting Tailwind writes is lowered here for the browsers of the floor (Safari 16.4, Chrome 111), which the dash's
 * Vite does in its own build.
 */

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const web = fileURLToPath(new URL("../", import.meta.url));
export const ADMIN_SHEET_SOURCE = "apps/admin/ui/admin.source.css";
export const ADMIN_SHEET_OUTPUT = "apps/admin/ui/admin.css";
const THEME = "packages/ui/src/theme.css";
const requireFromAdmin = createRequire(
  join(repository, "apps/admin/package.json")
);
const COMMAND = "bun run admin:sheet";
const TARGET = ["chrome111", "edge111", "firefox128", "safari16.4"];

const DARK_VARIANT = "@custom-variant dark (&:is(.dark *));";
const DARK_VARIANT_BY_MEDIA =
  "@custom-variant dark (@media (prefers-color-scheme: dark));";
const DARK_TOKENS = /^\.dark \{\n([\s\S]*?)^\}/m;
const DARK_SCHEME = /^ {2}\.dark \{\n {4}color-scheme: dark;\n {2}\}/m;

/** The dash's theme with the dark theme moved from the `.dark` class to `prefers-color-scheme`; each change must hit. */
export function themeByMedia(theme: string): string {
  const steps: [string, (text: string) => string][] = [
    [
      "the dark variant",
      (text) => text.replace(DARK_VARIANT, DARK_VARIANT_BY_MEDIA),
    ],
    [
      "the dark tokens",
      (text) =>
        text.replace(
          DARK_TOKENS,
          (_block, body: string) =>
            `@media (prefers-color-scheme: dark) {\n  :root {\n${body}  }\n}`
        ),
    ],
    [
      "the dark color-scheme",
      (text) =>
        text.replace(
          DARK_SCHEME,
          "  @media (prefers-color-scheme: dark) {\n    :root {\n      color-scheme: dark;\n    }\n  }"
        ),
    ],
  ];
  return steps.reduce((text, [name, step]) => {
    const changed = step(text);
    if (changed === text) {
      throw new Error(
        `${THEME}: ${name} was not found; ${COMMAND} needs to follow the theme`
      );
    }
    return changed;
  }, theme);
}

function stylesheetPath(id: string, base: string): string {
  if (id === "tailwindcss") {
    return join(web, "node_modules/tailwindcss/index.css");
  }
  if (id.startsWith("tailwindcss/")) {
    return join(web, "node_modules", id);
  }
  if (id.startsWith("@polaris/")) {
    return requireFromAdmin.resolve(id);
  }
  return resolve(base, id);
}

const TAILWIND_BANNER_ADDRESS = / \| https:\/\/tailwindcss\.com(?= \*\/)/;
const CANDIDATE = /[^\s"'`<>{}=]+/g;

/** The words of a text that could be classes: what Tailwind's scanner would take from it. */
export function candidatesIn(text: string): string[] {
  return text.match(CANDIDATE) ?? [];
}

/** The words of the files the source names in `@source`: Tailwind keeps the ones that are classes. */
function candidatesOf(files: readonly string[]): string[] {
  const words = new Set<string>();
  for (const file of files) {
    for (const word of candidatesIn(readFileSync(file, "utf8"))) {
      words.add(word);
    }
  }
  return [...words].sort();
}

export async function buildAdminSheet(): Promise<string> {
  const sourcePath = join(repository, ADMIN_SHEET_SOURCE);
  const themePath = join(repository, THEME);
  const compiler = await compile(readFileSync(sourcePath, "utf8"), {
    base: dirname(sourcePath),
    loadStylesheet: (id, base) => {
      const path = stylesheetPath(id, base);
      const content = readFileSync(path, "utf8");
      return Promise.resolve({
        base: dirname(path),
        content: path === themePath ? themeByMedia(content) : content,
        path,
      });
    },
  });
  const files = compiler.sources.map((source) =>
    resolve(source.base, source.pattern)
  );
  if (files.length === 0) {
    throw new Error(`${ADMIN_SHEET_SOURCE} names no @source`);
  }
  const css = compiler.build(candidatesOf(files));
  // the page's sheet names no address (ui-guard.test.ts): the license line keeps the name, the version and the license
  const banner = css.replace(TAILWIND_BANNER_ADDRESS, "");
  const lowered = await transformWithEsbuild(banner, "admin.css", {
    minify: false,
    target: TARGET,
  });
  return `/*\n * Generated from ${ADMIN_SHEET_SOURCE} by apps/web/scripts/admin-sheet.ts. Do not edit.\n * To generate again: ${COMMAND}\n */\n${lowered.code}`;
}

if (import.meta.main) {
  writeFileSync(join(repository, ADMIN_SHEET_OUTPUT), await buildAdminSheet());
  process.stdout.write(`wrote ${ADMIN_SHEET_OUTPUT}\n`);
}
