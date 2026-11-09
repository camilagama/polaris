/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The line under the title of a page says a date, a period or a state, never a sentence that explains the screen
 * (DESIGN.md, "Texto curto"). The sentence of Detalhe da venda, Despesas and Formas de receber is in the (i) of the
 * title, whole, under the name "Sobre {tela}"; nothing is left in the header but the title, its (i) and the action.
 */
skipOutsideChromium();

const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = "2026-10-14T12:00:00.000Z";
const TODAY = "2026-10-14";
const SALE_ID = "0199c2d0-0000-7000-8000-0000000000c1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000b1";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000c2";
const RPC_PREFIX = /^\/rpc\//;

const SALE_DETAIL_TEXT =
  "A venda confirmada é um registro que não muda. Cancelamento e cliente são registros à parte.";
const EXPENSES_TEXT =
  "Cada despesa conta no mês de competência, não no dia do pagamento.";
const PROFILES_TEXT =
  "Organize métodos, parcelamento, prazo de recebimento e taxas por perfil.";

const VIEWPORTS = [
  { fontPixels: 16, height: 740, name: "360", width: 360 },
  { fontPixels: 16, height: 800, name: "1280", width: 1280 },
  { fontPixels: 20, height: 740, name: "320/20", width: 320 },
] as const;

const answer = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const NO_FEE = {
  amount: null,
  basisPoints: null,
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
};

const DETAIL = {
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
      processingFee: NO_FEE,
    },
    sale: {
      commandId: uuid(0xc3),
      confirmedAt: NOW,
      currency: "BRL",
      id: SALE_ID,
      occurredAt: NOW,
      occurredOn: TODAY,
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

const EXPENSE = {
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: uuid(2),
  categoryName: "Aluguel",
  competenceOn: TODAY,
  createdAt: NOW,
  description: "Aluguel da loja",
  id: uuid(500),
  organizationId: ORGANIZATION,
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: NOW,
  version: 1,
  voidedAt: null,
};

const PROFILE = {
  archivedAt: null,
  createdAt: NOW,
  id: uuid(0xc1),
  name: "Maquininha da loja",
  organizationId: ORGANIZATION,
  rules: [],
  status: "active",
  updatedAt: NOW,
  version: 1,
};

async function startLab(page: Page, query: string) {
  await page.clock.setFixedTime(new Date(NOW));
  await serveLabWorker(page);
  await page.goto(`/offline-screens-lab?${query}`);
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
}

async function openDetail(page: Page) {
  await page.route("**/rpc/**", (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    switch (procedure) {
      case "sale/get":
        return route.fulfill(answer(DETAIL));
      case "sale/getCustomerLink":
        return route.fulfill(
          answer({
            current: { customerId: null, version: 0 },
            history: [],
            saleId: SALE_ID,
          })
        );
      case "customer/list":
        return route.fulfill(answer({ customers: [] }));
      default:
        return route.abort("internetdisconnected");
    }
  });
  await startLab(page, `screen=sale-detail&saleId=${SALE_ID}`);
  await expect(page.getByText("Camiseta básica").first()).toBeVisible({
    timeout: 20_000,
  });
}

async function openExpenses(page: Page) {
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    switch (procedure) {
      case "expense/listCategories":
        return route.fulfill(
          answer({
            categories: [
              {
                archivedAt: null,
                createdAt: NOW,
                groupKey: "operational",
                id: uuid(2),
                name: "Aluguel",
                organizationId: ORGANIZATION,
                status: "active",
                systemKey: null,
                updatedAt: NOW,
                version: 1,
              },
            ],
          })
        );
      case "expense/list":
        return route.fulfill(
          answer({
            count: 1,
            expenses: [EXPENSE],
            nextCursor: null,
            total: "1500.50",
          })
        );
      case "expense/listRules":
        return route.fulfill(answer({ rules: [] }));
      default:
        return route.fulfill({
          ...answer({ code: "NOT_FOUND" }),
          status: 404,
        });
    }
  });
  await startLab(page, "screen=expenses");
  await expect(page.getByText("Aluguel da loja")).toBeVisible({
    timeout: 20_000,
  });
}

async function openProfiles(page: Page) {
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(answer({ profiles: [PROFILE] }))
  );
  await startLab(page, "screen=payment-profiles");
  await expect(page.getByText("Maquininha da loja")).toBeVisible({
    timeout: 20_000,
  });
}

const SCREENS = [
  { about: "Detalhe da venda", open: openDetail, text: SALE_DETAIL_TEXT },
  { about: "Despesas", open: openExpenses, text: EXPENSES_TEXT },
  { about: "Formas de receber", open: openProfiles, text: PROFILES_TEXT },
] as const;

const headerOf = (page: Page, about: string) =>
  page
    .locator("header")
    .filter({
      has: page.getByRole("heading", { exact: true, name: about }),
    })
    .first();

/** The text of the (i) when it is open: the popup is in a portal, so it is found by its name, not under the header. */
async function openTip(page: Page, about: string): Promise<Locator> {
  await page
    .getByRole("button", { exact: true, name: `Sobre ${about}` })
    .click();
  const popup = page.getByRole("dialog", { name: about });
  await expect(popup).toBeVisible();
  return popup;
}

for (const screen of SCREENS) {
  for (const viewport of VIEWPORTS) {
    test(`${screen.about} a ${viewport.name}: a frase que explica a tela está inteira no (i) do título e não sobra linha sob ele`, async ({
      page,
    }) => {
      await openReflowViewport(page, viewport);
      await screen.open(page);
      await expectReflowFont(page, viewport.fontPixels);

      const header = headerOf(page, screen.about);
      await expect(header.locator("p")).toHaveCount(0);
      await expect(header).not.toContainText(screen.text);
      await expect(page.getByText(screen.text)).toHaveCount(0);

      const popup = await openTip(page, screen.about);
      await expect(popup).toContainText(screen.text);
      expect((await popup.innerText()).replace(/\s+/g, " ")).toBe(
        `${screen.about} ${screen.text}`
      );
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);

      await assertNothingClipped(header);
      await assertNoPageScroll(page);
    });
  }
}
