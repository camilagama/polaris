import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  archiveExpenseCategory,
  archiveExpenseRule,
  createExpense,
  createExpenseCategory,
  createExpenseRule,
  listExpenseCategories,
  listExpenseRules,
  listExpenses,
  renameExpenseCategory,
  restoreExpense,
  restoreExpenseCategory,
  restoreExpenseRule,
  updateExpense,
  updateExpenseRule,
  voidExpense,
} from "@polaris/db/expense-repository";
import { deriveExpenseLifecycle } from "@polaris/domain/expenses/expense";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface ExpenseRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

/** The repository functions the handlers call; tests replace any of them. */
const defaultExpenseRepository = {
  archiveExpenseCategory,
  archiveExpenseRule,
  createExpense,
  createExpenseCategory,
  createExpenseRule,
  listExpenseCategories,
  listExpenseRules,
  listExpenses,
  renameExpenseCategory,
  restoreExpense,
  restoreExpenseCategory,
  restoreExpenseRule,
  updateExpense,
  updateExpenseRule,
  voidExpense,
};

export type ExpenseRepository = typeof defaultExpenseRepository;

interface ExpenseRpcDependencies {
  expenseRepository: Partial<ExpenseRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "expense:create";

type CategoryRow = Awaited<
  ReturnType<ExpenseRepository["createExpenseCategory"]>
>;
type ExpenseRow = Awaited<ReturnType<ExpenseRepository["createExpense"]>>;

function categoryReadModel(category: CategoryRow) {
  return {
    archivedAt: category.archivedAt?.toISOString() ?? null,
    createdAt: category.createdAt.toISOString(),
    groupKey: category.groupKey as
      | "commercial"
      | "financial"
      | "operational"
      | "other"
      | "taxes",
    id: category.id,
    name: category.name,
    organizationId: category.organizationId,
    status:
      category.archivedAt === null
        ? ("active" as const)
        : ("archived" as const),
    systemKey: category.systemKey,
    updatedAt: category.updatedAt.toISOString(),
    version: category.version,
  };
}

function expenseReadModel(expense: ExpenseRow) {
  return {
    amount: expense.amount,
    categoryGroup: expense.categoryGroup as ReturnType<
      typeof categoryReadModel
    >["groupKey"],
    categoryId: expense.categoryId,
    categoryName: expense.categoryName,
    competenceOn: expense.competenceOn,
    createdAt: expense.createdAt.toISOString(),
    description: expense.description,
    id: expense.id,
    organizationId: expense.organizationId,
    payee: expense.payee,
    recurringRuleId: expense.recurringRuleId,
    saleId: expense.saleId,
    status: deriveExpenseLifecycle(expense.voidedAt),
    updatedAt: expense.updatedAt.toISOString(),
    version: expense.version,
    voidedAt: expense.voidedAt?.toISOString() ?? null,
  };
}

type RuleRow = Awaited<ReturnType<ExpenseRepository["createExpenseRule"]>>;

function ruleReadModel(rule: RuleRow) {
  return {
    amount: rule.amount,
    archivedAt: rule.archivedAt?.toISOString() ?? null,
    categoryGroup: rule.categoryGroup as ReturnType<
      typeof categoryReadModel
    >["groupKey"],
    categoryId: rule.categoryId,
    categoryName: rule.categoryName,
    createdAt: rule.createdAt.toISOString(),
    description: rule.description,
    endsOn: rule.endsOn,
    frequency: rule.frequency as "monthly" | "weekly" | "yearly",
    generatedCount: rule.generatedCount,
    id: rule.id,
    nextOccurrenceOn: rule.nextOccurrenceOn,
    organizationId: rule.organizationId,
    payee: rule.payee,
    startsOn: rule.startsOn,
    status:
      rule.archivedAt === null ? ("active" as const) : ("archived" as const),
    updatedAt: rule.updatedAt.toISOString(),
    version: rule.version,
  };
}

/**
 * Expense categories and expenses. Every operation needs the one capability
 * `expense:create` (there is no separate read capability in the V1).
 */
export function createExpenseRpcHandlers(dependencies: ExpenseRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<ExpenseRpcContext>();
  const repository = {
    ...defaultExpenseRepository,
    ...dependencies.expenseRepository,
  };

  const run = <T>(
    context: ExpenseRpcContext,
    organizationId: string,
    operation: Parameters<
      typeof dependencies.withTenantRequestContext<T>
    >[0]["operation"]
  ) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        operation,
        request: context.request,
        requestedOrganizationId: organizationId,
      })
      .catch(dependencies.toRpcError);

  const audit = (context: ExpenseRpcContext) =>
    dependencies.requestAuditId(context.requestId);

  const listCategories = implementContract.expense.listCategories.handler(
    async ({ context, input }) => {
      const categories = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.listExpenseCategories(transaction, identity, {
            status: input.status,
          })
      );
      return { categories: categories.map(categoryReadModel) };
    }
  );

  const createCategory = implementContract.expense.createCategory.handler(
    async ({ context, input }) =>
      categoryReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.createExpenseCategory(transaction, identity, {
            group: input.group,
            name: input.name,
            requestId: audit(context),
          })
        )
      )
  );

  const renameCategory = implementContract.expense.renameCategory.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.renameExpenseCategory(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            name: input.name,
            requestId: audit(context),
          })
      );
      return {
        category: categoryReadModel(result.category),
        changed: result.changed,
      };
    }
  );

  const archiveCategory = implementContract.expense.archiveCategory.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.archiveExpenseCategory(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return {
        category: categoryReadModel(result.category),
        changed: result.changed,
      };
    }
  );

  const restoreCategory = implementContract.expense.restoreCategory.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.restoreExpenseCategory(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return {
        category: categoryReadModel(result.category),
        changed: result.changed,
      };
    }
  );

  const list = implementContract.expense.list.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.listExpenses(transaction, identity, {
            categoryId: input.categoryId ?? null,
            cursor: input.cursor ?? null,
            from: input.from ?? null,
            limit: input.limit,
            status: input.status,
            to: input.to ?? null,
          })
      );
      return {
        count: result.count,
        expenses: result.expenses.map(expenseReadModel),
        nextCursor: result.nextCursor,
        total: result.total,
      };
    }
  );

  const create = implementContract.expense.create.handler(
    async ({ context, input }) =>
      expenseReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.createExpense(transaction, identity, {
            amount: input.amount,
            categoryId: input.categoryId,
            competenceOn: input.competenceOn,
            description: input.description,
            payee: input.payee ?? null,
            requestId: audit(context),
            saleId: input.saleId ?? null,
          })
        )
      )
  );

  const update = implementContract.expense.update.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.updateExpense(transaction, identity, {
            amount: input.amount,
            categoryId: input.categoryId,
            competenceOn: input.competenceOn,
            description: input.description,
            expectedVersion: input.expectedVersion,
            id: input.id,
            payee: input.payee ?? null,
            requestId: audit(context),
            saleId: input.saleId ?? null,
          })
      );
      return {
        changed: result.changed,
        expense: expenseReadModel(result.expense),
      };
    }
  );

  const voidHandler = implementContract.expense.void.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.voidExpense(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return {
        changed: result.changed,
        expense: expenseReadModel(result.expense),
      };
    }
  );

  const restore = implementContract.expense.restore.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.restoreExpense(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return {
        changed: result.changed,
        expense: expenseReadModel(result.expense),
      };
    }
  );

  const listRules = implementContract.expense.listRules.handler(
    async ({ context, input }) => {
      const rules = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.listExpenseRules(transaction, identity, {
            status: input.status,
          })
      );
      return { rules: rules.map(ruleReadModel) };
    }
  );

  const createRule = implementContract.expense.createRule.handler(
    async ({ context, input }) =>
      ruleReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.createExpenseRule(transaction, identity, {
            amount: input.amount,
            categoryId: input.categoryId,
            description: input.description,
            endsOn: input.endsOn ?? null,
            frequency: input.frequency,
            payee: input.payee ?? null,
            requestId: audit(context),
            startsOn: input.startsOn,
          })
        )
      )
  );

  const updateRule = implementContract.expense.updateRule.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.updateExpenseRule(transaction, identity, {
            amount: input.amount,
            categoryId: input.categoryId,
            description: input.description,
            endsOn: input.endsOn ?? null,
            expectedVersion: input.expectedVersion,
            id: input.id,
            payee: input.payee ?? null,
            requestId: audit(context),
          })
      );
      return { changed: result.changed, rule: ruleReadModel(result.rule) };
    }
  );

  const archiveRule = implementContract.expense.archiveRule.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.archiveExpenseRule(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return { changed: result.changed, rule: ruleReadModel(result.rule) };
    }
  );

  const restoreRule = implementContract.expense.restoreRule.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.restoreExpenseRule(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return { changed: result.changed, rule: ruleReadModel(result.rule) };
    }
  );

  return {
    archiveCategory,
    archiveRule,
    create,
    createCategory,
    createRule,
    list,
    listCategories,
    listRules,
    renameCategory,
    restore,
    restoreCategory,
    restoreRule,
    update,
    updateRule,
    void: voidHandler,
  };
}
