/// <reference lib="dom" />

import type { Browser, Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { READ_PROCEDURES } from "../src/lib/read-gate";
import { pickDate } from "./date-pickers";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/** The button of the menu of the store in the header: what the menu holds, then the store. */
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;

/**
 * The Início at `/` with a connection (desenho do Início v2, § 4 and § 5; corte inicio.md AC-1 to AC-23), in the real app
 * against a server played by network interception: the figures (A and B of `report.periodSummary`, with the daily
 * series and the ranking), the goals, the lists of balances and the sales. What the real server computes is proved
 * on PostgreSQL (the `economics` and `home-writes` gates); here, what the screen does with it.
 */

const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const USER_ID = "user-do-inicio";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
/** Any amount in reais, as the page or a slider would say it. */
const AN_AMOUNT = /R\$ -?\d/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};
/** `23/10/2026` at noon in Brasília. */
const NOON = Date.parse("2026-10-23T15:00:00.000Z");
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000b1";
const DELETED = "0199c2d0-0000-7000-8000-0000000000b2";
const SALES_PATH = /\/sales$/;
/** The link opens the Metas tab and the address keeps it: `aba=metas`, and no `meta=nova` (corte resultado-v2, AC-13). */
const DASHBOARD_GOALS_PATH = /\/dashboard\?aba=metas$/;
const SHIRT = /Camiseta básica/;
const PRODUCT_LINK =
  /\/products\?produto=0199c2d0-0000-7000-8000-0000000000b1$/;

const json = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const failure = (code: string, status: number) => ({
  body: JSON.stringify({
    json: { code, data: {}, defined: false, message: code, status },
    meta: [],
  }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

function money(cents: number): string {
  const whole = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
}

interface Scenario {
  /** Net sales in cents and the count of each day that sold. */
  days: Record<string, [number, number]>;
  /** What `sale.list` finds: none, or a sale (cancelled, out of A and B). */
  everSold: boolean;
  goals: unknown[];
  /**
   * The result of each day in cents, null for a day with an unknown cost; with it, every day of the series carries its
   * costs and result (a day not listed has a result of zero). Without it, the series has no costs (an older server).
   */
  results?: Record<string, number | null>;
  /** Item lines of the month sold without a known cost. */
  soldWithoutCost: number;
  /** Variants (balances) the lists return, by filter. */
  stock: {
    all: number;
    unknownCost: number;
    withStock: number;
    withoutStock: number;
  };
}

const SOLD: Scenario = {
  days: {
    "2026-09-20": [5000, 1],
    "2026-09-21": [12_000, 2],
    "2026-10-02": [8000, 1],
    "2026-10-18": [184_000, 6],
    "2026-10-20": [42_050, 3],
    "2026-10-23": [32_010, 2],
  },
  everSold: true,
  goals: [],
  soldWithoutCost: 2,
  stock: { all: 5, unknownCost: 1, withoutStock: 3, withStock: 4 },
};

function balance(index: number) {
  return {
    isDefaultVariant: true,
    listPrice: "10.00",
    movingAverageCost: null,
    productId:
      index === 0
        ? PRODUCT
        : `0199c2d0-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
    productName: `Produto ${index + 1}`,
    productStatus: "active",
    quantity: 0,
    sku: null,
    updatedAt: null,
    values: [],
    variantId: `0199c2d0-0000-7000-8000-0000000002${String(index).padStart(2, "0")}`,
    version: 0,
  };
}

/** A day of the series as the server sends it: with its costs and result only when the scenario has results. */
function dayEntry(scenario: Scenario, day: string): Record<string, unknown> {
  const [cents, count] = scenario.days[day] ?? [0, 0];
  const entry = { date: day, netSales: money(cents), salesCount: count };
  if (!scenario.results) {
    return entry;
  }
  // a day listed as null has an unknown cost; a day not listed has a result of zero
  const listed = scenario.results[day];
  const result = listed === undefined ? 0 : listed;
  return {
    ...entry,
    costs: result === null ? null : money(Math.max(0, cents - result)),
    operatingExpenses: "0.00",
    operatingResult: result === null ? null : money(result),
  };
}

/** Above this many days the server sends the months, not the days. */
const LONGEST_BY_DAY = 62;

/** The days of the series added up by calendar month, as the server sends a long period. */
function byMonth(
  daily: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const months = new Map<string, Record<string, unknown>[]>();
  for (const day of daily) {
    const key = String(day.date).slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), day]);
  }
  return [...months.values()].map((days) => ({
    date: days[0]?.date,
    days: days.length,
    netSales: money(
      days.reduce((sum, day) => sum + Math.round(Number(day.netSales) * 100), 0)
    ),
    salesCount: days.reduce((sum, day) => sum + Number(day.salesCount), 0),
    to: days.at(-1)?.date,
    unknownDays: 0,
  }));
}

class FakeServer {
  scenario: Scenario;
  /** The server's clock (Node's, not the page's: the page's clock is Playwright's). */
  now = NOON;
  /** No network at all, with `navigator.onLine` still true: nothing of the Worker answers, `/health` neither. */
  down: boolean = Boolean(false);
  /** Who the session is and which store it reads: the second person of the same browser is another user and store. */
  user = { email: "inicio@exemplo.com.br", id: USER_ID };
  organization = {
    id: ORGANIZATION_ID,
    name: "Loja do Início",
    role: "owner",
    timezone: "America/Sao_Paulo",
  };
  signOutCalls = 0;
  readonly calls: Array<{ input: Record<string, unknown>; procedure: string }> =
    [];
  /** Answers of a procedure replaced by a failure, a hold or a missing mark. */
  readonly broken = new Map<
    string,
    "401" | "403" | "429" | "500" | "1102" | "slow" | "unmarked"
  >();
  /** How many of the next answers of a procedure are the platform's page for a Worker killed for CPU (1102). */
  readonly diesNext = new Map<string, number>();
  /** How long each read of the Início takes to answer (ms), so the reads of an opening overlap. */
  latencyMs = 0;
  /** The store's date of the sale that `sale.get` returns. */
  saleOccurredOn = "2026-09-12";
  /** The expenses of the store, whatever the month asked: `expense.list` returns the active ones, or the voided. */
  readonly expenses: Array<{
    competenceOn: string;
    description: string;
    id: string;
    status: "active" | "voided";
    version: number;
  }> = [];

  /** The ranking of the month when a test needs other names than the two of the default one. */
  top: Array<{
    deleted: boolean;
    name: string;
    netSales: string;
    productId: string;
    quantity: number;
  }> | null = null;

  /** Answers of a procedure that wait for the promise to settle (an answer still in flight). */
  readonly held = new Map<string, Promise<void>>();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  /** The latency, and the platform's page when the Worker "died" for CPU: true when that page was the answer. */
  async platformAnswers(procedure: string, route: Route): Promise<boolean> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    const dies = this.diesNext.get(procedure) ?? 0;
    if (dies <= 0 && this.broken.get(procedure) !== "1102") {
      return false;
    }
    this.diesNext.set(procedure, dies - 1);
    await route.fulfill(KILLED_FOR_CPU);
    return true;
  }

  summary(from: string, to: string, topProducts: unknown) {
    const daily: Record<string, unknown>[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      daily.push(dayEntry(this.scenario, day));
    }
    const net = daily.reduce(
      (sum, day) => sum + Math.round(Number(day.netSales) * 100),
      0
    );
    const grouped = daily.length > LONGEST_BY_DAY ? byMonth(daily) : null;
    const count = daily.reduce((sum, day) => sum + Number(day.salesCount), 0);
    const inMonth = from.startsWith("2026-10") || from.startsWith("2026-11");
    const unknownCost = inMonth ? this.scenario.soldWithoutCost : 0;
    const missing: string[] = [];
    if (count === 0) {
      missing.push("no_sales");
    } else {
      if (unknownCost > 0) {
        missing.push("unknown_cost");
      }
      missing.push("no_expenses");
    }
    let level = "partial";
    if (count === 0) {
      level = "no_data";
    }
    const cards = {
      items: count,
      marginPercent: count > 0 ? "40.00" : null,
      netSales: money(net),
      operatingResult: money(Math.round(net * 0.3)),
      salesCount: count,
      ticket: count > 0 ? money(Math.round(net / count)) : null,
    };
    const zero = "0.00";
    return {
      cards,
      chain: {
        anticipationFees: zero,
        cogs: zero,
        commercialSurcharges: zero,
        contributionMargin: zero,
        discounts: zero,
        estimatedOperatingResult: cards.operatingResult,
        grossProfit: zero,
        grossSales: cards.netSales,
        linkedExpenses: zero,
        netSales: cards.netSales,
        operatingExpenses: zero,
        processingFees: zero,
        returns: zero,
      },
      daily: grouped ?? daily,
      ...(grouped ? { granularity: "month" } : {}),
      generatedAt: new Date(this.now).toISOString(),
      period: { from, to },
      quality: {
        anticipationFeesUnknown: 0,
        itemLines: count,
        itemLinesWithUnknownCost: unknownCost,
        level,
        linkedExpenses: 0,
        missing,
        operatingExpenses: 0,
        processingFeesUnknown: 0,
        salesCount: count,
      },
      ...(topProducts && count > 0
        ? {
            topProducts: this.top ?? [
              {
                deleted: false,
                name: "Camiseta básica",
                netSales: "900.00",
                productId: PRODUCT,
                quantity: 9,
              },
              {
                deleted: true,
                name: "Boné antigo",
                netSales: "120.00",
                productId: DELETED,
                quantity: 4,
              },
            ],
          }
        : {}),
    };
  }

  /** The light series of the map: the first date and two positional arrays, one entry per date. */
  dailySales(from: string, to: string) {
    const net: string[] = [];
    const count: number[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const [cents, sales] = this.scenario.days[day] ?? [0, 0];
      net.push(money(cents));
      count.push(sales);
    }
    return { count, from, net };
  }

  balances(input: Record<string, unknown>) {
    const { stock } = this.scenario;
    let count = stock.all;
    if (input.cost === "unknown") {
      count = stock.unknownCost;
    } else if (input.stock === "without_stock") {
      count = stock.withoutStock;
    } else if (input.stock === "with_stock") {
      count = stock.withStock;
    }
    const limit = Number(input.limit ?? 50);
    return {
      entries: Array.from({ length: Math.min(count, limit) }, (_, index) =>
        balance(index)
      ),
      nextCursor: count > limit ? "mais" : null,
    };
  }

  expenseView(expense: FakeServer["expenses"][number]) {
    return {
      ...EXPENSE_CATEGORY_FIELDS,
      amount: "80.00",
      competenceOn: expense.competenceOn,
      createdAt: new Date(this.now).toISOString(),
      description: expense.description,
      id: expense.id,
      organizationId: ORGANIZATION_ID,
      payee: null,
      recurringRuleId: null,
      saleId: null,
      status: expense.status,
      updatedAt: new Date(this.now).toISOString(),
      version: expense.version,
      voidedAt:
        expense.status === "voided" ? new Date(this.now).toISOString() : null,
    };
  }

  answer(procedure: string, input: Record<string, unknown>) {
    switch (procedure) {
      case "report/periodSummary":
        return json(
          this.summary(String(input.from), String(input.to), input.topProducts)
        );
      case "report/dailySales":
        return json(this.dailySales(String(input.from), String(input.to)));
      case "goal/list":
        return json({ goals: this.scenario.goals });
      case "inventory/listBalances":
        return json(this.balances(input));
      case "sale/get":
        return json(saleDetail(this.saleOccurredOn));
      case "sale/getCustomerLink":
        return json({
          current: { customerId: null, version: 0 },
          history: [],
          saleId: SALE_ID,
        });
      case "sale/cancel":
        return json({
          cancellation: {
            cancelledAt: new Date(this.now).toISOString(),
            cancelledBy: USER_ID,
            commandId: String(input.commandId ?? SALE_ID),
            id: "0199c2d0-0000-7000-8000-0000000000c4",
            reasonCode: null,
            reasonNote: null,
            saleId: SALE_ID,
          },
          replayed: false,
          restocked: [{ position: 0, quantity: 1, variantId: VARIANT }],
        });
      case "expense/listCategories":
        return json({ categories: [EXPENSE_CATEGORY] });
      case "expense/list": {
        const rows = this.expenses.filter(
          (expense) => expense.status === (input.status ?? "active")
        );
        return json({
          count: rows.length,
          expenses: rows.map((expense) => this.expenseView(expense)),
          nextCursor: null,
          total: "0.00",
        });
      }
      case "expense/create": {
        const created = {
          competenceOn: String(input.competenceOn),
          description: String(input.description),
          id: `0199c2d0-0000-7000-8000-0000000000f${this.expenses.length}`,
          status: "active" as const,
          version: 1,
        };
        this.expenses.push(created);
        return json(this.expenseView(created));
      }
      case "expense/update":
      case "expense/void": {
        const found = this.expenses.find((expense) => expense.id === input.id);
        if (!found) {
          return null;
        }
        if (procedure === "expense/void") {
          found.status = "voided";
        } else {
          found.competenceOn = String(input.competenceOn);
        }
        found.version += 1;
        return json({ changed: true, expense: this.expenseView(found) });
      }
      case "sale/list":
        return json({
          hasMore: false,
          sales: this.scenario.everSold ? [{ id: "x" }] : [],
        });
      default:
        return null;
    }
  }
}

/**
 * What the platform answers for a Worker it killed for CPU (1102): an HTML 503 with `cf-ray` and without the
 * Worker's mark (`server_failed`), never a JSON of the RPC.
 */
const KILLED_FOR_CPU = {
  body: "<!DOCTYPE html><title>Worker exceeded resource limits</title><h1>Error 1102</h1>",
  contentType: "text/html",
  headers: { "cf-ray": "8d2f0c1e9a7b-GRU" },
  status: 503,
};

/** What the Worker answers: the RPC and the auth endpoints. */
const WORKER_PATHS = /\/(rpc|api)\//;

const HOME_PROCEDURES = new Set([
  "expense/create",
  "expense/list",
  "expense/listCategories",
  "expense/update",
  "expense/void",
  "goal/list",
  "inventory/listBalances",
  "report/dailySales",
  "report/periodSummary",
  "sale/cancel",
  "sale/get",
  "sale/getCustomerLink",
  "sale/list",
]);

const EXPENSE_CATEGORY_FIELDS = {
  categoryGroup: "operational",
  categoryId: "0199c2d0-0000-7000-8000-0000000000e2",
  categoryName: "Aluguel",
};
const EXPENSE_CATEGORY = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  groupKey: "operational",
  id: EXPENSE_CATEGORY_FIELDS.categoryId,
  name: "Aluguel",
  organizationId: ORGANIZATION_ID,
  status: "active",
  systemKey: null,
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

const CANCELLED_NOTICE = /Venda cancelada\./;
const SALE_ID = "0199c2d0-0000-7000-8000-0000000000c1";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000c2";
const NO_FEE = {
  amount: null,
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
};

/** A confirmed sale of `occurredOn`, as `sale.get` returns it: one shirt, paid in cash, never returned. */
function saleDetail(occurredOn: string) {
  const at = `${occurredOn}T15:00:00.000Z`;
  return {
    cancellation: null,
    customer: { customerId: null, version: 0 },
    returnSummary: [
      {
        availableToReturn: 1,
        position: 0,
        restockedQuantity: 0,
        returnedQuantity: 0,
        sold: 1,
      },
    ],
    returns: [],
    sale: {
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          position: 0,
          productId: PRODUCT,
          productLabel: "Camiseta básica",
          quantity: 1,
          unitCost: "20.00",
          variantId: VARIANT,
        },
      ],
      payment: {
        amount: "50.00",
        anticipationFee: NO_FEE,
        anticipationRequested: false,
        expectedSettlementDays: null,
        installmentPlan: null,
        installments: null,
        method: "cash",
        paymentProfileId: null,
        paymentProfileName: null,
        paymentProfileRuleId: null,
        paymentProfileVersion: null,
        processingFee: NO_FEE,
      },
      sale: {
        commandId: "0199c2d0-0000-7000-8000-0000000000c3",
        confirmedAt: at,
        currency: "BRL",
        id: SALE_ID,
        occurredAt: at,
        occurredOn,
        recordedAt: null,
      },
      totals: {
        discountTotal: "0.00",
        freightTotal: "0.00",
        paymentSurchargeTotal: "0.00",
        subtotal: "50.00",
        surchargeTotal: "0.00",
        totalDue: "50.00",
      },
    },
  };
}

async function serve(page: Page, server: FakeServer) {
  // a read with no answer is judged by the probe of /health: it answers, so it was an isolated failure (not offline)
  await serveHealth(page, () => server.down);
  await page.route("**/rpc/**", async (route) => {
    if (server.down) {
      await route.abort("internetdisconnected");
      return;
    }
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (!HOME_PROCEDURES.has(procedure)) {
      await route.fallback();
      return;
    }
    const input = inputOf(route);
    server.calls.push({ input, procedure });
    await server.held.get(procedure);
    const broken = server.broken.get(procedure);
    if (await server.platformAnswers(procedure, route)) {
      return;
    }
    if (broken === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    if (broken === "500") {
      await route.fulfill(failure("INTERNAL_SERVER_ERROR", 500));
      return;
    }
    if (broken === "429") {
      await route.fulfill(failure("TOO_MANY_REQUESTS", 429));
      return;
    }
    if (broken === "403") {
      await route.fulfill(failure("FORBIDDEN", 403));
      return;
    }
    if (broken === "401") {
      await route.fulfill(failure("UNAUTHORIZED", 401));
      return;
    }
    const answer = server.answer(procedure, input);
    if (answer === null) {
      await route.abort("internetdisconnected");
      return;
    }
    // a "portal" answer: no mark of the Worker, so the client takes it for no answer
    await route.fulfill(
      broken === "unmarked" ? { ...answer, headers: {} } : answer
    );
  });
  await page.route("**/rpc/organization/listMine", (route) =>
    server.down
      ? route.abort("internetdisconnected")
      : route.fulfill(json({ organizations: [server.organization] }))
  );
  await page.route("**/api/auth/get-session", (route) =>
    server.down
      ? route.abort("internetdisconnected")
      : route.fulfill({
          body: JSON.stringify({ user: server.user }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        })
  );
  await page.route("**/api/auth/sign-out", (route) => {
    server.signOutCalls += 1;
    return route.fulfill({
      body: "{}",
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await page.route("**/rpc/device/*", (route) =>
    route.fulfill(json({ device: DEVICE, devices: [DEVICE] }))
  );
  await page.route("**/rpc/offline/issueLease", async (route) => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["customer:create", "customer:update"],
        deviceId: (inputOf(route) as { deviceId: string }).deviceId,
        epoch: 0,
        expiresAt,
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt,
        organizationId: server.organization.id,
        userId: server.user.id,
      }),
      LEASE_KEY
    );
    await route.fulfill(
      json({
        expiresAt: expiresAt.toISOString(),
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt: issuedAt.toISOString(),
        lease,
      })
    );
  });
  await page.route("**/rpc/sync/getCursor", (route) =>
    route.fulfill(json({ cursor: "0" }))
  );
  await page.route("**/rpc/sync/bootstrapPage", (route) =>
    route.fulfill(
      json({
        collection: (inputOf(route) as { collection: string }).collection,
        nextAfterId: null,
        rows: [],
      })
    )
  );
  await page.route("**/rpc/sync/pull", (route) =>
    route.fulfill(json({ changes: [], hasMore: false, nextCursor: "0" }))
  );
  // registered last, so asked first: with the network down nothing of the Worker answers
  await page.route(WORKER_PATHS, (route) =>
    server.down ? route.abort("internetdisconnected") : route.fallback()
  );
}

async function openHome(page: Page, server: FakeServer, at = NOON) {
  server.now = at;
  await page.clock.install({ time: new Date(at) });
  await serve(page, server);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * The estimate of the goal of `23/10` (v7 § 3 item 9): R$ 2.670,60 measured, plus the 7 whole days before today (16 to
 * `22/10`: R$ 1.840,00 + R$ 420,50 = R$ 2.260,50) × 8 days left ÷ 7 = R$ 2.583,428… → R$ 2.583,43 (half-up, once), so
 * R$ 5.254,03 on the 31st. Over the target of R$ 5.000,00 the phrase says the day the rhythm crosses it (the 7th day
 * would give R$ 4.931,10: the 31st, the last one, is the first above), and under a target of R$ 6.000,00 where it gets.
 */
const GOAL_PROJECTION = "No ritmo atual, a meta deve ser batida até 31/10.";
const GOAL_PROJECTION_SHORT =
  "No ritmo atual, deve chegar a R$ 5.254,03 em 31/10.";
const GOAL_PROJECTION_NO_SALES = "Sem vendas nos últimos 7 dias para estimar.";
/** The foot of the menu: in the sidebar from 760 px, in "Mais" below it. */
async function openMenuFoot(page: Page) {
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  if (await more.isVisible()) {
    await more.click();
  }
}

/** "Mais" is a modal dialog: the page behind it waits for it to close. */
async function closeMenuFoot(page: Page) {
  const panel = page.getByRole("dialog", { name: "Mais" });
  if (await panel.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
}

const region = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });
const PERIOD_BUTTON = /^Período: /;
const TYPE_DATES = /Digitar as datas/;
const periodButton = (page: Page) =>
  page.getByRole("button", { name: PERIOD_BUTTON });
/** The picker of the period of the Início, then one of its shortcuts ("Mês passado"): it applies and closes. */
async function choosePeriod(page: Page, shortcut: string) {
  await periodButton(page).click();
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: shortcut })
    .click();
}
const newSale = (page: Page) =>
  page.getByRole("link", { exact: true, name: "Nova venda" });
const periodCalls = (server: FakeServer) =>
  server.calls.filter((call) => call.procedure === "report/periodSummary");

function goal(overrides: Record<string, unknown>) {
  return {
    achievedValue: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    endsOn: "2026-10-31",
    id: "0199c2d0-0000-7000-8000-000000000c01",
    kind: "net_sales",
    name: "Meta de outubro",
    organizationId: ORGANIZATION_ID,
    paused: false,
    progress: {
      percent: "53.4",
      periodEnded: false,
      reached: false,
      value: "2670.60",
    },
    settledAt: null,
    startsOn: "2026-10-01",
    status: "active",
    target: "5000.00",
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

test.describe("loja com venda", () => {
  test("mostra Hoje, o mês pelo nome, a meta, a atenção, os mais vendidos e o gráfico, na ordem do AC-4 (360 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer({
      ...SOLD,
      goals: [
        goal({}),
        goal({
          endsOn: "2026-12-31",
          id: "0199c2d0-0000-7000-8000-000000000c02",
          name: "Meta do ano",
        }),
      ],
    });
    await openHome(page, server);

    await expect(newSale(page)).toHaveAttribute("href", "/sales");
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();

    // the KPI cards (v7 § 3): Friday `23/10` against the mean of the 4 Fridays before it (only `02/10` sold, R$ 80,00)
    const today = region(page, "Vendas hoje");
    await expect(today).toContainText("R$ 320,10");
    await expect(today).toContainText("16,0×2 vendas");
    await expect(today).not.toContainText("vs. média");
    // no date at rest: the title says it is today
    await expect(today.locator("[data-kpi-date]")).toHaveCount(0);
    // +1.500,5% is said as a multiple from +1.000% up: seen "16,0×", heard "subiu para 16,0 vezes o valor anterior"
    await expect(
      today.locator("[data-kpi-delta=up] [data-kpi-delta-text]")
    ).toHaveText("16,0×");
    await expect(today.locator("[data-kpi-delta=up]")).toHaveAttribute(
      "aria-label",
      "subiu para 16,0 vezes o valor anterior em relação à média das sextas"
    );
    // the sparkline is a reinforcement: hidden from the screen reader, with no axis; the range is its keyboard
    await expect(
      today.locator("[data-kpi-spark] [aria-hidden=true] svg")
    ).toHaveCount(1);
    await expect(today.locator("svg text")).toHaveCount(0);
    await expect(today.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Hoje: R$ 320,10"
    );

    // 1 to 23 October against 1 to 23 September: R$ 2.660,60 against R$ 170,00
    const month = region(page, "Vendas em outubro");
    await expect(month).toContainText("R$ 2.660,60");
    await expect(page.locator("[data-kpi-group]")).toHaveCount(0);
    await expect(month.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(
      month.locator("[data-kpi-delta=up] [data-kpi-delta-text]")
    ).toHaveText("15,7×");
    await expect(month.locator("[data-kpi-delta=up]")).toHaveAttribute(
      "aria-label",
      "subiu para 15,7 vezes o valor anterior em relação a 1 a 23/09"
    );
    await expect(month).toContainText("12 vendas");

    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    // this server sends no result of the day: no sparkline, no chip and no sum of the known days (AC-9)
    await expect(result.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("link")).toHaveAttribute(
      "href",
      "/dashboard"
    );

    const ticket = region(page, "Ticket médio");
    await expect(ticket).toContainText("R$ 221,72");
    // nothing under the number: what it is and what it compares with are in the (i) and in the name of the chip
    await expect(ticket).not.toContainText("Média por venda");
    await expect(ticket.locator("[data-kpi-delta]")).toHaveCount(1);

    const meta = region(page, "Meta");
    await expect(meta).toContainText("Meta de outubro");
    // the store's today is `23/10`: 8 days after it up to the 31st
    await expect(meta).toContainText("1 a 31/10 · faltam 8 dias");
    // the ring (v7 § 3 item 9): an image that says it in words, the drawing of Bklit UI hidden inside it
    const ring = meta.getByRole("img");
    await expect(ring).toHaveAttribute(
      "aria-label",
      "53,4% da meta: R$ 2.670,60 de R$ 5.000,00"
    );
    await expect(ring).toContainText("53,4%da meta");
    await expect(ring.locator("[data-ring-chart] svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(meta).toContainText("R$ 2.670,60de R$ 5.000,00");
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION
    );
    await expect(
      meta.getByRole("link", { name: "Ver as outras" })
    ).toHaveAttribute("href", "/dashboard?meta=lista");

    const attention = region(page, "Precisa de ação");
    await expect(attention.getByRole("link")).toHaveText([
      "1 variante sem custoInforme para as próximas vendas.",
      "3 variantes sem saldo",
    ]);
    await expect(attention.getByRole("link").first()).toHaveAttribute(
      "href",
      "/inventory?filtro=sem-custo"
    );
    await expect(attention.getByRole("link").last()).toHaveAttribute(
      "href",
      "/inventory?filtro=sem-saldo"
    );

    const top = region(page, "Mais vendidos do mês");
    await expect(top.getByRole("link")).toHaveCount(1);
    await expect(top.getByRole("link", { name: SHIRT })).toHaveAttribute(
      "href",
      `/products?produto=${PRODUCT}`
    );
    // a deleted product is listed without a link
    await expect(top).toContainText("Boné antigo");

    const chart = region(page, "Vendas por dia");
    await expect(chart.getByRole("tab")).toHaveCount(0);
    await expect(chart).toContainText("R$ 2.660,60");
    // the period it adds up (the month to today), and the peak written once, in the drawing, with its date
    await expect(chart).toContainText("1 a 23/10");
    await expect(chart).not.toContainText("Melhor dia");
    await expect(chart.locator("[data-chart-value-label]")).toHaveText(
      "18/10 · R$ 1.840,00"
    );
    await expect(chart.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas líquidas por dia, de 1 a 23/10: R$ 2.660,60 no total"
    );
    await expect(
      chart.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("row").nth(18)).toContainText(
      "18/10/2026R$ 1.840,00"
    );

    // the order of the parts at 360 px (AC-4), and nothing scrolls sideways
    const names = await page
      .locator('main [role="region"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector("h2")?.textContent)
      );
    expect(names).toEqual([
      "Precisa de ação",
      "Vendas hoje",
      "Vendas em outubro",
      "Resultado estimado",
      "Ticket médio",
      "Meta",
      "Vendas por dia",
      "Ritmo de vendas",
      "Mais vendidos do mês",
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("a 1280 px Nova venda, Hoje e o mês ficam acima da dobra, em duas colunas", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    for (const target of [
      newSale(page),
      region(page, "Vendas hoje"),
      region(page, "Vendas em outubro"),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one box at a time
      const box = await target.boundingBox();
      expect((box?.y ?? 900) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
    }
    const today = await region(page, "Vendas hoje").boundingBox();
    const month = await region(page, "Vendas em outubro").boundingBox();
    expect(month?.x ?? 0).toBeGreaterThan(
      (today?.x ?? 0) + (today?.width ?? 0)
    );
    expect(month?.y).toBe(today?.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("Nova venda leva à Venda num toque (AC-2), e a barra mantém Vender a um toque", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    await newSale(page).click();
    await page.waitForURL(SALES_PATH);
    await expect(
      page.getByRole("heading", { exact: true, name: "Nova venda" })
    ).toBeVisible();
    await page.goBack();
    await page
      .getByRole("navigation", { exact: true, name: "Destinos" })
      .getByRole("link", { name: "Vender" })
      .click();
    await page.waitForURL(SALES_PATH);
  });

  for (const width of [360, 320]) {
    test(`a linha da atenção quebra o texto em vez de cortá-lo, com a seta centrada (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openHome(page, new FakeServer(SOLD));
      const link = region(page, "Precisa de ação").getByRole("link").first();
      await expect(link).toContainText("Informe para as próximas vendas.");
      const measure = await link.evaluate((anchor) => {
        const text = anchor.querySelector<HTMLElement>("[data-attention-text]");
        const arrow = anchor.querySelector("svg");
        if (!(text && arrow)) {
          throw new Error("a linha sem texto ou sem seta");
        }
        const line = Number.parseFloat(getComputedStyle(text).lineHeight);
        const box = anchor.getBoundingClientRect();
        const mark = arrow.getBoundingClientRect();
        return {
          arrowOffset: Math.abs(
            mark.top + mark.height / 2 - (box.top + box.height / 2)
          ),
          cut: text.scrollWidth > text.clientWidth,
          ellipsis: getComputedStyle(text).textOverflow,
          lines: Math.round(text.getBoundingClientRect().height / line),
          overflowsPage:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      expect(measure.ellipsis).toBe("clip");
      expect(measure.cut).toBe(false);
      expect(measure.lines).toBeGreaterThanOrEqual(2);
      expect(measure.arrowOffset).toBeLessThanOrEqual(1);
      expect(measure.overflowsPage).toBe(false);
    });
  }

  test("vender e voltar: o Hoje e a série já trazem a venda, sem recarregar (§ 5.1)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer({ ...SOLD, days: { ...SOLD.days } });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await newSale(page).click();
    await page.waitForURL(SALES_PATH);
    const before = periodCalls(server).length;
    // the sale confirmed on /sales: the server now counts it in today
    server.scenario.days["2026-10-23"] = [52_010, 3];
    await page
      .getByRole("navigation", { exact: true, name: "Destinos" })
      .getByRole("link", { name: "Início" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Início" })
    ).toBeVisible();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 520,10");
    await expect(region(page, "Vendas hoje")).toContainText("3 vendas");
    expect(periodCalls(server).length).toBeGreaterThan(before);
  });

  test("o gráfico deixa a página rolar na vertical: nenhum touch-action 'none' da caixa do gráfico até a página (pan-y)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const chart = region(page, "Vendas por dia");
    const area = chart.locator("[data-chart-area]");
    await expect(area.locator("svg").first()).toBeVisible();

    // the box and the drawing of the chart ask for the horizontal drag only, so a finger that starts on the chart still
    // scrolls the page: a "none" anywhere between the drawing and the document takes the vertical gesture away
    const { inside, above } = await area.evaluate((node) => {
      const value = (element: Element) => getComputedStyle(element).touchAction;
      const chain: string[] = [];
      for (
        let element: Element | null = node;
        element;
        element = element.parentElement
      ) {
        chain.push(value(element));
      }
      return {
        above: chain,
        inside: [...node.querySelectorAll("*")]
          .map(value)
          .filter((touchAction) => touchAction !== "auto"),
      };
    });
    expect(inside.length).toBeGreaterThan(1);
    expect(new Set(inside)).toEqual(new Set(["pan-y"]));
    expect(above).not.toContain("none");
  });

  test("o gráfico desenha o mês até hoje, um ponto por dia, sem as abas 7 e 30 dias", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart.locator('input[type="range"]')).toHaveAttribute(
      "max",
      "22"
    );
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("tab")).toHaveCount(0);
  });
});

test.describe("o período do Início (cartões do mês, Vendas por dia e Mais vendidos)", () => {
  test("Mês passado muda os três cartões do mês, o gráfico e o ranking; Hoje e o Ritmo ficam; voltar a Este mês não lê de novo", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(periodButton(page)).toContainText("01/10 a 31/10");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    const today = await region(page, "Vendas hoje").innerText();
    const rhythm = await region(page, "Ritmo de vendas")
      .getByRole("img")
      .getAttribute("aria-label");

    await choosePeriod(page, "Mês passado");
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    const september = region(page, "Vendas em setembro");
    await expect(september).toContainText("R$ 170,00");
    await expect(region(page, "Resultado estimado")).toBeVisible();
    await expect(region(page, "Ticket médio")).toBeVisible();
    await expect(region(page, "Vendas por dia")).toContainText("1 a 30/09");
    await expect(region(page, "Vendas por dia")).toContainText("R$ 170,00");
    await expect(region(page, "Mais vendidos de setembro")).toBeVisible();
    await expect(region(page, "Mais vendidos do mês")).toHaveCount(0);
    // what is always "now" does not move
    expect(await region(page, "Vendas hoje").innerText()).toBe(today);
    expect(
      await region(page, "Ritmo de vendas")
        .getByRole("img")
        .getAttribute("aria-label")
    ).toBe(rhythm);
    expect(
      periodCalls(server).some(
        (call) =>
          call.input.from === "2026-09-01" &&
          call.input.to === "2026-09-30" &&
          call.input.topProducts === 3
      )
    ).toBe(true);

    const reads = periodCalls(server).length;
    await choosePeriod(page, "Este mês");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    await expect(region(page, "Mais vendidos do mês")).toBeVisible();
    expect(periodCalls(server).length).toBe(reads);
  });

  test("Este ano vem por mês acima de 62 dias, e o período digitado vale", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    await choosePeriod(page, "Este ano");
    await expect(periodButton(page)).toContainText("01/01 a 23/10");
    const chart = region(page, "Vendas por mês");
    await expect(chart).toBeVisible();
    await expect(chart.getByRole("row")).toHaveCount(11);
    await expect(region(page, "Mais vendidos do período")).toBeVisible();
  });

  test("escolher o período pelo teclado deixa o foco no botão do período, ao carregar e ao voltar a Este mês", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    const shortcut = (name: string) =>
      page
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name });
    for (const [name, text] of [
      ["Mês passado", "01/09 a 30/09"],
      ["Este mês", "01/10 a 31/10"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one choice after the other
      await periodButton(page).focus();
      await page.keyboard.press("Enter");
      await shortcut(name).focus();
      await page.keyboard.press("Enter");
      await expect(periodButton(page)).toContainText(text);
      await expect(
        region(
          page,
          name === "Este mês" ? "Vendas em outubro" : "Vendas em setembro"
        )
      ).toContainText("R$");
      await expect(periodButton(page)).toBeFocused();
    }
  });

  test("o cartão de Vendas diz 'do período' quando o período não é um mês inteiro, e o mês inteiro diz 'em setembro'", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    await choosePeriod(page, "Este ano");
    await expect(periodButton(page)).toContainText("01/01 a 23/10");
    await expect(region(page, "Vendas do período")).toBeVisible();
    await choosePeriod(page, "Últimos 30 dias");
    await expect(periodButton(page)).not.toContainText("01/01");
    await expect(region(page, "Vendas do período")).toBeVisible();
    await expect(region(page, "Vendas em o período")).toHaveCount(0);
    await choosePeriod(page, "Mês passado");
    await expect(region(page, "Vendas em setembro")).toBeVisible();
    await expect(region(page, "Vendas do período")).toHaveCount(0);
  });

  test("um período que falha diz o erro no lugar dos cartões do mês e Tentar novamente lê de novo; Hoje segue", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    server.broken.set("report/periodSummary", "500");
    await choosePeriod(page, "Mês passado");
    await expect(page.getByRole("alert").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    server.broken.delete("report/periodSummary");
    await page
      .getByRole("button", { name: "Tentar novamente" })
      .first()
      .click();
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
  });

  test("loja que nunca vendeu (primeiros passos) não tem o seletor: não há números do período a mostrar", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(
      page,
      new FakeServer({ ...SOLD, days: {}, everSold: false })
    );
    await expect(region(page, "Primeiros passos")).toBeVisible();
    await expect(periodButton(page)).toHaveCount(0);
  });

  test("a releitura do período que falha deixa os números na tela e diz que não atualizou, com Tentar novamente", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await choosePeriod(page, "Mês passado");
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
    server.broken.set("report/periodSummary", "500");
    await page.getByRole("button", { name: "Atualizar" }).first().click();
    const retry = page.locator("[data-home-period]").getByRole("button", {
      name: "Tentar novamente",
    });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-home-period]")).toContainText(
      "Mostrando os números de"
    );
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
    server.broken.delete("report/periodSummary");
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
  });

  test("sem conexão só Este mês e Mês passado abrem: os outros atalhos ficam apagados com o motivo, e o calendário e os campos não valem", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openWithCopy(page, new FakeServer(SOLD));
    // the chunk of the calendar comes with the first opening; the offline panel is the second
    await periodButton(page).click();
    await expect(
      page.locator('[role="grid"] button[data-day]').first()
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.context().setOffline(true);
    const reason = "Sem conexão: só este mês e o anterior.";
    const beside = page.locator("[data-home-period]").getByText(reason);
    await expect(beside).toBeVisible();
    await periodButton(page).click();
    const shortcuts = page.getByRole("group", { name: "Atalhos do período" });
    const off = ["Últimos 30 dias", "Este ano"].map((name) =>
      shortcuts.getByRole("button", { exact: true, name })
    );
    const on = ["Este mês", "Mês passado"].map((name) =>
      shortcuts.getByRole("button", { exact: true, name })
    );
    await Promise.all([
      ...off.map(async (button) => {
        await expect(button).toHaveAttribute("aria-disabled", "true");
        await expect(button).toHaveAccessibleDescription(reason);
      }),
      ...on.map((button) =>
        expect(button).not.toHaveAttribute("aria-disabled", "true")
      ),
    ]);
    await expect(page.getByRole("button", { name: TYPE_DATES })).toHaveCount(0);
    const days = page.locator('[role="grid"] button[data-day]');
    await expect(days.first()).toBeVisible();
    await expect(
      page.locator('[role="grid"] button[data-day]:not([aria-disabled="true"])')
    ).toHaveCount(0);
    await shortcuts
      .getByRole("button", { exact: true, name: "Este ano" })
      .click({ force: true });
    await expect(periodButton(page)).toContainText("01/10 a 31/10");
    await expect(periodButton(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.context().setOffline(false);
    await expect(beside).toBeHidden();
  });
});

/**
 * One command of this device that the server refused (as `sync.push` leaves it), written into the outbox of the runtime
 * that opened with the page, and read again on a reload: the third line of "Precisa de ação".
 */
async function leaveOneRefused(page: Page) {
  await page.evaluate(
    async ({ deviceId, organizationId }) => {
      const names = (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith("polaris-outbox-"));
      for (const name of names) {
        // biome-ignore lint/performance/noAwaitInLoops: one database, the one of this person
        await new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open(name);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const tx = opening.result.transaction(
              ["commands", "meta"],
              "readwrite"
            );
            const at = new Date().toISOString();
            tx.objectStore("commands").put({
              attempts: 1,
              baseVersion: null,
              commandId: crypto.randomUUID(),
              createdAt: at,
              deviceId,
              lastAttemptAt: at,
              lease: "lease",
              organizationId,
              payload: { name: "Bia Souza" },
              rejection: { at, code: "validation_failed" },
              seq: 1,
              status: "rejected",
              type: "customer.create",
            });
            tx.objectStore("meta").put(1, "lastSeq");
            tx.oncomplete = () => {
              opening.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    },
    { deviceId: DEVICE.id, organizationId: ORGANIZATION_ID }
  );
  await page.reload();
}

test.describe("o Início enxuto: a dobra a 360 px e a ajuda de cada bloco", () => {
  test("com três itens de ação, o número de Hoje e o título do mês ficam dentro da janela de 360 × 740 (AC-4)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openWithCopy(page, new FakeServer(SOLD));
    await leaveOneRefused(page);
    const attention = region(page, "Precisa de ação");
    await expect(attention.getByRole("link")).toHaveCount(3, {
      timeout: 20_000,
    });
    await expect(attention).toContainText("1 registro recusado neste aparelho");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");

    const bottom = async (target: Locator) => {
      const box = await target.first().boundingBox();
      return (box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0);
    };
    expect(
      await bottom(region(page, "Vendas hoje").locator("[data-kpi-value]"))
    ).toBeLessThanOrEqual(740);
    expect(await bottom(periodButton(page))).toBeLessThanOrEqual(740);
    expect(
      await bottom(region(page, "Vendas em outubro").locator("h2"))
    ).toBeLessThanOrEqual(740);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("a 360 px o seletor de período fica entre Hoje e os cartões do mês, e Hoje, o seletor e Vendas cabem na janela", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const top = async (target: Locator) =>
      (await target.first().boundingBox())?.y ?? Number.NaN;
    const picker = await top(periodButton(page));
    expect(picker).toBeGreaterThan(await top(region(page, "Vendas hoje")));
    expect(picker).toBeLessThan(await top(region(page, "Vendas em outubro")));
    const bottom = async (target: Locator) => {
      const box = await target.first().boundingBox();
      return (box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0);
    };
    expect(await bottom(region(page, "Vendas em outubro"))).toBeLessThanOrEqual(
      740
    );
  });

  test("a altura da página a 360 px com os mesmos três itens de ação", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openWithCopy(page, new FakeServer({ ...SOLD, goals: [goal({})] }));
    await leaveOneRefused(page);
    await expect(region(page, "Precisa de ação").getByRole("link")).toHaveCount(
      3,
      { timeout: 20_000 }
    );
    await expect(
      region(page, "Vendas por dia").locator("svg").first()
    ).toBeVisible();
    const height = await page.evaluate(
      () => document.documentElement.scrollHeight
    );
    testInfo.annotations.push({
      description: `scrollHeight a 360 px: ${height}`,
      type: "altura-da-pagina",
    });
    expect(height).toBeGreaterThan(740);
  });

  const HELPS: readonly [string, string][] = [
    [
      "Vendas hoje",
      "Vendas líquidas de hoje. Compara com a média das 4 sextas-feiras anteriores.",
    ],
    [
      "Vendas em outubro",
      "Vendas líquidas de 1 a 23/10. Compara com 1 a 23/09.",
    ],
    [
      "Ticket médio",
      "Vendas líquidas divididas pelo número de vendas, de 1 a 23/10. Compara com 1 a 23/09.",
    ],
    [
      "Resultado estimado",
      "Vendas menos custos, taxas e despesas do mês inteiro; não é lucro líquido nem caixa.",
    ],
    [
      "Meta",
      "Estimativa: a média dos últimos 7 dias repetida até o fim da meta.",
    ],
    [
      "Vendas por dia",
      "Vendas líquidas de cada dia do período. Toque num dia para ver o valor.",
    ],
  ];

  for (const [about, text] of HELPS) {
    test(`o (i) de "${about}" abre pelo teclado, diz o que o número é e devolve o foco ao fechar`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 1280 });
      await openHome(page, new FakeServer({ ...SOLD, goals: [goal({})] }));
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
      const help = page.getByRole("button", {
        exact: true,
        name: `Sobre ${about}`,
      });
      await help.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog");
      await expect(popup).toContainText(text);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(help).toBeFocused();
    });
  }

  test("o sinal de incompleta e os dias sem custo ficam à vista, com o (i) fechado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(
      page,
      new FakeServer({ ...SOLD, results: { "2026-10-20": null } })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result).toContainText("1 de 23 dias sem custo");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("loja sem venda: o checklist (AC-22, AC-23)", () => {
  const empty = (stock: Scenario["stock"]): Scenario => ({
    days: {},
    everSold: false,
    goals: [],
    soldWithoutCost: 0,
    stock,
  });

  test("sem produto, o próximo passo é cadastrar; Meta e Atenção continuam", async ({
    page,
  }) => {
    await openHome(
      page,
      new FakeServer(
        empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
      )
    );
    const checklist = region(page, "Primeiros passos");
    await expect(checklist.getByRole("listitem")).toHaveText([
      "Loja criada (feito)",
      "2Cadastrar o 1º produtoCadastrar à mãoImportar planilha",
      "3Fazer a 1ª venda",
    ]);
    // no button under the steps repeats the two ways of the step
    await expect(checklist.getByRole("link")).toHaveText([
      "Cadastrar à mão",
      "Importar planilha",
    ]);
    await expect(
      checklist.getByRole("link", { name: "Cadastrar produto" })
    ).toHaveCount(0);
    // the step has its two ways (corte 2.5, T-5): by hand, or the import of a spreadsheet
    const step = checklist.getByRole("listitem").nth(1);
    await expect(
      step.getByRole("link", { name: "Cadastrar à mão" })
    ).toHaveAttribute("href", "/products?novo=1");
    await expect(
      step.getByRole("link", { name: "Importar planilha" })
    ).toHaveAttribute("href", "/products?importar=1");
    // both are buttons (size sm, 28 px with a mouse), not 14 px text links
    const boxes = await Promise.all(
      ["Cadastrar à mão", "Importar planilha"].map((name) =>
        step.getByRole("link", { name }).boundingBox()
      )
    );
    for (const box of boxes) {
      expect(box?.height).toBeGreaterThanOrEqual(28);
    }
    await expect(region(page, "Vendas hoje")).toHaveCount(0);
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(
      region(page, "Meta").getByRole("link", { name: "Definir meta" })
    ).toHaveAttribute("href", "/dashboard?meta=nova");
    // nothing to do: the block is not there, and says nothing about it
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    // the foot of the menu follows the same three steps, linked back to them
    await openMenuFoot(page);
    await expect(
      page.getByRole("link", {
        exact: true,
        name: "Primeiros passos, 1 de 3 concluídos",
      })
    ).toHaveAttribute("href", "/#home-checklist");
  });

  test("cadastrar o 1º produto em Produtos: o pé do menu diz 2 de 3 na hora, e o Início diz o mesmo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const created = {
      archivedAt: null,
      categoryId: null,
      createdAt: "2026-10-23T15:00:00.000Z",
      deletedAt: null,
      description: null,
      id: PRODUCT,
      name: "Bolsa de couro",
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: "2026-10-23T15:00:00.000Z",
      version: 1,
    };
    let registered = false;
    await page.route("**/rpc/product/list", (route) =>
      route.fulfill(json({ products: registered ? [created] : [] }))
    );
    await page.route("**/rpc/category/list", (route) =>
      route.fulfill(json({ categories: [] }))
    );
    await page.route("**/rpc/product/create", (route) => {
      registered = true;
      return route.fulfill(json(created));
    });
    const server = new FakeServer(
      empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
    );
    await openHome(page, server);
    const checklist = region(page, "Primeiros passos");
    await expect(checklist).toContainText("2Cadastrar o 1º produto");
    const foot = (done: number) =>
      page.getByRole("link", {
        exact: true,
        name: `Primeiros passos, ${done} de 3 concluídos`,
      });
    await expect(foot(1)).toBeVisible();
    await checklist.getByRole("link", { name: "Cadastrar à mão" }).click();
    await page.waitForURL("**/products?novo=1");
    await page.getByLabel("Nome do produto").fill("Bolsa de couro");
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await expect(page.getByLabel("Nome do produto")).toHaveCount(0);
    // the Início was not opened again: nothing was read, the foot follows the registration
    await expect(foot(2)).toBeVisible();
    await expect(foot(1)).toHaveCount(0);
    server.scenario.stock = {
      all: 1,
      unknownCost: 1,
      withoutStock: 1,
      withStock: 0,
    };
    await page
      .getByRole("link", { exact: true, name: "Início" })
      .first()
      .click();
    await expect(
      region(page, "Primeiros passos").getByRole("listitem").nth(1)
    ).toContainText("Cadastrar o 1º produto (feito)");
    await expect(foot(2)).toBeVisible();
  });

  test("produto sem quantidade: 'Dar entrada no estoque' abre o painel do produto", async ({
    page,
  }) => {
    await openHome(
      page,
      new FakeServer(
        empty({ all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 })
      )
    );
    const checklist = region(page, "Primeiros passos");
    await expect(checklist).toContainText("Cadastrar o 1º produto (feito)");
    await openMenuFoot(page);
    await expect(
      page.getByRole("link", {
        exact: true,
        name: "Primeiros passos, 2 de 3 concluídos",
      })
    ).toBeVisible();
    await closeMenuFoot(page);
    const step = checklist.getByRole("link", {
      name: "Dar entrada no estoque",
    });
    await expect(step).toHaveAttribute("href", `/products?produto=${PRODUCT}`);
    await page.route("**/rpc/product/**", (route) =>
      route.abort("internetdisconnected")
    );
    await step.click();
    await page.waitForURL(PRODUCT_LINK);
  });

  test("o link do pé do menu leva ao bloco, vindo de outra tela e de Mais no celular", async ({
    page,
  }) => {
    // short enough that the block starts below the fold
    await page.setViewportSize({ height: 340, width: 360 });
    const server = new FakeServer(
      empty({ all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 })
    );
    server.now = NOON;
    await page.clock.install({ time: new Date(NOON) });
    await serve(page, server);
    // a full load of the address: the block comes after the reads, so the page scrolls to it by itself
    await page.goto("/#home-checklist");
    const title = page.getByRole("heading", {
      exact: true,
      name: "Primeiros passos",
    });
    await expect(title).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(title).not.toBeInViewport();
    // on the Início itself, from "Mais": the panel closes and the page goes to the block
    await page.getByRole("button", { exact: true, name: "Mais" }).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await panel
      .getByRole("link", {
        exact: true,
        name: "Primeiros passos, 2 de 3 concluídos",
      })
      .click();
    await expect(panel).toBeHidden();
    await expect(title).toBeInViewport();
  });

  for (const [state, stock, current] of [
    [
      "sem produto, com os dois botões do passo 2",
      { all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 },
      1,
    ],
    [
      "com produto, sem os botões",
      { all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 },
      2,
    ],
  ] as const) {
    for (const viewport of [
      { height: 740, width: 360 },
      { height: 800, width: 1280 },
    ]) {
      test(`o passo atual destaca um só item e não muda a altura do bloco: ${state}, ${viewport.width} px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await openHome(page, new FakeServer(empty({ ...stock })));
        const checklist = region(page, "Primeiros passos");
        const items = checklist.getByRole("listitem");
        await expect(items).toHaveCount(3);
        await expect(checklist.locator("[aria-current]")).toHaveCount(1);
        await expect(items.nth(current)).toHaveAttribute(
          "aria-current",
          "step"
        );
        const heights = async () => ({
          block: (await checklist.boundingBox())?.height ?? 0,
          rows: await Promise.all(
            [0, 1, 2].map(
              async (index) =>
                (await items.nth(index).boundingBox())?.height ?? 0
            )
          ),
        });
        const circles = await Promise.all(
          [0, 1, 2].map((index) =>
            items
              .nth(index)
              .locator("span[aria-hidden='true']")
              .first()
              .boundingBox()
          )
        );
        for (const box of circles) {
          expect(box?.width).toBeCloseTo(circles[0]?.width ?? 0, 0);
          expect(box?.height).toBeCloseTo(circles[0]?.height ?? 0, 0);
        }
        const marked = await heights();
        // the same block with the mark of the current step taken off: the mark must not take a pixel of height
        await items.nth(current).evaluate((item) => {
          item.removeAttribute("aria-current");
          const circle = item.querySelector("[aria-hidden='true']");
          circle?.classList.remove(
            "border-mark",
            "bg-mark/10",
            "text-mark-foreground"
          );
        });
        const plain = await heights();
        expect(Math.abs(marked.block - plain.block)).toBeLessThanOrEqual(1);
        for (const index of [0, 1, 2]) {
          expect(
            Math.abs((marked.rows[index] ?? 0) - (plain.rows[index] ?? 0))
          ).toBeLessThanOrEqual(1);
        }
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }

  test("com estoque, o botão vai à Venda", async ({ page }) => {
    await openHome(
      page,
      new FakeServer(
        empty({ all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 })
      )
    );
    await expect(
      region(page, "Primeiros passos").getByRole("link", {
        name: "Fazer a 1ª venda",
      })
    ).toHaveAttribute("href", "/sales");
  });

  test("a loja que já vendeu (mesmo cancelada) não vê o checklist: vê os vazios com a ação", async ({
    page,
  }) => {
    await openHome(
      page,
      new FakeServer({
        ...empty({ all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 }),
        everSold: true,
      })
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    const month = region(page, "Vendas em outubro");
    await expect(month).toContainText("Nenhuma venda ainda");
    await expect(
      month.getByRole("link", { name: "Fazer uma venda" })
    ).toHaveAttribute("href", "/sales");
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await expect(region(page, "Mais vendidos do mês")).toHaveCount(0);
    await expect(region(page, "Vendas por dia")).toContainText(
      "Sem vendas no período."
    );
    // never "0%" nor an arrow over nothing
    await expect(page.locator("main")).not.toContainText("0%");
  });
});

test.describe("Vendas hoje sem base de comparação", () => {
  test("hoje sem venda, com as 4 sextas somando zero ou menos, diz que não há média e não promete comparação", async ({
    page,
  }) => {
    const returned: Scenario = {
      ...SOLD,
      days: { "2026-10-02": [5000, 1], "2026-10-09": [-5000, 1] },
    };
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(returned));
    const today = region(page, "Vendas hoje");
    await expect(today).toContainText("Nenhuma venda ainda");
    await expect(today.locator("[data-kpi-delta]")).toHaveCount(0);

    await page.getByRole("button", { name: "Sobre Vendas hoje" }).click();
    await expect(
      page.getByText(
        "Vendas líquidas de hoje. Sem média das 4 sextas-feiras anteriores para comparar.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Compara com a média");
  });
});

test.describe("cartões de KPI (revisão de UI v7, § 3 e § 6)", () => {
  /** The results of the days that sold: 30 % of the net sales, known on every day of both months. */
  const KNOWN: Record<string, number> = {
    "2026-09-20": 1500,
    "2026-09-21": 3600,
    "2026-10-02": 2400,
    "2026-10-18": 55_200,
    "2026-10-20": 12_615,
    "2026-10-23": 9603,
  };
  test("o dedo ou o mouse numa sparkline do mês lê o mesmo dia nos três cartões; Vendas hoje lê sozinho; ao sair, volta para hoje", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const sales = region(page, "Vendas em outubro");
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-spark] svg")).toBeVisible();
    // the result's chip is in reais: 1 to 23 October against 1 to 23 September (R$ 798,18 − R$ 51,00)
    await expect(result.locator("[data-kpi-delta=up]")).toHaveText(
      "+R$ 747,18"
    );
    const strip = await sales.locator("[data-kpi-spark] svg").boundingBox();
    if (!strip) {
      throw new Error("a sparkline das vendas do mês não apareceu");
    }
    // the 18th of 23 days: the cards read the 1st to the 18th together
    const x = strip.x + 4 + ((strip.width - 8) * 17) / 22;
    await page.mouse.move(x, strip.y + strip.height / 2);
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 18/10");
    await expect(result.locator("[data-kpi-date]")).toHaveText("Até 18/10");
    await expect(sales.locator("[data-kpi-value]")).toHaveText("R$ 1.920,00");
    await expect(sales).toContainText("7 vendas");
    await expect(result.locator("[data-kpi-value]")).toHaveText("R$ 576,00");
    // Vendas hoje reads alone: it has no date at rest and the strip of the month does not move it
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-date]")
    ).toHaveCount(0);

    await page.mouse.move(10, 10);
    await expect(sales.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(sales.locator("[data-kpi-value]")).toHaveText("R$ 2.660,60");
  });

  test("pelo teclado: as setas andam pelos dias, o aria-valuetext diz o dia e o valor, e ao sair tudo volta para hoje", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const sales = region(page, "Vendas em outubro");
    const slider = sales.getByRole("slider");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 23/10: R$ 2.660,60"
    );
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 22/10: R$ 2.340,50"
    );
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 22/10");
    // the outline of the keyboard focus goes round the strip, inside it
    expect(
      await slider.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.outlineWidth, style.outlineOffset];
      })
    ).toEqual(["3px", "-3px"]);

    const today = region(page, "Vendas hoje").getByRole("slider");
    await today.focus();
    await expect(sales.locator("[data-kpi-date]")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(today).toHaveAttribute(
      "aria-valuetext",
      "qui, 22/10: R$ 0,00"
    );
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-date]")
    ).toHaveText("qui, 22/10");
    await expect(region(page, "Vendas hoje")).toContainText("Nenhuma venda");
  });

  test("Esconder valores: todo valor em reais vira R$ ••••, as porcentagens e as contagens ficam, e a escolha fica no aparelho", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const main = page.locator("main");
    const toggle = page.getByRole("button", { name: "Esconder valores" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(main).toContainText("R$ 320,10");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(main).not.toContainText("R$ 320,10");
    await expect(main).not.toContainText("R$ 2.660,60");
    await expect(main).not.toContainText("R$ 747,18");
    await expect(main).not.toContainText("R$ 1.840,00");
    // no amount anywhere in the page, the chip in reais of the result included, nor in what a slider says
    await expect(main).not.toContainText(AN_AMOUNT);
    await expect(region(page, "Resultado estimado")).toContainText("R$ ••••");
    // the sign of the chip in reais stays with the hidden amount, in one box: "+R$ ••••", no gap after the sign
    const resultChip = region(page, "Resultado estimado").locator(
      "[data-kpi-delta=up]"
    );
    await expect(resultChip.locator(":scope > span")).toHaveCount(1);
    await expect(resultChip.locator(":scope > span")).toHaveText(
      "+R$ ••••valor escondido"
    );
    const spoken = await main
      .getByRole("slider")
      .evaluateAll((sliders) =>
        sliders.map((slider) => slider.getAttribute("aria-valuetext") ?? "")
      );
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.filter((text) => AN_AMOUNT.test(text))).toEqual([]);
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-value]")
    ).toHaveText("R$ ••••valor escondido");
    // the percents, the counts and the shape stay
    await expect(region(page, "Vendas hoje")).toContainText("16,0×");
    await expect(region(page, "Vendas em outubro")).toContainText("12 vendas");
    await expect(region(page, "Mais vendidos do mês")).toContainText("9 un.");
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas líquidas por dia, de 1 a 23/10: valor escondido no total"
    );
    await expect(chart.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "23/10: valor escondido"
    );

    // kept on the device, like the theme: the next opening still hides
    expect(
      await page.evaluate(() => localStorage.getItem("polaris-valores"))
    ).toBe("escondidos");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Esconder valores" })
    ).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).not.toContainText("R$ 320,10");

    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(
      await page.evaluate(() => localStorage.getItem("polaris-valores"))
    ).toBeNull();
  });

  test("um dia sem custo no mês: o resultado diz quantos, com o selo, sem sparkline e sem chip (AC-9)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(
      page,
      new FakeServer({
        ...SOLD,
        results: { ...KNOWN, "2026-10-20": null },
      })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result.locator("[data-kpi-unknown]")).toHaveText(
      "1 de 23 dias sem custo"
    );
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("slider")).toHaveCount(0);
    // the other cards still read and compare
    await expect(
      region(page, "Vendas em outubro").locator("[data-kpi-spark] svg")
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("nenhum custo de mercadoria conhecido no mês: o resultado é “—” com o selo e a frase, sem sparkline e sem chip, e os outros cartões ficam (T399-3)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    // the 12 item lines sold in October have no cost: every day with a sale has a null result
    await openHome(
      page,
      new FakeServer({
        ...SOLD,
        results: {
          ...KNOWN,
          "2026-10-02": null,
          "2026-10-18": null,
          "2026-10-20": null,
          "2026-10-23": null,
        },
        soldWithoutCost: 12,
      })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result).toContainText(
      "Sem custo informado: não dá para estimar."
    );
    await expect(result).toContainText("—");
    await expect(result).not.toContainText("R$");
    await expect(result).not.toContainText("dias sem custo");
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("slider")).toHaveCount(0);
    await expect(
      region(page, "Vendas em outubro").locator("[data-kpi-spark] svg")
    ).toBeVisible();
    await expect(region(page, "Vendas em outubro")).toContainText("R$");
  });

  test("Vendas por dia: o anel do melhor dia e o de hoje, só o pico escrito (com a data), sem legenda nem linha de leitura em repouso", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    // the best day and today: the month to today sold on the 18th and on the 23rd
    await expect(chart.locator("[data-chart-mark]")).toHaveCount(2);
    await expect(chart.locator("[data-chart-mark=sold]")).toHaveCount(2);
    await expect(chart.locator("[data-chart-best]")).toHaveAttribute(
      "r",
      "5.5"
    );
    // only the peak is written, with its date: today's value is in its card
    await expect(chart.locator("[data-chart-value-label]")).toHaveText([
      "18/10 · R$ 1.840,00",
    ]);
    // no legend, and nothing above the drawing at rest
    await expect(chart.locator("[data-chart-legend]")).toHaveCount(0);
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);
  });

  for (const width of [360, 320]) {
    test(`Vendas por dia: o rótulo do pico não encosta no eixo nem sai do gráfico (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      const label = chart.locator("[data-chart-value-label]");
      await expect(label).toHaveText("18/10 · R$ 1.840,00");
      const boxes = await chart
        .locator("[data-chart-area] svg text")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return {
              isLabel: node.hasAttribute("data-chart-value-label"),
              left: box.left,
              right: box.right,
              text: node.textContent ?? "",
              top: box.top,
              bottom: box.bottom,
            };
          })
        );
      const peak = boxes.find((box) => box.isLabel);
      expect(peak).toBeDefined();
      for (const other of boxes.filter((box) => !box.isLabel)) {
        const apart =
          (peak?.right ?? 0) <= other.left ||
          other.right <= (peak?.left ?? 0) ||
          (peak?.bottom ?? 0) <= other.top ||
          other.bottom <= (peak?.top ?? 0);
        expect(apart, `o rótulo do pico sobre "${other.text}"`).toBe(true);
      }
      expect(peak?.left ?? 0).toBeGreaterThanOrEqual(0);
      expect(peak?.right ?? 0).toBeLessThanOrEqual(width);
    });
  }

  test("Vendas por dia: o melhor dia tem anel cheio, hoje sem venda tem anel vazado e sem rótulo, e os outros dias não têm anel", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    // the month of the chart sold on the 2nd, the 18th and the 20th; today (`23/10`) sold nothing
    const { "2026-10-23": _today, ...noSaleToday } = SOLD.days;
    await openHome(page, new FakeServer({ ...SOLD, days: noSaleToday }));
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-mark]")).toHaveCount(2);
    const best = chart.locator("[data-chart-best]");
    await expect(best).toHaveAttribute("data-chart-mark", "sold");
    await expect(best).toHaveAttribute("r", "5.5");
    await expect(chart.locator("[data-chart-mark=sold]")).toHaveCount(1);
    // the ring of today is hollow (a card-colored fill, the stroke in the color of the series) and smaller than the best's
    const hollow = chart.locator("[data-chart-mark=none]");
    await expect(hollow).toHaveCount(1);
    await expect(hollow).toHaveAttribute("fill", "var(--card)");
    await expect(hollow).toHaveAttribute("r", "3.5");
    // only the peak is written: the hollow ring of today carries no label, and its value (zero) is not written anywhere
    await expect(chart.locator("[data-chart-value-label]")).toHaveText([
      "18/10 · R$ 1.840,00",
    ]);
    const labelX = await chart
      .locator("[data-chart-value-label]")
      .getAttribute("x");
    const hollowX = await hollow.getAttribute("cx");
    expect(Number(labelX)).not.toBe(Number(hollowX));
    await expect(chart.locator("[data-chart-marks] text")).toHaveCount(1);
    // the best day comes first on the axis, today last: no other day has a ring
    const xs = await chart
      .locator("[data-chart-mark]")
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute("cx")))
      );
    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
  });

  test("Vendas por dia: a leitura de um dia pelo teclado aparece só enquanto dura, com o valor do dia, e a ajuda abre pelo teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    const slider = chart.getByRole("slider");
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuetext", "22/10: R$ 0,00");
    await expect(chart.locator("[data-chart-reading]")).toContainText(
      "22/10 R$ 0,00"
    );
    await slider.blur();
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);

    const help = chart.getByRole("button", { name: "Sobre Vendas por dia" });
    await help.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(
        "Vendas líquidas de cada dia do período. Toque num dia para ver o valor."
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
  });

  for (const viewport of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`Vendas por dia: ler um dia pelo teclado não move o gráfico nem o que vem depois (${viewport.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      const area = chart.locator("[data-chart-area]");
      const total = chart.locator("p.grid > span").first();
      const box = async (locator: Locator) => {
        const found = await locator.boundingBox();
        if (!found) {
          throw new Error("elemento sem caixa");
        }
        return found;
      };
      const at = async () => ({
        area: await box(area),
        region: await box(chart),
        total: await box(total),
      });
      await expect(area).toBeVisible();
      await chart.getByRole("slider").focus();
      const before = await at();
      await page.keyboard.press("ArrowLeft");
      const reading = chart.locator("[data-chart-reading]");
      await expect(reading).toContainText("22/10 R$ 0,00");
      await expect(reading).toBeVisible();
      const tooltipRows = chart.locator("[data-chart-tooltip-row]");
      await expect(tooltipRows).toHaveCount(0);
      const during = await at();
      expect(during).toEqual(before);

      const read = await box(reading);
      const frame = await box(area.locator(".."));
      expect(read.x).toBeGreaterThanOrEqual(frame.x);
      expect(read.y).toBeGreaterThanOrEqual(frame.y);
      expect(read.x + read.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(read.y + read.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(read.x - frame.x).toBeLessThan(frame.width / 4);
      expect(read.y - frame.y).toBeLessThan(frame.height / 4);

      await page.keyboard.press("ArrowLeft");
      await expect(reading).toContainText("21/10");
      await expect(tooltipRows).toHaveCount(0);
      expect(await at()).toEqual(before);

      const frameKeys = await box(area);
      await page.mouse.move(
        frameKeys.x + frameKeys.width / 2,
        frameKeys.y + frameKeys.height / 2
      );
      await expect(tooltipRows.first()).toBeVisible();
      await expect(reading).toHaveCount(0);
      await page.keyboard.press("ArrowLeft");
      await expect(reading).toContainText("20/10");
      await expect(tooltipRows).toHaveCount(0);
      expect(await at()).toEqual(before);

      await chart.getByRole("slider").blur();
      await expect(reading).toHaveCount(0);
      expect(await at()).toEqual(before);

      const frameNow = await box(area);
      await page.mouse.move(
        frameNow.x + frameNow.width / 3,
        frameNow.y + frameNow.height / 2
      );
      await expect(tooltipRows.first()).toBeVisible();
      await expect(reading).toHaveCount(0);
      expect(await at()).toEqual(before);
    });
  }

  test("Vendas por dia: o toque (só o pointerdown, sem movimento) devolve o gráfico ao dedo depois de ler um dia pelo teclado", async ({
    page,
  }) => {
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    const area = chart.locator("[data-chart-area]");
    await expect(area).toBeVisible();
    await chart.getByRole("slider").focus();
    await page.keyboard.press("ArrowLeft");
    const reading = chart.locator("[data-chart-reading]");
    await expect(reading).toContainText("22/10");

    await area.dispatchEvent("pointerdown", {
      isPrimary: true,
      pointerType: "touch",
    });
    await expect(reading).toHaveCount(0);
  });
});

test.describe("meta (AC-10, AC-11)", () => {
  test("a última encerrada nos 7 dias aparece sem ativa; pausada não tem percentual", async ({
    page,
  }) => {
    const server = new FakeServer({
      ...SOLD,
      goals: [
        goal({
          achievedValue: "5200.00",
          endsOn: "2026-10-20",
          progress: null,
          settledAt: "2026-10-21T03:05:00.000Z",
          startsOn: "2026-10-01",
          status: "completed",
        }),
      ],
    });
    await openHome(page, server);
    const meta = region(page, "Meta");
    await expect(meta).toContainText("Meta atingida");
    await expect(meta).toContainText("Chegou a R$ 5.200,00 de R$ 5.000,00.");

    server.scenario = {
      ...SOLD,
      goals: [goal({ paused: true, progress: null })],
    };
    await page.reload();
    await expect(region(page, "Meta")).toContainText(
      "Pausada pelo plano: não é medida"
    );
    await expect(region(page, "Meta")).not.toContainText("%");
  });

  test("o anel da meta: Esconder valores mascara os reais (no texto, na estimativa e no nome do anel) e deixa o percentual; sem meta, o anel tracejado e Definir meta", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openHome(page, server);
    const meta = region(page, "Meta");
    const ring = meta.getByRole("img");
    await expect(
      ring.locator("[data-ring-chart] svg path").first()
    ).toBeAttached();
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(meta).not.toContainText("2.670,60");
    await expect(meta).not.toContainText("5.000,00");
    await expect(meta).not.toContainText("5.254,03");
    // the phrase of "batida" has no amount: only the measured and the target are masked
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION
    );
    await expect(meta.locator("[data-masked-money]")).toHaveCount(2);
    await expect(ring).toHaveAttribute(
      "aria-label",
      "53,4% da meta: valor escondido de valor escondido"
    );
    await expect(ring).toContainText("53,4%");

    server.scenario = { ...SOLD, goals: [] };
    await page.reload();
    const empty = region(page, "Meta");
    // no goal: the title and the button, no ring and no sentence (the button says it)
    await expect(empty.locator("[data-goal-ring]")).toHaveCount(0);
    await expect(empty).not.toContainText("Defina quanto");
    await expect(
      empty.getByRole("link", { name: "Definir meta" })
    ).toHaveAttribute("href", "/dashboard?meta=nova");
  });

  test("a frase da estimativa: abaixo do alvo diz onde chega (e Esconder valores a mascara); sem venda nos 7 dias diz que não há o que estimar", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const short = new FakeServer({
      ...SOLD,
      goals: [goal({ target: "6000.00" })],
    });
    await openHome(page, short);
    const meta = region(page, "Meta");
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION_SHORT
    );
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(meta).not.toContainText("5.254,03");
    await expect(meta.locator("[data-masked-money]")).toHaveCount(3);

    // nothing sold from 16 to `22/10`: a "chega a" equal to what was reached would be no estimate
    const { "2026-10-18": _, "2026-10-20": __, ...quiet } = SOLD.days;
    short.scenario = {
      ...SOLD,
      days: quiet,
      goals: [goal({ target: "6000.00" })],
    };
    await page.reload();
    const none = region(page, "Meta").locator("[data-goal-projection]");
    await expect(none).toHaveText(GOAL_PROJECTION_NO_SALES);
    await expect(none).toHaveAttribute("data-goal-projection", "sem-venda");
  });

  test("'Definir meta' abre o formulário de meta no Resultado", async ({
    page,
  }) => {
    await openHome(page, new FakeServer({ ...SOLD, goals: [] }));
    await region(page, "Meta")
      .getByRole("link", { name: "Definir meta" })
      .click();
    await expect(page.getByLabel("Indicador")).toBeFocused();
    // the link did its work: a reload is the screen as it is, not the form again
    await expect(page).toHaveURL(DASHBOARD_GOALS_PATH);
  });
});

test.describe("erro por bloco (§ 5.2): Nova venda sempre visível e levando à Venda", () => {
  for (const kind of ["500", "429", "unmarked"] as const) {
    test(`números com ${kind}: um alerta no lugar deles, e Tentar novamente`, async ({
      page,
    }) => {
      const server = new FakeServer(SOLD);
      server.broken.set("report/periodSummary", kind);
      await openHome(page, server);
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Não foi possível carregar os números da loja." });
      // a 429 at once; a 500 or no answer after the three tries (~1.5 s and ~4 s between them)
      await expect(alert).toBeVisible({ timeout: 15_000 });
      await expect(newSale(page)).toHaveAttribute("href", "/sales");
      await expect(region(page, "Meta")).toContainText("Meta");
      await expect(region(page, "Vendas hoje")).toHaveCount(0);
      server.broken.delete("report/periodSummary");
      await alert.getByRole("button", { name: "Tentar novamente" }).click();
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    });
  }

  test("meta e estoque quebrados: cada um diz o seu, o resto fica", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("goal/list", "500");
    server.broken.set("inventory/listBalances", "500");
    await openHome(page, server);
    await expect(region(page, "Meta")).toContainText(
      "Não foi possível carregar a meta.",
      { timeout: 15_000 }
    );
    await expect(
      page.getByText("Avisos do estoque indisponíveis agora.")
    ).toBeVisible({ timeout: 15_000 });
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    server.broken.delete("goal/list");
    await region(page, "Meta")
      .getByRole("button", { name: "Tentar novamente" })
      .click();
    await expect(
      region(page, "Meta").getByRole("link", { name: "Definir meta" })
    ).toBeVisible();
  });

  test("401: o aviso de sessão do shell, nenhum erro nos blocos", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "401");
    await openHome(page, server);
    await expect(
      page.getByRole("button", { name: "Entrar de novo" })
    ).toBeVisible();
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    await expect(region(page, "Meta")).toHaveCount(0);
    // with no answer about the stock, the block does not say that nothing needs doing
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    await expect(newSale(page)).toBeVisible();
  });

  test("/rpc lento (10 s): esqueletos com a altura guardada, e Nova venda já na tela", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "slow");
    await openHome(page, server);
    await expect(newSale(page)).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Carregando os números…" })
    ).toBeAttached();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
  });
});

test.describe("atualização (§ 5.1, relógio controlado)", () => {
  test("23:59 → 00:01 na mesma sessão: o Hoje passa ao dia novo sozinho", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    const at2359 = Date.parse("2026-10-24T02:59:00.000Z");
    await openHome(page, server, at2359);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    server.now = at2359 + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(before);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
  });

  test("31/10 → 01/11: o mês e os dois períodos mudam", async ({ page }) => {
    const server = new FakeServer(SOLD);
    const at = Date.parse("2026-11-01T02:59:00.000Z");
    await openHome(page, server, at);
    await expect(region(page, "Vendas em outubro")).toBeVisible();
    server.now = at + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect(region(page, "Vendas em novembro")).toBeVisible();
    const asked = periodCalls(server).map(
      (call) => `${call.input.from}..${call.input.to}`
    );
    expect(asked).toContain("2026-11-01..2026-11-30");
    expect(asked).toContain("2026-10-01..2026-10-31");
  });

  test("com o relógio do aparelho errado, o mês é o do servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await page.clock.install({ time: new Date("2026-09-15T15:00:00.000Z") });
    await serve(page, server);
    await page.goto("/");
    await expect(region(page, "Vendas em outubro")).toBeVisible({
      timeout: 20_000,
    });
    expect(periodCalls(server).at(-2)?.input.from).toBe("2026-10-01");
  });

  test("ao voltar à aba relê, no máximo uma vez a cada 30 s", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(periodCalls(server).length).toBe(before);
    await page.clock.runFor(31_000);
    server.scenario = {
      ...SOLD,
      days: { ...SOLD.days, "2026-10-23": [42_010, 3] },
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 420,10");
  });

  test("uma releitura que falha deixa na tela os números já lidos", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    server.broken.set("report/periodSummary", "500");
    await page.clock.runFor(31_000);
    const failedRead = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/report/periodSummary") &&
        response.status() === 500
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failedRead;
    expect(periodCalls(server).length).toBeGreaterThan(before);
    // the answer was handled: the next frame has it
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve))
    );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
  });
});

const SYNCED = /sincronizado/i;
const OFFLINE_KEYS = /^polaris\.offline\.(home|periodSummary|dailySales)\./;

/** The keys of the Início's copy (A, B and the map's series) in this browser. */
const copyKeys = (page: Page) =>
  page.evaluate(
    (pattern) =>
      Object.keys(localStorage)
        .filter((key) => new RegExp(pattern).test(key))
        .sort(),
    OFFLINE_KEYS.source
  );

/** Opens the Início with the server, waits for its copy on the device, and leaves it ready to be cut. */
async function openWithCopy(page: Page, server: FakeServer) {
  await openHome(page, server);
  await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  await expect.poll(() => copyKeys(page)).toHaveLength(3);
  // the offline runtime finished opening (a usable lease, the collections in place): a sale can be kept offline
  await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
    timeout: 20_000,
  });
}

/** Opens the page again with no network at all but `navigator.onLine` true, the device's clock at `at`. */
async function reopenWithoutNetwork(page: Page, server: FakeServer, at = NOON) {
  server.down = true;
  await page.clock.setSystemTime(new Date(at));
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible({ timeout: 20_000 });
}

/** The reads of B (the days before the month) and of the month (A) of the Início, by the period they asked for. */
const beforeReads = (server: FakeServer) =>
  periodCalls(server).filter((call) => call.input.to === "2026-09-30").length;
const monthReads = (server: FakeServer) =>
  periodCalls(server).filter((call) => call.input.from === "2026-10-01").length;
const UPDATED_AT = /atualizado às \d{2}:\d{2}/;
const refreshButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Atualizar" });

test.describe("janela anterior do Início: uma leitura por dia da loja (relógio controlado)", () => {
  test("a segunda abertura no mesmo dia lê só o mês; no dia seguinte, as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    expect([beforeReads(server), monthReads(server)]).toEqual([1, 1]);

    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(3);
    expect([beforeReads(server), monthReads(server)]).toEqual([1, 2]);

    server.now = NOON + DAY;
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    expect(periodCalls(server)).toHaveLength(5);
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 3]);
  });

  test("voltar à aba no mesmo dia relê o mês e não a janela anterior", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => monthReads(server)).toBe(2);
    expect(beforeReads(server)).toBe(1);
  });

  test("Atualizar relê as duas, mesmo no mesmo dia", async ({ page }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(2);

    await refreshButton(page).click();

    await expect.poll(() => periodCalls(server).length).toBe(4);
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);
  });

  test("Atualizar pelo teclado: o foco fica no botão, o status diz 'Atualizando…' e depois 'atualizado às', e um segundo Enter não lê de novo", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(2);
    const updated = page.locator("#home-updated");
    await expect(updated).toHaveAttribute("role", "status");
    await expect(updated).toContainText(UPDATED_AT);
    const busy = page.locator("[aria-busy='true']:has(#home-today)");
    await expect(busy).toHaveCount(0);

    let answer: () => void = () => undefined;
    server.held.set(
      "report/periodSummary",
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const button = refreshButton(page);
    await button.focus();
    await page.keyboard.press("Enter");

    await expect(updated).toHaveText("Atualizando…");
    await expect(busy).toHaveCount(1);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).not.toHaveAttribute("disabled");
    await expect(button).toBeFocused();
    await expect.poll(() => periodCalls(server).length).toBe(4);

    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
    expect(periodCalls(server)).toHaveLength(4);

    answer();
    await expect(updated).toHaveText(UPDATED_AT);
    await expect(busy).toHaveCount(0);
    await expect(button).not.toHaveAttribute("aria-disabled");
    await expect(button).toBeFocused();
    expect(periodCalls(server)).toHaveLength(4);
  });

  test("Tentar novamente depois de uma falha também lê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    // the month fails on the next opening, with the day's copy of B in hand
    server.broken.set("report/periodSummary", "500");
    await page.reload();
    const retry = page.getByRole("button", { name: "Tentar novamente" });
    await expect(retry.first()).toBeVisible({ timeout: 20_000 });
    server.broken.delete("report/periodSummary");
    const asked = periodCalls(server).length;

    await retry.first().click();

    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server).length).toBe(asked + 2);
  });

  test("com outra janela (a virada do mês), lê as duas", async ({ page }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);

    server.now = Date.parse("2026-11-01T15:00:00.000Z");
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(region(page, "Vendas em novembro")).toBeVisible();

    expect(periodCalls(server)).toHaveLength(4);
    expect(
      periodCalls(server)
        .slice(2)
        .map((call) => `${call.input.from}..${call.input.to}`)
        .sort()
    ).toEqual(["2026-10-01..2026-10-31", "2026-11-01..2026-11-30"]);
  });

  test("com o relógio do aparelho um dia atrás do servidor, a cópia do dia do aparelho não serve", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server, NOON - DAY);
    // the eve of the server's day: nothing sold on it, and Vendas hoje has no date to say so
    await expect(region(page, "Vendas hoje")).toContainText("R$ 0,00");
    await expect.poll(() => copyKeys(page)).toHaveLength(3);
    // the copy was read on the eve of the server's day while the device clock still says that eve: the copy is
    // the device's today, not the store's, and the month's answer says so
    server.now = NOON;
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);
  });

  test("a loja recusa os números: a janela anterior guardada some junto e não volta sem o servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);

    server.broken.delete("report/periodSummary");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(beforeReads(server)).toBe(2);
  });
});

test.describe("janela anterior do Início: o que muda neste aparelho", () => {
  const cancelSale = async (page: Page) => {
    await page.goto(`/sales/detail?saleId=${SALE_ID}`);
    await page
      .getByRole("button", { exact: true, name: "Cancelar venda" })
      .click();
    await page.getByRole("button", { name: "Revisar cancelamento" }).click();
    await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
    await expect(page.getByText(CANCELLED_NOTICE)).toBeVisible();
  };

  test("cancelar neste aparelho uma venda de antes do mês: a próxima abertura relê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.saleOccurredOn = "2026-09-12";
    await openWithCopy(page, server);

    await cancelSale(page);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);

    // read again from the server, the copy is of the day again
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 3]);
  });

  test("cancelar uma venda do mês corrente não mexe na janela anterior", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.saleOccurredOn = "2026-10-05";
    await openWithCopy(page, server);

    await cancelSale(page);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");

    expect([beforeReads(server), monthReads(server)]).toEqual([1, 2]);
  });
});

test.describe("janela anterior do Início: uma despesa neste aparelho", () => {
  const fillCompetence = async (page: Page, competenceOn: string) => {
    await pickDate(page, "Data de competência", competenceOn);
    await page.getByLabel("Valor (R$)").fill("80");
    await page.getByLabel("Descrição").fill("Conta de luz");
  };
  const registerExpense = async (page: Page, competenceOn: string) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .click();
    const form = page.getByRole("dialog", {
      exact: true,
      name: "Nova despesa",
    });
    await expect(form).toBeVisible();
    await fillCompetence(page, competenceOn);
    await form
      .getByRole("combobox", { exact: true, name: "Categoria" })
      .click();
    await page.getByRole("option", { exact: true, name: "Aluguel" }).click();
    await page.getByRole("button", { name: "Registrar despesa" }).click();
    await expect(page.getByText("Despesa registrada.")).toBeVisible();
  };
  const editExpense = async (page: Page, competenceOn: string) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { name: "Editar despesa Conta de luz" })
      .click();
    await pickDate(page, "Data de competência", competenceOn);
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.getByText("Despesa atualizada.")).toBeVisible();
  };
  const voidExpense = async (page: Page) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { name: "Anular despesa Conta de luz" })
      .click();
    await expect(
      page.getByText("Despesa “Conta de luz” anulada.")
    ).toBeVisible();
  };
  const seeded = (competenceOn: string) => {
    const server = new FakeServer(SOLD);
    server.expenses.push({
      competenceOn,
      description: "Conta de luz",
      id: "0199c2d0-0000-7000-8000-0000000000e9",
      status: "active",
      version: 1,
    });
    return server;
  };
  /** Opens the Início again and says how many of the two windows it read: [B, A]. */
  const reopened = async (page: Page, server: FakeServer) => {
    const beforeB = beforeReads(server);
    const beforeA = monthReads(server);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    return [beforeReads(server) - beforeB, monthReads(server) - beforeA];
  };

  test("registrar com competência de antes do mês: a próxima abertura relê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await registerExpense(page, "2026-09-15");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("registrar com competência do mês corrente: a janela anterior segue da cópia, só o mês é lido", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await registerExpense(page, "2026-10-03");
    expect(await reopened(page, server)).toEqual([0, 1]);
  });

  test("editar a competência de uma despesa do mês para antes dele: relê as duas", async ({
    page,
  }) => {
    const server = seeded("2026-10-05");
    await openWithCopy(page, server);
    await editExpense(page, "2026-09-15");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("editar a competência de uma despesa de antes do mês para dentro dele: relê as duas", async ({
    page,
  }) => {
    const server = seeded("2026-09-15");
    await openWithCopy(page, server);
    await editExpense(page, "2026-10-05");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("anular uma despesa de antes do mês: relê as duas", async ({ page }) => {
    const server = seeded("2026-09-15");
    await openWithCopy(page, server);
    await voidExpense(page);
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("anular uma despesa do mês corrente: a janela anterior segue da cópia", async ({
    page,
  }) => {
    const server = seeded("2026-10-05");
    await openWithCopy(page, server);
    await voidExpense(page);
    expect(await reopened(page, server)).toEqual([0, 1]);
  });
});

const OFFLINE_SALE = "Sem internet. A venda é enviada quando a conexão voltar.";
/** The note of each card (and of the goal) without a connection and without a copy: the reason is said once, above. */
const NO_CONNECTION = "Sem conexão";
const NO_COPY_REASON = "Sem internet. Os números";
const CONFIRMED = "Confirmado em 23/10 12:00";

test.describe("sem conexão (§ 7, AC-28 a AC-31)", () => {
  test("com cópia, a rede cai: os números ficam como último resultado confirmado, a meta, a linha do aparelho e os avisos só com conexão", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    const reads = server.calls.length;
    await page.context().setOffline(true);

    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible();
    await expect(page.getByText("atualizado às")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    await expect(region(page, "Mais vendidos do mês")).toContainText(
      "Camiseta básica"
    );
    await expect(region(page, "Vendas por dia")).toBeVisible();
    await expect(region(page, "Meta")).toContainText("Meta de outubro");
    await expect(region(page, "Meta")).toContainText("53,4%");
    await expect(region(page, "Meta")).not.toContainText("Ver as outras");
    // the stock is not read without a connection, and nothing is said of it under the cards
    await expect(page.getByText("Avisos do estoque")).toHaveCount(0);
    await expect(page.getByText("sem saldo")).toHaveCount(0);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    await expect(newSale(page)).toHaveAttribute("href", "/sales");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    // the Início is no longer an online-only screen: the shell does not cover it with its notice
    await expect(
      page.getByText("Esta tela precisa de conexão.", { exact: false })
    ).toHaveCount(0);
    // no read while offline, not even when the tab comes back
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(server.calls.length).toBe(reads);
  });

  test("a rede volta: o Início lê de novo e diz 'Atualizado até', sem esqueleto", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.context().setOffline(true);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    const reads = periodCalls(server).length;
    await page.context().setOffline(false);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(reads);
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();
    await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });

  for (const viewport of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`a linha de ações fica no mesmo lugar, com Atualizar desligado, sem conexão e na volta (${viewport.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = new FakeServer(SOLD);
      await openWithCopy(page, server);
      const actions = [
        refreshButton(page),
        page.getByRole("button", { name: "Esconder valores" }),
        newSale(page),
      ];
      const boxes = async () =>
        Promise.all(
          actions.map(async (action) => {
            const box = await action.boundingBox();
            expect(box).not.toBeNull();
            return box as NonNullable<typeof box>;
          })
        );
      const sameAs = (before: Awaited<ReturnType<typeof boxes>>) =>
        expect
          .poll(async () => {
            const now = await boxes();
            return Math.max(
              ...before.flatMap((ref, index) => {
                const box = now[index];
                return box
                  ? [
                      Math.abs(box.x - ref.x),
                      Math.abs(box.y - ref.y),
                      Math.abs(box.width - ref.width),
                      Math.abs(box.height - ref.height),
                    ]
                  : [Number.POSITIVE_INFINITY];
              })
            );
          })
          .toBeLessThanOrEqual(1);
      await expect(refreshButton(page)).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
      const online = await boxes();

      await page.context().setOffline(true);
      await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
      await expect(refreshButton(page)).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(refreshButton(page)).toHaveAttribute(
        "aria-describedby",
        "home-new-sale-offline"
      );
      await expect(refreshButton(page)).toHaveAccessibleDescription(
        OFFLINE_SALE
      );
      await sameAs(online);
      const reads = server.calls.length;
      await refreshButton(page).click({ force: true });
      expect(server.calls.length).toBe(reads);

      await page.context().setOffline(false);
      await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
      await expect(refreshButton(page)).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(refreshButton(page)).not.toHaveAttribute("aria-describedby");
      await sameAs(online);
    });
  }

  test("o período escolhido e a rolagem sobrevivem à queda e à volta da conexão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    const chart = region(page, "Vendas por dia");
    await choosePeriod(page, "Mês passado");
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await expect(chart).toContainText("1 a 30/09");
    await chart.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    // the blocks above the chart change height offline (the sentence under "Nova venda", the stock's lines): the
    // proof is that the page does not jump back to the top and the chart stays in view, not the exact pixel
    const kept = async () => {
      await expect(chart).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
        scrolled / 2
      );
    };

    await page.context().setOffline(true);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await expect(chart).toContainText("1 a 30/09");
    await kept();

    await page.context().setOffline(false);
    await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await kept();
  });

  test("aberto sem resposta do Worker e com navigator.onLine verdadeiro: a cópia, nunca um erro", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("sem cópia: os quatro cartões no lugar com '—' e 'Sem conexão', o motivo dito uma vez sob o título, sem zeros; Nova venda continua", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(page.getByText("R$")).toHaveCount(0);
    for (const name of [
      "Vendas hoje",
      "Vendas em outubro",
      "Resultado estimado",
      "Ticket médio",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one card after the other
      await expect(region(page, name)).toContainText("—sem valor");
      await expect(region(page, name)).toContainText(NO_CONNECTION);
    }
    // the chart keeps its place and its name, so the goal beside it does not change columns
    await expect(region(page, "Vendas por dia")).toContainText(NO_CONNECTION);
    await expect(page.getByText("Ver os números")).toHaveCount(0);
    await expect(region(page, "Meta")).toContainText(NO_CONNECTION);
    await expect(region(page, "Meta")).not.toContainText("Definir meta");
    // the reason once, in the line under the title, which "Nova venda" points to: never in each card
    await expect(page.locator("#home-updated")).toContainText(NO_COPY_REASON);
    await expect(page.getByText(NO_COPY_REASON)).toHaveCount(1);
    await expect(page.getByText("Sem internet")).toHaveCount(1);
    await expect(page.locator("#home-new-sale-offline")).toHaveText(
      "A venda é enviada quando a conexão voltar."
    );
    await expect(refreshButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(refreshButton(page)).toHaveAttribute(
      "aria-describedby",
      "home-updated"
    );
    await expect(page.getByText("Avisos do estoque")).toHaveCount(0);
    await expect(newSale(page)).toHaveAttribute("href", "/sales");
  });

  test("sem cópia e sem conexão o botão do período está desligado e a frase dos dois meses não aparece nem para o leitor de tela; com a cópia ela aparece", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    const sentence = page
      .locator("[data-home-period]")
      .getByText("Sem conexão: só este mês e o anterior.");
    await page.context().setOffline(true);
    await expect(sentence).toBeVisible();
    await expect(sentence).not.toHaveAttribute("aria-hidden", "true");
    await page.context().setOffline(false);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(periodButton(page)).toBeDisabled();
    const hidden = page
      .locator("[data-home-period] p")
      .filter({ hasText: "Sem conexão: só este mês e o anterior." });
    await expect(hidden).toHaveAttribute("aria-hidden", "true");
    await expect(hidden).toBeHidden();
  });

  test("loja que já vendeu, sem venda no mês nem antes: aberta sem rede a partir da cópia, o checklist não aparece", async ({
    page,
  }) => {
    const server = new FakeServer({
      days: {},
      everSold: true,
      goals: [],
      soldWithoutCost: 0,
      stock: { all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 },
    });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    await expect
      .poll(async () => (await copyKeys(page)).length)
      .toBeGreaterThan(0);
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await reopenWithoutNetwork(page, server);
    await expect(page.getByText(CONFIRMED, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(region(page, "Vendas em outubro")).toBeVisible();
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
  });

  for (const [hours, stale] of [
    [23, false],
    [25, true],
  ] as const) {
    test(`cópia de ${hours} h: ${stale ? "diz que pode estar desatualizada" : "sem o aviso de idade"}, e o Hoje não é de outro dia`, async ({
      page,
    }) => {
      const server = new FakeServer(SOLD);
      await openWithCopy(page, server);
      await reopenWithoutNetwork(page, server, NOON + hours * HOUR);
      const line = page.locator("#home-updated");
      await expect(line).toContainText(CONFIRMED, { timeout: 20_000 });
      if (stale) {
        await expect(line).toContainText("pode estar desatualizado");
      } else {
        await expect(line).not.toContainText("desatualizados");
      }
      await expect(region(page, "Vendas hoje")).toContainText(
        "Sem números de hoje"
      );
      await expect(region(page, "Vendas hoje")).not.toContainText("R$ 320,10");
      // the month is still the confirmed one, said as such
      await expect(region(page, "Vendas em outubro")).toContainText(
        "R$ 2.660,60"
      );
    });
  }

  test("relógio do aparelho atrasado: a idade e o Hoje seguem o horário do servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON - 2 * DAY);
    await expect(page.locator("#home-updated")).toContainText(
      "pode estar desatualizado",
      { timeout: 20_000 }
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
  });

  test("meta guardada: no último dia em andamento, no dia seguinte 'Esta meta terminou'", async ({
    page,
  }) => {
    const server = new FakeServer({
      ...SOLD,
      goals: [goal({ endsOn: "2026-10-24", startsOn: "2026-10-18" })],
    });
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + DAY);
    await expect(region(page, "Meta")).toContainText("53,4%", {
      timeout: 20_000,
    });
    await page.clock.setSystemTime(new Date(NOON + 2 * DAY));
    await page.reload();
    await expect(region(page, "Meta")).toContainText(
      "Esta meta terminou. O resultado sai com conexão.",
      { timeout: 20_000 }
    );
    await expect(region(page, "Meta")).not.toContainText("%");
  });

  test("cópia antiga sem a série: os totais aparecem e nada da série é desenhado", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (!new RegExp(pattern).test(key)) {
          continue;
        }
        const kept = JSON.parse(localStorage.getItem(key) ?? "{}");
        if (kept.summary) {
          kept.summary.daily = undefined;
        }
        if (kept.before) {
          kept.before.daily = undefined;
        }
        localStorage.setItem(key, JSON.stringify(kept));
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60",
      {
        timeout: 20_000,
      }
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(page.getByText("a mais que no mesmo período")).toHaveCount(0);
  });

  test("cópia malformada: descartada, vale como sem cópia (Sem conexão), e a tela não cai", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("polaris.offline.home.")) {
          localStorage.setItem(key, '{"before":{"period":1},"goal":');
        }
      }
    });
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(newSale(page)).toBeVisible();
  });

  test("troca de usuário no mesmo navegador: nenhum número de A aparece para B", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    // A's session ends with no "Sair" (it expired): B signs in on the same browser, with B's own store
    server.user = { email: "outra@exemplo.com.br", id: "outra-pessoa" };
    server.organization = {
      ...server.organization,
      id: "0199c2d0-0000-7000-8000-00000000b002",
      name: "Loja da outra pessoa",
    };
    server.scenario = { ...SOLD, days: {}, everSold: false };
    await page.reload();
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible({
      timeout: 20_000,
    });
    await page.context().setOffline(true);
    await expect(
      page
        .locator("#home-updated, #home-new-sale-offline")
        .filter({ hasText: "Sem internet" })
        .first()
    ).toBeVisible();
    await expect(page.getByText("R$ 320,10")).toHaveCount(0);
    await expect(page.getByText("R$ 2.660,60")).toHaveCount(0);
    await expect(page.getByText("Camiseta básica")).toHaveCount(0);
  });

  test("a meia-noite da loja passa com a página aberta sem rede: o Hoje da cópia deixa de valer", async ({
    page,
  }) => {
    // 23:50 of `23/10` in Brasília
    const lateEvening = Date.parse("2026-10-24T02:50:00.000Z");
    const server = new FakeServer(SOLD);
    server.now = lateEvening;
    await page.clock.install({ time: new Date(lateEvening) });
    await serve(page, server);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    await expect.poll(() => copyKeys(page)).toHaveLength(3);
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await page.context().setOffline(true);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await page.clock.runFor(15 * 60_000);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
  });

  test("aberto sem rede, a rede volta: a cópia fica na tela até a leitura responder, sem esqueleto", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    // the network is back, and the server takes its time to answer
    server.broken.set("report/periodSummary", "slow");
    server.down = false;
    const asked = periodCalls(server).length;
    await page.clock.runFor(10_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(asked);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expect(page.getByText(CONFIRMED)).toBeVisible();
    server.broken.delete("report/periodSummary");
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("aberto sem rede, a rede volta e o estoque demora: a cópia fica até o estoque responder, com Meta, Gráfico e Ritmo", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    const expectParts = () =>
      Promise.all(
        ["Meta", "Vendas por dia", "Ritmo de vendas"].map((name) =>
          expect(region(page, name)).toBeVisible()
        )
      );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    await expectParts();
    // the network is back: the figures answer at once, the stock's read is held
    let answerStock: () => void = () => undefined;
    server.held.set(
      "inventory/listBalances",
      new Promise((resolve) => {
        answerStock = resolve;
      })
    );
    const balances = () =>
      server.calls.filter((call) => call.procedure === "inventory/listBalances")
        .length;
    const asked = periodCalls(server).length;
    server.down = false;
    await page.clock.runFor(10_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(asked);
    await expect.poll(balances).toBeGreaterThan(0);
    // the stock is asked only after the figures answered; two frames later the page has rendered that answer
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    // between the answer of the figures and the stock's: still the copy, no skeleton, nothing leaves
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expectParts();
    answerStock();
    await expect(page.locator("#home-updated")).toContainText(UPDATED_AT);
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expectParts();
  });

  test("sem cópia a 1280: a mesma grade da tela com cópia, e os cartões não trocam de lugar quando a rede volta", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(region(page, "Vendas em outubro")).toContainText(
      NO_CONNECTION
    );
    const places = async () => ({
      goal: await region(page, "Meta").boundingBox(),
      month: await region(page, "Vendas em outubro").boundingBox(),
      today: await region(page, "Vendas hoje").boundingBox(),
    });
    const before = await places();
    // Hoje on the left, the month on the right in the same row, Meta below them
    expect(before.month?.x ?? 0).toBeGreaterThan(
      (before.today?.x ?? 0) + (before.today?.width ?? 0)
    );
    expect(before.month?.y).toBe(before.today?.y);
    const bottom = (before.today?.y ?? 0) + (before.today?.height ?? 0);
    expect(before.goal?.y ?? 0).toBeGreaterThan(bottom);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);

    server.down = false;
    await page.clock.runFor(10_000);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    const after = await places();
    // the sentence under "Nova venda" goes with the connection and moves the row by a few pixels: the order does not
    expect(after.today?.x).toBe(before.today?.x);
    expect(after.month?.x).toBe(before.month?.x);
    expect(after.month?.y).toBe(after.today?.y);
  });

  test("o servidor recusa os números (FORBIDDEN): a cópia da loja é apagada e não volta sem rede", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);
    await page.context().setOffline(true);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION);
    await expect(page.getByText("R$ 320,10")).toHaveCount(0);
  });

  test("Sair apaga a cópia do Início antes de sair (A, B e a série do mapa do aparelho)", async ({
    page,
  }) => {
    // "Sair" in the menu of the store, in the header
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.getByRole("button", { name: STORE_MENU_NAME }).click();
    await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
    await expect.poll(() => server.signOutCalls).toBe(1);
    // the page leaves while this is asked: a question cut by the navigation is asked again
    await expect
      .poll(() => copyKeys(page).catch(() => ["navegando"]))
      .toEqual([]);
  });

  test("Sair com a leitura do mapa em voo: a resposta que chega depois não grava a série de novo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    let answerSeries: () => void = () => undefined;
    server.held.set(
      "report/dailySales",
      new Promise((resolve) => {
        answerSeries = resolve;
      })
    );
    // what the page does to the device's storage and when the series reaches it, told from inside the page: while the
    // page that "Sair" opens waits, the Início cannot be asked anything, but it still runs
    const seen: string[] = [];
    await page.exposeFunction("seenByTest", (what: string) => {
      seen.push(what);
    });
    await page.addInitScript(() => {
      const tell = (what: string) =>
        (
          window as unknown as { seenByTest: (what: string) => void }
        ).seenByTest(what);
      const { setItem } = Storage.prototype;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("polaris.offline.dailySales.")) {
          tell("kept");
        }
        setItem.call(this, key, value);
      };
      const read = window.fetch;
      window.fetch = async (...args) => {
        const answer = await read(...args);
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (url.includes("/rpc/report/dailySales")) {
          tell("answered");
        }
        return answer;
      };
    });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await expect
      .poll(() =>
        server.calls.some((call) => call.procedure === "report/dailySales")
      )
      .toBe(true);
    // the page that "Sair" opens waits: the Início stays alive, already leaving, while the series comes
    let leave: () => void = () => undefined;
    const left = new Promise<void>((resolve) => {
      leave = resolve;
    });
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) {
        await left;
      }
      await route.fallback();
    });
    await page.getByRole("button", { name: STORE_MENU_NAME }).click();
    await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
    await expect.poll(() => server.signOutCalls).toBe(1);

    answerSeries();
    await expect.poll(() => seen).toContain("answered");
    // the answer is read in the same turn; a real second more, and the copy was still not kept
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(seen).toEqual(["answered"]);
    leave();
    await expect
      .poll(() => copyKeys(page).catch(() => ["navegando"]))
      .toEqual([]);
  });
});

test.describe("Ritmo de vendas (revisão de UI v7, § 3 item 10)", () => {
  // Friday `23/10`: the 26 weeks go from Sunday `26/04` to Saturday `24/10`; the days that sold are those of SOLD
  // the sentence under the map is fixed and says what only the rhythm knows; the value of a day is in the tooltip over
  // its square, opened by the pointer, the finger or the keyboard; the best day (Sunday `18/10`) is in the summary of
  // the map and in the tooltip of its day
  const READING = "Sexta, 23/10 · R$ 320,10 · 2 vendas · hoje";
  const AT_REST =
    "Poucas semanas de vendas ainda: o mapa enche conforme você vende. 6 dias com venda nas últimas 13 semanas.";
  const rhythm = (page: Page) => region(page, "Ritmo de vendas");
  const tooltip = (page: Page) =>
    rhythm(page).locator("[data-heatmap-tooltip]");
  const expectTooltip = async (page: Page, ...parts: string[]) => {
    await Promise.all(
      parts.map((part) => expect(tooltip(page)).toContainText(part))
    );
  };
  const expectTooltipRow = (page: Page, label: string, value: string) =>
    expect(
      tooltip(page)
        .locator("dl > div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator("dd")
    ).toHaveText(value);
  const atRest = (page: Page) => rhythm(page).locator("[data-rhythm-insight]");
  const dataCells = (page: Page) =>
    rhythm(page).locator(
      '[data-heatmap] rect.visx-heatmap-rect:not([pointer-events="none"])'
    );

  test("a 1280 px: 26 semanas ao lado de Mais vendidos, hoje lido e o melhor dia em linha própria, os vazios com contorno e a camada acessível nossa", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const map = rhythm(page);
    // the line says only the weeks; how to read a square is in the (i) of the block
    await expect(map).toContainText("Últimas 26 semanas");
    await expect(map).not.toContainText("um quadrado por dia");
    await map.getByRole("button", { name: "Sobre Ritmo de vendas" }).click();
    // the ranges of the four levels are in the (i), not written under the map
    await expect(
      page.getByText(
        "Cada quadrado é um dia: quanto mais escuro, mais venda. Vazio: sem venda · até R$ 80,00 · até R$ 320,10 · até R$ 420,50 · acima"
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(atRest(page)).toHaveText(AT_REST);
    await expect(tooltip(page)).toHaveCount(0);
    // one read of the series: from the first Sunday of the 26 weeks to the eve of the month (the month is A's)
    expect(
      server.calls
        .filter((call) => call.procedure === "report/dailySales")
        .map((call) => [call.input.from, call.input.to])
    ).toEqual([["2026-04-26", "2026-09-30"]]);
    // the drawing of Bklit UI is hidden; the summary is ours
    await expect(map.locator("[data-heatmap] svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(map.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas por dia nas últimas 26 semanas: 6 dias com venda. Melhor dia 18/10, R$ 1.840,00. Meses anteriores atualizados até ontem. A tabela dia a dia está no fim deste bloco."
    );
    // a cell per day of the 26 weeks; 175 known days with no sale are outlined (181 days read, 6 sold); Saturday
    // `24/10`, to come, has no outline and no fill
    await expect(dataCells(page)).toHaveCount(182);
    await expect(map.locator("[data-heatmap-empty]")).toHaveCount(175);
    await expect(map).not.toContainText("Vazio: sem venda");
    await expect(map.locator("[data-rhythm-legend]")).toHaveText("MenosMais");
    // 3 weeks with a sale: the map says it is filling up, in the sentence under it; there is no chart of the mean by weekday
    await expect(map).not.toContainText("Média por dia da semana");
    await expect(map.locator("[data-weekday-bars]")).toHaveCount(0);
    // the cells are 12 px with a gap of 3
    const first = await dataCells(page).first().boundingBox();
    expect(first?.width).toBeCloseTo(12, 0);
    // the card keeps to the budget of the 1280 px layout
    expect((await map.boundingBox())?.height ?? 999).toBeLessThanOrEqual(260);
    // beside Mais vendidos, under the chart, in the left 2/3
    const mapBox = await map.boundingBox();
    const topBox = await region(page, "Mais vendidos do mês").boundingBox();
    const chartBox = await region(page, "Vendas por dia").boundingBox();
    expect(Math.abs((mapBox?.y ?? 0) - (topBox?.y ?? 900))).toBeLessThan(2);
    expect((mapBox?.x ?? 900) + (mapBox?.width ?? 0)).toBeLessThan(
      topBox?.x ?? 0
    );
    expect(mapBox?.y ?? 0).toBeGreaterThan(
      (chartBox?.y ?? 900) + (chartBox?.height ?? 0)
    );
    // the drawing fits its card: no cell beyond the right edge
    const svgBox = await map.locator("[data-heatmap] svg").boundingBox();
    expect((svgBox?.x ?? 0) + (svgBox?.width ?? 0)).toBeLessThanOrEqual(
      (mapBox?.x ?? 0) + (mapBox?.width ?? 0)
    );
    // no button: the days read, newest first, are a table for assistive technology, tied to the map
    await expect(
      map.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expectInvisibleTable(map);
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
    await expect(map.getByRole("row").nth(2)).toContainText(
      "22/10/2026R$ 0,00sem venda"
    );
  });

  test("o mouse abre o tooltip do dia sob ele e, ao sair, ele fecha; a frase de baixo não muda", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await expect(atRest(page)).toHaveText(AT_REST);
    // the column of the week of `18/10` is the last, the 26th (index 25); Sunday is its 1st row
    await dataCells(page)
      .nth(25 * 7)
      .hover();
    await expectTooltip(
      page,
      "Domingo, 18/10",
      "Vendido",
      "R$ 1.840,00",
      "Vendas",
      "6",
      "melhor dia"
    );
    await expect(atRest(page)).toHaveText(AT_REST);
    await dataCells(page)
      .nth(25 * 7 + 1)
      .hover();
    await expectTooltip(page, "Segunda, 19/10", "R$ 0,00");
    await expect(tooltip(page)).not.toContainText("melhor dia");
    await page.mouse.move(5, 5);
    await expect(tooltip(page)).toHaveCount(0);
    await expect(atRest(page)).toHaveText(AT_REST);
  });

  test("pelo teclado: o foco abre o tooltip em hoje, cima e baixo andam um dia, esquerda e direita uma semana, o aria-valuetext diz a leitura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const slider = rhythm(page).getByRole("slider", {
      name: "Dia do mapa de vendas",
    });
    await expect(slider).toHaveAttribute("aria-valuetext", READING);
    await expect(slider).toHaveValue("180");
    await expect(tooltip(page)).toHaveCount(0);
    await slider.focus();
    await expectTooltip(page, "Sexta, 23/10", "R$ 320,10", "hoje");
    await expectTooltipRow(page, "Vendas", "2");
    // the keyboard starts on today: down is Saturday `24/10`, to come, so it stays; up is the day before
    await page.keyboard.press("ArrowDown");
    await expectTooltip(page, "Sexta, 23/10", "R$ 320,10");
    await page.keyboard.press("ArrowUp");
    await expectTooltip(page, "Quinta, 22/10", "R$ 0,00");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Quinta, 22/10 · sem venda"
    );
    await page.keyboard.press("ArrowLeft");
    await expectTooltip(page, "Quinta, 15/10");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expectTooltip(page, "Terça, 13/10");
    await page.keyboard.press("ArrowRight");
    await expectTooltip(page, "Terça, 20/10", "R$ 420,50", "3");
    // a week ahead stops at today: the days to come are not read
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuetext", READING);
    await page.keyboard.press("Home");
    await expectTooltip(page, "Domingo, 26/04");
    // leaving the map, the tooltip closes
    await page.keyboard.press("Tab");
    await expect(tooltip(page)).toHaveCount(0);
    await expect(atRest(page)).toHaveText(AT_REST);
    // Escape puts the tooltip away without leaving the control
    await slider.focus();
    await expectTooltip(page, "Sexta, 23/10");
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toHaveCount(0);
  });

  test("a 360 px: tantas semanas quanto cabem (de 13 a 20), células de 12 px, nada passa da largura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    const map = rhythm(page);
    await expect(dataCells(page).first()).toBeVisible();
    const weeks = (await dataCells(page).count()) / 7;
    await expect(map).toContainText(`Últimas ${weeks} semanas`);
    expect(weeks).toBeGreaterThanOrEqual(13);
    expect(weeks).toBeLessThanOrEqual(20);
    await expect(atRest(page)).toHaveText(AT_REST);
    const mapBox = await map.boundingBox();
    // the whole block keeps to a part of a screen, with the numbers closed
    expect(mapBox?.height ?? 999).toBeLessThanOrEqual(270);
    const svgBox = await map.locator("[data-heatmap] svg").boundingBox();
    expect((svgBox?.x ?? 0) + (svgBox?.width ?? 0)).toBeLessThanOrEqual(
      (mapBox?.x ?? 0) + (mapBox?.width ?? 0)
    );
    const cell = await dataCells(page).first().boundingBox();
    expect(cell?.width ?? 0).toBeCloseTo(12, 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("Esconder valores: o tooltip do dia, as faixas do (i) e o título da legenda escondem os reais e deixam as contagens", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await page.getByRole("button", { name: "Esconder valores" }).click();
    const map = rhythm(page);
    await dataCells(page)
      .nth(25 * 7)
      .hover();
    await expectTooltip(page, "Domingo, 18/10", "R$ ••••", "6", "melhor dia");
    await expect(tooltip(page)).not.toContainText(AN_AMOUNT);
    await expect(map).not.toContainText(AN_AMOUNT);
    await expect(map.locator("[data-rhythm-legend]")).toHaveAttribute(
      "title",
      "Vazio: sem venda · até R$ •••• · até R$ •••• · até R$ •••• · acima"
    );
    await expect(map.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas por dia nas últimas 26 semanas: 6 dias com venda. Melhor dia 18/10, valor escondido. Meses anteriores atualizados até ontem. A tabela dia a dia está no fim deste bloco."
    );
    await page.mouse.move(5, 5);
    await expect(
      map.getByRole("slider", { name: "Dia do mapa de vendas" })
    ).toHaveAttribute(
      "aria-valuetext",
      "Sexta, 23/10 · valor escondido · 2 vendas · hoje"
    );
    await map.getByRole("button", { name: "Sobre Ritmo de vendas" }).click();
    await expect(
      page.getByText(
        "Vazio: sem venda · até R$ •••• · até R$ •••• · até R$ •••• · acima",
        { exact: false }
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(map).not.toContainText(AN_AMOUNT);
    await expect(map.getByRole("row").nth(1)).toContainText("2 vendas");
    // the invisible table is read by a screen reader and found by a search: no digit of an amount in any of its texts
    const table = map.getByRole("table");
    expect(await table.evaluate((node) => node.textContent)).not.toMatch(
      AN_AMOUNT
    );
    expect(
      await table.evaluate((node) => (node as HTMLElement).innerText)
    ).not.toMatch(AN_AMOUNT);
    await expect(table.getByText("R$ ••••").first()).toBeAttached();
    expect(
      await map.evaluate((node) =>
        [...node.querySelectorAll("[aria-label],[aria-valuetext]")].map(
          (element) =>
            `${element.getAttribute("aria-label")} ${element.getAttribute("aria-valuetext")}`
        )
      )
    ).not.toContainEqual(expect.stringMatching(AN_AMOUNT));
  });

  test("o gráfico não abriu: a tabela aparece à vista com o erro e Tentar novamente, e o resto do bloco fica", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.route(HEATMAP_CHUNK, (route) => route.abort());
    await openHome(page, new FakeServer(SOLD));
    const map = rhythm(page);
    await expect(map.getByText("O gráfico não abriu.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      map.getByRole("button", { name: "Tentar novamente" })
    ).toBeVisible();
    await expect(atRest(page)).toHaveText(AT_REST);
    // the numbers are on the screen, not an option: the table, newest day first, with the values
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "visible"
    );
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
    await expect(
      map.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.getByRole("table")).not.toContainText(AN_AMOUNT);
  });

  for (const size of [
    { height: 740, width: 360 },
    { height: 900, width: 900 },
    { height: 800, width: 1280 },
  ]) {
    test(`lugar reservado: a caixa do carregando tem a altura do bloco pronto e ler um dia não a muda (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      let release: () => void = () => undefined;
      const server = new FakeServer(SOLD);
      server.held.set(
        "report/dailySales",
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      await openHome(page, server);
      const loading = page
        .getByRole("status")
        .filter({ hasText: "Carregando o ritmo de vendas…" });
      await expect(loading).toBeVisible();
      await settled(page);
      const reserved = (await placeOf(loading)).height;

      release();
      await expect(atRest(page)).toHaveText(AT_REST);
      await settled(page);
      const ready = await placeOf(rhythm(page));
      expect(Math.abs(ready.height - reserved)).toBeLessThanOrEqual(1);

      // the tooltip of a day read is over the map, and moves nothing
      const total = await dataCells(page).count();
      await dataCells(page)
        .nth(total - 7)
        .hover();
      await expect(tooltip(page)).toBeVisible();
      await settled(page);
      expect(
        Math.abs((await placeOf(rhythm(page))).height - ready.height)
      ).toBeLessThanOrEqual(1);
    });
  }

  for (const size of [
    { height: 740, width: 360 },
    { height: 568, width: 320 },
  ]) {
    test(`o tooltip de um dia fica inteiro dentro da tela em toda coluna do mapa (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(SOLD));
      await expect(atRest(page)).toHaveText(AT_REST);
      await settled(page);
      const columns = Math.floor((await dataCells(page).count()) / 7);
      expect(columns).toBeGreaterThanOrEqual(16);
      const panelBox = () =>
        tooltip(page).evaluate((content) => {
          const panel = content.closest(".pointer-events-none.absolute");
          const box = panel?.getBoundingClientRect();
          const map = content
            .closest("[data-heatmap]")
            ?.getBoundingClientRect();
          return box && map
            ? {
                left: box.left,
                mapLeft: map.left,
                mapRight: map.right,
                right: box.right,
                width: window.innerWidth,
              }
            : null;
        });
      for (let column = 0; column < columns; column += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one pointer, one column after the other
        await dataCells(page)
          .nth(column * 7 + 3)
          .hover();
        await expect(tooltip(page)).toBeVisible();
        await settled(page);
        const box = await panelBox();
        expect(box, `coluna ${column}`).not.toBeNull();
        expect(box?.left, `coluna ${column}`).toBeGreaterThanOrEqual(
          Math.max(0, (box?.mapLeft ?? 0) - 0.5)
        );
        expect(box?.right, `coluna ${column}`).toBeLessThanOrEqual(
          Math.min(box?.width ?? 0, (box?.mapRight ?? 0) + 0.5)
        );
      }
    });
  }

  test("cache diário (CPU-1e): duas aberturas no mesmo dia leem a série uma vez; no dia seguinte, de novo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    const dailyCalls = () =>
      server.calls
        .filter((call) => call.procedure === "report/dailySales")
        .map((call) => [call.input.from, call.input.to]);
    await openHome(page, server);
    await expect(atRest(page)).toHaveText(AT_REST);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("polaris.offline.dailySales.")
          )
        )
      )
      .toBe(true);
    const summaries = periodCalls(server).length;

    // the second opening of the day: the figures are read again, the series comes from the copy of today
    await page.reload();
    await expect(atRest(page)).toHaveText(AT_REST, { timeout: 20_000 });
    await expect
      .poll(() => periodCalls(server).length)
      .toBeGreaterThan(summaries);
    expect(dailyCalls()).toEqual([["2026-04-26", "2026-09-30"]]);

    // the next day of the store: the copy is of yesterday, the series is read again (the next 26 weeks)
    server.now = NOON + 86_400_000;
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(rhythm(page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(dailyCalls).toEqual([
      ["2026-04-26", "2026-09-30"],
      ["2026-04-26", "2026-09-30"],
    ]);
  });

  test("cache diário: a loja recusa os números e a série do dia não é servida de novo sem o servidor", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    const dailyCalls = () =>
      server.calls.filter((call) => call.procedure === "report/dailySales")
        .length;
    await openHome(page, server);
    await expect(atRest(page)).toHaveText(AT_REST);
    expect(dailyCalls()).toBe(1);

    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);

    // the access is back: the series of the day is asked of the server, not taken from the page or the device
    server.broken.delete("report/periodSummary");
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(dailyCalls).toBe(2);
    await expect(atRest(page)).toHaveText(AT_REST);
  });

  test("a série quebrada: o bloco diz o seu erro e Tentar novamente lê só a série; o resto fica", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    server.broken.set("report/dailySales", "500");
    await openHome(page, server);
    await expect(
      page.getByText("Não foi possível carregar o ritmo de vendas.")
    ).toBeVisible({ timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas por dia")).toBeVisible();
    // never a map of zeros in the place of the unknown
    await expect(rhythm(page)).toHaveCount(0);
    const summaries = periodCalls(server).length;
    server.broken.delete("report/dailySales");
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(atRest(page)).toHaveText(AT_REST);
    expect(periodCalls(server).length).toBe(summaries);
  });

  test("sem conexão e sem o pedaço do mapa: a tabela da cópia aparece à vista, com o aviso de internet", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.route(HEATMAP_CHUNK, (route) => route.abort());
    await reopenWithoutNetwork(page, server);
    const map = rhythm(page);
    await expect(map).toContainText(
      "O gráfico abre quando a internet voltar. Os números estão abaixo.",
      { timeout: 20_000 }
    );
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
  });

  test("sem conexão: com a cópia da série, o mapa da cópia; sem ela, 'O mapa abre com internet.'", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.context().setOffline(true);
    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible();
    await expect(atRest(page)).toHaveText(AT_REST);
    await page.context().setOffline(false);

    await reopenWithoutNetwork(page, server);
    await expect(atRest(page)).toHaveText(AT_REST, { timeout: 20_000 });

    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("polaris.offline.dailySales.")) {
          localStorage.removeItem(key);
        }
      }
    });
    await reopenWithoutNetwork(page, server);
    await expect(rhythm(page)).toContainText("O mapa abre com internet.", {
      timeout: 20_000,
    });
    await expect(rhythm(page).locator("[data-heatmap]")).toHaveCount(0);
    // the rest of the copy stands
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });
});

/** Remembers, in the page, whether the error of the figures ever showed up (even for a frame). */
async function watchFiguresError(page: Page) {
  await page.addInitScript(() => {
    const seen = () =>
      document.body?.textContent?.includes(
        "Não foi possível carregar os números da loja."
      ) === true;
    const observer = new MutationObserver(() => {
      if (seen()) {
        (window as unknown as { figuresErrorSeen: boolean }).figuresErrorSeen =
          true;
      }
    });
    document.addEventListener("DOMContentLoaded", () =>
      observer.observe(document.body, { childList: true, subtree: true })
    );
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { figuresErrorSeen?: boolean })
          .figuresErrorSeen === true
    );
}

const SLOW_READ = "Demorando mais que o normal…";
const STALE_COPY = "Não foi possível atualizar agora";
const RPC_PATH = /\/rpc\/(.+)$/;

test.describe("paliativo dos 1102: leituras tentadas de novo, em fila e com freio", () => {
  test("(a) as duas primeiras respostas do periodSummary morrem por CPU: o Início abre sem 'Tentar novamente', em menos de 8 s, com o esqueleto no meio", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.diesNext.set("report/periodSummary", 2);
    const errorSeen = await watchFiguresError(page);
    const firstRead = page
      .waitForRequest((request) =>
        request.url().includes("/rpc/report/periodSummary")
      )
      .then(() => Date.now());
    await openHome(page, server);
    await expect(
      page.getByRole("status").filter({ hasText: "Carregando os números…" })
    ).toBeAttached();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 8000,
    });
    expect(Date.now() - (await firstRead)).toBeLessThan(8000);
    expect(await errorSeen()).toBe(false);
    await expect(
      page.getByRole("button", { name: "Tentar novamente" })
    ).toHaveCount(0);
    // the two that died and the two that answered: nothing more
    expect(periodCalls(server)).toHaveLength(4);
  });

  test("passados ~3 s, o esqueleto diz 'Demorando mais que o normal…', sem botão, e os números chegam sem erro", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    // the month and the days before die twice each: the third try of each answers, ~5.5 s after the first
    server.diesNext.set("report/periodSummary", 4);
    const errorSeen = await watchFiguresError(page);
    await openHome(page, server);
    const slow = page.getByRole("status").filter({ hasText: SLOW_READ });
    await expect(slow).toBeVisible({ timeout: 8000 });
    await expect(slow.getByRole("button")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 10_000,
    });
    await expect(slow).toHaveCount(0);
    expect(await errorSeen()).toBe(false);
    expect(periodCalls(server)).toHaveLength(6);
  });

  test("(b) três mortes seguidas, sem cópia: o erro de hoje com 'Tentar novamente', depois de três tentativas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "1102");
    await openHome(page, server);
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Não foi possível carregar os números da loja." });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    // two reads (the month and the days before), three tries each: the error shows with the first to give up
    await expect.poll(() => periodCalls(server).length).toBe(6);
    server.broken.delete("report/periodSummary");
    await alert.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });

  test("(b) três mortes seguidas, com cópia: a cópia fica, com 'Mostrando os números de' e o aviso com 'Tentar novamente'", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "1102");
    await page.reload();
    const notice = page.getByRole("status").filter({ hasText: STALE_COPY });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText(
      "Mostrando os números de 12:00. Vendas feitas depois não estão aqui."
    );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    server.broken.delete("report/periodSummary");
    await notice.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(notice).toHaveCount(0);
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();
  });

  test("(c) na abertura, nunca mais de 4 leituras /rpc em voo, e o get-session antes das leituras da tela", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.latencyMs = 400;
    const flying = { all: 0, maxAll: 0, maxReads: 0, reads: 0 };
    const order: string[] = [];
    const procedureOf = (url: string) => RPC_PATH.exec(new URL(url).pathname);
    const isRead = (url: string) => {
      const match = procedureOf(url);
      return match !== null && READ_PROCEDURES.has(match[1] ?? "");
    };
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/auth/get-session")) {
        order.push("get-session:start");
      }
      if (procedureOf(url) === null) {
        return;
      }
      order.push(`rpc:${procedureOf(url)?.[1]}`);
      flying.all += 1;
      flying.maxAll = Math.max(flying.maxAll, flying.all);
      if (isRead(url)) {
        flying.reads += 1;
        flying.maxReads = Math.max(flying.maxReads, flying.reads);
      }
    });
    const done = (request: { url: () => string }) => {
      const url = request.url();
      if (url.includes("/api/auth/get-session")) {
        order.push("get-session:end");
      }
      if (procedureOf(url) === null) {
        return;
      }
      flying.all -= 1;
      if (isRead(url)) {
        flying.reads -= 1;
      }
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 15_000,
    });
    await expect(region(page, "Meta")).toBeVisible();
    await expect(region(page, "Precisa de ação")).toBeVisible();

    expect(flying.maxReads).toBeLessThanOrEqual(4);
    // the screen's reads leave after the first session lookup ended
    const firstEnd = order.indexOf("get-session:end");
    expect(firstEnd).toBeGreaterThan(-1);
    expect(order.indexOf("rpc:report/periodSummary")).toBeGreaterThan(firstEnd);
    test.info().annotations.push({
      description: `leituras em voo no máximo: ${flying.maxReads}; todas as /rpc (escritas incluídas): ${flying.maxAll}`,
      type: "rpc-em-voo",
    });
  });
});

const SALE_OUTSIDE_THE_MONTH: Scenario = {
  ...SOLD,
  days: { "2026-09-25": [12_000, 2] },
};
const NO_SALE_AT_ALL: Scenario = { ...SOLD, days: {} };
const SOBRE = /^Sobre /;
const NO_COST_HELP =
  /não é lucro líquido nem caixa\. Sem custo informado: não dá para estimar\./;
const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;
const CHARTS_CHUNK = "**/assets/charts-*.js";
const HEATMAP_CHUNK = "**/assets/heatmap-*.js";

/** The table of the days of a chart: in the page for a screen reader, one pixel tall on the screen and out of the tab order. */
async function expectInvisibleTable(block: Locator, columns = 3) {
  const table = block.getByRole("table");
  await expect(table).toHaveCount(1);
  await expect(table.locator("caption")).not.toHaveText("");
  await expect(table.locator("th[scope=col]")).toHaveCount(columns);
  await expect(block.locator("[data-chart-data-table]")).toHaveAttribute(
    "data-chart-data-table",
    "hidden"
  );
  const box = await block.locator("[data-chart-data-table]").boundingBox();
  expect(box?.height ?? 99).toBeLessThanOrEqual(1);
  await expect(table.locator("a, button, input, [tabindex]")).toHaveCount(0);
  const id = await table.getAttribute("id");
  await expect(block.locator(`[role="img"][aria-details="${id}"]`)).toHaveCount(
    1
  );
}

/** Where a box is on the page, whatever the scroll: the height and the top in document coordinates. */
interface Place {
  height: number;
  top: number;
}

const placeOf = (locator: Locator): Promise<Place> =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { height: box.height, top: box.top + window.scrollY };
  });

/** Two frames with nothing moving between them: the layout the page settled on. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

/** The block "Vendas por dia" and what sits under it, as the page lays them out now. */
async function chartPlaces(page: Page) {
  await settled(page);
  const chart = region(page, "Vendas por dia");
  return {
    card: await placeOf(chart),
    next: await placeOf(region(page, "Ritmo de vendas")),
    total: await placeOf(chart.locator("p.grid > span").first()),
  };
}

type ChartPlaces = Awaited<ReturnType<typeof chartPlaces>>;

/**
 * The block of the chart within a pixel of the one before: its height, and where the total and the block below sit from
 * its top. The block's own top is not compared: the cards above it have another shape when the month sold nothing.
 */
function expectSamePlaces(after: ChartPlaces, before: ChartPlaces) {
  const from = (places: ChartPlaces) => ({
    card: places.card.height,
    next: places.next.top - places.card.top,
    nextHeight: places.next.height,
    total: places.total.top - places.card.top,
    totalHeight: places.total.height,
  });
  const [now, then] = [from(after), from(before)];
  for (const key of Object.keys(now) as (keyof typeof now)[]) {
    expect(Math.abs(now[key] - then[key]), key).toBeLessThanOrEqual(1);
  }
}

const MONTHS = {
  last: { range: "01/09 a 30/09", shortcut: "Mês passado" },
  this: { range: "01/10 a 31/10", shortcut: "Este mês" },
} as const;

/** One of the two months through the picker of the Início, once the block has the period asked. */
async function chooseMonth(page: Page, month: keyof typeof MONTHS) {
  await choosePeriod(page, MONTHS[month].shortcut);
  await expect(periodButton(page)).toContainText(MONTHS[month].range);
}

/** The block of one period has either the drawing or the sentence; waits for the one the scenario gives it. */
async function expectPeriodShown(page: Page, empty: boolean) {
  const chart = region(page, "Vendas por dia");
  if (empty) {
    await expect(chart).toContainText("Sem vendas no período.");
  } else {
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart).not.toContainText("Sem vendas no período.");
  }
}

test.describe("Vendas por dia: trocar de período não muda a altura do bloco nem o que vem depois", () => {
  const cases = [
    {
      name: "dados e dados (este mês e o passado com venda)",
      scenario: SOLD,
      empty: { last: false, this: false },
    },
    {
      name: "vazio e dados (este mês sem venda, o passado com)",
      scenario: SALE_OUTSIDE_THE_MONTH,
      empty: { last: false, this: true },
    },
    {
      name: "vazio e vazio (a loja que não vendeu nos dois meses)",
      scenario: NO_SALE_AT_ALL,
      empty: { last: true, this: true },
    },
  ] as const;

  for (const size of SIZES) {
    for (const { empty, name, scenario } of cases) {
      test(`${name} (${size.width} px)`, async ({ page }) => {
        await page.setViewportSize(size);
        await openHome(page, new FakeServer(scenario));
        await expectPeriodShown(page, empty.this);
        const thisMonth = await chartPlaces(page);

        await chooseMonth(page, "last");
        await expectPeriodShown(page, empty.last);
        expectSamePlaces(await chartPlaces(page), thisMonth);

        await chooseMonth(page, "this");
        await expectPeriodShown(page, empty.this);
        expectSamePlaces(await chartPlaces(page), thisMonth);
      });
    }

    test(`carregando e pronto: a caixa que guarda o lugar do gráfico tem a altura do gráfico (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(CHARTS_CHUNK, async (route) => {
        await held;
        await route.continue();
      });
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      await expect(chart.locator("[data-chart-loading]")).toBeVisible();
      const loading = await chartPlaces(page);

      release();
      await expect(
        chart.locator("[data-chart-area] svg").first()
      ).toBeVisible();
      expectSamePlaces(await chartPlaces(page), loading);
    });
  }

  test("o período sem venda mostra o chão do zero e a frase no meio da área do gráfico, não no lugar dela", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SALE_OUTSIDE_THE_MONTH));
    await expectPeriodShown(page, true);
    const chart = region(page, "Vendas por dia");
    // the chart of the chunk (the box that held its place has no `data-chart`)
    const drawn = chart.locator("[data-chart][data-chart-empty]");
    await expect(drawn).toBeVisible();
    const floor = drawn.locator("[data-chart-floor]");
    const plot = floor.locator("xpath=..");
    const sentence = plot.getByText("Sem vendas no período.");
    const [plotBox, floorBox, sentenceBox] = await Promise.all([
      plot.boundingBox(),
      floor.boundingBox(),
      sentence.boundingBox(),
    ]);
    if (!(plotBox && floorBox && sentenceBox)) {
      throw new Error("faltou uma caixa do estado vazio");
    }
    expect(plotBox.height).toBe(240);
    // the floor is the zero, 32 px over the bottom of the plot where the dates of the axis go
    expect(floorBox.y + floorBox.height).toBeCloseTo(
      plotBox.y + plotBox.height - 32,
      0
    );
    expect(sentenceBox.y + sentenceBox.height).toBeLessThanOrEqual(
      floorBox.y + floorBox.height
    );
    expect(sentenceBox.y).toBeGreaterThanOrEqual(plotBox.y);
    expect(
      Math.abs(
        sentenceBox.x + sentenceBox.width / 2 - (plotBox.x + plotBox.width / 2)
      )
    ).toBeLessThanOrEqual(1);
  });
});

const HIDE_VALUES = { name: "Esconder valores" } as const;

test.describe("Vendas por dia: só o gráfico, com os números numa tabela invisível (L2-6)", () => {
  test("a tabela invisível está ligada ao gráfico e troca com o período; o botão não existe", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0]);
    await openHome(page, new FakeServer(SOLD));
    await expectPeriodShown(page, false);
    const chart = region(page, "Vendas por dia");
    await expect(
      chart.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expect(chart).not.toContainText("Os números estão abaixo");
    await expectInvisibleTable(chart, 2);
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("row").nth(1)).toContainText(
      "01/10/2026R$ 0,00"
    );
    await expect(chart.getByRole("row").nth(2)).toContainText(
      "02/10/2026R$ 80,00"
    );
    await expect(chart.getByRole("row").nth(18)).toContainText(
      "18/10/2026R$ 1.840,00"
    );
    await expect(chart.getByRole("row").nth(23)).toContainText(
      "23/10/2026R$ 320,10"
    );
    await expect(chart.getByRole("slider")).toHaveAttribute("max", "22");

    await chooseMonth(page, "last");
    await expectPeriodShown(page, false);
    await expectInvisibleTable(chart, 2);
    await expect(chart.getByRole("row")).toHaveCount(31);
    await expect(chart.getByRole("row").nth(1)).toContainText("01/09/2026");
    await expect(chart.getByRole("row").nth(20)).toContainText(
      "20/09/2026R$ 50,00"
    );
    await expect(chart.getByRole("slider")).toHaveAttribute("max", "29");
    // the keyboard control and the summary of the image stay
    await expect(chart.getByRole("slider")).toBeVisible();
    await expect(chart.locator('[role="img"][aria-label]')).toHaveCount(1);
    await chart.getByRole("slider").focus();
    await page.keyboard.press("Tab");
    await expect(chart.getByRole("table").locator(":focus")).toHaveCount(0);
  });

  for (const size of SIZES) {
    test(`com Esconder valores a tabela invisível também mascara, e a altura do cartão não muda entre os dois meses (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(SOLD));
      await expectPeriodShown(page, false);
      const chart = region(page, "Vendas por dia");
      const visible = await chartPlaces(page);

      await page.getByRole("button", HIDE_VALUES).click();
      await expect(chart).not.toContainText(AN_AMOUNT);
      for (const month of ["last", "this"] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one period after the other
        await chooseMonth(page, month);
        await expectPeriodShown(page, false);
        const table = chart.getByRole("table");
        expect(await table.evaluate((node) => node.textContent)).not.toMatch(
          AN_AMOUNT
        );
        expect(
          await table.evaluate((node) => (node as HTMLElement).innerText)
        ).not.toMatch(AN_AMOUNT);
        await expect(table.getByText("R$ ••••").first()).toBeAttached();
        expect(
          await chart.evaluate((node) =>
            [...node.querySelectorAll("[aria-label],[aria-valuetext]")].map(
              (element) =>
                `${element.getAttribute("aria-label")} ${element.getAttribute("aria-valuetext")}`
            )
          )
        ).not.toContainEqual(expect.stringMatching(AN_AMOUNT));
        expectSamePlaces(await chartPlaces(page), visible);
      }
    });
  }

  for (const size of SIZES) {
    test(`o gráfico não abriu: a tabela aparece à vista, com o erro e Tentar novamente (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      await expect(chart.getByText("O gráfico não abriu.")).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        chart.getByRole("button", { name: "Tentar novamente" })
      ).toBeVisible();
      await expect(chart.getByRole("table")).toBeVisible();
      await expect(chart.locator("[data-chart-data-table]")).toHaveAttribute(
        "data-chart-data-table",
        "visible"
      );
      await expect(chart.getByRole("row")).toHaveCount(24);
      await expect(chart.getByRole("row").nth(18)).toContainText(
        "18/10/2026R$ 1.840,00"
      );
      await expect(
        chart.getByRole("button", { name: "Ver os números" })
      ).toHaveCount(0);
      await chooseMonth(page, "last");
      await expect(chart.getByRole("row")).toHaveCount(31);
      await page.getByRole("button", HIDE_VALUES).click();
      await expect(chart.getByRole("table")).not.toContainText(AN_AMOUNT);
    });
  }

  test("o gráfico não abriu e o período não tem venda: a frase de sem vendas, e a tabela de zeros continua invisível", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await page.route(CHARTS_CHUNK, (route) => route.abort());
    await openHome(page, new FakeServer(SALE_OUTSIDE_THE_MONTH));
    const chart = region(page, "Vendas por dia");
    await expect(chart).toContainText("Sem vendas no período.", {
      timeout: 20_000,
    });
    await expect(chart.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "hidden"
    );
    await expect(chart).not.toContainText("O gráfico não abriu.");
  });
});

/** What each KPI card lays out, in document coordinates: the card, its support text and its sparkline. */
async function kpiPlaces(page: Page) {
  await settled(page);
  return page.locator("[data-kpi-row] [data-kpi]").evaluateAll((cards) =>
    cards.map((card) => {
      const top = (element: Element | null) =>
        element
          ? element.getBoundingClientRect().top + window.scrollY
          : Number.NaN;
      const box = card.getBoundingClientRect();
      return {
        chip: card.querySelector("[data-kpi-delta]") !== null,
        height: box.height,
        note: top(card.querySelector("[data-kpi-note-row]")),
        spark: top(card.querySelector("[data-kpi-spark]")),
        top: top(card),
      };
    })
  );
}

type KpiPlaces = Awaited<ReturnType<typeof kpiPlaces>>;

function expectSameKpiPlaces(
  after: KpiPlaces,
  before: KpiPlaces,
  when: string
) {
  expect(after.length, when).toBe(before.length);
  for (const [index, place] of after.entries()) {
    const rest = before[index];
    for (const key of ["height", "note", "spark", "top"] as const) {
      expect(
        Math.abs(place[key] - (rest?.[key] ?? Number.NaN)),
        `${when}: ${key} do cartão ${index}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

/** Reads, by the arrows, each of the 29 days before today on the sparkline of a card, and the same places as at rest at each stop. */
async function walkDays(
  page: Page,
  name: string,
  rest: KpiPlaces,
  chips: Set<boolean>
) {
  const slider = region(page, name).getByRole("slider");
  await slider.focus();
  for (let step = 1; step <= 29; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one key, then one measure
    await page.keyboard.press("ArrowLeft");
    const read = await kpiPlaces(page);
    for (const place of read) {
      chips.add(place.chip);
    }
    expectSameKpiPlaces(read, rest, `${name}, ${step} dias antes`);
  }
  await slider.blur();
  expectSameKpiPlaces(await kpiPlaces(page), rest, `${name}, solto`);
}

test.describe("cartões de KPI: escolher ou soltar um dia não move nada no cartão", () => {
  const RESULTS: Record<string, number> = {
    "2026-09-20": 1500,
    "2026-09-21": 3600,
    "2026-10-02": 2400,
    "2026-10-18": 55_200,
    "2026-10-20": 12_615,
    "2026-10-23": 9603,
  };

  for (const size of SIZES) {
    test(`o texto de apoio, a sparkline e a altura de cada cartão ficam onde estavam em todos os dias lidos, com e sem o chip (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer({ ...SOLD, results: RESULTS }));
      await expect(
        region(page, "Resultado estimado").locator("[data-kpi-spark] svg")
      ).toBeVisible();
      const rest = await kpiPlaces(page);
      const chips = new Set<boolean>(rest.map((place) => place.chip));

      for (const name of ["Vendas hoje", "Vendas em outubro"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one card at a time, the keyboard is one
        await walkDays(page, name, rest, chips);
      }
      // the walk did cross days with a chip and days without one: the proof is not of a screen that never had it
      expect([...chips].sort()).toEqual([false, true]);
    });

    test(`sem venda no mês: a linha de apoio continua nos quatro cartões, sem chip (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(NO_SALE_AT_ALL));
      await expect(region(page, "Vendas hoje")).toContainText("R$ 0,00");
      const notes = page.locator(
        "[data-kpi-row] [data-kpi] [data-kpi-note-row]"
      );
      await expect(notes).toHaveCount(4);
      const heights = await notes.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      for (const height of heights) {
        expect(height).toBeGreaterThanOrEqual(20);
      }
      await expect(
        page.locator("[data-kpi-row] [data-kpi] [data-kpi-delta]")
      ).toHaveCount(0);
    });
  }

  test("carregando e pronto: a 360 px, o esqueleto de cada cartão tem a altura do cartão e fica a mesma distância do primeiro", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0]);
    const server = new FakeServer(SOLD);
    let answer: () => void = () => undefined;
    server.held.set(
      "report/periodSummary",
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await openHome(page, server);
    const skeletons = page.locator("[data-kpi-row] [data-kpi-skeleton]");
    await expect(skeletons).toHaveCount(4);
    await settled(page);
    const loading = await skeletons.evaluateAll((cards) =>
      cards.map((card) => {
        const box = card.getBoundingClientRect();
        return { height: box.height, top: box.top + window.scrollY };
      })
    );

    answer();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const loaded = await kpiPlaces(page);
    // the result's foot has the lines its sentence takes, which the skeleton does not know: the other three are exact
    for (const index of [0, 1, 3]) {
      expect(
        Math.abs((loaded[index]?.height ?? 0) - (loading[index]?.height ?? 0)),
        `altura do cartão ${index}`
      ).toBeLessThanOrEqual(1);
    }
    // the card of the month under Hoje is as far from it as its skeleton was
    expect(
      Math.abs(
        (loaded[1]?.top ?? 0) -
          (loaded[0]?.top ?? 0) -
          ((loading[1]?.top ?? 0) - (loading[0]?.top ?? 0))
      )
    ).toBeLessThanOrEqual(1);
  });
});

/** The geometry the areas of each KPI tile keep: the tile, its sparkline and the area of its number. */
async function tileAreas(page: Page) {
  await settled(page);
  return page.locator("[data-kpi-row] [data-kpi]").evaluateAll((cards) =>
    cards.map((card) => {
      const size = (element: Element | null) => {
        const box = element?.getBoundingClientRect();
        return box ? { height: box.height, width: box.width } : null;
      };
      return {
        figure: size(card.querySelector("[data-kpi-headline]")),
        name: card.getAttribute("aria-labelledby"),
        spark: size(card.querySelector("[data-kpi-spark]")),
        tile: size(card),
      };
    })
  );
}

type TileAreas = Awaited<ReturnType<typeof tileAreas>>[number];

function expectSameAreas(tile: TileAreas, rest: TileAreas | undefined) {
  const when = `${tile.name}`;
  const same = (what: string, now?: number, before?: number) =>
    expect(now, `${when}: ${what}`).toBeCloseTo(before ?? Number.NaN, 0);
  same("altura", tile.tile?.height, rest?.tile?.height);
  same("largura", tile.tile?.width, rest?.tile?.width);
  same("área do número", tile.figure?.width, rest?.figure?.width);
  if (tile.spark && rest?.spark) {
    same("minigráfico", tile.spark.width, rest.spark.width);
    same("altura do minigráfico", tile.spark.height, rest.spark.height);
  }
}

test.describe("cartões de KPI: o valor e o minigráfico têm áreas que o número não muda", () => {
  const SHORT: Scenario = {
    ...SOLD,
    results: {
      "2026-10-18": 55_200,
      "2026-10-20": 12_615,
      "2026-10-23": 9603,
    },
  };
  const LONG: Scenario = {
    ...SOLD,
    days: {
      "2026-10-02": [8000, 1],
      "2026-10-18": [99_964_035, 6],
      "2026-10-23": [32_010, 2],
    },
    results: {
      "2026-10-02": 100,
      "2026-10-18": -9_964_035,
      "2026-10-23": 100,
    },
  };
  const INCOMPLETE: Scenario = {
    ...SHORT,
    results: { ...SHORT.results, "2026-10-20": null },
  };

  for (const size of SIZES) {
    test(`valor curto, valor longo e estimativa incompleta: o cartão, o minigráfico e a área do número ficam do mesmo tamanho, e os quatro cartões têm a mesma altura (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const reads: Awaited<ReturnType<typeof tileAreas>>[] = [];
      for (const scenario of [SHORT, LONG, INCOMPLETE]) {
        // biome-ignore lint/performance/noAwaitInLoops: one store at a time, one page
        await openHome(page, new FakeServer(scenario));
        await expect(region(page, "Resultado estimado")).toContainText(
          scenario === INCOMPLETE ? "Incompleta" : "R$"
        );
        reads.push(await tileAreas(page));
      }
      const [short, long, incomplete] = reads;
      expect(short?.length).toBe(4);
      for (const read of [short, long, incomplete]) {
        const heights = (read ?? []).map((tile) => tile.tile?.height ?? 0);
        expect(
          Math.max(...heights) - Math.min(...heights),
          "os quatro cartões têm a mesma altura"
        ).toBeLessThanOrEqual(1);
      }
      for (const read of [long, incomplete]) {
        for (const [index, tile] of (read ?? []).entries()) {
          expectSameAreas(tile, short?.[index]);
        }
      }
    });
  }

  const NO_COST: Scenario = {
    ...SOLD,
    results: {
      "2026-10-02": null,
      "2026-10-18": null,
      "2026-10-20": null,
      "2026-10-23": null,
    },
    soldWithoutCost: 12,
  };

  async function detailInsideRow(result: Locator, detail: string) {
    return await result.evaluate((card, selector) => {
      const row = card
        .querySelector("[data-kpi-note-row]")
        ?.getBoundingClientRect();
      const box = card.querySelector(selector)?.getBoundingClientRect();
      return Boolean(
        row &&
          box &&
          box.width > 0 &&
          box.left >= row.left - 0.5 &&
          box.right <= row.right + 0.5 &&
          box.top >= row.top - 0.5 &&
          box.bottom <= row.bottom + 0.5
      );
    }, detail);
  }

  test("com a lateral aberta a 1280 px, os dias sem custo ficam à vista na linha de apoio e o (i) diz a contagem", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(INCOMPLETE));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-unknown]")).toContainText(
      "de 23 dias sem custo"
    );
    expect(
      await detailInsideRow(result, "[data-kpi-warning-detail]"),
      "o detalhe está dentro da linha de apoio, não escondido"
    ).toBe(true);
    await result.getByRole("button", { name: SOBRE }).click();
    await expect(
      page.getByText("1 de 23 dias ainda sem custo informado.")
    ).toBeVisible();
  });

  test("sem custo conhecido, com a lateral aberta a 1280 px: “Sem custo informado” à vista e o (i) diz que não dá para estimar", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(NO_COST));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-no-cost]")).toContainText(
      "Sem custo informado"
    );
    expect(
      await detailInsideRow(result, "[data-kpi-warning-detail]"),
      "o detalhe está dentro da linha de apoio, não escondido"
    ).toBe(true);
    await result.getByRole("button", { name: SOBRE }).click();
    await expect(page.getByText(NO_COST_HELP)).toBeVisible();
  });

  test("a estimativa incompleta é uma linha só, com o sinal à vista, e a data de um dia lido vem antes dele (1280 px)", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(INCOMPLETE));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-incomplete]")).toHaveText(
      "Incompleta"
    );
    await expect(result.locator("[data-kpi-incomplete]")).toBeVisible();
    await expect(result.locator("[data-kpi-note-row]")).toHaveCount(1);
    await expect(result.locator("[data-kpi-warning]")).toHaveCount(1);
    const rest = await tileAreas(page);
    const slider = region(page, "Vendas em outubro").getByRole("slider");
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(result.locator("[data-kpi-date]")).toBeVisible();
    await expect(result.locator("[data-kpi-incomplete]")).toBeVisible();
    const inside = await result.evaluate((card) => {
      const row = card
        .querySelector("[data-kpi-note-row]")
        ?.getBoundingClientRect();
      const sign = card
        .querySelector("[data-kpi-incomplete]")
        ?.getBoundingClientRect();
      return Boolean(
        row &&
          sign &&
          sign.right <= row.right + 0.5 &&
          sign.bottom <= row.bottom + 0.5
      );
    });
    expect(inside, "o sinal de incompleta cabe inteiro na linha de apoio").toBe(
      true
    );
    const read = await tileAreas(page);
    for (const [index, tile] of read.entries()) {
      expect(tile.tile?.height).toBeCloseTo(rest[index]?.tile?.height ?? 0, 0);
    }
  });
});

/** Names of 30, 45 and 60 characters. */
const LONG_NAMES = [
  "Camiseta de algodão manga lisa",
  "Calça jeans masculina slim fit azul escuro 44",
  "Tênis esportivo de corrida leve com amortecedor duplo, preto",
];

function rankingOf(names: readonly string[], scale = 1) {
  const ids = [PRODUCT, DELETED, "0199c2d0-0000-7000-8000-0000000000b3"];
  return names.map((name, index) => ({
    deleted: index === 1,
    name,
    netSales: `${(900 - index * 300) * scale}.00`,
    productId: ids[index] ?? PRODUCT,
    quantity: (12 - index * 4) * scale,
  }));
}

const NOVEMBER = Date.parse("2026-11-05T15:00:00.000Z");
const SOLD_IN_NOVEMBER: Scenario = {
  ...SOLD,
  days: { ...SOLD.days, "2026-11-03": [30_000, 2] },
};

interface RankingRow {
  bottom: number;
  clipped: boolean;
  figuresTop: number;
  fitsOnOneLine: boolean;
  height: number;
  nameBottom: number;
  nameLines: number;
  nameText: string;
  top: number;
  visibleCharacters: number;
}

/** Each line of the ranking as laid out, and how many characters of the name are drawn inside its box. */
async function rankingRows(page: Page): Promise<RankingRow[]> {
  await settled(page);
  return region(page, "Mais vendidos do mês")
    .locator("ol > li")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const name = row.querySelector("[data-top-name]") as HTMLElement;
        const figures = row.querySelector("[data-top-figures]") as HTMLElement;
        const box = row.getBoundingClientRect();
        const origin = (
          row.parentElement as HTMLElement
        ).getBoundingClientRect().top;
        const nameBox = name.getBoundingClientRect();
        const nameStyle = getComputedStyle(name);
        const parsedLine = Number.parseFloat(nameStyle.lineHeight);
        const lineHeight = Number.isNaN(parsedLine)
          ? Number.parseFloat(nameStyle.fontSize) * 1.2
          : parsedLine;
        const probe = name.cloneNode(true) as HTMLElement;
        probe.style.cssText =
          "position:absolute;visibility:hidden;width:max-content;white-space:nowrap;display:block;overflow:visible;-webkit-line-clamp:none";
        name.parentElement?.appendChild(probe);
        const naturalWidth = probe.getBoundingClientRect().width;
        probe.remove();
        const text = name.firstChild as Text;
        let visible = 0;
        for (let at = 0; at < text.length; at += 1) {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          const rect = range.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.bottom <= nameBox.bottom + 1 &&
            rect.right <= nameBox.right + 1
          ) {
            visible += 1;
          }
        }
        const value = figures.firstElementChild as HTMLElement;
        return {
          bottom: box.bottom - origin,
          clipped:
            name.scrollWidth > name.clientWidth + 1 ||
            name.scrollHeight > name.clientHeight + 1,
          figuresTop: value.getBoundingClientRect().top - origin,
          fitsOnOneLine: naturalWidth <= nameBox.width + 1,
          height: box.height,
          nameBottom: nameBox.bottom - origin,
          nameLines: Math.round(nameBox.height / lineHeight),
          nameText: name.textContent ?? "",
          top: box.top - origin,
          visibleCharacters: visible,
        };
      })
    );
}

/** Today's net sales, in cents, alone in the store: the month, the result and the ticket follow from it. */
const alone = (cents: number): Scenario => ({
  ...SOLD,
  days: { "2026-10-23": [cents, 3] },
  soldWithoutCost: 0,
});
const BIG_SALE = 9_964_035;
/** Below 760 px, or with a finger, the scale of money comes down a step (theme.css, "Touch … or a narrow screen"). */
const PHONE_WIDTH = 760;
const KPI_IDS = ["home-today", "home-month", "home-result", "home-ticket"];

interface HeroRead {
  card: string | null;
  currency: number;
  currencyWeight: string;
  size: number;
  weight: string;
}

/** The size and the weight each number of the four cards is drawn with. */
const readHeroes = (page: Page): Promise<HeroRead[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-kpi-value]")].map((value) => {
      const style = getComputedStyle(value);
      const currency = value.querySelector("[data-money-currency]");
      const currencyStyle = currency ? getComputedStyle(currency) : null;
      return {
        card:
          value.closest("[data-kpi]")?.getAttribute("aria-labelledby") ?? null,
        currency: Number.parseFloat(currencyStyle?.fontSize ?? "NaN"),
        currencyWeight: currencyStyle?.fontWeight ?? "",
        size: Number.parseFloat(style.fontSize),
        weight: style.fontWeight,
      };
    })
  );

const heightOf = async (target: Locator) =>
  (await target.boundingBox())?.height ?? Number.NaN;

test.describe("o padrão único dos valores nos cartões do Início (AC-3.1, AC-3.2, AC-3.6, AC-3.7)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` is a Chrome DevTools command"
  );

  for (const width of [360, 1280]) {
    test(`os quatro cartões têm o valor e o R$ no mesmo tamanho, em peso 600, a ${width} px`, async ({
      page,
    }) => {
      await openReflowViewport(page, { fontPixels: 16, height: 800, width });
      await openHome(page, new FakeServer(SOLD));
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
      const reads = await readHeroes(page);
      expect(reads.map((read) => read.card)).toEqual(KPI_IDS);
      const coarse = await page.evaluate(
        () => matchMedia("(pointer: coarse)").matches
      );
      const lg = width < PHONE_WIDTH || coarse ? 24 : 26;
      expect(
        reads.map((read) => read.size),
        "o valor: text-value-lg nos quatro, sem um principal maior"
      ).toEqual([lg, lg, lg, lg]);
      expect(
        new Set(reads.map((read) => read.currency)).size,
        "o R$ tem um tamanho só nos quatro"
      ).toBe(1);
      expect(reads[0]?.currency).toBeLessThan(lg);
      expect(new Set(reads.map((read) => read.currencyWeight)).size).toBe(1);
      expect(reads.map((read) => read.weight)).toEqual([
        "600",
        "600",
        "600",
        "600",
      ]);
    });
  }

  for (const [width, fontPixels] of [
    [360, 16],
    [375, 16],
    [320, 20],
    [320, 24],
  ] as const) {
    for (const cents of [BIG_SALE, -BIG_SALE]) {
      const text = `${cents < 0 ? "-" : ""}R$ 99.640,35`;
      test(`${text} em Vendas hoje não corta nem quebra a ${width} px com a letra em ${fontPixels} px`, async ({
        page,
      }, testInfo) => {
        await openReflowViewport(page, { fontPixels, width });
        await openHome(page, new FakeServer(alone(cents)));
        await expectReflowFont(page, fontPixels);
        const principal = region(page, "Vendas hoje");
        await expect(principal.locator("[data-kpi-value]")).toHaveText(text, {
          timeout: 20_000,
        });
        await assertNothingClipped(principal);
        const [today, ...rest] = await readHeroes(page);
        const lg = 1.5 * fontPixels;
        const floor = 0.875 * fontPixels;
        for (const read of [today, ...rest]) {
          expect(
            read?.size,
            "o valor desce só até caber na área dele, nunca abaixo do piso"
          ).toBeLessThanOrEqual(lg + 0.01);
          expect(read?.size).toBeGreaterThanOrEqual(floor - 0.01);
        }
        testInfo.annotations.push({
          description: `Vendas hoje ${today?.size} px, KPIs ${rest[0]?.size} px`,
          type: "medida",
        });
        const sameLine = await principal.evaluate((card) => {
          const currency = card
            .querySelector("[data-money-currency]")
            ?.getBoundingClientRect();
          const number = card
            .querySelector("[data-money-number]")
            ?.getBoundingClientRect();
          return Boolean(
            currency &&
              number &&
              number.top < currency.bottom &&
              currency.top < number.bottom
          );
        });
        expect(sameLine, "o R$ e o número na mesma linha").toBe(true);
        await assertNoPageScroll(page);
      });
    }
  }

  for (const fontPixels of [20, 24]) {
    test(`o cartão de Vendas hoje tem a mesma altura com um valor curto, um longo, um negativo e com os valores escondidos, na largura mínima com a letra em ${fontPixels} px`, async ({
      page,
    }) => {
      await openReflowViewport(page, { fontPixels, width: 320 });
      const server = new FakeServer(alone(100));
      await openHome(page, server);
      const principal = region(page, "Vendas hoje");
      await expect(principal.locator("[data-kpi-value]")).toHaveText(
        "R$ 1,00",
        {
          timeout: 20_000,
        }
      );
      const short = await heightOf(principal);
      const hiddenKeepsTheBox = async (cents: number, text: string) => {
        server.scenario = alone(cents);
        await page.reload();
        await expect(principal.locator("[data-kpi-value]")).toHaveText(text, {
          timeout: 20_000,
        });
        expect(
          Math.abs((await heightOf(principal)) - short)
        ).toBeLessThanOrEqual(1);
        const before = await tileAreas(page);
        await page.getByRole("button", { name: "Esconder valores" }).click();
        await expect(principal.locator("[data-masked-money]")).toBeVisible();
        expect(
          Math.abs((await heightOf(principal)) - short)
        ).toBeLessThanOrEqual(1);
        expect(await tileAreas(page)).toEqual(before);
        await page.getByRole("button", { name: "Esconder valores" }).click();
      };
      await hiddenKeepsTheBox(BIG_SALE, "R$ 99.640,35");
      await hiddenKeepsTheBox(-BIG_SALE, "-R$ 99.640,35");
    });
  }
});

async function openRanking(
  page: Page,
  server: FakeServer,
  { at = NOON, fontPixels = 20, width = 320 } = {}
) {
  await openReflowViewport(page, { fontPixels, width });
  await openHome(page, server, at);
  await expect(region(page, "Mais vendidos do mês")).toContainText("un.");
  await expectReflowFont(page, fontPixels);
}

test.describe("Mais vendidos do mês a 320 px com a letra do navegador em 20 px", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` is a Chrome DevTools command"
  );

  reflowTest(
    "o nome tem a sua linha, o valor e as unidades ficam inteiros na de baixo e nada rola de lado",
    async ({ page }) => {
      const server = new FakeServer(SOLD);
      server.top = rankingOf(LONG_NAMES);
      await openRanking(page, server);
      const rows = await rankingRows(page);
      expect(LONG_NAMES.map((name) => name.length)).toEqual([30, 45, 60]);
      expect(rows).toHaveLength(3);
      for (const [index, row] of rows.entries()) {
        expect(row.nameText).toBe(LONG_NAMES[index]);
        expect(
          row.visibleCharacters,
          `caracteres do nome ${index + 1} dentro da caixa`
        ).toBeGreaterThanOrEqual(20);
        expect(
          row.figuresTop,
          `valor ${index + 1} abaixo do nome`
        ).toBeGreaterThanOrEqual(row.nameBottom - 1);
        expect(
          row.fitsOnOneLine,
          `o nome ${index + 1} não cabe em 1 linha a 320 px com letra de 20 px`
        ).toBe(false);
        expect(
          row.nameLines,
          `o nome ${index + 1} quebra em 2 linhas, sem cortar em 1`
        ).toBe(2);
      }
      const block = region(page, "Mais vendidos do mês");
      await assertNothingClipped(block);
      await assertNoEllipsis(block.locator("[data-top-figures]"));
      await assertNoPageScroll(page);
      await expect(block.locator("[data-top-figures]")).toHaveText([
        "R$ 900,0012 un.",
        "R$ 600,008 un.",
        "R$ 300,004 un.",
      ]);
      await expect(block.getByRole("link")).toHaveCount(2);
      await expect(block.getByRole("link").first()).toHaveAttribute(
        "href",
        `/products?produto=${PRODUCT}`
      );
    }
  );

  test("a altura de cada linha não depende do estado: Esconder valores, o 3º produto ausente e outro mês", async ({
    browser,
    page,
  }) => {
    const server = new FakeServer(SOLD_IN_NOVEMBER);
    server.top = rankingOf(LONG_NAMES);
    await openRanking(page, server);
    const full = await rankingRows(page);

    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(region(page, "Mais vendidos do mês")).toContainText("R$ ••••");
    expectSameRows(await rankingRows(page), full, "Esconder valores");

    const fewer = new FakeServer(SOLD_IN_NOVEMBER);
    fewer.top = rankingOf(LONG_NAMES.slice(0, 2));
    await inFreshPage(browser, async (other) => {
      await openRanking(other, fewer);
      expectSameRows(
        await rankingRows(other),
        full.slice(0, 2),
        "sem o 3º produto"
      );
    });

    const later = new FakeServer(SOLD_IN_NOVEMBER);
    later.top = rankingOf(LONG_NAMES, 2);
    await inFreshPage(browser, async (other) => {
      await openRanking(other, later, { at: NOVEMBER });
      await expect(region(other, "Mais vendidos do mês")).toContainText(
        "R$ 1.800,00"
      );
      expectSameRows(
        await rankingRows(other),
        full,
        "outro mês, com outros valores"
      );
    });
  });
});

async function inFreshPage(
  browser: Browser,
  use: (page: Page) => Promise<void>
) {
  const context = await browser.newContext();
  try {
    await use(await context.newPage());
  } finally {
    await context.close();
  }
}

function expectSameRows(
  after: readonly RankingRow[],
  before: readonly RankingRow[],
  when: string
) {
  expect(after.length, when).toBe(before.length);
  for (const [index, row] of after.entries()) {
    const rest = before[index];
    for (const key of ["height", "top"] as const) {
      expect(
        Math.abs(row[key] - (rest?.[key] ?? Number.NaN)),
        `${when}: ${key} da linha ${index + 1}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

const WIDE_WINDOW = 1280;

test.describe("Mais vendidos do mês com a letra de 16 px: a linha de sempre", () => {
  for (const [label, width, height] of [
    ["360", 360, 740],
    ["1280", 1280, 800],
  ] as const) {
    reflowTest(
      `a ${label} px${width >= WIDE_WINDOW ? ", com a lateral recolhida," : ""} nome, valor e unidades ficam numa linha só`,
      async ({ page }) => {
        await page.setViewportSize({ height, width });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(LONG_NAMES);
        await openHome(page, server);
        if (width >= WIDE_WINDOW) {
          await foldSideMenu(page);
        }
        await expect(region(page, "Mais vendidos do mês")).toContainText("un.");
        const rows = await rankingRows(page);
        for (const [index, row] of rows.entries()) {
          expect(
            row.nameBottom,
            `valor na linha do nome ${index + 1}`
          ).toBeGreaterThan(row.figuresTop);
        }
        const line = region(page, "Mais vendidos do mês").locator(
          "[data-top-line]"
        );
        expect(
          await line.evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node).display)
          )
        ).toEqual(["flex", "flex", "flex"]);
        const cut = await region(page, "Mais vendidos do mês")
          .locator("[data-top-name]")
          .last()
          .evaluate((name) => {
            const style = getComputedStyle(name);
            return {
              cut: name.scrollWidth > name.clientWidth,
              ellipsis: style.textOverflow,
              overflow: style.overflowX,
              wrap: style.whiteSpace,
            };
          });
        expect(cut).toEqual({
          cut: true,
          ellipsis: "ellipsis",
          overflow: "hidden",
          wrap: "nowrap",
        });
        await assertNoPageScroll(page);
      },
      { coarse: width < WIDE_WINDOW }
    );
  }
});

async function foldSideMenu(page: Page) {
  await page
    .getByRole("button", { exact: true, name: "Recolher menu" })
    .click();
  await expect(
    page.getByRole("button", { exact: true, name: "Expandir menu" })
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().length))
    .toBe(0);
}

/** Names that fit in one line at the 9 rem or so the row keeps for the name, with a value of up to four digits, when the column is 20 rem wide. */
const SHORT_NAMES = ["Camiseta lisa", "Calça jeans slim", "Tênis de corrida"];

/** From the sidebar up the line is one row only when its box is 20 rem or wider; under it the name has its own line. */
const ONE_LINE_REM = 20;

function columnRem(block: Locator) {
  return block
    .locator("ol > li")
    .first()
    .evaluate((row) => row.getBoundingClientRect().width / 16);
}

function expectNameReads(
  row: RankingRow,
  name: string,
  stacked: boolean,
  when: string
) {
  expect(row.nameText, when).toBe(name);
  expect(row.clipped, `${when}: cortado`).toBe(false);
  expect(
    row.visibleCharacters,
    `${when}: letras à vista`
  ).toBeGreaterThanOrEqual(name.length - 1);
  if (stacked) {
    expect(row.figuresTop, `${when}: valor sob o nome`).toBeGreaterThanOrEqual(
      row.nameBottom - 1
    );
  } else {
    expect(row.nameBottom, `${when}: valor na linha do nome`).toBeGreaterThan(
      row.figuresTop
    );
  }
}

test.describe("Mais vendidos do mês de 1150 a 1361 px: o nome lê inteiro com a lateral aberta e recolhida, e a coluna chega a 20 rem em 1153 px (recolhida) e 1361 px (aberta)", () => {
  for (const side of ["aberta", "recolhida"] as const) {
    reflowTest(
      `lateral ${side}`,
      async ({ page }) => {
        const names = side === "aberta" ? LONG_NAMES : SHORT_NAMES;
        await page.setViewportSize({ height: 800, width: 1150 });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(names);
        await openHome(page, server);
        if (side === "recolhida") {
          await foldSideMenu(page);
        }
        const seen = new Set<string>();
        for (const width of [1150, 1200, 1280]) {
          // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other on the same page
          await page.setViewportSize({ height: 800, width });
          const block = region(page, "Mais vendidos do mês");
          await expect(block).toContainText("un.");
          const rows = await rankingRows(page);
          const rem = await columnRem(block);
          const stacked = rem < ONE_LINE_REM;
          seen.add(stacked ? "empilhada" : "numa linha");
          expect(rows, `${side} ${width} px`).toHaveLength(3);
          rows.forEach((row, index) => {
            expectNameReads(
              row,
              names[index] ?? "",
              stacked,
              `${side} ${width} px (${rem} rem), nome ${index + 1}`
            );
          });
          await assertNoPageScroll(page);
        }
        expect([...seen].sort()).toEqual(
          side === "aberta" ? ["empilhada"] : ["empilhada", "numa linha"]
        );
      },
      { coarse: false }
    );
  }

  const EDGES = [
    { oneLineAt: 1153, side: "recolhida", stackedAt: 1152 },
    { oneLineAt: 1361, side: "aberta", stackedAt: 1360 },
  ] as const;

  for (const edge of EDGES) {
    reflowTest(
      `lateral ${edge.side}: o nome empilha a ${edge.stackedAt} px e fica numa linha só a ${edge.oneLineAt} px`,
      async ({ page }) => {
        await page.setViewportSize({ height: 800, width: edge.stackedAt });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(SHORT_NAMES);
        await openHome(page, server);
        if (edge.side === "recolhida") {
          await foldSideMenu(page);
        }
        for (const [width, stacked] of [
          [edge.stackedAt, true],
          [edge.oneLineAt, false],
        ] as const) {
          // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other on the same page
          await page.setViewportSize({ height: 800, width });
          const block = region(page, "Mais vendidos do mês");
          await expect(block).toContainText("un.");
          const rows = await rankingRows(page);
          const rem = await columnRem(block);
          const when = `${edge.side} ${width} px (${rem} rem)`;
          if (stacked) {
            expect(rem, `${when}: coluna abaixo de 20 rem`).toBeLessThan(
              ONE_LINE_REM
            );
          } else {
            expect(
              rem,
              `${when}: coluna a partir de 20 rem`
            ).toBeGreaterThanOrEqual(ONE_LINE_REM);
          }
          expect(rows, when).toHaveLength(3);
          rows.forEach((row, index) => {
            expectNameReads(
              row,
              SHORT_NAMES[index] ?? "",
              stacked,
              `${when}, nome ${index + 1}`
            );
          });
          await assertNoPageScroll(page);
        }
      },
      { coarse: false }
    );
  }

  reflowTest(
    "a 1024 px com a lateral aberta o nome tem a sua linha, e a 360 px segue numa linha só",
    async ({ page }) => {
      const server = new FakeServer(SOLD);
      server.top = rankingOf(SHORT_NAMES);
      await page.setViewportSize({ height: 800, width: 1024 });
      await openHome(page, server);
      const open = await rankingRows(page);
      expect(open).toHaveLength(3);
      open.forEach((row, index) => {
        expectNameReads(
          row,
          SHORT_NAMES[index] ?? "",
          true,
          `1024 px, nome ${index + 1}`
        );
      });
      await page.setViewportSize({ height: 740, width: 360 });
      const phone = await rankingRows(page);
      expect(phone).toHaveLength(3);
      for (const row of phone) {
        expect(row.nameBottom).toBeGreaterThan(row.figuresTop);
      }
    },
    { coarse: false }
  );
});
