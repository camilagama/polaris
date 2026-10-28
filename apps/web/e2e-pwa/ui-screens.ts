/// <reference lib="dom" />
// Only types from Playwright: the source rules (scripts/ui-source-rules.test.ts) read this list under Vitest.
import type { BrowserContext, Locator, Page } from "@playwright/test";
import {
  acceptanceStates,
  firstAccessStates,
  legalStates,
} from "./ui-account-states";
import { attentionStates, deviceStates } from "./ui-device-states";
import { entryStates, settle } from "./ui-entry-states";
import { expenseStates } from "./ui-expense-states";
import { historyStates } from "./ui-history-states";
import { homeStates } from "./ui-home-states";
import {
  catalogStates,
  categoryStates,
  customerStates,
} from "./ui-lot2-states";
import { passwordStates } from "./ui-password-states";
import { paymentStates } from "./ui-payment-states";
import { productStates } from "./ui-product-states";
import { resultStates } from "./ui-result-states";
import { saleDetailStates } from "./ui-sale-detail-states";
import { saleStates } from "./ui-sale-states";
import { stockStates } from "./ui-stock-states";
import { subscriptionStates } from "./ui-subscription-states";

/**
 * The screens the interface guardrails run on, served by the static server of the pwa-e2e build under
 * the CSP of `_headers`. The list grows with each new screen or state: docs/runbooks/testes-de-tela.md says how.
 *
 * Every screen is on the new interface since batch 6: touch area of 48 px, no fault waits for a migration,
 * and the source folders of each one are read by the source rules (`scripts/ui-source-rules.test.ts`).
 */
export interface UiScreen {
  /** Opens and closes every overlay of the screen, so the motion recorder sees them. */
  exercise?: (page: Page) => Promise<void>;
  name: string;
  /** Opens the screen in one of the states, and waits until it is drawn. */
  open: (page: Page, context: BrowserContext) => Promise<void>;
  /** Source folders (or files) under `src/` of the screen, for the source rules. */
  sourceDirs: string[];
}

export type UiCheck = "overflow" | "touch" | "axe" | "focus";

export const VIEWPORTS = {
  "320": { height: 640, width: 320 },
  "360": { height: 740, width: 360 },
  "1280": { height: 800, width: 1280 },
} as const;

type UiTheme = "claro" | "escuro";
export const COLOR_SCHEME = { claro: "light", escuro: "dark" } as const;

/** One browser context of the matrix: the width, the pointer (a phone and a tablet have touch) and the theme. */
export interface UiContext {
  theme: UiTheme;
  touch: boolean;
  viewport: keyof typeof VIEWPORTS;
}

const light = (viewport: UiContext["viewport"], touch: boolean): UiContext => ({
  theme: "claro",
  touch,
  viewport,
});

/**
 * Each check runs only on the axes that can change its result, declared once here (docs/runbooks/testes-de-tela.md);
 * `ui-guardrails.e2e.ts` builds its tests from this map, one page load per distinct context, and runs on it every
 * check that lists the context. A new check, or a new axis for one, is a line here: the cost of the CI grows with
 * the contexts listed, not with the product of widths, themes and pointers.
 *
 * - overflow (1): the widths decide what fits; at 1280 it runs with a mouse and with touch (the context the touch
 *   check loads anyway); the theme does not move a box;
 * - touch (2): the areas of 48 px exist with a coarse pointer, at the two phone widths and on a tablet;
 * - axe (3): the contrast is the theme's, and the phone is the width where the layout is tightest;
 * - focus (6): the ring is drawn with the keyboard, which is the wide screen with a mouse.
 *
 * Motion (5) is not here: it needs no axis, it runs once per state in `MOTION_CONTEXT`. Colors only in OKLCH and
 * tokens (4) is a source test, with no context (`scripts/ui-source-rules.test.ts`).
 */
export const CHECK_CONTEXTS: Record<UiCheck, readonly UiContext[]> = {
  axe: [light("360", true), { theme: "escuro", touch: true, viewport: "360" }],
  focus: [light("1280", false)],
  overflow: [
    light("320", true),
    light("360", true),
    light("1280", false),
    light("1280", true),
  ],
  touch: [light("320", true), light("360", true), light("1280", true)],
};

/** The context of the motion check (5): once per state, with `reduce`. */
export const MOTION_CONTEXT: UiContext = light("360", true);

/** Opens an overlay by its trigger, waits for it, and closes it with Escape, waiting for the exit too. */
async function openAndClose(
  page: Page,
  trigger: { name: string; role: "button" | "combobox" },
  popup: { name?: string; role: "dialog" | "listbox" | "menu" }
) {
  // a form dialog can be open already (its own backdrop stays): what must go is the one of this overlay
  const backdrops = await page.locator("[data-base-ui-inert]").count();
  await page
    .getByRole(trigger.role, { exact: true, name: trigger.name })
    .first()
    .click();
  const surface = page.getByRole(
    popup.role,
    popup.name ? { name: popup.name } : {}
  );
  await surface.first().waitFor();
  await escapeUntilGone(page, surface);
  // no backdrop of a menu or a select (the Base UI marks it `data-base-ui-inert`) is left over the page
  await page.waitForFunction(
    (most) => document.querySelectorAll("[data-base-ui-inert]").length <= most,
    backdrops
  );
}

/**
 * Escape, asked again until the overlay leaves: one that has just opened (or opened again during the exit of the
 * last one) listens for the key only after its first effects, so an Escape sent right after it showed can be lost.
 */
async function escapeUntilGone(page: Page, surface: Locator) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one try at a time
    await page.keyboard.press("Escape");
    const gone = await surface
      .first()
      .waitFor({ state: "detached", timeout: 1500 })
      .then(
        () => true,
        () => false
      );
    if (gone) {
      return;
    }
  }
  await surface.first().waitFor({ state: "detached" });
}

async function exerciseGallery(page: Page) {
  await openAndClose(
    page,
    { name: "Abrir diálogo", role: "button" },
    { role: "dialog" }
  );
  await openAndClose(
    page,
    { name: "Abrir formulário", role: "button" },
    { name: "Novo cadastro", role: "dialog" }
  );
  await page.getByRole("button", { name: "Abrir popover" }).click();
  await page.getByText("Informe o custo do item para ver a margem.").waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByText("Informe o custo do item para ver a margem.")
    .waitFor({ state: "detached" });
  await openAndClose(
    page,
    { name: "Abrir menu", role: "button" },
    { role: "menu" }
  );
  await openAndClose(
    page,
    { name: "Método de pagamento", role: "combobox" },
    { role: "listbox" }
  );
  await page
    .getByRole("button", { name: "Saldo confirmado pelo servidor" })
    .hover();
  // Base UI's tooltip popup has no tooltip role; the text is what the person reads
  await page.getByText("Saldo confirmado pelo servidor").waitFor();
  await page.mouse.move(0, 0);
  await page
    .getByText("Saldo confirmado pelo servidor")
    .waitFor({ state: "detached" });
  // the height of the collapsible panel (200 ms): open and close it, waiting for the panel to settle
  const recurring = page.getByRole("button", { name: "Despesas recorrentes" });
  await recurring.click();
  await page.getByText("Aluguel e internet, todo dia 5.").waitFor();
  await page.waitForTimeout(300);
  await recurring.click();
  await page
    .getByText("Aluguel e internet, todo dia 5.")
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Mostrar aviso" }).click();
  await page.getByText("Venda registrada").waitFor();
  await page.waitForTimeout(300);
}

/** The files of the sale screen on the new interface: the other screens of `src/sales` are still the old CSS. */
const SALE_SOURCES = [
  "src/sales/confirmed-sale-parts.tsx",
  "src/sales/offline-sale-panels.tsx",
  "src/sales/sale-confirmed-panel.tsx",
  "src/sales/sale-fields.tsx",
  "src/sales/sale-item-editor.tsx",
  "src/sales/sale-page.tsx",
  "src/sales/sale-payment-section.tsx",
  "src/sales/sale-summary-panel.tsx",
  "src/sales/sale-variant-picker.tsx",
];

/** One state of the sale screen: the same screen, opened in the state the test builds (`ui-sale-states.ts`). */
const saleScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `venda ${name}`,
  open,
  sourceDirs: SALE_SOURCES,
});

/** The files of the products screen on the new interface, with the images panel. */
const PRODUCT_SOURCES = [
  "src/catalog/product-dialog.tsx",
  "src/catalog/product-fields.tsx",
  "src/catalog/product-form.tsx",
  "src/catalog/product-list.tsx",
  "src/catalog/product-media-crop.tsx",
  "src/catalog/product-media-list.tsx",
  "src/catalog/product-media-panel.tsx",
  "src/catalog/product-variant-parts.tsx",
  "src/catalog/product-variant-price-section.tsx",
  "src/catalog/product-variant-sku-section.tsx",
  "src/catalog/product-variants-form.tsx",
  "src/catalog/product-variants-panel.tsx",
  "src/catalog/products-page-parts.tsx",
  "src/catalog/products-page.tsx",
];

/** One state of the products screen (`ui-product-states.ts`). */
const productScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `produtos ${name}`,
  open,
  sourceDirs: PRODUCT_SOURCES,
});

/** The files of the import of a spreadsheet (corte 2.5): a chunk of its own, opened from the products screen. */
const IMPORT_SOURCES = [
  "src/catalog/product-import",
  "src/catalog/products-page-parts.tsx",
  "src/catalog/products-page.tsx",
];

/** One state of the import of a spreadsheet (`ui-product-states.ts`). */
const importScreen = (
  name: string,
  open: (page: Page) => Promise<void>
): UiScreen => ({
  name: `importar planilha ${name}`,
  open,
  sourceDirs: IMPORT_SOURCES,
});

/** Opens the menu of a row and closes it with Escape, so the motion recorder sees it. */
async function exerciseProductMenu(page: Page) {
  await openAndClose(
    page,
    { name: "Mais ações para Calça jeans", role: "button" },
    { role: "menu" }
  );
}

/** The files of Categorias on the new interface (the pieces it shares with Clientes and the catalog are listed in each). */
const CATEGORY_SOURCES = [
  "src/catalog/categories-page.tsx",
  "src/catalog/category-form.tsx",
  "src/catalog/category-list.tsx",
  "src/catalog/products-page-parts.tsx",
  "src/catalog/screen-parts.tsx",
  "src/app-shell/connection-required-notice.tsx",
];

/** The files of Clientes on the new interface. */
const CUSTOMER_SOURCES = [
  "src/catalog/product-fields.tsx",
  "src/catalog/products-page-parts.tsx",
  "src/catalog/screen-parts.tsx",
  "src/customers/customer-form.tsx",
  "src/customers/customer-list.tsx",
  "src/customers/customers-page-parts.tsx",
  "src/customers/customers-page.tsx",
];

/** The files of the public catalog of the ERP on the new interface. */
const CATALOG_SOURCES = [
  "src/catalog/product-fields.tsx",
  "src/catalog/products-page-parts.tsx",
  "src/catalog/public-catalog-page.tsx",
  "src/catalog/public-catalog-panels.tsx",
  "src/catalog/screen-parts.tsx",
  "src/app-shell/connection-required-notice.tsx",
];

/** One state of a screen of the lot 2 (`ui-lot2-states.ts`). */
const lot2Screen = (
  title: string,
  sourceDirs: string[],
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `${title} ${name}`,
  open,
  sourceDirs,
});
const categoryScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
) => lot2Screen("categorias", CATEGORY_SOURCES, name, open, exercise);
const customerScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
) => lot2Screen("clientes", CUSTOMER_SOURCES, name, open, exercise);
const catalogScreen = (name: string, open: (page: Page) => Promise<void>) =>
  lot2Screen("catálogo público", CATALOG_SOURCES, name, open);

/** Opens the menu of a row and closes it with Escape, so the motion recorder sees it. */
const exerciseRowMenu = (name: string) => (page: Page) =>
  openAndClose(
    page,
    { name: `Mais ações para ${name}`, role: "button" },
    { role: "menu" }
  );

async function exerciseSalePayment(page: Page) {
  await openAndClose(
    page,
    { name: "Perfil de pagamento", role: "combobox" },
    { role: "listbox" }
  );
}

/** The files of the expenses screen on the new interface (the month picker is Despesas' only). */
const EXPENSE_SOURCES = [
  "src/expenses/expense-categories-panel.tsx",
  "src/expenses/expense-category-form.tsx",
  "src/expenses/expense-fields.tsx",
  "src/expenses/expense-form.tsx",
  "src/expenses/expense-list.tsx",
  "src/expenses/expense-rule-form.tsx",
  "src/expenses/expense-rules-panel.tsx",
  "src/expenses/expenses-page.tsx",
  "src/expenses/month-picker.tsx",
];

/** One state of the expenses screen (`ui-expense-states.ts`). */
const expenseScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `despesas ${name}`,
  open,
  sourceDirs: EXPENSE_SOURCES,
});

/** The category filter and the grid of months (the popover of the month picker), each opened and closed. */
async function exerciseExpenseCategoryFilter(page: Page) {
  await openAndClose(
    page,
    { name: "Categoria", role: "combobox" },
    { role: "listbox" }
  );
  await openAndClose(
    page,
    { name: "Mês de competência, Outubro de 2026", role: "button" },
    { name: "Mês de competência", role: "dialog" }
  );
}

/** The files of Resultado and Metas on the new interface (the month picker is Despesas'). */
const RESULT_SOURCES = [
  "src/dashboard/dashboard-page.tsx",
  "src/dashboard/goal-card.tsx",
  "src/dashboard/goal-form.tsx",
  "src/dashboard/goal-history.tsx",
  "src/dashboard/goals-panel.tsx",
  "src/dashboard/offline-copy-notice.tsx",
  "src/dashboard/parts-bar.tsx",
  "src/dashboard/period-picker.tsx",
  "src/dashboard/quality-banner.tsx",
  "src/dashboard/result-cards.tsx",
  "src/dashboard/result-chain.tsx",
  "src/dashboard/result-chart.tsx",
];

/** One state of Resultado and Metas (`ui-result-states.ts`). */
const resultScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `resultado ${name}`,
  open,
  sourceDirs: RESULT_SOURCES,
});

/** The select of the indicator and the dialog that asks before cancelling a goal. */
async function exerciseGoalOverlays(page: Page) {
  await openAndClose(
    page,
    { name: "Cancelar meta Outubro forte", role: "button" },
    { role: "dialog" }
  );
  await page.getByRole("button", { name: "Nova meta" }).click();
  await openAndClose(
    page,
    { name: "Indicador", role: "combobox" },
    { role: "listbox" }
  );
}

/** The files of the Início (`ui-home-states.ts`). */
const HOME_SOURCES = ["src/home"];

/** One state of the Início, at `/` in the real shell. */
const homeScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  name: `início ${name}`,
  ...(exercise ? { exercise } : {}),
  open,
  sourceDirs: HOME_SOURCES,
});

/** The "Mais" panel of the phone and the numbers under the chart and the map: open each and close it, waiting for the exit. */
async function exerciseHomePanels(page: Page) {
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  const sheet = page.getByRole("dialog", { name: "Mais" });
  await more.click();
  await sheet.waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  // under the chart and under the map
  for (const numbers of await page
    .getByRole("button", { name: "Ver os números" })
    .all()) {
    // biome-ignore lint/performance/noAwaitInLoops: one panel at a time
    await numbers.click();
    await page.waitForTimeout(300);
    await numbers.click();
    await page.waitForTimeout(300);
  }
}

/** The files of the sales history on the new interface. */
const HISTORY_SOURCES = [
  "src/sales/confirmed-sale-parts.tsx",
  "src/sales/sale-history-list.tsx",
  "src/sales/sale-history-page.tsx",
];

/** One state of the sales history (`ui-history-states.ts`). */
const historyScreen = (
  name: string,
  open: (page: Page) => Promise<void>
): UiScreen => ({
  name: `histórico ${name}`,
  open,
  sourceDirs: HISTORY_SOURCES,
});

/** The files of the sale detail (with its return, cancellation and customer panels). */
const SALE_DETAIL_SOURCES = [
  "src/sales/operation-failure-notice.tsx",
  "src/sales/sale-cancel-panel.tsx",
  "src/sales/sale-customer-panel.tsx",
  "src/sales/sale-detail-page.tsx",
  "src/sales/sale-id-missing.tsx",
  "src/sales/sale-notice-region.tsx",
  "src/sales/sale-operation-actions.tsx",
  "src/sales/sale-reason-fields.tsx",
  "src/sales/sale-receipt.tsx",
  "src/sales/sale-return-panel.tsx",
  "src/sales/sale-return-table.tsx",
];

/** One state of the sale detail or of the customer page (`ui-sale-detail-states.ts`). */
const saleDetailScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `detalhe da venda ${name}`,
  open,
  sourceDirs: SALE_DETAIL_SOURCES,
});

async function exerciseCancelReason(page: Page) {
  await page.getByRole("button", { name: "Voltar" }).click();
  await openAndClose(
    page,
    { name: "Motivo (opcional)", role: "combobox" },
    { role: "listbox" }
  );
}

async function exerciseSaleCustomer(page: Page) {
  // the customer is chosen in a form dialog: opened, the list of customers opened and closed inside it, then closed
  await page
    .getByRole("button", { exact: true, name: "Trocar cliente" })
    .click();
  const choose = page.getByRole("dialog", { name: "Trocar cliente" });
  await choose.waitFor();
  await openAndClose(
    page,
    { name: "Cliente", role: "combobox" },
    { role: "listbox" }
  );
  await page.keyboard.press("Escape");
  await choose.waitFor({ state: "detached" });
  await openAndClose(
    page,
    { name: "Remover cliente", role: "button" },
    { role: "dialog" }
  );
}

/** The files of the stock screen on the new interface (the logic files of `src/inventory` have no markup). */
const STOCK_SOURCES = [
  "src/inventory/inventory-page.tsx",
  "src/inventory/stock-command-panel.tsx",
  "src/inventory/stock-panel-fields.tsx",
  "src/inventory/stock-row-actions.tsx",
];

/** One state of the stock screen: the same screen, opened in the state the test builds (`ui-stock-states.ts`). */
const stockScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `estoque ${name}`,
  open,
  sourceDirs: STOCK_SOURCES,
});

async function exerciseStockReason(page: Page) {
  await openAndClose(
    page,
    { name: "Motivo da baixa", role: "combobox" },
    { role: "listbox" }
  );
}

/** The files of Aparelhos and Pendências on the new interface (the expired access and the loading are shell pieces, below). */
const DEVICE_SOURCES = [
  "src/offline/runtime/device-item.tsx",
  "src/offline/runtime/devices-page.tsx",
];
const ATTENTION_SOURCES = [
  "src/offline/attention-panel.tsx",
  "src/offline/runtime/attention-page.tsx",
];

/** One state of Aparelhos (`ui-device-states.ts`). */
const deviceScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `aparelhos ${name}`,
  open,
  sourceDirs: DEVICE_SOURCES,
});

/** One state of Pendências. */
const attentionScreen = (
  name: string,
  open: (page: Page) => Promise<void>
): UiScreen => ({
  name: `pendências ${name}`,
  open,
  sourceDirs: ATTENTION_SOURCES,
});

/** Opens the confirmation of a revocation and closes it with Escape, so the motion recorder sees the dialog. */
async function exerciseRevoke(page: Page) {
  await openAndClose(
    page,
    { name: "Revogar o aparelho Celular da Ana", role: "button" },
    { role: "dialog" }
  );
}

/** The files of the payment profiles screen on the new interface (the draft and the fee model have no markup). */
const PAYMENT_SOURCES = [
  "src/payment-profiles/payment-profile-form.tsx",
  "src/payment-profiles/payment-profile-list.tsx",
  "src/payment-profiles/payment-profiles-page.tsx",
];

/** One state of the payment profiles screen (`ui-payment-states.ts`). */
const paymentScreen = (
  name: string,
  open: (page: Page) => Promise<void>,
  exercise?: UiScreen["exercise"]
): UiScreen => ({
  ...(exercise ? { exercise } : {}),
  name: `perfis de pagamento ${name}`,
  open,
  sourceDirs: PAYMENT_SOURCES,
});

async function exercisePaymentMethod(page: Page) {
  await openAndClose(
    page,
    { name: "Método", role: "combobox" },
    { role: "listbox" }
  );
}

/**
 * The files of the pieces around the screens on the new interface: the 404, the failure of a screen, the loading,
 * the notices of the session and the acceptance, "Sair" with work to lose and the expired access.
 */
const SHELL_PIECE_SOURCES = [
  "src/app-shell/connection-required-notice.tsx",
  "src/app-shell/error-boundary.tsx",
  "src/app-shell/legal-acceptance-notice.tsx",
  "src/app-shell/not-found-page.tsx",
  "src/app-shell/page-loading.tsx",
  "src/app-shell/session-ended-notice.tsx",
  "src/app-shell/state-panel.tsx",
  "src/offline/logout-dialog.tsx",
  "src/offline/runtime/offline-access-expired.tsx",
  "src/offline-poc/screens-lab-shell-pieces.tsx",
];

/** One piece in its state, drawn by the gallery of the pieces (`/ui-pecas-do-shell?estado=…`), with synthetic data. */
const shellPieceScreen = (
  name: string,
  state: string,
  ready: (page: Page) => Promise<void>
): UiScreen => ({
  name: `peças do shell ${name}`,
  open: async (page) => {
    await page.goto(`/ui-pecas-do-shell?estado=${state}`);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
  },
  sourceDirs: SHELL_PIECE_SOURCES,
});

const headingOf =
  (name: string, level = 1) =>
  async (page: Page) => {
    await page.getByRole("heading", { level, name }).waitFor();
  };

async function openLegalPage(page: Page, path: string, title: string) {
  await page.goto(path);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  // the title shows while the text still loads: wait for the text
  await page.getByText("Versão 1. Em vigor desde:").waitFor();
  await settle(page);
}

/** The files of the entry pages on the new interface (`/entrar` and the whole password family, "Trocar senha" too). */
const ENTRY_SOURCES = [
  "src/sign-in/change-password-page.tsx",
  "src/sign-in/confirm-email-page.tsx",
  "src/sign-in/email-sign-in-form.tsx",
  "src/sign-in/entry-ui.tsx",
  "src/sign-in/forgot-password-page.tsx",
  "src/sign-in/reset-password-page.tsx",
  "src/sign-in/sign-in-page.tsx",
  "src/sign-in/sign-up-page.tsx",
  "src/sign-in/unlock-page.tsx",
];

/** One state of an entry page (`ui-entry-states.ts`, `ui-password-states.ts`). */
const entryScreen = (name: string, open: UiScreen["open"]): UiScreen => ({
  name,
  open,
  sourceDirs: ENTRY_SOURCES,
});

/** The files of the first access, the acceptance and the legal texts, which stand outside the shell on the entry card. */
const ACCOUNT_SOURCES = [
  "src/legal/acceptance/acceptance-page.tsx",
  "src/legal/legal-app.tsx",
  "src/legal/legal-frame.tsx",
  "src/legal/legal-page.tsx",
  "src/organization/organization-setup.tsx",
  "src/sign-in/entry-ui.tsx",
];

/** The files of the Assinatura, with the notice of grace of the shell. */
const SUBSCRIPTION_SOURCES = [
  "src/subscription",
  "src/app-shell/grace-notice.tsx",
];

const subscriptionScreen = (
  name: string,
  open: UiScreen["open"]
): UiScreen => ({
  name: `assinatura ${name}`,
  open,
  sourceDirs: SUBSCRIPTION_SOURCES,
});

/** One state of the first access, the acceptance or a legal page (`ui-account-states.ts`). */
const accountScreen = (name: string, open: UiScreen["open"]): UiScreen => ({
  name,
  open,
  sourceDirs: ACCOUNT_SOURCES,
});

export const SCREENS: UiScreen[] = [
  {
    exercise: exerciseGallery,
    name: "galeria",
    open: async (page) => {
      await page.goto("/ui-galeria");
      await page
        .getByRole("heading", { name: "Galeria da interface" })
        .waitFor();
      // the charts come from their own chunk: measure them drawn, not the boxes that hold their place
      await page
        .locator("[data-chart-loading]")
        .first()
        .waitFor({ state: "detached" });
      // and the calendar of the date pickers, from its own chunk too
      await page
        .locator("[data-calendar-loading]")
        .first()
        .waitFor({ state: "detached" });
      await page.evaluate(() => document.fonts.ready);
    },
    sourceDirs: ["src/ui-gallery"],
  },
  entryScreen("entrar só com o Google", entryStates.googleOnly),
  entryScreen("entrar", entryStates.signIn),
  entryScreen("entrar desafio bloqueado", entryStates.signInBlocked),
  entryScreen("entrar abrindo o Google", entryStates.signInGooglePending),
  entryScreen("entrar e-mail incompleto", entryStates.signInEmailIncomplete),
  entryScreen("entrar e-mail completo", entryStates.signInEmailComplete),
  entryScreen("entrar preenchido pelo gerenciador", entryStates.signInFilled),
  entryScreen("entrar senha incorreta", entryStates.signInIncorrect),
  entryScreen("entrar pausado", entryStates.signInPaused),
  entryScreen("entrar sem conexão, sessão acabou", entryStates.signInOffline),
  entryScreen("criar conta", entryStates.signUp),
  entryScreen("criar conta abrindo o Google", entryStates.signUpGooglePending),
  entryScreen(
    "criar conta e-mail incompleto",
    entryStates.signUpEmailIncomplete
  ),
  entryScreen("criar conta e-mail completo", entryStates.signUpEmailComplete),
  entryScreen("criar conta sem o aceite", entryStates.signUpAcceptMissing),
  entryScreen("criar conta senha vazada", entryStates.signUpCompromised),
  entryScreen("criar conta criando", entryStates.signUpCreating),
  entryScreen("criar conta confirmando pessoa", entryStates.signUpChecking),
  entryScreen("criar conta desafio interativo", entryStates.signUpInteractive),
  entryScreen("criar conta desafio bloqueado", entryStates.signUpBlocked),
  entryScreen("confirme seu e-mail", entryStates.signUpConfirm),
  entryScreen("confirmar e-mail sem link", passwordStates.confirmNoLink),
  entryScreen("confirmando o e-mail", passwordStates.confirmChecking),
  entryScreen("e-mail confirmado", passwordStates.confirmDone),
  entryScreen("confirmar e-mail link vencido", passwordStates.confirmExpired),
  entryScreen(
    "confirmar e-mail link vencido, reenviado",
    passwordStates.confirmExpiredResent
  ),
  entryScreen("confirmar e-mail limite", passwordStates.confirmLimit),
  entryScreen(
    "confirmar e-mail indisponível",
    passwordStates.confirmUnavailable
  ),
  entryScreen("esqueci a senha", passwordStates.forgot),
  entryScreen(
    "esqueci a senha e-mail incompleto",
    passwordStates.forgotIncompleteEmail
  ),
  entryScreen("esqueci a senha enviando", passwordStates.forgotSending),
  entryScreen("esqueci a senha enviado", passwordStates.forgotSent),
  entryScreen("esqueci a senha limite", passwordStates.forgotLimit),
  entryScreen(
    "esqueci a senha desafio bloqueado",
    passwordStates.forgotBlocked
  ),
  entryScreen("nova senha", passwordStates.reset),
  entryScreen("nova senha curta", passwordStates.resetShort),
  entryScreen("nova senha desafio falhou", passwordStates.resetChallengeFailed),
  entryScreen("nova senha desafio bloqueado", passwordStates.resetBlocked),
  entryScreen("nova senha trocando", passwordStates.resetChanging),
  entryScreen("nova senha trocada", passwordStates.resetDone),
  entryScreen("nova senha link vencido", passwordStates.resetLinkExpired),
  entryScreen("nova senha sem link", passwordStates.resetNoLink),
  entryScreen("liberar a entrada liberando", passwordStates.unlockChecking),
  entryScreen("liberar a entrada liberada", passwordStates.unlockDone),
  entryScreen("liberar a entrada link inválido", passwordStates.unlockInvalid),
  entryScreen("liberar a entrada sem link", passwordStates.unlockNoLink),
  entryScreen(
    "liberar a entrada indisponível",
    passwordStates.unlockUnavailable
  ),
  entryScreen("trocar senha", passwordStates.changePassword),
  entryScreen(
    "trocar senha atual errada",
    passwordStates.changePasswordWrongCurrent
  ),
  entryScreen("trocar senha trocando", passwordStates.changePasswordChanging),
  entryScreen("trocar senha trocada", passwordStates.changePasswordDone),
  entryScreen("trocar senha pausada", passwordStates.changePasswordPaused),
  entryScreen(
    "trocar senha entre de novo",
    passwordStates.changePasswordRecent
  ),
  entryScreen(
    "trocar senha conta do Google",
    passwordStates.changePasswordNoPassword
  ),
  accountScreen("política de privacidade", (page) =>
    openLegalPage(page, "/privacidade", "Política de Privacidade")
  ),
  accountScreen("termos de uso", (page) =>
    openLegalPage(page, "/termos", "Termos de Uso")
  ),
  accountScreen("texto legal carregando", legalStates.loading),
  accountScreen("texto legal não abriu", legalStates.failed),
  accountScreen("primeiro acesso", firstAccessStates.empty),
  accountScreen(
    "primeiro acesso com erro no nome",
    firstAccessStates.fieldErrors
  ),
  accountScreen("primeiro acesso abrindo", firstAccessStates.opening),
  accountScreen("primeiro acesso recusado", firstAccessStates.failed),
  accountScreen("aceite", acceptanceStates.first),
  accountScreen("aceite de versão nova", acceptanceStates.newVersion),
  accountScreen("aceite sem a caixa", acceptanceStates.boxMissing),
  accountScreen("aceite registrando", acceptanceStates.saving),
  accountScreen("aceite não registrou", acceptanceStates.saveFailed),
  accountScreen("aceite carregando", acceptanceStates.loading),
  accountScreen("aceite não carregou", acceptanceStates.loadFailed),
  accountScreen("aceite já feito", acceptanceStates.done),
  saleScreen("vazia", saleStates.empty),
  saleScreen("com itens", saleStates.withItems),
  saleScreen("pagamento a crédito", saleStates.payment, exerciseSalePayment),
  saleScreen("erro nos campos", saleStates.fieldErrors),
  saleScreen("confirmada", saleStates.confirmed),
  saleScreen("sem conexão", saleStates.offline),
  stockScreen("lista", stockStates.list),
  stockScreen("carregando", stockStates.loading),
  stockScreen("vazio", stockStates.empty),
  stockScreen("busca sem resultado", stockStates.noResult),
  stockScreen("erro ao ler", stockStates.error),
  stockScreen("recebimento bloqueado", stockStates.receiveBlocked),
  stockScreen("recebimento com erros", stockStates.receiveErrors),
  stockScreen("recebimento a confirmar", stockStates.receiveConfirming),
  stockScreen("recebimento registrado", stockStates.receiveDone),
  stockScreen("recebimento sem resposta", stockStates.receiveLocked),
  stockScreen("contagem", stockStates.count),
  stockScreen(
    "baixa sem observação",
    stockStates.writeOffNote,
    exerciseStockReason
  ),
  stockScreen("baixa recusada", stockStates.writeOffRefused),
  stockScreen("sem conexão", stockStates.offline),
  stockScreen("sem conexão, recebimento guardado", stockStates.offlineKept),
  expenseScreen("lista", expenseStates.list, exerciseExpenseCategoryFilter),
  expenseScreen("grade de meses aberta", expenseStates.monthGrid),
  expenseScreen("erros nos campos", expenseStates.errors),
  expenseScreen("recorrentes e o diálogo da regra", expenseStates.rules),
  expenseScreen(
    "categorias e o diálogo da categoria",
    expenseStates.categories
  ),
  resultScreen("mês incompleto e gráfico de vendas", resultStates.list),
  resultScreen("gráfico de vendas e custos e a tabela", resultStates.chart),
  resultScreen("metas", resultStates.goals, exerciseGoalOverlays),
  resultScreen("sem dados", resultStates.empty),
  resultScreen("sem custo conhecido", resultStates.noCost),
  homeScreen("com vendas", homeStates.sold, exerciseHomePanels),
  homeScreen("loja nova", homeStates.fresh),
  homeScreen("erro nos números", homeStates.error),
  homeScreen("sem rede, com cópia", homeStates.offlineWithCopy),
  homeScreen("sem rede, sem cópia", homeStates.offlineNoCopy),
  subscriptionScreen("oferta com Pix", subscriptionStates.offer),
  subscriptionScreen("Pix aguardando o banco", subscriptionStates.pixWaiting),
  subscriptionScreen("Pro ativo", subscriptionStates.active),
  subscriptionScreen("cancelar a renovação", subscriptionStates.cancelDialog),
  subscriptionScreen("carência com o aviso", subscriptionStates.grace),
  resultScreen("nova meta com erro", resultStates.newGoalErrors),
  resultScreen("sem conexão", resultStates.offline),
  historyScreen("lista", historyStates.list),
  historyScreen("carregando", historyStates.loading),
  historyScreen("sem conexão", historyStates.offline),
  historyScreen("filtros ativos", historyStates.filters),
  saleDetailScreen("aberto", saleDetailStates.detail),
  saleDetailScreen("carregando", saleDetailStates.loading),
  saleDetailScreen("devolução com erro", saleDetailStates.returnError),
  saleDetailScreen(
    "cancelamento revisado",
    saleDetailStates.cancelReview,
    exerciseCancelReason
  ),
  saleDetailScreen(
    "cliente da venda",
    saleDetailStates.customer,
    exerciseSaleCustomer
  ),
  saleDetailScreen("trocar o cliente", saleDetailStates.customerChoose),
  shellPieceScreen("404", "nao-encontrada", headingOf("Página não encontrada")),
  shellPieceScreen(
    "falha da tela",
    "erro",
    headingOf("Algo deu errado nesta tela")
  ),
  shellPieceScreen("carregando", "carregando", async (page) => {
    await page.getByRole("status").getByText("Carregando…").waitFor();
  }),
  shellPieceScreen("avisos de sessão e aceite", "avisos", async (page) => {
    await page.getByText("Sua sessão acabou.").first().waitFor();
  }),
  shellPieceScreen(
    "sair com trabalho a perder",
    "sair",
    headingOf("Há trabalho que ainda não foi enviado", 2)
  ),
  shellPieceScreen("sair confirmando o descarte", "sair", async (page) => {
    await page.getByRole("button", { name: "Descartar e sair…" }).click();
    await page
      .getByRole("button", { exact: true, name: "Descartar e sair" })
      .waitFor();
  }),
  shellPieceScreen(
    "acesso sem internet vencido",
    "acesso-vencido",
    headingOf("O acesso sem internet venceu")
  ),
  productScreen("lista", productStates.list, exerciseProductMenu),
  productScreen("novo produto num passo só", productStates.create),
  productScreen("edição com erro no nome", productStates.edit),
  productScreen("produto aberto sem internet", productStates.offline),
  productScreen("variantes, opções e combinação", productStates.variantsForm),
  productScreen("imagens, remoção pedindo confirmação", productStates.media),
  productScreen(
    "imagens, recorte da imagem escolhida",
    productStates.mediaCrop
  ),
  importScreen(
    "prévia com erro, já existe e sem categoria",
    productStates.importPreview
  ),
  importScreen(
    "resultado com a linha que não entrou",
    productStates.importResult
  ),
  categoryScreen("lista", categoryStates.list, exerciseRowMenu("Camisetas")),
  categoryScreen("remover", categoryStates.remove),
  categoryScreen("sem conexão", categoryStates.offline),
  customerScreen("lista", customerStates.list, exerciseRowMenu("Ana Lima")),
  customerScreen("cliente parecido", customerStates.duplicate),
  customerScreen("sem conexão, cliente guardado", customerStates.offline),
  catalogScreen("no ar", catalogStates.live),
  catalogScreen("endereço recusado", catalogStates.slugError),
  catalogScreen("sem conexão", catalogStates.offline),
  paymentScreen("lista", paymentStates.list),
  paymentScreen("edição", paymentStates.edit, exercisePaymentMethod),
  paymentScreen("erros nos campos", paymentStates.errors),
  deviceScreen("lista", deviceStates.list, exerciseRevoke),
  deviceScreen("carregando", deviceStates.loading),
  deviceScreen("vazio", deviceStates.empty),
  deviceScreen("erro ao ler", deviceStates.error),
  deviceScreen("sem conexão", deviceStates.offline),
  deviceScreen("login antigo", deviceStates.sessionOld),
  deviceScreen("confirmação aberta", deviceStates.revokeConfirming),
  attentionScreen("com itens", attentionStates.items),
  attentionScreen("descartando", attentionStates.discarding),
  attentionScreen("vazio", attentionStates.empty),
];
