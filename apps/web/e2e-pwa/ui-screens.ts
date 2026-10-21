/// <reference lib="dom" />
// Only types from Playwright: the source rules (scripts/ui-source-rules.test.ts) read this list under Vitest.
import type { BrowserContext, Page } from "@playwright/test";
import { entryStates } from "./ui-entry-states";
import { passwordStates } from "./ui-password-states";
import { productStates } from "./ui-product-states";
import { saleStates } from "./ui-sale-states";

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

async function openLegalPage(page: Page, path: string, title: string) {
  await page.goto(path);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  // the title shows while the text still loads: wait for the text
  await page.getByText("Versão 1. Em vigor desde:").waitFor();
  await page.evaluate(() => document.fonts.ready);
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

// the brand link of the legal frame is named "Polaris, início" and shows "P Polaris": a voice command that says what
// is on screen misses it. Fixed with the migration of the legal pages (their frame is legacy markup).
const LEGAL_KNOWN: UiScreen["known"] = {
  axe: ["label-content-name-mismatch: .app-brand"],
};

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
  {
    known: LEGAL_KNOWN,
    name: "política de privacidade",
    open: (page) =>
      openLegalPage(page, "/privacidade", "Política de Privacidade"),
    sourceDirs: [],
    status: "legacy",
  },
  {
    known: LEGAL_KNOWN,
    name: "termos de uso",
    open: (page) => openLegalPage(page, "/termos", "Termos de Uso"),
    sourceDirs: [],
    status: "legacy",
  },
  saleScreen("vazia", saleStates.empty),
  saleScreen("com itens", saleStates.withItems),
  saleScreen("pagamento a crédito", saleStates.payment, exerciseSalePayment),
  saleScreen("erro nos campos", saleStates.fieldErrors),
  saleScreen("confirmada", saleStates.confirmed),
  saleScreen("sem conexão", saleStates.offline),
  productScreen("lista", productStates.list, exerciseProductMenu),
  productScreen("vazia", productStates.empty),
  productScreen("erro do nome", productStates.nameRequired),
  productScreen("edição", productStates.edit),
  productScreen("arquivados", productStates.archived),
  productScreen("busca sem resultado", productStates.emptySearch),
  productScreen("sem conexão", productStates.offline),
  productScreen("variantes", productStates.variants),
  productScreen("variantes, opções e combinação", productStates.variantsForm),
  productScreen("variantes configuradas", productStates.variantsConfigured),
];
