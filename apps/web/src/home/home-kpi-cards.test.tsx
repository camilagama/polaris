import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { KpiCards } from "./home-kpi-cards";
import type { HomeFigures } from "./use-home";

/**
 * The cards of the Início, closed (the static render is the first paint): the month said once, no date at rest on
 * Vendas hoje, one line of support, one (i) a card and one column on a phone. Reading a day, the (i) opening and the
 * layout at 360 and 1280 px are in the e2e (e2e-pwa/ui-home-kpis.e2e.ts).
 */

const TODAY = "2026-10-23";
const GROUP_LINE = /^Outubro · 1 a 23\/10/;

interface Day {
  costs: string | null;
  date: string;
  netSales: string;
  operatingExpenses: string;
  operatingResult: string | null;
  salesCount: number;
}

function days(from: string, to: string, pick: (date: string) => Partial<Day>) {
  const out: Day[] = [];
  for (
    let moment = Date.parse(`${from}T00:00:00Z`);
    moment <= Date.parse(`${to}T00:00:00Z`);
    moment += 86_400_000
  ) {
    const date = new Date(moment).toISOString().slice(0, 10);
    out.push({
      costs: "10.00",
      date,
      netSales: "0.00",
      operatingExpenses: "0.00",
      operatingResult: "0.00",
      salesCount: 0,
      ...pick(date),
    });
  }
  return out;
}

/** October to the 23rd at 20,00 a day against September at 10,00; `unknownCostDays` have no cost informed. */
function figures({
  unknownCostDays = [],
  todaySold = true,
}: {
  unknownCostDays?: readonly string[];
  todaySold?: boolean;
} = {}): HomeFigures {
  const sold = (net: string, result: string) => (date: string) => ({
    netSales: net,
    operatingResult: unknownCostDays.includes(date) ? null : result,
    costs: unknownCostDays.includes(date) ? null : "5.00",
    salesCount: 1,
  });
  const month = days("2026-10-01", "2026-10-31", (date) =>
    date <= TODAY && (todaySold || date < TODAY)
      ? sold("20.00", "15.00")(date)
      : {}
  );
  const before = days("2026-09-01", "2026-09-30", sold("10.00", "5.00"));
  const known = unknownCostDays.length;
  return {
    before: {
      cards: { netSales: "300.00", operatingResult: "150.00", salesCount: 30 },
      daily: before,
      period: { from: "2026-09-01", to: "2026-09-30" },
      quality: { itemLines: 30, itemLinesWithUnknownCost: 0 },
    } as unknown as StoredPeriodSummary,
    month: {
      cards: {
        marginPercent: "70.00",
        netSales: "460.00",
        operatingResult: "345.00",
        salesCount: 23,
        ticket: "20.00",
      },
      daily: month,
      generatedAt: "2026-10-23T15:00:00.000Z",
      period: { from: "2026-10-01", to: "2026-10-31" },
      quality: {
        itemLines: 23,
        itemLinesWithUnknownCost: known > 0 ? 1 : 0,
        level: known > 0 ? "partial" : "complete",
      },
    } as unknown as StoredPeriodSummary,
    today: TODAY,
  };
}

const render = (value: HomeFigures, todayShown = true) =>
  renderToStaticMarkup(<KpiCards figures={value} todayShown={todayShown} />);

/** The markup of one card, from its id to the next card. */
function card(markup: string, id: string): string {
  const start = markup.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('id="home-', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
}

/** The text of a piece of markup, tag by tag. */
function words(markup: string): string {
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
  return out.replace(/\s+/g, " ").trim();
}

describe("a coluna e o grupo do mês", () => {
  it("é uma coluna até 759 px, duas a partir de 760 e quatro a partir de 1024", () => {
    expect(render(figures())).toContain(
      "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 lg:gap-4"
    );
  });

  it("diz o mês e o período uma vez, no grupo dos três cartões, e nomeia o grupo", () => {
    const markup = render(figures());
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Outubro, 1 a 23/10"');
    expect(markup).toContain("data-kpi-group");
    const line = markup.slice(
      markup.lastIndexOf("<p", markup.indexOf("data-kpi-group"))
    );
    expect(words(line)).toMatch(GROUP_LINE);
    // none of the cards repeats the period: no card has a date of its own
    expect(markup).not.toContain("data-kpi-date");
  });

  it("não tira o mês do nome da região: o leitor de tela ouve 'Vendas em outubro'", () => {
    const month = card(render(figures()), "home-month");
    expect(month).toContain('Vendas<span class="sr-only"> em outubro</span>');
  });

  it("os títulos são Vendas, Resultado estimado e Ticket médio", () => {
    const markup = render(figures());
    expect(card(markup, "home-result")).toContain("Resultado estimado");
    expect(card(markup, "home-ticket")).toContain("Ticket médio");
  });

  it("o resultado só leva data própria quando é de outro período: 'outubro inteiro'", () => {
    const markup = render(figures({ unknownCostDays: ["2026-10-05"] }));
    expect(card(markup, "home-result")).toContain("outubro inteiro");
    expect(markup.match(/data-kpi-date/g)).toHaveLength(1);
  });
});

describe("Vendas hoje", () => {
  it("não tem data em repouso e diz numa linha só com o que compara e a contagem", () => {
    const today = card(render(figures()), "home-today");
    expect(today).not.toContain("data-kpi-date");
    expect(words(today)).toContain("vs. média das sextas · 1 venda");
    // the explanation is the help's, which opens by touch
    expect(words(today)).not.toContain("4 sextas-feiras");
    // 20,00 against the mean of 3 x 20,00 and 1 x 10,00; the base is in sight, so the chip has no name of its own
    expect(words(today)).toContain("+14,3%");
    expect(today).not.toContain('role="img"');
  });

  it("diz 'Nenhuma venda ainda' quando hoje não vendeu", () => {
    const today = card(render(figures({ todaySold: false })), "home-today");
    expect(words(today)).toContain("Nenhuma venda ainda");
  });

  it("sem os números de hoje diz só 'Sem números de hoje'", () => {
    const today = card(render(figures(), false), "home-today");
    expect(words(today)).toContain("Sem números de hoje");
    expect(words(today)).not.toContain("neste aparelho");
  });
});

describe("o cartão do Resultado estimado", () => {
  it("com todos os dias com custo, diz o que não é, em uma linha, e leva ao Resultado", () => {
    const result = card(render(figures()), "home-result");
    expect(words(result)).toContain("Não é lucro líquido nem caixa");
    expect(words(result)).not.toContain("estimativa incompleta");
    expect(result).toContain('href="/dashboard"');
    expect(words(result)).toContain("Ver o resultado");
  });

  it("com dias sem custo, o selo e os dias ficam na mesma linha, e a ressalva logo abaixo", () => {
    const result = card(
      render(
        figures({
          unknownCostDays: [
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
            "2026-10-08",
            "2026-10-09",
          ],
        })
      ),
      "home-result"
    );
    expect(words(result)).toContain("estimativa incompleta");
    expect(result).toContain('data-kpi-unknown="">· 5 de 23 dias sem custo<');
    expect(words(result)).toContain("Não é lucro líquido nem caixa");
    expect(result.indexOf("data-kpi-unknown")).toBeLessThan(
      result.indexOf("Não é lucro líquido nem caixa")
    );
  });
});

describe("a ajuda de cada cartão", () => {
  it("cada cartão tem o seu (i), com o nome 'Sobre {título}'", () => {
    const markup = render(figures());
    for (const about of [
      "Vendas hoje",
      "Vendas",
      "Resultado estimado",
      "Ticket médio",
    ]) {
      expect(markup).toContain(`aria-label="Sobre ${about}"`);
    }
    expect(markup.match(/data-slot="help-tip"/g)).toHaveLength(4);
  });

  it("o ticket não tem linha de apoio em repouso: só o chip", () => {
    const ticket = card(render(figures()), "home-ticket");
    expect(words(ticket)).not.toContain("Média por venda");
  });
});
