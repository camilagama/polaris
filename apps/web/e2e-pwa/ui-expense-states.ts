/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the expenses screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=expenses`), with the categories, the expenses of the month and the recurring rules
 * answered by the test (`page.route`), synthetic data only. A few states, as for the other screens of the lab: each
 * one starts the runtime of the lab in every context of the map, and the CI job has a limit of 30 minutes (five since the forms became dialogs, UI-H: each dialog is measured open). The empty
 * list, the loading, the list that could not be read, the voided tab and the saves are proved in
 * `e2e/expenses.e2e.ts` and in the captures of the pull request. The lab's own controls are hidden at the end of each
 * state, so what is measured is the screen alone.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const category = (
  n: number,
  groupKey: string,
  name: string,
  status: "active" | "archived" = "active"
) => ({
  archivedAt: status === "archived" ? NOW : null,
  createdAt: NOW,
  groupKey,
  id: uuid(n),
  name,
  organizationId: ORGANIZATION_ID,
  status,
  systemKey: null,
  updatedAt: NOW,
  version: 1,
});

const MARKETING = category(1, "commercial", "Marketing");
const RENT = category(2, "operational", "Aluguel");
const TAXES = category(3, "taxes", "Impostos");
const CATEGORIES = [
  MARKETING,
  RENT,
  TAXES,
  category(4, "operational", "Material de escritório", "archived"),
];

const expense = (
  n: number,
  description: string,
  amount: string,
  of: ReturnType<typeof category>,
  extra: Record<string, unknown> = {}
) => ({
  amount,
  categoryGroup: of.groupKey,
  categoryId: of.id,
  categoryName: of.name,
  competenceOn: "2026-10-05",
  createdAt: NOW,
  description,
  id: uuid(100 + n),
  organizationId: ORGANIZATION_ID,
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: NOW,
  version: 1,
  voidedAt: null,
  ...extra,
});

// a recurring occurrence with a payee, a description too long for the line, and a plain one: every shape of a row
const EXPENSES = [
  expense(1, "Aluguel de outubro", "1500.50", RENT, {
    competenceOn: "2026-10-01",
    payee: "Imobiliária Centro",
    recurringRuleId: uuid(201),
  }),
  expense(
    2,
    "Anúncio no Instagram para a liquidação de primavera com a coleção nova",
    "250.00",
    MARKETING,
    { competenceOn: "2026-10-08" }
  ),
  expense(3, "DAS do Simples", "389.12", TAXES, { competenceOn: "2026-10-10" }),
];

const rule = (
  n: number,
  description: string,
  amount: string,
  of: ReturnType<typeof category>,
  extra: Record<string, unknown> = {}
) => ({
  amount,
  archivedAt: null,
  categoryGroup: of.groupKey,
  categoryId: of.id,
  categoryName: of.name,
  createdAt: NOW,
  description,
  endsOn: null,
  frequency: "monthly",
  generatedCount: 4,
  id: uuid(200 + n),
  nextOccurrenceOn: "2026-11-01",
  organizationId: ORGANIZATION_ID,
  payee: null,
  startsOn: "2026-07-01",
  status: "active",
  updatedAt: NOW,
  version: 1,
  ...extra,
});

const RULES = [
  rule(1, "Aluguel de outubro", "1500.50", RENT, {
    payee: "Imobiliária Centro",
  }),
  rule(2, "Assinatura do sistema", "49.90", MARKETING, {
    archivedAt: NOW,
    endsOn: "2027-06-30",
    status: "archived",
  }),
];

const byStatus = <T extends { status: string }>(
  rows: readonly T[],
  status: unknown
) =>
  rows.filter((row) => status === "all" || row.status === (status ?? "active"));

async function serveExpenses(page: Page) {
  await page.route("**/rpc/expense/**", (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").pop();
    const input =
      (route.request().postDataJSON() as { json?: Record<string, unknown> })
        .json ?? {};
    if (procedure === "listCategories") {
      return route.fulfill(
        rpc({ categories: byStatus(CATEGORIES, input.status) })
      );
    }
    if (procedure === "listRules") {
      return route.fulfill(rpc({ rules: byStatus(RULES, input.status) }));
    }
    if (procedure === "list") {
      const rows = input.status === "voided" ? [] : EXPENSES;
      return route.fulfill(
        rpc({
          count: rows.length,
          expenses: rows,
          nextCursor: null,
          total: rows.length > 0 ? "2139.62" : "0.00",
        })
      );
    }
    return route.abort("internetdisconnected");
  });
}

/** Starts the lab's runtime and waits for the screen with the list read. */
async function openExpensesLab(page: Page) {
  // the month the screen opens on is the organization's today: keep it the month of the synthetic expenses
  await page.clock.setFixedTime(new Date(NOW));
  await serveExpenses(page);
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=expenses");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Despesas" })
    .waitFor();
  await page.getByText("DAS do Simples").waitFor();
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

export const expenseStates = {
  /** A new expense sent empty, in its dialog: the amount, the category and the description say what is missing. */
  async errors(page: Page) {
    await openExpensesLab(page);
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .click();
    await page.getByRole("button", { name: "Registrar despesa" }).click();
    await page.locator("#expense-description-error").waitFor();
    await showScreenAlone(page);
  },

  /** The list of the month read: a recurring occurrence, a long description and a plain row. */
  async list(page: Page) {
    await openExpensesLab(page);
    await showScreenAlone(page);
  },

  /** The grid of months open over the list: the year arrows, the twelve months and "Este mês" are measured open. */
  async monthGrid(page: Page) {
    await openExpensesLab(page);
    await page
      .getByRole("button", {
        exact: true,
        name: "Mês de competência, Outubro de 2026",
      })
      .click();
    await page.getByRole("dialog", { name: "Mês de competência" }).waitFor();
    await page.getByRole("button", { name: "Este mês" }).waitFor();
    // `showScreenAlone` blurs the focus: the popover stays open on a blur (it closes on Escape or a press outside)
    await showScreenAlone(page);
    await page.getByRole("dialog", { name: "Mês de competência" }).waitFor();
    // the popover is not modal, so the page under it is still on screen: what is measured is the grid, not the controls
    // it covers (the checks skip what is `inert`)
    await page.evaluate(() => {
      for (const child of document.body.children) {
        if (!child.querySelector("[data-slot=popover-content]")) {
          child.setAttribute("inert", "");
        }
      }
    });
  },

  /** The Recorrentes part with the paused rules shown, and the form of a new rule in its dialog. */
  async rules(page: Page) {
    await openExpensesLab(page);
    await page.getByRole("tab", { name: "Recorrentes" }).click();
    await page.getByRole("checkbox", { name: "Mostrar pausadas" }).check();
    await page.getByText("Assinatura do sistema").waitFor();
    await page.getByRole("button", { name: "Nova despesa recorrente" }).click();
    await page.getByLabel("Valor de cada ocorrência (R$)").waitFor();
    await showScreenAlone(page);
  },

  /** The Categorias part with the archived categories shown, and the form of a new category in its dialog. */
  async categories(page: Page) {
    await openExpensesLab(page);
    await page.getByRole("tab", { name: "Categorias" }).click();
    await page
      .getByRole("checkbox", { name: "Mostrar categorias arquivadas" })
      .check();
    await page.getByText("Material de escritório").waitFor();
    await page
      .getByRole("button", { exact: true, name: "Nova categoria" })
      .click();
    await page.getByLabel("Nome da categoria").waitFor();
    await showScreenAlone(page);
  },
};
