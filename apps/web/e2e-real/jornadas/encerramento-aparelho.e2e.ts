/// <reference lib="dom" />

import type { BrowserContext, Page } from "@playwright/test";
import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents, saleTotals } from "../oracle";
import { fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const CLOSED_PANEL = /\/loja-encerrada\?loja=/;
const REOPENED = /\/\?reaberta=1$/;
const MUG = /Caneca/;
const LIST_CLOSED = "/rpc/organization/listClosed";
const LIST_MINE = "/rpc/organization/listMine";
const SESSION_ENDED = /Sua sessão acabou|sessão expirou/;
const STOCK = 10;
const SOLD = 2;

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/**
 * Offline writes are a Pro capability and the stack has no provider: the billing record of an active subscription,
 * written into the run database, as `encerramento.e2e.ts` does.
 */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

/** The browser's calls to the real server, by path: observed on the context, never answered by the test. */
function countCalls(context: BrowserContext) {
  const calls = new Map<string, number>();
  context.on("request", (request) => {
    const { pathname } = new URL(request.url());
    calls.set(pathname, (calls.get(pathname) ?? 0) + 1);
  });
  return (path: string) => calls.get(path) ?? 0;
}

/** Every command of every outbox of the device (IndexedDB stores named `commands`), oldest first. */
function outbox(page: Page) {
  return page.evaluate(async () => {
    const found: { commandId: string; status: string; type: string }[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of tiny databases
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (database.objectStoreNames.contains("commands")) {
        const rows = await new Promise<
          { commandId: string; seq: number; status: string; type: string }[]
        >((resolve, reject) => {
          const request = database
            .transaction("commands", "readonly")
            .objectStore("commands")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        rows.sort((a, b) => a.seq - b.seq);
        found.push(
          ...rows.map(({ commandId, status, type }) => ({
            commandId,
            status,
            type,
          }))
        );
      }
      database.close();
    }
    return found;
  });
}

async function books(sql: Sql, organizationId: string, variantId: string) {
  const [row] = (
    await sql.query<{
      balance: number;
      movements: number;
      sales: number;
      total: string | null;
    }>(
      `SELECT (SELECT quantity FROM inventory_balances WHERE variant_id = $1) AS balance,
              (SELECT sum(quantity_delta)::int FROM stock_movements WHERE variant_id = $1) AS movements,
              (SELECT count(*)::int FROM sales WHERE organization_id = $2) AS sales,
              (SELECT sum(i.quantity * i.charged_unit_price)
                 FROM sale_items i JOIN sales s ON s.id = i.sale_id
                WHERE s.organization_id = $2)::text AS total`,
      [variantId, organizationId]
    )
  ).rows;
  return row;
}

const syncChip = (page: Page) => page.getByRole("status");

/**
 * The device side of the closure: a sale kept on the device without internet survives the closure
 * made elsewhere, the device says the store is closed and leads to its panel, and once the closure is undone the
 * kept sale reaches the server exactly once. Offline is the browser context's own (`setOffline`): the preview, the
 * service worker, the outbox and the server are the real ones.
 */
test("encerramento no aparelho: a venda guardada sem internet sobrevive ao encerramento, o aviso leva ao painel e, desfeito, a venda chega uma vez", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(90_000);
  const journey = await openJourney(
    browser,
    testInfo,
    "encerramento-aparelho",
    {
      organization: { timezone: ZONE },
    }
  );
  const { page } = journey;
  const { rpc } = journey.user;
  const organizationId = journey.organizationId as string;
  const storeName = journey.name;
  const product = await seedProduct(rpc, organizationId, "Caneca", "35.00");
  await seedStock(
    rpc,
    organizationId,
    product.variantId,
    STOCK,
    "12.00",
    localDate(runT0(), ZONE)
  );
  await makePro(sql, organizationId);
  const calls = countCalls(page.context());

  // AC-4, the active side: an account whose store is active never asks for the closed ones
  await page.goto("/sales");
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toBeVisible();
  await expect(
    syncChip(page).filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  expect(calls(LIST_MINE), "the counter sees the app's reads").toBeGreaterThan(
    0
  );
  expect(calls(LIST_CLOSED)).toBe(0);

  // one sale kept on the device, without internet
  await page.context().setOffline(true);
  await expect(syncChip(page).filter({ hasText: "Sem conexão" })).toBeVisible({
    timeout: 15_000,
  });
  await fillSale(
    page,
    [{ charged: "35,00", option: MUG, quantity: SOLD, search: "Caneca" }],
    []
  );
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  await expect(
    syncChip(page).filter({ hasText: "Sem conexão · 1 operação guardada" })
  ).toBeVisible();
  const kept = await outbox(page);
  expect(kept).toEqual([
    { commandId: expect.any(String), status: "pending", type: "sale.confirm" },
  ]);
  const before = await books(sql, organizationId, product.variantId);
  expect(before).toMatchObject({ balance: STOCK, sales: 0 });

  // the owner closes the store elsewhere; then the internet comes back
  await rpc.organization.requestClosure({
    confirmation: storeName,
    organizationId,
  });
  await page.context().setOffline(false);

  // AC-2: the notice of the closed store, with the way to its panel, and not the one of an ended session
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "Esta loja foi encerrada" });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText(
    "o que não foi enviado continua guardado na fila"
  );
  const panelLink = notice.getByRole("link", { name: "Ver a loja encerrada" });
  await expect(panelLink).toHaveAttribute(
    "href",
    `/loja-encerrada?loja=${organizationId}`
  );
  await expect(page.getByText(SESSION_ENDED)).toHaveCount(0);

  // AC-1: the queue still holds the same one command, and the server has no sale
  expect(await outbox(page)).toEqual(kept);
  expect(await books(sql, organizationId, product.variantId)).toEqual(before);

  await panelLink.click();
  await page.waitForURL(CLOSED_PANEL);
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: `${storeName} está encerrada`,
    })
  ).toBeVisible();
  await expect(page.getByText(SESSION_ENDED)).toHaveCount(0);
  expect(await outbox(page), "the panel keeps the queue").toEqual(kept);

  // AC-3: undone inside the window, the kept sale reaches the server once, and the queue empties
  await page
    .getByRole("button", { exact: true, name: "Desfazer encerramento" })
    .click();
  await page
    .getByRole("dialog", { name: "Desfazer o encerramento?" })
    .getByRole("button", { name: "Sim, desfazer" })
    .click();
  await page.waitForURL(REOPENED);
  await expect.poll(() => outbox(page), { timeout: 30_000 }).toEqual([]);
  const expected = saleTotals(
    [{ chargedCents: cents("35.00"), quantity: SOLD }],
    []
  );
  const after = await books(sql, organizationId, product.variantId);
  expect(after).toMatchObject({
    balance: STOCK - SOLD,
    movements: STOCK - SOLD,
    sales: 1,
  });
  expect(numericCents(after?.total as string)).toBe(expected.total);
  const [{ commands } = { commands: 0 }] = (
    await sql.query<{ commands: number }>(
      "SELECT count(*)::int AS commands FROM sync_commands WHERE organization_id = $1 AND command_id = $2",
      [organizationId, kept[0]?.commandId]
    )
  ).rows;
  expect(commands, "the kept command, recorded once").toBe(1);
  // the app's background sync, a moment later, sends nothing more
  await expect(
    syncChip(page).filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  expect((await books(sql, organizationId, product.variantId))?.sales).toBe(1);
});

/** AC-4 (AC-10 of the closure): an account whose only store is closed opens on the panel of that store. */
test("encerramento no aparelho: conta só com loja encerrada abre no painel dela", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "encerramento-so-encerrada",
    { organization: { timezone: ZONE } }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  await journey.user.rpc.organization.requestClosure({
    confirmation: journey.name,
    organizationId,
  });
  const calls = countCalls(page.context());

  await page.goto("/");
  await page.waitForURL(`**/loja-encerrada?loja=${organizationId}`);
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: `${journey.name} está encerrada`,
    })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Abra a sua loja" })
  ).toHaveCount(0);
  expect(calls(LIST_CLOSED)).toBeGreaterThan(0);
});
