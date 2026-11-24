/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Locator, Page, Route } from "@playwright/test";
import { showScreenAlone } from "./show-screen-alone";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the sale screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=sale`) over the real offline runtime, with the server answered by the test
 * (`page.route`) and synthetic data only. The lab's own controls are hidden at the end of each state, so what
 * is measured is the screen alone.
 */
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = new Date("2026-10-15T15:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

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
  updatedAt: ago(DAY + 3 * HOUR),
  values: [{ optionName: "cor", optionValueName: value }],
  variantId: `0199c2d0-0000-7000-8000-0000000000b${n}`,
  version: 1,
});
const SHIRT = entry(1, "Camiseta do teste", "Azul", "50.00", 5, null);
const JEANS = entry(2, "Calça jeans", "42", "139.90", 3, "62.40");

const PROFILE = {
  archivedAt: null,
  createdAt: ago(14 * DAY + 3 * HOUR),
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
  updatedAt: ago(14 * DAY + 3 * HOUR),
  version: 3,
};

export const CONFIRMED_SALE = {
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
    confirmedAt: new Date(NOW.getTime() + 1000).toISOString(),
    currency: "BRL",
    id: "77777777-7777-4777-8777-777777777777",
    occurredAt: NOW.toISOString(),
    occurredOn: NOW.toISOString().slice(0, 10),
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
    route.fulfill(rpc(CONFIRMED_SALE))
  );
  await page.route("**/rpc/sale/getCustomerLink", (route: Route) =>
    route.fulfill(
      rpc({
        current: { customerId: null, version: 0 },
        history: [],
        saleId: CONFIRMED_SALE.sale.id,
      })
    )
  );
  await page.route("**/rpc/customer/list", (route: Route) =>
    route.fulfill(rpc({ customers: [] }))
  );
}

/** Starts the lab's runtime and waits for the screen; the network is the lab's checkbox. */
async function openSaleLab(page: Page) {
  await page.clock.setFixedTime(NOW);
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

const SETTLED_FRAMES = 15;
const SETTLE_BUDGET_MS = 10_000;

/**
 * The screen alone (see `showScreenAlone`), then scrolled to the bottom, where the bar with the total rests at the end of
 * the form: anywhere else the bar floats over the controls under it, and their touch areas meet the button's by design of
 * a sticky bar. The stock lines and the summary settle after the last click without any animation (slower on a busy
 * machine) and change the page height, so the scroll follows the height until it holds for `SETTLED_FRAMES` frames.
 */
async function showSaleScreenAlone(page: Page) {
  await showScreenAlone(page);
  const settled = await page.evaluate(
    ({ budget, frames }) =>
      new Promise<boolean>((resolve) => {
        const startedAt = performance.now();
        let height = -1;
        let steady = 0;
        const step = () => {
          const now = document.documentElement.scrollHeight;
          steady = now === height ? steady + 1 : 0;
          height = now;
          window.scrollTo(0, now);
          if (steady >= frames) {
            resolve(true);
          } else if (performance.now() - startedAt > budget) {
            resolve(false);
          } else {
            requestAnimationFrame(step);
          }
        };
        step();
      }),
    { budget: SETTLE_BUDGET_MS, frames: SETTLED_FRAMES }
  );
  if (!settled) {
    throw new Error(
      `showSaleScreenAlone: a altura da página não parou de mudar em ${SETTLE_BUDGET_MS} ms`
    );
  }
}

async function pick(
  page: Page,
  index: number,
  search: string,
  option: RegExp
): Promise<Locator> {
  const item = page.getByRole("group", { exact: true, name: `Item ${index}` });
  await item.getByLabel("Produto ou variante").fill(search);
  await page
    .getByRole("listbox", { name: "Variantes encontradas" })
    .getByRole("option", { name: option })
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

const ASKS = 3;
const POPUP_WAIT_MS = 5000;
const ADJUSTMENT_WAIT_MS = 15_000;
const ADJUSTMENT_GROUP = /^Ajuste \d+$/;

/**
 * Opens the popup of a select. A click that left the listbox hidden for `POPUP_WAIT_MS` is repeated once (never while
 * it may be opening, because a second click would close it); a second miss fails with the trigger's name. The short
 * limit only decides whether the popup opened: once the listbox shows, the option is waited for by the action limit.
 */
async function openPopup(trigger: Locator, option: Locator, listbox: Locator) {
  for (let click = 1; click <= 2; click += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second click only follows one that opened nothing
    await trigger.click();
    try {
      await listbox.waitFor({ timeout: POPUP_WAIT_MS });
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) {
        throw error;
      }
      continue;
    }
    await option.waitFor();
    return;
  }
  throw new Error(
    `the click on the select "${await trigger.innerText()}" did not open its popup after 2 clicks`
  );
}

/**
 * Opens a select, picks the option and waits for the popup to leave: a slow machine still shows it fading out. The
 * popup opens under a trigger that the page may still be scrolling out from behind the bar of the total, and a click
 * that lands while it moves closes it without choosing: the choice is read back from the trigger, and asked again
 * when it did not take.
 */
async function chooseOption(page: Page, trigger: Locator, option: Locator) {
  const listbox = page.getByRole("listbox");
  for (let ask = 1; ; ask += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the next ask only follows a choice that did not take
    await openPopup(trigger, option, listbox);
    const label = (await option.innerText()).trim();
    await option.click();
    await listbox.waitFor({ state: "detached" });
    if ((await trigger.innerText()).includes(label)) {
      return;
    }
    if (ask === ASKS) {
      throw new Error(
        `the select kept "${await trigger.innerText()}" after ${ASKS} asks for "${label}"`
      );
    }
  }
}

/**
 * Adds the first adjustment and returns its group. The panel of date and adjustments opens with a height animation on
 * the desktop, and a click that lands while it runs can focus the button without activating it: the click waits for
 * the animation to end. The animation is read only once the panel carries `data-open`, which is what starts it. The
 * click is made once: a second one while the group is slow would add "Ajuste 2" and fail the state, and one the app
 * ignored must show as a failure, not be repeated away.
 */
async function addFirstAdjustment(page: Page) {
  const group = page.getByRole("group", { exact: true, name: "Ajuste 1" });
  const add = page.getByRole("button", { name: "Adicionar ajuste" });
  const panel = page
    .locator('[data-slot="collapsible-content"][data-open]')
    .filter({ has: add });
  await panel.waitFor();
  await panel.evaluate((element) =>
    Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished)
    )
  );
  await add.click();
  try {
    await group.waitFor({ timeout: ADJUSTMENT_WAIT_MS });
  } catch (error) {
    const groups = await page
      .getByRole("group", { name: ADJUSTMENT_GROUP })
      .count();
    throw new Error(
      `o clique em adicionar ajuste não teve efeito: "Ajuste 1" não apareceu em ${ADJUSTMENT_WAIT_MS} ms (${groups} grupos de ajuste na tela)`,
      { cause: error }
    );
  }
  return group;
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
    await showSaleScreenAlone(page);
  },

  async empty(page: Page) {
    await openSaleLab(page);
    await showSaleScreenAlone(page);
  },

  /** The confirm button pressed on an empty form: every message of the fields. */
  async fieldErrors(page: Page) {
    await openSaleLab(page);
    await submit(page).click();
    await page.getByText("Escolha o método de pagamento").first().waitFor();
    await showSaleScreenAlone(page);
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
    await showSaleScreenAlone(page);
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
        name: "Quem parcela",
      }),
      page.getByRole("option", { exact: true, name: "Lojista (eu)" })
    );
    await chooseOption(
      page,
      page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" }),
      page.getByRole("option", { name: PROFILE_OPTION })
    );
    await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
    const adjustment = await addFirstAdjustment(page);
    await chooseOption(
      page,
      adjustment.getByRole("combobox", { exact: true, name: "Tipo de ajuste" }),
      page.getByRole("option", { exact: true, name: "Desconto" })
    );
    await adjustment.getByLabel("Valor (R$)").fill("10,00");
    await showSaleScreenAlone(page);
  },

  /** Paid in two parts: Pix with no profile, then credit with installments and a profile, closing the total. */
  async split(page: Page) {
    await openSaleLab(page);
    await twoItems(page);
    await payPix(page);
    await page
      .getByRole("button", { exact: true, name: "Dividir pagamento" })
      .click();
    const first = page.getByRole("group", { exact: true, name: "Parte 1" });
    const second = page.getByRole("group", { exact: true, name: "Parte 2" });
    await first.getByLabel("Valor").fill("100,00");
    await chooseOption(
      page,
      second.getByRole("combobox", { exact: true, name: "Método" }),
      page.getByRole("option", { exact: true, name: "Crédito" })
    );
    await second.getByLabel("Número de parcelas").fill("3");
    await chooseOption(
      page,
      second.getByRole("combobox", { exact: true, name: "Quem parcela" }),
      page.getByRole("option", { exact: true, name: "Lojista (eu)" })
    );
    await chooseOption(
      page,
      second.getByRole("combobox", {
        exact: true,
        name: "Perfil de pagamento",
      }),
      page.getByRole("option", { name: PROFILE_OPTION })
    );
    await page.locator('[data-split-balance="closed"]').waitFor();
    await showSaleScreenAlone(page);
  },

  /** The items chosen and the method paid in Pix. */
  async withItems(page: Page) {
    await openSaleLab(page);
    await twoItems(page);
    await payPix(page);
    await showSaleScreenAlone(page);
  },
};
