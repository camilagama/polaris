// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HideValuesButton } from "@/ui/hidden-values";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { ResultCardsView } from "./result-cards";
import { addDays } from "./result-period";

const user = userEvent.setup();

afterEach(async () => {
  const toggle = screen.queryByRole("button", { name: "Esconder valores" });
  if (toggle?.getAttribute("aria-pressed") === "true") {
    await user.click(toggle);
  }
  cleanup();
});

const UNAVAILABLE_TICKET = /Ticket indisponível agora/;
const NO_SALES_IN_PERIOD = /Sem vendas no período/;
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

function Screen({
  index,
  summary,
}: {
  index: number | null;
  summary: StoredPeriodSummary;
}) {
  const props: ComponentProps<typeof ResultCardsView> = {
    comparison: null,
    index,
    onIndex: () => undefined,
    onOpenSales: null,
    salesComparison: null,
    summary,
    today: TODAY,
  };
  return (
    <>
      <HideValuesButton />
      <ResultCardsView {...props} />
    </>
  );
}

function show(summary: StoredPeriodSummary, index: number | null) {
  const view = render(<Screen index={index} summary={summary} />);
  return {
    read: (next: number | null) =>
      view.rerender(<Screen index={next} summary={summary} />),
  };
}

async function hideValues() {
  await user.click(screen.getByRole("button", { name: "Esconder valores" }));
}

function card(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[aria-labelledby="${id}"]`
  );
  expect(found, `no ${id} on the screen`).not.toBeNull();
  return found as HTMLElement;
}

/** What the keyboard control of a card says (its `aria-valuetext`), from the card's id. */
function spokenBy(id: string): string {
  const slider = within(card(id)).getByRole("slider");
  const spoken = slider.getAttribute("aria-valuetext");
  expect(spoken, `no aria-valuetext in ${id}`).not.toBeNull();
  return spoken as string;
}

describe("what the keyboard control of the cards says of a day read before the first sale", () => {
  it("names the amount and then 'Sem vendas' on Vendas, and 'sem valor' on Ticket médio", () => {
    show(octoberFromTheFifth(), 0);
    expect(spokenBy("result-kpi-sales")).toBe("Até 01/10: R$ 0,00. Sem vendas");
    expect(spokenBy("result-kpi-ticket")).toBe(
      "Até 01/10: sem valor. Sem vendas"
    );
  });

  it("says only the amount once the first sale is read, and the ticket from then on", () => {
    show(octoberFromTheFifth(), FIRST_SALE_ON - 1);
    expect(spokenBy("result-kpi-sales")).toBe("Até 05/10: R$ 50,00");
    expect(spokenBy("result-kpi-ticket")).toBe("Até 05/10: R$ 50,00");
  });

  it("hides the amount with 'Esconder valores' and keeps the words of the day", async () => {
    const screenOf = show(octoberFromTheFifth(), 0);
    await hideValues();
    expect(spokenBy("result-kpi-sales")).toBe(
      "Até 01/10: valor escondido. Sem vendas"
    );
    expect(spokenBy("result-kpi-ticket")).toBe(
      "Até 01/10: sem valor. Sem vendas"
    );
    expect(spokenBy("result-kpi-result")).toBe("Até 01/10: valor escondido");
    screenOf.read(9);
    expect(spokenBy("result-kpi-sales")).toBe("Até 10/10: valor escondido");
    expect(spokenBy("result-kpi-ticket")).toBe("Até 10/10: valor escondido");
  });

  it("hides the amount at rest too, with no 'Sem vendas'", async () => {
    show(octoberFromTheFifth(), null);
    await hideValues();
    expect(spokenBy("result-kpi-sales")).toBe("Até 25/10: valor escondido");
  });

  it("says the amounts when the values are not hidden", () => {
    show(octoberFromTheFifth(), null);
    expect(spokenBy("result-kpi-sales")).toBe("Até 25/10: R$ 1.050,00");
  });
});

describe("the same, in the reading by month of a period above 62 days", () => {
  it("says 'Sem vendas' of a month before the first sale, to the last day of that month", () => {
    show(yearFromTheFourthMonth(), 1);
    expect(spokenBy("result-kpi-sales")).toBe("Até 28/02: R$ 0,00. Sem vendas");
    expect(spokenBy("result-kpi-ticket")).toBe(
      "Até 28/02: sem valor. Sem vendas"
    );
  });

  it("hides the amount of that month and keeps 'Sem vendas'", async () => {
    show(yearFromTheFourthMonth(), 0);
    await hideValues();
    expect(spokenBy("result-kpi-sales")).toBe(
      "Até 31/01: valor escondido. Sem vendas"
    );
    expect(spokenBy("result-kpi-ticket")).toBe(
      "Até 31/01: sem valor. Sem vendas"
    );
  });

  it("drops 'Sem vendas' from the month of the first sale on", () => {
    show(yearFromTheFourthMonth(), 3);
    expect(spokenBy("result-kpi-sales")).toBe("Até 30/04: R$ 1.500,00");
    expect(spokenBy("result-kpi-ticket")).toBe("Até 30/04: R$ 50,00");
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
    const screenOf = show(monthsAtRest(), 1);
    expect(spokenBy("result-kpi-result")).toBe("Até 28/02: R$ 0,00");
    screenOf.read(3);
    expect(spokenBy("result-kpi-result")).toBe("Até 30/04: R$ 1.200,00");
  });

  it("hides the result of a month read and keeps its date", async () => {
    show(monthsAtRest(), 3);
    await hideValues();
    expect(spokenBy("result-kpi-result")).toBe("Até 30/04: valor escondido");
  });

  it("reads the whole period at rest, up to today, with no 'Sem vendas'", () => {
    show(monthsAtRest(), null);
    expect(spokenBy("result-kpi-result")).toBe("Até 25/10: R$ 8.320,00");
    expect(spokenBy("result-kpi-sales")).toBe("Até 25/10: R$ 10.400,00");
    expect(spokenBy("result-kpi-ticket")).toBe("Até 25/10: R$ 50,00");
  });
});

describe("the Ticket médio at rest when the server sends none for a period that has sales", () => {
  it("says it is unavailable, never 'Sem vendas no período', and still counts the sales", () => {
    const base = octoberFromTheFifth();
    show({ ...base, cards: { ...base.cards, ticket: null } }, null);
    const ticket = card("result-kpi-ticket").textContent;
    expect(ticket).toMatch(UNAVAILABLE_TICKET);
    expect(ticket).not.toMatch(NO_SALES_IN_PERIOD);
    expect(spokenBy("result-kpi-ticket")).toBe("Até 25/10: sem valor");
  });
});
