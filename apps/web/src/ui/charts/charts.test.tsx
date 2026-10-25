import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AreaChart } from "./area-chart";
import { Sparkline } from "./sparkline";

/**
 * The markup of what Polaris adds around the blocks of Bklit UI (ADR 0103, amendment "Gráficos", t336): the name and
 * the summary a screen reader gets, the reading line, the legend, the keyboard control and the empty state. The blocks
 * measure their box with a ResizeObserver, so the plot itself has no width on the server and is not in this markup:
 * what the browser draws (the reveal, the tooltip with the value in pt-BR, the arrows moving the point in focus, the
 * reduced motion, the colors) is measured by e2e-pwa/ui-charts.e2e.ts, in the gallery.
 */
const WEEK = [
  { label: "17/10", value: 120 },
  { label: "18/10", value: 340 },
  { label: "19/10", value: 90 },
  { label: "20/10", value: 1840 },
  { label: "21/10", value: 760 },
  { label: "22/10", value: 0 },
  { label: "23/10", value: 520 },
];

const money = (value: number) => `R$ ${value},00`;
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const IMG = /<div[^>]*role="img"[^>]*>/;
const ARIA_LABEL = /aria-label="([^"]*)"/;
const RANGE = /<input[^>]*type="range"[^>]*>/;
const READING = /<p[^>]*data-chart-reading=""[^>]*>(.*?)<\/p>/;
const TAGS = /<[^>]+>/g;
const LEGEND = /<ul[^>]*data-chart-legend[\s\S]*?<\/ul>/;
const note = (index: number) =>
  index === 6 ? "inclui R$ 100,00 de despesas" : null;
const plain = (value: number) => `R$ ${String(value).replace(".", ",")}`;
const OKLCH_OR_HEX = /oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
const text = (markup: string) =>
  markup.replace(TAGS, "").replaceAll("&#x27;", "'");

describe("AreaChart", () => {
  const markup = html(
    <AreaChart
      data={WEEK}
      formatValue={money}
      label="Vendas líquidas por dia, de 17/10 a 23/10"
    />
  );

  it("is an image named by its summary", () => {
    const image = markup.match(IMG)?.[0] ?? "";
    expect(image.match(ARIA_LABEL)?.[1]).toBe(
      "Vendas líquidas por dia, de 17/10 a 23/10"
    );
  });

  it("walks through the points with a range input that speaks the date and the value", () => {
    const input = markup.match(RANGE)?.[0] ?? "";
    expect(input).toContain('aria-label="Dia"');
    expect(input).toContain('aria-valuetext="23/10: R$ 520,00"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="6"');
    expect(input).toContain('value="6"');
    expect(input).toContain("pointer-events-none");
    // the control is a sibling of the image: an image has no interactive children for a screen reader
    expect(markup.indexOf("</div><input")).toBeGreaterThan(
      markup.indexOf('role="img"')
    );
  });

  it("reads the last day in a line above the drawing, not live: the keyboard control speaks it", () => {
    const reading = markup.match(READING)?.[0] ?? "";
    expect(text(reading)).toBe("23/10 R$ 520,00");
    expect(reading).not.toContain("aria-live");
  });

  it("names the keyboard control as the caller says", () => {
    const named = html(
      <AreaChart
        data={WEEK}
        formatValue={money}
        label="x"
        rangeLabel="Dia, últimos 7 dias"
      />
    );
    expect(named.match(RANGE)?.[0]).toContain(
      'aria-label="Dia, últimos 7 dias"'
    );
  });

  it("takes only a token as a color: none written in the markup", () => {
    expect(markup).not.toMatch(OKLCH_OR_HEX);
  });

  it("an empty series is the named floor: no reading, no keyboard control", () => {
    const empty = html(
      <AreaChart data={[]} formatValue={money} label="Vendas, sem dados" />
    );
    expect(empty).toContain('aria-label="Vendas, sem dados"');
    expect(empty).toContain("data-chart-empty");
    expect(empty).not.toContain("data-chart-reading");
    expect(empty).not.toContain("<input");
  });

  it("a single point has one stop on the keyboard control", () => {
    const one = html(
      <AreaChart
        data={[{ label: "23/10", value: 740 }]}
        formatValue={money}
        label="Vendas, um dia"
      />
    );
    expect(one.match(RANGE)?.[0]).toContain('max="0"');
    expect(text(one.match(READING)?.[0] ?? "")).toBe("23/10 R$ 740,00");
  });

  it("speaks the value as the caller formats it, a number only positions the point", () => {
    const odd = html(
      <AreaChart
        data={[
          { label: "22/10", value: -5 },
          { label: "23/10", value: 1234.5 },
        ]}
        formatValue={plain}
        label="x"
      />
    );
    expect(odd.match(RANGE)?.[0]).toContain(
      'aria-valuetext="23/10: R$ 1234,5"'
    );
  });
});

describe("AreaChart: a second series (the costs of the Resultado)", () => {
  const costs = WEEK.map((day) => ({ ...day, value: day.value * 2 }));
  const markup = html(
    <AreaChart
      data={WEEK}
      formatValue={money}
      label="Vendas e custos"
      legend="Vendas líquidas"
      name="Vendas"
      readingNote={note}
      secondary={{ data: costs, legend: "Custos", name: "Custos" }}
    />
  );

  it("names both lines in a legend, each with its own trace, the second one dashed", () => {
    expect(markup).toContain("data-chart-legend");
    const legend = markup.match(LEGEND)?.[0] ?? "";
    expect(text(legend)).toBe("Vendas líquidasCustos");
    expect(legend.match(/stroke-dasharray/g)).toHaveLength(1);
    expect(legend).toContain('stroke="var(--chart-3)"');
  });

  it("reads both values of the day in focus and the note, in a line of text", () => {
    expect(text(markup.match(READING)?.[0] ?? "")).toBe(
      "23/10 · Vendas R$ 520,00 · Custos R$ 1040,00 · inclui R$ 100,00 de despesas"
    );
  });

  it("speaks both values and the note through the keyboard control", () => {
    expect(markup.match(RANGE)?.[0]).toContain(
      'aria-valuetext="23/10: Vendas R$ 520,00, Custos R$ 1040,00, inclui R$ 100,00 de despesas"'
    );
  });

  it("has no legend without the second series", () => {
    expect(
      html(<AreaChart data={WEEK} formatValue={money} label="x" />)
    ).not.toContain("data-chart-legend");
  });
});

describe("Sparkline", () => {
  it("is hidden from a screen reader: the number beside it is the information", () => {
    const markup = html(<Sparkline values={[1, 2, 3]} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<input");
  });

  it("draws nothing without values", () => {
    expect(html(<Sparkline values={[]} />)).toBe("");
  });

  it("takes only a token as a color", () => {
    expect(
      html(<Sparkline color="var(--chart-3)" values={[1, 2, 3]} />)
    ).not.toMatch(OKLCH_OR_HEX);
  });
});
