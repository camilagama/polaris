import type { Browser, Page, TestInfo } from "@playwright/test";
import { datePickerButton } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate, monthStart } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { openSaleAction } from "../pages/detalhe-da-venda";
import { makePro } from "../pages/resultado-historico";
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

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

async function goalsOf(sql: Sql, organizationId: string): Promise<GoalRow[]> {
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
  await form
    .getByRole("textbox", { name: "Nome Opcional" })
    .fill("Duas vendas no mês");
  await form.getByLabel("Alvo").fill("2");
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
  await form.getByLabel("Alvo").fill("5");
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

const PAUSED = "Pausada pelo plano";
const EDIT_BUTTON = /^Editar meta/;
const CANCEL_BUTTON = /^Cancelar meta/;
const PAUSED_EDIT_REFUSAL =
  "Seu plano permite menos metas em andamento do que você tem, então esta meta está pausada e não pode ser editada. Cancele-a ou aguarde o plano permitir.";

/**
 * The downgrade as the rule counts it: the subscription's access ended before the record changed, so the record keeps
 * its `active` state and only the end date is in the past (nothing of the goals is touched).
 */
async function endAccess(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `UPDATE organization_billing SET access_ends_at = now() - interval '1 day' WHERE organization_id = $1`,
    [organizationId]
  );
}

/** The downgrade once the record has changed: the free states never carry an end date. */
async function settleAsFree(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `UPDATE organization_billing SET state = 'free', access_ends_at = NULL, cycle_months = NULL WHERE organization_id = $1`,
    [organizationId]
  );
}

async function restoreAccess(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `UPDATE organization_billing SET access_ends_at = now() + interval '365 days' WHERE organization_id = $1`,
    [organizationId]
  );
}

/** Every column of every goal of the organization, oldest first: any write changes `updated_at` or `version`. */
async function goalColumns(
  sql: Sql,
  organizationId: string
): Promise<Record<string, unknown>[]> {
  const { rows } = await sql.query<{ goal: Record<string, unknown> }>(
    "SELECT to_jsonb(g) AS goal FROM goals g WHERE organization_id = $1 ORDER BY created_at, id",
    [organizationId]
  );
  return rows.map((row) => row.goal);
}

const cardOf = (page: Page, title: string) =>
  page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { exact: true, name: title }),
  });

/**
 * A Pro store in the extreme zone with `count` goals of "Número de vendas" in progress, created in order (targets 2, 3,
 * 4...) and one confirmed sale, so every goal has the same measured value: 1.
 */
async function proWithGoals(
  browser: Browser,
  testInfo: TestInfo,
  sql: Sql,
  journeyName: string,
  count: number
) {
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, journeyName, {
    organization: { timezone: zone },
  });
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), zone);
  await makePro(sql, organizationId);

  const product = await seedProduct(
    rpc,
    organizationId,
    "Garrafa térmica",
    "45.90"
  );
  await seedStock(rpc, organizationId, product.variantId, 10, "20.00", today);
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.90", quantity: 1, variantId: product.variantId }],
    new Date(runT0()).toISOString()
  );

  const titles: string[] = [];
  const created: { id: string; version: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const title = `${journey.name} meta ${String.fromCharCode(65 + index)}`;
    titles.push(title);
    // in order: the plan keeps the oldest
    // biome-ignore lint/performance/noAwaitInLoops: the creation order is what the plan reads
    const goal = await rpc.goal.create({
      endsOn: addDays(monthStart(today, 1), -1),
      kind: "sale_count",
      name: title,
      organizationId,
      startsOn: monthStart(today),
      target: String(index + 2),
    });
    created.push({ id: goal.id, version: goal.version });
  }
  return { created, journey, organizationId, rpc, titles, today };
}

/**
 * The downgrade of a Pro store with three goals in progress (Free allows 1, Pro 3): the oldest stays, the two newer
 * ones are "Pausada pelo plano" on screen, and nothing is written to them (every column of the three rows is the same
 * before and after, and the table has no paused state); a stale edit form is refused with the paused text; the
 * paused goal is not measured and has no Editar; the Pro back returns the three with the same targets and progress.
 */
test("metas depois do downgrade: a mais antiga continua, as 2 novas ficam pausadas sem gravar nada, não são medidas nem editadas, e voltam com o Pro", async ({
  browser,
  sql,
}, testInfo) => {
  const { created, journey, organizationId, rpc, titles } = await proWithGoals(
    browser,
    testInfo,
    sql,
    "meta-downgrade",
    3
  );
  const { page } = journey;
  const [titleA, titleB, titleC] = titles as [string, string, string];
  const goalB = created[1] as (typeof created)[number];
  const progressOf = (target: number) => `1 de ${target} vendas`;

  // AC-1.1: three goals in progress, in the order they were made, on screen and in the database
  await openGoals(page);
  const cardA = cardOf(page, titleA);
  const cardB = cardOf(page, titleB);
  const cardC = cardOf(page, titleC);
  for (const [card, target] of [
    [cardA, 2],
    [cardB, 3],
    [cardC, 4],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: three cards, each read once
    await expect(card).toContainText("Em andamento");
    await expect(card).toContainText(progressOf(target));
    await expect(card.getByRole("progressbar")).toHaveCount(1);
  }
  const before = await goalColumns(sql, organizationId);
  expect(
    before.map((row) => [row.name, row.status, row.target]),
    "three goals in progress, oldest first"
  ).toEqual([
    [titleA, "active", 2],
    [titleB, "active", 3],
    [titleC, "active", 4],
  ]);

  // the form of C is open on the page while the plan ends
  await page.getByRole("button", { name: `Editar meta ${titleC}` }).click();
  const staleForm = page.getByRole("form", { name: `Editar ${titleC}` });
  await staleForm.getByLabel("Alvo (número de vendas)").fill("9");

  // AC-1.2: the downgrade, with the goals untouched
  await endAccess(sql, organizationId);

  // AC-1.4 (screen): saving the stale form is refused with the text of the paused goal, and the row does not change
  await staleForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText(PAUSED_EDIT_REFUSAL)).toBeVisible();
  await expect.poll(() => goalColumns(sql, organizationId)).toEqual(before);

  // AC-1.2: the oldest goal goes on, the two newer ones are paused
  await refresh(page);
  await expect(cardA).toContainText("Em andamento");
  await expect(cardA).toContainText(progressOf(2));
  await expect(cardA).not.toContainText(PAUSED);
  for (const card of [cardB, cardC]) {
    // biome-ignore lint/performance/noAwaitInLoops: two cards, each read once
    await expect(card).toContainText(PAUSED);
    await expect(card).not.toContainText("Em andamento");
    // AC-1.4: not measured (no bar, no figure of progress) and no way to edit; the way out is to cancel
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card).not.toContainText("1 de");
    await expect(card).toContainText("não é medida nem pode ser editada");
    await expect(card.getByRole("button", { name: EDIT_BUTTON })).toHaveCount(
      0
    );
    await expect(
      card.getByRole("button", { name: CANCEL_BUTTON })
    ).toBeVisible();
  }
  await expect(page.getByText(PAUSED, { exact: true })).toHaveCount(2);

  // AC-1.3: nothing was written: every column of the three rows is what it was, and there is no paused state
  expect(await goalColumns(sql, organizationId)).toEqual(before);
  const { rows: pausedColumns } = await sql.query<{ column: string }>(
    `SELECT column_name AS "column" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'goals' AND column_name ILIKE '%paus%'`
  );
  expect(pausedColumns).toEqual([]);
  const { rows: states } = await sql.query<{ status: string }>(
    "SELECT DISTINCT status FROM goals WHERE organization_id = $1",
    [organizationId]
  );
  expect(states).toEqual([{ status: "active" }]);

  // AC-1.4 (RPC): editing a paused goal is refused with its reason, and the row does not change
  const refused = await rpc.goal
    .update({
      expectedVersion: goalB.version,
      id: goalB.id,
      organizationId,
      target: "8",
    })
    .then(
      () => null,
      (error: unknown) => error as { code?: string; data?: { reason?: string } }
    );
  expect(refused?.code).toBe("CONFLICT");
  expect(refused?.data?.reason).toBe("goal_paused_by_plan");
  expect(await goalColumns(sql, organizationId)).toEqual(before);

  // AC-1.5: the Pro is back, and the three return as they were: same rows, same targets, same progress
  await restoreAccess(sql, organizationId);
  await refresh(page);
  for (const [card, target] of [
    [cardA, 2],
    [cardB, 3],
    [cardC, 4],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: three cards, each read once
    await expect(card).toContainText("Em andamento");
    await expect(card).not.toContainText(PAUSED);
    await expect(card).toContainText(progressOf(target));
    await expect(card.getByRole("progressbar")).toHaveCount(1);
  }
  expect(await goalColumns(sql, organizationId)).toEqual(before);
});

/**
 * A paused goal can be cancelled (the way out the card offers), with the billing record already in the free state
 * (the other tests leave it `active` with the end date in the past): it becomes "Cancelada", leaves the paused ones, and
 * the other goals' rows are not touched.
 */
test("meta pausada pelo downgrade: pode ser cancelada pela tela, sai das pausadas e não mexe nas outras", async ({
  browser,
  sql,
}, testInfo) => {
  const { journey, organizationId, titles } = await proWithGoals(
    browser,
    testInfo,
    sql,
    "meta-downgrade-cancela",
    3
  );
  const { page } = journey;
  const [titleA, titleB, titleC] = titles as [string, string, string];
  await settleAsFree(sql, organizationId);
  const before = await goalColumns(sql, organizationId);

  await openGoals(page);
  await expect(cardOf(page, titleB)).toContainText(PAUSED);
  await expect(cardOf(page, titleC)).toContainText(PAUSED);

  await page.getByRole("button", { name: `Cancelar meta ${titleB}` }).click();
  await page
    .getByRole("dialog", { name: `Cancelar a meta ${titleB}?` })
    .getByRole("button", { name: "Confirmar cancelamento" })
    .click();
  await expect(
    page.getByText("Meta cancelada. Ela fica na lista, só para leitura.")
  ).toBeVisible();

  await expect(cardOf(page, titleB)).toContainText("Cancelada");
  await expect(cardOf(page, titleB)).not.toContainText(PAUSED);
  await expect(cardOf(page, titleC)).toContainText(PAUSED);
  await expect(cardOf(page, titleA)).toContainText("Em andamento");
  await expect(page.getByText(PAUSED, { exact: true })).toHaveCount(1);

  await expect
    .poll(async () => {
      const after = await goalColumns(sql, organizationId);
      return after.map((row, index) => ({
        changed: JSON.stringify(row) !== JSON.stringify(before[index]),
        name: row.name,
        status: row.status,
      }));
    })
    .toEqual([
      { changed: false, name: titleA, status: "active" },
      { changed: true, name: titleB, status: "cancelled" },
      { changed: false, name: titleC, status: "active" },
    ]);
});

/**
 * A goal whose period already ended is never paused, even above the limit, and takes no place: the read settles it.
 * Free allows 1; the store has two in progress this month, one ended goal older than both and one newer (written
 * straight into the table, since the form takes only the current period).
 */
test("meta de período terminado não aparece pausada acima do limite: é liquidada na leitura", async ({
  browser,
  sql,
}, testInfo) => {
  const { journey, organizationId, titles, today } = await proWithGoals(
    browser,
    testInfo,
    sql,
    "meta-downgrade-vencida",
    2
  );
  const { page } = journey;
  const [titleA, titleB] = titles as [string, string];
  const endedTitles = [
    `${journey.name} meta vencida antiga`,
    `${journey.name} meta vencida nova`,
  ];
  for (const [title, createdAt] of [
    [endedTitles[0], "now() - interval '40 days'"],
    [endedTitles[1], "now() + interval '1 minute'"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: two rows, in order
    await sql.query(
      `INSERT INTO goals (organization_id, kind, target, starts_on, ends_on, name, created_at)
       VALUES ($1, 'sale_count', 5, $2, $3, $4, ${createdAt})`,
      [
        organizationId,
        monthStart(today, -1),
        addDays(monthStart(today), -1),
        title,
      ]
    );
  }
  await endAccess(sql, organizationId);

  await openGoals(page);
  await expect(cardOf(page, titleA)).toContainText("Em andamento");
  await expect(cardOf(page, titleB)).toContainText(PAUSED);
  for (const title of endedTitles) {
    const ended = cardOf(page, title);
    // biome-ignore lint/performance/noAwaitInLoops: two cards, each read once
    await expect(ended).toContainText("Não atingida");
    await expect(ended).not.toContainText(PAUSED);
  }
  await expect(page.getByText(PAUSED, { exact: true })).toHaveCount(1);
  await expect
    .poll(async () => {
      const { rows } = await sql.query<{ status: string }>(
        "SELECT status FROM goals WHERE organization_id = $1 AND name = ANY($2) ORDER BY name",
        [organizationId, endedTitles]
      );
      return rows.map((row) => row.status);
    })
    .toEqual(["missed", "missed"]);
});
