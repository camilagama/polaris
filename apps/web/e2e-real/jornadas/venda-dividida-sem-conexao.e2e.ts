/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { numericCents } from "../oracle";
import { waitForOfflineShell } from "../pages/casca-offline";
import { choose, confirmSale, fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const SHIRT = /Camiseta lisa/;
const SAVED_CARD = "Vendas guardadas neste aparelho";
const REFUSED_TITLE =
  /^Venda de R\$ 300,00 · Pix \+ Débito · \d{2}\/\d{2}, \d{2}:\d{2}$/;
const PROFILE_NAME = "Maquininha da jornada";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/** Offline is a Pro capability and the stack has no provider: the billing record of an active subscription. */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

/** Every command of every outbox of the device (IndexedDB stores named `commands`), oldest first. */
function outbox(page: Page) {
  return page.evaluate(async () => {
    const found: { payload: unknown; status: string; type: string }[] = [];
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
          { payload: unknown; seq: number; status: string; type: string }[]
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
          ...rows.map(({ payload, status, type }) => ({
            payload,
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

/** The payment rows the server recorded for the store, by position. */
async function payments(sql: Sql, organizationId: string) {
  return (
    await sql.query<{
      amount: string;
      method: string;
      position: number;
      profile_version: number | null;
    }>(
      `SELECT p.position, p.method, p.amount::text AS amount,
              p.payment_profile_version_snapshot AS profile_version
         FROM sale_payments p WHERE p.organization_id = $1 ORDER BY p.position`,
      [organizationId]
    )
  ).rows.map((row) => ({ ...row, amount: numericCents(row.amount) }));
}

const syncChip = (page: Page) =>
  page.locator('[data-slot="badge"][role="status"]');
const part = (page: Page, ordinal: 1 | 2) =>
  page.getByRole("group", { exact: true, name: `Parte ${ordinal}` });

async function openStore(
  browser: Parameters<Parameters<typeof test>[2]>[0]["browser"],
  sql: Sql,
  testInfo: Parameters<Parameters<typeof test>[2]>[1],
  name: string
) {
  const journey = await openJourney(browser, testInfo, name, {
    organization: { timezone: ZONE },
  });
  const organizationId = journey.organizationId as string;
  const shirt = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Camiseta lisa",
    "300.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    shirt.variantId,
    3,
    "120.00",
    localDate(runT0(), ZONE)
  );
  await makePro(sql, organizationId);
  return { journey, organizationId };
}

/** Vender with the connection, until the device holds the store; then the connection drops. */
async function sellerOffline(page: Page): Promise<void> {
  // the device clock starts at T0, minutes before this journey on the CI, and the server refuses a command dated too far
  // behind its own clock (`invalid_creation_time`): the device is set to the server's `Date` header first
  const serverNow = (await page.request.get("/health")).headers().date;
  expect(serverNow, "the server answers with its date").toBeDefined();
  await page.clock.setSystemTime(new Date(serverNow as string));
  await page.goto("/sales");
  await expect(
    syncChip(page).filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  await waitForOfflineShell(page);
  await page.context().setOffline(true);
  await expect(syncChip(page).filter({ hasText: "Sem conexão" })).toBeVisible({
    timeout: 15_000,
  });
}

/** R$ 300,00: part 1 Pix 100,00 with no profile, part 2 with the rest (200,00). */
async function splitShirt(page: Page): Promise<void> {
  await fillSale(
    page,
    [{ charged: "300,00", option: SHIRT, quantity: 1, search: "Camiseta" }],
    []
  );
  const start = page.getByRole("button", {
    exact: true,
    name: "Dividir pagamento",
  });
  await expect(start).not.toHaveAttribute("aria-disabled");
  await start.click();
  await choose(page, part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("200,00");
}

async function keepOnDevice(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
}

/**
 * AC-5.3: a sale paid in two parts without internet is kept on the device with its parts, survives the app being opened
 * again with no connection, and goes up when the connection is back: the server records two payment rows in the
 * order typed and the history says "Pix + Crédito".
 */
test("venda dividida sem conexão: guarda as partes, sobrevive à reabertura do app e sobe com Pix + Crédito no Histórico", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(150_000);
  const { journey, organizationId } = await openStore(
    browser,
    sql,
    testInfo,
    "venda-dividida-sem-conexao"
  );
  const { page } = journey;

  await sellerOffline(page);
  await splitShirt(page);
  await choose(page, part(page, 2), "Método", "Crédito");
  await part(page, 2).getByLabel("Número de parcelas").fill("3");
  await choose(page, part(page, 2), "Quem parcela", "Lojista (eu)");
  await choose(
    page,
    part(page, 2),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await expect(
    page.getByText("Fechou: R$ 300,00", { exact: true }).first()
  ).toBeVisible();
  await keepOnDevice(page);
  const kept = await outbox(page);
  expect(kept).toHaveLength(1);
  const [stored] = kept;
  expect(stored?.payload).not.toHaveProperty("payment");
  expect(stored?.payload).toMatchObject({
    payments: [
      { amount: "100.00", method: "pix" },
      { amount: "200.00", installments: 3, method: "credit_card" },
    ],
  });

  // the app is opened again with no connection: the sale is still there, with its parts
  await page.reload();
  await expect(syncChip(page).filter({ hasText: "Sem conexão" })).toBeVisible({
    timeout: 30_000,
  });
  const saved = page.getByRole("region", { name: SAVED_CARD });
  await expect(saved.getByRole("listitem")).toHaveCount(1, { timeout: 30_000 });
  await expect(saved.getByRole("listitem")).toContainText("Pix + Crédito");
  await expect(saved.getByRole("listitem")).toContainText("Aguardando envio");
  expect(await payments(sql, organizationId)).toEqual([]);

  await page.context().setOffline(false);
  await expect(
    syncChip(page).filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => payments(sql, organizationId), { timeout: 30_000 })
    .toEqual([
      { amount: 10_000, method: "pix", position: 0, profile_version: null },
      {
        amount: 20_000,
        method: "credit_card",
        position: 1,
        profile_version: null,
      },
    ]);
  expect(await outbox(page)).toEqual([]);

  await page.goto("/sales/history");
  await expect(page.getByText("Pix + Crédito").first()).toBeVisible({
    timeout: 30_000,
  });
});

/**
 * AC-5.4: part 2 priced with a profile that changed on the server before the sale went up. The whole sale is refused
 * (nothing recorded), Pendências names the parts and offers Refazer, and Refazer opens Vender with both parts, part 2
 * asking for the review of its profile; confirming records the two parts with the current version.
 */
test("venda dividida sem conexão com o perfil da parte 2 mudado: a venda inteira é recusada e Refazer volta com as duas partes", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const { journey, organizationId } = await openStore(
    browser,
    sql,
    testInfo,
    "venda-dividida-perfil-sem-conexao"
  );
  const { page } = journey;
  const { rpc } = journey.user;
  const noFee = { fixedAmount: null, mode: "none" as const, percentage: null };
  const rule = {
    anticipationFee: noFee,
    expectedSettlementDays: 1,
    installmentPlan: null,
    installments: null,
    method: "debit_card" as const,
    processingFee: noFee,
  };
  const profile = await rpc.paymentProfile.create({
    name: PROFILE_NAME,
    organizationId,
    rules: [rule],
  });

  await sellerOffline(page);
  await splitShirt(page);
  await choose(
    page,
    part(page, 1),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await choose(page, part(page, 2), "Método", "Débito");
  await choose(page, part(page, 2), "Perfil de pagamento", PROFILE_NAME);
  await keepOnDevice(page);

  // the profile changes on the server while the device is offline
  const changed = await rpc.paymentProfile.update({
    expectedVersion: profile.version,
    id: profile.id,
    name: PROFILE_NAME,
    organizationId,
    rules: [{ ...rule, expectedSettlementDays: 2 }],
  });
  expect(changed.profile.version).toBeGreaterThan(profile.version);
  await page.context().setOffline(false);
  await expect
    .poll(async () => (await outbox(page)).map((command) => command.status), {
      timeout: 60_000,
    })
    .toEqual(["rejected"]);
  const refusal = await sql.query<{ code: string }>(
    "SELECT outcome_code AS code FROM sync_commands WHERE organization_id = $1",
    [organizationId]
  );
  expect(refusal.rows).toEqual([{ code: "payment_profile_changed" }]);
  expect(
    await payments(sql, organizationId),
    "atomic: no part recorded"
  ).toEqual([]);

  await page.goto("/attention");
  const refused = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: REFUSED_TITLE }),
  });
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await expect(refused).toContainText("O perfil de pagamento da parte 2");
  await expect(refused).toContainText("a venda inteira foi recusada");
  await expect(
    refused.getByRole("button", { name: "Reenviar sem perfil de pagamento" })
  ).toBeVisible();
  await refused.getByRole("button", { name: "Refazer esta venda" }).click();

  await page.waitForURL("**/sales");
  await expect(
    page.getByText("Você está refazendo uma venda recusada")
  ).toBeVisible();
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("200,00");
  await expect(
    part(page, 1).getByRole("combobox", { exact: true, name: "Método" })
  ).toContainText("Pix");
  await expect(
    part(page, 2).getByRole("combobox", { exact: true, name: "Método" })
  ).toContainText("Débito");
  await expect(
    part(page, 2).getByRole("combobox", {
      exact: true,
      name: "Perfil de pagamento",
    })
  ).toContainText(PROFILE_NAME);
  const review = page.getByRole("button", {
    name: "Revisei a prévia da parte 2",
  });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.click();
  await confirmSale(page);

  await expect
    .poll(() => payments(sql, organizationId), { timeout: 30_000 })
    .toEqual([
      { amount: 10_000, method: "pix", position: 0, profile_version: null },
      {
        amount: 20_000,
        method: "debit_card",
        position: 1,
        profile_version: changed.profile.version,
      },
    ]);
  await page.goto("/attention");
  await expect(
    page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: REFUSED_TITLE }),
    })
  ).toContainText("Você já refez esta venda", { timeout: 30_000 });
});

const NO_PROFILE = "Sem perfil de pagamento";
const ITEM_GROUP = /^Item \d+$/;
const PART_GROUP = /^Parte \d+$/;
const CHANGE_VARIANT = /^Trocar/;
const CHANGE_PREFIX = /^Trocar variante de /;

/** What Vender shows after Refazer: each item's name, quantity and charged price, each part's amount, method and profile. */
async function restoredSale(page: Page) {
  const items = page.getByRole("group", { name: ITEM_GROUP });
  const parts = page.getByRole("group", { name: PART_GROUP });
  return {
    items: await Promise.all(
      (await items.all()).map(async (line) => ({
        charged: await line.getByLabel("Preço cobrado").inputValue(),
        name: (
          (await line
            .getByRole("button", { name: CHANGE_VARIANT })
            .textContent()) ?? ""
        ).replace(CHANGE_PREFIX, ""),
        quantity: await line.getByLabel("Quantidade").inputValue(),
      }))
    ),
    parts: await Promise.all(
      (await parts.all()).map(async (scope) => {
        const select = async (name: string) =>
          (
            await scope
              .getByRole("combobox", { exact: true, name })
              .textContent()
          )?.trim();
        return {
          amount: await scope.getByLabel("Valor").inputValue(),
          method: await select("Método"),
          profile: await select("Perfil de pagamento"),
        };
      })
    ),
  };
}

const REDONE_TITLE =
  /^Venda de R\$ 750,00 · Pix \+ Dinheiro · \d{2}\/\d{2}, \d{2}:\d{2}$/;
const PANTS = /Calça jeans/;

/** The items the server recorded for the store, by position. */
async function soldItems(sql: Sql, organizationId: string) {
  return (
    await sql.query<{
      charged: string;
      label: string;
      position: number;
      quantity: number;
    }>(
      `SELECT i.position, i.product_label AS label, i.quantity,
              i.charged_unit_price::text AS charged
         FROM sale_items i WHERE i.organization_id = $1 ORDER BY i.position`,
      [organizationId]
    )
  ).rows.map((row) => ({ ...row, charged: numericCents(row.charged) }));
}

/**
 * Refazer a refused sale paid in two parts (Pix with a profile + Dinheiro) with two items: Vender comes back with the
 * same items, quantities, prices and both parts with the same amounts; confirming records ONE new sale with the two
 * parts, and the refused one stays on the device, untouched, until it is discarded.
 */
test("Refazer uma venda dividida recusada: mesmos itens e as duas partes, a nova entra uma vez e a recusada fica até ser descartada", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(240_000);
  const { journey, organizationId } = await openStore(
    browser,
    sql,
    testInfo,
    "refazer-venda-dividida"
  );
  const { page } = journey;
  const { rpc } = journey.user;
  const pants = await seedProduct(rpc, organizationId, "Calça jeans", "150.00");
  await seedStock(
    rpc,
    organizationId,
    pants.variantId,
    2,
    "60.00",
    localDate(runT0(), ZONE)
  );
  const noFee = { fixedAmount: null, mode: "none" as const, percentage: null };
  const rule = {
    anticipationFee: noFee,
    expectedSettlementDays: 1,
    installmentPlan: null,
    installments: null,
    method: "pix" as const,
    processingFee: noFee,
  };
  const profile = await rpc.paymentProfile.create({
    name: PROFILE_NAME,
    organizationId,
    rules: [rule],
  });

  await sellerOffline(page);
  await fillSale(
    page,
    [
      { charged: "300,00", option: SHIRT, quantity: 2, search: "Camiseta" },
      { charged: "150,00", option: PANTS, quantity: 1, search: "Calça" },
    ],
    []
  );
  await page
    .getByRole("button", { exact: true, name: "Dividir pagamento" })
    .click();
  await choose(page, part(page, 1), "Método", "Pix");
  await choose(page, part(page, 1), "Perfil de pagamento", PROFILE_NAME);
  await part(page, 1).getByLabel("Valor").fill("250,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("500,00");
  await choose(page, part(page, 2), "Método", "Dinheiro");
  await choose(
    page,
    part(page, 2),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await keepOnDevice(page);
  const [kept, ...otherCommands] = await outbox(page);
  expect(otherCommands).toEqual([]);
  expect(kept?.payload).toMatchObject({
    payments: [
      { amount: "250.00", method: "pix" },
      { amount: "500.00", method: "cash" },
    ],
  });

  const changed = await rpc.paymentProfile.update({
    expectedVersion: profile.version,
    id: profile.id,
    name: PROFILE_NAME,
    organizationId,
    rules: [{ ...rule, expectedSettlementDays: 2 }],
  });
  await page.context().setOffline(false);
  await expect
    .poll(async () => (await outbox(page)).map((command) => command.status), {
      timeout: 60_000,
    })
    .toEqual(["rejected"]);
  expect(
    (
      await sql.query<{ code: string }>(
        "SELECT outcome_code AS code FROM sync_commands WHERE organization_id = $1",
        [organizationId]
      )
    ).rows
  ).toEqual([{ code: "payment_profile_changed" }]);
  expect(await payments(sql, organizationId)).toEqual([]);

  await page.goto("/attention");
  const refused = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: REDONE_TITLE }),
  });
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await expect(refused).toContainText("O perfil de pagamento da parte 1");
  await refused.getByRole("button", { name: "Refazer esta venda" }).click();

  await page.waitForURL("**/sales");
  await expect(
    page.getByText("Você está refazendo uma venda recusada")
  ).toBeVisible();
  await expect(page.getByRole("group", { name: ITEM_GROUP })).toHaveCount(2);
  await expect(page.getByRole("group", { name: PART_GROUP })).toHaveCount(2);
  await expect
    .poll(() => restoredSale(page), { timeout: 30_000 })
    .toEqual({
      items: [
        {
          charged: "300,00",
          name: "Camiseta lisa",
          quantity: "2",
        },
        {
          charged: "150,00",
          name: "Calça jeans",
          quantity: "1",
        },
      ],
      parts: [
        { amount: "250,00", method: "Pix", profile: PROFILE_NAME },
        { amount: "500,00", method: "Dinheiro", profile: NO_PROFILE },
      ],
    });
  const review = page.getByRole("button", {
    name: "Revisei a prévia da parte 1",
  });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.click();
  await confirmSale(page);

  await expect
    .poll(() => payments(sql, organizationId), { timeout: 30_000 })
    .toEqual([
      {
        amount: 25_000,
        method: "pix",
        position: 0,
        profile_version: changed.profile.version,
      },
      { amount: 50_000, method: "cash", position: 1, profile_version: null },
    ]);
  expect(await soldItems(sql, organizationId)).toEqual([
    {
      charged: 30_000,
      label: "Camiseta lisa",
      position: 0,
      quantity: 2,
    },
    {
      charged: 15_000,
      label: "Calça jeans",
      position: 1,
      quantity: 1,
    },
  ]);

  expect(
    await outbox(page),
    "the refused sale is still on the device, as it was"
  ).toEqual([{ ...kept, status: "rejected" }]);
  await page.goto("/attention");
  await expect(refused).toContainText("Você já refez esta venda", {
    timeout: 30_000,
  });
  await expect(
    refused.getByRole("button", { name: "Refazer esta venda" })
  ).toHaveCount(0);
  await refused
    .getByRole("button", { name: "Descartar a venda recusada…" })
    .click();
  await page.getByRole("button", { name: "Confirmar descarte" }).click();
  await expect.poll(() => outbox(page), { timeout: 15_000 }).toEqual([]);
  await page.goto("/attention");
  await expect(refused).toHaveCount(0);
  expect(
    (await payments(sql, organizationId)).map((row) => row.method),
    "the new sale is still the one recorded"
  ).toEqual(["pix", "cash"]);
});
