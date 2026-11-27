import type { Page } from "@playwright/test";
import { pickDate } from "../../e2e/date-pickers";
import { extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { choose } from "../pages/venda";

const EXPENSES_OF_PERIOD = "(−) Despesas do período (sem venda)";
const BRL_VALUE = /R\$/;
const NOTHING_IN_PERIOD = /^Sem vendas nem despesas em /;
const DESCRIPTION = "Aluguel do galpão";
const CATEGORY = "Aluguel da loja";

interface StoredExpense {
  amount: number;
  version: number;
  voided: boolean;
}

const expenseRow = (page: Page, text: string) =>
  page.locator("[data-expense-id]").filter({ hasText: text });

const statusTabs = (page: Page) =>
  page.getByRole("tablist", { exact: true, name: "Situação" });

async function showStatus(page: Page, status: "Anuladas" | "Ativas") {
  const option = statusTabs(page).getByRole("tab", {
    exact: true,
    name: status,
  });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

async function registerExpense(
  page: Page,
  values: { amount: string; competenceOn: string }
) {
  await page
    .getByRole("button", { exact: true, name: "Nova despesa" })
    .and(page.locator("[data-expense-new]"))
    .click();
  const form = page.getByRole("dialog", { name: "Nova despesa" });
  await form.getByLabel("Valor", { exact: true }).fill(values.amount);
  await choose(page, form, "Categoria", CATEGORY);
  await pickDate(form, "Data de competência", values.competenceOn);
  await form.getByLabel("Descrição").fill(DESCRIPTION);
  await form.getByRole("button", { name: "Registrar despesa" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Despesa registrada.")).toBeVisible();
}

async function openEdit(page: Page) {
  await page
    .getByRole("button", { name: `Editar despesa ${DESCRIPTION}` })
    .click();
  return page.getByRole("dialog", { name: "Editar despesa" });
}

async function expectResultExpenses(page: Page, expected: number) {
  await page.goto("/dashboard");
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toHaveText(BRL_VALUE);
  await expect
    .poll(async () =>
      cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
    )
    .toBe(expected);
}

/**
 * The Despesas screen against the real database: edit, void and restore change the amount in cents and the status
 * in the table, and the "(−) Despesas do período" of the Resultado follows them to the cent. The organization is in
 * the extreme zone of the run, so the competence date is the organization's day, never a constant.
 */
test("despesa editada e anulada: o banco, a lista e o Resultado concordam em centavos, e reativar devolve o valor", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(
    browser,
    testInfo,
    "despesa-editar-anular",
    {
      organization: { timezone: zone },
    }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  await journey.user.rpc.expense.createCategory({
    group: "operational",
    name: CATEGORY,
    organizationId,
  });
  const stored = async (): Promise<StoredExpense[]> =>
    (
      await sql.query<{ amount: string; version: number; voided: boolean }>(
        "SELECT amount::text, version, voided_at IS NOT NULL AS voided FROM expenses WHERE organization_id = $1",
        [organizationId]
      )
    ).rows.map((row) => ({
      amount: numericCents(row.amount),
      version: row.version,
      voided: row.voided,
    }));

  await page.goto("/expenses");
  await registerExpense(page, { amount: "100,00", competenceOn: today });
  await expect(expenseRow(page, DESCRIPTION)).toContainText("R$ 100,00");
  await expect
    .poll(stored)
    .toEqual([{ amount: 10_000, version: 1, voided: false }]);
  await expectResultExpenses(page, 10_000);

  // edit to 120,50: the amount is in cents in the table, the version went up, list and Resultado say 120,50
  await page.goto("/expenses");
  const editForm = await openEdit(page);
  await expect(editForm.getByLabel("Valor", { exact: true })).toHaveValue(
    "100,00"
  );
  await editForm.getByLabel("Valor", { exact: true }).fill("120,50");
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Despesa atualizada.")).toBeVisible();
  await expect(expenseRow(page, DESCRIPTION)).toContainText("R$ 120,50");
  await expect
    .poll(stored)
    .toEqual([{ amount: 12_050, version: 2, voided: false }]);
  await expectResultExpenses(page, 12_050);

  // void: out of "Ativas" and of the Resultado, in "Anuladas" with no "Editar", voided in the table
  await page.goto("/expenses");
  await page
    .getByRole("button", { name: `Mais ações para ${DESCRIPTION}` })
    .click();
  await page
    .getByRole("menuitem", { name: `Anular despesa ${DESCRIPTION}` })
    .click();
  await expect(expenseRow(page, DESCRIPTION)).toHaveCount(0);
  await expect
    .poll(async () => (await stored()).map((row) => row.voided))
    .toEqual([true]);
  const [voided] = await stored();
  expect(voided?.amount).toBe(12_050);
  await showStatus(page, "Anuladas");
  await expect(expenseRow(page, DESCRIPTION)).toContainText("R$ 120,50");
  await expect(
    page.getByRole("button", { name: `Editar despesa ${DESCRIPTION}` })
  ).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("status").getByText(NOTHING_IN_PERIOD),
    "a anulada sai do Resultado: sem vendas nem despesas"
  ).toBeVisible();
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toHaveCount(0);

  // restore: back in the list and in the Resultado with the same amount
  await page.goto("/expenses");
  await showStatus(page, "Anuladas");
  await page
    .getByRole("button", { name: `Reativar despesa ${DESCRIPTION}` })
    .click();
  await expect
    .poll(async () => (await stored()).map((row) => row.voided))
    .toEqual([false]);
  await showStatus(page, "Ativas");
  await expect(expenseRow(page, DESCRIPTION)).toContainText("R$ 120,50");
  expect((await stored())[0]?.amount).toBe(12_050);
  await expectResultExpenses(page, 12_050);
});

/**
 * A concurrent edit made straight through `rpc.expense.update` while the screen has the edit open. The screen's save
 * is on an old version, so it is refused with the screen's message and the table keeps only the rpc edit. Syncing
 * between tabs or devices is not exercised here.
 */
test("despesa editada sobre uma versão antiga: a tela avisa e o banco guarda só a outra edição", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(
    browser,
    testInfo,
    "despesa-versao-antiga",
    { organization: { timezone: zone } }
  );
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), zone);
  const category = await rpc.expense.createCategory({
    group: "operational",
    name: CATEGORY,
    organizationId,
  });
  const created = await rpc.expense.create({
    amount: "100.00",
    categoryId: category.id,
    competenceOn: today,
    description: DESCRIPTION,
    organizationId,
  });

  await page.goto("/expenses");
  const editForm = await openEdit(page);
  await expect(editForm.getByLabel("Valor", { exact: true })).toHaveValue(
    "100,00"
  );

  const other = await rpc.expense.update({
    amount: "130.00",
    categoryId: category.id,
    competenceOn: today,
    description: DESCRIPTION,
    expectedVersion: created.version,
    id: created.id,
    organizationId,
  });
  expect(other.expense.version).toBe(created.version + 1);

  await editForm.getByLabel("Valor", { exact: true }).fill("140,00");
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Esta despesa mudou em outra solicitação" })
      .first()
  ).toBeVisible();

  await expect(expenseRow(page, DESCRIPTION)).toContainText("R$ 130,00");

  const rows = (
    await sql.query<{ amount: string; version: number }>(
      "SELECT amount::text, version FROM expenses WHERE organization_id = $1",
      [organizationId]
    )
  ).rows.map((row) => ({
    amount: numericCents(row.amount),
    version: row.version,
  }));
  expect(rows).toEqual([{ amount: 13_000, version: created.version + 1 }]);
});
