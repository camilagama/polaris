/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { setBrowserFont } from "./sale-item-geometry";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * Swapping the variant of a line in the sale takes the prices of the new variant, unless the operator typed one of
 * them on that line: then both stay and a note says so. The lab offers Azul (list price 50,00) and Vermelha (10,00).
 */
const AZUL = /Camiseta do laboratório · Azul/;
const VERMELHA = /Camiseta do laboratório · Vermelha/;
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const AZUL_ID = "0199c2d0-0000-7000-8000-0000000000b1";
const KEPT_NOTICE = "Preço cobrado mantido da variante anterior.";
const SUGGESTION_NOTICE = /Preços sugeridos pela última venda/;
const PRICE_10 = /10,00/;
const PRICE_45 = /45,00/;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openSale(page: Page, fontPixels = 16) {
  await setBrowserFont(page, fontPixels);
  await page.addInitScript(
    ([key, variant]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({
          [variant as string]: {
            charged: "49.90",
            listed: "49.90",
            on: "2026-10-01",
          },
        })
      );
    },
    [`polaris.sale.lastPrices.v1:${ORGANIZATION}`, AZUL_ID]
  );
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: AZUL }).click();
  await expect(item.getByLabel("Preço cobrado")).toHaveValue("49,90");
  return item;
}

async function swapToRed(page: Page, item: Locator) {
  await item
    .getByRole("button", {
      name: "Trocar variante de Camiseta do laboratório · Azul",
    })
    .click();
  await item
    .getByRole("combobox", { name: "Produto ou variante" })
    .fill("vermelha");
  await page.getByRole("option", { name: VERMELHA }).click();
  await expect(
    item.getByText("Camiseta do laboratório · Vermelha", { exact: true })
  ).toBeVisible();
}

const summaryOf = (page: Page) =>
  page.getByRole("complementary", { name: "Resumo" });

test("trocar a variante sem editar preço leva o preço da variante nova, no item e no Resumo", async ({
  page,
}) => {
  const item = await openSale(page);
  await expect(summaryOf(page)).not.toContainText(PRICE_10);
  await swapToRed(page, item);
  await expect(item.getByLabel("Preço cobrado")).toHaveValue("10,00");
  await expect(item.getByLabel("Preço de tabela")).toHaveValue("10,00");
  await expect(item.getByRole("note")).toHaveCount(0);
  await expect(summaryOf(page)).toContainText(PRICE_10);
});

test("trocar a variante com o preço cobrado editado mantém os dois preços e avisa", async ({
  page,
}) => {
  const item = await openSale(page);
  await item.getByLabel("Preço cobrado").fill("45,00");
  await swapToRed(page, item);
  await expect(item.getByLabel("Preço cobrado")).toHaveValue("45,00");
  await expect(item.getByLabel("Preço de tabela")).toHaveValue("49,90");
  await expect(item.getByRole("note")).toContainText(KEPT_NOTICE);
  await expect(summaryOf(page)).toContainText(PRICE_45);
  await expect(summaryOf(page)).not.toContainText(PRICE_10);

  await item.getByLabel("Preço cobrado").fill("44,00");
  await expect(item.getByText(KEPT_NOTICE)).toHaveCount(0);
});

test("trocar com só o preço de tabela editado também mantém os dois", async ({
  page,
}) => {
  const item = await openSale(page);
  await item.getByLabel("Preço de tabela").fill("55,00");
  await swapToRed(page, item);
  await expect(item.getByLabel("Preço cobrado")).toHaveValue("49,90");
  await expect(item.getByLabel("Preço de tabela")).toHaveValue("55,00");
  await expect(item.getByRole("note")).toContainText(KEPT_NOTICE);
});

test("cancelar a troca deixa a linha e as dicas como estavam", async ({
  page,
}) => {
  const item = await openSale(page);
  await item
    .getByRole("button", {
      name: "Trocar variante de Camiseta do laboratório · Azul",
    })
    .click();
  await item
    .getByRole("combobox", { name: "Produto ou variante" })
    .press("Escape");
  await expect(item.getByLabel("Preço cobrado")).toHaveValue("49,90");
  await expect(item.getByRole("note")).toContainText(SUGGESTION_NOTICE);
});

test("o aviso cabe a 320 px com letra de 20 px e não corta nem rola a página", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 320 });
  const item = await openSale(page, 20);
  await item.getByLabel("Preço cobrado").fill("45,00");
  await swapToRed(page, item);
  const note = item.getByRole("note");
  await expect(note).toContainText(KEPT_NOTICE);
  await note.scrollIntoViewIfNeeded();
  const box = await note.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  expect(
    await note.evaluate((node) => node.scrollWidth <= node.clientWidth)
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
