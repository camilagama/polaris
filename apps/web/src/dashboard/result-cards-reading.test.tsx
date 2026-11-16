import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { ResultCardsView } from "./result-cards";
import { addDays } from "./result-period";

const harness = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [harness.hidden, () => undefined],
}));

afterEach(() => {
  harness.hidden = false;
});

const SPOKEN = /aria-valuetext="([^"]*)"/;
const TODAY = "2026-10-25";
const FIRST_SALE_ON = 5;

const emptyDay = (date: string) => ({
  costs: "0.00",
  date,
  netSales: "0.00",
  operatingExpenses: "0.00",
  operatingResult: "0.00",
  salesCount: 0,
});

const QUALITY = {
  anticipationFeesUnknown: 0,
  itemLines: 21,
  itemLinesWithUnknownCost: 0,
  level: "complete",
  linkedExpenses: 0,
  missing: [],
  operatingExpenses: 0,
  processingFeesUnknown: 0,
  salesCount: 21,
};

/** October to the 25th with the first sale on day 5: the days before it have none, the period has sales. */
function octoberFromTheFifth(): StoredPeriodSummary {
  return {
    cards: {
      items: 21,
      marginPercent: "41.20",
      netSales: "1050.00",
      operatingResult: "840.00",
      salesCount: 21,
      ticket: "50.00",
    },
    chain: {} as StoredPeriodSummary["chain"],
    daily: Array.from({ length: 31 }, (_, index) => {
      const date = addDays("2026-10-01", index);
      return index + 1 < FIRST_SALE_ON || index + 1 > 25
        ? emptyDay(date)
        : {
            ...emptyDay(date),
            costs: "10.00",
            netSales: "50.00",
            operatingResult: "40.00",
            salesCount: 1,
          };
    }),
    generatedAt: "2026-10-25T15:00:00.000Z",
    period: { from: "2026-10-01", to: "2026-10-31" },
    quality: QUALITY,
  } as unknown as StoredPeriodSummary;
}

const lastOfMonth = (month: number) =>
  addDays(`2026-${String(month + 1).padStart(2, "0")}-01`, -1);

/** January 15 to today as the server sends a period above 62 days: one entry per month, with no sale up to March. */
function yearFromTheFourthMonth(): StoredPeriodSummary {
  const months = Array.from({ length: 10 }, (_, index) => {
    const month = index + 1;
    const date =
      month === 1 ? "2026-01-15" : `2026-${String(month).padStart(2, "0")}-01`;
    const to = month === 10 ? TODAY : lastOfMonth(month);
    const days =
      Math.round(
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
          86_400_000
      ) + 1;
    const sold = month >= 4;
    return {
      costs: sold ? `${10 * days}.00` : "0.00",
      date,
      days,
      netSales: sold ? `${50 * days}.00` : "0.00",
      operatingExpenses: "0.00",
      operatingResult: sold ? `${40 * days}.00` : "0.00",
      salesCount: sold ? days : 0,
      to,
      unknownDays: 0,
    };
  });
  const sold = months.filter((month) => month.salesCount > 0);
  const salesCount = sold.reduce((sum, month) => sum + month.salesCount, 0);
  const base = octoberFromTheFifth();
  return {
    ...base,
    cards: {
      ...base.cards,
      netSales: `${50 * salesCount}.00`,
      salesCount,
    },
    daily: months,
    granularity: "month",
    period: { from: "2026-01-15", to: TODAY },
  } as unknown as StoredPeriodSummary;
}

function render(summary: StoredPeriodSummary, index: number | null): string {
  const props: ComponentProps<typeof ResultCardsView> = {
    comparison: null,
    index,
    onIndex: () => undefined,
    onOpenSales: null,
    salesComparison: null,
    summary,
    today: TODAY,
  };
  return renderToStaticMarkup(<ResultCardsView {...props} />);
}

/** What the keyboard control of a card says (its `aria-valuetext`), from the card's id to the next one. */
function spokenBy(markup: string, id: string): string {
  const start = markup.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('id="result-kpi-', start + 1);
  const slice = markup.slice(start, next === -1 ? undefined : next);
  const found = SPOKEN.exec(slice);
  expect(found, `no aria-valuetext in ${id}`).not.toBeNull();
  return (found as RegExpExecArray)[1] as string;
}

describe("what the keyboard control of the cards says of a day read before the first sale", () => {
  it("names the amount and then 'Sem vendas' on Vendas, and 'sem valor' on Ticket médio", () => {
    const markup = render(octoberFromTheFifth(), 0);
    expect(spokenBy(markup, "result-kpi-sales")).toBe(
      "Até 01/10: R$ 0,00. Sem vendas"
    );
    expect(spokenBy(markup, "result-kpi-ticket")).toBe(
      "Até 01/10: sem valor. Sem vendas"
    );
  });

  it("says only the amount once the first sale is read, and the ticket from then on", () => {
    const markup = render(octoberFromTheFifth(), FIRST_SALE_ON - 1);
    expect(spokenBy(markup, "result-kpi-sales")).toBe("Até 05/10: R$ 50,00");
    expect(spokenBy(markup, "result-kpi-ticket")).toBe("Até 05/10: R$ 50,00");
  });

  it("hides the amount with 'Esconder valores' and keeps the words of the day", () => {
    harness.hidden = true;
    const before = render(octoberFromTheFifth(), 0);
    expect(spokenBy(before, "result-kpi-sales")).toBe(
      "Até 01/10: valor escondido. Sem vendas"
    );
    expect(spokenBy(before, "result-kpi-ticket")).toBe(
      "Até 01/10: sem valor. Sem vendas"
    );
    expect(spokenBy(before, "result-kpi-result")).toBe(
      "Até 01/10: valor escondido"
    );
    const after = render(octoberFromTheFifth(), 9);
    expect(spokenBy(after, "result-kpi-sales")).toBe(
      "Até 10/10: valor escondido"
    );
    expect(spokenBy(after, "result-kpi-ticket")).toBe(
      "Até 10/10: valor escondido"
    );
  });

  it("hides the amount at rest too, with no 'Sem vendas'", () => {
    harness.hidden = true;
    const markup = render(octoberFromTheFifth(), null);
    expect(spokenBy(markup, "result-kpi-sales")).toBe(
      "Até 25/10: valor escondido"
    );
  });

  it("says the amounts when the values are not hidden", () => {
    const markup = render(octoberFromTheFifth(), null);
    expect(spokenBy(markup, "result-kpi-sales")).toBe("Até 25/10: R$ 1.050,00");
  });
});

describe("the same, in the reading by month of a period above 62 days", () => {
  it("says 'Sem vendas' of a month before the first sale, to the last day of that month", () => {
    const markup = render(yearFromTheFourthMonth(), 1);
    expect(spokenBy(markup, "result-kpi-sales")).toBe(
      "Até 28/02: R$ 0,00. Sem vendas"
    );
    expect(spokenBy(markup, "result-kpi-ticket")).toBe(
      "Até 28/02: sem valor. Sem vendas"
    );
  });

  it("hides the amount of that month and keeps 'Sem vendas'", () => {
    harness.hidden = true;
    const markup = render(yearFromTheFourthMonth(), 0);
    expect(spokenBy(markup, "result-kpi-sales")).toBe(
      "Até 31/01: valor escondido. Sem vendas"
    );
    expect(spokenBy(markup, "result-kpi-ticket")).toBe(
      "Até 31/01: sem valor. Sem vendas"
    );
  });

  it("drops 'Sem vendas' from the month of the first sale on", () => {
    const markup = render(yearFromTheFourthMonth(), 3);
    expect(spokenBy(markup, "result-kpi-sales")).toBe("Até 30/04: R$ 1.500,00");
    expect(spokenBy(markup, "result-kpi-ticket")).toBe("Até 30/04: R$ 50,00");
  });
});

describe("the cards of the month read at rest and the card of the result", () => {
  const monthsAtRest = (): StoredPeriodSummary => {
    const base = yearFromTheFourthMonth();
    return {
      ...base,
      cards: { ...base.cards, operatingResult: "8320.00" },
    } as StoredPeriodSummary;
  };

  it("says the result of the months up to the one read, to its last day", () => {
    const summary = monthsAtRest();
    expect(spokenBy(render(summary, 1), "result-kpi-result")).toBe(
      "Até 28/02: R$ 0,00"
    );
    expect(spokenBy(render(summary, 3), "result-kpi-result")).toBe(
      "Até 30/04: R$ 1.200,00"
    );
  });

  it("hides the result of a month read and keeps its date", () => {
    harness.hidden = true;
    expect(spokenBy(render(monthsAtRest(), 3), "result-kpi-result")).toBe(
      "Até 30/04: valor escondido"
    );
  });

  it("reads the whole period at rest, up to today, with no 'Sem vendas'", () => {
    const markup = render(monthsAtRest(), null);
    expect(spokenBy(markup, "result-kpi-result")).toBe(
      "Até 25/10: R$ 8.320,00"
    );
    expect(spokenBy(markup, "result-kpi-sales")).toBe(
      "Até 25/10: R$ 10.400,00"
    );
    expect(spokenBy(markup, "result-kpi-ticket")).toBe("Até 25/10: R$ 50,00");
  });
});

describe("the Ticket médio at rest when the server sends none for a period that has sales", () => {
  it("says it is unavailable, never 'Sem vendas no período', and still counts the sales", () => {
    const base = octoberFromTheFifth();
    const markup = render(
      { ...base, cards: { ...base.cards, ticket: null } },
      null
    );
    const start = markup.indexOf('id="result-kpi-ticket"');
    const ticket = markup.slice(
      start,
      markup.indexOf('id="result-kpi-margin"', start)
    );
    expect(ticket).toContain("Ticket indisponível agora");
    expect(ticket).not.toContain("Sem vendas no período");
    expect(spokenBy(markup, "result-kpi-ticket")).toBe("Até 25/10: sem valor");
  });
});
