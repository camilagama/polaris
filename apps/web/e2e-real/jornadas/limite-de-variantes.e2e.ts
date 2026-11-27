import type { Page } from "@playwright/test";
import { expect, openJourney, test } from "../fixtures";

const ZONE = "America/Sao_Paulo";
const FREE_LIMIT = 50;
const SEEDED = FREE_LIMIT - 1;
const SEED_LEG = 10;
const LIMIT_REFUSAL = "Seu plano chegou ao limite de variantes.";
const LIMIT_REASON = "entitlement_limit_reached";
const MORE_ACTIONS = /^Mais ações/;
const NAME_FIELD = "Digite o nome do produto para confirmar";
const FIRST_BY_NAME = "Limite 00 pela tela";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];
type Rpc = Awaited<ReturnType<typeof openJourney>>["user"]["rpc"];

/** The variants a store holds against its plan, read by a query of its own: every variant of a product not deleted. */
async function variantCount(sql: Sql, organizationId: string) {
  const { rows } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM product_variants v
       JOIN products p ON p.organization_id = v.organization_id AND p.id = v.product_id
      WHERE v.organization_id = $1 AND p.deleted_at IS NULL`,
    [organizationId]
  );
  return rows[0]?.n;
}

async function storedProducts(sql: Sql, organizationId: string, name: string) {
  const { rows } = await sql.query<{ archived: boolean; deleted: boolean }>(
    `SELECT archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted
       FROM products WHERE organization_id = $1 AND name = $2`,
    [organizationId, name]
  );
  return rows;
}

/** Products "Limite 01" to "Limite 49", one variant each, in legs that stay far from the 120 writes of the minute. */
async function seedProducts(rpc: Rpc, organizationId: string) {
  for (let from = 1; from <= SEEDED; from += SEED_LEG) {
    const names = Array.from(
      { length: Math.min(SEED_LEG, SEEDED - from + 1) },
      (_, index) => `Limite ${String(from + index).padStart(2, "0")}`
    );
    // biome-ignore lint/performance/noAwaitInLoops: one leg at a time keeps the writes of the minute low
    await Promise.all(
      names.map((name) => rpc.product.create({ name, organizationId }))
    );
  }
}

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const { code, data } = error as {
      code?: unknown;
      data?: { reason?: unknown } | null;
    };
    return { code: String(code), reason: data?.reason };
  }
  throw new Error("The call was expected to be refused, and it answered.");
}

/** The billing record of an active subscription: the stack has no provider, so the plan changes by this one row. */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

const rowOf = (page: Page, name: string) =>
  page.locator("[data-product-id]", { hasText: name });

async function fillNewProduct(page: Page, name: string) {
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Novo produto" });
  await dialog.getByLabel("Nome do produto").fill(name);
  return dialog;
}

/** The registration that the plan's limit refuses: the dialog stays open, with the refusal and the typed name. */
async function expectRefusedOnScreen(page: Page, name: string) {
  const dialog = await fillNewProduct(page, name);
  await dialog.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(dialog.getByRole("alert")).toContainText(LIMIT_REFUSAL);
  await expect(dialog.getByRole("alert")).toContainText("Nada foi cadastrado.");
  return dialog;
}

/**
 * The Free plan's limit of 50 variants, on the real stack (the default variant counts): the 50th product enters, the
 * 51st is refused on screen and by the command with the limit's reason, and nothing is stored; archiving does not open
 * a vacancy, deleting does; with the Pro (one billing record, no variant touched) the refused product enters. The
 * preview has the owner's billing self-service off, so the panel of the limit ("Conhecer o Pro", "Você usa N de 50")
 * and the line "Excluir libera vaga" are not drawn here: what the screen says is the refusal and, when deleting, the
 * dialog's "libera 1 variante".
 */
test("limite de variantes do plano Free: o 50º entra, o 51º é recusado, arquivado conta, excluído libera e o Pro passa", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(240_000);
  const journey = await openJourney(browser, testInfo, "limite-variantes", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const count = () => variantCount(sql, organizationId);

  await seedProducts(rpc, organizationId);
  expect(await count()).toBe(SEEDED);
  expect(
    (
      await sql.query(
        "SELECT 1 FROM organization_billing WHERE organization_id = $1",
        [organizationId]
      )
    ).rowCount
  ).toBe(0);

  // 49 + the one made on screen = 50 of 50
  await page.goto("/products");
  const dialog = await fillNewProduct(page, FIRST_BY_NAME);
  await dialog.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(rowOf(page, FIRST_BY_NAME)).toBeVisible();
  await expect.poll(count).toBe(FREE_LIMIT);

  // the 51st on screen: refused, "Nada foi cadastrado", and the store keeps 50
  const refusedName = "Limite 51 recusado";
  const refused = await expectRefusedOnScreen(page, refusedName);
  await expect.poll(count).toBe(FREE_LIMIT);
  expect(await storedProducts(sql, organizationId, refusedName)).toEqual([]);
  await refused.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // the same registration by the command, with no screen: the limit's reason, and nothing stored
  const byCommand = "Limite 51 pelo comando";
  expect(
    await refusal(rpc.product.create({ name: byCommand, organizationId }))
  ).toEqual({ code: "CONFLICT", reason: LIMIT_REASON });
  expect(await storedProducts(sql, organizationId, byCommand)).toEqual([]);
  expect(await count()).toBe(FREE_LIMIT);

  // archived still counts: no vacancy, and the 51st is still refused
  await rowOf(page, FIRST_BY_NAME)
    .getByRole("button", { name: MORE_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(
    page.getByText(`Produto “${FIRST_BY_NAME}” arquivado.`)
  ).toBeVisible();
  await expect
    .poll(() => storedProducts(sql, organizationId, FIRST_BY_NAME))
    .toEqual([{ archived: true, deleted: false }]);
  expect(await count()).toBe(FREE_LIMIT);
  const stillRefused = await expectRefusedOnScreen(page, refusedName);
  expect(await storedProducts(sql, organizationId, refusedName)).toEqual([]);
  expect(await count()).toBe(FREE_LIMIT);
  await stillRefused.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // deleting it (archived and with no stock) frees the vacancy
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await rowOf(page, FIRST_BY_NAME)
    .getByRole("button", { name: MORE_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: "Excluir…" }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: `Excluir produto “${FIRST_BY_NAME}”?`,
  });
  await expect(deleteDialog).toContainText(
    "Este produto libera 1 variante do seu plano."
  );
  await deleteDialog.getByLabel(NAME_FIELD).fill(FIRST_BY_NAME);
  await deleteDialog.getByRole("button", { name: "Excluir produto" }).click();
  await expect(
    page.getByText(`Produto “${FIRST_BY_NAME}” excluído.`)
  ).toBeVisible();
  await expect.poll(count).toBe(SEEDED);

  // the 51st product of the story enters now: 50 of 50 again
  const entersName = "Limite 51 entra";
  await page.getByRole("tab", { name: "Ativos" }).click();
  const enters = await fillNewProduct(page, entersName);
  await enters.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(rowOf(page, entersName)).toBeVisible();
  await expect.poll(count).toBe(FREE_LIMIT);

  // refused again at 50; the Pro (one billing row, no variant touched) lets the same registration in
  const proName = "Limite 52 do Pro";
  const proDialog = await expectRefusedOnScreen(page, proName);
  expect(await storedProducts(sql, organizationId, proName)).toEqual([]);
  expect(await count()).toBe(FREE_LIMIT);
  await makePro(sql, organizationId);
  await proDialog.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(LIMIT_REFUSAL)).toHaveCount(0);
  await expect(
    page.getByText(`Produto “${proName}” cadastrado.`)
  ).toBeVisible();
  await expect.poll(count).toBe(FREE_LIMIT + 1);
  expect(await storedProducts(sql, organizationId, proName)).toEqual([
    { archived: false, deleted: false },
  ]);
});

/**
 * Two registrations sent at the same time with the store at 49: exactly one enters and the other is refused with the
 * limit's reason; the store ends at 50, never 51. Then one more, at 50, is refused and nothing is stored.
 */
test("limite de variantes: duas criações ao mesmo tempo com a loja em 49, só uma entra", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(240_000);
  const journey = await openJourney(browser, testInfo, "limite-simultaneas", {
    organization: { timezone: ZONE },
  });
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const names = ["Limite 50 corrida A", "Limite 50 corrida B"];

  await seedProducts(rpc, organizationId);
  await journey.page.goto("/products");
  expect(await variantCount(sql, organizationId)).toBe(SEEDED);

  const outcomes = await Promise.allSettled(
    names.map((name) => rpc.product.create({ name, organizationId }))
  );
  const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const refused = outcomes.filter((outcome) => outcome.status === "rejected");
  expect(accepted).toHaveLength(1);
  expect(refused).toHaveLength(1);
  const { code, data } = (refused[0] as PromiseRejectedResult).reason as {
    code?: unknown;
    data?: { reason?: unknown } | null;
  };
  expect({ code, reason: data?.reason }).toEqual({
    code: "CONFLICT",
    reason: LIMIT_REASON,
  });

  await expect.poll(() => variantCount(sql, organizationId)).toBe(FREE_LIMIT);
  const stored = await Promise.all(
    names.map((name) => storedProducts(sql, organizationId, name))
  );
  expect(stored.flat()).toHaveLength(1);
  expect(await variantCount(sql, organizationId)).toBe(FREE_LIMIT);

  // at 50, one more is refused by the command and nothing is stored
  const extra = "Limite 51 depois da corrida";
  expect(
    await refusal(rpc.product.create({ name: extra, organizationId }))
  ).toEqual({ code: "CONFLICT", reason: LIMIT_REASON });
  expect(await storedProducts(sql, organizationId, extra)).toEqual([]);
  expect(await variantCount(sql, organizationId)).toBe(FREE_LIMIT);
});
