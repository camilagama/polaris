/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Locator, Page, Route } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the sales history the interface guardrails measure (t234): the screen in the lab of the screens
 * (`/offline-screens-lab?screen=history`) over the real offline runtime, with the list answered by the test
 * (`page.route`) and synthetic data only. The lab's own controls are hidden at the end of each state, so what is
 * measured is the screen alone. Three states, for the reason the products screen gives (each one starts the
 * runtime of the lab); the detail of a sale has its own states (`ui-sale-detail-states.ts`).
 */
const id = (n: number) =>
  `0199c2d0-0000-7000-8000-000000001${String(n).padStart(3, "0")}`;

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: id(n),
  itemCount: 2,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
  ...overrides,
});

// a customer, a long customer name, a cancelled sale, one with returns and one dated before it was confirmed,
// so the row shows every badge and the long text
const SALES = [
  entry(1, { customerId: id(90), customerName: "Ângela Souza" }),
  entry(2, {
    cancelledAt: "2026-10-13T12:00:00.000Z",
    itemCount: 1,
    paymentMethod: "cash",
    status: "cancelled",
    totalDue: "20.00",
  }),
  entry(3, {
    customerId: id(91),
    customerName:
      "Maria Aparecida da Conceição Albuquerque de Oliveira Santos Filho",
    hasReturns: true,
    paymentMethod: "credit_card",
    totalDue: "1234.50",
  }),
  entry(4, {
    confirmedAt: "2026-10-14T12:00:01.000Z",
    occurredAt: "2026-10-10T12:00:00.000Z",
    occurredOn: "2026-10-10",
    totalDue: "80.00",
  }),
];

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** Starts the lab's runtime and waits for the screen; the network is the lab's checkbox. */
async function openHistoryLab(page: Page, answers: boolean, hold = false) {
  if (hold) {
    // the server never answers: the list stays loading
    await page.route(
      "**/rpc/sale/list",
      () => new Promise<void>(() => undefined)
    );
  } else if (answers) {
    await page.route("**/rpc/sale/list", (route: Route) =>
      route.fulfill(rpc({ hasMore: true, sales: SALES }))
    );
  }
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, name: "Histórico de vendas" })
    .waitFor();
}

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas" });

/** Below 760 px the editor is the form Dialog of the whole screen: what was touched applies with "Aplicar". */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 760;

async function apply(page: Page, popup: Locator) {
  if (onPhone(page)) {
    await popup.getByRole("button", { exact: true, name: "Aplicar" }).click();
  }
}

/** Chooses a field in the "Filtrar" menu: its pill is added and its editor opens. */
async function addFilter(page: Page, field: string) {
  await bar(page).getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: new RegExp(`^${field}`) })
    .click();
  const popup = page.getByRole("dialog", { name: field });
  await popup.waitFor();
  return popup;
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

export const historyStates = {
  /** The server's list: every badge, a long name, and "Carregar mais". */
  async list(page: Page) {
    await openHistoryLab(page, true);
    await page.getByText("Ângela Souza").waitFor();
    await page.getByRole("button", { name: "Carregar mais" }).waitFor();
    await showScreenAlone(page);
  },

  /** The list on its way: three rows of skeleton in the card, and the line for the screen reader (P-14). */
  async loading(page: Page) {
    await openHistoryLab(page, false, true);
    await page
      .getByRole("status")
      .getByText("Carregando vendas…")
      .waitFor({ state: "attached" });
    await showScreenAlone(page);
  },

  /** Without a network: the notice, the device's window of recent sales, and the search turned off. */
  async offline(page: Page) {
    await openHistoryLab(page, false);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText("Sem conexão.").waitFor();
    await page.getByText("Ângela Souza").waitFor();
    await showScreenAlone(page);
  },

  /** The bar with three pills (Período, Situação, Cliente) and "Limpar tudo", every editor closed. */
  async filters(page: Page) {
    await openHistoryLab(page, true);
    await page.getByText("Ângela Souza").waitFor();
    const period = await addFilter(page, "Período");
    await period.locator('button[data-day="2026-10-12"]').click();
    await period.locator('button[data-day="2026-10-05"]').click();
    await apply(page, period);
    await period.waitFor({ state: "hidden" });
    const status = await addFilter(page, "Situação");
    await status
      .getByRole("button", { exact: true, name: "Canceladas" })
      .click();
    await apply(page, status);
    await status.waitFor({ state: "hidden" });
    const customer = await addFilter(page, "Cliente");
    await customer.getByRole("textbox", { name: "Cliente" }).fill("Ângela");
    await customer
      .getByRole("button", { name: onPhone(page) ? "Aplicar" : "Pronto" })
      .click();
    await customer.waitFor({ state: "hidden" });
    await bar(page).getByRole("button", { name: "Limpar tudo" }).waitFor();
    await showScreenAlone(page);
  },
};
