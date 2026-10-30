/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The real period result screen in a real browser, over a small in-memory
 * stand-in for the server's `report.periodSummary` procedure (answered on the
 * RPC wire format). The figures are computed from a tiny fixture of sales and
 * expenses, the way the server derives them from confirmed records; what the
 * real server computes is proved on PostgreSQL by the `economics` gate.
 */
const NOW = "2026-10-14T12:00:00.000Z";
/** The server read the figures at NOW: 09:00 in the lab organization (America/Sao_Paulo). */
const UPDATED_UNTIL = "Atualizado até 14/10/2026 09:00";
const COPY_NOTICE =
  "Mostrando o último resultado confirmado, de 14/10/2026 às 09:00. Vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números.";
const CACHE_KEY_PREFIX = "polaris.offline.periodSummary.";
const rpcPrefix = /^\/rpc\//;
/** An amount written on the screen: "R$ 130,00". */
const AN_AMOUNT = /R\$ \d/;

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

interface FixtureMonth {
  expenses: FixtureExpense[];
  sales: FixtureSale[];
}

/** October: every cost and fee is known and an expense is recorded. */
const COMPLETE_MONTH: FixtureMonth = {
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
const PARTIAL_MONTH: FixtureMonth = {
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
const NO_COST_MONTH: FixtureMonth = {
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

const FIXTURE: Readonly<Record<string, FixtureMonth>> = {
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
    const first = index === 0;
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
  fixture: Readonly<Record<string, FixtureMonth>> = FIXTURE
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
    generatedAt: NOW,
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

class FakeReportServer {
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
  /** When true the network is down: the request never gets an answer. */
  networkDown = false as boolean;
  /** The records of each month the answers are computed from. */
  fixture: Readonly<Record<string, FixtureMonth>> = FIXTURE;
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
      if (this.failure) {
        return this.fail(this.failure.code, this.failure.status);
      }
      return {
        body: {
          json: summaryOf(from.slice(0, 7), from, to, this.fixture),
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
      body: { json: summaryOf(month, from, to, this.fixture), meta: [] },
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
    const { daily } = summaryOf(from.slice(0, 7), from, to, this.fixture);
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

async function installServer(page: Page, server: FakeReportServer) {
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

async function signIn(page: Page, user: string, extra = "") {
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
async function openDashboard(page: Page, server: FakeReportServer, extra = "") {
  // the screen reads today's date from the browser: October 2026
  await page.clock.setFixedTime(new Date(NOW));
  await installServer(page, server);
  const user = `user-${crypto.randomUUID()}`;
  await signIn(page, user, extra);
  return user;
}

/** The four KPI cards (v7 § 8), in the order the screen shows them. */
const CARD = {
  margin: 3,
  netSales: 1,
  result: 0,
  ticket: 2,
} as const;

const kpiCards = (page: Page) => page.locator("[data-kpi-row] [data-kpi]");
const card = (page: Page, index: number) => kpiCards(page).nth(index);
const quality = (page: Page) =>
  page.getByRole("region", { name: "Qualidade dos dados" });
const chain = (page: Page) =>
  page.getByRole("region", { name: "Como chegamos a este resultado" });
const goalsRegion = (page: Page) =>
  page.getByRole("region", { exact: true, name: "Metas" });
const chainRow = (page: Page, label: string) =>
  chain(page).locator("tbody tr").filter({ hasText: label });
const preset = (page: Page, name: string) =>
  page.getByRole("button", { exact: true, name });
const chartRegion = (page: Page) =>
  page.getByRole("region", { name: "Vendas × custos por dia" });
/** A phone (the Pixel 5 project too) has the periods in a Select; from 768 px they are a strip of buttons. */
const compact = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
const periodSelect = (page: Page) =>
  page.getByRole("combobox", { name: "Período" });
/** What is on screen to choose the period: the Select on a phone, "Este mês" of the strip otherwise. */
const periodChoice = (page: Page) =>
  compact(page) ? periodSelect(page) : preset(page, "Este mês");
async function choosePreset(page: Page, name: string) {
  if (compact(page)) {
    await periodSelect(page).click();
    await page.getByRole("option", { exact: true, name }).click();
    return;
  }
  await preset(page, name).click();
}
async function expectPreset(page: Page, name: string) {
  if (compact(page)) {
    await expect(periodSelect(page)).toContainText(name);
    return;
  }
  await expect(preset(page, name)).toHaveAttribute("aria-pressed", "true");
}
const rangeFields = async (page: Page, from: string, to: string) => {
  await choosePreset(page, "Período");
  await page.getByLabel("De", { exact: true }).fill(from);
  await page.getByLabel("Até", { exact: true }).fill(to);
  await page.getByRole("button", { name: "Ver período" }).click();
};

test("mostra os quatro cartões (v7) e o passo a passo do mês atual", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await expect(kpiCards(page)).toHaveCount(4);
  await expect(card(page, CARD.result)).toContainText("Resultado estimado");
  // the expense of the 31st is after today: the card is the server's of the whole month, as the chain says
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(card(page, CARD.result)).toContainText("outubro inteiro");
  await expect(card(page, CARD.netSales)).toContainText("Vendas em outubro");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.netSales)).toContainText("2 vendas");
  await expect(card(page, CARD.ticket)).toContainText("Ticket médio");
  await expect(card(page, CARD.ticket)).toContainText("R$ 65,00");
  await expect(card(page, CARD.margin)).toContainText("Margem");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  // the chips compare with the same days of September (v7 § 8): R$ 130,00 against R$ 100,00
  await expect(card(page, CARD.netSales)).toContainText("+30,0%");
  // what it compares with is in the name of the chip and in the (i), not in sight
  await expect(
    card(page, CARD.netSales).locator("[data-kpi-delta]")
  ).toHaveAttribute("aria-label", "+30,0% em relação a 1 a 14/09");
  // the chips of sales and ticket read `dailySales`; the result's chip reads the summary of the same month
  expect(server.salesComparisons).toContainEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });
  expect(server.comparisons).toContainEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });

  // the period asked for is this month, the first to the last day, and it is the one pressed
  expect(server.periods[0]).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  await expectPreset(page, "Este mês");

  // complete data: a quiet line, no incomplete-estimate tag
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  await expect(page.getByText("estimativa incompleta")).toHaveCount(0);

  // the chain, in order, with each line's amount
  await expect(
    page.getByRole("heading", { name: "Como chegamos a este resultado" })
  ).toBeVisible();
  const labels = await chain(page).locator("tbody th").allTextContents();
  expect(labels).toEqual([
    "Vendas brutas",
    "(−) Descontos",
    "(−) Devoluções",
    "(=) Vendas líquidas",
    "(−) Custo das mercadorias vendidas (CMV)",
    "(=) Lucro bruto",
    "(+) Acréscimos e frete",
    "(−) Taxas de processamento",
    "(−) Taxas de antecipação",
    "(−) Despesas ligadas à venda",
    "(=) Margem de contribuição",
    "(−) Despesas do período (sem venda)",
    "(=) Resultado operacional estimado",
  ]);
  await expect(chainRow(page, "Vendas brutas")).toContainText("R$ 150,00");
  await expect(chainRow(page, "Descontos")).toContainText("R$ 10,00");
  await expect(chainRow(page, "Devoluções")).toContainText("R$ 10,00");
  await expect(chainRow(page, "(=) Vendas líquidas")).toContainText(
    "R$ 130,00"
  );
  await expect(chainRow(page, "(CMV)")).toContainText("R$ 60,00");
  await expect(chainRow(page, "(=) Lucro bruto")).toContainText("R$ 70,00");
  await expect(chainRow(page, "Acréscimos e frete")).toContainText("R$ 5,00");
  await expect(chainRow(page, "Taxas de processamento")).toContainText(
    "R$ 4,50"
  );
  await expect(chainRow(page, "Taxas de antecipação")).toContainText("R$ 0,00");
  await expect(chainRow(page, "ligadas à venda")).toContainText("R$ 2,00");
  await expect(chainRow(page, "Margem de contribuição")).toContainText(
    "R$ 68,50"
  );
  await expect(chainRow(page, "sem venda")).toContainText("R$ 30,00");
  await expect(chainRow(page, "Resultado operacional estimado")).toContainText(
    "R$ 38,50"
  );

  // the time of the last successful load is visible
  await expect(page.locator("#dashboard-updated")).toContainText(UPDATED_UNTIL);
});

test("sem a leitura do dailySales, somem só os chips de Vendas e Ticket médio; o resto da tela fica", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.salesFailure = true;
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect.poll(() => server.salesComparisons.length).toBe(1);
  await expect(
    card(page, CARD.netSales).locator("[data-kpi-delta]")
  ).toHaveCount(0);
  await expect(card(page, CARD.ticket).locator("[data-kpi-delta]")).toHaveCount(
    0
  );
  await expect(card(page, CARD.netSales)).not.toContainText("vs. ");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  await expect(chartRegion(page)).toBeVisible();
});

test("Esconder valores (v7 § 6): o mesmo botão do Início esconde os reais dos cartões, da cadeia, das partes e do gráfico, e as porcentagens ficam", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  const main = page.locator("main");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  const toggle = main.getByRole("button", { name: "Esconder valores" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, CARD.netSales)).toContainText("R$ ••••");
  await expect(card(page, CARD.result)).not.toContainText("R$ 38,50");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  await expect(chainRow(page, "Vendas brutas")).not.toContainText("R$ 150,00");
  await expect(main).not.toContainText(AN_AMOUNT);
  await expect(main.getByText("valor escondido").first()).toBeAttached();
  // the choice is the device's, the same key the Início reads
  expect(
    await page.evaluate(() => localStorage.getItem("polaris-valores"))
  ).toBe("escondidos");

  await toggle.click();
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});

test("um mês parcial mostra o aviso do que faltou e a etiqueta de estimativa incompleta", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");

  await choosePreset(page, "Mês passado");

  // the result of September is incomplete, so its chip cannot exist: the engine is not asked for August, and
  // `dailySales` still is (the chips of Vendas and Ticket)
  const august = { from: "2026-08-01", to: "2026-08-31" };
  await expect.poll(() => server.salesComparisons).toContainEqual(august);
  expect(server.comparisons).not.toContainEqual(august);

  const banner = quality(page);
  await expect(banner).toContainText("Estimativa incompleta");
  await expect(banner).toContainText(
    "2 linhas de itens vendidos sem custo conhecido: o custo delas não entrou no CMV."
  );
  await expect(banner).toContainText(
    "1 venda sem taxa de processamento conhecida: a venda entra nos totais, mas a taxa dela ficou fora do cálculo."
  );
  await expect(banner).toContainText(
    "1 venda com antecipação sem taxa conhecida: a venda entra nos totais, mas a taxa dela ficou fora do cálculo."
  );
  await expect(banner).toContainText(
    "Nenhuma despesa registrada neste período: o resultado pode estar acima do real."
  );
  await expect(banner).not.toContainText("Dados completos");

  // the result carries the tag, and the unknowns are marked on their own lines
  await expect(card(page, CARD.result)).toContainText("estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("R$ 92,00");
  await expect(chainRow(page, "(CMV)")).toContainText(
    "Não inclui 2 itens sem custo conhecido."
  );
  // a partial cost of the goods keeps its amount and the bar of the parts, marked "incompleto"
  await expect(chainRow(page, "(CMV)")).toContainText("R$ 8,00");
  await expect(chain(page).locator("[data-parts-bar]")).toHaveCount(1);
  await expect(chain(page)).toContainText("incompleto");
  await expect(chainRow(page, "Taxas de processamento")).toContainText(
    "Não inclui 1 venda sem taxa conhecida."
  );
});

test("nenhum custo de mercadoria conhecido: o CMV é “—” com a nota, a barra das partes não aparece e os cartões do resultado e da margem são “—” (T399-3)", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.fixture = { ...FIXTURE, "2026-10": NO_COST_MONTH };
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  const result = card(page, CARD.result);
  await expect(result).toContainText(
    "Sem custo informado: não dá para estimar."
  );
  await expect(result).not.toContainText(AN_AMOUNT);
  await expect(card(page, CARD.margin)).toContainText("Sem custo informado");
  await expect(card(page, CARD.margin)).not.toContainText("%");

  const cogs = chainRow(page, "(CMV)");
  await expect(cogs).toContainText("—");
  await expect(cogs).toContainText(
    "Nenhum dos 3 itens vendidos tem custo conhecido."
  );
  await expect(cogs).not.toContainText(AN_AMOUNT);
  await expect(chainRow(page, "Vendas brutas")).toContainText("R$ 150,00");

  await expect(chain(page).locator("[data-parts-bar]")).toHaveCount(0);
  await expect(chain(page)).toContainText("sem custo conhecido");
  // the fees (3,00 + 1,50) and the expenses (2,00 + 30,00) keep their values
  await expect(chain(page)).toContainText("TaxasR$ 4,50");
  await expect(chain(page)).toContainText("DespesasR$ 32,00");
  await expect(chain(page)).toContainText(
    "Sem o custo das mercadorias, a divisão dos custos não aparece."
  );
});

test("trocar entre este mês e o mês passado carrega o período dele de novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  await choosePreset(page, "Mês passado");
  await expectPreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  expect(server.periods.at(-1)).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });

  await choosePreset(page, "Este mês");
  await expectPreset(page, "Este mês");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(server.periods.map((period) => period.from)).toEqual([
    "2026-10-01",
    "2026-09-01",
    "2026-10-01",
  ]);
});

test("um mês sem vendas nem despesas mostra o estado vazio, sem cartões", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await rangeFields(page, "2026-03-01", "2026-03-31");

  await expect(
    page.getByText("Sem vendas nem despesas em 1 a 31 de março")
  ).toBeVisible();
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(chain(page)).toHaveCount(0);
});

test("uma resposta atrasada nunca troca a de um mês mais novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const releaseOctober = server.hold("2026-10");
  await openDashboard(page, server);

  // October is still pending when September is asked for and answered
  await choosePreset(page, "Mês passado");
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");

  releaseOctober();
  await expect
    .poll(() => server.answered.filter((m) => m === "2026-10").length)
    .toBe(1);
  // give the late answer time to reach the screen, where it must be ignored
  await page.waitForTimeout(300);

  await expectPreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  await expect(quality(page)).toContainText("Estimativa incompleta");
});

test("uma falha do servidor mostra o erro e deixa tentar de novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.failure = { code: "INTERNAL_SERVER_ERROR", status: 500 };
  await openDashboard(page, server);

  const alert = page.getByRole("alert");
  // three tries (~1.5 s and ~4 s between them) before the screen says it failed
  await expect(alert).toContainText(
    "Não foi possível carregar o resultado. Tente novamente.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  server.failure = null;
  await alert.getByRole("button", { name: "Tentar novamente" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(page.locator("#dashboard-updated")).toContainText(UPDATED_UNTIL);
});

const copyNotice = (page: Page) =>
  page
    .getByRole("status")
    .filter({ hasText: "Não foi possível falar com o servidor." });

/** The months of the device copy of the results kept in this browser. */
const cachedMonths = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(-7))
        .sort(),
    CACHE_KEY_PREFIX
  );

test("com o servidor, a tela diz até quando está atualizada e guarda o mês para depois", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await expect(page.locator("#dashboard-updated")).toHaveText(UPDATED_UNTIL);
  await expect(copyNotice(page)).toHaveCount(0);
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  await choosePreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  expect(await cachedMonths(page)).toEqual(["2026-09", "2026-10"]);
});

test("sem conexão, atualizar mostra o último resultado confirmado, dito como tal", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");

  server.networkDown = true;
  await page.getByRole("button", { exact: true, name: "Atualizar" }).click();

  const notice = copyNotice(page);
  await expect(notice).toContainText(COPY_NOTICE, { timeout: 15_000 });
  // nothing is waiting on the device, so no line about operations kept
  await expect(notice).not.toContainText("operações guardadas");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // the same figures the server confirmed, not recomputed
  await expect(kpiCards(page)).toHaveCount(4);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  // the quiet "updated until" line is for figures the server just gave
  await expect(page.locator("#dashboard-updated")).not.toContainText(
    "Atualizado até"
  );

  // the connection is back: the figures of the server replace the copy
  server.networkDown = false;
  await page.getByRole("button", { exact: true, name: "Atualizar" }).click();
  await expect(copyNotice(page)).toHaveCount(0);
  await expect(page.locator("#dashboard-updated")).toHaveText(UPDATED_UNTIL);
});

test("sem conexão, a cópia vale só para o mês já lido, com a estimativa como estava", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await choosePreset(page, "Mês passado");
  await expect(quality(page)).toContainText("Estimativa incompleta");

  server.networkDown = true;
  // a range never read has no copy at all: it opens only with a connection (AC-16)
  await rangeFields(page, "2026-08-01", "2026-08-31");
  await expect(page.getByRole("alert")).toContainText(
    "Este período só abre com internet.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // a month that was read shows its own copy, never the one of another period
  await choosePreset(page, "Mês passado");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("R$ 92,00");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sem conexão, um mês que nunca foi lido diz que não há números guardados, e os outros períodos só abrem com internet", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await choosePreset(page, "Mês passado");
  await expect(page.getByRole("alert")).toContainText(
    "Sem internet e sem números guardados neste aparelho.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  // the last 30 days is a window that moves: no copy, and the screen says why
  await choosePreset(page, "Últimos 30 dias");
  await expect(page.getByRole("alert")).toContainText(
    "Este período só abre com internet.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  // this month was read: its copy is still there
  await choosePreset(page, "Este mês");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});

test("abrir o painel sem rede mostra a cópia do mês, e com a rede de volta mostra o servidor", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const user = await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await signIn(page, user);
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  // the goals are never copied: their tab shows its own load error
  await page.getByRole("tab", { name: "Metas" }).click();
  await expect(goalsRegion(page)).toContainText(
    "Não foi possível carregar as metas."
  );

  // back on the Resultado tab, the connection returns: the figures of the server replace the copy
  await page.getByRole("tab", { exact: true, name: "Resultado" }).click();
  server.networkDown = false;
  await page.getByRole("button", { exact: true, name: "Atualizar" }).click();
  await expect(page.locator("#dashboard-updated")).toHaveText(UPDATED_UNTIL);
  await expect(copyNotice(page)).toHaveCount(0);
});

test("sem conexão, o mês vazio guardado mostra o estado vazio com a cópia dita como tal, e os dois botões seguem como com conexão", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.fixture = { ...FIXTURE, "2026-10": { expenses: [], sales: [] } };
  const user = await openDashboard(page, server);
  const empty = page.getByText("Sem vendas nem despesas em 1 a 31 de outubro");
  await expect(empty).toBeVisible();
  expect(await cachedMonths(page)).toEqual(["2026-10"]);
  const newSale = page.getByRole("link", { exact: true, name: "Nova venda" });
  const newExpense = page.getByRole("link", {
    exact: true,
    name: "Nova despesa",
  });
  await expect(newSale).toHaveAttribute("href", "/sales");
  await expect(newExpense).toHaveAttribute("href", "/dashboard?aba=despesas");

  server.networkDown = true;
  await signIn(page, user);
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(empty).toBeVisible();
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(newSale).toBeVisible();
  await expect(newSale).toHaveAttribute("href", "/sales");
  await expect(newExpense).toBeVisible();
  await expect(newExpense).toHaveAttribute("href", "/dashboard?aba=despesas");
});

test("uma recusa do servidor nunca cai na cópia, mas uma indisponibilidade cai", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const user = await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  // the copy exists, but the server said the session is over
  server.failure = { code: "UNAUTHORIZED", status: 401 };
  await signIn(page, user);
  // the lab has no shell (no notice): the red box says only what did not happen
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar o resultado."
  );
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // and the session being over cleared every copy this browser held
  expect(await cachedMonths(page)).toEqual([]);

  // signed in again, the month is read and kept anew
  server.failure = null;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  // an outage of the server is not a refusal: with the connection there, after the three tries, the copy stays
  // under "Não foi possível atualizar agora", with what it shows and "Tentar novamente" (paliativo dos 1102)
  server.failure = { code: "SERVICE_UNAVAILABLE", status: 503 };
  await page.getByRole("button", { exact: true, name: "Atualizar" }).click();
  const stale = page
    .getByRole("status")
    .filter({ hasText: "Não foi possível atualizar agora" });
  await expect(stale).toContainText(
    "Mostrando os números de 09:00. Vendas feitas depois não estão aqui.",
    { timeout: 15_000 }
  );
  await expect(copyNotice(page)).toHaveCount(0);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  server.failure = null;
  await stale.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.locator("#dashboard-updated")).toHaveText(UPDATED_UNTIL);
  await expect(stale).toHaveCount(0);
});

/** The text of the line that reads the day in focus of the chart (the last one until the pointer moves it). */
const reading = (page: Page) =>
  chartRegion(page).locator("[data-chart-reading]");
const METAS_TAB = /^Metas/;
const ONE_UNKNOWN_DAY = /1 de 30 dias sem custo informado/;
const CHART_IMAGE = /Vendas líquidas e custos por dia, 1 a 31 de outubro/;
const metasTab = (page: Page) => page.getByRole("tab", { name: METAS_TAB });
const resultTab = (page: Page) =>
  page.getByRole("tab", { exact: true, name: "Resultado" });
const search = (page: Page) => new URL(page.url()).searchParams;

test.describe("o gráfico de vendas e custos (AC-4 a AC-12)", () => {
  test("escreve os totais, o melhor dia e a frase de apoio, e a tabela fecha com o que vem depois de hoje", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const region = chartRegion(page);
    await expect(region).toBeVisible();

    // the numbers hold without the drawing (AC-5)
    await expect(region).toContainText("Vendas líquidas");
    await expect(region).toContainText("R$ 130,00");
    await expect(region.locator("dt", { hasText: "Custos" })).toBeVisible();
    await expect(region).toContainText("R$ 96,50");
    await expect(region).toContainText("Melhor dia: 01/10, R$ 130,00");
    await expect(region).toContainText("1 a 31 de outubro");
    // there is a surcharge in October: the sentence does not promise that the lines differ by the result (AC-11)
    await expect(region).toContainText(
      "O resultado de cada dia está em Ver os números. Despesas do período entram no dia da competência."
    );
    await expect(region).not.toContainText(
      "A diferença entre as duas linhas é o resultado estimado do dia."
    );
    await expect(region).not.toContainText("estimativa incompleta");

    // the drawing is an image named by its summary, with a legend that names both lines
    await expect(region.getByRole("img", { name: CHART_IMAGE })).toBeVisible();
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "Custos (CMV, taxas e despesas)"
    );

    // "Ver os números": a row for each day up to today, and the line for what comes after
    await region.getByRole("button", { name: "Ver os números" }).click();
    const table = region.locator("table");
    expect(await table.locator("thead th").allTextContents()).toEqual([
      "Dia",
      "Vendas líquidas",
      "Custos",
      "Resultado do dia",
      "Despesas do período",
    ]);
    await expect(table.locator("tbody tr")).toHaveCount(14);
    const first = table.locator("tbody tr").first();
    await expect(first).toContainText("01/10/2026");
    await expect(first).toContainText("R$ 130,00");
    await expect(first).toContainText("R$ 66,50");
    await expect(first).toContainText("R$ 68,50");
    await expect(table.locator("tfoot")).toContainText(
      "Depois de hoje: despesas R$ 30,00"
    );
  });

  test("sem acréscimos, a frase diz que a diferença é o resultado do dia, e o dia da despesa a nomeia na leitura", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await rangeFields(page, "2026-07-01", "2026-07-31");

    const region = chartRegion(page);
    await expect(region).toContainText("1 a 31 de julho");
    await expect(region).toContainText(
      "A diferença entre as duas linhas é o resultado estimado do dia. Despesas do período entram no dia da competência."
    );
    // the day in focus is the last: it has no sale, and the rent of the month fell on it (AC-11)
    await expect(reading(page)).toHaveText(
      "31/07 · Vendas R$ 0,00 · Custos R$ 18,00 · inclui R$ 18,00 de despesas do período"
    );
    await region.getByRole("button", { name: "Ver os números" }).click();
    await expect(region.locator("table").locator("tbody tr")).toHaveCount(31);
    await expect(region.locator("table").locator("tfoot")).toHaveCount(0);
  });

  test("com um dia de custo desconhecido, o dia é hachurado e a linha quebra só nele; a leitura e a tabela dizem 'sem custo informado' (AC-9, emenda de 25/10)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await choosePreset(page, "Mês passado");

    const region = chartRegion(page);
    await expect(region).toContainText("estimativa incompleta");
    await expect(region).toContainText(
      "Não é lucro líquido nem dinheiro já recebido."
    );
    // September has no surcharge: the count first, the equality on the days without the hatch (AC-11)
    await expect(region).toContainText(
      "1 de 30 dias sem custo informado. A diferença entre as duas linhas é o resultado estimado do dia nos dias sem hachura. Despesas do período entram no dia da competência."
    );
    await expect(region).not.toContainText("A linha de custos não aparece");
    // the legend names both lines and the hatch; no total of costs, never a partial sum
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "Custos (CMV, taxas e despesas)"
    );
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "dia sem custo informado"
    );
    await expect(region.locator("dt", { hasText: "Custos" })).toHaveCount(0);
    // the card of the result: the badge and the count, no sparkline and no chip (AC-9)
    const result = card(page, CARD.result);
    await expect(result).toContainText("estimativa incompleta");
    await expect(result).toContainText("1 de 30 dias sem custo");
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(
      region.getByRole("img", { name: ONE_UNKNOWN_DAY })
    ).toBeVisible();
    // the hatch on the first day only, and the cost line drawn from the second day on, never through the first
    await expect(region.locator("[data-chart-unknown-day]")).toHaveCount(1);
    await expect(region.locator("[data-chart-unknown-day]")).toHaveAttribute(
      "data-chart-unknown-day",
      "0"
    );
    await expect(region.locator("[data-chart-run]")).toHaveAttribute(
      "data-chart-run",
      "1-29"
    );

    // the reading of the unknown day says so in words
    const range = region.getByRole("slider");
    await range.focus();
    await range.press("Home");
    await expect(reading(page)).toContainText(
      "01/09 · Vendas R$ 100,00 · Custos: sem custo informado"
    );
    await expect(reading(page)).not.toContainText("R$ 0,00");

    await region.getByRole("button", { name: "Ver os números" }).click();
    const first = region.locator("table").locator("tbody tr").first();
    await expect(first).toContainText("01/09/2026");
    await expect(first.locator("td").nth(1)).toHaveText("sem custo informado");
    await expect(first.locator("td").nth(2)).toHaveText("sem custo informado");
  });

  test("com o pedaço do gráfico bloqueado, ficam os totais, o melhor dia e a tabela, e o texto do Início", async ({
    page,
  }) => {
    await page.route("**/assets/charts-*.js", (route) => route.abort());
    const server = new FakeReportServer();
    await openDashboard(page, server);

    const region = chartRegion(page);
    await expect(region).toContainText("O gráfico não abriu.");
    await expect(
      region.getByRole("button", { name: "Tentar novamente" })
    ).toBeVisible();
    await expect(region.getByRole("img")).toHaveCount(0);
    await expect(region).toContainText("R$ 130,00");
    await expect(region).toContainText("Melhor dia: 01/10, R$ 130,00");
    await region.getByRole("button", { name: "Ver os números" }).click();
    await expect(region.locator("table").locator("tbody tr")).toHaveCount(14);
  });
});

test.describe("os períodos (AC-1 a AC-3)", () => {
  test("os períodos prontos pedem as datas certas ao servidor, a partir de hoje na loja", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    // "Este ano" waits for the CPU measure (AC-23)
    await expect(preset(page, "Este ano")).toHaveCount(0);

    await choosePreset(page, "Últimos 30 dias");
    await expect(chartRegion(page)).toContainText(
      "15 de setembro a 14 de outubro"
    );
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-15",
      to: "2026-10-14",
    });

    await choosePreset(page, "Mês passado");
    await expect(chartRegion(page)).toContainText("1 a 30 de setembro");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });

    await rangeFields(page, "2026-10-05", "2026-10-12");
    await expectPreset(page, "Período");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
  });

  test("um intervalo inválido diz o que está errado e não chama o servidor", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    const asked = server.periods.length;

    await choosePreset(page, "Período");
    await page.getByLabel("De", { exact: true }).fill("2026-10-10");
    await page.getByLabel("Até", { exact: true }).fill("2026-10-09");
    await page.getByRole("button", { name: "Ver período" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "A data inicial vem depois da final."
    );

    await page.getByLabel("De", { exact: true }).fill("2026-01-01");
    await page.getByLabel("Até", { exact: true }).fill("2026-03-05");
    await page.getByRole("button", { name: "Ver período" }).click();
    await expect(page.getByRole("alert")).toContainText("Escolha até 62 dias.");

    await page.getByLabel("De", { exact: true }).fill("");
    await page.getByRole("button", { name: "Ver período" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Escolha a data inicial e a final."
    );
    expect(server.periods).toHaveLength(asked);
    // and the period on screen is still the one it was
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  });

  test("enquanto lê outro período, mantém os números de antes marcados como tal, e um erro nunca deixa os de antes com o nome do novo", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

    const release = server.hold("2026-09");
    await choosePreset(page, "Mês passado");
    await expect(page.locator("#dashboard-updated")).toHaveText("Atualizando…");
    // still the figures of October, said so, and never under the name of September
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    await expect(
      page.getByText("Mostrando 1 a 31 de outubro até o novo período carregar.")
    ).toBeVisible();
    release();
    await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
    await expect(page.getByText("Mostrando 1 a 31 de outubro")).toHaveCount(0);

    // a failure leaves no figures of the period before (the last 30 days keep no copy to stand in)
    await choosePreset(page, "Este mês");
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    server.failure = { code: "INTERNAL_SERVER_ERROR", status: 500 };
    await choosePreset(page, "Últimos 30 dias");
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível carregar o resultado. Tente novamente.",
      { timeout: 15_000 }
    );
    await expect(kpiCards(page)).toHaveCount(0);
    await expect(chartRegion(page)).toHaveCount(0);
  });
});

test.describe("as abas Resultado e Metas e o endereço (AC-13 a AC-15)", () => {
  test("abre no Resultado, e trocar de aba escreve aba=metas no endereço sem acrescentar um passo ao histórico", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(resultTab(page)).toHaveAttribute("aria-selected", "true");
    expect(search(page).get("aba")).toBeNull();
    const steps = await page.evaluate(() => window.history.length);

    await metasTab(page).click();
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    expect(search(page).get("aba")).toBe("metas");
    // the period and the chart belong to the Resultado tab only (AC-15)
    await expect(periodChoice(page)).toHaveCount(0);
    await expect(chartRegion(page)).toHaveCount(0);
    await expect(goalsRegion(page)).toBeVisible();

    await resultTab(page).click();
    expect(search(page).get("aba")).toBeNull();
    await expect(periodChoice(page)).toBeVisible();
    // the "voltar" of the browser leaves the screen: the tabs added no step
    expect(await page.evaluate(() => window.history.length)).toBe(steps);
  });

  test("a leitura do resumo não se repete ao trocar de aba, e o endereço guarda a aba", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const reads = server.periods.length;

    await metasTab(page).click();
    await resultTab(page).click();
    await metasTab(page).click();
    expect(server.periods).toHaveLength(reads);
    expect(page.url()).toContain("aba=metas");
  });

  test("?aba=metas abre a aba Metas", async ({ page }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&aba=metas");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(goalsRegion(page)).toBeVisible();
    expect(search(page).get("aba")).toBe("metas");
  });

  test("?meta=nova abre a aba Metas com o formulário, e o endereço guarda a aba e solta o link", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=nova");
    // the form is a dialog, so the tabs are under it: found by their markup
    await expect(
      page.getByRole("tab", { includeHidden: true, name: METAS_TAB })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog", { name: "Nova meta" })).toBeVisible();
    await expect(page.locator("#goal-create-kind")).toBeVisible();
    await expect.poll(() => search(page).get("aba")).toBe("metas");
    expect(search(page).get("meta")).toBeNull();
  });

  test("?meta=lista abre a aba Metas, sem o formulário", async ({ page }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=lista");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(goalsRegion(page)).toBeVisible();
    await expect(page.locator("#goal-create-kind")).toHaveCount(0);
    await expect.poll(() => search(page).get("aba")).toBe("metas");
  });

  test("os links do Início ganham do parâmetro aba quando vêm juntos", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&aba=resultado&meta=nova");
    await expect(
      page.getByRole("tab", { includeHidden: true, name: METAS_TAB })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#goal-create-kind")).toBeVisible();
  });
});

test.describe("a tela em um celular e o dia da loja (revisão do PR)", () => {
  test("a 360 px, o período é um seletor e a tabela dos dias vira um cartão por dia, sem rolar de lado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeReportServer();
    await openDashboard(page, server);

    // a Select, no lugar dos botões lado a lado
    const select = page.getByRole("combobox", { name: "Período" });
    await expect(select).toBeVisible();
    await expect(preset(page, "Mês passado")).toHaveCount(0);
    await select.click();
    await page.getByRole("option", { name: "Mês passado" }).click();
    await expect(chartRegion(page)).toContainText("1 a 30 de setembro");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    await select.click();
    await page.getByRole("option", { name: "Este mês" }).click();
    await expect(chartRegion(page)).toContainText("1 a 31 de outubro");

    // a card for each day: the name of each column beside its value, and "Depois de hoje" in view
    await chartRegion(page)
      .getByRole("button", { name: "Ver os números" })
      .click();
    const first = chartRegion(page).locator("tbody tr").first();
    await expect(first).toContainText("01/10/2026");
    await Promise.all(
      [
        "Vendas líquidas",
        "Custos",
        "Resultado do dia",
        "Despesas do período",
      ].map((label) =>
        expect(first.locator(`[data-label="${label}"]`)).toBeVisible()
      )
    );
    await expect(chartRegion(page).locator("tfoot")).toBeVisible();
    await expect(chartRegion(page).locator("tfoot")).toContainText(
      "Depois de hoje: despesas R$ 30,00"
    );
    // nothing scrolls sideways, in the page or in the card of the numbers
    const overflow = await page.evaluate(() => {
      const box = document.querySelector("[data-slot=table-container]");
      return {
        box: box ? box.scrollWidth - box.clientWidth : 0,
        page:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.box).toBeLessThanOrEqual(0);
  });

  test("a 320 px, o valor do cartão não quebra em duas linhas", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 320 });
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const value = card(page, CARD.netSales).locator("[data-kpi-value]");
    await expect(value).toHaveText("R$ 130,00");
    const box = await value.boundingBox();
    // one line of the display type
    expect(box?.height ?? 999).toBeLessThan(40);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("o erro do intervalo fica sob o campo Até e é lido com ele", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await choosePreset(page, "Período");
    await page.getByLabel("De", { exact: true }).fill("2026-10-10");
    await page.getByLabel("Até", { exact: true }).fill("2026-10-09");
    await page.getByRole("button", { name: "Ver período" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("A data inicial vem depois da final.");
    const until = page.getByLabel("Até", { exact: true });
    const describedBy = await until.getAttribute("aria-describedby");
    expect(describedBy).toBe(await alert.getAttribute("id"));
    // under the field, not under the button
    const alertBox = await alert.boundingBox();
    const untilBox = await until.boundingBox();
    const buttonBox = await page
      .getByRole("button", { name: "Ver período" })
      .boundingBox();
    expect(alertBox?.y ?? 0).toBeGreaterThan(untilBox?.y ?? 0);
    expect(alertBox?.x ?? 999).toBeLessThan(
      (buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)
    );
    await expect(until).toHaveAttribute("aria-invalid", "true");
  });

  test("o dia da loja vem do relógio do servidor: com o aparelho em outro dia, os períodos são calculados de novo, uma vez", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    // the device is on November 2nd, the server says October 14th (NOW)
    await page.clock.setFixedTime(new Date("2026-11-02T12:00:00.000Z"));
    await installServer(page, server);
    await signIn(page, `user-${crypto.randomUUID()}`);

    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    await expect(chartRegion(page)).toContainText("1 a 31 de outubro");
    // the first read named November (the device's day), the second corrected it, and none came after
    expect(server.periods).toEqual([
      { from: "2026-11-01", to: "2026-11-30" },
      { from: "2026-10-01", to: "2026-10-31" },
    ]);
    await page.waitForTimeout(500);
    expect(server.periods).toHaveLength(2);
  });
});
