import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AreaChart } from "./area-chart";
import { Sparkline } from "./sparkline";

/**
 * The markup of the charts (ADR 0103, amendment "Gráficos"): the role and the name each one gives the screen reader,
 * the keyboard control and the colors as tokens. The browser checks (e2e-pwa/ui-charts.e2e.ts) run the same ones in
 * the gallery, with axe, the real width and the keyboard.
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

const money = (value: number) => `R$ ${value}`;
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const IMG_SVG = /<svg[^>]*role="img"[^>]*>/;
const ARIA_LABEL = /aria-label="([^"]*)"/;
const RANGE = /<input[^>]*type="range"[^>]*>/;
const OKLCH_OR_HEX = /oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
const STOP_COLORS = /stop-color="([^"]*)"/g;
const SVG_TEXT = /<text[^>]*>([^<]*)<\/text>/g;
const READING_LINE = /<p[^>]*data-chart-reading=""[^>]*>.*23\/10.*R\$ 520/;
const TOP_LABEL_X = /<text[^>]*x="(\d+(?:\.\d+)?)"[^>]*>R\$ 2 mil/;
const abbreviate = (value: number) => `${value / 1000} mil`;

describe("AreaChart", () => {
  const markup = html(
    <AreaChart
      data={WEEK}
      formatValue={money}
      label="Vendas líquidas por dia, de 17/10 a 23/10"
      width={328}
    />
  );

  it("is an image named by its summary", () => {
    const svg = markup.match(IMG_SVG)?.[0] ?? "";
    expect(svg).toContain('role="img"');
    expect(svg.match(ARIA_LABEL)?.[1]).toBe(
      "Vendas líquidas por dia, de 17/10 a 23/10"
    );
  });

  it("walks through the points with a range input that speaks the date and the value", () => {
    const input = markup.match(RANGE)?.[0] ?? "";
    expect(input).toContain('aria-label="Dia"');
    expect(input).toContain('aria-valuetext="23/10: R$ 520"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="6"');
    expect(input).toContain('value="6"');
    expect(input).toContain("pointer-events-none");
  });

  it("reads the day in focus (the last) in a line above the drawing, not live: the keyboard control speaks it", () => {
    expect(markup).toMatch(READING_LINE);
    expect(markup.indexOf("data-chart-reading")).toBeLessThan(
      markup.indexOf("<svg")
    );
    // said once, by the control (Petković, PR 283): a live line would repeat it
    expect(markup).not.toContain("aria-live");
  });

  it("labels the axes: money in the two lines the series fills, four dates on a phone", () => {
    const texts = [...markup.matchAll(SVG_TEXT)].map((match) => match[1]);
    expect(texts).toEqual(expect.arrayContaining(["R$ 1000", "R$ 2000"]));
    expect(texts).not.toContain("R$ 3000");
    expect(texts).toEqual(
      expect.arrayContaining(["17/10", "19/10", "21/10", "23/10"])
    );
    expect(texts).not.toContain("18/10");
  });

  it("marks the best day in the first token and draws the series in the ink", () => {
    expect(markup).toContain('fill="var(--chart-1)"');
    expect(markup).toContain('stroke="var(--chart-5)"');
    expect(markup.match(STOP_COLORS)).toEqual([
      'stop-color="var(--chart-5)"',
      'stop-color="var(--chart-5)"',
    ]);
  });

  it("takes only a token as a color: none written in the markup", () => {
    expect(markup).not.toMatch(OKLCH_OR_HEX);
  });

  it("fades in with the page's fade and no other animation", () => {
    expect(markup).toContain("animate-rise");
    expect(markup).not.toContain("<animate");
  });

  it("draws nothing before the box has a width, and keeps the keyboard control", () => {
    const unmeasured = html(
      <AreaChart data={WEEK} formatValue={money} label="x" />
    );
    expect(unmeasured).not.toContain("<svg");
    expect(unmeasured).toMatch(RANGE);
  });

  it("an empty series has the floor, no reading and no keyboard control", () => {
    const empty = html(
      <AreaChart data={[]} formatValue={money} label="Sem vendas" width={328} />
    );
    expect(empty).toMatch(IMG_SVG);
    expect(empty).not.toContain("data-chart-reading");
    expect(empty).not.toMatch(RANGE);
    expect(empty).not.toContain("NaN");
  });

  it("a single point is a ring and no line", () => {
    const one = html(
      <AreaChart
        data={[{ label: "23/10", value: 500 }]}
        formatValue={money}
        label="Um dia"
        width={328}
      />
    );
    expect(one).toContain("<circle");
    expect(one).not.toContain('fill="none" stroke="var(--chart-5)"');
    expect(one).toContain('max="0"');
  });

  it("all zero draws no labeled line above the floor", () => {
    const zero = html(
      <AreaChart
        data={WEEK.map((day) => ({ ...day, value: 0 }))}
        formatValue={money}
        label="Tudo zero"
        width={328}
      />
    );
    expect([...zero.matchAll(SVG_TEXT)].map((match) => match[1])).toEqual([
      "17/10",
      "19/10",
      "21/10",
      "23/10",
    ]);
    expect(zero).not.toContain("NaN");
  });

  it("uses the axis formatter for the lines and the value formatter for the reading", () => {
    const abbreviated = html(
      <AreaChart
        data={WEEK}
        formatAxis={abbreviate}
        formatValue={money}
        label="x"
        width={328}
      />
    );
    expect(abbreviated).toContain(">1 mil<");
    expect(abbreviated).toContain("R$ 520");
  });
});

describe("AreaChart: the unit of the axis", () => {
  const texts = (axisUnit?: string, data = WEEK) =>
    [
      ...html(
        <AreaChart
          {...(axisUnit ? { axisUnit } : {})}
          data={data}
          formatAxis={abbreviate}
          formatValue={money}
          label="x"
          width={328}
        />
      ).matchAll(SVG_TEXT),
    ].map((match) => match[1] as string);

  it("is written once, on the label of the top line only", () => {
    expect(texts("R$")).toEqual(expect.arrayContaining(["1 mil", "R$ 2 mil"]));
    expect(texts("R$").filter((text) => text.startsWith("R$"))).toHaveLength(1);
  });

  it("is not written without the prop", () => {
    expect(texts()).toEqual(expect.arrayContaining(["1 mil", "2 mil"]));
    expect(texts()).not.toContain("R$ 2 mil");
  });

  it("widens the left margin to the label with the unit, so it fits", () => {
    const x = html(
      <AreaChart
        axisUnit="R$"
        data={WEEK}
        formatAxis={abbreviate}
        formatValue={money}
        label="x"
        width={328}
      />
    ).match(TOP_LABEL_X)?.[1];
    // the label ends 6 px before the plot: 0.58 em of 11 px for each of the 8 characters of "R$ 2 mil", plus 14
    expect(Number(x)).toBe(Math.ceil(8 * 11 * 0.58) + 14 - 6);
  });

  it("is not drawn on an all-zero series, which has no labeled line", () => {
    const zeros = WEEK.map((day) => ({ ...day, value: 0 }));
    expect(texts("R$", zeros).some((text) => text.startsWith("R$"))).toBe(
      false
    );
  });
});

describe("Sparkline", () => {
  const markup = html(<Sparkline values={[3, 5, 4, 9, 7]} width={120} />);

  it("is hidden from a screen reader: the number beside it is the information", () => {
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("role=");
    expect(markup).not.toContain("<text");
    expect(markup).not.toContain("<input");
  });

  it("draws one line with a fade and a dot on the last value, in a token", () => {
    expect(markup).toContain('stroke="var(--chart-5)"');
    expect(markup).toContain('fill="var(--chart-5)"');
    expect(markup.match(/<circle/g)).toHaveLength(1);
    expect(markup).not.toMatch(OKLCH_OR_HEX);
  });

  it("draws nothing without values or before it has a width", () => {
    expect(html(<Sparkline values={[]} width={120} />)).not.toContain("<svg");
    expect(html(<Sparkline values={[1, 2]} />)).not.toContain("<svg");
  });

  it("an all-zero series is a flat line, no NaN", () => {
    const flat = html(<Sparkline values={[0, 0, 0]} width={120} />);
    expect(flat).toContain("<path");
    expect(flat).not.toContain("NaN");
  });
});
