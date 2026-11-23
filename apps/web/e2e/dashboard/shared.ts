/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import { touchDay } from "../date-pickers";
import { serveLabWorker, WORKER_MARK } from "../worker-mark";

/**
 * The real period result screen in a real browser, over a small in-memory
 * stand-in for the server's `report.periodSummary` procedure (answered on the
 * RPC wire format). The figures are computed from a tiny fixture of sales and
 * expenses, the way the server derives them from confirmed records; what the
 * real server computes is proved on PostgreSQL by the `economics` gate.
 */
const NOW = "2026-10-14T12:00:00.000Z";

/** The server read the figures at NOW: 09:00 in the lab organization (America/Sao_Paulo). */
export const UPDATED_AT = "Atualizado às 09:00";

export const UPDATED_NAME = "Atualizar, atualizado às 09:00";

export const COPY_NOTICE =
  "Mostrando o último resultado confirmado, de 14/10/2026 às 09:00. Vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números.";

const rpcPrefix = /^\/rpc\//;

const ATUALIZAR_NAME = /^Atualizar(, atualizado .+)?$/;

/** The time of the read is the text of the button that reads again: its name starts with "Atualizar". */
export const refreshButton = (page: Page) =>
  page.getByRole("button", { name: ATUALIZAR_NAME });

/** Money in cents, so the fixture arithmetic is exact. */
interface FixtureSale {
  anticipationFee: number | null;
  cogs: number | null;
  discount: number;
  gross: number;
  itemLines: number;
  /** Units sold, net of returns. */
  items: number;
  processingFee: number | null;
  returns: number;
  surcharge: number;
}

interface FixtureExpense {
  amount: number;
  linked: boolean;
}

export interface FixtureMonth {
  expenses: FixtureExpense[];
  sales: FixtureSale[];
  /** Zero-based day of the period that carries the sales and what they cost; the first day when absent. */
  saleDay?: number;
}

/** October: every cost and fee is known and an expense is recorded. */
export const COMPLETE_MONTH: FixtureMonth = {
  expenses: [
    { amount: 3000, linked: false },
    { amount: 200, linked: true },
  ],
  sales: [
    {
      anticipationFee: 0,
      cogs: 4000,
      discount: 1000,
      gross: 10_000,
      itemLines: 1,
      items: 2,
      processingFee: 300,
      returns: 0,
      surcharge: 500,
    },
    {
      anticipationFee: 0,
      cogs: 2000,
      discount: 0,
      gross: 5000,
      itemLines: 1,
      items: 1,
      processingFee: 150,
      returns: 1000,
      surcharge: 0,
    },
  ],
};

/** September: unknown costs and fees were left out, and no expense is recorded. */
export const PARTIAL_MONTH: FixtureMonth = {
  expenses: [],
  sales: [
    {
      anticipationFee: 0,
      cogs: null,
      discount: 0,
      gross: 8000,
      itemLines: 2,
      items: 3,
      processingFee: null,
      returns: 0,
      surcharge: 0,
    },
    {
      anticipationFee: null,
      cogs: 800,
      discount: 0,
      gross: 2000,
      itemLines: 1,
      items: 1,
      processingFee: 0,
      returns: 0,
      surcharge: 0,
    },
  ],
};

/** July: every cost known and no commercial surcharge, so the two lines differ by exactly the result of the day. */
const NO_SURCHARGE_MONTH: FixtureMonth = {
  expenses: [{ amount: 1800, linked: false }],
  sales: [
    {
      anticipationFee: 0,
      cogs: 2000,
      discount: 0,
      gross: 6000,
      itemLines: 1,
      items: 2,
      processingFee: 120,
      returns: 0,
      surcharge: 0,
    },
  ],
};

/** October with no cost of the goods known: every item line sold has an unknown cost; fees and expenses known. */
export const NO_COST_MONTH: FixtureMonth = {
  expenses: [
    { amount: 3000, linked: false },
    { amount: 200, linked: true },
  ],
  sales: [
    {
      anticipationFee: 0,
      cogs: null,
      discount: 1000,
      gross: 10_000,
      itemLines: 2,
      items: 2,
      processingFee: 300,
      returns: 0,
      surcharge: 500,
    },
    {
      anticipationFee: 0,
      cogs: null,
      discount: 0,
      gross: 5000,
      itemLines: 1,
      items: 1,
      processingFee: 150,
      returns: 1000,
      surcharge: 0,
    },
  ],
};

/** May: one sale with every cost known and no expense recorded, so the estimate is partial like June's. */
const MAY_MONTH: FixtureMonth = {
  expenses: [],
  sales: [
    {
      anticipationFee: 0,
      cogs: 2000,
      discount: 0,
      gross: 6000,
      itemLines: 1,
      items: 2,
      processingFee: 120,
      returns: 0,
      surcharge: 0,
    },
  ],
};

/** June: one sale that was returned whole, so the month has a sale and nothing to draw (the net of every day is zero). */
const RETURNED_MONTH: FixtureMonth = {
  expenses: [],
  sales: [
    {
      anticipationFee: 0,
      cogs: 0,
      discount: 0,
      gross: 10_000,
      itemLines: 1,
      items: 0,
      processingFee: 0,
      returns: 10_000,
      surcharge: 0,
    },
  ],
};

export const FIXTURE: Readonly<Record<string, FixtureMonth>> = {
  "2026-05": MAY_MONTH,
  "2026-06": RETURNED_MONTH,
  "2026-07": NO_SURCHARGE_MONTH,
  "2026-09": PARTIAL_MONTH,
  "2026-10": COMPLETE_MONTH,
};

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${Math.floor(absolute / 100)}.${fraction}`;
}

const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);

/** An unknown amount (null) is left out of the sum, never counted as zero. */
const known = (values: ReadonlyArray<number | null>) =>
  sum(values.map((value) => value ?? 0));

function missingInputs(counts: {
  operatingExpenses: number;
  salesCount: number;
  unknownAnticipation: number;
  unknownCost: number;
  unknownProcessing: number;
}) {
  const missing: string[] = [];
  if (counts.salesCount === 0 && counts.operatingExpenses === 0) {
    missing.push("no_sales");
  }
  if (counts.unknownCost > 0) {
    missing.push("unknown_cost");
  }
  if (counts.unknownProcessing > 0) {
    missing.push("unknown_processing_fee");
  }
  if (counts.unknownAnticipation > 0) {
    missing.push("unknown_anticipation_fee");
  }
  if (counts.salesCount > 0 && counts.operatingExpenses === 0) {
    missing.push("no_expenses");
  }
  return missing;
}

const DAY_MS = 86_400_000;

/** Every date from `from` to `to`, as the server sends them. */
function datesBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const count =
    Math.round((Date.parse(`${to}T00:00:00.000Z`) - start) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10)
  );
}

/**
 * The days of the period as the server sends them (AC-8): the sales and what they cost (goods, fees, linked
 * expenses) on the first day, the expenses without a sale on the last, every other day zero. A day with an unknown
 * cost or fee is `null` in the cost and in the result of the day.
 */
function dailyOf(data: FixtureMonth, from: string, to: string) {
  const { sales } = data;
  const net = sum(
    sales.map((sale) => sale.gross - sale.discount - sale.returns)
  );
  const surcharges = sum(sales.map((sale) => sale.surcharge));
  const unknown = sales.some(
    (sale) =>
      sale.cogs === null ||
      sale.processingFee === null ||
      sale.anticipationFee === null
  );
  const linked = sum(
    data.expenses.filter((expense) => expense.linked).map((e) => e.amount)
  );
  const operating = sum(
    data.expenses.filter((expense) => !expense.linked).map((e) => e.amount)
  );
  const salesCosts =
    known(sales.map((sale) => sale.cogs)) +
    known(sales.map((sale) => sale.processingFee)) +
    known(sales.map((sale) => sale.anticipationFee)) +
    linked;
  const dates = datesBetween(from, to);
  return dates.map((date, index) => {
    const first = index === (data.saleDay ?? 0);
    const last = index === dates.length - 1;
    const costs = (first ? salesCosts : 0) + (last ? operating : 0);
    const result = (first ? net + surcharges : 0) - costs;
    const hidden = first && unknown;
    return {
      costs: hidden ? null : money(costs),
      date,
      netSales: first ? money(net) : "0.00",
      // the part of the cost that is an expense without a sale: the server sends it on every day
      operatingExpenses: money(last ? operating : 0),
      operatingResult: hidden ? null : money(result),
      salesCount: first ? sales.length : 0,
    };
  });
}

/** The read model of a month, derived from its fixture. */
function summaryOf(
  month: string,
  from: string,
  to: string,
  fixture: Readonly<Record<string, FixtureMonth>> = FIXTURE,
  now: string = NOW
) {
  const data = fixture[month] ?? { expenses: [], sales: [] };
  const { sales } = data;
  const gross = sum(sales.map((sale) => sale.gross));
  const discounts = sum(sales.map((sale) => sale.discount));
  const returns = sum(sales.map((sale) => sale.returns));
  const net = gross - discounts - returns;
  const cogs = known(sales.map((sale) => sale.cogs));
  const grossProfit = net - cogs;
  const surcharges = sum(sales.map((sale) => sale.surcharge));
  const processing = known(sales.map((sale) => sale.processingFee));
  const anticipation = known(sales.map((sale) => sale.anticipationFee));
  const linkedList = data.expenses.filter((expense) => expense.linked);
  const operatingList = data.expenses.filter((expense) => !expense.linked);
  const linked = sum(linkedList.map((expense) => expense.amount));
  const operating = sum(operatingList.map((expense) => expense.amount));
  const contribution =
    grossProfit + surcharges - processing - anticipation - linked;
  const result = contribution - operating;
  const unknownCost = sum(
    sales.map((sale) => (sale.cogs === null ? sale.itemLines : 0))
  );
  const unknownProcessing = sales.filter(
    (sale) => sale.processingFee === null
  ).length;
  const unknownAnticipation = sales.filter(
    (sale) => sale.anticipationFee === null
  ).length;
  const missing = missingInputs({
    operatingExpenses: operatingList.length,
    salesCount: sales.length,
    unknownAnticipation,
    unknownCost,
    unknownProcessing,
  });
  const noData = missing[0] === "no_sales";
  let level = "partial";
  if (missing.length === 0) {
    level = "complete";
  } else if (noData) {
    level = "no_data";
  }
  return {
    cards: {
      items: sum(sales.map((sale) => sale.items)),
      marginPercent:
        net > 0
          ? (Math.round((contribution * 10_000) / net) / 100).toFixed(2)
          : null,
      netSales: money(net),
      operatingResult: money(result),
      salesCount: sales.length,
      ticket: sales.length > 0 ? money(Math.round(net / sales.length)) : null,
    },
    chain: {
      anticipationFees: money(anticipation),
      cogs: money(cogs),
      commercialSurcharges: money(surcharges),
      contributionMargin: money(contribution),
      discounts: money(discounts),
      estimatedOperatingResult: money(result),
      grossProfit: money(grossProfit),
      grossSales: money(gross),
      linkedExpenses: money(linked),
      netSales: money(net),
      operatingExpenses: money(operating),
      processingFees: money(processing),
      returns: money(returns),
    },
    daily: dailyOf(data, from, to),
    // the server clock at the read: what the screen says it is updated until
    generatedAt: now,
    period: { from, to },
    quality: {
      anticipationFeesUnknown: unknownAnticipation,
      itemLines: sum(sales.map((sale) => sale.itemLines)),
      itemLinesWithUnknownCost: unknownCost,
      level,
      linkedExpenses: linkedList.length,
      missing,
      operatingExpenses: operatingList.length,
      processingFeesUnknown: unknownProcessing,
      salesCount: sales.length,
    },
  };
}

export class FakeReportServer {
  /** The periods asked for by the screen, in order. */
  readonly periods: Array<{ from: string; to: string }> = [];
  /**
   * The periods read for the chips of the cards (the period before, v7 § 8), in order: the screen asks for them with no
   * `topProducts`, and they are kept apart from `periods`, are never held and are not counted in `answered`.
   */
  readonly comparisons: Array<{ from: string; to: string }> = [];
  /** The periods read by `report.dailySales` for the chips of Vendas and Ticket médio (the same period before), in order. */
  readonly salesComparisons: Array<{ from: string; to: string }> = [];
  /** Months whose answer was sent, in order. */
  readonly answered: string[] = [];
  /** When set, every answer is this ORPC error instead of a summary. */
  failure: { code: string; status: number } | null = null;
  /** When true only `report.dailySales` fails: the chips of Vendas and Ticket médio go, the rest stays. */
  salesFailure = false as boolean;
  /** When true only the read of the period before by `report.periodSummary` fails: the screen's own read answers. */
  comparisonFailure = false as boolean;
  /** When true the network is down: the request never gets an answer. */
  networkDown = false as boolean;
  /** The records of each month the answers are computed from. */
  fixture: Readonly<Record<string, FixtureMonth>> = FIXTURE;
  /** The server clock at each read: it fixes the store's today. */
  now = NOW;
  private readonly holds = new Map<string, Promise<void>>();

  /** Holds the answer for a month until the returned function is called. */
  hold(month: string): () => void {
    let release: () => void = () => undefined;
    this.holds.set(
      month,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    return release;
  }

  async handle(procedure: string, input: Record<string, unknown>) {
    if (procedure === "goal/list") {
      // the goals panel below the chain reads on mount; goals.e2e.ts covers it
      return { body: { json: { goals: [] }, meta: [] }, status: 200 };
    }
    if (procedure === "report/dailySales") {
      return this.dailySales(String(input.from), String(input.to));
    }
    if (procedure !== "report/periodSummary") {
      return this.fail("NOT_FOUND", 404);
    }
    const from = String(input.from);
    const to = String(input.to);
    if (input.topProducts === undefined) {
      this.comparisons.push({ from, to });
      if (this.comparisonFailure) {
        return this.fail("INTERNAL_SERVER_ERROR", 500);
      }
      if (this.failure) {
        return this.fail(this.failure.code, this.failure.status);
      }
      return {
        body: {
          json: summaryOf(from.slice(0, 7), from, to, this.fixture, this.now),
          meta: [],
        },
        status: 200,
      };
    }
    this.periods.push({ from, to });
    const month = from.slice(0, 7);
    await this.holds.get(month);
    this.answered.push(month);
    if (this.failure) {
      return this.fail(this.failure.code, this.failure.status);
    }
    return {
      body: {
        json: summaryOf(month, from, to, this.fixture, this.now),
        meta: [],
      },
      status: 200,
    };
  }

  /** The sales and count of each day of the period, as the SQL `GROUP BY` of `dailySales` gives them. */
  private dailySales(from: string, to: string) {
    this.salesComparisons.push({ from, to });
    if (this.salesFailure) {
      return this.fail("INTERNAL_SERVER_ERROR", 500);
    }
    if (this.failure) {
      return this.fail(this.failure.code, this.failure.status);
    }
    const { daily } = summaryOf(
      from.slice(0, 7),
      from,
      to,
      this.fixture,
      this.now
    );
    return {
      body: {
        json: {
          count: daily.map((day) => day.salesCount),
          from,
          net: daily.map((day) => day.netSales),
        },
        meta: [],
      },
      status: 200,
    };
  }

  private fail(code: string, status: number) {
    return {
      body: {
        json: { code, data: {}, defined: false, message: code, status },
        meta: [],
      },
      status,
    };
  }
}

export async function installServer(page: Page, server: FakeReportServer) {
  await page.route("**/rpc/**", async (route: Route) => {
    if (server.networkDown) {
      await route.abort("internetdisconnected");
      return;
    }
    const url = new URL(route.request().url());
    const procedure = url.pathname.replace(rpcPrefix, "");
    const body = route.request().postDataJSON() as {
      json?: Record<string, unknown>;
    } | null;
    const answer = await server.handle(procedure, body?.json ?? {});
    await route.fulfill({
      body: JSON.stringify(answer.body),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
      status: answer.status,
    });
  });
}

export async function signIn(page: Page, user: string, extra = "") {
  await serveLabWorker(page);
  await page.goto(`/offline-screens-lab?screen=dashboard${extra}`);
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  // the form of a new goal can be open already (the address `?meta=nova`): the dialog hides the page from the reader
  await expect(
    page.getByRole("heading", {
      exact: true,
      includeHidden: true,
      name: "Resultado",
    })
  ).toBeVisible({ timeout: 20_000 });
}

/** Opens the screen as a new user and returns the user, to open it again later. */
export async function openDashboard(
  page: Page,
  server: FakeReportServer,
  extra = ""
) {
  // the screen reads today's date from the browser: October 2026
  await page.clock.setFixedTime(new Date(server.now));
  await installServer(page, server);
  const user = `user-${crypto.randomUUID()}`;
  await signIn(page, user, extra);
  return user;
}

/** The four KPI cards (v7 § 8), in the order the screen shows them. */
export const CARD = {
  margin: 3,
  netSales: 1,
  result: 0,
  ticket: 2,
} as const;

export const kpiCards = (page: Page) =>
  page.locator("[data-kpi-row] [data-kpi]");

export const card = (page: Page, index: number) => kpiCards(page).nth(index);

export const quality = (page: Page) =>
  page.getByRole("region", { name: "Qualidade dos dados" });

export const chain = (page: Page) =>
  page.getByRole("region", { name: "Como chegamos a este resultado" });

export const goalsRegion = (page: Page) =>
  page.getByRole("region", { exact: true, name: "Metas" });

export const chainRow = (page: Page, label: string) =>
  chain(page).locator("tbody tr").filter({ hasText: label });

export const shortcut = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name });

const CHART_REGION_NAME = /^Vendas × custos por (dia|mês)$/;

export const chartRegion = (page: Page) =>
  page.getByRole("region", { name: CHART_REGION_NAME });

const PERIOD_BUTTON_NAME = /^Período: .+, editar$/;

export const periodButton = (page: Page) =>
  page.getByRole("button", { name: PERIOD_BUTTON_NAME });

export const periodPanel = (page: Page) =>
  page.getByRole("dialog", { name: "Período" });

export const YEAR_NAME = /01\/01 a 05\/11/;

export async function openPeriod(page: Page) {
  await periodButton(page).click();
  await expect(periodPanel(page)).toBeVisible();
}

export async function choosePreset(page: Page, name: string) {
  await openPeriod(page);
  await shortcut(page, name).click();
  await expect(periodPanel(page)).toHaveCount(0);
}

export async function expectPreset(page: Page, name: string) {
  await openPeriod(page);
  if (name === "Período") {
    await Promise.all(
      ["Este mês", "Mês passado", "Últimos 30 dias", "Este ano"].map((other) =>
        expect(shortcut(page, other)).toHaveAttribute("aria-pressed", "false")
      )
    );
  } else {
    await expect(shortcut(page, name)).toHaveAttribute("aria-pressed", "true");
  }
  await page.keyboard.press("Escape");
  await expect(periodPanel(page)).toHaveCount(0);
}

/** Touches the first and the last day in the open panel, walking the calendar month by month; the panel closes on the second. */
async function touchRange(page: Page, from: string, to: string) {
  const panel = periodPanel(page);
  await touchDay(panel, from);
  await touchDay(panel, to);
}

export const chooseRange = async (page: Page, from: string, to: string) => {
  await openPeriod(page);
  await touchRange(page, from, to);
  await expect(periodPanel(page)).toHaveCount(0);
};

export const copyNotice = (page: Page) =>
  page
    .getByRole("status")
    .filter({ hasText: "Não foi possível falar com o servidor." });

/** The text of the line that reads the day in focus of the chart (the last one until the pointer moves it). */
export const reading = (page: Page) =>
  chartRegion(page).locator("[data-chart-reading]");

/**
 * The reading of the last day, which at rest is not written (as in the Início): the keyboard control walks one day back and
 * returns to the last, and the line shows over the corner of the drawing while the control has the focus.
 */
export async function readLastDay(page: Page) {
  const slider = chartRegion(page).getByRole("slider");
  await slider.focus();
  await slider.press("ArrowLeft");
  await slider.press("ArrowRight");
  return reading(page);
}

export const METAS_TAB = /^Metas/;

export const metasTab = (page: Page) =>
  page.getByRole("tab", { name: METAS_TAB });

export const resultTab = (page: Page) =>
  page.getByRole("tab", { exact: true, name: "Resultado" });

export const search = (page: Page) => new URL(page.url()).searchParams;

/** The text of an open (i) of the chart's title ("o período" or "as linhas"), closed again afterwards. */
export async function chartHelp(
  page: Page,
  region: Locator,
  which: "as linhas" | "o período"
): Promise<string> {
  const title = (await region.getByRole("heading").first().innerText()).trim();
  const about = `${title}: ${which}`;
  await region
    .getByRole("button", { exact: true, name: `Sobre ${about}` })
    .click();
  const popup = page.getByRole("dialog", { name: about });
  await expect(popup).toBeVisible();
  const said = (await popup.innerText()).replace(/\s+/g, " ");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  return said;
}

export const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

/** Where a box is on the page, whatever the scroll: the height and the top in document coordinates. */
export const placeOf = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { height: box.height, top: box.top + window.scrollY };
  });

/** Two frames with nothing moving between them: the layout the page settled on. */
export const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

/**
 * The largest vertical step between consecutive rows of the pieces of the reading and of the legend: room reserved
 * below the text is no step, an empty row between two fragments is.
 */
const rowStep = (chart: Locator) =>
  chart.evaluate((region) => {
    let step = 0;
    for (const lines of region.querySelectorAll(
      "[data-chart-reading], [data-chart-legend]"
    )) {
      const tops = [
        ...new Set(
          [...lines.children]
            .filter((child) => child.getClientRects().length > 0)
            .map((child) => Math.round(child.getBoundingClientRect().top))
        ),
      ].sort((a, b) => a - b);
      for (let at = 1; at < tops.length; at += 1) {
        step = Math.max(step, (tops[at] ?? 0) - (tops[at - 1] ?? 0));
      }
    }
    return step;
  });

/** Where the strip of KPI cards ends: the sales card is a line taller under the comparison chip, and that moves what is below. */
async function stripBottom(page: Page): Promise<number> {
  const strip = await placeOf(page.locator("[data-kpi-row]").first());
  return strip.top + strip.height;
}

export async function chartPlaces(page: Page) {
  await settled(page);
  const chart = chartRegion(page);
  return {
    stripBottom: await stripBottom(page),
    card: await placeOf(chart),
    rowStep: await rowStep(chart),
    next: await placeOf(chain(page)),
    after: await placeOf(chart.locator("[data-chart-data-table]")),
    totals: await placeOf(chart.locator("dl")),
  };
}

export type ChartPlaces = Awaited<ReturnType<typeof chartPlaces>>;

export function expectSamePlaces(after: ChartPlaces, before: ChartPlaces) {
  for (const key of ["after", "card", "next", "totals"] as const) {
    expect(
      Math.abs(after[key].height - before[key].height),
      `altura de ${key}`
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        after[key].top -
          after.stripBottom -
          (before[key].top - before.stripBottom)
      ),
      `topo de ${key} a partir da faixa de KPIs`
    ).toBeLessThanOrEqual(1);
  }
}

/**
 * A summary of a period above 62 days as the server sends it (`granularity` "month"): the days added up by calendar
 * month up to today, the ends cut, each month with its last day, its days and its unknown days, and the days after
 * today apart.
 */
function byMonth(summary: ReturnType<typeof summaryOf>) {
  type Day = (typeof summary.daily)[number];
  const add = (values: ReadonlyArray<string | null>) =>
    values.some((value) => value === null)
      ? null
      : money(sum(values.map((value) => Math.round(Number(value) * 100))));
  const bucket = (days: Day[]) => ({
    costs: add(days.map((day) => day.costs)),
    date: (days[0] as Day).date,
    days: days.length,
    netSales: add(days.map((day) => day.netSales)) as string,
    operatingExpenses: add(days.map((day) => day.operatingExpenses)) as string,
    operatingResult: add(days.map((day) => day.operatingResult)),
    salesCount: sum(days.map((day) => day.salesCount)),
    to: (days.at(-1) as Day).date,
    unknownDays: days.filter((day) => day.costs === null).length,
  });
  const today = summary.generatedAt.slice(0, 10);
  const months = new Map<string, Day[]>();
  for (const day of summary.daily.filter((entry) => entry.date <= today)) {
    months.set(day.date.slice(0, 7), [
      ...(months.get(day.date.slice(0, 7)) ?? []),
      day,
    ]);
  }
  const later = summary.daily.filter((day) => day.date > today);
  return {
    ...summary,
    daily: [...months.values()].map(bucket),
    granularity: "month",
    ...(later.length > 0 ? { afterToday: bucket(later) } : {}),
  };
}

/** The server of `FakeReportServer` that answers a period above 62 days by month, as the real one does. */
export class MonthlyReportServer extends FakeReportServer {
  override async handle(procedure: string, input: Record<string, unknown>) {
    const answer = await super.handle(procedure, input);
    const from = String(input.from);
    const to = String(input.to);
    const { json } = answer.body as { json?: unknown };
    if (
      procedure !== "report/periodSummary" ||
      answer.status !== 200 ||
      datesBetween(from, to).length <= 62
    ) {
      return answer;
    }
    return {
      ...answer,
      body: {
        json: byMonth(json as ReturnType<typeof summaryOf>),
        meta: [],
      },
    };
  }
}

/** The heights of the KPI row, of each KPI card and of the chart's card: what must not move between periods. */
export async function resultHeights(page: Page) {
  await settled(page);

  const cards = await kpiCards(page).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );
  return {
    cards,
    chart: (await placeOf(chartRegion(page))).height,
    row: (await placeOf(page.locator("[data-kpi-row]"))).height,
  };
}

export function expectSameHeights(
  after: Awaited<ReturnType<typeof resultHeights>>,
  before: Awaited<ReturnType<typeof resultHeights>>
) {
  expect(
    Math.abs(after.row - before.row),
    "altura da linha de KPI"
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(after.chart - before.chart),
    "altura do gráfico"
  ).toBeLessThanOrEqual(1);
  expect(after.cards).toHaveLength(before.cards.length);
  for (const [index, height] of after.cards.entries()) {
    expect(
      Math.abs(height - (before.cards[index] ?? 0)),
      `altura do cartão ${index}`
    ).toBeLessThanOrEqual(1);
  }
}

/** The chart drawn (not the box that holds its place while the chunk comes). */
export const DRAWN_CHART = /^Vendas líquidas/;

/** A store whose today is on November: the range from a year before to today crosses a year, 366 days. */
export const NOVEMBER_5 = "2026-11-05T12:00:00.000Z";

export const YEAR_AGO_TO_TODAY = ["2025-11-05", "2026-11-05"] as const;

/**
 * The record that opens each period of the sequence (the fake server reads the month the period starts in): the month,
 * the 30 days, the year from January and the 366 days.
 */
/** The longest reading of a month: amounts of six digits and an expense of the same size on the day that closes it. */
const BIG_MONTH: FixtureMonth = {
  expenses: [{ amount: 99_999_999, linked: false }],
  sales: [
    {
      anticipationFee: null,
      cogs: null,
      discount: 0,
      gross: 99_999_999,
      itemLines: 1,
      items: 1,
      processingFee: null,
      returns: 0,
      surcharge: 0,
    },
  ],
};

export const CHART_BOX_FIXTURES = {
  completo: {
    "2025-11": COMPLETE_MONTH,
    "2026-01": COMPLETE_MONTH,
    "2026-10": COMPLETE_MONTH,
    "2026-11": COMPLETE_MONTH,
  },
  incompleto: {
    "2025-11": PARTIAL_MONTH,
    "2026-01": PARTIAL_MONTH,
    "2026-10": PARTIAL_MONTH,
    "2026-11": PARTIAL_MONTH,
  },
  "só o ano incompleto": {
    "2025-11": PARTIAL_MONTH,
    "2026-01": PARTIAL_MONTH,
    "2026-10": COMPLETE_MONTH,
    "2026-11": COMPLETE_MONTH,
  },
  "valores de seis dígitos": {
    "2025-11": BIG_MONTH,
    "2026-01": BIG_MONTH,
    "2026-10": COMPLETE_MONTH,
    "2026-11": COMPLETE_MONTH,
  },
  "ano sem os custos por dia": {
    "2025-11": COMPLETE_MONTH,
    "2026-01": COMPLETE_MONTH,
    "2026-10": COMPLETE_MONTH,
    "2026-11": COMPLETE_MONTH,
  },
} as const;
