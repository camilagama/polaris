import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_TITLE_MAX } from "@/ui/empty-state";
import { helpTipTextProblem } from "@/ui/help-tip-text";
import { ChartBlock, chartHelp, NumbersTable } from "./home-chart";
import type { ComponentProps } from "react";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";

/**
 * "Vendas por dia", closed (the static render is the first paint): the header with the (i), the total and the period,
 * no line that repeats what the chart says, and the invisible table with every day. The drawing (peak with its date,
 * reading only while a day is read) is in the e2e.
 */

const TODAY = "2026-10-23";

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

// in the month of the chart the 17th sells 100,00, the 18th 1.840,00 and today 320,10; every other day, 50,00
const WEEK: Record<string, string> = {
  "2026-10-17": "100.00",
  "2026-10-18": "1840.00",
  "2026-10-23": "320.10",
};

function summaryOf(
  from: string,
  to: string,
  net: (date: string) => string,
  extra: Record<string, unknown> = {}
) {
  return {
    daily: daily(from, to, net),
    period: { from, to },
    ...extra,
  } as unknown as StoredPeriodSummary;
}

const MONTH = summaryOf(
  "2026-10-01",
  "2026-10-31",
  (date) => WEEK[date] ?? "50.00"
);
const IDLE = summaryOf("2026-10-01", "2026-10-31", () => "0.00");

describe("o bloco Vendas por dia", () => {
  const markup = renderToStaticMarkup(
    <ChartBlock summary={MONTH} today={TODAY} />
  );

  it("tem o (i) no título e não tem mais o segmentado 7 e 30 dias", () => {
    expect(markup).toContain('aria-label="Sobre Vendas por dia"');
    expect(markup).not.toContain('aria-label="Período do gráfico"');
    expect(markup).not.toContain("7 dias");
    expect(markup).not.toContain("30 dias");
  });

  it("diz o total e só o período embaixo, cortado em hoje", () => {
    expect(markup).toContain("1 a 23/10");
    expect(markup).not.toContain("Melhor dia");
    expect(markup).not.toContain("Vendas líquidas de");
  });

  it("não tem 'Ver os números': os números são uma tabela invisível, fora do cabeçalho", () => {
    expect(markup).not.toContain("Ver os números");
    expect(markup).toContain('data-chart-data-table="hidden"');
  });

  it("um mês passado mostra o mês inteiro, não o corte em hoje", () => {
    const september = summaryOf("2026-09-01", "2026-09-30", () => "50.00");
    const past = renderToStaticMarkup(
      <ChartBlock summary={september} today={TODAY} />
    );
    expect(past).toContain("1 a 30/09");
    expect(past.match(/<th[^>]*scope="row"/g)).toHaveLength(30);
  });

  it("acima de 62 dias vem por mês, com o nome e a ajuda do mês", () => {
    const year = {
      daily: [
        {
          date: "2026-01-01",
          days: 31,
          netSales: "900.00",
          salesCount: 9,
          to: "2026-01-31",
          unknownDays: 0,
        },
        {
          date: "2026-02-01",
          days: 28,
          netSales: "800.00",
          salesCount: 8,
          to: "2026-02-28",
          unknownDays: 0,
        },
      ],
      granularity: "month",
      period: { from: "2026-01-01", to: "2026-02-28" },
    } as unknown as StoredPeriodSummary;
    const grouped = renderToStaticMarkup(
      <ChartBlock summary={year} today={TODAY} />
    );
    expect(grouped).toContain("Vendas por mês");
    expect(grouped).toContain("janeiro de 2026");
    expect(grouped).toContain("fevereiro de 2026");
    expect(grouped.match(/<th[^>]*scope="row"/g)).toHaveLength(2);
    expect(grouped).toContain('aria-label="Sobre Vendas por mês"');
  });
});

const EMPTY_TITLE = /data-empty-title="" id="[^"]*">([^<]*)</;
const BOX_HEIGHT = /data-chart-(?:empty|loading)[^>]*style="height:(\d+)px"/;
const ZERO_TOTAL = /R\$\s0,00/;
const boxHeight = (markup: string) => Number(BOX_HEIGHT.exec(markup)?.[1]);

describe("o período sem venda", () => {
  it("a caixa do gráfico fica, com a frase e o chão dentro dela, e guarda a altura que o gráfico terá (a prova de que é a mesma do gráfico pronto está no e2e)", () => {
    const empty = renderToStaticMarkup(
      <ChartBlock summary={IDLE} today={TODAY} />
    );
    const sold = renderToStaticMarkup(
      <ChartBlock summary={MONTH} today={TODAY} />
    );
    expect(empty).toContain("data-chart-empty");
    expect(empty).toContain("Sem vendas no período.");
    expect(empty).toContain("data-empty-state");
    expect(empty).toContain('role="status"');
    expect(EMPTY_TITLE.exec(empty)?.[1]?.length).toBeLessThanOrEqual(
      EMPTY_TITLE_MAX
    );
    expect(empty).toContain("data-chart-floor");
    expect(sold).not.toContain("Sem vendas no período.");
    expect(boxHeight(empty)).toBe(240);
    expect(boxHeight(empty)).toBe(boxHeight(sold));
  });

  it("o total e o período continuam no bloco, sem 'Ver os números'", () => {
    const empty = renderToStaticMarkup(
      <ChartBlock summary={IDLE} today={TODAY} />
    );
    expect(empty).toMatch(ZERO_TOTAL);
    expect(empty).toContain("1 a 23/10");
    expect(empty).not.toContain("Ver os números");
  });
});

const ROWS = /<tr/g;
const COLUMN_HEADERS = /<th[^>]*scope="col"/g;
const FOCUSABLE_IN_TABLE = /<table[\s\S]*(?:tabindex|<button|<a )/;
const ROW_HEADERS = /<th[^>]*scope="row"/g;

describe("a tabela invisível dos números (AC-6.1)", () => {
  const month = renderToStaticMarkup(
    <ChartBlock summary={MONTH} today={TODAY} />
  );

  it("a tabela está no bloco, com legenda, um dia por linha e as duas colunas", () => {
    expect(month).toContain("<table");
    expect(month).toContain("<caption");
    expect(month).toContain("do período mostrado");
    expect(month.match(COLUMN_HEADERS)).toHaveLength(2);
    // the header and one row a day up to today
    expect(month.match(ROWS)).toHaveLength(24);
    expect(month.match(ROW_HEADERS)).toHaveLength(23);
    expect(month).toContain("01/10/2026");
    expect(month).toContain("23/10/2026");
    expect(month).not.toContain("24/10/2026");
    expect(month).toContain("1.840,00");
    expect(month).toContain("320,10");
  });

  it("nenhuma célula da tabela entra na ordem de foco", () => {
    expect(month).not.toMatch(FOCUSABLE_IN_TABLE);
  });

  it("é a mesma tabela, à vista, quando o gráfico não abre", () => {
    const rows = [
      {
        key: "2026-10-23",
        label: "23/10",
        netSales: "320.10",
        tableLabel: "23/10/2026",
      },
    ] as unknown as ComponentProps<typeof NumbersTable>["rows"];
    const shown = renderToStaticMarkup(
      <NumbersTable grouped={false} id="numbers" rows={rows} visible />
    );
    expect(shown).toContain('data-chart-data-table="visible"');
    expect(shown).not.toContain('data-chart-data-table="hidden"');
    expect(shown.match(ROWS)).toHaveLength(2);
  });
});

describe("a ajuda do bloco", () => {
  it("diz como ler um dia, dentro do limite, e não fala de linha tracejada", () => {
    const text = chartHelp(false);
    expect(text).toBe(
      "Vendas líquidas de cada dia do período. Toque num dia para ver o valor."
    );
    expect(text).not.toContain("tracejada");
    expect(helpTipTextProblem(text)).toBeNull();
  });

  it("por mês, fala do mês", () => {
    const text = chartHelp(true);
    expect(text).toContain("cada mês");
    expect(helpTipTextProblem(text)).toBeNull();
  });
});
