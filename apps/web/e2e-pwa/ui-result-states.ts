/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of Resultado and Metas the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=dashboard`), with the summary of the month and the goals answered by the test
 * (`page.route`), synthetic data only. Few states: each one starts the runtime of the lab in every context of the
 * map, and the CI job has a limit of 30 minutes. The complete month, the loading, the saves and the cancellation
 * are proved in `e2e/dashboard.e2e.ts` and `e2e/goals.e2e.ts` and in the captures of the pull request. The lab's own
 * controls are hidden at the end of each state, so what is measured is the screen alone.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const RPC_PREFIX = /^\/rpc\//;
const GOALS_TAB = /^Metas/;
const TWO_LINES_CHART = /Vendas líquidas e custos por dia/;
const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const DAY_MS = 86_400_000;

/**
 * The days of the period as the server sends them (AC-8): the sales and what they cost on the first day, the expenses
 * without a sale on the last, every other day zero. With `unknown` the first day has an unknown cost: `null` in the cost
 * and in the result of the day, which is what takes the cost line out of the chart.
 */
function dailyOf(from: string, to: string, unknown: boolean) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const count =
    Math.round((Date.parse(`${to}T00:00:00.000Z`) - start) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    if (index === 0) {
      return {
        costs: unknown ? null : "116.25",
        date,
        netSales: "245.00",
        operatingResult: unknown ? null : "128.75",
        salesCount: 3,
      };
    }
    const last = index === count - 1;
    return {
      costs: last ? "135.10" : "0.00",
      date,
      netSales: "0.00",
      operatingResult: last ? "-135.10" : "0.00",
      salesCount: 0,
    };
  });
}

/** A month with an unknown cost and a processing fee left out: the warning, the badges and the notes on the chain. */
const PARTIAL_SUMMARY = (from: string, to: string) => ({
  cards: {
    items: 4,
    marginPercent: "52.56",
    netSales: "245.00",
    operatingResult: "-6.35",
    salesCount: 3,
    ticket: "81.67",
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "96.00",
    commercialSurcharges: "0.00",
    contributionMargin: "128.75",
    discounts: "10.00",
    estimatedOperatingResult: "-6.35",
    grossProfit: "149.00",
    grossSales: "260.00",
    linkedExpenses: "11.55",
    netSales: "245.00",
    operatingExpenses: "135.10",
    processingFees: "8.70",
    returns: "5.00",
  },
  daily: dailyOf(from, to, true),
  generatedAt: NOW,
  period: { from, to },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 4,
    itemLinesWithUnknownCost: 1,
    level: "partial",
    linkedExpenses: 1,
    missing: ["unknown_cost", "unknown_processing_fee"],
    operatingExpenses: 2,
    processingFeesUnknown: 1,
    salesCount: 3,
  },
});

/** The same figures with every cost known: the chart draws the sales and the dashed cost line, and the table has its columns. */
const COMPLETE_SUMMARY = (from: string, to: string) => ({
  ...PARTIAL_SUMMARY(from, to),
  daily: dailyOf(from, to, false),
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 4,
    itemLinesWithUnknownCost: 0,
    level: "complete",
    linkedExpenses: 1,
    missing: [],
    operatingExpenses: 2,
    processingFeesUnknown: 0,
    salesCount: 3,
  },
});

/**
 * The month with no cost of the goods known (T399-3): every item line sold has an unknown cost, so the server's CMV is
 * zero for lack of data. The cards of the result and the margin and the CMV say "—", and the bar of the parts goes.
 */
const NO_COST_SUMMARY = (from: string, to: string) => {
  const partial = PARTIAL_SUMMARY(from, to);
  return {
    ...partial,
    cards: {
      ...partial.cards,
      marginPercent: "91.73",
      operatingResult: "89.65",
    },
    chain: {
      ...partial.chain,
      cogs: "0.00",
      contributionMargin: "224.75",
      estimatedOperatingResult: "89.65",
      grossProfit: "245.00",
    },
    quality: {
      ...partial.quality,
      itemLinesWithUnknownCost: 4,
      missing: ["unknown_cost"],
      processingFeesUnknown: 0,
    },
  };
};

const EMPTY_SUMMARY = (from: string, to: string) => ({
  cards: {
    items: 0,
    marginPercent: null,
    netSales: "0.00",
    operatingResult: "0.00",
    salesCount: 0,
    ticket: null,
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "0.00",
    commercialSurcharges: "0.00",
    contributionMargin: "0.00",
    discounts: "0.00",
    estimatedOperatingResult: "0.00",
    grossProfit: "0.00",
    grossSales: "0.00",
    linkedExpenses: "0.00",
    netSales: "0.00",
    operatingExpenses: "0.00",
    processingFees: "0.00",
    returns: "0.00",
  },
  generatedAt: NOW,
  period: { from, to },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 0,
    itemLinesWithUnknownCost: 0,
    level: "no_data",
    linkedExpenses: 0,
    missing: ["no_sales"],
    operatingExpenses: 0,
    processingFeesUnknown: 0,
    salesCount: 0,
  },
});

const goal = (n: number, extra: Record<string, unknown>) => ({
  achievedValue: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  endsOn: "2026-10-31",
  id: uuid(n),
  kind: "net_sales",
  name: null,
  organizationId: ORGANIZATION_ID,
  paused: false,
  progress: null,
  settledAt: null,
  startsOn: "2026-10-01",
  status: "active",
  target: "2000.00",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
  ...extra,
});

// in progress with a bar, one that has not started, and one of each way to end
const GOALS = [
  goal(1, {
    name: "Outubro forte",
    progress: {
      percent: "12.2",
      periodEnded: false,
      reached: false,
      value: "245.00",
    },
  }),
  goal(2, {
    endsOn: "2026-12-24",
    name: "Natal",
    progress: {
      percent: null,
      periodEnded: false,
      reached: false,
      value: "0.00",
    },
    startsOn: "2026-11-01",
    target: "8000.00",
  }),
  goal(3, {
    achievedValue: "1620.00",
    endsOn: "2026-09-30",
    name: "Setembro",
    settledAt: "2026-09-30T12:00:00.000Z",
    startsOn: "2026-09-01",
    status: "completed",
    target: "1500.00",
  }),
  goal(4, {
    achievedValue: "212.40",
    endsOn: "2026-08-31",
    kind: "operating_result",
    settledAt: "2026-08-31T12:00:00.000Z",
    startsOn: "2026-08-01",
    status: "missed",
    target: "400.00",
  }),
];

/** What the screen reads in the shell check (`ui-shell-isolation.e2e.ts`): an incomplete month, and the goals. */
export const resultAnswers = {
  "goal/list": { goals: GOALS },
  "report/periodSummary": PARTIAL_SUMMARY("2026-10-01", "2026-10-31"),
};

interface Served {
  /** Every cost known: the chart has two lines. */
  complete?: boolean;
  empty?: boolean;
  /** No cost of the goods known: the dash on the CMV and on the cards, no bar of the parts. */
  noCost?: boolean;
  /** The network is down: nothing is answered. */
  offline?: boolean;
}

/** The summary of the period for what is served: the partial month unless another state is asked for. */
function summaryFor(served: Served, from: string, to: string): unknown {
  if (served.empty) {
    return EMPTY_SUMMARY(from, to);
  }
  if (served.noCost) {
    return NO_COST_SUMMARY(from, to);
  }
  return served.complete
    ? COMPLETE_SUMMARY(from, to)
    : PARTIAL_SUMMARY(from, to);
}

async function serveResult(page: Page, served: Served) {
  await page.route("**/rpc/**", (route: Route) => {
    if (served.offline) {
      return route.abort("internetdisconnected");
    }
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    const input =
      (route.request().postDataJSON() as { json?: Record<string, unknown> })
        .json ?? {};
    if (procedure === "report/periodSummary") {
      const from = String(input.from);
      const to = String(input.to);
      return route.fulfill(rpc(summaryFor(served, from, to)));
    }
    if (procedure === "report/dailySales") {
      // the chips of Vendas and Ticket médio read the period before here (a SQL `GROUP BY`: sales and counts only)
      const daily = dailyOf(String(input.from), String(input.to), false);
      return route.fulfill(
        rpc({
          count: daily.map((day) => day.salesCount),
          from: input.from,
          net: daily.map((day) => day.netSales),
        })
      );
    }
    if (procedure === "goal/list") {
      return route.fulfill(rpc({ goals: served.empty ? [] : GOALS }));
    }
    return route.abort("internetdisconnected");
  });
  // after the catch-all above: the last route registered is the first asked
  await serveLabWorker(page);
}

async function signIn(page: Page, user: string, extra = "") {
  await page.goto(`/offline-screens-lab?screen=dashboard${extra}`);
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Resultado" })
    .waitFor();
}

/** Starts the lab's runtime and waits for the screen with the month read. */
async function openResultLab(page: Page, served: Served = {}, extra = "") {
  // the month the screen opens on is the organization's today: keep it October 2026
  await page.clock.setFixedTime(new Date(NOW));
  await serveResult(page, served);
  await signIn(page, `guardrails-${crypto.randomUUID()}`, extra);
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

export const resultStates = {
  /** Every cost known: the two lines and their legend, the reading of the day and the table of the days open. */
  async chart(page: Page) {
    await openResultLab(page, { complete: true });
    await page.getByRole("img", { name: TWO_LINES_CHART }).waitFor();
    await page.getByRole("button", { name: "Ver os números" }).click();
    await page.getByText("Depois de hoje: despesas R$ 135,10").waitFor();
    await showScreenAlone(page);
  },
  /** No sales, no expenses: the period's empty state. */
  async empty(page: Page) {
    await openResultLab(page, { empty: true });
    await page
      .getByText("Sem vendas nem despesas em 1 a 31 de outubro")
      .waitFor();
    await showScreenAlone(page);
  },

  /** No cost of the goods known (T399-3): the cards and the CMV with the dash, the parts without their bar. */
  async noCost(page: Page) {
    await openResultLab(page, { noCost: true });
    await page
      .getByText("Nenhum dos 4 itens vendidos tem custo conhecido.")
      .waitFor();
    await page
      .getByText(
        "Sem o custo das mercadorias, a divisão dos custos não aparece."
      )
      .waitFor();
    await showScreenAlone(page);
  },

  /** The goals tab: in progress with a bar, not started, completed and missed; the dialogs open and close from here. */
  async goals(page: Page) {
    await openResultLab(page, {}, "&aba=metas");
    await page.getByText("Outubro forte").waitFor();
    await showScreenAlone(page);
  },

  /**
   * The period read with an incomplete estimate: the warning, the badges, the chart with the first day hatched and the
   * cost line from the second day on (AC-9, emenda de 25/10), and the chain.
   */
  async list(page: Page) {
    await openResultLab(page);
    await page.getByText("Estimativa incompleta").first().waitFor();
    await page.getByRole("img", { name: TWO_LINES_CHART }).waitFor();
    await page.locator("[data-chart-unknown-day]").first().waitFor();
    await showScreenAlone(page);
  },

  /** A new goal sent empty: the target says what is missing. */
  async newGoalErrors(page: Page) {
    await openResultLab(page);
    await page.getByRole("tab", { name: GOALS_TAB }).click();
    await page.getByText("Outubro forte").waitFor();
    await page.getByRole("button", { name: "Nova meta" }).click();
    await page.getByRole("button", { name: "Criar meta" }).click();
    await page.locator("#goal-create-target-error").waitFor();
    await showScreenAlone(page);
  },

  /** The server out of reach after a read: the copy the device kept, the notice, and the goals that could not load. */
  async offline(page: Page) {
    const served: Served = {};
    await page.clock.setFixedTime(new Date(NOW));
    await serveResult(page, served);
    const user = `guardrails-${crypto.randomUUID()}`;
    await signIn(page, user);
    await page.getByText("Estimativa incompleta").first().waitFor();
    served.offline = true;
    await signIn(page, user);
    await page.getByText("Não foi possível falar com o servidor.").waitFor();
    await showScreenAlone(page);
  },
};
