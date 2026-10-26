import type { Page } from "@playwright/test";
import { pickDate } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { choose } from "../pages/venda";

const BRL_VALUE = /R\$/;
const EXPENSES_OF_PERIOD = "(−) Despesas do período (sem venda)";

async function addCategory(page: Page, categoryName: string): Promise<void> {
  await page.getByRole("button", { name: "Categorias de despesa" }).click();
  const categories = page.getByRole("region", {
    name: "Categorias de despesa",
  });
  await choose(page, categories, "Grupo", "Operacional/Administrativa");
  await categories.getByLabel("Nome da categoria").fill(categoryName);
  await categories.getByRole("button", { name: "Adicionar categoria" }).click();
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

  const form = page.getByRole("region", {
    exact: true,
    name: "Nova despesa",
  });
  const register = async (
    amount: string,
    competenceOn: string,
    description: string
  ) => {
    await form.getByLabel("Valor (R$)").fill(amount);
    await choose(page, form, "Categoria", categoryName);
    await pickDate(form, "Data de competência", competenceOn);
    await form.getByLabel("Descrição").fill(description);
    await form.getByRole("button", { name: "Registrar despesa" }).click();
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
  expect(cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())).toBe(
    123_456
  );
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

  await page.getByRole("button", { name: "Despesas recorrentes" }).click();
  const rules = page.getByRole("region", { name: "Despesas recorrentes" });
  const create = async (
    amount: string,
    startsOn: string,
    description: string
  ) => {
    await rules
      .getByRole("button", { name: "Nova despesa recorrente" })
      .click();
    // the form is a dialog, outside the region of the panel
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
  expect(cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())).toBe(
    25_000
  );
});
