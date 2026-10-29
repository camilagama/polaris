/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { historyStates } from "./ui-history-states";

/**
 * The line of a sale in the history, "cliente · forma de pagamento · itens": with a connection the row is a link
 * that ends in a chevron, and a long customer name takes at most two lines at 360 px; without a connection the row
 * is plain text, with no link and no chevron.
 */
const LONG_NAME =
  "Maria Aparecida da Conceição Albuquerque de Oliveira Santos Filho";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { height: 740, width: 360 },
});

test("com conexão, o nome longo do cliente não passa de 2 linhas a 360 px e a linha termina no chevron", async ({
  page,
}) => {
  await historyStates.list(page);
  const row = page.getByRole("link").filter({ hasText: LONG_NAME });
  const support = row.getByText(`${LONG_NAME} · Cartão de crédito · 2 itens`);
  await expect(support).toBeVisible();
  const measured = await support.evaluate((element) => {
    const height = Number.parseFloat(getComputedStyle(element).lineHeight);
    return {
      height,
      lines: element.getBoundingClientRect().height / height,
    };
  });
  expect(measured.height).toBeGreaterThan(0);
  expect(measured.lines).toBeGreaterThan(1.5);
  expect(measured.lines).toBeLessThanOrEqual(2.05);
  await expect(row.locator("svg[aria-hidden='true']").last()).toBeVisible();
  const rowBox = await row.boundingBox();
  const supportBox = await support.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(supportBox).not.toBeNull();
  expect((supportBox?.x ?? 0) + (supportBox?.width ?? 0)).toBeLessThanOrEqual(
    (rowBox?.x ?? 0) + (rowBox?.width ?? 0)
  );
});

test("sem cliente, a linha diz 'Sem cliente' sem o prefixo 'Cliente:'", async ({
  page,
}) => {
  await historyStates.list(page);
  await expect(page.getByText("Sem cliente · Dinheiro · 1 item")).toBeVisible();
  await expect(page.getByText("Cliente: ")).toHaveCount(0);
  await expect(
    page.getByText("Da mais recente para a mais antiga")
  ).toHaveCount(0);
});

test("sem conexão, a linha é só texto: sem link e sem chevron", async ({
  page,
}) => {
  await historyStates.offline(page);
  const rows = page.getByRole("list", { name: "Vendas" }).getByRole("listitem");
  await expect(rows.first()).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Vendas" }).getByRole("link")
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Vendas" }).locator("svg")
  ).toHaveCount(0);
});
