/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The sale paid in two parts read at 320 px with the browser font at 20 px (`./reflow`): one column, every field of
 * both parts whole (part 2 in credit, with installments, who pays them and anticipation), the state line with its
 * button wrapping instead of cutting, the summary with a group per part, and no sideways scroll of the page.
 */
skipOutsideChromium();

const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const FALTA = /Falta R\$\s1\.234,56/;
const TOUCH_HIT = /\btouch-hit\b/;
const NOW = new Date("2026-10-01T12:00:00-03:00");
const STAMP = NOW.toISOString();
const PROFILE = {
  archivedAt: null,
  createdAt: STAMP,
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório com nome comprido",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [],
  status: "active",
  updatedAt: STAMP,
  version: 1,
};

const ANY_ID = /.+/;

const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** A closed Select popup stays in the page with no size; the option is looked up in the list this trigger opened. */
async function choose(scope: Locator, label: string, option: string) {
  const trigger = scope.getByRole("combobox", { exact: true, name: label });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-controls", ANY_ID);
  const list = scope
    .page()
    .locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
  await list.getByRole("option", { exact: true, name: option }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

async function openSaleScreen(page: Page, price: string) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [PROFILE] }))
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
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Rede disponível").check();
  await item.getByLabel("Quantidade").fill("1");
  await item.getByLabel("Preço cobrado").fill(price);
  await page
    .getByRole("button", { exact: true, name: "Dividir pagamento" })
    .click();
}

async function openSplitSale(page: Page) {
  await openSaleScreen(page, "123456,78");
  const first = page.getByRole("group", { exact: true, name: "Parte 1" });
  const second = page.getByRole("group", { exact: true, name: "Parte 2" });
  await choose(first, "Método", "Transferência");
  await first.getByLabel("Valor").fill("100000,00");
  await choose(first, "Perfil de pagamento", PROFILE.name);
  await choose(second, "Método", "Crédito");
  await second.getByLabel("Valor").fill("22222,22");
  await second.getByLabel("Número de parcelas").fill("12");
  await choose(second, "Quem parcela", "Lojista (eu)");
  await choose(second, "Perfil de pagamento", "Sem perfil de pagamento");
  return { first, second };
}

reflowTest(
  "a 320 px com letra de 20 px a venda em duas partes fica numa coluna, sem nada cortado, e a linha de estado quebra",
  async ({ page }) => {
    await openReflowViewport(page);
    const { first, second } = await openSplitSale(page);
    await expectReflowFont(page);
    const status = page.locator("#sale-split-balance");
    await expect(status).toContainText(FALTA);
    // one column: the method and the amount of a part are one above the other
    const stacked = await Promise.all(
      [first, second].map(async (part) => {
        const method = await part
          .getByRole("combobox", { exact: true, name: "Método" })
          .boundingBox();
        const amount = await part.getByLabel("Valor").boundingBox();
        return Boolean(method && amount && amount.y > method.y + method.height);
      })
    );
    expect(stacked).toEqual([true, true]);
    const action = status.getByRole("button", { name: "Pôr na parte 2" });
    await expect(action).toBeVisible();
    // the button is smaller than 44 px; with a finger `touch-hit` takes its area to 44 px
    await expect(action).toHaveClass(TOUCH_HIT);
    // what the split changes: the card of the payment, the summary and the bar at the bottom
    await assertNothingClipped(
      page.getByRole("region", { exact: true, name: "Pagamento" })
    );
    await assertNothingClipped(page.locator("[data-submit-bar]"));
    await assertNoPageScroll(page);
    const summary = page.getByRole("region", { exact: true, name: "Resumo" });
    await expect(summary).toContainText("Pagamento em 2 partes");
    await assertNothingClipped(summary);
  }
);

for (const fontPixels of [16, 20]) {
  reflowTest(
    `a 320 px com letra de ${fontPixels} px o valor da parte com nome curto fica na primeira linha do nome`,
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels });
      await openSaleScreen(page, "300,00");
      await expectReflowFont(page, fontPixels);
      const first = page.getByRole("group", { exact: true, name: "Parte 1" });
      const second = page.getByRole("group", { exact: true, name: "Parte 2" });
      await choose(first, "Método", "Pix");
      await first.getByLabel("Valor").fill("100,00");
      await choose(second, "Método", "Dinheiro");
      await second.getByLabel("Valor").fill("200,00");
      const summary = page.getByRole("region", { exact: true, name: "Resumo" });
      const names = [1, 2].map((ordinal) =>
        summary.locator("dt", { hasText: `Parte ${ordinal} ·` })
      );
      await expect(summary).toContainText("R$ 100,00");
      await expect(summary).toContainText("R$ 200,00");
      const boxes = await Promise.all(
        names.flatMap((name) => [
          name.boundingBox(),
          name.locator("xpath=following-sibling::dd[1]").boundingBox(),
        ])
      );
      for (const [name, amount] of [
        [boxes[0], boxes[1]],
        [boxes[2], boxes[3]],
      ]) {
        if (!(name && amount)) {
          throw new Error("sem caixa para medir");
        }
        expect(amount.y).toBeLessThan(name.y + name.height / 2);
      }
    }
  );
}
