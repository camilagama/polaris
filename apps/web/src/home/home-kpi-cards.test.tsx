import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { KpiCards, NoFiguresCards } from "./home-kpi-cards";
import type { HomeFigures } from "./use-home";

/**
 * The cards of the Início, closed (the static render is the first paint): the month said once, no date at rest on
 * Vendas hoje, one line of support, one (i) a card and one column on a phone. Reading a day, the (i) opening and the
 * layout at 360 and 1280 px are in the e2e (e2e-pwa/ui-home-kpis.e2e.ts).
 */

const TODAY = "2026-10-23";

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
  todayReturned = false,
}: {
  unknownCostDays?: readonly string[];
  todayReturned?: boolean;
  todaySold?: boolean;
} = {}): HomeFigures {
  const sold = (net: string, result: string) => (date: string) => ({
    netSales: net,
    operatingResult: unknownCostDays.includes(date) ? null : result,
    costs: unknownCostDays.includes(date) ? null : "5.00",
    salesCount: 1,
  });
  const returned = (date: string): Partial<Day> =>
    todayReturned && date === TODAY
      ? { netSales: "-8.00", operatingResult: "-8.00", salesCount: 0 }
      : {};
  const month = days("2026-10-01", "2026-10-31", (date) =>
    date <= TODAY && (todaySold || date < TODAY)
      ? sold("20.00", "15.00")(date)
      : returned(date)
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

describe("a coluna e os quatro cartões", () => {
  it("é uma coluna até 759 px, duas a partir de 760 e quatro a partir de 1280", () => {
    expect(render(figures())).toContain(
      "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:gap-4"
    );
  });

  it("não tem linha de grupo nem data própria em repouso: o mês está no nome e o período no (i)", () => {
    const markup = render(figures());
    expect(markup).not.toContain("data-kpi-group");
    expect(markup).not.toContain('role="group"');
    expect(markup).not.toContain("data-kpi-date");
    expect(markup).not.toContain("outubro inteiro");
    expect(markup.match(/role="region"/g)).toHaveLength(4);
  });

  it("o nome do cartão de vendas do mês diz o mês, à vista; os outros dois ficam com o nome de sempre", () => {
    const markup = render(figures());
    expect(words(card(markup, "home-month"))).toContain("Vendas em outubro");
    expect(card(markup, "home-result")).toContain("Resultado estimado</a>");
    expect(card(markup, "home-ticket")).toContain(
      '<span class="min-w-0">Ticket médio</span>'
    );
  });

  it("cada cartão tem um minigráfico à direita do número, e a altura é a mesma nos quatro", () => {
    const markup = render(figures());
    expect(markup.match(/data-kpi-spark=""/g)).toHaveLength(4);
    expect(markup.match(/height:36px/g)).toHaveLength(4);
    expect(markup).not.toContain("data-kpi-foot");
  });
});

const CLASS_ATTRIBUTE = /class="([^"]*)"/;

/** The classes of the element that carries `attribute` in a card: the number box, or the R$ inside it. */
function classesWith(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", at);
  return CLASS_ATTRIBUTE.exec(markup.slice(open, at))?.[1] ?? "";
}

const FOUR = ["home-today", "home-month", "home-result", "home-ticket"];

describe("o R$ e o valor têm um padrão só nos quatro cartões", () => {
  it("o valor de Vendas hoje tem as mesmas classes de tamanho dos outros três", () => {
    const rendered = render(figures());
    const sizes = FOUR.map((id) =>
      classesWith(card(rendered, id), "data-kpi-value")
    );
    for (const classes of sizes) {
      expect(classes).toContain("text-value-lg");
      expect(classes).not.toContain("text-value-xl");
      expect(classes).not.toContain("@max-");
    }
    const sorted = sizes.map((classes) => classes.split(" ").sort().join(" "));
    expect(new Set(sorted).size).toBe(1);
  });

  it("o R$ de cada cartão é escrito pelas mesmas classes, menor que o número", () => {
    const rendered = render(figures());
    const currencies = FOUR.map((id) =>
      classesWith(card(rendered, id), "data-money-currency")
    );
    expect(new Set(currencies).size).toBe(1);
    expect(currencies[0]).toContain("text-[0.56em]");
  });
});

describe("Vendas hoje", () => {
  it("não tem data em repouso e diz numa linha só o chip e a contagem", () => {
    const today = card(render(figures()), "home-today");
    expect(today).not.toContain("data-kpi-date");
    expect(words(today)).toContain("+14,3%1 venda");
    expect(words(today)).not.toContain("vs. média");
    expect(words(today)).not.toContain("4 sextas-feiras");
    expect(today).toContain(
      'aria-label="subiu 14,3 por cento em relação à média das sextas"'
    );
  });

  it("diz 'Nenhuma venda ainda' quando hoje não vendeu", () => {
    const today = card(render(figures({ todaySold: false })), "home-today");
    expect(words(today)).toContain("Nenhuma venda ainda");
  });

  it("com só devolução hoje, mostra o líquido negativo e 'Só devoluções até agora'", () => {
    const today = card(
      render(figures({ todayReturned: true, todaySold: false })),
      "home-today"
    );
    expect(words(today)).toContain("Só devoluções até agora");
    expect(words(today)).not.toContain("Nenhuma venda ainda");
    expect(words(today)).toContain("8,00");
  });

  it("sem os números de hoje diz só 'Sem números de hoje'", () => {
    const today = card(render(figures(), false), "home-today");
    expect(words(today)).toContain("Sem números de hoje");
    expect(words(today)).not.toContain("neste aparelho");
  });
});

describe("o cartão do Resultado estimado", () => {
  it("é inteiro um link para o Resultado; o aviso do que não é fica no (i)", () => {
    const result = card(render(figures()), "home-result");
    expect(result).toContain('href="/dashboard"');
    expect(result).toContain("after:absolute after:inset-0");
    expect(words(result)).not.toContain("estimativa incompleta");
    expect(words(result)).not.toContain("Ver o resultado");
    expect(words(result)).not.toContain("Não é lucro líquido nem caixa");
  });

  it("com dias sem custo, o selo e os dias ficam na linha de apoio", () => {
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
    expect(result).toContain('data-kpi-unknown="">5 de 23 dias sem custo<');
    expect(result.indexOf("estimativa incompleta")).toBeLessThan(
      result.indexOf("data-kpi-unknown")
    );
    expect(result).not.toContain("data-kpi-delta=");
  });
});

describe("a ajuda de cada cartão", () => {
  it("cada cartão tem o seu (i), com o nome 'Sobre {título}'", () => {
    const markup = render(figures());
    for (const about of [
      "Vendas hoje",
      "Vendas em outubro",
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

describe("the cards without a connection and without a copy", () => {
  it("are the four, each with its name, '—' and 'Sem conexão', never a zero nor the long sentence", () => {
    const markup = renderToStaticMarkup(<NoFiguresCards today={TODAY} />);
    for (const id of [
      "home-today",
      "home-month",
      "home-result",
      "home-ticket",
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup.match(/Sem conexão/g)).toHaveLength(4);
    expect(markup.match(/sem valor/g)).toHaveLength(4);
    expect(markup).not.toContain("R$");
    expect(markup).not.toContain("Sem internet");
    expect(markup).toContain("Vendas em outubro");
    expect(markup).not.toContain("data-kpi-group");
  });

  it("are as tall as with figures: the number and the support line set the height, not the sparkline", () => {
    const markup = renderToStaticMarkup(<NoFiguresCards today={TODAY} />);
    expect(markup.match(/data-kpi-note-row=""/g)).toHaveLength(4);
    expect(markup.match(/data-kpi-spark=""/g)).toBeNull();
  });
});
