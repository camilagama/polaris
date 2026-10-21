import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { uiBuild, uiPlugins } from "../../vite.ui";

/**
 * No utility shares its name with a class of an old sheet (ADR 0103, section 3): utilities win over
 * `@layer legacy`, so a utility named like an old class (`.hidden`, `.grid`, `.table`) would restyle an old
 * screen. The CSS entry builds utilities only from the folders of the new interface (`@source`); this test
 * builds it with the Tailwind plugin of the app and crosses the class selectors of its utilities with the classes
 * of the `legacy` sheets. It goes away with `@layer legacy`.
 */
const web = fileURLToPath(new URL("../..", import.meta.url));
const src = join(web, "src");
const COMMENT = /\/\*[\s\S]*?\*\//g;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const URL_VALUE = /url\([^)]*\)/g;
// a class selector: a dot, then a name that does not start with a digit (`.5rem` in a value is not one)
const CLASS = /\.(-?[_a-zA-Z](?:\\.|[\w-])*)/g;
const LEGACY = /@layer legacy\s*\{/;
// the namespaces of Tailwind's theme variables: an old sheet that reads one gets the new theme's value
const TAILWIND_VARIABLE =
  /var\(\s*--(?:color|font|text|radius|shadow|spacing|leading|tracking|ease|animate|blur|breakpoint|container|default)\b[\w-]*/g;
// and the variables the new theme declares itself (`--border`, `--ring`, `--mark` and the others)
const DECLARED_VARIABLE = /(--[\w-]+)\s*:/g;
const READ_VARIABLE = /var\(\s*(--[\w-]+)/g;
const THEME_SHEETS = ["styles/theme.css", "styles/shadcn-tailwind.css"];

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return cssFiles(path);
    }
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

function classNames(css: string): Set<string> {
  const text = css
    .replace(COMMENT, "")
    .replace(STRING, '""')
    .replace(URL_VALUE, "");
  return new Set(
    [...text.matchAll(CLASS)].map((match) =>
      (match[1] as string).replace(/\\(.)/g, "$1")
    )
  );
}

/** The text of every `@layer utilities { … }` block of a sheet. */
function utilitiesLayers(css: string): string {
  const blocks: string[] = [];
  const opening = /@layer utilities\s*\{/g;
  for (const match of css.matchAll(opening)) {
    let depth = 1;
    let index = (match.index as number) + match[0].length;
    const start = index;
    while (depth > 0 && index < css.length) {
      if (css[index] === "{") {
        depth += 1;
      } else if (css[index] === "}") {
        depth -= 1;
      }
      index += 1;
    }
    blocks.push(css.slice(start, index - 1));
  }
  return blocks.join("\n");
}

async function builtUtilities(): Promise<string> {
  const output = (await build({
    ...uiBuild,
    build: {
      ...uiBuild.build,
      rolldownOptions: { input: join(src, "styles/index.css") },
      write: false,
    },
    configFile: false,
    logLevel: "silent",
    plugins: [uiPlugins()],
    root: web,
  })) as Rolldown.RolldownOutput;
  const css = output.output
    .filter(
      (item): item is Rolldown.OutputAsset =>
        item.type === "asset" && item.fileName.endsWith(".css")
    )
    .map((item) => String(item.source))
    .join("\n");
  return utilitiesLayers(css);
}

describe("utilities and the classes of the legacy sheets (ADR 0103, section 3)", () => {
  it("the patterns read class selectors and the utilities layer", () => {
    expect([
      ...classNames(
        '.a,.hover\\:bg-x:hover{margin:.5rem;background:url(x.svg)} .b > .c::after{content:".d"}'
      ),
    ]).toEqual(["a", "hover:bg-x", "b", "c"]);
    expect(
      utilitiesLayers(
        "@layer base{.x{}}@layer utilities{.p-2{padding:1px}@media (x){.y{}}}"
      )
    ).toBe(".p-2{padding:1px}@media (x){.y{}}");
  });

  it("no legacy sheet reads a variable of Tailwind's theme", () => {
    expect(
      "var(--color-border, oklch(0% 0 0 / 12%))".match(TAILWIND_VARIABLE)
    ).toEqual(["var(--color-border"]);
    const found = cssFiles(src)
      .filter((path) => LEGACY.test(readFileSync(path, "utf8")))
      .flatMap((path) =>
        (
          readFileSync(path, "utf8")
            .replace(COMMENT, "")
            .match(TAILWIND_VARIABLE) ?? []
        ).map((use) => `${relative(src, path).split(sep).join("/")}: ${use}`)
      );
    expect(found).toEqual([]);
  });

  it("no legacy sheet reads or declares a variable of the new theme", () => {
    const theme = new Set(
      THEME_SHEETS.flatMap((sheet) =>
        [
          ...readFileSync(join(src, sheet), "utf8")
            .replace(COMMENT, "")
            .matchAll(DECLARED_VARIABLE),
        ].map((match) => match[1] as string)
      )
    );
    expect(theme.has("--border")).toBe(true);
    const found = cssFiles(src)
      .filter((path) => LEGACY.test(readFileSync(path, "utf8")))
      .flatMap((path) => {
        const text = readFileSync(path, "utf8").replace(COMMENT, "");
        const names = [
          ...[...text.matchAll(READ_VARIABLE)].map(
            (match) => match[1] as string
          ),
          ...[...text.matchAll(DECLARED_VARIABLE)].map(
            (match) => match[1] as string
          ),
        ];
        return [...new Set(names)]
          .filter((name) => theme.has(name))
          .map(
            (name) => `${relative(src, path).split(sep).join("/")}: ${name}`
          );
      });
    expect(found).toEqual([]);
  });

  it("no utility of the build is named like a class of a legacy sheet", async () => {
    const utilities = classNames(await builtUtilities());
    // the build made utilities: an empty set would pass without proving anything
    expect(utilities.size).toBeGreaterThan(50);
    const legacy = cssFiles(src)
      .filter((path) => LEGACY.test(readFileSync(path, "utf8")))
      .flatMap((path) =>
        [...classNames(readFileSync(path, "utf8"))]
          .filter((name) => utilities.has(name))
          .map(
            (name) => `${relative(src, path).split(sep).join("/")}: .${name}`
          )
      );
    expect(legacy).toEqual([]);
  }, 60_000);
});
