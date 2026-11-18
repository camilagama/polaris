import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
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
  const sales = page.getByRole("list", { name: "Vendas" });
  await expect(sales.getByRole("listitem")).toHaveCount(2);
  const saleLink = (id: string) =>
    sales.locator(`a[href="/sales/detail?saleId=${id}"]`);
  await expect(saleLink(saleId)).toContainText("Confirmada");
  await expect(saleLink(cancelledSaleId)).toContainText("Confirmada");
  await saleLink(cancelledSaleId).click();
  await expect(page).toHaveURL(new RegExp(`saleId=${cancelledSaleId}`));
  await expect(page.getByText("Garrafa térmica").first()).toBeVisible();
  const cancelPanel = page.getByRole("region", { name: "Cancelar venda" });
  await cancelPanel.getByRole("button", { name: "Cancelar venda" }).click();
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
  await page
    .getByRole("region", { name: "Devolução" })
    .getByRole("button", { name: "Registrar devolução" })
    .click();
  const panel = page.getByRole("region", { name: "Registrar devolução" });
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
  await expect(ranking.getByRole("link")).toHaveCount(0);
});
