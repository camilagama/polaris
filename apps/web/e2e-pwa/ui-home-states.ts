/// <reference lib="dom" />
// Only types from Playwright: the e2e-pwa helpers are read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

/**
 * The reads of the Início (`/`) answered by the test, synthetic data only: the month and the days before it with the
 * daily series and the ranking, an active goal, three variants with no stock and a store that already sold. The
 * shell check (`ui-shell-isolation.e2e.ts`) and the CSP check (`ui-csp.e2e.ts`) open the real page with them, so the
 * chart and its chunk are drawn under the real rules. The states and the errors are proved in `e2e/home.e2e.ts`.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
/** 23/10/2026 at noon in Brasília: the month of the figures is the server's, whatever the device's date. */
const NOW = "2026-10-23T15:00:00.000Z";
const DAY = 86_400_000;
const RPC_PREFIX = /^\/rpc\//;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const SOLD: Readonly<Record<string, [string, number]>> = {
  "2026-09-28": ["310.00", 2],
  "2026-10-17": ["420.50", 3],
  "2026-10-18": ["1840.00", 6],
  "2026-10-19": ["90.00", 1],
  "2026-10-20": ["760.00", 4],
  "2026-10-23": ["520.00", 2],
};

function summary(from: string, to: string, ranked: boolean) {
  const daily: { date: string; netSales: string; salesCount: number }[] = [];
  let cents = 0;
  let count = 0;
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    const [netSales, salesCount] = SOLD[date] ?? ["0.00", 0];
    daily.push({ date, netSales, salesCount });
    cents += Math.round(Number(netSales) * 100);
    count += salesCount;
  }
  const net = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const zero = "0.00";
  return {
    cards: {
      items: count,
      marginPercent: count > 0 ? "41.20" : null,
      netSales: net,
      operatingResult: net,
      salesCount: count,
      ticket: null,
    },
    chain: {
      anticipationFees: zero,
      cogs: zero,
      commercialSurcharges: zero,
      contributionMargin: net,
      discounts: zero,
      estimatedOperatingResult: net,
      grossProfit: net,
      grossSales: net,
      linkedExpenses: zero,
      netSales: net,
      operatingExpenses: zero,
      processingFees: zero,
      returns: zero,
    },
    daily,
    generatedAt: NOW,
    period: { from, to },
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: count,
      itemLinesWithUnknownCost: 0,
      level: count > 0 ? "partial" : "no_data",
      linkedExpenses: 0,
      missing: count > 0 ? ["no_expenses"] : ["no_sales"],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: count,
    },
    ...(ranked && count > 0
      ? {
          topProducts: [
            {
              deleted: false,
              name: "Camiseta básica",
              netSales: "900.00",
              productId: "0199c2d0-0000-7000-8000-0000000000b1",
              quantity: 9,
            },
          ],
        }
      : {}),
  };
}

const GOAL = {
  achievedValue: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  endsOn: "2026-10-31",
  id: "0199c2d0-0000-7000-8000-000000000c01",
  kind: "net_sales",
  name: "Outubro forte",
  organizationId: ORGANIZATION.id,
  paused: false,
  progress: {
    percent: "72.6",
    periodEnded: false,
    reached: false,
    value: "3630.50",
  },
  settledAt: null,
  startsOn: "2026-10-01",
  status: "active",
  target: "5000.00",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

function balances(input: Record<string, unknown>) {
  const count = input.stock === "without_stock" ? 3 : 0;
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      isDefaultVariant: true,
      listPrice: "10.00",
      movingAverageCost: null,
      productId: `0199c2d0-0000-7000-8000-0000000001${index}0`,
      productName: `Produto ${index + 1}`,
      productStatus: "active",
      quantity: 0,
      sku: null,
      updatedAt: null,
      values: [],
      variantId: `0199c2d0-0000-7000-8000-0000000002${index}0`,
      version: 0,
    })),
    nextCursor: null,
  };
}

/**
 * Answers the reads of the Início; register it after a catch-all of `/rpc` (the last route registered is the first
 * asked). With `signedIn`, also the session and the store, for a page opened without the shell's own helper.
 */
export async function serveHome(page: Page, { signedIn = false } = {}) {
  if (signedIn) {
    await page.route("**/rpc/**", (route) =>
      route.abort("internetdisconnected")
    );
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      })
    );
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(rpc({ organizations: [ORGANIZATION] }))
    );
  }
  for (const procedure of [
    "goal/list",
    "inventory/listBalances",
    "report/periodSummary",
    "sale/list",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one route at a time, in order
    await page.route(`**/rpc/${procedure}`, (route: Route) => {
      const input =
        (route.request().postDataJSON() as { json?: Record<string, unknown> })
          .json ?? {};
      const asked = new URL(route.request().url()).pathname.replace(
        RPC_PREFIX,
        ""
      );
      if (asked === "report/periodSummary") {
        return route.fulfill(
          rpc(
            summary(
              String(input.from),
              String(input.to),
              Boolean(input.topProducts)
            )
          )
        );
      }
      if (asked === "goal/list") {
        return route.fulfill(rpc({ goals: [GOAL] }));
      }
      if (asked === "inventory/listBalances") {
        return route.fulfill(rpc(balances(input)));
      }
      return route.fulfill(rpc({ hasMore: false, sales: [] }));
    });
  }
}
