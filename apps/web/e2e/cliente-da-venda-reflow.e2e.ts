/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  DETAIL_SALE_ID,
  saleDetailAnswers,
} from "../e2e-pwa/sale-detail-fixture";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The "Cliente da venda" card of the sale detail read at 320 px with the browser font at 20 px (`./reflow`), with the
 * summary of the customer at its widest: a total of millions, a count of three digits and a date with the year. The
 * three indicators stay whole and the page does not scroll sideways.
 */
skipOutsideChromium();

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-14T12:00:00-03:00");
const LAST_PURCHASE_ON = new Date(NOW.getTime() - 300 * 86_400_000)
  .toISOString()
  .slice(0, 10);
const LAST_PURCHASE_TEXT = LAST_PURCHASE_ON.split("-").reverse().join("/");
const TOTAL_TEXT = /^R\$\s1\.234\.567,89$/;
const PURCHASES = 128;

const answer = (body: string) => ({
  body,
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const rpcBody = (json: unknown) => answer(JSON.stringify(json));
const rpc = (json: unknown) => rpcBody({ json, meta: [] });

async function openSaleDetail(page: Page, name?: string) {
  const answers = saleDetailAnswers({ withReturn: true });
  const customer = answers["customer/get"] as object;
  const withSummary = {
    ...answers,
    "customer/get": {
      ...customer,
      ...(name === undefined ? {} : { name }),
      summary: {
        lastPurchaseOn: LAST_PURCHASE_ON,
        purchaseCount: PURCHASES,
        totalSpent: "1234567.89",
      },
    },
  };
  await openReflowViewport(page);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(rpcBody({ session: { id: "s" }, user: { id: "u" } }))
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const found = (withSummary as Record<string, unknown>)[procedure];
    return found === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(rpc(found));
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(`/sales/detail?saleId=${DETAIL_SALE_ID}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Cliente da venda" })
  ).toBeVisible();
  await expectReflowFont(page, 20);
  return page.locator("[data-customer-summary]");
}

const LONG_NAME =
  "Maria Aparecida dos Santos Albuquerque Figueiredo Nascimento";
const UNBROKEN_NAME = "MariaAparecidaDosSantosAlbuquerqueFigueiredoNascimento";

reflowTest(
  "a 320 px com letra de 20 px o resumo do cliente da venda lê inteiro, com total de milhões, várias compras e a data com ano",
  async ({ page }) => {
    const summary = await openSaleDetail(page);
    await expect(summary).toBeVisible();
    await expect(summary.locator("dd")).toHaveText([
      String(PURCHASES),
      TOTAL_TEXT,
      LAST_PURCHASE_TEXT,
    ]);
    await assertNothingClipped(summary);
    await assertNothingClipped(page.locator("main"));
    await assertNoPageScroll(page);
  }
);

for (const name of [LONG_NAME, UNBROKEN_NAME]) {
  reflowTest(
    `a 320 px com letra de 20 px o nome longo do cliente da venda fica dentro do cartão, sem rolagem lateral (${name.includes(" ") ? "com espaços" : "sem espaços"})`,
    async ({ page }) => {
      await openSaleDetail(page, name);
      const card = page.locator("section[aria-labelledby=sale-customer-title]");
      const current = card.getByRole("status").filter({ hasText: name });
      await expect(current).toBeVisible();
      await expect(current).toHaveText(name);
      const box = await card.boundingBox();
      const written = await current.boundingBox();
      expect(box, "o cartão está na tela").not.toBeNull();
      expect(written, "o nome está na tela").not.toBeNull();
      expect(
        (written?.x ?? 0) + (written?.width ?? 0),
        "o nome não passa da borda direita do cartão"
      ).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
      expect(
        written?.x ?? 0,
        "o nome não passa da borda esquerda"
      ).toBeGreaterThanOrEqual((box?.x ?? 0) - 0.5);
      await assertNothingClipped(card);
      await assertNoPageScroll(page);
    }
  );
}
