import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { openSaleAction } from "../pages/detalhe-da-venda";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const DELETED_NOTICE = "Produto “Garrafa térmica” excluído.";
const RETURN_REGISTERED = /^Devolução registrada: 1 unidade no total/;
const RETURNED_BOTTLE = /^Devolvido: Garrafa térmica/;
const RESTOCKED_BOTTLE = /^Volta ao estoque: Garrafa térmica/;
const MORE_ACTIONS = /^Mais ações/;
const NAME_FIELD = "Digite o nome do produto para confirmar";
const RETURN_REFUSED = /removido.*não podem voltar ao estoque/;
const BOTTLE_STOCK = 4;
const RESTOCKED_QUANTITY = 1;
const KEPT_QUANTITY = 3;
const CANCELLED_QUANTITY = 1;
const CANCEL_DONE =
  /^Venda cancelada\. Nenhum item voltou ao estoque, porque os produtos desta venda foram removidos\.$/;

/**
 * Excluir produto arquivado, na pilha de verdade: o produto arquivado e sem estoque sai da lista e a vaga volta; as vendas
 * antigas continuam no Histórico, abrem com o nome guardado e aceitam cancelamento e devolução; "Mais vendidos" mostra o
 * excluído sem link; o arquivado com saldo é recusado e fica como estava.
 */
test("excluir produto arquivado: sai da lista, libera a vaga, a venda antiga segue e o de saldo é recusado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "excluir-arquivado", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);

  const bottle = await seedProduct(
    rpc,
    organizationId,
    "Garrafa térmica",
    "45.90"
  );
  const mug = await seedProduct(
    rpc,
    organizationId,
    "Caneca esmaltada",
    "19.90"
  );
  await seedStock(
    rpc,
    organizationId,
    bottle.variantId,
    BOTTLE_STOCK,
    "20.00",
    today
  );
  await seedStock(rpc, organizationId, mug.variantId, 3, "8.00", today);
  const saleId = await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.90", quantity: KEPT_QUANTITY, variantId: bottle.variantId }],
    new Date(runT0()).toISOString()
  );
  const cancelledSaleId = await seedCashSale(
    rpc,
    organizationId,
    [
      {
        price: "45.90",
        quantity: CANCELLED_QUANTITY,
        variantId: bottle.variantId,
      },
    ],
    new Date(runT0()).toISOString()
  );
  const liveVariants = async () =>
    (
      await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM product_variants v
           JOIN products p ON p.id = v.product_id
          WHERE p.organization_id = $1 AND p.deleted_at IS NULL`,
        [organizationId]
      )
    ).rows[0]?.n;
  expect(await liveVariants()).toBe(2);
  const cancellationRecords = async () =>
    (
      await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM sale_cancellations WHERE sale_id = $1",
        [cancelledSaleId]
      )
    ).rows[0]?.n;
  const bottleStock = async () =>
    (
      await sql.query<{
        balance: number;
        cancellations: number;
        returns: number;
      }>(
        `SELECT (SELECT quantity::int FROM inventory_balances WHERE variant_id = $1) AS balance,
                (SELECT count(*)::int FROM stock_movements
                  WHERE variant_id = $1 AND movement_type = 'sale_cancellation') AS cancellations,
                (SELECT count(*)::int FROM stock_movements
                  WHERE variant_id = $1 AND movement_type = 'sale_return') AS returns`,
        [bottle.variantId]
      )
    ).rows[0];
  const returnedQuantity = async () =>
    (
      await sql.query<{ returned: number | null }>(
        "SELECT sum(returned_quantity)::int AS returned FROM sale_return_items WHERE sale_id = $1",
        [saleId]
      )
    ).rows[0]?.returned;
  const stockAfterSales = BOTTLE_STOCK - KEPT_QUANTITY - CANCELLED_QUANTITY;
  expect(await bottleStock()).toEqual({
    balance: stockAfterSales,
    cancellations: 0,
    returns: 0,
  });

  await page.goto("/products");
  const rowOf = (name: string) =>
    page.locator("[data-product-id]", { hasText: name });
  await rowOf("Garrafa térmica")
    .getByRole("button", { name: MORE_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(
    page.getByText("Produto “Garrafa térmica” arquivado.")
  ).toBeVisible();
  await rpc.product.archive({
    expectedVersion: (
      await rpc.product.list({ organizationId, status: "active" })
    ).products.find((item) => item.id === mug.productId)?.version as number,
    id: mug.productId,
    organizationId,
  });
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await expect(rowOf("Caneca esmaltada")).toBeVisible();
  await expect(rowOf("Garrafa térmica")).toBeVisible();

  // com saldo: recusado, nada some
  await rowOf("Caneca esmaltada")
    .getByRole("button", { name: MORE_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: "Excluir…" }).click();
  let dialog = page.getByRole("dialog", {
    name: "Excluir produto “Caneca esmaltada”?",
  });
  await dialog.getByLabel(NAME_FIELD).fill("caneca  ESMALTADA");
  await dialog.getByRole("button", { name: "Excluir produto" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "porque ele ainda tem 3 em estoque."
  );
  await page.keyboard.press("Escape");
  await expect(rowOf("Caneca esmaltada")).toBeVisible();
  expect(await liveVariants()).toBe(2);

  // sem saldo: sai da lista e a vaga volta
  await rowOf("Garrafa térmica")
    .getByRole("button", { name: MORE_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: "Excluir…" }).click();
  dialog = page.getByRole("dialog", {
    name: "Excluir produto “Garrafa térmica”?",
  });
  await expect(dialog).toContainText(
    "Este produto libera 1 variante do seu plano."
  );
  await dialog.getByLabel(NAME_FIELD).fill("Garrafa térmica");
  await dialog.getByRole("button", { name: "Excluir produto" }).click();
  await expect(page.getByText(DELETED_NOTICE)).toBeVisible();
  await expect(rowOf("Garrafa térmica")).toHaveCount(0);
  await expect.poll(liveVariants).toBe(1);

  // o Histórico segue listando as vendas do produto excluído; a venda abre com o nome guardado e aceita cancelamento
  await page.goto("/sales/history");
  const sales = page.getByRole("list", {
    exact: true,
    name: "Vendas do período",
  });
  await expect(sales.getByRole("listitem")).toHaveCount(2);
  const saleLink = (id: string) =>
    sales.locator(`a[href="/sales/detail?saleId=${id}"]`);
  await expect(saleLink(saleId)).toContainText("Confirmada");
  await expect(saleLink(cancelledSaleId)).toContainText("Confirmada");
  await saleLink(cancelledSaleId).click();
  await expect(page).toHaveURL(new RegExp(`saleId=${cancelledSaleId}`));
  await expect(page.getByText("Garrafa térmica").first()).toBeVisible();
  await openSaleAction(page, "Cancelar venda");
  const cancelPanel = page.getByRole("dialog", { name: "Cancelar venda" });
  await cancelPanel
    .getByRole("button", { name: "Revisar cancelamento" })
    .click();
  await cancelPanel
    .getByRole("button", { name: "Confirmar cancelamento" })
    .click();
  await expect(page.getByText(CANCEL_DONE)).toBeVisible();
  // produto excluído tem saldo congelado: o cancelamento fica registrado e nenhuma unidade volta ao saldo
  expect(await cancellationRecords()).toBe(1);
  expect(await bottleStock()).toEqual({
    balance: stockAfterSales,
    cancellations: 0,
    returns: 0,
  });
  await page.goto("/sales/history");
  await expect(saleLink(cancelledSaleId)).toContainText("Cancelada");
  await expect(saleLink(saleId)).toContainText("Confirmada");

  // a venda antiga abre com o nome de quando foi vendida e aceita devolução
  await page.goto(`/sales/detail?saleId=${saleId}`);
  await expect(page.getByText("Garrafa térmica").first()).toBeVisible();
  await openSaleAction(page, "Registrar devolução");
  const panel = page.getByRole("dialog", { name: "Registrar devolução" });
  await panel.getByLabel(RETURNED_BOTTLE).fill("1");
  // o produto saiu do catálogo: tentar devolver 1 unidade ao estoque é recusado e nada é gravado
  await panel.getByLabel(RESTOCKED_BOTTLE).fill(String(RESTOCKED_QUANTITY));
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(panel.getByRole("alert")).toContainText(RETURN_REFUSED);
  await expect(page.getByText(RETURN_REGISTERED)).toHaveCount(0);
  expect(await returnedQuantity()).toBeNull();
  expect(await bottleStock()).toEqual({
    balance: stockAfterSales,
    cancellations: 0,
    returns: 0,
  });
  await panel.getByLabel(RESTOCKED_BOTTLE).fill("0");
  await panel.getByRole("button", { name: "Revisar devolução" }).click();
  await panel.getByRole("button", { name: "Confirmar devolução" }).click();
  await expect(page.getByText(RETURN_REGISTERED)).toBeVisible();
  expect(await returnedQuantity()).toBe(1);
  expect(
    (
      await sql.query<{ restocked: number }>(
        "SELECT sum(restocked_quantity)::int AS restocked FROM sale_return_items WHERE sale_id = $1",
        [saleId]
      )
    ).rows[0]?.restocked
  ).toBe(0);
  expect(await bottleStock()).toEqual({
    balance: stockAfterSales,
    cancellations: 0,
    returns: 0,
  });

  // Mais vendidos mostra o produto excluído pelo nome guardado, sem link para um painel que não existe mais
  await page.goto("/");
  const ranking = page.getByRole("region", { name: "Mais vendidos do mês" });
  await expect(ranking).toContainText("Garrafa térmica");
  await expect(ranking.getByRole("listitem")).toHaveCount(1);
  await expect(ranking).toContainText("2 un.");
  await expect(ranking.getByRole("listitem").getByRole("link")).toHaveCount(0);
  await expect(
    ranking.getByRole("link", { name: "Ver os produtos" })
  ).toHaveAttribute("href", "/products");
});

interface Refusal {
  code: string;
  reason: unknown;
}

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(call: Promise<unknown>): Promise<Refusal> {
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

interface ProductState {
  archived: boolean;
  categoryId: string | null;
  deleted: boolean;
  id: string;
  version: number;
}

/** The lifecycle events the audit holds for one product, by type. */
type ProductAudit = Record<
  "product.archived" | "product.deleted" | "product.restored",
  number
>;

const ANY_ROW = "[data-product-id]";

/**
 * Archiving and restoring by the screen: the same row (id) goes out of "Ativos" and back, each transition raises the
 * version by one and writes one audit event; the archived product is not offered by the sale search and its old sale
 * stays in the history; archiving what is already archived changes nothing.
 */
test("produto: arquivar e restaurar pela tela mantêm o id, sobem a versão, saem e voltam na Nova venda; repetir não muda nada", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "ciclo-vida-produto", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const archivedName = `Garrafa ${journey.name} arquivada`;
  const controlName = `Garrafa ${journey.name} ativa`;

  const subject = await seedProduct(rpc, organizationId, archivedName, "45.90");
  const control = await seedProduct(rpc, organizationId, controlName, "19.90");
  await seedStock(rpc, organizationId, subject.variantId, 4, "20.00", today);
  await seedStock(rpc, organizationId, control.variantId, 4, "8.00", today);
  const saleId = await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.90", quantity: 1, variantId: subject.variantId }],
    new Date(runT0()).toISOString()
  );

  const stateOf = async (): Promise<ProductState> => {
    const { rows } = await sql.query<ProductState>(
      `SELECT id, version, category_id AS "categoryId",
              archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted
         FROM products WHERE id = $1`,
      [subject.productId]
    );
    return rows[0] as ProductState;
  };
  const auditOf = async (): Promise<ProductAudit> => {
    const { rows } = await sql.query<{
      event_type: keyof ProductAudit;
      n: number;
    }>(
      `SELECT event_type, count(*)::int AS n FROM tenant_audit_event
        WHERE organization_id = $1 AND entity_type = 'product' AND entity_id = $2
          AND event_type IN ('product.archived', 'product.restored', 'product.deleted')
        GROUP BY event_type`,
      [organizationId, subject.productId]
    );
    const audit: ProductAudit = {
      "product.archived": 0,
      "product.deleted": 0,
      "product.restored": 0,
    };
    for (const row of rows) {
      audit[row.event_type] = row.n;
    }
    return audit;
  };

  const first = await stateOf();
  expect(first).toMatchObject({ archived: false, deleted: false });
  expect(await auditOf()).toEqual({
    "product.archived": 0,
    "product.deleted": 0,
    "product.restored": 0,
  });

  await page.goto("/products");
  const rowOf = (name: string) => page.locator(ANY_ROW, { hasText: name });
  await expect(rowOf(archivedName)).toBeVisible({ timeout: 30_000 });
  await rowOf(archivedName).getByRole("button", { name: MORE_ACTIONS }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(
    page.getByText(`Produto “${archivedName}” arquivado.`)
  ).toBeVisible();
  await expect(rowOf(archivedName)).toHaveCount(0);
  await expect(rowOf(controlName)).toBeVisible();
  await expect
    .poll(stateOf)
    .toEqual({ ...first, archived: true, version: first.version + 1 });
  expect(await auditOf()).toEqual({
    "product.archived": 1,
    "product.deleted": 0,
    "product.restored": 0,
  });
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await expect(rowOf(archivedName)).toBeVisible();
  await expect(rowOf(controlName)).toHaveCount(0);

  // outside the sale: the search offers the active product of the same prefix and not the archived one
  const searchSale = async () => {
    await page.goto("/sales");
    const item = page.getByRole("group", { exact: true, name: "Item 1" });
    await item
      .getByLabel("Produto ou variante")
      .fill(`Garrafa ${journey.name}`);
    const listbox = page.getByRole("listbox", {
      name: "Variantes encontradas",
    });
    await expect(
      listbox.getByRole("option", { name: new RegExp(controlName) })
    ).toBeVisible();
    return listbox.getByRole("option", { name: new RegExp(archivedName) });
  };
  await expect(await searchSale()).toHaveCount(0);

  // a sale of the archived product stays in the history, with its name
  await page.goto("/sales/history");
  const sales = page.getByRole("list", {
    exact: true,
    name: "Vendas do período",
  });
  const saleLink = sales.locator(`a[href="/sales/detail?saleId=${saleId}"]`);
  await expect(saleLink).toContainText("Confirmada");
  await saleLink.click();
  await expect(page).toHaveURL(new RegExp(`saleId=${saleId}`));
  await expect(page.getByText(archivedName).first()).toBeVisible();

  // archiving what is archived changes nothing: same version, no second audit row
  const archivedVersion = (await stateOf()).version;
  const again = await rpc.product.archive({
    expectedVersion: archivedVersion,
    id: subject.productId,
    organizationId,
  });
  expect(again.changed).toBe(false);
  expect(await stateOf()).toEqual({
    ...first,
    archived: true,
    version: archivedVersion,
  });
  expect(await auditOf()).toEqual({
    "product.archived": 1,
    "product.deleted": 0,
    "product.restored": 0,
  });

  // restoring brings the same row back, one more version, and the sale offers it again
  await page.goto("/products");
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await rowOf(archivedName).getByRole("button", { name: MORE_ACTIONS }).click();
  await page.getByRole("menuitem", { name: "Restaurar" }).click();
  await expect(
    page.getByText(`Produto “${archivedName}” restaurado.`)
  ).toBeVisible();
  await expect(rowOf(archivedName)).toHaveCount(0);
  await expect
    .poll(stateOf)
    .toEqual({ ...first, archived: false, version: first.version + 2 });
  expect(await auditOf()).toEqual({
    "product.archived": 1,
    "product.deleted": 0,
    "product.restored": 1,
  });
  await page.getByRole("tab", { name: "Ativos" }).click();
  await expect(rowOf(archivedName)).toBeVisible();
  await expect(await searchSale()).toBeVisible();
});

/** Deleting an active product is refused by the server and the screen offers "Excluir…" only for an archived one. */
test("produto ativo não se exclui: o servidor recusa com product_lifecycle_conflict e a tela só oferece Excluir no arquivado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "excluir-ativo", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const name = `Caneca ${journey.name}`;
  const subject = await seedProduct(rpc, organizationId, name, "19.90");

  const rowState = async () =>
    (
      await sql.query<{
        deleted: boolean;
        events: number;
        version: number;
      }>(
        `SELECT p.version, p.deleted_at IS NOT NULL AS deleted,
                (SELECT count(*)::int FROM tenant_audit_event
                  WHERE organization_id = $1 AND entity_id = $2::text AND event_type = 'product.deleted') AS events
           FROM products p WHERE p.id = $2::uuid`,
        [organizationId, subject.productId]
      )
    ).rows[0];
  const before = await rowState();
  expect(before).toMatchObject({ deleted: false, events: 0 });

  const refused = await refusal(
    rpc.product.delete({
      expectedVersion: before?.version as number,
      id: subject.productId,
      organizationId,
    })
  );
  expect(refused).toEqual({
    code: "CONFLICT",
    reason: "product_lifecycle_conflict",
  });
  expect(await rowState()).toEqual(before);

  await page.goto("/products");
  const row = page.locator(ANY_ROW, { hasText: name });
  await row.getByRole("button", { name: MORE_ACTIONS }).click();
  await expect(page.getByRole("menuitem", { name: "Arquivar" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Excluir…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Arquivar" })).toBeHidden();

  await row.getByRole("button", { name: MORE_ACTIONS }).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(page.getByText(`Produto “${name}” arquivado.`)).toBeVisible();
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await row.getByRole("button", { name: MORE_ACTIONS }).click();
  await expect(page.getByRole("menuitem", { name: "Excluir…" })).toBeVisible();
});

/**
 * Archiving a category keeps the link of the products that already have it, and no new product can pick it: the
 * selector does not list it and the server refuses the assignment without saving anything.
 */
test("categoria arquivada: o produto mantém o vínculo e nenhum produto novo pode escolhê-la", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "categoria-arquivada", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const archivedCategory = `Antiga ${journey.name}`;
  const activeCategory = `Vigente ${journey.name}`;
  const linkedName = `Linkado ${journey.name}`;
  const newName = `Novo ${journey.name}`;
  const refusedName = `Recusado ${journey.name}`;

  const category = await rpc.category.create({
    name: archivedCategory,
    organizationId,
  });
  await rpc.category.create({ name: activeCategory, organizationId });
  const linked = await rpc.product.create({
    categoryId: category.id,
    name: linkedName,
    organizationId,
  });
  const linkedCategory = async () =>
    (
      await sql.query<{ category_id: string | null }>(
        "SELECT category_id FROM products WHERE id = $1",
        [linked.id]
      )
    ).rows[0]?.category_id;
  const productsNamed = async (name: string) =>
    (
      await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM products WHERE organization_id = $1 AND name = $2",
        [organizationId, name]
      )
    ).rows[0]?.n;
  expect(await linkedCategory()).toBe(category.id);

  await rpc.category.archive({ id: category.id, organizationId });
  await expect
    .poll(
      async () =>
        (
          await sql.query<{ archived: boolean }>(
            "SELECT archived_at IS NOT NULL AS archived FROM categories WHERE id = $1",
            [category.id]
          )
        ).rows[0]?.archived
    )
    .toBe(true);
  expect(await linkedCategory()).toBe(category.id);

  await page.goto("/products");
  const linkedRow = page.locator(ANY_ROW, { hasText: linkedName });
  await expect(linkedRow).toBeVisible({ timeout: 30_000 });
  await expect(linkedRow).toContainText(archivedCategory);

  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill(newName);
  await page.getByRole("button", { name: "Mais detalhes" }).click();
  await page.getByRole("combobox", { exact: true, name: "Categoria" }).click();
  await expect(
    page.getByRole("option", { exact: true, name: activeCategory })
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: new RegExp(archivedCategory) })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const refused = await refusal(
    rpc.product.create({
      categoryId: category.id,
      name: refusedName,
      organizationId,
    })
  );
  expect(refused).toEqual({
    code: "CONFLICT",
    reason: "product_category_unavailable",
  });
  expect(await productsNamed(refusedName)).toBe(0);
  expect(await linkedCategory()).toBe(category.id);
});
