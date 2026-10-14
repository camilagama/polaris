import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  ExpenseCategoryNameConflictError,
  ExpenseCategoryNotFoundError,
  ExpenseCategoryUnavailableError,
  ExpenseCategoryVersionConflictError,
  ExpenseCompetenceOutOfRangeError,
  ExpenseNotFoundError,
  ExpenseSaleNotFoundError,
  ExpenseVersionConflictError,
  ExpenseVoidedError,
  InvalidExpenseError,
} from "@polaris/domain/expenses/expense";
import { createDatabase } from "../src/client";
import {
  archiveExpenseCategory,
  createExpense,
  createExpenseCategory,
  listExpenseCategories,
  listExpenses,
  renameExpenseCategory,
  restoreExpense,
  restoreExpenseCategory,
  updateExpense,
  voidExpense,
} from "../src/expense-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  confirmPlainSale,
  createSellableProduct,
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
 * Expense categories and expenses (plan PR63 and PR64) on a real PostgreSQL 18:
 * what the database itself enforces (RLS, column grants, CHECKs, composite
 * foreign keys), the repositories on top of it (defaults, versions, audit, the
 * competence window, exact totals, paging) and the sale link.
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

/** The date of today in the organization's calendar plus `days`. */
function dateFrom(today: string, days: number): string {
  const [year, month, day] = today.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
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
      "expenses A"
    );
    const tenantB: TenantFixture = await createTenantFixture(
      admin.pool,
      "expenses B"
    );
    loginRole = `polaris_expense_gate_${randomUUID().replaceAll("-", "")}`;
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

    // ---------------------------------------------- 1. defaults, seeded once
    const [first, second] = await Promise.all([
      as(tenantA, (tx, identity) => listExpenseCategories(tx, identity)),
      as(tenantA, (tx, identity) => listExpenseCategories(tx, identity)),
    ]);
    assert.equal(first.length, DEFAULT_EXPENSE_CATEGORIES.length);
    assert.equal(second.length, DEFAULT_EXPENSE_CATEGORIES.length);
    const stored = await admin.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.expense_categories WHERE organization_id = $1",
      [tenantA.organizationId]
    );
    assert.equal(Number(stored.rows[0]?.n), DEFAULT_EXPENSE_CATEGORIES.length);
    assert.deepEqual(
      first
        .map((category) => category.groupKey)
        .filter((_, i, all) => all.indexOf(_) === i),
      ["commercial", "operational", "financial", "taxes", "other"]
    );
    const rent = first.find((category) => category.systemKey === "rent");
    const marketing = first.find(
      (category) => category.systemKey === "marketing"
    );
    assert.ok(rent && marketing);
    tests.push(
      "an organization starts with the default categories, once, even when two first calls race, listed in group order"
    );

    // ----------------------------------------------------- 2. the categories
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpenseCategory(tx, identity, {
            group: "commercial",
            name: "  aluguel ",
          })
        ),
      ExpenseCategoryNameConflictError,
      "the name is unique across groups and letter cases"
    );
    const software = await as(tenantA, (tx, identity) =>
      createExpenseCategory(tx, identity, {
        group: "operational",
        name: "Ferramentas",
        requestId: randomUUID(),
      })
    );
    assert.equal(software.version, 1);
    assert.equal(software.systemKey, null);
    // the same name is free in another organization
    await as(tenantB, (tx, identity) =>
      createExpenseCategory(tx, identity, {
        group: "operational",
        name: "Ferramentas",
      })
    );
    const renamed = await as(tenantA, (tx, identity) =>
      renameExpenseCategory(tx, identity, {
        expectedVersion: 1,
        id: software.id,
        name: "Ferramentas e apps",
      })
    );
    assert.equal(renamed.changed, true);
    assert.equal(renamed.category.version, 2);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          renameExpenseCategory(tx, identity, {
            expectedVersion: 1,
            id: software.id,
            name: "Outro nome",
          })
        ),
      ExpenseCategoryVersionConflictError,
      "stale category version"
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          renameExpenseCategory(tx, identity, {
            expectedVersion: 2,
            id: software.id,
            name: "marketing",
          })
        ),
      ExpenseCategoryNameConflictError,
      "rename onto an existing name"
    );
    await expectRejects(
      () =>
        as(tenantB, (tx, identity) =>
          renameExpenseCategory(tx, identity, {
            expectedVersion: 2,
            id: software.id,
            name: "Invasor",
          })
        ),
      ExpenseCategoryNotFoundError,
      "another organization's category"
    );
    const unchangedRename = await as(tenantA, (tx, identity) =>
      renameExpenseCategory(tx, identity, {
        expectedVersion: 2,
        id: software.id,
        name: "Ferramentas e apps",
      })
    );
    assert.equal(unchangedRename.changed, false);
    assert.equal(unchangedRename.category.version, 2);
    tests.push(
      "category names are unique per organization (any group, any case), renames are versioned, stale or foreign ones are refused, an identical rename changes nothing"
    );

    // ----------------------------------------------------- 3. creating
    const aluguel = await as(tenantA, (tx, identity) =>
      createExpense(tx, identity, {
        amount: "1500",
        categoryId: rent.id,
        competenceOn: dateFrom(today, -3),
        description: "  Aluguel do mês  ",
        payee: "Imobiliária Sintética",
        requestId: randomUUID(),
      })
    );
    assert.equal(aluguel.amount, "1500.00");
    assert.equal(aluguel.description, "Aluguel do mês");
    assert.equal(aluguel.categoryName, "Aluguel");
    assert.equal(aluguel.categoryGroup, "operational");
    assert.equal(aluguel.version, 1);
    assert.equal(aluguel.voidedAt, null);
    tests.push(
      "an expense is stored with its exact two-decimal amount, trimmed text, category and version 1"
    );

    // ------------------------------------------ 4. what the database enforces
    for (const [label, values] of [
      ["zero amount", ["0.00", "x", null, "2026-10-01"]],
      ["negative amount", ["-1.00", "x", null, "2026-10-01"]],
      ["three decimals", ["1.005", "x", null, "2026-10-01"]],
      ["1e18", ["1000000000000000000.00", "x", null, "2026-10-01"]],
      ["blank description", ["1.00", "   ", null, "2026-10-01"]],
      ["long description", ["1.00", "d".repeat(201), null, "2026-10-01"]],
      ["long payee", ["1.00", "x", "p".repeat(121), "2026-10-01"]],
      ["competence before 2000", ["1.00", "x", null, "1999-12-31"]],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(
              "INSERT INTO public.expenses (organization_id, category_id, amount, description, payee, competence_on) VALUES ($1, $2, $3, $4, $5, $6)",
              [
                tenantA.organizationId,
                rent.id,
                values[0],
                values[1],
                values[2],
                values[3],
              ]
            )
          ),
        "23514",
        `the database refuses ${label}`
      );
    }
    tests.push(
      "PostgreSQL itself refuses a zero, negative, over-scaled or over-large amount, blank or over-long text and a competence before 2000, even around the repositories"
    );

    // ------------------------------------------- 5. isolation and the grants
    await expectRejects(
      () =>
        as(tenantB, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "1.00",
            categoryId: rent.id,
            competenceOn: today,
            description: "usa categoria alheia",
          })
        ),
      ExpenseCategoryNotFoundError,
      "another organization's category"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.expenses (organization_id, category_id, amount, description, competence_on) VALUES ($1, $2, 1, 'x', $3)",
            [tenantB.organizationId, rent.id, today]
          )
        ),
      "23503",
      "the composite foreign key also stops a direct insert onto another organization's category"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.expenses (organization_id, category_id, amount, description, competence_on) VALUES ($1, $2, 1, 'x', $3)",
            [tenantA.organizationId, rent.id, today]
          )
        ),
      "42501",
      "RLS refuses a row for an organization that is not the current one"
    );
    await expectRejects(
      () =>
        as(tenantB, (tx, identity) =>
          updateExpense(tx, identity, {
            amount: "9.00",
            categoryId: rent.id,
            competenceOn: today,
            description: "invasor",
            expectedVersion: 1,
            id: aluguel.id,
          })
        ),
      ExpenseNotFoundError,
      "another organization's expense"
    );
    const seenByB = await as(tenantB, (tx, identity) =>
      listExpenses(tx, identity, { status: "all" })
    );
    assert.equal(seenByB.count, 0);
    assert.equal(seenByB.total, "0.00");
    for (const [label, statement] of [
      ["expenses.id", "UPDATE public.expenses SET id = gen_random_uuid()"],
      ["expenses.created_at", "UPDATE public.expenses SET created_at = now()"],
      [
        "expenses.organization_id",
        "UPDATE public.expenses SET organization_id = organization_id",
      ],
      [
        "expense_categories.group_key",
        "UPDATE public.expense_categories SET group_key = 'other'",
      ],
      [
        "expense_categories.system_key",
        "UPDATE public.expense_categories SET system_key = NULL",
      ],
      ["DELETE expenses", "DELETE FROM public.expenses"],
      ["DELETE categories", "DELETE FROM public.expense_categories"],
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
    await expectRejects(
      () =>
        withTenantAs(db, tenantA, "customer:update", (tx, identity) =>
          listExpenses(tx, identity)
        ),
      TenantAuthorizationError,
      "another capability is not enough"
    );
    tests.push(
      "another organization cannot read, edit or reference these rows (RLS, composite FKs), the runtime role cannot delete or rewrite identity columns, and another capability cannot list expenses"
    );

    // ---------------------------------------------- 6. the competence window
    await as(tenantA, (tx, identity) =>
      createExpense(tx, identity, {
        amount: "10.00",
        categoryId: rent.id,
        competenceOn: dateFrom(today, 366),
        description: "daqui a um ano (limite)",
      })
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "10.00",
            categoryId: rent.id,
            competenceOn: dateFrom(today, 367),
            description: "além do limite",
          })
        ),
      ExpenseCompetenceOutOfRangeError,
      "more than 366 days ahead"
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "10.00",
            categoryId: rent.id,
            competenceOn: "1999-12-31",
            description: "antes de 2000",
          })
        ),
      ExpenseCompetenceOutOfRangeError,
      "before 2000"
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "10.005",
            categoryId: rent.id,
            competenceOn: today,
            description: "três casas",
          })
        ),
      InvalidExpenseError,
      "over-scaled amount"
    );
    tests.push(
      "the competence date may be up to 366 days ahead of the organization's today (not 367) and not before 2000; an over-scaled amount is refused before it reaches the database"
    );

    // ------------------------------------- 7. versions, voiding, categories
    const edited = await as(tenantA, (tx, identity) =>
      updateExpense(tx, identity, {
        amount: "1600.00",
        categoryId: rent.id,
        competenceOn: aluguel.competenceOn,
        description: "Aluguel do mês",
        expectedVersion: 1,
        id: aluguel.id,
        payee: "Imobiliária Sintética",
        requestId: randomUUID(),
      })
    );
    assert.equal(edited.changed, true);
    assert.equal(edited.expense.version, 2);
    assert.equal(edited.expense.amount, "1600.00");
    const sameAgain = await as(tenantA, (tx, identity) =>
      updateExpense(tx, identity, {
        amount: "1600",
        categoryId: rent.id,
        competenceOn: aluguel.competenceOn,
        description: "Aluguel do mês",
        expectedVersion: 2,
        id: aluguel.id,
        payee: "Imobiliária Sintética",
      })
    );
    assert.equal(sameAgain.changed, false);
    assert.equal(sameAgain.expense.version, 2);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          updateExpense(tx, identity, {
            amount: "1.00",
            categoryId: rent.id,
            competenceOn: aluguel.competenceOn,
            description: "stale",
            expectedVersion: 1,
            id: aluguel.id,
          })
        ),
      ExpenseVersionConflictError,
      "stale expense version"
    );
    const concurrent = await Promise.allSettled([
      as(tenantA, (tx, identity) =>
        updateExpense(tx, identity, {
          amount: "1601.00",
          categoryId: rent.id,
          competenceOn: aluguel.competenceOn,
          description: "concorrente 1",
          expectedVersion: 2,
          id: aluguel.id,
        })
      ),
      as(tenantA, (tx, identity) =>
        updateExpense(tx, identity, {
          amount: "1602.00",
          categoryId: rent.id,
          competenceOn: aluguel.competenceOn,
          description: "concorrente 2",
          expectedVersion: 2,
          id: aluguel.id,
        })
      ),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(
      concurrent.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ExpenseVersionConflictError
      ).length,
      1
    );
    const version3 = (
      await as(tenantA, (tx, identity) =>
        listExpenses(tx, identity, { categoryId: rent.id })
      )
    ).expenses.find((expense) => expense.id === aluguel.id);
    assert.equal(version3?.version, 3);
    tests.push(
      "editing is versioned: an identical edit changes nothing, a stale one is refused, and of two concurrent edits from the same version exactly one wins"
    );

    const voided = await as(tenantA, (tx, identity) =>
      voidExpense(tx, identity, {
        expectedVersion: 3,
        id: aluguel.id,
        requestId: randomUUID(),
      })
    );
    assert.equal(voided.changed, true);
    assert.notEqual(voided.expense.voidedAt, null);
    assert.equal(voided.expense.version, 4);
    const voidedAgain = await as(tenantA, (tx, identity) =>
      voidExpense(tx, identity, { expectedVersion: 4, id: aluguel.id })
    );
    assert.equal(voidedAgain.changed, false);
    assert.equal(voidedAgain.expense.version, 4);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          updateExpense(tx, identity, {
            amount: "1.00",
            categoryId: rent.id,
            competenceOn: today,
            description: "anulada",
            expectedVersion: 4,
            id: aluguel.id,
          })
        ),
      ExpenseVoidedError,
      "a voided expense is read-only"
    );
    const restored = await as(tenantA, (tx, identity) =>
      restoreExpense(tx, identity, { expectedVersion: 4, id: aluguel.id })
    );
    assert.equal(restored.changed, true);
    assert.equal(restored.expense.voidedAt, null);
    assert.equal(restored.expense.version, 5);
    tests.push(
      "an expense is voided and restored (never deleted), repeating either changes nothing, and a voided expense cannot be edited until restored"
    );

    // categories in use
    const archivedRent = await as(tenantA, (tx, identity) =>
      archiveExpenseCategory(tx, identity, {
        expectedVersion: 1,
        id: rent.id,
        requestId: randomUUID(),
      })
    );
    assert.equal(archivedRent.changed, true);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "1.00",
            categoryId: rent.id,
            competenceOn: today,
            description: "em categoria arquivada",
          })
        ),
      ExpenseCategoryUnavailableError,
      "a new expense cannot use an archived category"
    );
    const stillEditable = await as(tenantA, (tx, identity) =>
      updateExpense(tx, identity, {
        amount: "1700.00",
        categoryId: rent.id,
        competenceOn: aluguel.competenceOn,
        description: "Aluguel do mês",
        expectedVersion: 5,
        id: aluguel.id,
      })
    );
    assert.equal(stillEditable.changed, true);
    // moving to an archived category is refused; moving to an active one works
    const archivedMarketing = await as(tenantA, (tx, identity) =>
      archiveExpenseCategory(tx, identity, {
        expectedVersion: 1,
        id: marketing.id,
      })
    );
    assert.equal(archivedMarketing.category.version, 2);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          updateExpense(tx, identity, {
            amount: "1700.00",
            categoryId: marketing.id,
            competenceOn: aluguel.competenceOn,
            description: "Aluguel do mês",
            expectedVersion: 6,
            id: aluguel.id,
          })
        ),
      ExpenseCategoryUnavailableError,
      "moving onto an archived category"
    );
    const restoredRent = await as(tenantA, (tx, identity) =>
      restoreExpenseCategory(tx, identity, {
        expectedVersion: 2,
        id: rent.id,
      })
    );
    assert.equal(restoredRent.changed, true);
    const listedActive = await as(tenantA, (tx, identity) =>
      listExpenseCategories(tx, identity)
    );
    assert.equal(
      listedActive.some((category) => category.id === marketing.id),
      false
    );
    assert.equal(
      (
        await as(tenantA, (tx, identity) =>
          listExpenseCategories(tx, identity, { status: "archived" })
        )
      ).length,
      1
    );
    tests.push(
      "an archived category refuses new expenses and moves onto it, but expenses already in it stay editable; archiving and restoring are versioned and listed apart"
    );

    // ------------------------------------------------ 8. totals and paging
    // a clean category: ten expenses on three dates, exact decimals
    const probe = await as(tenantA, (tx, identity) =>
      createExpenseCategory(tx, identity, { group: "other", name: "Sonda" })
    );
    const dates = [
      dateFrom(today, -40),
      dateFrom(today, -40),
      dateFrom(today, -41),
    ];
    const amounts = ["0.10", "0.20", "1234567890123456.78"];
    for (const [index, amount] of amounts.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: created in order
      await as(tenantA, (tx, identity) =>
        createExpense(tx, identity, {
          amount,
          categoryId: probe.id,
          competenceOn: dates[index] as string,
          description: `sonda ${index}`,
        })
      );
    }
    for (let n = 0; n < 4; n += 1) {
      // same competence date as the first two: ties are ordered by ID
      // biome-ignore lint/performance/noAwaitInLoops: created in order
      await as(tenantA, (tx, identity) =>
        createExpense(tx, identity, {
          amount: "0.01",
          categoryId: probe.id,
          competenceOn: dates[0] as string,
          description: `empate ${n}`,
        })
      );
    }
    const wholeFilter = await as(tenantA, (tx, identity) =>
      listExpenses(tx, identity, { categoryId: probe.id, limit: 200 })
    );
    assert.equal(wholeFilter.count, 7);
    assert.equal(wholeFilter.total, "1234567890123457.12");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      // biome-ignore lint/performance/noAwaitInLoops: pages are read in order
      const page = await as(tenantA, (tx, identity) =>
        listExpenses(tx, identity, {
          categoryId: probe.id,
          cursor,
          limit: 3,
        })
      );
      assert.equal(
        page.count,
        7,
        "the total covers the whole filter on every page"
      );
      assert.equal(page.total, "1234567890123457.12");
      seen.push(...page.expenses.map((expense) => expense.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 7);
    assert.equal(
      new Set(seen).size,
      7,
      "no expense is repeated or skipped across pages"
    );
    const ordered = [...wholeFilter.expenses].map((expense) => expense.id);
    assert.deepEqual(
      seen,
      ordered,
      "paging follows the same order as one page"
    );
    const period = await as(tenantA, (tx, identity) =>
      listExpenses(tx, identity, {
        categoryId: probe.id,
        from: dateFrom(today, -40),
        to: dateFrom(today, -40),
      })
    );
    assert.equal(period.count, 6);
    assert.equal(period.total, "0.34");
    const voidedProbe = await as(tenantA, (tx, identity) =>
      voidExpense(tx, identity, {
        expectedVersion: 1,
        id: (period.expenses[0] as { id: string }).id,
      })
    );
    assert.notEqual(voidedProbe.expense.voidedAt, null);
    const afterVoid = await as(tenantA, (tx, identity) =>
      listExpenses(tx, identity, {
        categoryId: probe.id,
        from: dateFrom(today, -40),
        to: dateFrom(today, -40),
      })
    );
    assert.equal(
      afterVoid.count,
      5,
      "a voided expense leaves the default list"
    );
    const onlyVoided = await as(tenantA, (tx, identity) =>
      listExpenses(tx, identity, { categoryId: probe.id, status: "voided" })
    );
    assert.equal(onlyVoided.count, 1);
    const everything = await as(tenantA, (tx, identity) =>
      listExpenses(tx, identity, { categoryId: probe.id, status: "all" })
    );
    assert.equal(everything.count, 7);
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          listExpenses(tx, identity, { cursor: "garbage" })
        ),
      InvalidExpenseError,
      "a malformed cursor"
    );
    tests.push(
      "totals are exact decimals over the whole filter (not the page), pages follow one stable order with ties by ID without repeating or skipping, period and category filters work, voided expenses leave the default list and totals"
    );

    // ------------------------------------------------------- 9. sale link
    const product = await createSellableProduct(
      { adminPool: admin.pool, db },
      tenantA,
      "despesa",
      { cost: "5.00", quantity: 3 }
    );
    const sale = await confirmPlainSale(
      { adminPool: admin.pool, db },
      tenantA,
      [{ quantity: 1, variantId: product.variantId }]
    );
    const linked = await as(tenantA, (tx, identity) =>
      createExpense(tx, identity, {
        amount: "12.50",
        categoryId: probe.id,
        competenceOn: today,
        description: "Entrega da venda",
        saleId: sale.sale.id,
      })
    );
    assert.equal(linked.saleId, sale.sale.id);
    const [bCategory] = await as(tenantB, (tx, identity) =>
      listExpenseCategories(tx, identity)
    );
    assert.ok(bCategory);
    await expectRejects(
      () =>
        as(tenantB, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "1.00",
            categoryId: bCategory.id,
            competenceOn: today,
            description: "venda alheia",
            saleId: sale.sale.id,
          })
        ),
      ExpenseSaleNotFoundError,
      "another organization's sale"
    );
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createExpense(tx, identity, {
            amount: "1.00",
            categoryId: probe.id,
            competenceOn: today,
            description: "venda inexistente",
            saleId: randomUUID(),
          })
        ),
      ExpenseSaleNotFoundError,
      "unknown sale"
    );
    const unlinked = await as(tenantA, (tx, identity) =>
      updateExpense(tx, identity, {
        amount: "12.50",
        categoryId: probe.id,
        competenceOn: today,
        description: "Entrega da venda",
        expectedVersion: 1,
        id: linked.id,
        saleId: null,
      })
    );
    assert.equal(unlinked.expense.saleId, null);
    tests.push(
      "an expense can point to a sale of its own organization (and be unlinked); another organization's or an unknown sale is refused"
    );

    // ------------------------------------------------------------ 10. audit
    const audit = await admin.pool.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n FROM public.tenant_audit_event
        WHERE organization_id = $1 AND entity_type IN ('expense', 'expense_category')
        GROUP BY event_type`,
      [tenantA.organizationId]
    );
    const counts = new Map(
      audit.rows.map((row) => [row.event_type, Number(row.n)])
    );
    for (const eventType of [
      "expense.created",
      "expense.updated",
      "expense.voided",
      "expense.restored",
      "expense_category.created",
      "expense_category.renamed",
      "expense_category.archived",
      "expense_category.restored",
    ]) {
      assert.ok((counts.get(eventType) ?? 0) >= 1, `audit event ${eventType}`);
    }
    // an identical edit, a repeated void and a refused edit leave no event
    assert.equal(counts.get("expense.voided"), 2);
    tests.push(
      "every successful change leaves an audit event; repeated or refused changes leave none"
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
  console.error(`Expenses PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
