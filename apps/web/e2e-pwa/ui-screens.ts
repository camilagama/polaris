/// <reference lib="dom" />
// Only types from Playwright: the source rules (scripts/ui-source-rules.test.ts) read this list under Vitest.
import type { BrowserContext, Page } from "@playwright/test";
import {
  acceptanceStates,
  firstAccessStates,
  legalStates,
} from "./ui-account-states";
import { entryStates, settle } from "./ui-entry-states";
import { historyStates } from "./ui-history-states";
import { passwordStates } from "./ui-password-states";
import { paymentStates } from "./ui-payment-states";
import { productStates } from "./ui-product-states";
import { saleStates } from "./ui-sale-states";
import { stockStates } from "./ui-stock-states";

/**
 * The screens the interface guardrails run on (t180), served by the static server of the pwa-e2e build under
 * the CSP of `_headers`. The list grows with each migrated screen: docs/runbooks/testes-de-tela.md says how.
 *
 * - `migrated`: a screen of the new interface (`data-ui`, tokens v5.1): touch area of 48 px, and its source
 *   folder is read by the source rules (`scripts/ui-source-rules.test.ts`).
 * - `legacy`: a screen of the old CSS, measured as it is (touch area of 44 px, the rule it still follows); it
 *   cannot change before its migration, so what it fails today is listed in `known`, check by check, and the
 *   test fails if the list is not exactly what the browser finds (a new fault, or one fixed and still listed).
 */
export interface UiScreen {
  /** Opens and closes every overlay of the screen, so the motion recorder sees them. */
  exercise?: (page: Page) => Promise<void>;
  /** Faults of a legacy screen that wait for its migration, by check. Always empty for a migrated screen. */
  known?: Partial<Record<UiCheck, string[]>>;
  name: string;
  /** Opens the screen in one of the states, and waits until it is drawn. */
  open: (page: Page, context: BrowserContext) => Promise<void>;
  /** Source folders (or files) under `src/` of a migrated screen, for the source rules. */
  sourceDirs: string[];
  status: "legacy" | "migrated";
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
 * - overflow (1): the widths decide what fits; theme and pointer do not move a box;
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
  overflow: [light("320", true), light("360", true), light("1280", false)],
  touch: [light("320", true), light("360", true), light("1280", true)],
};

/** The context of the motion checks (5): once per state with `exercise`, and once more with `reduce`. */
export const MOTION_CONTEXT: UiContext = light("360", true);

/** Opens an overlay by its trigger, waits for it, and closes it with Escape, waiting for the exit too. */
async function openAndClose(
  page: Page,
  trigger: { name: string; role: "button" | "combobox" },
  popup: { name?: string; role: "dialog" | "listbox" | "menu" }
) {
  await page
    .getByRole(trigger.role, { exact: true, name: trigger.name })
    .first()
    .click();
  const surface = page.getByRole(
    popup.role,
    popup.name ? { name: popup.name } : {}
  );
  await surface.first().waitFor();
  await page.keyboard.press("Escape");
  await surface.waitFor({ state: "detached" });
}

async function exerciseGallery(page: Page) {
  await openAndClose(
    page,
    { name: "Abrir diálogo", role: "button" },
    { role: "dialog" }
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
  status: "migrated",
});

/** The files of the products screen on the new interface: the images panel and the categories are still the old CSS. */
const PRODUCT_SOURCES = [
  "src/catalog/product-fields.tsx",
  "src/catalog/product-form.tsx",
  "src/catalog/product-list.tsx",
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
  status: "migrated",
});

/** Opens the menu of a row and closes it with Escape, so the motion recorder sees it. */
async function exerciseProductMenu(page: Page) {
  await openAndClose(
    page,
    { name: "Mais ações para Calça jeans", role: "button" },
    { role: "menu" }
  );
}

async function exerciseSalePayment(page: Page) {
  await openAndClose(
    page,
    { name: "Perfil de pagamento", role: "combobox" },
    { role: "listbox" }
  );
}

/** The files of the sales history and of the sale detail on the new interface: the panels of the detail are still old. */
const HISTORY_SOURCES = [
  "src/sales/confirmed-sale-parts.tsx",
  "src/sales/sale-detail-page.tsx",
  "src/sales/sale-history-list.tsx",
  "src/sales/sale-history-page.tsx",
  "src/sales/sale-receipt.tsx",
];

/** One state of the sales history (`ui-history-states.ts`). */
const historyScreen = (
  name: string,
  open: (page: Page) => Promise<void>
): UiScreen => ({
  name: `histórico ${name}`,
  open,
  sourceDirs: HISTORY_SOURCES,
  status: "migrated",
});

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
  status: "migrated",
});

async function exerciseStockReason(page: Page) {
  await openAndClose(
    page,
    { name: "Motivo da baixa", role: "combobox" },
    { role: "listbox" }
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
  status: "migrated",
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
 * the notices of the session, the acceptance and the new version, "Sair" with work to lose and the expired access.
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
  "src/pwa/update-banner.tsx",
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
  status: "migrated",
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
  status: "migrated",
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

/** One state of the first access, the acceptance or a legal page (`ui-account-states.ts`). */
const accountScreen = (name: string, open: UiScreen["open"]): UiScreen => ({
  name,
  open,
  sourceDirs: ACCOUNT_SOURCES,
  status: "migrated",
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
      await page.evaluate(() => document.fonts.ready);
    },
    sourceDirs: ["src/ui-gallery"],
    status: "migrated",
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
  historyScreen("lista", historyStates.list),
  historyScreen("sem conexão", historyStates.offline),
  historyScreen("período invertido", historyStates.periodError),
  shellPieceScreen("404", "nao-encontrada", headingOf("Página não encontrada")),
  shellPieceScreen(
    "falha da tela",
    "erro",
    headingOf("Algo deu errado nesta tela")
  ),
  shellPieceScreen("carregando", "carregando", async (page) => {
    await page.getByRole("status").getByText("Carregando…").waitFor();
  }),
  shellPieceScreen(
    "avisos de sessão, aceite e nova versão",
    "avisos",
    async (page) => {
      await page.getByText("Sua sessão acabou.").first().waitFor();
      await page.getByText("Há uma nova versão do Polaris").first().waitFor();
    }
  ),
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
  productScreen("edição com erro no nome", productStates.edit),
  productScreen("variantes, opções e combinação", productStates.variantsForm),
  paymentScreen("lista", paymentStates.list),
  paymentScreen("edição", paymentStates.edit, exercisePaymentMethod),
  paymentScreen("erros nos campos", paymentStates.errors),
];
