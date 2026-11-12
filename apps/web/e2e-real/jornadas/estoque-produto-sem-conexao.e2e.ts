import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { openMugAndSeeItsStock, stockRows } from "../pages/estoque-e-produto";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";

/** The same round trip with no connection: both screens read the device's copy and the links load nothing. */
test("estoque e produto se ligam: ida e volta sem conexão", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(90_000);
  const journey = await openJourney(
    browser,
    testInfo,
    "estoque-produto-sem-conexao",
    { organization: { timezone: ZONE } }
  );
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

  await page.goto("/inventory");
  await expect(stockRows(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByRole("status").filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: 30_000 });
  await page.context().setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Sem conexão" }).first()
  ).toBeVisible({ timeout: 15_000 });
  await openMugAndSeeItsStock(page);
});
