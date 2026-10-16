import { getEffectiveEntitlements } from "./billing-repository";
import { periodResult } from "@polaris/domain/economics/sale-economics";
import {
  evaluateGoal,
  type GoalEvaluation,
  GoalLimitReachedError,
  GoalNotActiveError,
  GoalNotFoundError,
  GoalPausedByPlanError,
  GoalPeriodEndedError,
  MAX_ACTIVE_GOALS,
  pausedGoalIds,
  type GoalInput,
  type GoalKind,
  type GoalSettlement,
  GoalVersionConflictError,
  type GoalStatus,
  InvalidGoalError,
  normalizeGoal,
  normalizeGoalTarget,
  settleGoal,
} from "@polaris/domain/goals/goal";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { readPeriodFacts } from "./economics-repository";
import { assertRoomFor } from "./entitlement-enforcement";
import { organizationToday } from "./expense-repository";
import { goalTargetChanges, goals } from "./schema/goal";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/** Every goal operation needs this capability (owner-only in the V1). */
const GOAL_CAPABILITY = "goal:manage";

function requireGoalCapability(identity: TenantRequestIdentity) {
  if (identity.capability !== GOAL_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

export interface GoalListOptions {
  status?: "active" | "all" | GoalStatus;
}

export interface CreateGoalInput extends GoalInput {
  requestId?: string | null;
}

export interface UpdateGoalInput {
  expectedVersion: number;
  id: string;
  name?: string | null | undefined;
  requestId?: string | null;
  target?: string | undefined;
}

export interface GoalMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

const goalColumns = {
  achievedValue: goals.achievedValue,
  createdAt: goals.createdAt,
  endsOn: goals.endsOn,
  id: goals.id,
  kind: goals.kind,
  name: goals.name,
  organizationId: goals.organizationId,
  settledAt: goals.settledAt,
  startsOn: goals.startsOn,
  status: goals.status,
  target: goals.target,
  updatedAt: goals.updatedAt,
  version: goals.version,
};

export async function listGoals(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: GoalListOptions = {}
) {
  requireGoalCapability(identity);
  const filters = [eq(goals.organizationId, identity.organizationId)];
  const status = options.status ?? "all";
  if (status !== "all") {
    filters.push(eq(goals.status, status));
  }
  return await transaction
    .select(goalColumns)
    .from(goals)
    .where(and(...filters))
    .orderBy(sql`${goals.startsOn} DESC`, asc(goals.id));
}

/**
 * The active goals the plan pauses (more active goals than the limit in force,
 * after a downgrade): the newest ones. Nothing is stored; it is derived here.
 */
export async function listPausedGoalIds(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<string[]> {
  requireGoalCapability(identity);
  const active = await transaction
    .select({
      createdAt: goals.createdAt,
      endsOn: goals.endsOn,
      id: goals.id,
      startsOn: goals.startsOn,
    })
    .from(goals)
    .where(
      and(
        eq(goals.organizationId, identity.organizationId),
        eq(goals.status, "active")
      )
    );
  if (active.length === 0) {
    return [];
  }
  const entitlements = await getEffectiveEntitlements(transaction, identity);
  return pausedGoalIds(
    active,
    entitlements.values["goals.active.max"],
    await organizationToday(transaction, identity)
  );
}

export async function createGoal(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateGoalInput
) {
  requireGoalCapability(identity);
  const normalized = normalizeGoal(
    input,
    await organizationToday(transaction, identity)
  );
  const countActive = async () => {
    const [{ active } = { active: 0 }] = await transaction
      .select({ active: sql<number>`count(*)::int` })
      .from(goals)
      .where(
        and(
          eq(goals.organizationId, identity.organizationId),
          eq(goals.status, "active")
        )
      );
    return active;
  };
  // the plan's limit (1 on Free, 3 on Pro), then the technical ceiling
  await assertRoomFor(
    transaction,
    identity,
    "goals.active.max",
    1,
    countActive
  );
  if ((await countActive()) >= MAX_ACTIVE_GOALS) {
    throw new GoalLimitReachedError();
  }
  const [created] = await transaction
    .insert(goals)
    .values({
      endsOn: normalized.endsOn,
      kind: normalized.kind,
      name: normalized.name,
      organizationId: identity.organizationId,
      startsOn: normalized.startsOn,
      target: normalized.target,
    })
    .returning(goalColumns);
  if (!created) {
    throw new Error("goal_insert_failed");
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "goal",
    eventType: "goal.created",
    requestId: input.requestId ?? null,
  });
  return created;
}

async function lockGoal(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: GoalMutationInput
) {
  const [existing] = await transaction
    .select(goalColumns)
    .from(goals)
    .where(
      and(
        eq(goals.id, input.id),
        eq(goals.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!existing) {
    throw new GoalNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new GoalVersionConflictError();
  }
  return existing;
}

/**
 * Changes the name and/or the target of an active goal. A changed target is
 * kept in the goal's history (previous and new value) and audited; a goal that
 * is not active is final and read-only.
 */
export async function updateGoal(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdateGoalInput
) {
  requireGoalCapability(identity);
  const existing = await lockGoal(transaction, identity, input);
  if (existing.status !== "active") {
    throw new GoalNotActiveError();
  }
  // a goal the plan pauses can only be cancelled until the plan allows it again
  if ((await listPausedGoalIds(transaction, identity)).includes(existing.id)) {
    throw new GoalPausedByPlanError();
  }
  if (existing.endsOn < (await organizationToday(transaction, identity))) {
    // the period is over: the next read settles it; it is not edited
    throw new GoalPeriodEndedError();
  }
  const kind = existing.kind as GoalKind;
  const target =
    input.target === undefined
      ? existing.target
      : normalizeGoalTarget(kind, input.target);
  let { name } = existing;
  if (input.name !== undefined) {
    name = input.name?.trim() || null;
    if (name !== null && [...name].length > 100) {
      throw new InvalidGoalError();
    }
  }
  // both are normalized decimal text (two places, or a whole number): compare as text
  const targetChanged = target !== existing.target;
  if (!targetChanged && name === existing.name) {
    return { changed: false, goal: existing };
  }
  const [updated] = await transaction
    .update(goals)
    .set({ name, target, updatedAt: new Date(), version: existing.version + 1 })
    .where(
      and(
        eq(goals.id, input.id),
        eq(goals.organizationId, identity.organizationId),
        eq(goals.version, input.expectedVersion)
      )
    )
    .returning(goalColumns);
  if (!updated) {
    throw new GoalVersionConflictError();
  }
  if (targetChanged) {
    await transaction.insert(goalTargetChanges).values({
      changedBy: identity.userId,
      goalId: updated.id,
      newTarget: target,
      organizationId: identity.organizationId,
      previousTarget: existing.target,
    });
    await recordTenantAuditEvent(transaction, identity, {
      entityId: updated.id,
      entityType: "goal",
      eventType: "goal.target_changed",
      requestId: input.requestId ?? null,
    });
  }
  if (name !== existing.name) {
    await recordTenantAuditEvent(transaction, identity, {
      entityId: updated.id,
      entityType: "goal",
      eventType: "goal.updated",
      requestId: input.requestId ?? null,
    });
  }
  return { changed: true, goal: updated };
}

export async function cancelGoal(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: GoalMutationInput
) {
  requireGoalCapability(identity);
  const existing = await lockGoal(transaction, identity, input);
  if (existing.status === "cancelled") {
    return { changed: false, goal: existing };
  }
  if (existing.status !== "active") {
    throw new GoalNotActiveError();
  }
  const [updated] = await transaction
    .update(goals)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(goals.id, input.id),
        eq(goals.organizationId, identity.organizationId),
        eq(goals.version, input.expectedVersion)
      )
    )
    .returning(goalColumns);
  if (!updated) {
    throw new GoalVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: updated.id,
    entityType: "goal",
    eventType: "goal.cancelled",
    requestId: input.requestId ?? null,
  });
  return { changed: true, goal: updated };
}

export async function listGoalTargetChanges(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  goalId: string
) {
  requireGoalCapability(identity);
  return await transaction
    .select({
      changedAt: goalTargetChanges.changedAt,
      newTarget: goalTargetChanges.newTarget,
      previousTarget: goalTargetChanges.previousTarget,
    })
    .from(goalTargetChanges)
    .where(
      and(
        eq(goalTargetChanges.organizationId, identity.organizationId),
        eq(goalTargetChanges.goalId, goalId)
      )
    )
    .orderBy(asc(goalTargetChanges.changedAt), asc(goalTargetChanges.id));
}

/** The period result from the start to `through`; a goal that has not started has nothing to measure yet. */
async function resultSoFar(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  startsOn: string,
  through: string
) {
  if (startsOn > through) {
    return periodResult([], []);
  }
  const facts = await readPeriodFacts(transaction, identity, {
    from: startsOn,
    to: through,
  });
  return periodResult(facts.sales, facts.operatingExpenses);
}

export interface GoalProgress {
  evaluation: GoalEvaluation;
  goalId: string;
  settlement: GoalSettlement | null;
  version: number;
}

/**
 * The progress of every active goal, measured over its period so far (from the
 * start to the earlier of the end and today) with the same economics the
 * dashboard shows. Read-only: run it in a REPEATABLE READ transaction (the
 * economics read requires it), then settle what it says in a second, short
 * transaction (`settleGoals`).
 */
export async function evaluateActiveGoals(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<GoalProgress[]> {
  requireGoalCapability(identity);
  const today = await organizationToday(transaction, identity);
  const active = await listGoals(transaction, identity, { status: "active" });
  const paused = new Set(await listPausedGoalIds(transaction, identity));
  const progress: GoalProgress[] = [];
  for (const goal of active) {
    // a paused goal is not measured (a goal whose period has ended is never paused:
    // it is settled right here, so history stays correct and it takes no place)
    if (paused.has(goal.id)) {
      continue;
    }
    const kind = goal.kind as GoalKind;
    const through = goal.endsOn < today ? goal.endsOn : today;
    // biome-ignore lint/performance/noAwaitInLoops: one goal at a time, a handful per organization
    const result = await resultSoFar(
      transaction,
      identity,
      goal.startsOn,
      through
    );
    const evaluation = evaluateGoal(
      { endsOn: goal.endsOn, kind, target: goal.target },
      result,
      today
    );
    progress.push({
      evaluation,
      goalId: goal.id,
      settlement: settleGoal("active", evaluation, kind),
      version: goal.version,
    });
  }
  return progress;
}

export interface GoalSettlementInput {
  /** The measure at the time (decimal text). */
  achievedValue: string;
  expectedVersion: number;
  goalId: string;
  settlement: GoalSettlement;
}

/**
 * Applies the settlements `evaluateActiveGoals` asked for: completed (the
 * target was reached) or missed (the period ended without it). Idempotent and
 * safe under concurrency: each goal is locked in ID order and settled only if
 * it is still active at the version that was evaluated (an edited target is
 * evaluated again on the next read). A settled goal is final.
 */
export async function settleGoals(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  settlements: readonly GoalSettlementInput[]
): Promise<string[]> {
  requireGoalCapability(identity);
  if (settlements.length === 0) {
    return [];
  }
  const ordered = [...settlements].sort((a, b) =>
    a.goalId.localeCompare(b.goalId)
  );
  const locked = await transaction
    .select({ id: goals.id, status: goals.status, version: goals.version })
    .from(goals)
    .where(
      and(
        eq(goals.organizationId, identity.organizationId),
        inArray(
          goals.id,
          ordered.map((entry) => entry.goalId)
        )
      )
    )
    .orderBy(asc(goals.id))
    .for("update");
  const byId = new Map(locked.map((row) => [row.id, row]));
  const applied: string[] = [];
  for (const entry of ordered) {
    const row = byId.get(entry.goalId);
    if (row?.status !== "active" || row.version !== entry.expectedVersion) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one goal at a time under its row lock
    await transaction
      .update(goals)
      .set({
        achievedValue: entry.achievedValue,
        settledAt: new Date(),
        status: entry.settlement,
        updatedAt: new Date(),
        version: row.version + 1,
      })
      .where(
        and(
          eq(goals.id, entry.goalId),
          eq(goals.organizationId, identity.organizationId)
        )
      );
    await recordTenantAuditEvent(transaction, identity, {
      entityId: entry.goalId,
      entityType: "goal",
      eventType:
        entry.settlement === "completed" ? "goal.completed" : "goal.missed",
      requestId: null,
    });
    applied.push(entry.goalId);
  }
  return applied;
}
