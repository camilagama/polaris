/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  datePickerButton,
  FORM_VIEWPORTS,
  openDatePicker,
  pickDate,
  touchDay,
} from "./date-pickers";
import {
  expectFormDialogLayout,
  expectKeyboardKeepsMainButton,
  FORM_WIDTHS,
  sizeFor,
} from "./form-dialog-checks";
import { expectTabsKeyboard } from "./tabs-keyboard";
import { WORKER_MARK, serveLabWorker } from "./worker-mark";

/**
 * The real expenses screen in a real browser, over a small in-memory stand-in
 * for the server's `expense.*` procedures (answered on the RPC wire format).
 * What the real server enforces is proved on PostgreSQL by the `expenses` gate.
 */
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const NOW = "2026-10-14T12:00:00.000Z";
const TODAY = "2026-10-14";
const TODAY_BR = "14/10/2026";
const rpcPrefix = /^\/rpc\//;

interface FakeCategory {
  archivedAt: string | null;
  createdAt: string;
  groupKey: string;
  id: string;
  name: string;
  organizationId: string;
  status: "active" | "archived";
  systemKey: string | null;
  updatedAt: string;
  version: number;
}

interface FakeExpense {
  amount: string;
  categoryGroup: string;
  categoryId: string;
  categoryName: string;
  competenceOn: string;
  createdAt: string;
  description: string;
  id: string;
  organizationId: string;
  payee: string | null;
  recurringRuleId: string | null;
  saleId: string | null;
  status: "active" | "voided";
  updatedAt: string;
  version: number;
  voidedAt: string | null;
}

interface FakeRule {
  amount: string;
  archivedAt: string | null;
  categoryGroup: string;
  categoryId: string;
  categoryName: string;
  createdAt: string;
  description: string;
  endsOn: string | null;
  frequency: "monthly" | "weekly" | "yearly";
  generatedCount: number;
  id: string;
  organizationId: string;
  payee: string | null;
  startsOn: string;
  updatedAt: string;
  version: number;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Date of occurrence `index`, counted from the start date (day clamped to the month). */
function occurrenceDate(rule: FakeRule, index: number): string {
  const [year = 0, month = 1, day = 1] = rule.startsOn.split("-").map(Number);
  if (rule.frequency === "weekly") {
    return new Date(Date.UTC(year, month - 1, day + 7 * index))
      .toISOString()
      .slice(0, 10);
  }
  const monthsAhead = rule.frequency === "monthly" ? index : 12 * index;
  const monthIndex = month - 1 + monthsAhead;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

/** The date of the next occurrence to generate, or null when the rule is over. */
function nextOccurrenceOn(rule: FakeRule): string | null {
  const date = occurrenceDate(rule, rule.generatedCount);
  return rule.endsOn !== null && date > rule.endsOn ? null : date;
}

function category(n: number, groupKey: string, name: string): FakeCategory {
  return {
    archivedAt: null,
    createdAt: NOW,
    groupKey,
    id: uuid(n),
    name,
    organizationId: ORGANIZATION,
    status: "active",
    systemKey: null,
    updatedAt: NOW,
    version: 1,
  };
}

class FakeExpenseServer {
  readonly categories = [
    category(1, "commercial", "Marketing"),
    category(2, "operational", "Aluguel"),
    category(3, "taxes", "Impostos"),
  ];
  readonly expenses: FakeExpense[] = [];
  readonly rules: FakeRule[] = [];
  calls: string[] = [];
  private next = 100;

  /** Like the real server: reading generates the occurrences that fell due, each an ordinary expense. */
  private generateDue() {
    for (const rule of this.rules) {
      if (rule.archivedAt !== null) {
        continue;
      }
      for (
        let date = nextOccurrenceOn(rule);
        date !== null && date <= TODAY;
        date = nextOccurrenceOn(rule)
      ) {
        this.next += 1;
        this.expenses.push({
          amount: rule.amount,
          categoryGroup: rule.categoryGroup,
          categoryId: rule.categoryId,
          categoryName: rule.categoryName,
          competenceOn: date,
          createdAt: NOW,
          description: rule.description,
          id: uuid(this.next),
          organizationId: ORGANIZATION,
          payee: rule.payee,
          recurringRuleId: rule.id,
          saleId: null,
          status: "active",
          updatedAt: NOW,
          version: 1,
          voidedAt: null,
        });
        rule.generatedCount += 1;
      }
    }
  }

  private ruleView(rule: FakeRule) {
    return {
      ...rule,
      nextOccurrenceOn: nextOccurrenceOn(rule),
      status: rule.archivedAt === null ? "active" : "archived",
    };
  }

  /** The five `expense/*Rule` procedures. */
  private handleRule(procedure: string, input: Record<string, unknown>) {
    if (procedure === "expense/listRules") {
      this.generateDue();
      return this.ok({
        rules: this.rules
          .map((rule) => this.ruleView(rule))
          .filter(
            (r) =>
              input.status === "all" || r.status === (input.status ?? "active")
          ),
      });
    }
    if (procedure === "expense/createRule") {
      const cat = this.categories.find((c) => c.id === input.categoryId);
      if (!cat) {
        return this.fail("NOT_FOUND", 404);
      }
      this.next += 1;
      const created: FakeRule = {
        amount: Number(input.amount).toFixed(2),
        archivedAt: null,
        categoryGroup: cat.groupKey,
        categoryId: cat.id,
        categoryName: cat.name,
        createdAt: NOW,
        description: String(input.description),
        endsOn: (input.endsOn as string | null | undefined) ?? null,
        frequency: input.frequency as FakeRule["frequency"],
        generatedCount: 0,
        id: uuid(this.next),
        organizationId: ORGANIZATION,
        payee: (input.payee as string | null | undefined) ?? null,
        startsOn: String(input.startsOn),
        updatedAt: NOW,
        version: 1,
      };
      this.rules.push(created);
      return this.ok(this.ruleView(created));
    }
    const found = this.rules.find((r) => r.id === input.id);
    if (!found) {
      return this.fail("NOT_FOUND", 404);
    }
    if (found.version !== input.expectedVersion) {
      return this.fail("CONFLICT", 409);
    }
    if (procedure === "expense/updateRule") {
      const cat = this.categories.find((c) => c.id === input.categoryId);
      if (!cat) {
        return this.fail("NOT_FOUND", 404);
      }
      found.amount = Number(input.amount).toFixed(2);
      found.categoryGroup = cat.groupKey;
      found.categoryId = cat.id;
      found.categoryName = cat.name;
      found.description = String(input.description);
      found.endsOn = (input.endsOn as string | null | undefined) ?? null;
      found.payee = (input.payee as string | null | undefined) ?? null;
    } else if (procedure === "expense/archiveRule") {
      found.archivedAt = NOW;
    } else {
      // resuming skips the periods that passed while the rule was paused
      found.archivedAt = null;
      let count = found.generatedCount;
      while (occurrenceDate(found, count) <= TODAY) {
        count += 1;
      }
      found.generatedCount = count;
    }
    found.version += 1;
    return this.ok({ changed: true, rule: this.ruleView(found) });
  }

  private fail(code: string, status: number) {
    return {
      body: {
        json: { code, data: {}, defined: false, message: code, status },
        meta: [],
      },
      status,
    };
  }

  private expenseOf(id: string) {
    return this.expenses.find((expense) => expense.id === id);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a stand-in server, one case per procedure
  handle(procedure: string, input: Record<string, unknown>) {
    this.calls.push(procedure);
    switch (procedure) {
      case "expense/listCategories":
        return this.ok({
          categories: this.categories.filter(
            (c) =>
              input.status === "all" || c.status === (input.status ?? "active")
          ),
        });
      case "expense/createCategory": {
        const name = String(input.name).trim();
        if (
          this.categories.some(
            (c) => c.name.toLowerCase() === name.toLowerCase()
          )
        ) {
          return this.fail("CONFLICT", 409);
        }
        this.next += 1;
        const created = category(this.next, String(input.group), name);
        this.categories.push(created);
        return this.ok(created);
      }
      case "expense/archiveCategory":
      case "expense/restoreCategory":
      case "expense/renameCategory": {
        const found = this.categories.find((c) => c.id === input.id);
        if (!found) {
          return this.fail("NOT_FOUND", 404);
        }
        if (found.version !== input.expectedVersion) {
          return this.fail("CONFLICT", 409);
        }
        if (procedure === "expense/renameCategory") {
          found.name = String(input.name);
        } else {
          const archive = procedure === "expense/archiveCategory";
          found.archivedAt = archive ? NOW : null;
          found.status = archive ? "archived" : "active";
        }
        found.version += 1;
        return this.ok({ category: found, changed: true });
      }
      case "expense/list": {
        this.generateDue();
        const rows = this.expenses
          .filter(
            (e) =>
              (input.status ?? "active") === "all" ||
              e.status === (input.status ?? "active")
          )
          .filter((e) => !input.from || e.competenceOn >= String(input.from))
          .filter((e) => !input.to || e.competenceOn <= String(input.to))
          .filter((e) => !input.categoryId || e.categoryId === input.categoryId)
          .sort((a, b) => b.competenceOn.localeCompare(a.competenceOn));
        const cents = rows.reduce(
          (sum, e) => sum + Math.round(Number(e.amount) * 100),
          0
        );
        const limit = Number(input.limit ?? 100);
        return this.ok({
          count: rows.length,
          expenses: rows.slice(0, limit),
          nextCursor: rows.length > limit ? "more" : null,
          total: (cents / 100).toFixed(2),
        });
      }
      case "expense/create": {
        const cat = this.categories.find((c) => c.id === input.categoryId);
        if (!cat) {
          return this.fail("NOT_FOUND", 404);
        }
        this.next += 1;
        const created: FakeExpense = {
          amount: Number(input.amount).toFixed(2),
          categoryGroup: cat.groupKey,
          categoryId: cat.id,
          categoryName: cat.name,
          competenceOn: String(input.competenceOn),
          createdAt: NOW,
          description: String(input.description),
          id: uuid(this.next),
          organizationId: ORGANIZATION,
          payee: (input.payee as string | null | undefined) ?? null,
          recurringRuleId: null,
          saleId: null,
          status: "active",
          updatedAt: NOW,
          version: 1,
          voidedAt: null,
        };
        this.expenses.push(created);
        return this.ok(created);
      }
      case "expense/update":
      case "expense/void":
      case "expense/restore": {
        const found = this.expenseOf(String(input.id));
        if (!found) {
          return this.fail("NOT_FOUND", 404);
        }
        if (found.version !== input.expectedVersion) {
          return this.fail("CONFLICT", 409);
        }
        if (procedure === "expense/update") {
          found.amount = Number(input.amount).toFixed(2);
          found.description = String(input.description);
          if (typeof input.competenceOn === "string") {
            found.competenceOn = input.competenceOn;
          }
        } else {
          const voiding = procedure === "expense/void";
          found.status = voiding ? "voided" : "active";
          found.voidedAt = voiding ? NOW : null;
        }
        found.version += 1;
        return this.ok({ changed: true, expense: found });
      }
      case "expense/listRules":
      case "expense/createRule":
      case "expense/updateRule":
      case "expense/archiveRule":
      case "expense/restoreRule":
        return this.handleRule(procedure, input);
      default:
        return this.fail("NOT_FOUND", 404);
    }
  }

  private ok(output: unknown) {
    return { body: { json: output, meta: [] }, status: 200 };
  }
}

async function installServer(page: Page, server: FakeExpenseServer) {
  await page.route("**/rpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.replace(rpcPrefix, "");
    const body = route.request().postDataJSON() as {
      json?: Record<string, unknown>;
    } | null;
    const answer = server.handle(procedure, body?.json ?? {});
    await route.fulfill({
      body: JSON.stringify(answer.body),
      headers: { ...WORKER_MARK },
      contentType: "application/json",
      status: answer.status,
    });
  });
}

async function openExpenses(
  page: Page,
  server: FakeExpenseServer,
  /** Routes that answer before the fake server (the last route registered is the first asked). */
  before?: (page: Page) => Promise<unknown>
) {
  await installServer(page, server);
  await serveLabWorker(page);
  await before?.(page);
  await page.goto("/offline-screens-lab?screen=expenses");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Despesas" })
  ).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, text: string) =>
  page.locator("article").filter({ hasText: text }).first();

/** Picks an option of a Base UI select: its list opens in a portal, on the page. */
async function choose(
  page: Page,
  scope: Page | Locator,
  label: string,
  option: string
) {
  await scope.getByRole("combobox", { exact: true, name: label }).click();
  await page.getByRole("option", { exact: true, name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

const newExpenseButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Nova despesa" });
const expenseForm = (page: Page) =>
  page.getByRole("dialog", { exact: true, name: "Nova despesa" });

/** "Nova despesa" at the top of Lançamentos opens the form in its dialog. */
async function openNewExpense(page: Page) {
  await newExpenseButton(page).click();
  await expect(expenseForm(page)).toBeVisible();
}

/** Fills the form of a new expense, opening its dialog when it is not open yet. */
async function fillExpense(
  page: Page,
  values: { amount: string; description: string; category: string }
) {
  if (!(await expenseForm(page).isVisible())) {
    await openNewExpense(page);
  }
  await page.getByLabel("Valor (R$)").fill(values.amount);
  await choose(page, expenseForm(page), "Categoria", values.category);
  await page.getByLabel("Descrição").fill(values.description);
}

test("registra uma despesa com valor em formato brasileiro e a soma do período aparece", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);

  await fillExpense(page, {
    amount: "1.500,50",
    category: "Aluguel",
    description: "Aluguel de outubro",
  });
  await page.getByRole("button", { name: "Registrar despesa" }).click();

  await expect(page.getByText("Despesa registrada.")).toBeVisible();
  await expect(row(page, "Aluguel de outubro")).toContainText("R$ 1.500,50");
  expect(server.expenses[0]?.amount).toBe("1500.50");
  await expect(page.getByText("Total do período").locator("..")).toContainText(
    "1.500,50"
  );
});

for (const viewport of FORM_VIEWPORTS) {
  test(`a data de competência, a ${viewport.name} px: abre em hoje, escolhe um dia e o servidor recebe esse dia`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(NOW));
    await page.setViewportSize(viewport);
    const server = new FakeExpenseServer();
    await openExpenses(page, server);
    await openNewExpense(page);

    await expect(
      datePickerButton(page, "Data de competência")
    ).toHaveAccessibleName(`Data de competência, ${TODAY_BR}`);
    await pickDate(page, "Data de competência", "2026-10-03");
    await expect(
      datePickerButton(page, "Data de competência")
    ).toHaveAccessibleName("Data de competência, 03/10/2026");

    // "Hoje" in the footer of the calendar goes back to the store's day
    const popup = await openDatePicker(page, "Data de competência");
    await popup.getByRole("button", { exact: true, name: "Hoje" }).click();
    await expect(popup).toBeHidden();
    await expect(
      datePickerButton(page, "Data de competência")
    ).toHaveAccessibleName(`Data de competência, ${TODAY_BR}`);

    await pickDate(page, "Data de competência", "2026-10-03");
    await fillExpense(page, {
      amount: "80",
      category: "Aluguel",
      description: "Conta de luz",
    });
    await page.getByRole("button", { name: "Registrar despesa" }).click();
    await expect(page.getByText("Despesa registrada.")).toBeVisible();
    expect(server.expenses[0]?.competenceOn).toBe("2026-10-03");
  });
}

test("a data de competência a 360×600: 'Hoje' fica à vista sem rolar e tocar nele escolhe hoje", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ height: 600, width: 360 });
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await openNewExpense(page);
  await pickDate(page, "Data de competência", "2026-10-03");

  // the field sits low in the form: little room is left for the popover
  await datePickerButton(page, "Data de competência").evaluate((button) =>
    button.scrollIntoView({ block: "end" })
  );
  const popup = await openDatePicker(page, "Data de competência");
  const today = popup.getByRole("button", { exact: true, name: "Hoje" });
  // the popover is placed first and flipped and clamped a frame later: poll until it has settled
  await expect
    .poll(async () => {
      const box = await popup.boundingBox();
      return box && box.y >= 0 && box.y + box.height <= 600;
    })
    .toBe(true);
  // "Hoje" is whole in the view with no scrolling: the popover itself does not scroll
  await expect(today).toBeInViewport({ ratio: 1 });
  // and the month is not scrolled away: the footer sits below it, in its own band
  const month = popup.locator("[data-date-month]");
  await expect
    .poll(async () => {
      const [monthBox, todayBox] = await Promise.all([
        month.boundingBox(),
        today.boundingBox(),
      ]);
      return (
        monthBox !== null &&
        todayBox !== null &&
        todayBox.y >= monthBox.y + monthBox.height
      );
    })
    .toBe(true);

  await today.click();
  await expect(popup).toBeHidden();
  await expect(
    datePickerButton(page, "Data de competência")
  ).toHaveAccessibleName(`Data de competência, ${TODAY_BR}`);
});

test("a data de competência com pouca altura (celular deitado): o mês rola dentro do popover e 'Hoje' continua à vista", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ height: 300, width: 360 });
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await openNewExpense(page);
  await datePickerButton(page, "Data de competência").evaluate((button) =>
    button.scrollIntoView({ block: "center" })
  );
  const popup = await openDatePicker(page, "Data de competência");
  await expect
    .poll(async () => {
      const box = await popup.boundingBox();
      return box && box.y >= 0 && box.y + box.height <= 300;
    })
    .toBe(true);
  // less room than the month needs: the month gives way, the footer stays
  await expect
    .poll(() =>
      popup
        .locator("[data-date-month]")
        .evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);
  await expect(
    popup.getByRole("button", { exact: true, name: "Hoje" })
  ).toBeInViewport({ ratio: 1 });
});

test("o calendário da data de competência: o teclado abre, as setas andam, Enter escolhe e o foco volta ao botão", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await openNewExpense(page);

  await datePickerButton(page, "Data de competência").focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", { name: "Data de competência" });
  await expect(popup.getByRole("grid").first()).toBeVisible();
  // the focus is on the chosen day (today), and the arrows walk the days
  await expect(popup.locator(`button[data-day="${TODAY}"]`)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(datePickerButton(page, "Data de competência")).toBeFocused();
  await expect(
    datePickerButton(page, "Data de competência")
  ).toHaveAccessibleName("Data de competência, 13/10/2026");
});

test("um valor inválido é recusado na tela, sem chamar o servidor", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  const callsBefore = server.calls.length;

  await fillExpense(page, {
    amount: "10,505",
    category: "Marketing",
    description: "Anúncio",
  });
  await page.getByRole("button", { name: "Registrar despesa" }).click();

  await expect(page.locator("#expense-amount-error")).toBeVisible();
  expect(server.calls.slice(callsBefore)).not.toContain("expense/create");
  expect(server.expenses).toHaveLength(0);
});

test("as abas Ativas e Anuladas: setas trocam de aba, Tab sai do grupo e o leitor de tela lê aba selecionada", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "o teclado é o do desktop"
  );
  await openExpenses(page, new FakeExpenseServer());
  await expectTabsKeyboard(page, "Situação das despesas", [
    "Ativas",
    "Anuladas",
  ]);
});

test("anular tira a despesa do período, aparece em Anuladas e pode ser reativada", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await fillExpense(page, {
    amount: "80",
    category: "Marketing",
    description: "Panfletos",
  });
  await page.getByRole("button", { name: "Registrar despesa" }).click();
  await expect(row(page, "Panfletos")).toBeVisible();

  await page.getByRole("button", { name: "Anular despesa Panfletos" }).click();
  await expect(row(page, "Panfletos")).toHaveCount(0);

  await page.getByRole("tab", { name: "Anuladas" }).click();
  await expect(row(page, "Panfletos")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Editar despesa Panfletos" })
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Reativar despesa Panfletos" })
    .click();
  await page.getByRole("tab", { name: "Ativas" }).click();
  await expect(row(page, "Panfletos")).toBeVisible();
});

test("editar sobre uma versão antiga mostra o conflito e recarrega", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await fillExpense(page, {
    amount: "50",
    category: "Marketing",
    description: "Brindes",
  });
  await page.getByRole("button", { name: "Registrar despesa" }).click();
  await expect(row(page, "Brindes")).toBeVisible();

  await page.getByRole("button", { name: "Editar despesa Brindes" }).click();
  // another device changed it meanwhile
  const [stored] = server.expenses;
  if (stored) {
    stored.version += 1;
    stored.amount = "75.00";
  }
  await page.getByLabel("Valor (R$)").fill("60");
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(row(page, "Brindes")).toContainText("R$ 75,00");
});

test("uma categoria com nome já usado é recusada com a mensagem da tela", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);

  await page.getByRole("tab", { name: "Categorias" }).click();
  await page
    .getByRole("button", { exact: true, name: "Nova categoria" })
    .click();
  const form = page.getByRole("dialog", { name: "Nova categoria" });
  await form.getByLabel("Nome da categoria").fill("aluguel");
  await form.getByRole("button", { name: "Adicionar categoria" }).click();

  // the refusal is said inside the dialog, which stays open with what was typed
  await expect(
    form.getByText("Já existe uma categoria com esse nome")
  ).toBeVisible();
  await expect(form.getByLabel("Nome da categoria")).toHaveValue("aluguel");
});

const rulesPanel = (page: Page) =>
  page.getByRole("tabpanel", { name: "Recorrentes" });
const listedExpense = (page: Page, text: string) =>
  page
    .getByRole("region", { name: "Despesas do período" })
    .locator("article")
    .filter({ hasText: text });

async function openRulesPanel(page: Page) {
  await page.getByRole("tab", { name: "Recorrentes" }).click();
}

async function openLaunches(page: Page) {
  await page.getByRole("tab", { name: "Lançamentos" }).click();
}

/** Creates a monthly rule that started three months before today. */
async function createMonthlyRule(page: Page, description: string) {
  const panel = rulesPanel(page);
  await panel.getByRole("button", { name: "Nova despesa recorrente" }).click();
  // the form is a dialog, outside the panel
  const form = page.getByRole("dialog", { name: "Nova despesa recorrente" });
  await form.getByLabel("Valor de cada ocorrência (R$)").fill("1.200");
  await choose(page, form, "Categoria", "Aluguel");
  await choose(page, form, "Frequência", "Todo mês");
  await pickDate(form, "Começa em", "2026-07-14");
  await form.getByLabel("Descrição").fill(description);
  await form.getByRole("button", { name: "Criar despesa recorrente" }).click();
  await expect(panel.getByText("Despesa recorrente criada.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("uma despesa recorrente criada no passado lança a ocorrência do mês e mostra a próxima", async ({
  page,
}) => {
  // the screen reads today's date from the browser: keep it equal to the fake server's
  await page.clock.setFixedTime(new Date(NOW));
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await openRulesPanel(page);

  await createMonthlyRule(page, "Assinatura do sistema");

  // everything missed was generated at once: July to October
  expect(server.expenses).toHaveLength(4);
  expect(server.expenses.every((e) => e.recurringRuleId !== null)).toBe(true);
  const rule = rulesPanel(page).locator("article").filter({
    hasText: "Assinatura do sistema",
  });
  await expect(rule).toContainText("Todo mês");
  await expect(rule).toContainText("Começa em 14/07/2026");
  await expect(rule).toContainText("Próxima: 14/11/2026");

  await openLaunches(page);
  const occurrence = listedExpense(page, "Assinatura do sistema");
  await expect(occurrence).toHaveCount(1);
  await expect(occurrence).toContainText("R$ 1.200,00");
  await expect(occurrence).toContainText("Competência 14/10/2026");
  await expect(
    occurrence.getByText("Recorrente", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Total do período").locator("..")).toContainText(
    "1.200,00"
  );
});

for (const width of FORM_WIDTHS) {
  test(`Despesa recorrente a ${width} px: o formulário abre, cancela e salva na tela inteira do celular ou no diálogo central`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "a largura é a do teste"
    );
    await page.setViewportSize(sizeFor(width));
    await page.clock.setFixedTime(new Date(NOW));
    const server = new FakeExpenseServer();
    await openExpenses(page, server);
    await openRulesPanel(page);
    const openForm = rulesPanel(page).getByRole("button", {
      name: "Nova despesa recorrente",
    });
    await openForm.click();
    const dialog = page.getByRole("dialog", {
      name: "Nova despesa recorrente",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Valor de cada ocorrência (R$)")
    ).toBeFocused();
    await expectFormDialogLayout(dialog, width);

    // Esc sem digitar não guarda nada, nem o que foi digitado e apagado: reabrir traz o formulário como começou
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openForm.click();
    await expect(
      dialog.getByLabel("Valor de cada ocorrência (R$)")
    ).toHaveValue("");
    await dialog.getByLabel("Valor de cada ocorrência (R$)").fill("7");
    await dialog.getByLabel("Valor de cada ocorrência (R$)").fill("");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openForm.click();
    await expect(
      dialog.getByLabel("Valor de cada ocorrência (R$)")
    ).toHaveValue("");

    await dialog.getByLabel("Valor de cada ocorrência (R$)").fill("1.200");
    if (width < 760) {
      await expectKeyboardKeepsMainButton(
        page,
        dialog,
        dialog.getByRole("button", { name: "Criar despesa recorrente" })
      );
    }

    // Esc guarda o rascunho (só em memória): o formulário fecha, o foco volta e o mesmo formulário o traz de volta
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    await openForm.click();
    await expect(
      dialog.getByLabel("Valor de cada ocorrência (R$)")
    ).toHaveValue("1.200");

    await dialog.getByRole("button", { exact: true, name: "Cancelar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    expect(server.rules).toHaveLength(0);

    // o que foi digitado não fica para a próxima vez, e salvar fecha o formulário e diz o resultado
    await openForm.click();
    await expect(
      dialog.getByLabel("Valor de cada ocorrência (R$)")
    ).toHaveValue("");
    await dialog.getByLabel("Valor de cada ocorrência (R$)").fill("1.200");
    await choose(page, dialog, "Categoria", "Aluguel");
    await choose(page, dialog, "Frequência", "Todo mês");
    await pickDate(dialog, "Começa em", "2026-07-14");
    await dialog.getByLabel("Descrição").fill("Assinatura do sistema");
    await dialog
      .getByRole("button", { name: "Criar despesa recorrente" })
      .click();
    await expect(
      rulesPanel(page).getByText("Despesa recorrente criada.")
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(server.rules).toHaveLength(1);
  });
}

for (const viewport of FORM_VIEWPORTS) {
  test(`'Termina em' da despesa recorrente, a ${viewport.name} px: não aceita dia antes do início, é opcional e Limpar o esvazia`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(NOW));
    await page.setViewportSize(viewport);
    const server = new FakeExpenseServer();
    await openExpenses(page, server);
    await openRulesPanel(page);
    await rulesPanel(page)
      .getByRole("button", { name: "Nova despesa recorrente" })
      .click();
    const form = page.getByRole("dialog", { name: "Nova despesa recorrente" });

    await pickDate(form, "Começa em", "2026-10-10");
    const ends = await openDatePicker(page, "Termina em");
    // the days before the start cannot be chosen: the "ends before it starts" error cannot be made
    await expect(ends.locator('button[data-day="2026-10-09"]')).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await touchDay(ends, "2026-12-10");
    await expect(ends).toBeHidden();
    await expect(datePickerButton(form, "Termina em")).toHaveAccessibleName(
      "Termina em, 10/12/2026"
    );

    await form.getByRole("button", { name: "Limpar data de término" }).click();
    await expect(datePickerButton(form, "Termina em")).toHaveAccessibleName(
      "Termina em, Escolher data"
    );
    // the button that was cleared is gone: the focus goes to the field, not to the page
    await expect(datePickerButton(form, "Termina em")).toBeFocused();
    // the help of the field is read with it
    await expect(
      datePickerButton(form, "Termina em")
    ).toHaveAccessibleDescription("Em branco, repete sem data de término.");
    await expect(
      form.getByRole("button", { name: "Limpar data de término" })
    ).toHaveCount(0);
  });
}

test("pausar uma despesa recorrente a esconde, e retomar não lança os períodos da pausa", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await openRulesPanel(page);
  await createMonthlyRule(page, "Assinatura do sistema");
  const panel = rulesPanel(page);
  const rule = panel.locator("article").filter({
    hasText: "Assinatura do sistema",
  });

  await panel
    .getByRole("button", {
      name: "Pausar despesa recorrente Assinatura do sistema",
    })
    .click();
  await expect(panel.getByText("Despesa recorrente pausada.")).toBeVisible();
  await expect(rule).toHaveCount(0);

  await panel.getByRole("checkbox", { name: "Mostrar pausadas" }).check();
  await expect(rule.getByText("Pausada", { exact: true })).toBeVisible();
  await expect(rule).toContainText("Geração suspensa até retomar");

  await panel
    .getByRole("button", {
      name: "Retomar despesa recorrente Assinatura do sistema",
    })
    .click();
  await expect(panel.getByText("Despesa recorrente retomada.")).toBeVisible();
  await expect(rule.getByText("Pausada", { exact: true })).toHaveCount(0);
  await expect(rule).toContainText("Próxima: 14/11/2026");
  // nothing new was generated by pausing and resuming
  expect(server.expenses).toHaveLength(4);
  await openLaunches(page);
  await expect(listedExpense(page, "Assinatura do sistema")).toHaveCount(1);
});

/** Opens the screen and records the month of every list the screen asks for. */
async function openExpensesWatchingMonths(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  const server = new FakeExpenseServer();
  const months: string[] = [];
  await openExpenses(page, server, (target) =>
    target.route("**/rpc/expense/list", async (route) => {
      const body = route.request().postDataJSON() as {
        json?: { from?: string };
      };
      months.push(String(body.json?.from ?? "").slice(0, 7));
      await route.fallback();
    })
  );
  return months;
}

test("o seletor de mês mostra o mês por extenso, anda com as setas e escolhe na grade de meses", async ({
  page,
}) => {
  const months = await openExpensesWatchingMonths(page);
  // one button in the middle with the month in words, named by the label; no native month field
  const trigger = page.locator("#expense-month");
  await expect(trigger).toHaveAccessibleName(
    "Mês de competência, Outubro de 2026"
  );
  await expect(trigger).toHaveText("Outubro de 2026");
  await expect(page.locator('input[type="month"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(trigger).toHaveText("Novembro de 2026");
  // the total of the list follows the month
  await expect(
    page.getByText("Total do período").locator("../..")
  ).toContainText("novembro de 2026");
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(trigger).toHaveText("Setembro de 2026");

  // the grid opens on the year of the month on screen, with that month pressed
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Mês de competência" });
  await expect(popup.getByText("2026", { exact: true })).toBeVisible();
  const grid = popup.getByRole("group", { name: "Meses de 2026" });
  await expect(grid.getByRole("button")).toHaveCount(12);
  await expect(
    grid.getByRole("button", { name: "setembro de 2026" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    grid.getByRole("button", { name: "outubro de 2026" })
  ).toHaveAttribute("aria-pressed", "false");

  // a month of the grid is chosen with one touch, and closes the popover
  await grid.getByRole("button", { name: "março de 2026" }).click();
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText("Março de 2026");
  await expect.poll(() => months.at(-1)).toBe("2026-03");
  await expect(trigger).toBeFocused();

  // the year has its own arrows, and a month ahead of today is chosen as the arrow does (the list reads any month)
  await trigger.click();
  await popup.getByRole("button", { name: "Próximo ano" }).click();
  await expect(popup.getByText("2027", { exact: true })).toBeVisible();
  await popup
    .getByRole("group", { name: "Meses de 2027" })
    .getByRole("button", { name: "dezembro de 2027" })
    .click();
  await expect(trigger).toHaveText("Dezembro de 2027");
  await expect.poll(() => months.at(-1)).toBe("2027-12");
  expect(months).toEqual(
    expect.arrayContaining(["2026-10", "2026-11", "2026-09", "2026-03"])
  );

  // the arrow after December goes to January of the next year
  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(trigger).toHaveText("Janeiro de 2028");

  // "Este mês" in the footer chooses the store's current month (the clock says October 2026), closes, gives the focus back
  await trigger.click();
  await expect(popup.getByText("2028", { exact: true })).toBeVisible();
  await popup.getByRole("button", { name: "Este mês" }).click();
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText("Outubro de 2026");
  await expect.poll(() => months.at(-1)).toBe("2026-10");
  await expect(trigger).toBeFocused();
});

test("a grade de meses não volta de janeiro de 2000, pelos botões nem pelo teclado, e o futuro continua livre", async ({
  page,
}) => {
  const months = await openExpensesWatchingMonths(page);
  const trigger = page.getByRole("button", { name: "Mês de competência," });
  const popup = page.getByRole("dialog", { name: "Mês de competência" });
  const previousYear = popup.getByRole("button", { name: "Ano anterior" });
  const month = (name: string) => popup.getByRole("button", { name });

  await trigger.click();
  await expect(previousYear).not.toHaveAttribute("aria-disabled", "true");
  for (let year = 2025; year >= 2001; year -= 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one year at a time, the grid redraws between them
    await previousYear.click();
    await expect(popup.getByText(String(year), { exact: true })).toBeVisible();
  }
  await expect(previousYear).not.toHaveAttribute("aria-disabled", "true");
  await previousYear.click();
  await expect(popup.getByText("2000", { exact: true })).toBeVisible();
  // in 2000 the arrow is off, still focusable, and Enter on it does nothing
  await expect(previousYear).toHaveAttribute("aria-disabled", "true");
  await previousYear.focus();
  await page.keyboard.press("Enter");
  await expect(popup.getByText("2000", { exact: true })).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Próximo ano" })
  ).not.toHaveAttribute("aria-disabled", "true");

  // the keys stop at January 2000 too; going forward is free
  await month("outubro de 2000").focus();
  await page.keyboard.press("Home");
  await expect(month("janeiro de 2000")).toBeFocused();
  for (const key of ["ArrowLeft", "ArrowUp", "PageUp"]) {
    // biome-ignore lint/performance/noAwaitInLoops: the keys are pressed in order
    await page.keyboard.press(key);
    await expect(month("janeiro de 2000")).toBeFocused();
    await expect(popup.getByText("2000", { exact: true })).toBeVisible();
  }
  await page.keyboard.press("PageDown");
  await expect(month("janeiro de 2001")).toBeFocused();
  await page.keyboard.press("PageUp");
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText("Janeiro de 2000");
  await expect.poll(() => months.at(-1)).toBe("2000-01");
});

test("o teclado abre a grade de meses, anda por ela e escolhe o mês", async ({
  page,
}) => {
  const months = await openExpensesWatchingMonths(page);
  const trigger = page.getByRole("button", { name: "Mês de competência," });
  const popup = page.getByRole("dialog", { name: "Mês de competência" });
  const month = (name: string) => popup.getByRole("button", { name });

  // the first Tab stop of the group after the arrow: Enter opens, and the focus goes to the month on screen
  await page.getByRole("button", { name: "Mês anterior" }).focus();
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(month("outubro de 2026")).toBeFocused();

  // only the month with the cursor is in the tab order (the arrows move inside the grid)
  await expect(month("novembro de 2026")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowRight");
  await expect(month("novembro de 2026")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(month("julho de 2026")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(month("janeiro de 2026")).toBeFocused();
  await page.keyboard.press("End");
  await expect(month("dezembro de 2026")).toBeFocused();
  // past December: January of the next year (the grid changes its year, the focus follows)
  await page.keyboard.press("ArrowRight");
  await expect(
    popup.getByRole("group", { name: "Meses de 2027" })
  ).toBeVisible();
  await expect(month("janeiro de 2027")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(month("abril de 2027")).toBeFocused();
  await page.keyboard.press("PageUp");
  await expect(month("abril de 2026")).toBeFocused();

  // Enter chooses, closes and gives the focus back to the button
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText("Abril de 2026");
  await expect(trigger).toBeFocused();
  await expect.poll(() => months.at(-1)).toBe("2026-04");

  // Escape closes without changing the month
  await page.keyboard.press("Enter");
  await expect(month("abril de 2026")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText("Abril de 2026");
  await expect(trigger).toBeFocused();
});

test("a lista que não pôde ser lida diz o motivo e oferece tentar de novo, nunca a lista vazia", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  const reads: { fail: boolean } = { fail: true };
  await openExpenses(page, server, (target) =>
    target.route("**/rpc/expense/list", (route) =>
      reads.fail ? route.abort("internetdisconnected") : route.fallback()
    )
  );

  const retry = page.getByRole("button", { name: "Tentar novamente" });
  // no answer with the connection there: three tries (~1.5 s and ~4 s between them) before the screen says so
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Nenhuma despesa neste período")).toHaveCount(0);

  reads.fail = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByText(
      "Nenhuma despesa neste período. Toque em Nova despesa para registrar a primeira."
    )
  ).toBeVisible();
});

const VER_RECURRING = /[?&]ver=recorrentes(&|$)/;
const VER_CATEGORIES = /[?&]ver=categorias(&|$)/;
const VER_ANY = /[?&]ver=/;
const LAB_SCREEN = /screen=expenses/;

const segmented = (page: Page) =>
  page.getByRole("tablist", { name: "Lançamentos, recorrentes e categorias" });

test("o segmentado Lançamentos · Recorrentes · Categorias: nome acessível, endereço e controle", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await expect(segmented(page).getByRole("tab")).toHaveText([
    "Lançamentos",
    "Recorrentes",
    "Categorias",
  ]);
  // no `ver`: Lançamentos, with the month at the top and the way to a new expense
  await expect(
    segmented(page).getByRole("tab", { name: "Lançamentos" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#expense-month")).toBeVisible();
  await expect(newExpenseButton(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Categorias de despesa" })
  ).toHaveCount(0);

  // the control writes the part in the address, in place: "voltar" leaves the screen, it does not walk the parts
  const steps = await page.evaluate(() => history.length);
  await page.getByRole("tab", { name: "Recorrentes" }).click();
  await expect(page).toHaveURL(VER_RECURRING);
  await expect(rulesPanel(page)).toBeVisible();
  await expect(
    rulesPanel(page).getByRole("button", { name: "Nova despesa recorrente" })
  ).toBeVisible();
  await page.getByRole("tab", { name: "Categorias" }).click();
  await expect(page).toHaveURL(VER_CATEGORIES);
  await expect(
    page
      .getByRole("tabpanel", { name: "Categorias" })
      .getByRole("checkbox", { name: "Mostrar categorias arquivadas" })
  ).toBeVisible();
  await page.getByRole("tab", { name: "Lançamentos" }).click();
  await expect(page).not.toHaveURL(VER_ANY);
  expect(await page.evaluate(() => history.length)).toBe(steps);

  // the arrows walk the parts, as the other tabs of the app
  await page.getByRole("tab", { name: "Lançamentos" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Recorrentes" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // the address opens a part: what was ticked in another survives (the three stay mounted)
  await rulesPanel(page)
    .getByRole("checkbox", { name: "Mostrar pausadas" })
    .check();
  await page.getByRole("tab", { name: "Lançamentos" }).click();
  await page.getByRole("tab", { name: "Recorrentes" }).click();
  await expect(
    rulesPanel(page).getByRole("checkbox", { name: "Mostrar pausadas" })
  ).toBeChecked();
});

test("o endereço abre o segmento, e um ?ver= inválido cai em Lançamentos sem passo no histórico", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  // the lab keeps its own query: the part goes beside it, and the screen reads it on its first paint
  for (const [ver, tab] of [
    ["recorrentes", "Recorrentes"],
    ["categorias", "Categorias"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    await page.evaluate((value) => {
      const url = new URL(window.location.href);
      url.searchParams.set("ver", value);
      history.replaceState(history.state, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, ver);
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  }
  const steps = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("ver", "xyz");
    history.replaceState(history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("tab", { name: "Lançamentos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page).not.toHaveURL(VER_ANY);
  await expect(page).toHaveURL(LAB_SCREEN);
  expect(await page.evaluate(() => history.length)).toBe(steps);
});

test("despesa no diálogo: Nova despesa e Editar abrem o formulário, Esc guarda o rascunho e o foco volta ao gatilho", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  const server = new FakeExpenseServer();
  await openExpenses(page, server);

  await openNewExpense(page);
  const form = expenseForm(page);
  await expect(form.getByLabel("Valor (R$)")).toBeFocused();
  await form.getByLabel("Valor (R$)").fill("80");
  // Esc closes keeping the draft (in memory): the focus goes back to "Nova despesa", and it brings the draft back
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(newExpenseButton(page)).toBeFocused();
  await openNewExpense(page);
  await expect(form.getByLabel("Valor (R$)")).toHaveValue("80");
  // "Cancelar" throws it away
  await form.getByRole("button", { exact: true, name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(newExpenseButton(page)).toBeFocused();
  await openNewExpense(page);
  await expect(form.getByLabel("Valor (R$)")).toHaveValue("");

  await fillExpense(page, {
    amount: "80",
    category: "Marketing",
    description: "Panfletos",
  });
  await form.getByRole("button", { name: "Registrar despesa" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Despesa registrada.")).toBeVisible();
  await expect(row(page, "Panfletos")).toContainText("R$ 80,00");

  // "Editar" of the row: the same dialog with the expense, and the focus back on that "Editar"
  const edit = page.getByRole("button", { name: "Editar despesa Panfletos" });
  await edit.click();
  const editForm = page.getByRole("dialog", { name: "Editar despesa" });
  await expect(editForm.getByLabel("Valor (R$)")).toHaveValue("80,00");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.click();
  await editForm.getByLabel("Valor (R$)").fill("95");
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Despesa atualizada.")).toBeVisible();
  await expect(row(page, "Panfletos")).toContainText("R$ 95,00");
  expect(server.expenses[0]?.amount).toBe("95.00");

  // saved into another month, the row leaves the list: the focus goes to "Nova despesa", not to the page
  await edit.click();
  await pickDate(editForm, "Data de competência", "2026-09-15");
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row(page, "Panfletos")).toHaveCount(0);
  await expect(newExpenseButton(page)).toBeFocused();
});

test("categoria no diálogo: Nova categoria cria no grupo, Renomear muda o nome e o foco volta ao gatilho", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  await page.getByRole("tab", { name: "Categorias" }).click();
  const panel = page.getByRole("tabpanel", { name: "Categorias" });
  const newCategory = panel.getByRole("button", {
    exact: true,
    name: "Nova categoria",
  });

  await newCategory.click();
  const form = page.getByRole("dialog", { name: "Nova categoria" });
  await expect(form.getByRole("combobox", { name: "Grupo" })).toBeFocused();
  // the name is required: said beside the field, with the focus on it, and nothing sent
  await form.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(form.getByText("Informe o nome da categoria.")).toBeVisible();
  await expect(form.getByLabel("Nome da categoria")).toBeFocused();
  await choose(page, form, "Grupo", "Comercial");
  await form.getByLabel("Nome da categoria").fill("Frete");
  await form.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByText("Categoria criada.")).toBeVisible();
  await expect(newCategory).toBeFocused();
  await expect(
    panel
      .getByRole("region", { name: "Comercial" })
      .getByText("Frete", { exact: true })
  ).toBeVisible();

  const rename = panel.getByRole("button", {
    name: "Renomear categoria Frete",
  });
  await rename.click();
  const renameForm = page.getByRole("dialog", { name: "Renomear categoria" });
  // only the name: the group of a category does not change
  await expect(renameForm.getByRole("combobox")).toHaveCount(0);
  await expect(renameForm.getByLabel("Nome da categoria")).toHaveValue("Frete");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(rename).toBeFocused();
  // another device changed it meanwhile: the conflict is said inside the dialog, which keeps what was typed, and
  // saving again goes with the version the list read again
  const stored = server.categories.find((item) => item.name === "Frete");
  if (stored) {
    stored.version += 1;
  }
  await rename.click();
  await renameForm.getByLabel("Nome da categoria").fill("Frete e entregas");
  await renameForm.getByRole("button", { exact: true, name: "Salvar" }).click();
  await expect(renameForm.getByRole("alert")).toBeVisible();
  await expect(renameForm.getByLabel("Nome da categoria")).toHaveValue(
    "Frete e entregas"
  );
  await renameForm.getByRole("button", { exact: true, name: "Salvar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByText("Categoria renomeada.")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Renomear categoria Frete e entregas" })
  ).toBeFocused();
});
