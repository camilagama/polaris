/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertAmountsOnOneLine,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The amounts of the sale detail read at 320 px with the browser font at 20 px (`./reflow`): "R$" and the number of
 * "Custo unitário registrado", of the item line and of the payment block (value and fee) stay on one line, and the
 * text of the page is the one it always was. With the default font (16 px) the cost line is the same line.
 */
skipOutsideChromium();

const SALE_ID = "0199c2d0-0000-7000-8000-0000000000c1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000b1";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000c2";
const AT = "2026-10-14T15:00:00.000Z";
const NO_FEE = {
  amount: null,
  basisPoints: null,
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
};
const RPC_PREFIX = /^\/rpc\//;
const COST_LINE = "Custo unitário registrado: R$ 17,00.";

const detail = {
  cancellation: null,
  customer: { customerId: null, version: 0 },
  returnSummary: [
    {
      availableToReturn: 3,
      position: 0,
      restockedQuantity: 0,
      returnedQuantity: 0,
      sold: 3,
    },
  ],
  returns: [],
  sale: {
    adjustments: [],
    items: [
      {
        chargedUnitPrice: "1234.50",
        listedUnitPrice: "1300.00",
        position: 0,
        productId: PRODUCT,
        productLabel: "Camiseta básica",
        quantity: 3,
        unitCost: "17.00",
        variantId: VARIANT,
      },
    ],
    payment: {
      amount: "3703.50",
      anticipationFee: NO_FEE,
      anticipationRequested: false,
      expectedSettlementDays: null,
      installmentPlan: null,
      installments: null,
      method: "cash",
      paymentProfileId: null,
      paymentProfileName: null,
      paymentProfileRuleId: null,
      paymentProfileVersion: null,
      processingFee: {
        amount: "18894.09",
        basisPoints: null,
        fixedAmount: "1111.50",
        mode: "fixed_and_percentage",
        percentage: "12.5",
      },
    },
    sale: {
      commandId: "0199c2d0-0000-7000-8000-0000000000c3",
      confirmedAt: AT,
      currency: "BRL",
      id: SALE_ID,
      occurredAt: AT,
      occurredOn: "2026-10-14",
      recordedAt: null,
    },
    totals: {
      discountTotal: "0.00",
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal: "3703.50",
      surchargeTotal: "0.00",
      totalDue: "3703.50",
    },
  },
};

const answer = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openDetail(page: Page, fontPixels: number) {
  await openReflowViewport(page, { fontPixels });
  await page.route("**/rpc/**", async (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (procedure === "sale/get") {
      await route.fulfill(answer(detail));
      return;
    }
    if (procedure === "sale/getCustomerLink") {
      await route.fulfill(
        answer({
          current: { customerId: null, version: 0 },
          history: [],
          saleId: SALE_ID,
        })
      );
      return;
    }
    if (procedure === "customer/list") {
      await route.fulfill(answer({ customers: [] }));
      return;
    }
    await route.abort("internetdisconnected");
  });
  await serveLabWorker(page);
  await page.goto(`/offline-screens-lab?screen=sale-detail&saleId=${SALE_ID}`);
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByText(COST_LINE)).toBeVisible({ timeout: 20_000 });
  await expectReflowFont(page, fontPixels);
}

reflowTest(
  "Detalhe da venda: o R$ e o número do custo e da linha do item ficam na mesma linha, com o texto de sempre",
  async ({ page }) => {
    await openDetail(page, 20);
    const items = page.getByRole("region", { name: "Itens" });
    await expect(items.locator("li")).toHaveText([
      "Camiseta básica3 × R$ 1.234,50 (tabela R$ 1.300,00) = R$ 3.703,50Custo unitário registrado: R$ 17,00.",
    ]);
    expect(await assertAmountsOnOneLine(items)).toBe(4);
    // the punched holes of the perforation sit half outside the card on purpose, and the card hides them
    await assertNothingClipped(page.locator("main"), {
      allowScroll: ['[data-slot="card"]'],
    });
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "Detalhe da venda: o R$ e o número do bloco de pagamento ficam na mesma linha, com o texto de sempre",
  async ({ page }) => {
    await openDetail(page, 20);
    const payment = page
      .locator("dl")
      .filter({ hasText: "Valor do pagamento" });
    await expect(payment.locator("dd").nth(1)).toHaveText("R$ 3.703,50");
    await expect(
      payment.locator("div").filter({ hasText: "Taxa de processamento" })
    ).toHaveText(
      "Taxa de processamentoR$ 18.894,09 (R$ 1.111,50 + 12,5% do total devido)"
    );
    expect(await assertAmountsOnOneLine(payment)).toBe(3);
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "Detalhe da venda: a 16 px o custo é a mesma linha",
  async ({ page }) => {
    await openDetail(page, 16);
    const cost = page.getByText(COST_LINE);
    expect(
      await cost.evaluate((element) => element.getClientRects().length)
    ).toBe(1);
    await assertAmountsOnOneLine(page.getByRole("region", { name: "Itens" }));
  }
);
