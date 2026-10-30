import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { helpTipTextProblem } from "@/ui/help-tip-text";
import { ChartBlock, chartHelp, NumbersTable } from "./home-chart";
import { lastDays } from "./home-model";
import type { HomeFigures } from "./use-home";

/**
 * "Vendas por dia", closed (the static render is the first paint): the header with the (i) and the compact selector, the
 * total and the period, no line that repeats what the chart says, and the table with every day and both values. The
 * drawing (peak with its date, faint dashed line, reading only while a day is read) is in the e2e.
 */

const TODAY = "2026-10-23";
const NO_CHANGE = () => undefined;

function daily(from: string, to: string, net: (date: string) => string) {
  const out: Array<{ date: string; netSales: string; salesCount: number }> = [];
  for (
    let moment = Date.parse(`${from}T00:00:00Z`);
    moment <= Date.parse(`${to}T00:00:00Z`);
    moment += 86_400_000
  ) {
    const date = new Date(moment).toISOString().slice(0, 10);
    out.push({ date, netSales: net(date), salesCount: 1 });
  }
  return out;
}

// in the week of the chart the first day sells 100,00, the second 1.840,00 and today 320,10; every other day, 50,00
const WEEK: Record<string, string> = {
  "2026-10-17": "100.00",
  "2026-10-18": "1840.00",
  "2026-10-23": "320.10",
};

const BEFORE = daily("2026-09-01", "2026-09-30", () => "50.00");
const MONTH = daily(
  "2026-10-01",
  "2026-10-31",
  (date) => WEEK[date] ?? "50.00"
);

const figures = {
  before: { daily: BEFORE },
  month: { daily: MONTH },
  today: TODAY,
} as unknown as HomeFigures;

describe("o bloco Vendas por dia", () => {
  const markup = renderToStaticMarkup(
    <ChartBlock days="7" figures={figures} onDays={NO_CHANGE} />
  );

  it("tem o (i) no título e o segmentado 7 e 30 dias no mesmo cabeçalho", () => {
    expect(markup).toContain('aria-label="Sobre Vendas por dia"');
    expect(markup).toContain('aria-label="Período do gráfico"');
    expect(markup).toContain("7 dias");
    expect(markup).toContain("30 dias");
  });

  it("diz o total e só o período embaixo, sem repetir o melhor dia nem 'Vendas líquidas de'", () => {
    expect(markup).toContain("17 a 23/10");
    expect(markup).not.toContain("Melhor dia");
    expect(markup).not.toContain("Vendas líquidas de");
    expect(markup).not.toContain("de 17/10 a 23/10");
  });

  it("tem 'Ver os números' como link pequeno que abre a tabela", () => {
    expect(markup).toContain("Ver os números");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("text-xs");
  });
});

describe("a tabela de 'Ver os números'", () => {
  const series = lastDays(BEFORE, MONTH, TODAY, 7);
  const earlier = lastDays(BEFORE, MONTH, "2026-10-16", 7);

  it("tem todos os dias do período e os dois valores de cada um", () => {
    const table = renderToStaticMarkup(
      <NumbersTable days={7} earlier={earlier} series={series} />
    );
    // the header and one row a day
    expect(table.match(/<tr/g)).toHaveLength(8);
    expect(table).toContain("7 dias antes");
    for (const day of [
      "17/10",
      "18/10",
      "19/10",
      "20/10",
      "21/10",
      "22/10",
      "23/10",
    ]) {
      expect(table).toContain(day);
    }
    expect(table).toContain("1.840,00");
    expect(table).toContain("320,10");
    // the days before, beside each day: 7 values of the column of the week before
    expect(table.match(/R\$ 50,00/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("sem os dias antes lidos, só a coluna do período", () => {
    const table = renderToStaticMarkup(
      <NumbersTable days={30} earlier={null} series={series} />
    );
    expect(table).not.toContain("dias antes");
    expect(table.match(/<tr/g)).toHaveLength(8);
  });
});

describe("a ajuda do bloco", () => {
  it("diz a linha tracejada e como ler um dia, dentro do limite", () => {
    const text = chartHelp(7, true);
    expect(text).toBe(
      "A linha tracejada são os 7 dias anteriores. Toque num dia para ver os dois valores."
    );
    expect(helpTipTextProblem(text)).toBeNull();
    expect(chartHelp(30, true)).toContain("30 dias anteriores");
  });

  it("sem os dias antes, não fala de linha tracejada", () => {
    const text = chartHelp(30, false);
    expect(text).not.toContain("tracejada");
    expect(helpTipTextProblem(text)).toBeNull();
  });
});
