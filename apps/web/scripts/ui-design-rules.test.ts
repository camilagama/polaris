import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_TARGET } from "../vite.ui";

/**
 * Rules of the interface base that the review would otherwise have to remember (ADR 0103):
 * - colors only in OKLCH in src/ui/ and in the CSS of the base (decision 3);
 * - lucide icons one file at a time, never the whole package (section 2);
 * - the primitives keep the animation that shadcn brings (DESIGN.md, motion) at the `full` level of motion, not on a
 *   phone, and the page zeroes it with reduce;
 * - the browser floor of Tailwind 4 is the same in `build.target` and in `browserslist` (section 2).
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const uiDir = join(web, "src/ui");
const uiFiles = readdirSync(uiDir).filter((file) => file.endsWith(".tsx"));
const TSX = /\.tsx$/;
const componentFiles = uiFiles.filter((file) => !file.endsWith(".test.tsx"));
const AXE_IMPORT = /["'`]axe-core["'`/]/;
const BASE_CSS = [
  "src/styles/index.css",
  "src/styles/theme.css",
  "src/styles/shadcn-tailwind.css",
];
// a `//` comment starts a line or follows a space, so the `//` of a URL inside a string is not one
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const NOT_OKLCH = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch)\(/;
const WHOLE_LUCIDE = /from "lucide-react"/;
const BASE_UI_STYLE = /^base-/;
const TOAST_VIEWPORT_NAMED =
  /<ToastPrimitive\.Viewport\b[^>]*\saria-label="Avisos"/;
const ESBUILD_TARGET = /^([a-z]+)([\d.]+)$/;
const MOTION_IMPORT = /from\s+"motion|import\s+"motion/;

/**
 * A component that only loads on demand is in the gallery through its loader, as in the app: a static import of it
 * would put its chunk in the gallery's and fail the placement guard of `pwa/precache-budget.ts`.
 */
const ON_DEMAND_LOADER: Record<string, string> = {
  calendar: "calendar-on-demand",
  // the animated layer of the bar comes by `import()` only at the full level of motion
  "filter-bar-motion": "filter-bar",
};

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

  it("has the components of the sale (ADR 0103, section 8, item 3)", () => {
    for (const name of [
      "alert",
      "badge",
      "button-group",
      "card",
      "checkbox",
      "field",
      "input-group",
      "radio-group",
      "separator",
    ]) {
      expect(uiFiles).toContain(`${name}.tsx`);
    }
  });

  it.each(componentFiles)(
    "%s has an entry in the /ui-galeria gallery",
    (file) => {
      const gallery = read("src/ui-gallery/ui-gallery.tsx");
      const name = file.replace(TSX, "");
      expect(gallery).toContain(
        `from "@/ui/${ON_DEMAND_LOADER[name] ?? name}"`
      );
    }
  );

  it.each(["radio-group.tsx", "checkbox.tsx"])(
    "%s grows to a touch area of at least 44 px with touch (18 + 2 × 13 = 44 px inside the 1 px border; measured in e2e-pwa/ui-components)",
    (file) => {
      expect(read(`src/ui/${file}`)).toContain("touch:after:-inset-3.5");
    }
  );

  it("nothing under src/ imports axe-core (a test tool, development only)", () => {
    const sources = (dir: string): string[] =>
      readdirSync(join(web, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? sources(`${dir}/${entry.name}`)
          : [`${dir}/${entry.name}`]
      );
    const importers = sources("src").filter((path) =>
      AXE_IMPORT.test(readFileSync(join(web, path), "utf8"))
    );
    expect(importers).toEqual([]);
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

  it.each(["popover.tsx", "dropdown-menu.tsx", "select.tsx", "tooltip.tsx"])(
    "%s keeps the shadcn animation (zoom, slide by side, 100 ms) at the full level of motion (none on a phone, t386)",
    (file) => {
      const source = read(`src/ui/${file}`);
      for (const part of [
        "motion-full:data-open:animate-in",
        "data-open:zoom-in-95",
        "motion-full:data-closed:animate-out",
        "data-closed:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[side=top]:slide-in-from-bottom-2",
        "motion-full:duration-100",
      ]) {
        expect(source, part).toContain(part);
      }
    }
  );

  it("the filter bar does not import motion: its animated layer comes by import(), only at the full level of motion (t386)", () => {
    const source = read("src/ui/filter-bar.tsx");
    expect(source).not.toMatch(MOTION_IMPORT);
    expect(source).toContain('import("./filter-bar-motion")');
  });

  it("names the toast viewport in Portuguese", () => {
    expect(read("src/ui/toast.tsx")).toMatch(TOAST_VIEWPORT_NAMED);
  });

  it("declares the same browser floor to the build and in browserslist", () => {
    const manifest = JSON.parse(
      readFileSync(join(web, "package.json"), "utf8")
    );
    const asBrowserslist = BROWSER_TARGET.map((target) => {
      const [, name, version] = ESBUILD_TARGET.exec(target) ?? [];
      return `${name === "ios" ? "ios_saf" : name} >= ${version}`;
    });
    expect(manifest.browserslist).toEqual(asBrowserslist);
    expect(BROWSER_TARGET).toEqual(
      expect.arrayContaining(["chrome111", "firefox128", "safari16.4"])
    );
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

  it("each dependency knip is told to ignore is still imported by the CSS entry (knip does not read CSS)", () => {
    const knip = JSON.parse(readFileSync(join(web, "../../knip.json"), "utf8"));
    const ignored: string[] = knip.workspaces["apps/web"].ignoreDependencies;
    const entry = readFileSync(join(web, "src/styles/index.css"), "utf8");
    for (const name of ignored.filter((item) => item !== "cloudflare")) {
      expect(entry).toContain(`"${name}`);
    }
  });

  it("the patterns catch what they are for", () => {
    expect("color: #fff;").toMatch(NOT_OKLCH);
    expect("bg-[rgb(0_0_0)]").toMatch(NOT_OKLCH);
    expect("oklch(0.2 0.005 85 / 0.4)").not.toMatch(NOT_OKLCH);
    expect('import { X } from "lucide-react"').toMatch(WHOLE_LUCIDE);
    expect('const a = "https://x/#fff"; // note'.replace(COMMENT, "")).toMatch(
      NOT_OKLCH
    );
  });
});
