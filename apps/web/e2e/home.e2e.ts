/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The Início at `/` with a connection (desenho t269 v2, § 4 and § 5; corte inicio.md AC-1 to AC-23), in the real app
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};
/** 23/10/2026 at noon in Brasília. */
const NOON = Date.parse("2026-10-23T15:00:00.000Z");
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000b1";
const DELETED = "0199c2d0-0000-7000-8000-0000000000b2";
const SALES_PATH = /\/sales$/;
const DASHBOARD_PATH = /\/dashboard$/;
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
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

interface Scenario {
  /** Net sales in cents and the count of each day that sold. */
  days: Record<string, [number, number]>;
  /** What `sale.list` finds: none, or a sale (cancelled, out of A and B). */
  everSold: boolean;
  goals: unknown[];
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

class FakeServer {
  scenario: Scenario;
  /** The server's clock (Node's, not the page's: the page's clock is Playwright's). */
  now = NOON;
  readonly calls: Array<{ input: Record<string, unknown>; procedure: string }> =
    [];
  /** Answers of a procedure replaced by a failure, a hold or a missing mark. */
  readonly broken = new Map<
    string,
    "401" | "429" | "500" | "slow" | "unmarked"
  >();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  summary(from: string, to: string, topProducts: unknown) {
    const daily: { date: string; netSales: string; salesCount: number }[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const [cents, count] = this.scenario.days[day] ?? [0, 0];
      daily.push({ date: day, netSales: money(cents), salesCount: count });
    }
    const net = daily.reduce(
      (sum, day) => sum + Math.round(Number(day.netSales) * 100),
      0
    );
    const count = daily.reduce((sum, day) => sum + day.salesCount, 0);
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
      daily,
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
            topProducts: [
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

  answer(procedure: string, input: Record<string, unknown>) {
    switch (procedure) {
      case "report/periodSummary":
        return json(
          this.summary(String(input.from), String(input.to), input.topProducts)
        );
      case "goal/list":
        return json({ goals: this.scenario.goals });
      case "inventory/listBalances":
        return json(this.balances(input));
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

const HOME_PROCEDURES = new Set([
  "goal/list",
  "inventory/listBalances",
  "report/periodSummary",
  "sale/list",
]);

async function serve(page: Page, server: FakeServer) {
  // a read with no answer is judged by the probe of /health: it answers, so it was an isolated failure (not offline)
  await serveHealth(page);
  await page.route("**/rpc/**", async (route) => {
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
    const broken = server.broken.get(procedure);
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
    route.fulfill(
      json({
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "Loja do Início",
            role: "owner",
            timezone: "America/Sao_Paulo",
          },
        ],
      })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({
        user: { email: "inicio@exemplo.com.br", id: USER_ID },
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
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
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
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

const region = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });
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
      page.getByText("Atualizado até 23/10/2026 12:00")
    ).toBeVisible();

    const today = region(page, "Hoje");
    await expect(today).toContainText("R$ 320,10");
    await expect(today).toContainText("Vendas líquidas · 2 vendas");
    // the miniature is a reinforcement: hidden from the screen reader, with no axis
    await expect(today.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(today.locator("svg text")).toHaveCount(0);

    const month = region(page, "Outubro");
    await expect(month).toContainText("R$ 2.660,60");
    await expect(month).toContainText("Resultado estimado");
    await expect(month).toContainText("estimativa incompleta");
    await expect(month).toContainText(
      "Não é lucro líquido nem dinheiro já recebido."
    );
    // 1 to 23 October against 1 to 23 September: R$ 2.660,60 − R$ 170,00
    await expect(month).toContainText(
      "R$ 2.490,60 a mais que no mesmo período de setembro"
    );
    await expect(
      month.getByRole("link", { name: "Ver o resultado" })
    ).toHaveAttribute("href", "/dashboard");

    const meta = region(page, "Meta");
    await expect(meta).toContainText("Meta de outubro");
    await expect(meta).toContainText("de 01/10 a 31/10");
    await expect(meta).toContainText("R$ 2.670,60 de R$ 5.000,00");
    await expect(meta).toContainText("53,4%");
    await expect(
      meta.getByRole("link", { name: "Ver as outras" })
    ).toHaveAttribute("href", "/dashboard?meta=lista");

    const attention = region(page, "Precisa de atenção");
    await expect(attention.getByRole("link")).toHaveText([
      "1 variante sem custo. Informe para as próximas vendas.",
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
    await expect(chart.getByRole("tab", { name: "7 dias" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(chart).toContainText("R$ 2.580,60");
    await expect(chart).toContainText("Melhor dia: 18/10, R$ 1.840,00");
    await expect(chart.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas líquidas por dia, de 17/10 a 23/10: R$ 2.580,60 no total"
    );
    await chart.getByRole("button", { name: "Ver os números" }).click();
    await expect(chart.getByRole("row")).toHaveCount(8);
    await expect(chart.getByRole("row").nth(2)).toContainText(
      "18/10/2026R$ 1.840,00"
    );
    await chart.getByRole("tab", { name: "30 dias" }).click();
    await expect(chart).toContainText("Vendas líquidas de 24/09 a 23/10");
    await expect(chart).toContainText("R$ 2.660,60");

    // the order of the parts at 360 px (AC-4), and nothing scrolls sideways
    const names = await page
      .locator('main [role="region"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector("h2")?.textContent)
      );
    expect(names).toEqual([
      "Hoje",
      "Outubro",
      "Meta",
      "Precisa de atenção",
      "Mais vendidos do mês",
      "Vendas por dia",
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
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    for (const target of [
      newSale(page),
      region(page, "Hoje"),
      region(page, "Outubro"),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one box at a time
      const box = await target.boundingBox();
      expect((box?.y ?? 900) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
    }
    const today = await region(page, "Hoje").boundingBox();
    const month = await region(page, "Outubro").boundingBox();
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

  test("sem rede: só o título e Nova venda ativa, com o aviso de conexão e nenhum bloco em erro; tocar pede a Venda", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    await page.context().setOffline(true);
    const notice = page
      .getByRole("status")
      .filter({ hasText: "Sem internet." });
    await expect(notice).toContainText("Esta tela precisa de conexão.");
    await expect(region(page, "Hoje")).toHaveCount(0);
    await expect(region(page, "Precisa de atenção")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    await expect(newSale(page)).toBeVisible();
    await expect(newSale(page)).not.toHaveAttribute("aria-disabled", "true");
    // no read while there is no connection; the ones that come when it is back are the opening's
    const reads = server.calls.length;
    await page.clock.runFor(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(server.calls.length).toBe(reads);
    // the app is served by the service worker offline (e2e-pwa/app-shell.e2e.ts); this harness has none, so the
    // proof here is that the touch asks for /sales
    await expect(newSale(page)).toHaveAttribute("href", "/sales");
    const toSales = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        new URL(request.url()).pathname === "/sales"
    );
    await newSale(page).click();
    await toSales;
  });

  test("a rede volta: o Início lê de novo e os blocos reaparecem, sem recarregar", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    await page.context().setOffline(true);
    await expect(region(page, "Hoje")).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    await expect(page.getByText("Sem internet.")).toHaveCount(0);
  });

  for (const width of [360, 320]) {
    test(`a linha da atenção quebra o texto em vez de cortá-lo, com a seta centrada (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openHome(page, new FakeServer(SOLD));
      const link = region(page, "Precisa de atenção").getByRole("link").first();
      await expect(link).toContainText("Informe para as próximas vendas.");
      const measure = await link.evaluate((anchor) => {
        const text = anchor.querySelector("span");
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
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
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
    await expect(region(page, "Hoje")).toContainText("R$ 520,10");
    await expect(region(page, "Hoje")).toContainText(
      "Vendas líquidas · 3 vendas"
    );
    expect(periodCalls(server).length).toBeGreaterThan(before);
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
      "2Cadastrar o 1º produto",
      "3Fazer a 1ª venda",
    ]);
    await expect(
      checklist.getByRole("link", { name: "Cadastrar produto" })
    ).toHaveAttribute("href", "/products?novo=1");
    await expect(region(page, "Hoje")).toHaveCount(0);
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(
      region(page, "Meta").getByRole("link", { name: "Definir meta" })
    ).toHaveAttribute("href", "/dashboard?meta=nova");
    await expect(region(page, "Precisa de atenção")).toContainText(
      "Nada precisa de atenção agora."
    );
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
    await expect(region(page, "Hoje")).toContainText(
      "Nenhuma venda hoje ainda"
    );
    const month = region(page, "Outubro");
    await expect(month).toContainText("Nenhuma venda este mês ainda");
    await expect(
      month.getByRole("link", { name: "Fazer uma venda" })
    ).toHaveAttribute("href", "/sales");
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(region(page, "Mais vendidos do mês")).toHaveCount(0);
    await expect(region(page, "Vendas por dia")).toContainText(
      "Sem vendas no período."
    );
    // never "0%" nor an arrow over nothing
    await expect(page.locator("main")).not.toContainText("0%");
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

  test("'Definir meta' abre o formulário de meta no Resultado", async ({
    page,
  }) => {
    await openHome(page, new FakeServer({ ...SOLD, goals: [] }));
    await region(page, "Meta")
      .getByRole("link", { name: "Definir meta" })
      .click();
    await expect(page.getByLabel("Indicador")).toBeFocused();
    // the link did its work: a reload is the screen as it is, not the form again
    await expect(page).toHaveURL(DASHBOARD_PATH);
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
      await expect(alert).toBeVisible();
      await expect(newSale(page)).toHaveAttribute("href", "/sales");
      await expect(region(page, "Meta")).toContainText("Meta");
      await expect(region(page, "Hoje")).toHaveCount(0);
      server.broken.delete("report/periodSummary");
      await alert.getByRole("button", { name: "Tentar novamente" }).click();
      await expect(region(page, "Hoje")).toContainText("R$ 320,10");
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
      "Não foi possível carregar a meta."
    );
    const attention = region(page, "Precisa de atenção");
    await expect(attention).toContainText(
      "Avisos do estoque indisponíveis agora."
    );
    await expect(attention.getByRole("link")).toHaveCount(0);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    server.broken.delete("goal/list");
    await region(page, "Meta")
      .getByRole("button", { name: "Tentar novamente" })
      .click();
    await expect(region(page, "Meta")).toContainText(
      "Nenhuma meta em andamento."
    );
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
    // with no answer about the stock, the block does not say that nothing needs attention
    await expect(region(page, "Precisa de atenção")).toHaveCount(0);
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
      page
        .getByRole("status")
        .filter({ hasText: "Carregando os números de hoje…" })
    ).toBeAttached();
    await expect(region(page, "Hoje")).toContainText("R$ 320,10", {
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
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    server.now = at2359 + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(before);
    await expect(region(page, "Hoje")).toContainText(
      "Nenhuma venda hoje ainda"
    );
  });

  test("31/10 → 01/11: o mês e os dois períodos mudam", async ({ page }) => {
    const server = new FakeServer(SOLD);
    const at = Date.parse("2026-11-01T02:59:00.000Z");
    await openHome(page, server, at);
    await expect(region(page, "Outubro")).toBeVisible();
    server.now = at + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect(region(page, "Novembro")).toBeVisible();
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
    await expect(region(page, "Outubro")).toBeVisible({ timeout: 20_000 });
    expect(periodCalls(server).at(-2)?.input.from).toBe("2026-10-01");
  });

  test("ao voltar à aba relê, no máximo uma vez a cada 30 s", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(periodCalls(server).length).toBe(before);
    await page.clock.runFor(31_000);
    server.scenario = {
      ...SOLD,
      days: { ...SOLD.days, "2026-10-23": [42_010, 3] },
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(region(page, "Hoje")).toContainText("R$ 420,10");
  });

  test("uma releitura que falha deixa na tela os números já lidos", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
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
    await expect(region(page, "Hoje")).toContainText("R$ 320,10");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
  });
});
