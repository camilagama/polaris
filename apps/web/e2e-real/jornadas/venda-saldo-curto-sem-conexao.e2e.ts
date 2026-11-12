import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { movements, queuedCommands } from "../pages/fila-e-estoque";
import { fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const MUG = /Caneca esmaltada/;
const ENTRY_LINK = /^Dar entrada no estoque/;
const ZONE = "America/Sao_Paulo";

/** The same path with no connection: the variant is read from the device and still nothing is queued by opening. */
test("venda com saldo curto sem conexão: o link abre a entrada com a quantidade que falta e a fila fica vazia", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(90_000);
  const journey = await openJourney(
    browser,
    testInfo,
    "venda-saldo-curto-sem-conexao",
    { organization: { timezone: ZONE } }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Caneca esmaltada",
    "35.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    product.variantId,
    1,
    "12.00",
    localDate(runT0(), ZONE)
  );
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );

  await page.goto("/sales");
  await expect(
    page.getByRole("status").filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  await page.context().setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Sem conexão" })
  ).toBeVisible({ timeout: 15_000 });
  await fillSale(
    page,
    [{ charged: "35,00", option: MUG, quantity: 3, search: "Caneca" }],
    []
  );
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await expect(item).toContainText("Acima do saldo (1)");
  await item.getByRole("link", { name: ENTRY_LINK }).click();

  await expect(
    page.getByRole("heading", { name: "Receber estoque" })
  ).toBeVisible();
  await expect(page.getByLabel("Quantidade recebida")).toHaveValue("2");
  expect(new URL(page.url()).search).toBe("");
  expect(await queuedCommands(page)).toBe(0);
  expect(await movements(sql, product.variantId)).toBe(1);
});
