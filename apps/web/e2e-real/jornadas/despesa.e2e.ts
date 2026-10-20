import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";

/**
 * Journey 7: a one-off expense in the month of T0 enters the list and the Resultado of the month, in cents; an
 * expense of another month (computed, never a constant) does not. The organization is in the extreme zone of the
 * run, so "the month" is the organization's, not UTC's.
 */
test("despesa avulsa: entra na lista e no Resultado do mês; a de outro mês não entra", async ({ browser, sql }, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "despesa", { organization: { timezone: zone } });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const otherMonth = addDays(monthStart(today), -1); // the last day of the previous month
  const categoryName = "Aluguel da loja";

  await page.goto("/expenses");
  await page.getByText("Categorias de despesa").click();
  const categories = page.getByRole("group").filter({ hasText: "Categorias de despesa" });
  await categories.getByLabel("Grupo").selectOption({ label: "Operacional/Administrativa" });
  await categories.getByLabel("Nome da categoria").fill(categoryName);
  await categories.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(categories.getByText(categoryName, { exact: true })).toBeVisible();

  const form = page.getByRole("region", { name: "Nova despesa" });
  const register = async (amount: string, competenceOn: string, description: string) => {
    await form.getByLabel("Valor (R$)").fill(amount);
    await form.getByLabel("Categoria").selectOption({ label: categoryName });
    await form.getByLabel("Data de competência").fill(competenceOn);
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
      ).rows.map((row) => ({ amount: numericCents(row.amount), on: row.competence_on }))
    )
    .toEqual([
      { amount: 123_456, on: today },
      { amount: 9999, on: otherMonth },
    ]);

  // the list of the period shows the one of this month
  await expect(page.getByRole("region", { name: "Despesas do período" }).getByText("Aluguel deste mês")).toBeVisible();

  await page.goto("/dashboard");
  await expect(chainValue(page, "(−) Despesas do período (sem venda)")).toHaveText(/R\$/);
  expect(cents(await chainValue(page, "(−) Despesas do período (sem venda)").innerText())).toBe(123_456);
});
