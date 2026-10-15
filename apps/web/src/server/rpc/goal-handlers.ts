import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  cancelGoal,
  evaluateActiveGoals,
  listGoals,
  listGoalTargetChanges,
  settleGoals,
  updateGoal,
  createGoal,
} from "@polaris/db/goal-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface GoalRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

const defaultGoalRepository = {
  cancelGoal,
  createGoal,
  evaluateActiveGoals,
  listGoalTargetChanges,
  listGoals,
  settleGoals,
  updateGoal,
};

/** The repository functions the handlers call; tests replace any of them. */
export type GoalRepository = typeof defaultGoalRepository;

interface GoalRpcDependencies {
  goalRepository: Partial<GoalRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "goal:manage";

type GoalRow = Awaited<ReturnType<GoalRepository["createGoal"]>>;

interface Progress {
  periodEnded: boolean;
  percent: string | null;
  reached: boolean;
  value: string;
}

function goalReadModel(goal: GoalRow, progress: Progress | null) {
  return {
    achievedValue: goal.achievedValue,
    createdAt: goal.createdAt.toISOString(),
    endsOn: goal.endsOn,
    id: goal.id,
    kind: goal.kind as "net_sales" | "operating_result" | "sale_count",
    name: goal.name,
    organizationId: goal.organizationId,
    progress: goal.status === "active" ? progress : null,
    settledAt: goal.settledAt?.toISOString() ?? null,
    startsOn: goal.startsOn,
    status: goal.status as "active" | "cancelled" | "completed" | "missed",
    target: goal.target,
    updatedAt: goal.updatedAt.toISOString(),
    version: goal.version,
  };
}

/**
 * Goals. Every operation needs `goal:manage`. Listing evaluates the active
 * goals over their period in one repeatable-read snapshot (the economics need
 * it) and then settles, in a second short transaction, the ones that reached
 * their target or whose period ended: that is how a completed goal stays
 * completed.
 */
export function createGoalRpcHandlers(dependencies: GoalRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<GoalRpcContext>();
  const repository = {
    ...defaultGoalRepository,
    ...dependencies.goalRepository,
  };

  const run = <T>(
    context: GoalRpcContext,
    organizationId: string,
    operation: Parameters<
      typeof dependencies.withTenantRequestContext<T>
    >[0]["operation"],
    isolationLevel?: "read committed" | "repeatable read"
  ) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        ...(isolationLevel ? { isolationLevel } : {}),
        operation,
        request: context.request,
        requestedOrganizationId: organizationId,
      })
      .catch(dependencies.toRpcError);

  const audit = (context: GoalRpcContext) =>
    dependencies.requestAuditId(context.requestId);

  /**
   * Evaluates the active goals in one snapshot and settles what it says in a
   * second short transaction. Run before editing or cancelling too, so a goal
   * that already reached its target (or whose period ended) is settled instead
   * of being changed under the person's feet.
   */
  const evaluateAndSettle = async (
    context: GoalRpcContext,
    organizationId: string
  ) => {
    const progress = await run(
      context,
      organizationId,
      (transaction, identity) =>
        repository.evaluateActiveGoals(transaction, identity),
      "repeatable read"
    );
    await run(context, organizationId, (transaction, identity) =>
      repository.settleGoals(
        transaction,
        identity,
        progress.flatMap((entry) =>
          entry.settlement
            ? [
                {
                  achievedValue: entry.evaluation.progress,
                  expectedVersion: entry.version,
                  goalId: entry.goalId,
                  settlement: entry.settlement,
                },
              ]
            : []
        )
      )
    );
    return progress;
  };

  const list = implementContract.goal.list.handler(
    async ({ context, input }) => {
      const progress = await evaluateAndSettle(context, input.organizationId);
      // the goals as they are now (progress belongs to the version it was measured at)
      const goals = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.listGoals(transaction, identity, {
            status: input.status,
          })
      );
      const byGoal = new Map(progress.map((entry) => [entry.goalId, entry]));
      return {
        goals: goals.map((row) => {
          const entry = byGoal.get(row.id);
          return goalReadModel(
            row,
            entry && entry.version === row.version
              ? {
                  periodEnded: entry.evaluation.periodEnded,
                  percent: entry.evaluation.percent,
                  reached: entry.evaluation.reached,
                  value: entry.evaluation.progress,
                }
              : null
          );
        }),
      };
    }
  );

  const create = implementContract.goal.create.handler(
    async ({ context, input }) => {
      // a goal that already reached its target or whose period ended no longer
      // counts against the plan's limit, but only once it is settled
      await evaluateAndSettle(context, input.organizationId);
      return goalReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.createGoal(transaction, identity, {
            endsOn: input.endsOn,
            kind: input.kind,
            name: input.name ?? null,
            requestId: audit(context),
            startsOn: input.startsOn,
            target: input.target,
          })
        ),
        null
      );
    }
  );

  const update = implementContract.goal.update.handler(
    async ({ context, input }) => {
      await evaluateAndSettle(context, input.organizationId);
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.updateGoal(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            requestId: audit(context),
            target: input.target,
          })
      );
      return {
        changed: result.changed,
        goal: goalReadModel(result.goal, null),
      };
    }
  );

  const cancel = implementContract.goal.cancel.handler(
    async ({ context, input }) => {
      await evaluateAndSettle(context, input.organizationId);
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.cancelGoal(transaction, identity, {
            expectedVersion: input.expectedVersion,
            id: input.id,
            requestId: audit(context),
          })
      );
      return {
        changed: result.changed,
        goal: goalReadModel(result.goal, null),
      };
    }
  );

  const targetChanges = implementContract.goal.targetChanges.handler(
    async ({ context, input }) => {
      const changes = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.listGoalTargetChanges(transaction, identity, input.id)
      );
      return {
        changes: changes.map((change) => ({
          changedAt: change.changedAt.toISOString(),
          newTarget: change.newTarget,
          previousTarget: change.previousTarget,
        })),
      };
    }
  );

  return { cancel, create, list, targetChanges, update };
}
