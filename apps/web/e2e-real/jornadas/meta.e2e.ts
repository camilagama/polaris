import type { Page } from "@playwright/test";
import { datePickerButton } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { openSaleAction } from "../pages/detalhe-da-venda";
import { choose } from "../pages/venda";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const LIMIT_REFUSAL =
  "Seu plano chegou ao limite de metas em andamento. Nada foi criado.";

interface GoalRow {
  achieved: string | null;
  endsOn: string;
  kind: string;
  settled: boolean;
  startsOn: string;
  status: string;
  target: string;
}

/** "AAAA-MM-DD" as the picker of the form says it: "dd/mm". */
function dayAndMonth(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

async function goalsOf(
  sql: Parameters<Parameters<typeof test>[2]>[0]["sql"],
  organizationId: string
): Promise<GoalRow[]> {
  const { rows } = await sql.query<GoalRow>(
    `SELECT kind, target::text AS target, starts_on::text AS "startsOn", ends_on::text AS "endsOn", status,
            achieved_value::text AS achieved, settled_at IS NOT NULL AS settled
       FROM goals WHERE organization_id = $1 ORDER BY created_at`,
    [organizationId]
  );
  return rows;
}

async function openGoals(page: Page) {
  await page.goto("/dashboard");
  await page.getByRole("tab", { name: "Metas" }).click();
  await expect(
    page.getByRole("region", { exact: true, name: "Metas" })
  ).toBeVisible();
}

const refresh = (page: Page) =>
  page.getByRole("button", { name: "Atualizar metas" }).click();

/**
 * A goal of "Número de vendas" with a target of 2 is created on screen for the month of the organization
 * (in the extreme zone of the run, so the month is the store's, not UTC's); with one sale it stays in progress, with
 * the second it becomes "Concluída" on screen and in the database, and cancelling one of the two sales afterwards
 * does not reopen it: the status and the value reached stay as they were (the goals rule of the results business rules).
 * Free plan: a second goal with one in progress is refused with the plan's limit, and nothing is created.
 */
test("meta de número de vendas: criada pela tela, conclui com a 2ª venda e não reabre quando uma venda é cancelada", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "meta", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), zone);
  const firstDay = monthStart(today);
  const lastDay = addDays(monthStart(today, 1), -1);

  const product = await seedProduct(
    rpc,
    organizationId,
    "Garrafa térmica",
    "45.90"
  );
  await seedStock(rpc, organizationId, product.variantId, 10, "20.00", today);
  const sell = () =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.90", quantity: 1, variantId: product.variantId }],
      new Date(runT0()).toISOString()
    );

  await openGoals(page);
  await page.getByRole("button", { name: "Nova meta" }).click();
  const form = page.getByRole("dialog", { name: "Nova meta" });
  await choose(page, form, "Indicador", "Número de vendas");
  await expect(datePickerButton(form, "Período da meta")).toHaveAccessibleName(
    `Período da meta, ${dayAndMonth(firstDay)} a ${dayAndMonth(lastDay)}`
  );
  await form.locator("#goal-create-name").fill("Duas vendas no mês");
  await form.locator("#goal-create-target").fill("2");
  await form.getByRole("button", { name: "Criar meta" }).click();
  await expect(page.getByText("Meta criada.")).toBeVisible();

  // the exact target and the whole month of the store
  await expect
    .poll(() => goalsOf(sql, organizationId))
    .toEqual([
      {
        achieved: null,
        endsOn: lastDay,
        kind: "sale_count",
        settled: false,
        startsOn: firstDay,
        status: "active",
        target: "2",
      },
    ]);
  const goal = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Duas vendas no mês",
    }),
  });
  await expect(goal).toContainText("Em andamento");
  await expect(goal).toContainText("0 de 2 vendas");

  // Free plan: one goal in progress is the limit
  await page.getByRole("button", { name: "Nova meta" }).click();
  await form.locator("#goal-create-target").fill("5");
  await form.getByRole("button", { name: "Criar meta" }).click();
  await expect(form.getByRole("alert")).toContainText(LIMIT_REFUSAL);
  await form.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await goalsOf(sql, organizationId)).toHaveLength(1);

  // one sale of two: in progress
  const firstSale = await sell();
  await refresh(page);
  await expect(goal).toContainText("1 de 2 vendas");
  await expect(goal).toContainText("Em andamento");
  await expect(goal.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50"
  );
  expect((await goalsOf(sql, organizationId))[0]).toMatchObject({
    achieved: null,
    status: "active",
  });

  // the second one reaches it
  await sell();
  await refresh(page);
  await expect(goal).toContainText("Concluída");
  await expect(goal).toContainText("atingido com 2");
  await expect
    .poll(async () => (await goalsOf(sql, organizationId))[0])
    .toMatchObject({ settled: true, status: "completed", target: "2" });
  const [settled] = await goalsOf(sql, organizationId);
  expect(Number(settled?.achieved)).toBe(2);

  // cancelling one of the two sales does not reopen it
  await page.goto(`/sales/detail?saleId=${firstSale}`);
  await openSaleAction(page, "Cancelar venda");
  const panel = page.getByRole("dialog", { name: "Cancelar venda" });
  await panel.getByRole("button", { name: "Revisar cancelamento" }).click();
  await panel.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{ cancelled: number }>(
        "SELECT count(*)::int AS cancelled FROM sale_cancellations WHERE sale_id = $1",
        [firstSale]
      );
      return rows[0]?.cancelled;
    })
    .toBe(1);
  // the cancelled sale left the count: one confirmed sale stands, so the goal's target of 2 is no longer met
  const { rows: standing } = await sql.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM sales s
      WHERE s.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM sale_cancellations c WHERE c.sale_id = s.id)`,
    [organizationId]
  );
  expect(standing[0]?.total).toBe(1);

  await openGoals(page);
  await refresh(page);
  const reread = page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Duas vendas no mês",
    }),
  });
  await expect(reread).toContainText("Concluída");
  await expect(reread).toContainText("atingido com 2");
  await expect(page.getByRole("heading", { name: "Em andamento" })).toHaveCount(
    0
  );
  expect(await goalsOf(sql, organizationId)).toEqual([
    {
      achieved: settled?.achieved,
      endsOn: lastDay,
      kind: "sale_count",
      settled: true,
      startsOn: firstDay,
      status: "completed",
      target: "2",
    },
  ]);
});
