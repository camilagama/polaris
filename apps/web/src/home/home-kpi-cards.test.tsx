import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { KpiCards, KpiCardsSkeleton, NoFiguresCards } from "./home-kpi-cards";
import { THIS_MONTH } from "./home-period";
import { HomePeriodRow } from "./home-period-row";
import { PeriodControlProvider } from "./period-control";
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
    costs: unknownCostDays.includes(date) ? null : "5.00",
    netSales: net,
    operatingResult: unknownCostDays.includes(date) ? null : result,
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
const REORDERING_CLASS = /[\s"](?:[\w-]+:)*order-(?:first|last|\d)/;

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

describe("Vendas do mês sem venda", () => {
  const withoutSales = (): HomeFigures => {
    const base = figures();
    return {
      ...base,
      month: {
        ...base.month,
        cards: { ...base.month.cards, salesCount: 0 },
      },
    };
  };

  it("o vazio do mês traz a ação 'Fazer uma venda' para a Venda", () => {
    const month = card(render(withoutSales()), "home-month");
    expect(month).toContain('href="/sales"');
    expect(words(month)).toContain("Fazer uma venda");
  });

  it("com venda no mês, o cartão não traz a ação", () => {
    expect(card(render(figures()), "home-month")).not.toContain(
      "Fazer uma venda"
    );
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

  it("com dias sem custo, o aviso é a linha de apoio: o sinal e os dias, numa linha só", () => {
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
    expect(words(result)).toContain("Incompleta");
    expect(result).toContain('data-kpi-unknown="">5 de 23 dias sem custo<');
    expect(result.indexOf("Incompleta")).toBeLessThan(
      result.indexOf("data-kpi-unknown")
    );
    expect(result).not.toContain("estimativa incompleta");
    expect(result.match(/data-kpi-note-row/g)).toHaveLength(1);
    expect(result).toContain("h-5 overflow-hidden");
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

describe("o seletor de período na linha acima dos cartões do mês", () => {
  const control = <button type="button">Seletor</button>;
  const withControl = (node: React.ReactNode) =>
    renderToStaticMarkup(
      <PeriodControlProvider value={control}>{node}</PeriodControlProvider>
    );

  it("fica no fim de uma linha só dele, sem o texto do mês", () => {
    const markup = withControl(<KpiCards figures={figures()} />);
    const line = markup.slice(markup.indexOf("data-kpi-group-line"));
    expect(words(line.slice(0, line.indexOf("</div>")))).toBe(
      'data-kpi-group-line=""Seletor'
    );
    expect(markup).toContain("min-h-9");
    expect(markup).not.toContain("Outubro · 1 a 23/10");
  });

  it("o seletor vem entre Hoje e os cartões do mês no DOM, sem classe que mude a ordem visual", () => {
    for (const markup of [
      withControl(<KpiCards figures={figures()} />),
      withControl(<KpiCardsSkeleton />),
      withControl(<NoFiguresCards today={TODAY} />),
    ]) {
      expect(markup).not.toMatch(REORDERING_CLASS);
    }
    const markup = withControl(<KpiCards figures={figures()} />);
    const picker = markup.indexOf("Seletor");
    expect(markup.indexOf("Vendas hoje")).toBeLessThan(picker);
    expect(picker).toBeLessThan(markup.indexOf("Vendas em outubro"));
  });

  it("o esqueleto e o sem conexão guardam a mesma linha, com o seletor no mesmo lugar", () => {
    for (const markup of [
      withControl(<KpiCardsSkeleton />),
      withControl(<NoFiguresCards today={TODAY} />),
    ]) {
      expect(markup).toContain("Seletor");
      expect(markup).toContain("min-h-9");
      expect(markup.match(/Seletor/g)).toHaveLength(1);
    }
  });

  it("sem o seletor não há linha: os cartões não pagam uma fileira vazia", () => {
    const markup = render(figures());
    expect(markup).not.toContain("Seletor");
    expect(markup).not.toContain("data-kpi-group-line");
  });
});

const SALES_IN_SEPTEMBER = /^Vendas em setembro/;
const SALES_OF_PERIOD = /^Vendas do período/;
const CARD_ID = /^id="[^"]*"/;
const SENTENCE = /<p([^>]*)>Sem conexão: só este mês e o anterior\./;
const noop = () => undefined;

describe("o nome do cartão de Vendas em cada período", () => {
  const periodOf = (from: string, to: string) =>
    renderToStaticMarkup(
      <PeriodControlProvider value={<button type="button">Seletor</button>}>
        <KpiCards
          figures={figures()}
          month={{
            kind: "period",
            source: {
              comparison: null,
              kind: "period",
              salesComparison: null,
              summary: { ...figures().month, period: { from, to } },
              today: TODAY,
            },
          }}
        />
      </PeriodControlProvider>
    );
  const sales = (markup: string) =>
    words(card(markup, "home-month")).replace(CARD_ID, "").slice(0, 40);

  it("mês inteiro diz 'em setembro'", () => {
    expect(sales(periodOf("2026-09-01", "2026-09-30"))).toMatch(
      SALES_IN_SEPTEMBER
    );
  });

  it("um período que não é um mês diz 'do período', nunca 'em o período'", () => {
    for (const [from, to] of [
      ["2026-01-01", "2026-10-23"],
      ["2026-09-24", "2026-10-23"],
      ["2026-10-05", "2026-10-12"],
    ] as const) {
      const markup = periodOf(from, to);
      expect(sales(markup)).toMatch(SALES_OF_PERIOD);
      expect(markup).not.toContain("em o período");
    }
  });
});

describe("o seletor fica no mesmo lugar em cada estado dos cartões do mês", () => {
  const control = <button type="button">Seletor</button>;
  const states = [
    { kind: "figures" },
    { kind: "loading" },
    { error: <p role="alert">Falhou</p>, kind: "error" },
  ] as const;

  it("há um seletor só, no fim da linha do grupo, no pronto, lendo e com erro", () => {
    for (const month of states) {
      const markup = renderToStaticMarkup(
        <PeriodControlProvider value={control}>
          <KpiCards figures={figures()} month={month} />
        </PeriodControlProvider>
      );
      expect(markup.match(/Seletor/g)).toHaveLength(1);
      const line = markup.slice(markup.indexOf("data-kpi-group-line"));
      expect(line.indexOf("Seletor")).toBeGreaterThan(-1);
      expect(line.slice(0, line.indexOf("Seletor"))).not.toContain('id="home-');
    }
  });

  it("lendo, a linha guarda o lugar do texto; o aviso de leitura fica fora da linha", () => {
    const markup = renderToStaticMarkup(
      <PeriodControlProvider value={control}>
        <KpiCards figures={figures()} month={{ kind: "loading" }} />
      </PeriodControlProvider>
    );
    const line = markup.slice(markup.indexOf("data-kpi-group-line"));
    expect(line.slice(0, line.indexOf("Seletor"))).not.toContain(
      "Carregando o período"
    );
    expect(markup).toContain("Carregando o período");
  });
});

describe("a frase de sem conexão ao lado do seletor", () => {
  const row = (disabled: boolean, offline: boolean) =>
    renderToStaticMarkup(
      <HomePeriodRow
        disabled={disabled}
        note={null}
        offline={offline}
        onCustom={noop}
        onPreset={noop}
        period={{ from: "2026-10-01", to: "2026-10-31" }}
        selection={THIS_MONTH}
        today={TODAY}
      />
    );
  const attributes = (markup: string) => markup.match(SENTENCE)?.[1] ?? "";

  it("com o seletor ativo e sem conexão a frase é dita (leitor de tela e, de 640 px, a vista)", () => {
    const attrs = attributes(row(false, true));
    expect(attrs).not.toContain("aria-hidden");
    expect(attrs).toContain("max-sm:sr-only");
    expect(attrs).not.toContain("invisible");
  });

  it("com o seletor desligado e sem conexão a frase fica invisível e fora do leitor, com o lugar guardado", () => {
    const attrs = attributes(row(true, true));
    expect(attrs).toContain('aria-hidden="true"');
    expect(attrs).toContain("invisible");
    expect(attrs).not.toContain("sr-only");
  });

  it("com conexão a frase segue invisível, com o seletor ativo ou não", () => {
    for (const disabled of [false, true]) {
      const attrs = attributes(row(disabled, false));
      expect(attrs).toContain('aria-hidden="true"');
      expect(attrs).toContain("invisible");
    }
  });
});
