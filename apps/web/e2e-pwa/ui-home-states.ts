/// <reference lib="dom" />
// Only types from Playwright: the e2e-pwa helpers are read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { serveHealth, serveLabWorker, WORKER_MARK } from "./worker-mark";

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

/** A 500 of the server, with the Worker's mark. */
const FAILURE = {
  body: JSON.stringify({
    json: {
      code: "INTERNAL_SERVER_ERROR",
      data: {},
      defined: false,
      message: "INTERNAL_SERVER_ERROR",
      status: 500,
    },
    meta: [],
  }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status: 500,
};

const SOLD: Readonly<Record<string, [string, number]>> = {
  "2026-09-28": ["310.00", 2],
  "2026-10-17": ["420.50", 3],
  "2026-10-18": ["1840.00", 6],
  "2026-10-19": ["90.00", 1],
  "2026-10-20": ["760.00", 4],
  "2026-10-23": ["520.00", 2],
};

function summary(
  from: string,
  to: string,
  ranked: boolean,
  sold: Readonly<Record<string, [string, number]>> = SOLD
) {
  const daily: { date: string; netSales: string; salesCount: number }[] = [];
  let cents = 0;
  let count = 0;
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    const [netSales, salesCount] = sold[date] ?? ["0.00", 0];
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

/** The light series of the map (`report.dailySales`): the first date and one entry per date, from the same days. */
function dailySales(
  from: string,
  to: string,
  sold: Readonly<Record<string, [string, number]>> = SOLD
) {
  const net: string[] = [];
  const count: number[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY
  ) {
    const [netSales, salesCount] = sold[
      new Date(time).toISOString().slice(0, 10)
    ] ?? ["0.00", 0];
    net.push(netSales);
    count.push(salesCount);
  }
  return { count, from, net };
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

/** The answer of one read of the Início in the scenario served. */
function answer(
  asked: string,
  input: Record<string, unknown>,
  { failing, fresh }: { failing: boolean; fresh: boolean }
) {
  if (asked === "report/periodSummary") {
    return failing
      ? FAILURE
      : rpc(
          summary(
            String(input.from),
            String(input.to),
            Boolean(input.topProducts),
            fresh ? {} : SOLD
          )
        );
  }
  if (asked === "report/dailySales") {
    return rpc(
      dailySales(String(input.from), String(input.to), fresh ? {} : SOLD)
    );
  }
  if (asked === "goal/list") {
    return rpc({ goals: fresh ? [] : [GOAL] });
  }
  if (asked === "inventory/listBalances") {
    return rpc(fresh ? { entries: [], nextCursor: null } : balances(input));
  }
  return rpc({ hasMore: false, sales: [] });
}

interface HomeServed {
  /** `report.periodSummary` answers 500: the alert in the place of the figures. */
  failing?: boolean;
  /** A store that never sold and has no product: the checklist. */
  fresh?: boolean;
  signedIn?: boolean;
}

/**
 * Answers the reads of the Início; register it after a catch-all of `/rpc` (the last route registered is the first
 * asked). With `signedIn`, also the session and the store, for a page opened without the shell's own helper.
 */
export async function serveHome(
  page: Page,
  { failing = false, fresh = false, signedIn = false }: HomeServed = {}
) {
  // without a marked answer of /health the tab is offline: the Início reads nothing and shows its copy, if any
  await serveHealth(page);
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
    "report/dailySales",
    "report/periodSummary",
    "sale/list",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one route at a time, in order
    await page.route(`**/rpc/${procedure}`, (route: Route) =>
      route.fulfill(
        answer(
          new URL(route.request().url()).pathname.replace(RPC_PREFIX, ""),
          (route.request().postDataJSON() as { json?: Record<string, unknown> })
            .json ?? {},
          { failing, fresh }
        )
      )
    );
  }
}

/** Opens `/` in the shell and waits for the state drawn; the fonts are loaded and the focus is nowhere. */
async function openHome(
  page: Page,
  served: HomeServed,
  ready: (page: Page) => Promise<void>
) {
  await serveHome(page, { ...served, signedIn: true });
  await page.goto("/");
  await page.getByRole("heading", { level: 1, name: "Início" }).waitFor();
  await ready(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
}

/** The keys of the Início's copy: A under the period summary's key, the rest under the Início's own, the map's series under its own. */
const COPY_KEYS = /^polaris\.offline\.(home|periodSummary|dailySales)\./;

/** The charts chunk of a build, by its path. */
const CHARTS_CHUNK_PATH = /\/assets\/charts-[\w-]+\.js$/;

const HOME_READS = [
  "goal/list",
  "inventory/listBalances",
  "report/dailySales",
  "report/periodSummary",
  "sale/list",
];

/**
 * The Início without a connection (§ 7.4), in the lab of the screens (`/offline-screens-lab?screen=home`): its
 * runtime is ready with a usable lease, as the copy asks. The page reads once with the network (and keeps its copy),
 * then the network goes; with `copy` false the copy is dropped first, so the page has nothing to show but the
 * sentence. The lab's own controls are hidden at the end: what is measured is the screen alone.
 */
async function openHomeOffline(page: Page, copy: boolean) {
  await readHomeInLab(page);
  if (!copy) {
    await dropHomeCopy(page);
  }
  await cutHomeNetwork(page);
  await page
    .getByText(
      copy
        ? "Último resultado confirmado"
        : "Sem internet e sem números guardados neste aparelho",
      { exact: false }
    )
    .first()
    .waitFor();
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
}

const labNetworks = new WeakMap<Page, { down: boolean }>();

/** The keys of the Início's copy kept in this browser. */
const homeCopyKeys = (page: Page) =>
  page.evaluate(
    (pattern) =>
      Object.keys(localStorage).filter((key) => new RegExp(pattern).test(key)),
    COPY_KEYS.source
  );

/** Drops the Início's copy from this browser. */
async function dropHomeCopy(page: Page) {
  await page.evaluate(
    (keys) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    },
    await homeCopyKeys(page)
  );
}

/** Takes the network away: nothing of the Worker answers, and the browser says it is offline. */
export async function cutHomeNetwork(page: Page) {
  const network = labNetworks.get(page);
  if (network) {
    network.down = true;
  }
  await page.context().setOffline(true);
}

/** Starts the lab's runtime as `user` and waits until the Início shows. */
export async function startHomeLab(page: Page, user: string) {
  await page.goto("/offline-screens-lab?screen=home");
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
}

/**
 * The Início in the lab of the screens with the network: the runtime ready with a usable lease, the figures read
 * with the chart drawn, and the copy kept. Returns the lab's user, to start it again on the same device.
 */
export async function readHomeInLab(page: Page): Promise<string> {
  await page.clock.setFixedTime(new Date(NOW));
  const network: { down: boolean } = { down: Boolean(false) };
  labNetworks.set(page, network);
  await page.route("**/rpc/**", (route: Route) => {
    const asked = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (network.down || !HOME_READS.includes(asked)) {
      return route.abort("internetdisconnected");
    }
    return route.fulfill(
      answer(
        asked,
        (route.request().postDataJSON() as { json?: Record<string, unknown> })
          .json ?? {},
        { failing: false, fresh: false }
      )
    );
  });
  // after the catch-all above: the last route registered is the first asked
  await serveLabWorker(page);
  const user = `inicio-${crypto.randomUUID()}`;
  await startHomeLab(page, user);
  await page
    .getByRole("region", { name: "Vendas por dia" })
    .getByRole("img")
    .waitFor();
  // biome-ignore lint/performance/noAwaitInLoops: waits for the copy the read keeps
  for (let tries = 0; (await homeCopyKeys(page)).length < 3; tries += 1) {
    if (tries > 50) {
      throw new Error("o Início não guardou a cópia");
    }
    await page.waitForTimeout(100);
  }
  return user;
}

/** Takes the charts chunk out of every cache of the service worker. */
export const dropChartsChunkFromCaches = (page: Page) =>
  page.evaluate(async (pattern) => {
    const names = await caches.keys();
    await Promise.all(
      names.map(async (name) => {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((request) =>
              new RegExp(pattern).test(new URL(request.url).pathname)
            )
            .map((request) => cache.delete(request))
        );
      })
    );
  }, CHARTS_CHUNK_PATH.source);

/** The states of the Início the interface guardrails measure (`ui-screens.ts`). */
export const homeStates = {
  /** The numbers did not load: the alert with "Tentar novamente", Meta and Atenção still there. */
  error: (page: Page) =>
    openHome(page, { failing: true }, (opened) =>
      opened
        .getByText("Não foi possível carregar os números da loja.")
        .waitFor()
    ),
  /** No connection, no copy on the device: the sentence in place of the figures, goals and stock only with it. */
  offlineNoCopy: (page: Page) => openHomeOffline(page, false),
  /** No connection, with the copy: the last confirmed figures, the goal kept, the device's line. */
  offlineWithCopy: (page: Page) => openHomeOffline(page, true),
  /** A store that never sold and has no product: the checklist, Meta and Atenção. */
  fresh: (page: Page) =>
    openHome(page, { fresh: true }, (opened) =>
      opened.getByRole("link", { name: "Cadastrar produto" }).waitFor()
    ),
  /** A store with sales: every block, with the chart and the map drawn (not the boxes that hold their places). */
  sold: (page: Page) =>
    openHome(page, {}, async (opened) => {
      await opened
        .getByRole("region", { name: "Vendas por dia" })
        .getByRole("img")
        .waitFor();
      await opened
        .getByRole("region", { name: "Ritmo de vendas" })
        .locator("[data-heatmap] svg")
        .waitFor();
      await opened
        .locator("[data-chart-loading]")
        .first()
        .waitFor({ state: "detached" });
    }),
};
