import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";

/**
 * The size of a control by its role (DESIGN.md, "Tamanho de controle por papel"): the tokens and utilities of
 * `theme.css` and the `xl` step of the button. The browser measures the same on the gallery
 * (`e2e-pwa/ui-components.e2e.ts`); this reads the source so a change of a number fails here first.
 */
const theme = readFileSync(
  fileURLToPath(new URL("./theme.css", import.meta.url)),
  "utf8"
);

const TOUCH_BLOCK =
  /@media \(pointer: coarse\), \(max-width: 759\.98px\) \{\s*:root \{([^}]*)\}/;

function tokenIn(css: string, name: string) {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1];
}

function utilityBody(name: string) {
  const start = theme.indexOf(`@utility ${name} {`);
  const end = theme.indexOf("\n}\n", start);
  return theme.slice(start, end);
}

describe("heights by role", () => {
  const touch = TOUCH_BLOCK.exec(theme)?.[1] ?? "";
  const mouse = theme.slice(0, theme.indexOf(".dark {"));

  it("the common control is 32 px with a mouse and 36 with touch", () => {
    expect(tokenIn(mouse, "--h-md")).toBe("2rem");
    expect(tokenIn(touch, "--h-md")).toBe("2.25rem");
  });

  it("the main action of a screen is 36 px with a mouse and 44 with touch", () => {
    expect(tokenIn(mouse, "--h-xl")).toBe("2.25rem");
    expect(tokenIn(touch, "--h-xl")).toBe("2.75rem");
    expect(theme).toContain("--spacing-ctl-xl: var(--h-xl);");
  });

  it("the button has the `xl` step on that token, and only that step", () => {
    expect(buttonVariants({ size: "xl" })).toContain("h-ctl-xl");
    for (const size of ["default", "lg", "sm", "xs"] as const) {
      expect(buttonVariants({ size })).not.toContain("h-ctl-xl");
    }
  });

  it("`h-ctl-xl` is a height for the class merger: it yields to a later height", () => {
    expect(cn("h-ctl-xl", "h-auto")).toBe("h-auto");
    expect(cn("h-ctl-md", "h-ctl-xl")).toBe("h-ctl-xl");
  });
});

describe("touch area", () => {
  it("`touch-hit` reaches 44 px around a smaller control, not 48", () => {
    const body = utilityBody("touch-hit");
    expect(body).toContain("inset: min(0px, calc(50% - 22px));");
    expect(body).not.toContain("24px");
  });

  it("`touch-hit-field` reaches 44 px too, on the sides it has", () => {
    const body = utilityBody("touch-hit-field");
    expect(body).toContain("inset: min(0px, calc(50% - 22px)) 0;");
    expect(body).not.toContain("24px");
  });

  it("the controls of a group can drop the area: the day of a month grid does", () => {
    const calendar = readFileSync(
      fileURLToPath(new URL("../ui/calendar.tsx", import.meta.url)),
      "utf8"
    );
    expect(calendar).toContain("before:content-none!");
  });
});

const SRC = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const MIN_HEIGHT = /min-h-/;

/** Every `.ts`/`.tsx` of `src/` that is not a test, as paths under `src/`. */
function sourceFiles(directory = ""): string[] {
  return readdirSync(join(SRC, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
        ? [path]
        : [];
    }
  );
}

/** A size of 48 px with touch: `h`, `w`, `size`, `min-` and `max-` of `-12`, `-[48px]` or `-[3rem]`, under any other variant, with or without `!`. */
const TOUCH_48 =
  /touch:(?:[^\s"'`:]+:)*!?(?:min-|max-)?(?:h|w|size)-(?:12|\[(?:48px|3rem)\])!?(?![\w.[])/;

describe("no 48 px with touch", () => {
  it("the matcher sees the forms that leaked before and lets 44 through", () => {
    for (const leaked of [
      "touch:h-12",
      "touch:min-h-12",
      "touch:size-12",
      "touch:w-12",
      "data-[size=default]:touch:h-12",
      "touch:group-data-[collapsible=icon]:size-12",
      "touch:data-[size=default]:h-12",
      "touch:has-[>[data-align=inline-end]]:h-12",
      "touch:[&_svg]:size-12",
      "touch:aria-[invalid=true]:h-12",
      "touch:!h-12",
      "touch:h-12!",
      "touch:max-h-12",
      "touch:h-[48px]",
      "touch:min-h-[3rem]",
    ]) {
      expect(TOUCH_48.test(`flex ${leaked} items-center`), leaked).toBe(true);
    }
    for (const fine of [
      "touch:h-11",
      "touch:min-h-11",
      "touch:size-11",
      "touch:h-120",
      "touch:h-[44px]",
      "touch:data-[size=default]:h-11",
    ]) {
      expect(TOUCH_48.test(`flex ${fine} items-center`), fine).toBe(false);
    }
  });

  it("no file of src/ writes one", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((file) =>
      TOUCH_48.test(readFileSync(join(SRC, file), "utf8"))
    );
    expect(found).toEqual([]);
  });
});

describe("fields and the main action on touch", () => {
  const ui = (name: string) => readFileSync(join(SRC, "ui", name), "utf8");

  it("the text field and the select are 44 px with touch, the multi-line group is not", () => {
    expect(ui("input-group.tsx")).toContain("h-ctl-md touch:h-11");
    expect(ui("select.tsx")).toContain("data-[size=default]:touch:h-11");
    expect(cn("h-ctl-md touch:h-11", "h-auto touch:h-auto items-stretch")).toBe(
      "h-auto touch:h-auto items-stretch"
    );
    for (const file of [
      "inventory/stock-panel-fields.tsx",
      "sales/sale-reason-fields.tsx",
    ]) {
      expect(readFileSync(join(SRC, file), "utf8")).toContain(
        "h-auto touch:h-auto items-stretch"
      );
    }
  });

  it("the plain button stays 36 px with touch and takes no minimum height", () => {
    expect(buttonVariants({ size: "default" })).toContain("h-ctl-md");
    expect(buttonVariants({ size: "default" })).not.toMatch(MIN_HEIGHT);
    expect(buttonVariants({ size: "default" })).toContain("touch-hit");
  });
});
