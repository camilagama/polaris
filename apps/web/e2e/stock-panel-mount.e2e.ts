/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * A panel opened on a row that a search takes out of the list is not drawn, so it must not leave the buttons of the
 * rows still on screen off: they would read a reason that is nowhere on the page. When the search is cleared the row
 * and its panel come back, and the other rows go back off.
 */
const PANEL_OPEN_REASON = "Feche o painel aberto para usar os botões.";

const SHIRT = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: "0199c2d0-0000-7000-8000-0000000000f1",
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "CAM-AZ-M",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "cor", optionValueName: "Azul" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  version: 1,
};
const JEANS = {
  ...SHIRT,
  movingAverageCost: "62.400000",
  productId: "0199c2d0-0000-7000-8000-0000000000f3",
  productName: "Calça jeans",
  quantity: 3,
  sku: null,
  values: [{ optionName: "tamanho", optionValueName: "42" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b3",
};

const RECEIVE_JEANS = "Receber estoque de Calça jeans, 42";
const RECEIVE_SHIRT = "Receber estoque de Camiseta do teste, Azul";
const WRITE_OFF_SHIRT = "Baixar estoque de Camiseta do teste, Azul";
const INFORM_SHIRT = "Informar custo de Camiseta do teste, Azul";

const searchedText = (body: string): string => {
  const parsed: unknown = JSON.parse(body);
  const json =
    typeof parsed === "object" && parsed !== null && "json" in parsed
      ? parsed.json
      : null;
  return typeof json === "object" &&
    json !== null &&
    "query" in json &&
    typeof json.query === "string"
    ? json.query
    : "";
};

async function openStockLab(page: Page) {
  await page.route("**/rpc/inventory/listBalances", (route) => {
    const query = searchedText(route.request().postData() ?? "{}")
      .trim()
      .toLowerCase();
    const entries = [SHIRT, JEANS].filter((entry) =>
      entry.productName.toLowerCase().includes(query)
    );
    return route.fulfill({
      body: JSON.stringify({ json: { entries, nextCursor: null }, meta: [] }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=stock");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Estoque" })
  ).toBeVisible();
  await expect(page.getByText("2 variantes", { exact: true })).toBeVisible();
}

const REASON_ID = "stock-panel-open-reason";

const shirtButtons = (page: Page) =>
  [RECEIVE_SHIRT, WRITE_OFF_SHIRT, INFORM_SHIRT].map((name) =>
    page.getByRole("button", { exact: true, name })
  );

async function expectShirtButtonsOff(page: Page, off: boolean) {
  await Promise.all(
    shirtButtons(page).map(async (button) => {
      await expect(button).toBeVisible();
      if (off) {
        await expect(button).toHaveAttribute("aria-disabled", "true");
        await expect(button).toHaveAttribute("aria-describedby", REASON_ID);
      } else {
        await expect(button).not.toHaveAttribute("aria-disabled", "true");
        await expect(button).not.toHaveAttribute("aria-describedby", REASON_ID);
      }
    })
  );
}

test("o painel aberto numa linha que a busca tira da lista não deixa os botões das outras desligados", async ({
  page,
}) => {
  await openStockLab(page);

  await page.getByRole("button", { name: RECEIVE_JEANS }).click();
  await expect(page.getByLabel("Quantidade recebida")).toBeFocused();
  await expect(page.getByText(PANEL_OPEN_REASON)).toBeVisible();
  await expectShirtButtonsOff(page, true);

  await page
    .getByRole("searchbox", { name: "Buscar no estoque" })
    .fill("camiseta");
  await expect(page.getByText("1 variante", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: RECEIVE_JEANS })).toHaveCount(
    0
  );
  await expect(page.getByLabel("Quantidade recebida")).toHaveCount(0);
  await expect(page.getByText(PANEL_OPEN_REASON)).toHaveCount(0);
  await expectShirtButtonsOff(page, false);

  await page.getByRole("button", { name: "Limpar busca" }).click();
  await expect(page.getByText("2 variantes", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Quantidade recebida")).toBeVisible();
  await expect(page.getByText(PANEL_OPEN_REASON)).toBeVisible();
  await expectShirtButtonsOff(page, true);
});
