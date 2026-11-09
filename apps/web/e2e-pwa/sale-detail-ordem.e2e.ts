/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { skipOutsideChromium } from "../e2e/reflow";
import { saleDetailStates } from "./ui-sale-detail-states";

/**
 * The receipt of the sale detail puts the total right under the title and the three dates after the items and the
 * adjustments: the order is the DOM's, so the reading order of a screen reader is the visual one.
 */
skipOutsideChromium();

const PHONE = { height: 740, width: 360 };
const LARGE_MONEY = /text-value-lg/;
const DAY_OF_SALE = /^14\/10\/2026/;
const READING_ORDER = [
  'heading "Venda"',
  "Confirmada",
  "Total devido",
  'heading "Itens"',
  "Subtotal",
  "Data da venda",
  "Confirmada no servidor",
  'heading "Pagamento"',
];

async function openReceipt(page: Page, theme: "claro" | "escuro" = "claro") {
  await page.setViewportSize(PHONE);
  await page.addInitScript((stored) => {
    window.localStorage.setItem("polaris-tema", stored);
  }, theme);
  await saleDetailStates.detail(page);
}

test("o total devido vem antes das datas no DOM e na tela, e cabe na primeira tela a 360 px", async ({
  page,
}) => {
  await openReceipt(page);
  const receipt = page.getByRole("region", { exact: true, name: "Venda" });
  const total = receipt.getByText("Total devido", { exact: true });
  const firstDate = receipt.getByText("Data da venda", { exact: true });
  await expect(total).toBeVisible();
  await expect(receipt.getByRole("listitem")).toHaveCount(2);
  await expect(receipt.locator("[data-money]").first()).toHaveClass(
    LARGE_MONEY
  );
  const terms = await receipt
    .locator("dt")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  expect(terms.indexOf("Total devido")).toBeGreaterThanOrEqual(0);
  expect(terms.indexOf("Total devido")).toBeLessThan(
    terms.indexOf("Data da venda")
  );
  const totalBox = await total.boundingBox();
  const dateBox = await firstDate.boundingBox();
  const itemsBox = await receipt
    .getByRole("heading", { name: "Itens" })
    .boundingBox();
  expect(totalBox).not.toBeNull();
  expect(dateBox).not.toBeNull();
  expect(itemsBox).not.toBeNull();
  expect(totalBox?.y ?? 0).toBeLessThan(itemsBox?.y ?? 0);
  expect(itemsBox?.y ?? 0).toBeLessThan(dateBox?.y ?? 0);
  expect((totalBox?.y ?? 0) + (totalBox?.height ?? 0)).toBeLessThanOrEqual(
    PHONE.height
  );
  expect(itemsBox?.y ?? 0).toBeLessThan(PHONE.height);
});

test("as datas seguem num bloco só, com o mesmo texto, e vêm depois do subtotal", async ({
  page,
}) => {
  await openReceipt(page);
  const receipt = page.getByRole("region", { exact: true, name: "Venda" });
  const block = receipt
    .locator("dl")
    .filter({ has: page.getByText("Data da venda", { exact: true }) });
  await expect(block).toHaveCount(1);
  await expect(block.locator("dt")).toContainText([
    "Data da venda",
    "Confirmada no servidor",
  ]);
  await expect(block.getByText(DAY_OF_SALE).first()).toBeVisible();
  const subtotal = await receipt
    .getByText("Subtotal", { exact: true })
    .boundingBox();
  const dates = await block.boundingBox();
  expect(subtotal?.y ?? 0).toBeLessThan(dates?.y ?? 0);
});

test("a árvore de acessibilidade lê título, estado, total, itens, datas e pagamento, nessa ordem", async ({
  page,
}) => {
  await openReceipt(page);
  const tree = await page
    .getByRole("region", { exact: true, name: "Venda" })
    .ariaSnapshot();
  const positions = READING_ORDER.map((text) => tree.indexOf(text));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});
