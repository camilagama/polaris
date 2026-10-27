import type { Page } from "@playwright/test";
import { pickDate } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { choose } from "../pages/venda";

const BRL_VALUE = /R\$/;
const EXPENSES_OF_PERIOD = "(−) Despesas do período (sem venda)";

/** Categorias, a part of the Despesas tab: the new category in its dialog, then back to Lançamentos. */
async function addCategory(page: Page, categoryName: string): Promise<void> {
  await page.getByRole("tab", { name: "Categorias" }).click();
  const categories = page.getByRole("tabpanel", { name: "Categorias" });
  await categories
    .getByRole("button", { exact: true, name: "Nova categoria" })
    .click();
  const form = page.getByRole("dialog", { name: "Nova categoria" });
  await choose(page, form, "Grupo", "Operacional/Administrativa");
  await form.getByLabel("Nome da categoria").fill(categoryName);
  await form.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
  expect(cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())).toBe(
    25_000
  );
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
 * Journey 7b: the Resultado is read once in front of the person, and an expense written in the Despesas tab (a
 * second tab of the same page, no reload) is in its "(−) Despesas do período" when the person comes back, to the cent,
 * with no press on "Atualizar". With nothing written, coming back reads nothing again.
 */
test("despesa registrada na aba Despesas aparece no Resultado ao voltar, sem Atualizar", async ({
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
  const expectExpensesOfPeriod = (expected: number) =>
    expect
      .poll(async () =>
        cents(await chainValue(page, EXPENSES_OF_PERIOD).innerText())
      )
      .toBe(expected);

  // the page opens on the Despesas tab: the Resultado was read there, with nothing in the month
  await page.goto("/expenses");
  await addCategory(page, categoryName);
  await page.getByRole("tab", { name: "Lançamentos" }).click();
  await register("1.234,56", "Conta de luz");

  const tabs = page.getByRole("tablist", {
    name: "Resultado, metas e despesas",
  });
  await tabs.getByRole("tab", { exact: true, name: "Resultado" }).click();
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toBeVisible();
  await expectExpensesOfPeriod(123_456);

  // a second expense, written from the other tab: the figure is the sum, not the one from before
  await tabs.getByRole("tab", { exact: true, name: "Despesas" }).click();
  await register("100,00", "Conta de água");
  await tabs.getByRole("tab", { exact: true, name: "Resultado" }).click();
  await expectExpensesOfPeriod(133_456);

  // nothing written: going to another tab and back asks the server for nothing (the reads in flight settle first)
  await settled(() => summaryReads);
  const before = summaryReads;
  await tabs.getByRole("tab", { exact: true, name: "Metas" }).click();
  await tabs.getByRole("tab", { exact: true, name: "Resultado" }).click();
  await expect(chainValue(page, EXPENSES_OF_PERIOD)).toBeVisible();
  await settled(() => summaryReads);
  expect(summaryReads).toBe(before);
});
