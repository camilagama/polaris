import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
  ExpenseRuleReadModel,
} from "@polaris/contracts";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import {
  ExpenseCategoryNameConflictError,
  ExpenseCategoryNotFoundError,
  ExpenseCompetenceOutOfRangeError,
  ExpenseNotFoundError,
  ExpenseSaleNotFoundError,
  ExpenseVersionConflictError,
  ExpenseVoidedError,
  InvalidExpenseError,
} from "@polaris/domain/expenses/expense";
import {
  ExpenseRuleNotFoundError,
  ExpenseRuleVersionConflictError,
  InvalidExpenseRuleError,
} from "@polaris/domain/expenses/recurrence";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const categoryId = "0199c2d0-0000-7000-8000-0000000000c1";
const expenseId = "0199c2d0-0000-7000-8000-0000000000e1";
const identity: TenantRequestIdentity = {
  capability: "expense:create",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const at = new Date("2026-10-14T12:00:00.000Z");
const categoryRow = {
  archivedAt: null,
  createdAt: at,
  groupKey: "operational",
  id: categoryId,
  name: "Aluguel",
  organizationId,
  systemKey: "rent",
  updatedAt: at,
  version: 1,
};
const expenseRow = {
  amount: "1500.00",
  categoryGroup: "operational",
  categoryId,
  categoryName: "Aluguel",
  competenceOn: "2026-10-01",
  createdAt: at,
  description: "Aluguel de outubro",
  id: expenseId,
  organizationId,
  payee: null,
  recurringRuleId: null,
  saleId: null,
  updatedAt: at,
  version: 1,
  voidedAt: null,
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Result<T> = Promise<T>;
interface ExpenseClient {
  expense: {
    archiveCategory: (input: unknown) => Result<{
      category: ExpenseCategoryReadModel;
      changed: boolean;
    }>;
    create: (input: unknown) => Result<ExpenseReadModel>;
    createCategory: (input: unknown) => Result<ExpenseCategoryReadModel>;
    list: (input: unknown) => Result<{
      count: number;
      expenses: ExpenseReadModel[];
      nextCursor: string | null;
      total: string;
    }>;
    listCategories: (
      input: unknown
    ) => Result<{ categories: ExpenseCategoryReadModel[] }>;
    update: (input: unknown) => Result<{
      changed: boolean;
      expense: ExpenseReadModel;
    }>;
    archiveRule: (input: unknown) => Result<{
      changed: boolean;
      rule: ExpenseRuleReadModel;
    }>;
    createRule: (input: unknown) => Result<ExpenseRuleReadModel>;
    listRules: (input: unknown) => Result<{ rules: ExpenseRuleReadModel[] }>;
    updateRule: (input: unknown) => Result<{
      changed: boolean;
      rule: ExpenseRuleReadModel;
    }>;
    void: (input: unknown) => Result<{
      changed: boolean;
      expense: ExpenseReadModel;
    }>;
  };
}

function createRpcClient(router: ReturnType<typeof createRpcRouter>) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as ExpenseClient;
}

function tenantStub(onCall?: (capability: string) => void) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.(input.capability);
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

const newExpense = {
  amount: "1500.00",
  categoryId,
  competenceOn: "2026-10-01",
  description: "Aluguel de outubro",
  organizationId: "requested-org",
};

describe("expense RPCs", () => {
  it("lists categories through expense:create, in the server-authorized organization", async () => {
    let capability = "";
    const listExpenseCategories = vi.fn(async () => [categoryRow]);
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { listExpenseCategories },
        withTenantRequestContext: tenantStub((value) => {
          capability = value;
        }),
      })
    );

    await expect(
      client.expense.listCategories({ organizationId })
    ).resolves.toMatchObject({
      categories: [
        { groupKey: "operational", id: categoryId, status: "active" },
      ],
    });
    expect(capability).toBe("expense:create");
    expect(listExpenseCategories).toHaveBeenCalledWith({}, identity, {
      status: "active",
    });
  });

  it("creates an expense with the identity from the session and an audit request ID", async () => {
    const createExpense = vi.fn(async () => expenseRow);
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { createExpense },
        withTenantRequestContext: tenantStub(),
      })
    );

    await expect(client.expense.create(newExpense)).resolves.toMatchObject({
      amount: "1500.00",
      organizationId,
      status: "active",
    });
    expect(createExpense).toHaveBeenCalledWith({}, identity, {
      amount: "1500.00",
      categoryId,
      competenceOn: "2026-10-01",
      description: "Aluguel de outubro",
      payee: null,
      requestId: expect.stringMatching(requestIdPattern),
      saleId: null,
    });
  });

  it("reports a voided expense as voided", async () => {
    const voidExpense = vi.fn(async () => ({
      changed: true,
      expense: { ...expenseRow, version: 2, voidedAt: at },
    }));
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { voidExpense },
        withTenantRequestContext: tenantStub(),
      })
    );

    await expect(
      client.expense.void({ expectedVersion: 1, id: expenseId, organizationId })
    ).resolves.toMatchObject({
      changed: true,
      expense: { status: "voided", version: 2, voidedAt: at.toISOString() },
    });
  });

  it("returns the page, the next cursor and the exact total of the whole filter", async () => {
    const listExpenses = vi.fn(async () => ({
      count: 2,
      expenses: [expenseRow],
      nextCursor: "2026-10-01|0199c2d0-0000-7000-8000-0000000000e1",
      total: "2000.50",
    }));
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { listExpenses },
        withTenantRequestContext: tenantStub(),
      })
    );

    await expect(
      client.expense.list({
        from: "2026-10-01",
        limit: 1,
        organizationId,
        to: "2026-10-31",
      })
    ).resolves.toMatchObject({ count: 2, total: "2000.50" });
    expect(listExpenses).toHaveBeenCalledWith({}, identity, {
      categoryId: null,
      cursor: null,
      from: "2026-10-01",
      limit: 1,
      status: "active",
      to: "2026-10-31",
    });
  });

  it("refuses malformed input before opening a tenant context", async () => {
    const withTenantRequestContext = vi.fn(tenantStub());
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as NonNullable<
            NonNullable<
              Parameters<typeof createRpcRouter>[0]
            >["withTenantRequestContext"]
          >,
      })
    );

    for (const bad of [
      { ...newExpense, amount: "" },
      { ...newExpense, competenceOn: "01/10/2026" },
      { ...newExpense, categoryId: "not-a-uuid" },
      { ...newExpense, description: "   " },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(client.expense.create(bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid expense", new InvalidExpenseError(), "BAD_REQUEST"],
    [
      "a competence outside the window",
      new ExpenseCompetenceOutOfRangeError(),
      "BAD_REQUEST",
    ],
    ["a stale version", new ExpenseVersionConflictError(), "CONFLICT"],
    ["a voided expense", new ExpenseVoidedError(), "CONFLICT"],
    ["a missing expense", new ExpenseNotFoundError(), "NOT_FOUND"],
    ["a missing category", new ExpenseCategoryNotFoundError(), "NOT_FOUND"],
    ["a missing sale", new ExpenseSaleNotFoundError(), "NOT_FOUND"],
  ])("maps %s to a safe RPC error", async (_label, error, code) => {
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { updateExpense: () => Promise.reject(error) },
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      client.expense.update({
        ...newExpense,
        expectedVersion: 1,
        id: expenseId,
        organizationId,
      })
    ).rejects.toMatchObject({ code });
  });

  it("maps a duplicate category name to a conflict", async () => {
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: {
          createExpenseCategory: () =>
            Promise.reject(new ExpenseCategoryNameConflictError()),
        },
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      client.expense.createCategory({
        group: "commercial",
        name: "Marketing",
        organizationId,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses an unknown group", async () => {
    const client = createRpcClient(createRpcRouter());
    await expect(
      client.expense.createCategory({
        group: "invented",
        name: "X",
        organizationId,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  const ruleRow = {
    amount: "1500.00",
    archivedAt: null,
    categoryGroup: "operational",
    categoryId,
    categoryName: "Aluguel",
    createdAt: at,
    description: "Aluguel",
    endsOn: null,
    frequency: "monthly",
    generatedCount: 10,
    id: "0199c2d0-0000-7000-8000-0000000000f1",
    nextOccurrenceOn: "2026-11-05",
    organizationId,
    payee: null,
    startsOn: "2026-01-05",
    updatedAt: at,
    version: 1,
  };

  it("creates a recurring rule and lists it with its next occurrence", async () => {
    const createExpenseRule = vi.fn(async () => ruleRow);
    const listExpenseRules = vi.fn(async () => [ruleRow]);
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { createExpenseRule, listExpenseRules },
        withTenantRequestContext: tenantStub(),
      })
    );

    await expect(
      client.expense.createRule({
        amount: "1500.00",
        categoryId,
        description: "Aluguel",
        frequency: "monthly",
        organizationId,
        startsOn: "2026-01-05",
      })
    ).resolves.toMatchObject({
      frequency: "monthly",
      nextOccurrenceOn: "2026-11-05",
      status: "active",
    });
    expect(createExpenseRule).toHaveBeenCalledWith({}, identity, {
      amount: "1500.00",
      categoryId,
      description: "Aluguel",
      endsOn: null,
      frequency: "monthly",
      payee: null,
      requestId: expect.stringMatching(requestIdPattern),
      startsOn: "2026-01-05",
    });
    await expect(
      client.expense.listRules({ organizationId })
    ).resolves.toMatchObject({ rules: [{ generatedCount: 10 }] });
  });

  it("refuses an unknown frequency or a malformed date before opening a tenant context", async () => {
    const withTenantRequestContext = vi.fn(tenantStub());
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as NonNullable<
            NonNullable<
              Parameters<typeof createRpcRouter>[0]
            >["withTenantRequestContext"]
          >,
      })
    );
    const valid = {
      amount: "1.00",
      categoryId,
      description: "x",
      frequency: "monthly",
      organizationId,
      startsOn: "2026-01-05",
    };
    for (const bad of [
      { ...valid, frequency: "daily" },
      { ...valid, startsOn: "05/01/2026" },
      { ...valid, endsOn: "2026-1-1" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(client.expense.createRule(bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid rule", new InvalidExpenseRuleError(), "BAD_REQUEST"],
    ["a stale rule", new ExpenseRuleVersionConflictError(), "CONFLICT"],
    ["a missing rule", new ExpenseRuleNotFoundError(), "NOT_FOUND"],
  ])("maps %s to a safe RPC error", async (_label, error, code) => {
    const client = createRpcClient(
      createRpcRouter({
        expenseRepository: { updateExpenseRule: () => Promise.reject(error) },
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      client.expense.updateRule({
        amount: "2.00",
        categoryId,
        description: "x",
        expectedVersion: 1,
        id: ruleRow.id,
        organizationId,
      })
    ).rejects.toMatchObject({ code });
  });
});
