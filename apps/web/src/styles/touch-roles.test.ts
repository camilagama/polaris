import { readFileSync } from "node:fs";
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
