import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { currentFirstStep } from "../app-shell/first-steps";
import { ChecklistBlock } from "./home-figures";

const items = (html: string) =>
  [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]);

const BOX = /<span aria-hidden="true"[^>]*data-step-box[^>]*>/;

const box = (item: string) => BOX.exec(item)?.[0] ?? "";

const LUCIDE = /lucide-([a-z-]+)/;
const DASH_OFFSET = /stroke-dashoffset:([\d.]+)/;

const icon = (item: string) =>
  LUCIDE.exec(item.slice(item.indexOf("data-step-box")))?.[1];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function block(firstProductId: string | null) {
  return renderToStaticMarkup(
    <ChecklistBlock checklist={{ firstProductId, hasStock: false }} />
  );
}

function render(firstProductId: string | null) {
  return items(block(firstProductId));
}

describe("the current step is the first one not done", () => {
  it.each([
    [[true, false, false], 1],
    [[false, true, false], 0],
    [[false, false, true], 0],
    [[true, true, false], 2],
    [[false, false, false], 0],
    [[true, true, true], null],
  ] as const)("%j points at %s", (done, expected) => {
    expect(currentFirstStep(done)).toBe(expected);
  });
});

describe("the checklist of the Início marks the step of the hour", () => {
  it("with no product: only the second step is current, with its icon and its mark", () => {
    const rows = render(null);
    expect(rows.map((row) => row.includes('aria-current="step"'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(box(rows[1] as string)).toContain("border-primary");
    expect(box(rows[1] as string)).toContain("text-primary");
    expect(box(rows[1] as string)).toContain('data-step-box="current"');
    expect(icon(rows[1] as string)).toBe("tag");
    expect(text(rows[1] as string)).toContain("Cadastrar o 1º produto");
  });

  it("with a product: only the third step is current", () => {
    const rows = render("p1");
    expect(rows.map((row) => row.includes('aria-current="step"'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(icon(rows[2] as string)).toBe("shopping-bag");
    expect(text(rows[2] as string)).toBe(
      "Fazer a 1ª venda Diga quantas unidades você tem para poder vender."
    );
  });

  it("a done step has the check in place of the icon, a soft row and the words for the screen reader, never the mark", () => {
    const rows = render("p1");
    for (const row of rows.slice(0, 2)) {
      expect(box(row)).toContain("bg-primary/10");
      expect(box(row)).not.toContain("border-primary");
      expect(icon(row)).toBe("check");
      expect(row).toContain("bg-muted/50");
      expect(row).toContain("text-muted-foreground");
      expect(row).toContain("(feito)");
      expect(row).not.toContain("aria-current");
    }
  });

  it("a future step keeps its icon with a muted frame, no mark and no aria-current", () => {
    const rows = render(null);
    const future = rows[2] as string;
    expect(text(future)).toBe("Fazer a 1ª venda");
    expect(icon(future)).toBe("shopping-bag");
    expect(box(future)).toContain('data-step-box="todo"');
    expect(box(future)).toContain("text-muted-foreground");
    expect(box(future)).not.toContain("border-primary");
    expect(future).not.toContain("bg-muted/50");
    expect(future).not.toContain("aria-current");
    expect(future).not.toContain("(feito)");
  });

  it("the three states differ by shape and words, not only by color: check, icon, icon", () => {
    const rows = render(null);
    expect(rows.map(icon)).toEqual(["check", "tag", "shopping-bag"]);
    expect(rows.map((row) => row.includes("(feito)"))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("every icon is 16 px and sits in a box of 28 px", () => {
    for (const row of render(null)) {
      expect(box(row)).toContain("size-7");
      expect(row).toContain("<svg");
    }
  });
});

describe("the count beside the title", () => {
  it.each([
    [null, "1 de 3", 1],
    ["p1", "2 de 3", 2],
  ] as const)(
    "a product of %s: '%s' written beside a ring of %s thirds",
    (firstProductId, written, done) => {
      const html = block(firstProductId);
      expect(text(html)).toContain(`Primeiros passos ${written}`);
      const offset = DASH_OFFSET.exec(html)?.[1];
      expect(1 - Number(offset) / (2 * Math.PI * 7)).toBeCloseTo(done / 3, 5);
    }
  );
});
