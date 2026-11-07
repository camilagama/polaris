import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import {
  confirmSale,
  fillSale,
  type SaleLineInput,
  termValue,
} from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const FIRST_STEPS_KEY = "polaris.home.firstSteps";
const FIRST_SALE_LINE =
  "1ª venda registrada. Veja o Hoje no Início e o resultado estimado em Resultado.";
const CANDLE = /Vela aromática/;
const EXPENSES_TAB_URL = /\/dashboard\?aba=despesas$/;
const SALE_URL = /\/sales$/;
const EMPTY_PERIOD = /^Sem vendas nem despesas em /;

const LINE: SaleLineInput = {
  charged: "45,00",
  option: CANDLE,
  quantity: 1,
  search: "Vela",
};

/**
 * Journey of the first sale and the empty Resultado (corte primeira-venda-e-resultado-vazio, AC-1, AC-4, AC-5): the line
 * of the first sale is in the panel of the sale the server confirms while this tab knows the store never sold, with its
 * two links, and not in the next one; a period with nothing in it offers a new sale and a new expense.
 */
test("primeira venda: a linha com os dois links aparece na 1ª venda confirmada e não na 2ª", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "primeira-venda", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const candle = await seedProduct(
    rpc,
    organizationId,
    "Vela aromática",
    "45.00"
  );
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    5,
    "12.00",
    localDate(runT0(), ZONE)
  );

  // the Início reads the steps of a store that never sold and keeps them in this tab
  await page.goto("/");
  await expect
    .poll(async () =>
      page.evaluate((key) => {
        const kept = sessionStorage.getItem(key);
        return kept === null
          ? null
          : (JSON.parse(kept) as { done: number }).done;
      }, FIRST_STEPS_KEY)
    )
    .toBe(2);

  await page.goto("/sales");
  await fillSale(page, [LINE], []);
  const first = await confirmSale(page);
  await expect(first).toContainText(FIRST_SALE_LINE);
  const toHome = first.getByRole("link", { name: "Ver o Início" });
  const toResult = first.getByRole("link", { name: "Ver o Resultado" });
  await expect(toHome).toHaveAttribute("href", "/");
  await expect(toResult).toHaveAttribute("href", "/dashboard");
  await expect(toHome).not.toBeFocused();
  await expect(toResult).not.toBeFocused();
  const firstId = await termValue(first, "Venda").innerText();
  // the form started over: the second sale, confirmed by the same server, has no line
  await fillSale(page, [LINE], []);
  const second = await confirmSale(page);
  await expect(termValue(second, "Venda")).not.toHaveText(firstId);
  await expect(second).not.toContainText("1ª venda registrada");
  await expect(page.getByRole("link", { name: "Ver o Início" })).toHaveCount(0);

  // a page loaded again keeps no panel, so no line
  await page.goto("/sales");
  await expect(page.getByRole("link", { name: "Ver o Início" })).toHaveCount(0);
});

test("resultado vazio: Nova venda leva à Venda e Nova despesa à aba Despesas", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "resultado-vazio", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;

  await page.goto("/dashboard");
  await expect(page.getByText(EMPTY_PERIOD)).toBeVisible();
  await page.getByRole("link", { exact: true, name: "Nova despesa" }).click();
  await expect(page).toHaveURL(EXPENSES_TAB_URL);
  await expect(page.getByRole("tab", { name: "Despesas" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await page.goto("/dashboard");
  await page.getByRole("link", { exact: true, name: "Nova venda" }).click();
  await expect(page).toHaveURL(SALE_URL);
  await expect(page.getByRole("form", { name: "Nova venda" })).toBeVisible();
});
