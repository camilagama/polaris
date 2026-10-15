/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
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
  saleId: string | null;
  status: "active" | "voided";
  updatedAt: string;
  version: number;
  voidedAt: string | null;
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
  calls: string[] = [];
  private next = 100;

  private fail(code: string, status: number) {
    return {
      status,
      body: {
        json: { code, data: {}, defined: false, message: code, status },
        meta: [],
      },
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
      default:
        return this.fail("NOT_FOUND", 404);
    }
  }

  private ok(output: unknown) {
    return { status: 200, body: { json: output, meta: [] } };
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

async function openExpenses(page: Page, server: FakeExpenseServer) {
  await installServer(page, server);
  await page.goto("/offline-screens-lab?screen=expenses");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Despesas" })
  ).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, text: string) =>
  page.locator("article, li").filter({ hasText: text }).first();

async function fillExpense(
  page: Page,
  values: { amount: string; description: string; category: string }
) {
  await page.getByLabel("Valor (R$)").fill(values.amount);
  await page.locator("#expense-categoryId").selectOption({
    label: values.category,
  });
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

  await page
    .locator("summary")
    .filter({ hasText: "Categorias de despesa" })
    .click();
  await page.getByLabel("Nome da categoria").fill("aluguel");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();

  await expect(
    page.getByText("Já existe uma categoria com esse nome")
  ).toBeVisible();
});
