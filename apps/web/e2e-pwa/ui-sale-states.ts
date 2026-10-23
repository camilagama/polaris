/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Locator, Page, Route } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the sale screen the interface guardrails measure (t185): the screen in the lab of the screens
 * (`/offline-screens-lab?screen=sale`) over the real offline runtime, with the server answered by the test
 * (`page.route`) and synthetic data only. The lab's own controls are hidden at the end of each state, so what
 * is measured is the screen alone.
 */
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";

const SHIRT_OPTION = /Camiseta do teste/;
const JEANS_OPTION = /Calça jeans/;
const LAB_SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const PROFILE_OPTION = /Maquininha do balcão/;
const CONFIRMED_REGION = /Venda confirmada/;
const SUBMIT_NAME =
  /Confirmar venda|Guardar venda neste aparelho|Tentar novamente/;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const entry = (
  n: number,
  productName: string,
  value: string,
  listPrice: string | null,
  quantity: number,
  cost: string | null
) => ({
  isDefaultVariant: false,
  listPrice,
  movingAverageCost: cost,
  productId: `0199c2d0-0000-7000-8000-0000000000f${n}`,
  productName,
  productStatus: "active",
  quantity,
  sku: `SKU-${n}`,
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "cor", optionValueName: value }],
  variantId: `0199c2d0-0000-7000-8000-0000000000b${n}`,
  version: 1,
});
const SHIRT = entry(1, "Camiseta do teste", "Azul", "50.00", 5, null);
const JEANS = entry(2, "Calça jeans", "42", "139.90", 3, "62.40");

const PROFILE = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do balcão",
  organizationId: ORGANIZATION,
  rules: [
    {
      anticipationFee: {
        fixedAmount: null,
        mode: "percentage",
        percentage: "1.500000",
      },
      expectedSettlementDays: 30,
      id: "0199c2d0-0000-7000-8000-0000000000c2",
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
      processingFee: {
        fixedAmount: "0.50",
        mode: "fixed_and_percentage",
        percentage: "2.990000",
      },
    },
  ],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 3,
};

const CONFIRMED = {
  adjustments: [
    {
      amount: "10.00",
      kind: "discount",
      percentage: null,
      position: 0,
      valueType: "fixed",
    },
  ],
  items: [
    {
      chargedUnitPrice: "50.00",
      listedUnitPrice: "50.00",
      position: 0,
      productId: SHIRT.productId,
      productLabel: "Camiseta do teste — Azul",
      quantity: 2,
      unitCost: null,
      variantId: SHIRT.variantId,
    },
    {
      chargedUnitPrice: "129.90",
      listedUnitPrice: "139.90",
      position: 1,
      productId: JEANS.productId,
      productLabel: "Calça jeans — 42",
      quantity: 1,
      unitCost: "62.40",
      variantId: JEANS.variantId,
    },
  ],
  payment: {
    amount: "219.90",
    anticipationFee: {
      amount: "0.00",
      fixedAmount: null,
      mode: "not_applicable",
      percentage: null,
    },
    anticipationRequested: false,
    expectedSettlementDays: null,
    installmentPlan: null,
    installments: null,
    method: "pix",
    paymentProfileId: null,
    paymentProfileName: null,
    paymentProfileRuleId: null,
    paymentProfileVersion: null,
    processingFee: {
      amount: null,
      fixedAmount: null,
      mode: "unknown",
      percentage: null,
    },
  },
  replayed: false,
  sale: {
    commandId: "00000000-0000-4000-8000-000000000001",
    confirmedAt: "2026-10-15T15:00:01.000Z",
    currency: "BRL",
    id: "77777777-7777-4777-8777-777777777777",
    occurredAt: "2026-10-15T15:00:00.000Z",
    occurredOn: "2026-10-15",
    recordedAt: null,
  },
  totals: {
    discountTotal: "10.00",
    freightTotal: "0.00",
    paymentSurchargeTotal: "0.00",
    subtotal: "229.90",
    surchargeTotal: "0.00",
    totalDue: "219.90",
  },
};

async function serveSale(page: Page) {
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: [PROFILE] }))
  );
  await page.route("**/rpc/inventory/listBalances", (route: Route) => {
    const body = route.request().postData() ?? "";
    let entries = [SHIRT, JEANS];
    if (body.includes("cal")) {
      entries = [JEANS];
    } else if (body.includes("cam")) {
      entries = [SHIRT];
    }
    return route.fulfill(rpc({ entries, nextCursor: null }));
  });
  await page.route("**/rpc/sale/confirm", (route: Route) =>
    route.fulfill(rpc(CONFIRMED))
  );
  await page.route("**/rpc/sale/getCustomerLink", (route: Route) =>
    route.fulfill(
      rpc({
        current: { customerId: null, version: 0 },
        history: [],
        saleId: CONFIRMED.sale.id,
      })
    )
  );
  await page.route("**/rpc/customer/list", (route: Route) =>
    route.fulfill(rpc({ customers: [] }))
  );
}

/** Starts the lab's runtime and waits for the screen; the network is the lab's checkbox. */
async function openSaleLab(page: Page) {
  await serveSale(page);
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
}

/**
 * Hides the lab's own controls and waits for the fonts: what stays is the screen. The page ends scrolled to the
 * bottom, where the bar with the total rests at the end of the form: anywhere else the bar floats over the
 * controls under it, and their touch areas meet the button's by design of a sticky bar.
 */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.evaluate(() => document.fonts.ready);
  // the stock lines and the summary settle after the last click (slower on a busy machine): scroll again once they have
  await page.waitForTimeout(400);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight)
  );
}

async function pick(
  page: Page,
  index: number,
  search: string,
  option: RegExp
): Promise<Locator> {
  const item = page.getByRole("group", { exact: true, name: `Item ${index}` });
  await item.getByLabel("Produto ou variante").fill(search);
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: option })
    .click();
  return item;
}

async function twoItems(page: Page) {
  const first = await pick(page, 1, "cam", SHIRT_OPTION);
  await first.getByLabel("Quantidade").fill("2");
  await page.getByRole("button", { name: "Adicionar item" }).click();
  const second = await pick(page, 2, "cal", JEANS_OPTION);
  await second.getByLabel("Preço cobrado").fill("129,90");
}

async function chooseMethod(page: Page, method: string) {
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: method })
    .check();
}

async function payPix(page: Page) {
  await chooseMethod(page, "Pix");
  await chooseOption(
    page,
    page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" }),
    page.getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
  );
}

/** Opens a select, picks the option and waits for the popup to leave: a slow machine still shows it fading out. */
async function chooseOption(page: Page, trigger: Locator, option: Locator) {
  await trigger.click();
  await option.click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}

const submit = (page: Page) =>
  page
    .getByRole("button", {
      name: SUBMIT_NAME,
    })
    .last();

export const saleStates = {
  /** The sale confirmed by the server, with the item whose cost is unknown. */
  async confirmed(page: Page) {
    await openSaleLab(page);
    await twoItems(page);
    await payPix(page);
    await submit(page).click();
    await page.getByRole("region", { name: CONFIRMED_REGION }).waitFor();
    await showScreenAlone(page);
  },

  async empty(page: Page) {
    await openSaleLab(page);
    await showScreenAlone(page);
  },

  /** The confirm button pressed on an empty form: every message of the fields. */
  async fieldErrors(page: Page) {
    await openSaleLab(page);
    await submit(page).click();
    await page.getByText("Escolha o método de pagamento").first().waitFor();
    await showScreenAlone(page);
  },

  /** Without a network, a sale kept on the device and the next one being filled from its catalog. */
  async offline(page: Page) {
    await openSaleLab(page);
    await page.getByLabel("Rede disponível").uncheck();
    const first = await pick(page, 1, "camiseta azul", LAB_SHIRT_OPTION);
    await first.getByLabel("Quantidade").fill("2");
    await payPix(page);
    await submit(page).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
      .waitFor({ timeout: 15_000 });
    await pick(page, 1, "camiseta azul", LAB_SHIRT_OPTION);
    await showScreenAlone(page);
  },
  /** A credit card sale: installments, a profile and an adjustment (the tallest form). */
  async payment(page: Page) {
    await openSaleLab(page);
    await twoItems(page);
    await chooseMethod(page, "Crédito");
    await page.getByLabel("Número de parcelas").fill("3");
    await chooseOption(
      page,
      page.getByRole("combobox", {
        exact: true,
        name: "Modalidade do parcelamento",
      }),
      page.getByRole("option", { exact: true, name: "Parcelado pelo lojista" })
    );
    await chooseOption(
      page,
      page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" }),
      page.getByRole("option", { name: PROFILE_OPTION })
    );
    await page.getByRole("button", { name: "Adicionar ajuste" }).click();
    const adjustment = page.getByRole("group", {
      exact: true,
      name: "Ajuste 1",
    });
    await chooseOption(
      page,
      adjustment.getByRole("combobox", { exact: true, name: "Tipo de ajuste" }),
      page.getByRole("option", { exact: true, name: "Desconto" })
    );
    await adjustment.getByLabel("Valor (R$)").fill("10,00");
    await showScreenAlone(page);
  },

  /** The items chosen and the method paid in Pix. */
  async withItems(page: Page) {
    await openSaleLab(page);
    await twoItems(page);
    await payPix(page);
    await showScreenAlone(page);
  },
};
