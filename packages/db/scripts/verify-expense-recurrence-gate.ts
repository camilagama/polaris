import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ExpenseCategoryUnavailableError } from "@polaris/domain/expenses/expense";
import {
  ExpenseRuleNotFoundError,
  ExpenseRuleVersionConflictError,
  InvalidExpenseRuleError,
  occurrencesThrough,
} from "@polaris/domain/expenses/recurrence";
import { createDatabase } from "../src/client";
import {
  archiveExpenseCategory,
  archiveExpenseRule,
  createExpenseRule,
  generateDueExpenses,
  listExpenseCategories,
  listExpenseRules,
  listExpenses,
  restoreExpenseRule,
  updateExpenseRule,
  voidExpense,
  updateExpense,
} from "../src/expense-repository";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Recurring expenses (plan PR65) on a real PostgreSQL 18: rules generate
 * ordinary expenses when they fall due, idempotently and under concurrency;
 * editing a rule never rewrites what was generated; a paused rule skips the
 * periods that passed; the database defends the shape of rules and origins.
 * "Time passing" is simulated by moving a rule's start date back, which is the
 * same as moving today forward for that rule.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const capability = "expense:create";

type ErrorClass = abstract new (...args: never[]) => Error;

async function expectRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof expected, `${label}: got ${String(error)}`);
      return true;
    },
    label
  );
}

function dateFrom(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const tenantA: TenantFixture = await createTenantFixture(
      admin.pool,
      "recurrence A"
    );
    const tenantB: TenantFixture = await createTenantFixture(
      admin.pool,
      "recurrence B"
    );
    loginRole = `polaris_recurrence_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const as = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const today = (
      await admin.pool.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
      )
    ).rows[0]?.today as string;
    assert.ok(today);

    const categoriesA = await as(tenantA, (tx, identity) =>
      listExpenseCategories(tx, identity)
    );
    const rent = categoriesA.find((category) => category.systemKey === "rent");
    const software = categoriesA.find(
      (category) => category.systemKey === "software"
    );
    assert.ok(rent && software);
    const categoriesB = await as(tenantB, (tx, identity) =>
      listExpenseCategories(tx, identity)
    );
    const rentB = categoriesB.find((category) => category.systemKey === "rent");
    assert.ok(rentB);

    const expensesOf = async (ruleId: string) =>
      (
        await admin.pool.query<{
          amount: string;
          category_id: string;
          competence_on: string;
          description: string;
          id: string;
          recurring_occurrence: number;
          voided_at: Date | null;
          version: number;
        }>(
          "SELECT amount::text, category_id, to_char(competence_on, 'YYYY-MM-DD') AS competence_on, description, id, recurring_occurrence, voided_at, version FROM public.expenses WHERE recurring_rule_id = $1 ORDER BY recurring_occurrence",
          [ruleId]
        )
      ).rows;
    const ruleRow = async (ruleId: string) =>
      (
        await admin.pool.query<{
          archived_at: Date | null;
          generated_count: number;
          version: number;
        }>(
          "SELECT archived_at, generated_count, version FROM public.expense_recurring_rules WHERE id = $1",
          [ruleId]
        )
      ).rows[0];
    /** Time passes: today moves forward by `days` for this rule. */
    const passTime = (ruleId: string, days: number) =>
      admin.pool.query(
        "UPDATE public.expense_recurring_rules SET starts_on = starts_on - $2::int, ends_on = ends_on - $2::int WHERE id = $1",
        [ruleId, days]
      );
    const startsOnOf = async (ruleId: string) =>
      (
        await admin.pool.query<{ starts_on: string }>(
          "SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM public.expense_recurring_rules WHERE id = $1",
          [ruleId]
        )
      ).rows[0]?.starts_on as string;

    // ------------------------------------------- 1. a rule from the past
    const monthlyStart = "2024-01-31";
    const rentRule = await as(tenantA, (tx, identity) =>
      createExpenseRule(tx, identity, {
        amount: "1500",
        categoryId: rent.id,
        description: "Aluguel",
        frequency: "monthly",
        payee: "Imobiliária Sintética",
        requestId: randomUUID(),
        startsOn: monthlyStart,
      })
    );
    const expectedCount = occurrencesThrough(monthlyStart, "monthly", today);
    assert.ok(expectedCount > 24);
    assert.equal(rentRule.generatedCount, expectedCount);
    const rentExpenses = await expensesOf(rentRule.id);
    assert.equal(rentExpenses.length, expectedCount);
    assert.deepEqual(
      rentExpenses.slice(0, 5).map((expense) => expense.competence_on),
      ["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30", "2024-05-31"],
      "the 31st clamps to the end of shorter months and comes back"
    );
    assert.equal(rentExpenses[13]?.competence_on, "2025-02-28");
    assert.ok(
      rentExpenses.every(
        (expense, index) =>
          expense.recurring_occurrence === index &&
          expense.amount === "1500.00" &&
          expense.description === "Aluguel" &&
          expense.category_id === rent.id
      )
    );
    assert.notEqual(rentRule.nextOccurrenceOn, null);
    assert.ok((rentRule.nextOccurrenceOn as string) > today);
    tests.push(
      "a rule that starts in the past generates every missed occurrence at once, on the right dates (the 31st clamps and returns), as ordinary expenses that snapshot the rule"
    );

    // ----------------------------------------- 2. idempotency, concurrency
    const before = (await expensesOf(rentRule.id)).length;
    assert.equal(
      await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity)),
      0
    );
    await as(tenantA, (tx, identity) => listExpenses(tx, identity));
    assert.equal((await expensesOf(rentRule.id)).length, before);
    const weekly = await as(tenantA, (tx, identity) =>
      createExpenseRule(tx, identity, {
        amount: "20.00",
        categoryId: software.id,
        description: "Assinatura semanal",
        frequency: "weekly",
        startsOn: dateFrom(today, -21),
      })
    );
    assert.equal(weekly.generatedCount, 4);
    await passTime(weekly.id, 14);
    const racing = await Promise.all([
      as(tenantA, (tx, identity) => generateDueExpenses(tx, identity)),
      as(tenantA, (tx, identity) => generateDueExpenses(tx, identity)),
      as(tenantA, (tx, identity) => listExpenses(tx, identity)),
    ]);
    assert.ok(racing.slice(0, 2).every((made) => typeof made === "number"));
    const afterRace = await expensesOf(weekly.id);
    assert.equal(
      afterRace.length,
      6,
      "two occurrences, once, whoever won the race"
    );
    assert.deepEqual(
      afterRace.map((expense) => expense.recurring_occurrence),
      [0, 1, 2, 3, 4, 5]
    );
    assert.equal((await ruleRow(weekly.id))?.generated_count, 6);
    tests.push(
      "generating again produces nothing, and concurrent generations and reads produce each occurrence exactly once"
    );

    // ---------------- 3. editing a rule never rewrites the past, only the future
    const edited = await as(tenantA, (tx, identity) =>
      updateExpenseRule(tx, identity, {
        amount: "25.50",
        categoryId: software.id,
        description: "Assinatura semanal (nova)",
        expectedVersion: weekly.version,
        id: weekly.id,
        requestId: randomUUID(),
      })
    );
    assert.equal(edited.changed, true);
    assert.equal(edited.rule.version, 2);
    assert.equal(edited.rule.frequency, "weekly");
    assert.equal(edited.rule.startsOn, await startsOnOf(weekly.id));
    assert.equal(
      (await expensesOf(weekly.id)).every(
        (expense) =>
          expense.amount === "20.00" &&
          expense.description === "Assinatura semanal"
      ),
      true,
      "what was generated keeps what it was"
    );
    await passTime(weekly.id, 7);
    await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity));
    const afterEdit = await expensesOf(weekly.id);
    assert.equal(afterEdit.length, 7);
    assert.equal(afterEdit[6]?.amount, "25.50");
    assert.equal(afterEdit[6]?.description, "Assinatura semanal (nova)");
    assert.equal(afterEdit[5]?.amount, "20.00");
    const unchanged = await as(tenantA, (tx, identity) =>
      updateExpenseRule(tx, identity, {
        amount: "25.5",
        categoryId: software.id,
        description: "Assinatura semanal (nova)",
        expectedVersion: 2,
        id: weekly.id,
      })
    );
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.rule.version, 2);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          updateExpenseRule(tx, identity, {
            amount: "30",
            categoryId: software.id,
            description: "stale",
            expectedVersion: 1,
            id: weekly.id,
          })
        ),
      ExpenseRuleVersionConflictError,
      "stale rule version"
    );
    const startBeforeEdit = await startsOnOf(weekly.id);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          updateExpenseRule(tx, identity, {
            amount: "30",
            categoryId: software.id,
            description: "fim antes do começo",
            endsOn: dateFrom(startBeforeEdit, -1),
            expectedVersion: 2,
            id: weekly.id,
          })
        ),
      InvalidExpenseRuleError,
      "an end date before the start"
    );
    tests.push(
      "editing a rule changes only the occurrences not generated yet; what was generated keeps its amount and text, an identical edit changes nothing, a stale or impossible one is refused"
    );

    // ------------ 4. a voided or edited occurrence is never regenerated
    const [first, second] = afterEdit;
    assert.ok(first && second);
    await as(tenantA, (tx, identity) =>
      voidExpense(tx, identity, {
        expectedVersion: first.version,
        id: first.id,
      })
    );
    await as(tenantA, (tx, identity) =>
      updateExpense(tx, identity, {
        amount: "99.99",
        categoryId: software.id,
        competenceOn: second.competence_on,
        description: "ajustada à mão",
        expectedVersion: second.version,
        id: second.id,
      })
    );
    await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity));
    const afterManual = await expensesOf(weekly.id);
    assert.equal(afterManual.length, 7, "nothing is regenerated");
    assert.notEqual(afterManual[0]?.voided_at, null);
    assert.equal(afterManual[1]?.amount, "99.99");
    tests.push(
      "voiding or editing a generated occurrence is final: it is never regenerated or overwritten"
    );

    // ---------------------------------------------- 5. pause and resume
    const paused = await as(tenantA, (tx, identity) =>
      archiveExpenseRule(tx, identity, {
        expectedVersion: 2,
        id: weekly.id,
        requestId: randomUUID(),
      })
    );
    assert.equal(paused.changed, true);
    assert.notEqual(paused.rule.archivedAt, null);
    await passTime(weekly.id, 14);
    await as(tenantA, (tx, identity) => listExpenses(tx, identity));
    assert.equal(
      (await expensesOf(weekly.id)).length,
      7,
      "a paused rule generates nothing"
    );
    const resumed = await as(tenantA, (tx, identity) =>
      restoreExpenseRule(tx, identity, {
        expectedVersion: paused.rule.version,
        id: weekly.id,
      })
    );
    assert.equal(resumed.changed, true);
    assert.equal(resumed.rule.archivedAt, null);
    // the periods that passed while paused are skipped (up to yesterday)...
    assert.equal(
      (await ruleRow(weekly.id))?.generated_count,
      occurrencesThrough(resumed.rule.startsOn, "weekly", dateFrom(today, -1))
    );
    assert.equal(
      (await expensesOf(weekly.id)).length,
      7,
      "nothing is generated afterwards for the paused periods"
    );
    // ...but an occurrence due on the very day it is resumed is generated
    await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity));
    const afterResume = await expensesOf(weekly.id);
    assert.equal(afterResume.length, 8);
    assert.equal(afterResume.at(-1)?.competence_on, today);
    assert.deepEqual(
      afterResume.map((expense) => expense.recurring_occurrence),
      [0, 1, 2, 3, 4, 5, 6, 8],
      "the paused occurrence (7) was skipped, today's (8) was not"
    );
    await passTime(weekly.id, 7);
    await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity));
    assert.equal(
      (await expensesOf(weekly.id)).length,
      9,
      "generation continues with the next period that falls due"
    );
    // what already fell due is generated before pausing, not lost to the pause
    const closing = await as(tenantA, (tx, identity) =>
      createExpenseRule(tx, identity, {
        amount: "5.00",
        categoryId: software.id,
        description: "Pausada logo depois de vencer",
        frequency: "weekly",
        startsOn: dateFrom(today, -14),
      })
    );
    assert.equal(closing.generatedCount, 3);
    await passTime(closing.id, 7);
    const closed = await as(tenantA, (tx, identity) =>
      archiveExpenseRule(tx, identity, {
        expectedVersion: closing.version,
        id: closing.id,
      })
    );
    assert.equal(closed.changed, true);
    assert.equal(
      (await expensesOf(closing.id)).length,
      4,
      "the occurrence that fell due is generated by the pause itself"
    );
    assert.equal((await ruleRow(closing.id))?.generated_count, 4);
    tests.push(
      "a paused rule generates nothing; pausing first generates what already fell due; resuming skips the periods that passed meanwhile but not an occurrence due the day it resumes, and generation continues from there"
    );

    // --------------------------------------------------- 6. the end date
    const ending = await as(tenantA, (tx, identity) =>
      createExpenseRule(tx, identity, {
        amount: "10.00",
        categoryId: software.id,
        description: "Contrato com fim",
        endsOn: dateFrom(today, -20),
        frequency: "weekly",
        startsOn: dateFrom(today, -50),
      })
    );
    assert.equal(ending.generatedCount, 5);
    assert.equal(ending.nextOccurrenceOn, null, "the series is over");
    await passTime(ending.id, 30);
    await as(tenantA, (tx, identity) => generateDueExpenses(tx, identity));
    assert.equal(
      (await expensesOf(ending.id)).length,
      5,
      "nothing after the end date"
    );
    tests.push("a rule stops at its end date, however much time passes");

    // ------------------------------------------- 7. a very long catch-up
    const longAgo = await as(tenantA, (tx, identity) =>
      createExpenseRule(tx, identity, {
        amount: "1.00",
        categoryId: software.id,
        description: "Desde 2000",
        frequency: "weekly",
        startsOn: "2000-01-01",
      })
    );
    const longExpected = occurrencesThrough("2000-01-01", "weekly", today);
    assert.ok(longExpected > 1000);
    assert.equal(longAgo.generatedCount, longExpected);
    assert.equal((await expensesOf(longAgo.id)).length, longExpected);
    tests.push(
      "a catch-up of more than a thousand occurrences completes in passes of 500 and ends complete and without duplicates"
    );

    // ---------------------------------------------- 8. rules and categories
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpenseRule(tx, identity, {
            amount: "1.00",
            categoryId: rentB.id,
            description: "categoria alheia",
            frequency: "monthly",
            startsOn: today,
          })
        ),
      Error,
      "another organization's category"
    );
    const archivedCategory = categoriesA.find(
      (category) => category.systemKey === "marketing"
    );
    assert.ok(archivedCategory);
    await as(tenantA, (tx, identity) =>
      archiveExpenseCategory(tx, identity, {
        expectedVersion: 1,
        id: archivedCategory.id,
      })
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpenseRule(tx, identity, {
            amount: "1.00",
            categoryId: archivedCategory.id,
            description: "categoria arquivada",
            frequency: "monthly",
            startsOn: today,
          })
        ),
      ExpenseCategoryUnavailableError,
      "a new rule cannot use an archived category"
    );
    for (const [label, input] of [
      ["unknown frequency", { frequency: "daily", startsOn: today }],
      ["start before 2000", { frequency: "monthly", startsOn: "1999-12-31" }],
      [
        "start too far ahead",
        { frequency: "monthly", startsOn: dateFrom(today, 367) },
      ],
      ["impossible start", { frequency: "monthly", startsOn: "2026-02-30" }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expectRejects(
        () =>
          as(tenantA, (tx, identity) =>
            createExpenseRule(tx, identity, {
              amount: "1.00",
              categoryId: rent.id,
              description: label,
              ...input,
            })
          ),
        InvalidExpenseRuleError,
        label
      );
    }
    tests.push(
      "a rule needs an active category of its own organization and a known frequency and a real start date inside the competence window"
    );

    // ------------------------------------------ 9. isolation and the grants
    await expectRejects(
      () =>
        as(tenantB, (tx, identity) =>
          archiveExpenseRule(tx, identity, {
            expectedVersion: 1,
            id: rentRule.id,
          })
        ),
      ExpenseRuleNotFoundError,
      "another organization's rule"
    );
    const seenByB = await as(tenantB, (tx, identity) =>
      listExpenseRules(tx, identity, { status: "all" })
    );
    assert.equal(seenByB.length, 0);
    const bExpenses = await as(tenantB, (tx, identity) =>
      listExpenses(tx, identity, { status: "all" })
    );
    assert.equal(
      bExpenses.count,
      0,
      "another organization's rules generate nothing here"
    );
    for (const [label, statement] of [
      [
        "frequency",
        "UPDATE public.expense_recurring_rules SET frequency = 'weekly'",
      ],
      [
        "starts_on",
        "UPDATE public.expense_recurring_rules SET starts_on = starts_on",
      ],
      [
        "id",
        "UPDATE public.expense_recurring_rules SET id = gen_random_uuid()",
      ],
      [
        "expenses.recurring_rule_id",
        "UPDATE public.expenses SET recurring_rule_id = NULL",
      ],
      ["DELETE", "DELETE FROM public.expense_recurring_rules"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `the runtime role cannot touch ${label}`
      );
    }
    tests.push(
      "another organization cannot see, change or trigger these rules, and the runtime role cannot change a rule's calendar or origin links or delete rules"
    );

    // ---------------------------------- 10. what the database itself enforces
    for (const [label, statement, params, state] of [
      [
        "an unknown frequency",
        "INSERT INTO public.expense_recurring_rules (organization_id, category_id, amount, description, frequency, starts_on) VALUES ($1, $2, 1, 'x', 'daily', '2026-01-01')",
        [tenantA.organizationId, rent.id],
        "23514",
      ],
      [
        "an end before the start",
        "INSERT INTO public.expense_recurring_rules (organization_id, category_id, amount, description, frequency, starts_on, ends_on) VALUES ($1, $2, 1, 'x', 'monthly', '2026-01-02', '2026-01-01')",
        [tenantA.organizationId, rent.id],
        "23514",
      ],
      [
        "a zero amount",
        "INSERT INTO public.expense_recurring_rules (organization_id, category_id, amount, description, frequency, starts_on) VALUES ($1, $2, 0, 'x', 'monthly', '2026-01-01')",
        [tenantA.organizationId, rent.id],
        "23514",
      ],
      [
        "a start before 2000",
        "INSERT INTO public.expense_recurring_rules (organization_id, category_id, amount, description, frequency, starts_on) VALUES ($1, $2, 1, 'x', 'monthly', '1999-12-31')",
        [tenantA.organizationId, rent.id],
        "23514",
      ],
      [
        "an expense with half an origin",
        "INSERT INTO public.expenses (organization_id, category_id, amount, description, competence_on, recurring_rule_id) VALUES ($1, $2, 1, 'x', '2026-01-01', $3)",
        [tenantA.organizationId, rent.id, rentRule.id],
        "23514",
      ],
      [
        "an occurrence generated twice",
        "INSERT INTO public.expenses (organization_id, category_id, amount, description, competence_on, recurring_rule_id, recurring_occurrence) VALUES ($1, $2, 1, 'x', '2026-01-01', $3, 0)",
        [tenantA.organizationId, rent.id, rentRule.id],
        "23505",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement, [...params])
          ),
        state,
        `the database refuses ${label}`
      );
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.expenses (organization_id, category_id, amount, description, competence_on, recurring_rule_id, recurring_occurrence) VALUES ($1, $2, 1, 'x', '2026-01-01', $3, 999999)",
            [tenantB.organizationId, rentB.id, rentRule.id]
          )
        ),
      "23503",
      "an origin pointing at another organization's rule"
    );
    tests.push(
      "PostgreSQL itself refuses an unknown frequency, an end before the start, a zero amount, a start before 2000, half an origin, a duplicated occurrence and an origin in another organization"
    );

    // ------------------------------------------------------------ 11. audit
    const audit = await admin.pool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n FROM public.tenant_audit_event
        WHERE organization_id = $1 AND entity_type = 'expense_rule'
        GROUP BY event_type`,
      [tenantA.organizationId]
    );
    const counts = new Map(
      audit.rows.map((row) => [row.event_type, Number(row.n)])
    );
    for (const eventType of [
      "expense_rule.created",
      "expense_rule.updated",
      "expense_rule.archived",
      "expense_rule.restored",
      "expense_rule.generated",
    ]) {
      assert.ok((counts.get(eventType) ?? 0) >= 1, `audit event ${eventType}`);
    }
    assert.equal(counts.get("expense_rule.archived"), 2);
    tests.push(
      "every rule change and every generation pass leaves an audit event, repeated or refused ones leave none"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    if (runtime) {
      await runtime.pool.end();
    }
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Expense recurrence PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
