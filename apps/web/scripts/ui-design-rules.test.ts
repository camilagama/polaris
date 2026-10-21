import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rules of the interface base that the review would otherwise have to remember (ADR 0103):
 * - colors only in OKLCH in src/ui/ and in the CSS of the base (decision 3);
 * - lucide icons one file at a time, never the whole package (section 2);
 * - every Base UI portal carries `data-ui`, the root of the scoped preflight and page defaults (section 3):
 *   a popup portalled to <body> without it would lose the reset.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const uiDir = join(web, "src/ui");
const uiFiles = readdirSync(uiDir).filter((file) => file.endsWith(".tsx"));
const BASE_CSS = [
  "src/styles/index.css",
  "src/styles/theme.css",
  "src/styles/shadcn-tailwind.css",
  "src/styles/preflight.css",
];
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const NOT_OKLCH = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch)\(/;
const WHOLE_LUCIDE = /from "lucide-react"/;
const BASE_UI_STYLE = /^base-/;
const PORTAL = /<[A-Za-z]+\.Portal\b[^>]*>/g;

const read = (path: string) =>
  readFileSync(join(web, path), "utf8").replace(COMMENT, "");

describe("design rules of src/ui/ (ADR 0103)", () => {
  it("has the primitives of the base", () => {
    for (const name of [
      "button",
      "input",
      "label",
      "dialog",
      "popover",
      "select",
      "dropdown-menu",
      "tooltip",
      "toast",
      "scroll-area",
    ]) {
      expect(uiFiles).toContain(`${name}.tsx`);
    }
  });

  it.each([...uiFiles.map((file) => `src/ui/${file}`), ...BASE_CSS])(
    "%s writes colors only in OKLCH",
    (path) => {
      expect(read(path).match(NOT_OKLCH)).toBeNull();
    }
  );

  it.each(uiFiles)("%s imports lucide icons one file at a time", (file) => {
    expect(read(`src/ui/${file}`)).not.toMatch(WHOLE_LUCIDE);
  });

  it.each(uiFiles)("every portal of %s carries data-ui", (file) => {
    const portals = read(`src/ui/${file}`).match(PORTAL) ?? [];
    expect(portals.filter((tag) => !tag.includes('data-ui=""'))).toEqual([]);
  });

  it("components.json: the Base UI variant, our aliases and only the official registry (condition 5)", () => {
    const config = JSON.parse(
      readFileSync(join(web, "components.json"), "utf8")
    );
    expect(config.style).toMatch(BASE_UI_STYLE);
    expect(config).toMatchObject({
      aliases: { components: "@/ui", ui: "@/ui", utils: "@/lib/utils" },
      registries: {},
      rsc: false,
      tailwind: { config: "", css: "src/styles/index.css" },
      tsx: true,
    });
  });

  it("the patterns catch what they are for", () => {
    expect("color: #fff;").toMatch(NOT_OKLCH);
    expect("bg-[rgb(0_0_0)]").toMatch(NOT_OKLCH);
    expect("oklch(0.2 0.005 85 / 0.4)").not.toMatch(NOT_OKLCH);
    expect('import { X } from "lucide-react"').toMatch(WHOLE_LUCIDE);
    expect("<Foo.Portal>".match(PORTAL)).toEqual(["<Foo.Portal>"]);
  });
});
