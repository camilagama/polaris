import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AreaChart } from "./area-chart";
import { Sparkline } from "./sparkline";

/**
 * The markup of what Polaris adds around the blocks of Bklit UI (ADR 0103, amendment "Gráficos"): the name and
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
const LEGEND = /<ul[^>]*data-chart-legend[\s\S]*?<\/ul>/;
const note = (index: number) =>
  index === 6 ? "inclui R$ 100,00 de despesas" : null;
const plain = (value: number) => `R$ ${String(value).replace(".", ",")}`;
const OKLCH_OR_HEX = /oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
/** The text of a piece of markup, read tag by tag (not by a regular expression that strips them: it can leave a `<script`). */
function text(markup: string) {
  let out = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
    } else if (!inTag) {
      out += char;
    }
  }
  return out.replaceAll("&#x27;", "'");
}

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

describe("AreaChart: a quiet chart (Vendas por dia do Início)", () => {
  const before = WEEK.map((day) => ({ ...day, value: day.value / 2 }));
  const quiet = html(
    <AreaChart
      data={WEEK}
      formatValue={money}
      label="Vendas líquidas por dia"
      name="Vendas"
      readingAtRest={false}
      secondary={{
        data: before,
        legend: "7 dias antes",
        name: "7 dias antes",
        subtle: true,
      }}
      valueLabels="peak"
    />
  );

  it("shows no reading line at rest: nothing sits above the drawing", () => {
    expect(quiet).not.toContain("data-chart-reading");
    // the keyboard control still speaks both values of the day in focus
    expect(quiet.match(RANGE)?.[0]).toContain(
      'aria-valuetext="23/10: Vendas R$ 520,00, 7 dias antes R$ 260,00"'
    );
  });

  it("names the faint line by no legend: the help of the block and the reading of a day say it", () => {
    expect(quiet).not.toContain("data-chart-legend");
  });

  it("keeps the reading line by default, as the Resultado has it", () => {
    expect(
      html(<AreaChart data={WEEK} formatValue={money} label="x" />)
    ).toContain("data-chart-reading");
  });
});

describe("AreaChart: a second series with unknown days (AC-9 of the Resultado, emenda de 25/10)", () => {
  const UNKNOWN = {
    legend: "dia sem custo informado",
    text: "sem custo informado",
  };
  const costs = WEEK.map((day, index) => ({
    label: day.label,
    value: index === 6 || index === 2 ? null : day.value * 2,
  }));
  const markup = html(
    <AreaChart
      data={WEEK}
      formatValue={money}
      label="Vendas e custos"
      legend="Vendas líquidas"
      name="Vendas"
      secondary={{
        data: costs,
        legend: "Custos",
        name: "Custos",
        unknown: UNKNOWN,
      }}
    />
  );

  it("reads the unknown day in words, never as R$ 0,00", () => {
    const reading = text(markup.match(READING)?.[0] ?? "");
    expect(reading).toBe(
      "23/10 · Vendas R$ 520,00 · Custos: sem custo informado"
    );
    expect(reading).not.toContain("R$ 0,00");
  });

  it("speaks the unknown day in words through the keyboard control", () => {
    expect(markup.match(RANGE)?.[0]).toContain(
      'aria-valuetext="23/10: Vendas R$ 520,00, Custos: sem custo informado"'
    );
  });

  it("names the hatch in the legend, beside the two lines", () => {
    const legend = markup.match(LEGEND)?.[0] ?? "";
    expect(text(legend)).toBe("Vendas líquidasCustosdia sem custo informado");
    expect(legend).toContain('stroke="var(--chart-unknown)"');
    expect(legend).not.toMatch(OKLCH_OR_HEX);
  });

  it("does not name the cost line when no day is known: only the hatch", () => {
    const none = html(
      <AreaChart
        data={WEEK}
        formatValue={money}
        label="Vendas e custos"
        secondary={{
          data: WEEK.map((day) => ({ label: day.label, value: null })),
          legend: "Custos",
          name: "Custos",
          unknown: UNKNOWN,
        }}
      />
    );
    expect(text(none.match(LEGEND)?.[0] ?? "")).toBe(
      "Vendasdia sem custo informado"
    );
  });

  it("has no hatch in the legend when every day is known", () => {
    const known = html(
      <AreaChart
        data={WEEK}
        formatValue={money}
        label="Vendas e custos"
        secondary={{
          data: WEEK,
          legend: "Custos",
          name: "Custos",
          unknown: UNKNOWN,
        }}
      />
    );
    expect(known).not.toContain("data-chart-legend-unknown");
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
