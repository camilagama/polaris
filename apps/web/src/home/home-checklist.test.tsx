import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { currentFirstStep } from "../app-shell/first-steps";
import { ChecklistBlock } from "./home-figures";

const items = (html: string) =>
  [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]);

const CIRCLE = /<span aria-hidden="true"[^>]*>/;

const circle = (item: string) => CIRCLE.exec(item)?.[0] ?? "";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function render(firstProductId: string | null) {
  return items(
    renderToStaticMarkup(
      <ChecklistBlock checklist={{ firstProductId, hasStock: false }} />
    )
  );
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
  it("with no product: only the second step is current, and it keeps its number", () => {
    const rows = render(null);
    expect(rows.map((row) => row.includes('aria-current="step"'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(circle(rows[1] as string)).toContain("border-mark");
    expect(circle(rows[1] as string)).toContain("text-mark-foreground");
    expect(text(rows[1] as string)).toContain("2 Cadastrar o 1º produto");
  });

  it("with a product: only the third step is current", () => {
    const rows = render("p1");
    expect(rows.map((row) => row.includes('aria-current="step"'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(text(rows[2] as string)).toBe("3 Fazer a 1ª venda");
  });

  it("a done step keeps the ink, the check and the words for the screen reader, never the mark", () => {
    const rows = render("p1");
    for (const row of rows.slice(0, 2)) {
      expect(circle(row)).toContain("bg-primary");
      expect(circle(row)).not.toContain("border-mark");
      expect(row).toContain("<svg");
      expect(row).toContain("(feito)");
      expect(row).not.toContain("aria-current");
    }
  });

  it("a future step has its number, no mark and no aria-current", () => {
    const rows = render(null);
    const future = rows[2] as string;
    expect(text(future)).toBe("3 Fazer a 1ª venda");
    expect(circle(future)).not.toContain("text-mark-foreground");
    expect(circle(future)).not.toContain("border-mark");
    expect(future).not.toContain("aria-current");
    expect(future).not.toContain("(feito)");
  });
});
