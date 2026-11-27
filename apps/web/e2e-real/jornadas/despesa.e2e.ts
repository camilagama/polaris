import type { Locator, Page } from "@playwright/test";
import { pickDate } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, refusedWith, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { choose } from "../pages/venda";

const BRL_VALUE = /R\$/;
const FILTER_BUTTON = /^Filtrar( despesas)?$/;
const CATEGORY_ITEM = /^Categoria/;
const EXPENSES_OF_PERIOD = "(−) Despesas do período (sem venda)";

/** The dialog "Nova categoria" of the Categorias tab, filled and not yet sent. */
async function openNewCategory(
  page: Page,
  categoryName: string,
  group: string
): Promise<Locator> {
  await page.getByRole("tab", { name: "Categorias" }).click();
  await page
    .getByRole("tabpanel", { name: "Categorias" })
    .getByRole("button", { exact: true, name: "Nova categoria" })
    .click();
  const form = page.getByRole("dialog", { name: "Nova categoria" });
  await choose(page, form, "Grupo", group);
  await form.getByLabel("Nome da categoria").fill(categoryName);
  return form;
}

/** Categorias, a part of the Despesas tab: the new category in its dialog, then back to Lançamentos. */
async function addCategory(
  page: Page,
  categoryName: string,
  group = "Operacional/Administrativa"
): Promise<void> {
  const form = await openNewCategory(page, categoryName, group);
  await form.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const categories = page.getByRole("tabpanel", { name: "Categorias" });
  await expect(
    categories.getByText(categoryName, { exact: true })
  ).toBeVisible();
}

/**
 * Journey 7: a one-off expense in the month of T0 enters the list and the Resultado of the month, in cents; an
 * expense of another month (computed, never a constant) does not. The organization is in the extreme zone of the
 * run, so "the month" is the organization's, not UTC's.
 */
test("despesa avulsa: entra na lista e no Resultado do mês; a de outro mês não entra", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const otherMonth = addDays(monthStart(today), -1); // the last day of the previous month
  const categoryName = "Aluguel da loja";

  await page.goto("/expenses");
  await addCategory(page, categoryName);
  await page.getByRole("tab", { name: "Lançamentos" }).click();

  const form = page.getByRole("dialog", { name: "Nova despesa" });
  const register = async (
    amount: string,
    competenceOn: string,
    description: string
  ) => {
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .and(page.locator("[data-expense-new]"))
      .click();
    await form.getByLabel("Valor (R$)").fill(amount);
    await choose(page, form, "Categoria", categoryName);
    await pickDate(form, "Data de competência", competenceOn);
    await form.getByLabel("Descrição").fill(description);
    await form.getByRole("button", { name: "Registrar despesa" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Despesa registrada.")).toBeVisible();
  };
  await register("1.234,56", today, "Aluguel deste mês");
  await register("99,99", otherMonth, "Aluguel do mês anterior");

  await expect
    .poll(async () =>
      (
        await sql.query<{ amount: string; competence_on: string }>(
          "SELECT amount::text, competence_on::text FROM expenses WHERE organization_id = $1 ORDER BY competence_on DESC",
          [organizationId]
        )
      ).rows.map((row) => ({
        amount: numericCents(row.amount),
        on: row.competence_on,
      }))
    )
    .toEqual([
      { amount: 123_456, on: today },
      { amount: 9999, on: otherMonth },
    ]);

  // the list of the period shows the one of this month
  await expect(
    page
      .getByRole("region", { name: "Despesas do período" })
      .getByText("Aluguel deste mês")
  ).toBeVisible();

  await page.goto("/dashboard");
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toHaveText(BRL_VALUE);
  await expect
    .poll(async () =>
      cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
    )
    .toBe(123_456);
});

/**
 * The server's "today" of the organization (`organizationToday`, in its zone) decides which occurrence of a recurring
 * expense is due. In the extreme zone the local date is one day off the UTC date, in either direction: the rule
 * that starts today has its occurrence generated and the one that starts tomorrow has none. With "today" taken in
 * UTC, Kiritimati (ahead) generates nothing for the first and Pago Pago (behind) generates the second.
 */
test("despesa recorrente: a que começa hoje no fuso da loja é lançada, a que começa amanhã não", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa-recorrente", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const tomorrow = addDays(today, 1);
  const categoryName = "Assinaturas";

  await page.goto("/expenses");
  await addCategory(page, categoryName);

  await page.getByRole("tab", { name: "Recorrentes" }).click();
  const rules = page.getByRole("tabpanel", { name: "Recorrentes" });
  const create = async (
    amount: string,
    startsOn: string,
    description: string
  ) => {
    await rules
      .getByRole("button", { name: "Nova despesa recorrente" })
      .click();
    // the form is a dialog, outside the panel
    const form = page.getByRole("dialog", { name: "Nova despesa recorrente" });
    await form.getByLabel("Valor de cada ocorrência (R$)").fill(amount);
    await choose(page, form, "Categoria", categoryName);
    await choose(page, form, "Frequência", "Todo mês");
    await pickDate(form, "Começa em", startsOn);
    await form.getByLabel("Descrição").fill(description);
    await form
      .getByRole("button", { name: "Criar despesa recorrente" })
      .click();
    await expect(
      rules.getByRole("heading", { exact: true, name: description })
    ).toBeVisible();
  };
  await create("250,00", today, "Sistema da loja");
  await create("80,00", tomorrow, "Internet");

  // the occurrences the server generated, read by the owner: one, today's, in cents
  await expect
    .poll(async () =>
      (
        await sql.query<{ amount: string; competence_on: string }>(
          "SELECT amount::text, competence_on::text FROM expenses WHERE organization_id = $1 AND recurring_rule_id IS NOT NULL ORDER BY competence_on",
          [organizationId]
        )
      ).rows.map((row) => ({
        amount: numericCents(row.amount),
        on: row.competence_on,
      }))
    )
    .toEqual([{ amount: 25_000, on: today }]);

  await page.goto("/dashboard");
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toHaveText(BRL_VALUE);
  await expect
    .poll(async () =>
      cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
    )
    .toBe(25_000);
});

const PERIOD_SUMMARY_PATH = "/rpc/report/periodSummary";

/** Waits until `count` stops moving for a second: a count taken before that may still be missing a read on its way. */
async function settled(count: () => number): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const stable = count() === last;
        last = count();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return stable;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
}

/**
 * Journey 7b: the Resultado is read once in front of the person, and an expense written in the Despesas screen is in its
 * "(−) Despesas do período" when the person comes back, to the cent, with no press on "Atualizar". With nothing
 * written, going to another tab of the Resultado and back reads nothing again.
 */
test("despesa registrada em Despesas aparece no Resultado ao voltar, sem Atualizar", async ({
  browser,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa-resultado", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const today = localDate(runT0(), zone);
  const categoryName = "Energia";
  let summaryReads = 0;
  page.on("request", (request) => {
    if (request.url().includes(PERIOD_SUMMARY_PATH)) {
      summaryReads += 1;
    }
  });
  const register = async (amount: string, description: string) => {
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .and(page.locator("[data-expense-new]"))
      .click();
    const form = page.getByRole("dialog", { name: "Nova despesa" });
    await form.getByLabel("Valor (R$)").fill(amount);
    await choose(page, form, "Categoria", categoryName);
    await pickDate(form, "Data de competência", today);
    await form.getByLabel("Descrição").fill(description);
    await form.getByRole("button", { name: "Registrar despesa" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Despesa registrada.")).toBeVisible();
  };
  const openFromSidebar = async (name: "Despesas" | "Resultado") => {
    await page
      .getByRole("navigation", { exact: true, name: "Principal" })
      .getByRole("link", { exact: true, name })
      .click();
  };
  const expectExpensesOfPeriod = (expected: number) =>
    expect
      .poll(async () =>
        cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
      )
      .toBe(expected);

  await page.goto("/expenses");
  await addCategory(page, categoryName);
  await page.getByRole("tab", { name: "Lançamentos" }).click();
  await register("1.234,56", "Conta de luz");

  const tabs = page.getByRole("tablist", { name: "Resultado e metas" });
  await openFromSidebar("Resultado");
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toBeVisible();
  await expectExpensesOfPeriod(123_456);

  // a second expense, written from the other screen: the figure is the sum, not the one from before
  await openFromSidebar("Despesas");
  await register("100,00", "Conta de água");
  await settled(() => summaryReads);
  const readsBeforeReturn = summaryReads;
  await openFromSidebar("Resultado");
  await expectExpensesOfPeriod(133_456);
  expect(summaryReads).toBeGreaterThan(readsBeforeReturn);

  // nothing written: going to another tab and back asks the server for nothing (the reads in flight settle first)
  await settled(() => summaryReads);
  const before = summaryReads;
  await tabs.getByRole("tab", { exact: true, name: "Metas" }).click();
  await tabs.getByRole("tab", { exact: true, name: "Resultado" }).click();
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toBeVisible();
  await settled(() => summaryReads);
  expect(summaryReads).toBe(before);
});

const LIST_RULES_PATH = "/rpc/expense/listRules";

/**
 * The occurrence of a recurring rule that fell due is generated by the read of the list (`listExpenses`), not by the
 * read of the rules: Despesas does not read the rules on opening, so opening the Lançamentos tab is all that has to
 * show it. The rule is made through the Worker's command starting tomorrow (so `createRule` has
 * nothing to catch up) and then brought to today in the database, so only the opening of the list can generate it.
 */
test("despesa recorrente vencida: aparece em Lançamentos sem abrir Recorrentes", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa-vencida", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), zone);
  const tomorrow = addDays(today, 1);

  const category = await rpc.expense.createCategory({
    group: "operational",
    name: "Mensalidades",
    organizationId,
  });
  const rule = await rpc.expense.createRule({
    amount: "321.45",
    categoryId: category.id,
    description: "Mensalidade do sistema",
    frequency: "monthly",
    organizationId,
    startsOn: tomorrow,
  });
  const occurrencesOf = async () =>
    (
      await sql.query<{ competence_on: string }>(
        "SELECT competence_on::text FROM expenses WHERE organization_id = $1 AND recurring_rule_id = $2",
        [organizationId, rule.id]
      )
    ).rows.map((row) => row.competence_on);
  await expect.poll(occurrencesOf).toEqual([]);

  const moved = await sql.query(
    "UPDATE expense_recurring_rules SET starts_on = $1 WHERE id = $2 AND organization_id = $3",
    [today, rule.id, organizationId]
  );
  expect(moved.rowCount).toBe(1);
  await expect.poll(occurrencesOf).toEqual([]);

  let ruleReads = 0;
  page.on("request", (request) => {
    if (request.url().includes(LIST_RULES_PATH)) {
      ruleReads += 1;
    }
  });
  await page.goto("/expenses");
  await expect(page.getByRole("tab", { name: "Lançamentos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  const listed = page
    .getByRole("region", { name: "Despesas do período" })
    .filter({ hasText: "Mensalidade do sistema" });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText("321,45");
  await expect.poll(occurrencesOf).toEqual([today]);
  await settled(() => ruleReads);
  expect(ruleReads).toBe(0);

  await page.getByRole("tab", { name: "Recorrentes" }).click();
  await expect(
    page
      .getByRole("tabpanel", { name: "Recorrentes" })
      .getByRole("heading", { exact: true, name: "Mensalidade do sistema" })
  ).toBeVisible();
  await expect.poll(() => ruleReads).toBeGreaterThan(0);
});

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

const CATEGORY_CONFLICT =
  "Já existe uma categoria com esse nome, ou ela mudou em outra solicitação. A lista foi atualizada.";

interface CategoryRow {
  archived: boolean;
  group_key: string;
  id: string;
  name: string;
  updated_at: string;
  version: number;
}

/** The categories the person made (the ones the organization started with have a `system_key`), as the database holds them. */
async function categoriesOf(
  sql: Sql,
  organizationId: string
): Promise<CategoryRow[]> {
  const { rows } = await sql.query<CategoryRow>(
    `SELECT id, name, group_key, archived_at IS NOT NULL AS archived, version, updated_at::text AS updated_at
       FROM expense_categories
      WHERE organization_id = $1 AND system_key IS NULL
      ORDER BY name`,
    [organizationId]
  );
  return rows;
}

async function expensesOf(
  sql: Sql,
  organizationId: string
): Promise<{ amount: number; category_id: string }[]> {
  const { rows } = await sql.query<{ amount: string; category_id: string }>(
    "SELECT amount::text, category_id FROM expenses WHERE organization_id = $1 ORDER BY description",
    [organizationId]
  );
  return rows.map((row) => ({
    amount: numericCents(row.amount),
    category_id: row.category_id,
  }));
}

async function editedExpensesOf(
  sql: Sql,
  organizationId: string
): Promise<
  {
    amount: number;
    category_id: string;
    description: string;
    version: number;
  }[]
> {
  const { rows } = await sql.query<{
    amount: string;
    category_id: string;
    description: string;
    version: number;
  }>(
    "SELECT amount::text, category_id, description, version FROM expenses WHERE organization_id = $1 ORDER BY description",
    [organizationId]
  );
  return rows.map((row) => ({
    amount: numericCents(row.amount),
    category_id: row.category_id,
    description: row.description,
    version: row.version,
  }));
}

/** The one category the person made, once the database has it with the fields in `expected`; the row is the one the poll matched. */
async function onlyCategoryOf(
  sql: Sql,
  organizationId: string,
  expected: Partial<CategoryRow>
): Promise<CategoryRow> {
  let seen: CategoryRow[] = [];
  await expect
    .poll(async () => {
      seen = await categoriesOf(sql, organizationId);
      return seen;
    })
    .toEqual([expect.objectContaining(expected)]);
  return seen[0] as CategoryRow;
}

const categoryAlert = (scope: Locator, text: string) =>
  scope.getByRole("alert").filter({ hasText: text });

/**
 * The name of a category is one per organization, whatever the group and the letter case; a new name onto another
 * category's is refused the same way. The screen says so and the database keeps what it had.
 */
test("categoria de despesa: nome repetido na loja (outra caixa, outro grupo) e renomear em cima de outra são recusados", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "despesa-cat-nome", {
    organization: { timezone: extremeTimeZone(runT0()) },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const first = `Aluguel ${journey.name}`;
  const second = `Comissao ${journey.name}`;

  await page.goto("/expenses");
  await addCategory(page, first, "Operacional/Administrativa");
  const created = await onlyCategoryOf(sql, organizationId, {
    group_key: "operational",
    name: first,
  });

  const repeated = await openNewCategory(
    page,
    `  ${first.toUpperCase()}  `,
    "Comercial"
  );
  await repeated.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(categoryAlert(repeated, CATEGORY_CONFLICT)).toBeVisible();
  await expect
    .poll(async () => categoriesOf(sql, organizationId))
    .toEqual([created]);
  await repeated.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await addCategory(page, second, "Comercial");
  let before: CategoryRow[] = [];
  await expect
    .poll(async () => {
      before = await categoriesOf(sql, organizationId);
      return before.map((row) => [row.name, row.group_key]);
    })
    .toEqual([
      [first, "operational"],
      [second, "commercial"],
    ]);

  await page
    .getByRole("button", { exact: true, name: `Renomear categoria ${second}` })
    .click();
  const rename = page.getByRole("dialog", { name: "Renomear categoria" });
  await rename.getByLabel("Nome da categoria").fill(first.toLowerCase());
  await rename.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(categoryAlert(rename, CATEGORY_CONFLICT)).toBeVisible();
  await expect
    .poll(async () => categoriesOf(sql, organizationId))
    .toEqual(before);
});

/** Renaming changes the name and nothing else: the id and the group are the ones from before. */
test("categoria de despesa: renomear muda o nome e o banco guarda o mesmo id e o mesmo grupo", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "despesa-cat-renomear", {
    organization: { timezone: extremeTimeZone(runT0()) },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Contador ${journey.name}`;
  const renamed = `Contabilidade ${journey.name}`;

  await page.goto("/expenses");
  await addCategory(page, name, "Impostos");
  const created = await onlyCategoryOf(sql, organizationId, {
    group_key: "taxes",
    name,
  });

  await page
    .getByRole("button", { exact: true, name: `Renomear categoria ${name}` })
    .click();
  const form = page.getByRole("dialog", { name: "Renomear categoria" });
  await form.getByLabel("Nome da categoria").fill(renamed);
  await form.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${renamed}” renomeada.` })
  ).toBeVisible();

  await expect
    .poll(async () => categoriesOf(sql, organizationId))
    .toEqual([
      expect.objectContaining({
        group_key: "taxes",
        id: created.id,
        name: renamed,
      }),
    ]);
  const panel = page.getByRole("tabpanel", { name: "Categorias" });
  await expect(panel.getByText(renamed, { exact: true })).toBeVisible();
  await expect(panel.getByText(name, { exact: true })).toHaveCount(0);
});

/**
 * A category is never deleted, only archived: the row stays with the same id and a mark, and "Restaurar" takes the
 * mark off. An expense that was already in it stays in the list and in the Resultado of the month, to the cent; a new
 * one cannot be put in it, neither on the form (it is not offered) nor by a client that sends it (the server refuses).
 */
test("categoria de despesa: arquivar não apaga, a despesa lançada fica e a nova não é aceita; restaurar devolve", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa-cat-arquivar", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), zone);
  const name = `Marketing ${journey.name}`;

  await page.goto("/expenses");
  await addCategory(page, name, "Comercial");
  const created = await onlyCategoryOf(sql, organizationId, {
    archived: false,
    group_key: "commercial",
  });
  const categoryId = created.id;
  await rpc.expense.create({
    amount: "321.45",
    categoryId,
    competenceOn: today,
    description: "Anuncio de antes",
    organizationId,
  });

  const panel = page.getByRole("tabpanel", { name: "Categorias" });
  await panel
    .getByRole("button", { exact: true, name: `Arquivar categoria ${name}` })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${name}” arquivada.` })
  ).toBeVisible();
  const row = panel.locator("[data-category-id]").filter({ hasText: name });
  await expect(row).toHaveCount(0);
  await panel.getByRole("checkbox", { name: "Incluir arquivadas" }).check();
  await expect(row.getByText("Arquivada", { exact: true })).toBeVisible();
  await expect
    .poll(async () => categoriesOf(sql, organizationId))
    .toEqual([
      expect.objectContaining({
        archived: true,
        group_key: "commercial",
        id: categoryId,
      }),
    ]);

  // the expense from before is still there, in the list and in the Resultado, with the same value
  await page.getByRole("tab", { name: "Lançamentos" }).click();
  await expect(
    page
      .getByRole("region", { name: "Despesas do período" })
      .filter({ hasText: "Anuncio de antes" })
  ).toContainText(name);
  await expect
    .poll(async () => expensesOf(sql, organizationId))
    .toEqual([{ amount: 32_145, category_id: categoryId }]);
  const filters = page.getByRole("search", {
    exact: true,
    name: "Filtrar despesas",
  });
  await filters.getByRole("button", { name: FILTER_BUTTON }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: CATEGORY_ITEM })
    .click();
  const chooser = page.getByRole("dialog", { name: "Categoria" });
  await expect(
    chooser.getByRole("button", { exact: true, name: `${name} (arquivada)` })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chooser).toHaveCount(0);

  // editing the expense from before keeps its archived category selected and marked; saving another field leaves it there
  await page
    .getByRole("region", { name: "Despesas do período" })
    .getByRole("button", {
      exact: true,
      name: "Editar despesa Anuncio de antes",
    })
    .click();
  const editForm = page.getByRole("dialog", { name: "Editar despesa" });
  await expect(
    editForm.getByRole("combobox", { exact: true, name: "Categoria" })
  ).toContainText(`${name} (arquivada)`);
  await editForm.getByLabel("Descrição").fill("Anuncio de antes, revisado");
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Despesa atualizada.")).toBeVisible();
  await expect
    .poll(async () => editedExpensesOf(sql, organizationId))
    .toEqual([
      {
        amount: 32_145,
        category_id: categoryId,
        description: "Anuncio de antes, revisado",
        version: 2,
      },
    ]);

  // a new expense is not offered the archived category, and the server refuses it when a client sends it
  await page
    .getByRole("button", { exact: true, name: "Nova despesa" })
    .and(page.locator("[data-expense-new]"))
    .click();
  const form = page.getByRole("dialog", { name: "Nova despesa" });
  await form.getByRole("combobox", { exact: true, name: "Categoria" }).click();
  await expect(
    page.getByRole("option", { exact: true, name: "Aluguel" })
  ).toBeVisible();
  await expect(page.getByRole("option", { name })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await form.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await refusedWith(
      rpc.expense.create({
        amount: "10.00",
        categoryId,
        competenceOn: today,
        description: "Anuncio depois",
        organizationId,
      })
    )
  ).toBe("CONFLICT");
  await expect
    .poll(async () => expensesOf(sql, organizationId))
    .toEqual([{ amount: 32_145, category_id: categoryId }]);

  await page.goto("/dashboard");
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toHaveText(BRL_VALUE);
  await expect
    .poll(async () =>
      cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
    )
    .toBe(32_145);

  // restoring brings the same row back with the mark off
  await page.goto("/expenses");
  await page.getByRole("tab", { name: "Categorias" }).click();
  await panel.getByRole("checkbox", { name: "Incluir arquivadas" }).check();
  await panel
    .getByRole("button", { exact: true, name: `Restaurar categoria ${name}` })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Categoria “${name}” restaurada.` })
  ).toBeVisible();
  await expect
    .poll(async () => categoriesOf(sql, organizationId))
    .toEqual([
      expect.objectContaining({
        archived: false,
        group_key: "commercial",
        id: categoryId,
      }),
    ]);
  await expect(row).toBeVisible();
  await expect(
    panel.getByRole("button", {
      exact: true,
      name: `Arquivar categoria ${name}`,
    })
  ).toBeVisible();
  await expect(row.getByText("Arquivada", { exact: true })).toHaveCount(0);
});
