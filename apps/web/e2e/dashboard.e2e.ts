/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

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
  "Não foi possível falar com o servidor. Mostrando o último resultado confirmado, de 14/10/2026 às 09:00. Vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números.";
const CACHE_KEY_PREFIX = "polaris.offline.periodSummary.";
const rpcPrefix = /^\/rpc\//;

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

const FIXTURE: Readonly<Record<string, FixtureMonth>> = {
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

/** The read model of a month, derived from its fixture. */
function summaryOf(month: string, from: string, to: string) {
  const data = FIXTURE[month] ?? { expenses: [], sales: [] };
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
    // the server clock at the read: what the screen says it is updated until
    generatedAt: NOW,
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
  /** The periods asked for, in order. */
  readonly periods: Array<{ from: string; to: string }> = [];
  /** Months whose answer was sent, in order. */
  readonly answered: string[] = [];
  /** When set, every answer is this ORPC error instead of a summary. */
  failure: { code: string; status: number } | null = null;
  /** When true the network is down: the request never gets an answer. */
  networkDown = false as boolean;
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
    if (procedure !== "report/periodSummary") {
      return this.fail("NOT_FOUND", 404);
    }
    const from = String(input.from);
    const to = String(input.to);
    this.periods.push({ from, to });
    const month = from.slice(0, 7);
    await this.holds.get(month);
    this.answered.push(month);
    if (this.failure) {
      return this.fail(this.failure.code, this.failure.status);
    }
    return {
      body: { json: summaryOf(month, from, to), meta: [] },
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
      status: answer.status,
    });
  });
}

async function signIn(page: Page, user: string) {
  await page.goto("/offline-screens-lab?screen=dashboard");
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Resultado" })
  ).toBeVisible({ timeout: 20_000 });
}

/** Opens the screen as a new user and returns the user, to open it again later. */
async function openDashboard(page: Page, server: FakeReportServer) {
  // the screen reads today's date from the browser: October 2026
  await page.clock.setFixedTime(new Date(NOW));
  await installServer(page, server);
  const user = `user-${crypto.randomUUID()}`;
  await signIn(page, user);
  return user;
}

/** The six cards, in the order the screen shows them. */
const CARD = {
  items: 5,
  margin: 2,
  netSales: 0,
  result: 1,
  sales: 3,
  ticket: 4,
} as const;

const card = (page: Page, index: number) =>
  page.locator(".dashboard-card").nth(index);
const quality = (page: Page) =>
  page.getByRole("region", { name: "Qualidade dos dados" });
const chainRow = (page: Page, label: string) =>
  page.locator(".dashboard-chain tbody tr").filter({ hasText: label });

test("mostra os seis cartões e o passo a passo do mês atual", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await expect(page.locator(".dashboard-card")).toHaveCount(6);
  await expect(card(page, CARD.netSales)).toContainText("Vendas líquidas");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.result)).toContainText("Resultado estimado");
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(card(page, CARD.margin)).toContainText("Margem");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  await expect(card(page, CARD.sales)).toContainText("2");
  await expect(card(page, CARD.ticket)).toContainText("Ticket médio");
  await expect(card(page, CARD.ticket)).toContainText("R$ 65,00");
  await expect(card(page, CARD.items)).toContainText("Itens vendidos");
  await expect(card(page, CARD.items)).toContainText("3");

  // the month asked for is October, the first to the last day
  expect(server.periods[0]).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  await expect(page.locator("#dashboard-month")).toHaveValue("2026-10");

  // complete data: a quiet line, no incomplete-estimate tag
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  await expect(page.getByText("estimativa incompleta")).toHaveCount(0);

  // the chain, in order, with each line's amount
  await expect(
    page.getByRole("heading", { name: "Como chegamos a este resultado" })
  ).toBeVisible();
  const labels = await page
    .locator(".dashboard-chain tbody th")
    .allTextContents();
  expect(labels).toEqual([
    "Vendas brutas",
    "(−) Descontos",
    "(−) Devoluções",
    "(=) Vendas líquidas",
    "(−) Custo das mercadorias vendidas (CMV)",
    "(=) Lucro bruto",
    "(+) Acréscimos e frete",
    "(−) Taxas de processamento do cartão",
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
  await expect(page.locator(".dashboard-updated")).toContainText(UPDATED_UNTIL);
});

test("um mês parcial mostra o aviso do que faltou e a etiqueta de estimativa incompleta", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");

  await page.getByRole("button", { name: "Mês anterior" }).click();

  const banner = quality(page);
  await expect(banner).toContainText("Estimativa incompleta");
  await expect(banner).toContainText(
    "2 linhas de itens vendidos sem custo conhecido: o custo delas não entrou no CMV."
  );
  await expect(banner).toContainText(
    "1 venda sem taxa de processamento conhecida: ela não entrou no resultado."
  );
  await expect(banner).toContainText(
    "1 venda com antecipação sem taxa conhecida: ela não entrou no resultado."
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
  await expect(chainRow(page, "Taxas de processamento")).toContainText(
    "Não inclui 1 venda sem taxa conhecida."
  );
});

test("navegar para o mês anterior carrega o período dele de novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(page.locator("#dashboard-month")).toHaveValue("2026-09");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  expect(server.periods.at(-1)).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });

  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(page.locator("#dashboard-month")).toHaveValue("2026-10");
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

  await page.locator("#dashboard-month").fill("2026-03");

  await expect(quality(page)).toContainText("Sem vendas neste período.");
  await expect(
    page.getByText("Não há vendas nem despesas em março")
  ).toBeVisible();
  await expect(page.locator(".dashboard-card")).toHaveCount(0);
  await expect(page.locator(".dashboard-chain")).toHaveCount(0);
});

test("uma resposta atrasada nunca troca a de um mês mais novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const releaseOctober = server.hold("2026-10");
  await openDashboard(page, server);

  // October is still pending when September is asked for and answered
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");

  releaseOctober();
  await expect
    .poll(() => server.answered.filter((m) => m === "2026-10").length)
    .toBe(1);
  // give the late answer time to reach the screen, where it must be ignored
  await page.waitForTimeout(300);

  await expect(page.locator("#dashboard-month")).toHaveValue("2026-09");
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
  await expect(alert).toContainText(
    "Não foi possível carregar o resultado. Tente novamente."
  );
  await expect(page.locator(".dashboard-card")).toHaveCount(0);

  server.failure = null;
  await alert.getByRole("button", { name: "Tentar de novo" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(page.locator(".dashboard-updated")).toContainText(UPDATED_UNTIL);
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

  await expect(page.locator(".dashboard-updated")).toHaveText(UPDATED_UNTIL);
  await expect(copyNotice(page)).toHaveCount(0);
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  await page.getByRole("button", { name: "Mês anterior" }).click();
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
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();

  const notice = copyNotice(page);
  await expect(notice).toContainText(COPY_NOTICE);
  // nothing is waiting on the device, so no line about operations kept
  await expect(notice).not.toContainText("operações guardadas");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // the same figures the server confirmed, not recomputed
  await expect(page.locator(".dashboard-card")).toHaveCount(6);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  // the quiet "updated until" line is for figures the server just gave
  await expect(page.locator(".dashboard-updated")).not.toContainText(
    "Atualizado até"
  );

  // the connection is back: the figures of the server replace the copy
  server.networkDown = false;
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(copyNotice(page)).toHaveCount(0);
  await expect(page.locator(".dashboard-updated")).toHaveText(UPDATED_UNTIL);
});

test("sem conexão, a cópia vale só para o mês já lido, com a estimativa como estava", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(quality(page)).toContainText("Estimativa incompleta");

  server.networkDown = true;
  // a month never read with a connection has no copy: the usual error
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(page.locator("#dashboard-month")).toHaveValue("2026-08");
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar o resultado. Tente novamente."
  );
  await expect(page.locator(".dashboard-card")).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // a month that was read shows its own copy, never the one of another month
  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(page.locator("#dashboard-month")).toHaveValue("2026-09");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE);
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("R$ 92,00");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("abrir o painel sem rede mostra a cópia do mês, e com a rede de volta mostra o servidor", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const user = await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await signIn(page, user);
  await expect(copyNotice(page)).toContainText(COPY_NOTICE);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  // the goals are never copied: their panel shows its own load error
  await page.locator(".goal-panel > summary").click();
  await expect(page.locator(".goal-panel")).toContainText(
    "Não foi possível carregar as metas."
  );

  server.networkDown = false;
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator(".dashboard-updated")).toHaveText(UPDATED_UNTIL);
  await expect(copyNotice(page)).toHaveCount(0);
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
  await expect(page.getByRole("alert")).toContainText(
    "Sua sessão acabou. Entre de novo para continuar."
  );
  await expect(page.locator(".dashboard-card")).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // and the session being over cleared every copy this browser held
  expect(await cachedMonths(page)).toEqual([]);

  // signed in again, the month is read and kept anew
  server.failure = null;
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  // an outage of the server is not a refusal
  server.failure = { code: "SERVICE_UNAVAILABLE", status: 503 };
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(copyNotice(page)).toContainText(COPY_NOTICE);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});
