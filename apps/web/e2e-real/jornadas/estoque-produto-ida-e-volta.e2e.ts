import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { openMugAndSeeItsStock, stockRows } from "../pages/estoque-e-produto";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";

/**
 * Estoque → produto → "Ver estoque" → the row of the product: the name of the row opens the product and the footer of
 * the product opens the stock with the search already holding its name.
 */
test("estoque e produto se ligam: ida e volta com conexão", async ({
  browser,
}, testInfo) => {
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

  await page.goto("/inventory");
  await expect(stockRows(page)).toHaveCount(2, { timeout: 30_000 });
  await openMugAndSeeItsStock(page);
});
