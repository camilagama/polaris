import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const MUG_LINK = /^Caneca esmaltada, Variante padrão\. Abrir o produto$/;
const SEE_STOCK = /^Ver estoque$/;

/**
 * Estoque → produto → "Ver estoque" → the row of the product, with and without a connection: the name of the row opens
 * the product and the footer of the product opens the stock with the search already holding its name.
 */
test("estoque e produto se ligam: ida e volta, com conexão e sem conexão", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(120_000);
  const journey = await openJourney(browser, testInfo, "estoque-produto", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const mug = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Caneca esmaltada",
    "35.00"
  );
  await seedProduct(journey.user.rpc, organizationId, "Camiseta básica");
  await seedStock(
    journey.user.rpc,
    organizationId,
    mug.variantId,
    4,
    "12.00",
    localDate(runT0(), ZONE)
  );
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );

  const rows = page
    .getByRole("list", { name: "Saldos por variante" })
    .getByRole("listitem");
  const goAndBack = async () => {
    await page.getByRole("link", { name: MUG_LINK }).click();
    const dialog = page.getByRole("dialog", { name: "Caneca esmaltada" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("link", { name: SEE_STOCK }).click();
    await expect(
      page.getByRole("heading", { exact: true, level: 1, name: "Estoque" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Buscar no estoque")).toHaveValue(
      "Caneca esmaltada"
    );
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.first()).toContainText("Caneca esmaltada");
  };

  await page.goto("/inventory");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await goAndBack();

  await page.goto("/sales");
  await expect(
    page.getByRole("status").filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  await page.context().setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Sem conexão" })
  ).toBeVisible({ timeout: 15_000 });
  await page.goto("/inventory");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await goAndBack();
});
