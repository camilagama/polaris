/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

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
      contentType: "application/json",
      status: answer.status,
    });
  });
}

async function openExpenses(
  page: Page,
  server: FakeExpenseServer,
  /** Routes that answer before the fake server (the last route registered is the first asked). */
  before?: (page: Page) => Promise<void>
) {
  await installServer(page, server);
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

const expenseForm = (page: Page) =>
  page.getByRole("region", { name: "Nova despesa" });

async function fillExpense(
  page: Page,
  values: { amount: string; description: string; category: string }
) {
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

  await page.getByRole("button", { name: "Anuladas" }).click();
  await expect(row(page, "Panfletos")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Editar despesa Panfletos" })
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Reativar despesa Panfletos" })
    .click();
  await page.getByRole("button", { name: "Ativas" }).click();
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

  await page.getByRole("button", { name: "Categorias de despesa" }).click();
  await page.getByLabel("Nome da categoria").fill("aluguel");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();

  await expect(
    page.getByText("Já existe uma categoria com esse nome")
  ).toBeVisible();
});

const rulesPanel = (page: Page) =>
  page.getByRole("region", { name: "Despesas recorrentes" });
const listedExpense = (page: Page, text: string) =>
  page
    .getByRole("region", { name: "Despesas do período" })
    .locator("article")
    .filter({ hasText: text });

async function openRulesPanel(page: Page) {
  await page.getByRole("button", { name: "Despesas recorrentes" }).click();
}

/** Creates a monthly rule that started three months before today. */
async function createMonthlyRule(page: Page, description: string) {
  const panel = rulesPanel(page);
  await panel.getByRole("button", { name: "Nova despesa recorrente" }).click();
  await panel.getByLabel("Valor de cada ocorrência (R$)").fill("1.200");
  await choose(page, panel, "Categoria", "Aluguel");
  await choose(page, panel, "Frequência", "Todo mês");
  await panel.getByLabel("Começa em").fill("2026-07-14");
  await panel.getByLabel("Descrição").fill(description);
  await panel.getByRole("button", { name: "Criar despesa recorrente" }).click();
  await expect(panel.getByText("Despesa recorrente criada.")).toBeVisible();
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

  const rule = rulesPanel(page).locator("article").filter({
    hasText: "Assinatura do sistema",
  });
  await expect(rule).toContainText("Todo mês");
  await expect(rule).toContainText("Começa em 14/07/2026");
  await expect(rule).toContainText("Próxima: 14/11/2026");
});

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
  await expect(listedExpense(page, "Assinatura do sistema")).toHaveCount(1);
});

test("o seletor de mês mostra o mês por extenso, anda com as setas e aceita o mês digitado", async ({
  page,
}) => {
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
  // the words over the month field (the field itself is invisible)
  const picker = page.locator("#expense-month").locator("..");
  await expect(picker).toHaveText("Outubro de 2026");
  // the month field is named by its label, and the browser's own text never shows
  await expect(page.getByLabel("Mês de competência")).toHaveValue("2026-10");

  await page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(picker).toHaveText("Novembro de 2026");
  await expect(page.getByText("Total do período").locator("..")).toBeVisible();
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await page.getByRole("button", { name: "Mês anterior" }).click();
  await expect(picker).toHaveText("Setembro de 2026");

  await page.getByLabel("Mês de competência").fill("2026-03");
  await expect(picker).toHaveText("Março de 2026");
  await expect.poll(() => months.at(-1)).toBe("2026-03");
  expect(months).toEqual(
    expect.arrayContaining(["2026-10", "2026-11", "2026-09"])
  );
});

test("a lista que não pôde ser lida diz o motivo e oferece tentar de novo, nunca a lista vazia", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  let fail = true;
  await openExpenses(page, server, (target) =>
    target.route("**/rpc/expense/list", (route) =>
      fail ? route.abort("internetdisconnected") : route.fallback()
    )
  );

  const retry = page.getByRole("button", { name: "Tentar novamente" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Nenhuma despesa neste período")).toHaveCount(0);

  fail = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByText("Nenhuma despesa neste período", { exact: false })
  ).toBeVisible();
});

test("fechar e abrir um painel recolhível não perde o que foi digitado nele", async ({
  page,
}) => {
  const server = new FakeExpenseServer();
  await openExpenses(page, server);
  const trigger = page.getByRole("button", { name: "Categorias de despesa" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Nome da categoria")).toBeHidden();

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("Nome da categoria").fill("Frete");
  await trigger.click();
  await expect(page.getByLabel("Nome da categoria")).toBeHidden();
  await trigger.click();
  await expect(page.getByLabel("Nome da categoria")).toHaveValue("Frete");
});
