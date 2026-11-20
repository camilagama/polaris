/// <reference lib="dom" />

import type { Locator, Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "../worker-mark";

/**
 * The Início at `/` with a connection (desenho do Início v2, § 4 and § 5; corte inicio.md AC-1 to AC-23), in the real app
 * against a server played by network interception: the figures (A and B of `report.periodSummary`, with the daily
 * series and the ranking), the goals, the lists of balances and the sales. What the real server computes is proved
 * on PostgreSQL (the `economics` and `home-writes` gates); here, what the screen does with it.
 */

export const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";

const USER_ID = "user-do-inicio";

const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};

/** Any amount in reais, as the page or a slider would say it. */
export const AN_AMOUNT = /R\$ -?\d/;

export const HOUR = 3_600_000;

export const RETURN_REFRESH_MS = 5 * 60_000 + 1000;

export const DAY = 24 * HOUR;

export const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};

/** `23/10/2026` at noon in Brasília. */
export const NOON = Date.parse("2026-10-23T15:00:00.000Z");

export const PRODUCT = "0199c2d0-0000-7000-8000-0000000000b1";

export const DELETED = "0199c2d0-0000-7000-8000-0000000000b2";

export const SALES_PATH = /\/sales$/;

export const json = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

export const failure = (code: string, status: number) => ({
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

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

function money(cents: number): string {
  const whole = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
}

export interface Scenario {
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

export const SOLD: Scenario = {
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
  stock: { all: 5, unknownCost: 1, withoutStock: 3, withStock: 2 },
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
  return [...months.values()].map((days) => {
    const unknownDays = days.filter(
      (day) => day.operatingResult === null
    ).length;
    return {
      date: days[0]?.date,
      days: days.length,
      netSales: money(
        days.reduce(
          (sum, day) => sum + Math.round(Number(day.netSales) * 100),
          0
        )
      ),
      salesCount: days.reduce((sum, day) => sum + Number(day.salesCount), 0),
      to: days.at(-1)?.date,
      unknownDays,
      ...("operatingResult" in (days[0] ?? {})
        ? {
            costs: unknownDays > 0 ? null : "0.00",
            operatingExpenses: "0.00",
            operatingResult:
              unknownDays > 0
                ? null
                : money(
                    days.reduce(
                      (sum, day) =>
                        sum + Math.round(Number(day.operatingResult) * 100),
                      0
                    )
                  ),
          }
        : {}),
    };
  });
}

export class FakeServer {
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

  /**
   * The opening's one list (every status, 100 variants): the catalog of the scenario, in which the first
   * `withoutStock` variants have no stock, the first `unknownCost` have no cost, and the rest has both.
   */
  wideBalances(limit: number) {
    const { stock } = this.scenario;
    if (stock.withStock + stock.withoutStock !== stock.all) {
      throw new Error(
        "the scenario's stock counts do not add up to the catalog"
      );
    }
    return {
      entries: Array.from(
        { length: Math.min(stock.all, limit) },
        (_, index) => ({
          ...balance(index),
          movingAverageCost: index < stock.unknownCost ? null : "5.00",
          quantity: index < stock.withoutStock ? 0 : 3,
        })
      ),
      nextCursor: stock.all > limit ? "mais" : null,
    };
  }

  balances(input: Record<string, unknown>) {
    const { stock } = this.scenario;
    if (
      input.productStatus === "all" &&
      input.stock === undefined &&
      input.cost === undefined &&
      input.limit === 100
    ) {
      return this.wideBalances(100);
    }
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

export const SALE_ID = "0199c2d0-0000-7000-8000-0000000000c1";

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

export async function serve(page: Page, server: FakeServer) {
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

export async function openHome(page: Page, server: FakeServer, at = NOON) {
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

export const region = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });

const PERIOD_BUTTON = /^Período: /;

export const TYPE_DATES = /Digitar as datas/;

export const periodButton = (page: Page) =>
  page.getByRole("button", { name: PERIOD_BUTTON });

/** The picker of the period of the Início, then one of its shortcuts ("Mês passado"): it applies and closes. */
export async function choosePeriod(page: Page, shortcut: string) {
  await periodButton(page).click();
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: shortcut })
    .click();
}

export const newSale = (page: Page) =>
  page.getByRole("link", { exact: true, name: "Nova venda" });

export const periodCalls = (server: FakeServer) =>
  server.calls.filter((call) => call.procedure === "report/periodSummary");

/**
 * No read left on its way: two frames so the event has left the page, a second of the page's clock so a timer that
 * would start a read fires, then the network idle of Playwright (signals, not a wait). A count taken before this
 * passes while an answer is still flying. The second stays under the 5 min that the tests count.
 */
export async function readsEnded(page: Page) {
  await settled(page);
  await page.clock.runFor(1000);
  await page.waitForLoadState("networkidle");
  await settled(page);
}

export function goal(overrides: Record<string, unknown>) {
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

export const SYNCED = /sincronizado/i;

export const OFFLINE_KEYS =
  /^polaris\.offline\.(home|periodSummary|dailySales)\./;

/** The keys of the Início's copy (A, B and the map's series) in this browser. */
export const copyKeys = (page: Page) =>
  page.evaluate(
    (pattern) =>
      Object.keys(localStorage)
        .filter((key) => new RegExp(pattern).test(key))
        .sort(),
    OFFLINE_KEYS.source
  );

/** Opens the Início with the server, waits for its copy on the device, and leaves it ready to be cut. */
export async function openWithCopy(page: Page, server: FakeServer) {
  await openHome(page, server);
  await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  await expect.poll(() => copyKeys(page)).toHaveLength(3);
  // the offline runtime finished opening (a usable lease, the collections in place): a sale can be kept offline
  await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
    timeout: 20_000,
  });
}

/** Opens the page again with no network at all but `navigator.onLine` true, the device's clock at `at`. */
export async function reopenWithoutNetwork(
  page: Page,
  server: FakeServer,
  at = NOON
) {
  server.down = true;
  await page.clock.setSystemTime(new Date(at));
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible({ timeout: 20_000 });
}

export const CONFIRMED = "Confirmado em 23/10 12:00";

export const RPC_PATH = /\/rpc\/(.+)$/;

export const SOBRE = /^Sobre /;

export const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

/** The table of the days of a chart: in the page for a screen reader, one pixel tall on the screen and out of the tab order. */
export async function expectInvisibleTable(block: Locator, columns = 3) {
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
export interface Place {
  height: number;
  top: number;
}

export const placeOf = (locator: Locator): Promise<Place> =>
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

/** The geometry the areas of each KPI tile keep: the tile, its sparkline and the area of its number. */
export async function tileAreas(page: Page) {
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

/** Today's net sales, in cents, alone in the store: the month, the result and the ticket follow from it. */
export const alone = (cents: number): Scenario => ({
  ...SOLD,
  days: { "2026-10-23": [cents, 3] },
  soldWithoutCost: 0,
});
