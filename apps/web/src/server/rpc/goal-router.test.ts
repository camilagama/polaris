import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { GoalReadModel } from "@polaris/contracts";
import type { PeriodReadCounts } from "@polaris/db/economics-repository";
import type {
  ActiveGoalsEvaluation,
  GoalProgress,
} from "@polaris/db/goal-repository";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import {
  GoalNotActiveError,
  GoalNotFoundError,
  GoalPausedByPlanError,
  GoalVersionConflictError,
  InvalidGoalError,
} from "@polaris/domain/goals/goal";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const goalId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity: TenantRequestIdentity = {
  capability: "goal:manage",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
const at = new Date("2026-10-14T12:00:00.000Z");

const row = {
  achievedValue: null,
  createdAt: at,
  endsOn: "2026-10-31",
  id: goalId,
  kind: "net_sales",
  name: "Outubro",
  organizationId,
  settledAt: null,
  startsOn: "2026-10-01",
  status: "active",
  target: "1000.00",
  updatedAt: at,
  version: 1,
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface GoalClient {
  goal: {
    cancel: (
      input: unknown
    ) => Promise<{ changed: boolean; goal: GoalReadModel }>;
    create: (input: unknown) => Promise<GoalReadModel>;
    list: (input: unknown) => Promise<{ goals: GoalReadModel[] }>;
    targetChanges: (input: unknown) => Promise<{
      changes: {
        changedAt: string;
        newTarget: string;
        previousTarget: string;
      }[];
    }>;
    update: (
      input: unknown
    ) => Promise<{ changed: boolean; goal: GoalReadModel }>;
  };
}

function client(router: ReturnType<typeof createRpcRouter>) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as GoalClient;
}

function tenantStub(
  onCall?: (input: { capability: string; isolationLevel?: string }) => void
) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.({
      capability: input.capability,
      ...(input.isolationLevel ? { isolationLevel: input.isolationLevel } : {}),
    });
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

function numberedTenantStub(
  onCall: (input: { capability: string; isolationLevel?: string }) => void
) {
  let number = 0;
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall({
      capability: input.capability,
      ...(input.isolationLevel ? { isolationLevel: input.isolationLevel } : {}),
    });
    number += 1;
    return await input.operation(
      { number } as unknown as TenantRequestTransaction,
      identity
    );
  };
}

function evaluated(
  progress: GoalProgress[] = [],
  goals: ActiveGoalsEvaluation["goals"] = [],
  paused: string[] = []
) {
  return Promise.resolve({ goals, paused, progress });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("goal RPCs", () => {
  it("listing records the rows each goal's period read, summed, with the opaque organization only", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const reads = (sales: number): PeriodReadCounts => ({
      adjustments: 0,
      cancellations: 0,
      items: sales * 2,
      linkedExpenses: 0,
      operatingExpenses: 1,
      payments: sales,
      returnLines: 0,
      sales,
    });
    await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: (_transaction, _identity, onRead) => {
            onRead?.(reads(30));
            onRead?.(reads(366));
            return evaluated([], [{ ...row, name: "Meta secreta" }]);
          },
          settleGoals: () => Promise.resolve([]),
        },
        withTenantRequestContext: tenantStub(),
      })
    ).goal.list({ organizationId });
    const calls = info.mock.calls.filter(
      ([event]) => event === "goal_list_read"
    );
    expect(calls).toHaveLength(1);
    const fields = calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      goals: 1,
      measuredPeriods: 2,
      organizationId,
      reads: {
        items: 792,
        operatingExpenses: 2,
        payments: 396,
        sales: 396,
      },
      settlementsAsked: 0,
    });
    expect(fields.responseBytes).toBeGreaterThan(0);
    const text = JSON.stringify(fields);
    expect(text).not.toContain("Meta secreta");
    expect(text).not.toContain(row.target);
  });

  it("listing without a settlement opens one repeatable-read transaction that evaluates and answers from what it returned, and never writes", async () => {
    const calls: { capability: string; isolationLevel?: string }[] = [];
    const used = vi.fn<(step: string, transaction: unknown) => void>();
    const secondGoal = "0199c2d0-0000-7000-8000-0000000000a2";
    const result = await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: (transaction) => {
            used("evaluate", transaction);
            return evaluated(
              [
                {
                  evaluation: {
                    percent: "10.0",
                    periodEnded: false,
                    progress: "100.00",
                    reached: false,
                  },
                  goalId: secondGoal,
                  settlement: null,
                  version: 3,
                },
              ],
              [{ ...row, id: secondGoal, version: 3 }],
              [secondGoal]
            );
          },
          listGoals: (transaction) => {
            used("list", transaction);
            return Promise.resolve([]);
          },
          listPausedGoalIds: (transaction) => {
            used("paused", transaction);
            return Promise.resolve([]);
          },
          settleGoals: (transaction) => {
            used("settle", transaction);
            return Promise.resolve([]);
          },
        },
        withTenantRequestContext: numberedTenantStub((input) =>
          calls.push(input)
        ),
      })
    ).goal.list({ organizationId });

    expect(calls).toEqual([
      { capability: "goal:manage", isolationLevel: "repeatable read" },
    ]);
    expect(used.mock.calls).toEqual([["evaluate", { number: 1 }]]);
    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]).toMatchObject({
      paused: true,
      progress: {
        percent: "10.0",
        periodEnded: false,
        reached: false,
        value: "100.00",
      },
      status: "active",
    });
  });

  it("listing with a settlement opens a second transaction that settles and reads the goals again, and answers from it", async () => {
    const calls: { capability: string; isolationLevel?: string }[] = [];
    const used = vi.fn<(step: string, transaction: unknown) => void>();
    const secondGoal = "0199c2d0-0000-7000-8000-0000000000a2";
    let settled = false;
    const settleGoals = vi.fn(
      (transaction: unknown, _identity: unknown, _entries: unknown) => {
        used("settle", transaction);
        settled = true;
        return Promise.resolve([goalId]);
      }
    );
    const result = await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: (transaction) => {
            used("evaluate", transaction);
            return evaluated(
              [
                {
                  evaluation: {
                    percent: "112.5",
                    periodEnded: false,
                    progress: "1125.00",
                    reached: true,
                  },
                  goalId,
                  settlement: "completed" as const,
                  version: 1,
                },
                {
                  evaluation: {
                    percent: "10.0",
                    periodEnded: false,
                    progress: "100.00",
                    reached: false,
                  },
                  goalId: secondGoal,
                  settlement: null,
                  version: 3,
                },
              ],
              [row, { ...row, id: secondGoal, version: 3 }],
              [secondGoal]
            );
          },
          listGoals: (transaction, _identity, options) => {
            used(`list ${options?.status}`, transaction);
            return Promise.resolve([
              settled
                ? {
                    ...row,
                    achievedValue: "1125.00",
                    settledAt: at,
                    status: "completed",
                    version: 2,
                  }
                : row,
              { ...row, id: secondGoal, version: 3 },
            ]);
          },
          listPausedGoalIds: (transaction) => {
            used("paused", transaction);
            return Promise.resolve([secondGoal]);
          },
          settleGoals,
        },
        withTenantRequestContext: numberedTenantStub((input) =>
          calls.push(input)
        ),
      })
    ).goal.list({ organizationId, status: "active" });

    expect(calls).toEqual([
      { capability: "goal:manage", isolationLevel: "repeatable read" },
      { capability: "goal:manage" },
    ]);
    expect(used.mock.calls).toEqual([
      ["evaluate", { number: 1 }],
      ["settle", { number: 2 }],
      ["list active", { number: 2 }],
      ["paused", { number: 2 }],
    ]);
    expect(settleGoals).toHaveBeenCalledWith({ number: 2 }, identity, [
      {
        achievedValue: "1125.00",
        expectedVersion: 1,
        goalId,
        settlement: "completed",
      },
    ]);
    const [done, running] = result.goals;
    expect(done).toMatchObject({
      achievedValue: "1125.00",
      paused: false,
      progress: null,
      status: "completed",
    });
    expect(running).toMatchObject({
      paused: true,
      progress: {
        percent: "10.0",
        periodEnded: false,
        reached: false,
        value: "100.00",
      },
      status: "active",
    });
  });

  it("listing answers the same payload per status filter from the goals and paused ids the evaluation returned", async () => {
    const pausedId = "0199c2d0-0000-7000-8000-0000000000a2";
    const doneId = "0199c2d0-0000-7000-8000-0000000000a3";
    const missedId = "0199c2d0-0000-7000-8000-0000000000a4";
    const cancelledId = "0199c2d0-0000-7000-8000-0000000000a5";
    const goals = [
      row,
      { ...row, id: pausedId, startsOn: "2026-09-01" },
      {
        ...row,
        achievedValue: "1200.00",
        id: doneId,
        settledAt: at,
        startsOn: "2026-08-01",
        status: "completed",
        version: 2,
      },
      {
        ...row,
        achievedValue: "300.00",
        id: missedId,
        settledAt: at,
        startsOn: "2026-07-01",
        status: "missed",
        version: 2,
      },
      {
        ...row,
        id: cancelledId,
        startsOn: "2026-06-01",
        status: "cancelled",
        version: 2,
      },
    ];
    const progress: GoalProgress[] = [
      {
        evaluation: {
          percent: "10.0",
          periodEnded: false,
          progress: "100.00",
          reached: false,
        },
        goalId,
        settlement: null,
        version: 1,
      },
    ];
    const listGoals = vi.fn(() => Promise.resolve([]));
    const listPausedGoalIds = vi.fn(() => Promise.resolve([]));
    const api = client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: () => evaluated(progress, goals, [pausedId]),
          listGoals,
          listPausedGoalIds,
        },
        withTenantRequestContext: tenantStub(),
      })
    );
    const readModel = (
      source: ActiveGoalsEvaluation["goals"][number],
      fields: Record<string, unknown>
    ) => ({
      achievedValue: source.achievedValue,
      createdAt: at.toISOString(),
      endsOn: "2026-10-31",
      id: source.id,
      kind: "net_sales",
      name: "Outubro",
      organizationId,
      paused: false,
      progress: null,
      settledAt: source.settledAt ? at.toISOString() : null,
      startsOn: source.startsOn,
      status: source.status,
      target: "1000.00",
      updatedAt: at.toISOString(),
      version: source.version,
      ...fields,
    });
    const [first, second, third, fourth, fifth] = goals as [
      ActiveGoalsEvaluation["goals"][number],
      ActiveGoalsEvaluation["goals"][number],
      ActiveGoalsEvaluation["goals"][number],
      ActiveGoalsEvaluation["goals"][number],
      ActiveGoalsEvaluation["goals"][number],
    ];
    const running = readModel(first, {
      progress: {
        periodEnded: false,
        percent: "10.0",
        reached: false,
        value: "100.00",
      },
    });
    const paused = readModel(second, { paused: true });
    const done = readModel(third, {});
    const missed = readModel(fourth, {});
    const cancelled = readModel(fifth, {});

    expect(await api.goal.list({ organizationId })).toEqual({
      goals: [running, paused, done, missed, cancelled],
    });
    expect(await api.goal.list({ organizationId, status: "all" })).toEqual({
      goals: [running, paused, done, missed, cancelled],
    });
    expect(await api.goal.list({ organizationId, status: "active" })).toEqual({
      goals: [running, paused],
    });
    expect(
      await api.goal.list({ organizationId, status: "completed" })
    ).toEqual({ goals: [done] });
    expect(await api.goal.list({ organizationId, status: "missed" })).toEqual({
      goals: [missed],
    });
    expect(
      await api.goal.list({ organizationId, status: "cancelled" })
    ).toEqual({ goals: [cancelled] });
    expect(listGoals).not.toHaveBeenCalled();
    expect(listPausedGoalIds).not.toHaveBeenCalled();
  });

  it("listing keeps no progress for a goal whose version moved after it was measured", async () => {
    const result = await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: () =>
            evaluated(
              [
                {
                  evaluation: {
                    percent: "10.0",
                    periodEnded: false,
                    progress: "100.00",
                    reached: false,
                  },
                  goalId,
                  settlement: null,
                  version: 1,
                },
              ],
              [{ ...row, version: 2 }]
            ),
        },
        withTenantRequestContext: tenantStub(),
      })
    ).goal.list({ organizationId });
    expect(result.goals[0]).toMatchObject({ progress: null, version: 2 });
  });

  it("listing records its read counts again from zero when the transaction runs twice", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const reads: PeriodReadCounts = {
      adjustments: 0,
      cancellations: 0,
      items: 0,
      linkedExpenses: 0,
      operatingExpenses: 0,
      payments: 0,
      returnLines: 0,
      sales: 7,
    };
    await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: (_transaction, _identity, onRead) => {
            onRead?.(reads);
            return evaluated();
          },
        },
        withTenantRequestContext: async (input) => {
          await input.operation({} as TenantRequestTransaction, identity);
          return await input.operation(
            {} as TenantRequestTransaction,
            identity
          );
        },
      })
    ).goal.list({ organizationId });
    const fields = info.mock.calls.find(
      ([event]) => event === "goal_list_read"
    )?.[1] as { measuredPeriods: number; reads: { sales: number } };
    expect(fields.measuredPeriods).toBe(1);
    expect(fields.reads.sales).toBe(7);
  });

  it("a refused session runs no repository work and opens no second transaction", async () => {
    const repository = {
      evaluateActiveGoals: vi.fn(() => evaluated()),
      listGoals: vi.fn(() => Promise.resolve([])),
      listPausedGoalIds: vi.fn(() => Promise.resolve([])),
      settleGoals: vi.fn(() => Promise.resolve([])),
    };
    const withTenantRequestContext = vi.fn(() =>
      Promise.reject(new TenantRequestContextError("session_required"))
    );
    await expect(
      client(
        createRpcRouter({
          goalRepository: repository,
          withTenantRequestContext:
            withTenantRequestContext as unknown as NonNullable<
              NonNullable<
                Parameters<typeof createRpcRouter>[0]
              >["withTenantRequestContext"]
            >,
        })
      ).goal.list({ organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(withTenantRequestContext).toHaveBeenCalledTimes(1);
    for (const work of Object.values(repository)) {
      expect(work).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["membership", new TenantAuthorizationError("tenant_access_denied")],
    ["capability", new TenantAuthorizationError("capability_denied")],
    [
      "closed organization",
      new TenantAuthorizationError("organization_closed"),
    ],
  ])(
    "a %s refusal of the transaction answers the RPC error and runs no repository work",
    async (_label, error) => {
      const repository = {
        evaluateActiveGoals: vi.fn(() => evaluated()),
        listGoals: vi.fn(() => Promise.resolve([])),
        listPausedGoalIds: vi.fn(() => Promise.resolve([])),
        settleGoals: vi.fn(() => Promise.resolve([])),
      };
      const withTenantRequestContext = vi.fn(() => Promise.reject(error));
      const rejection = client(
        createRpcRouter({
          goalRepository: repository,
          withTenantRequestContext:
            withTenantRequestContext as unknown as NonNullable<
              NonNullable<
                Parameters<typeof createRpcRouter>[0]
              >["withTenantRequestContext"]
            >,
        })
      ).goal.list({ organizationId });
      await expect(rejection).rejects.toMatchObject({
        code: "FORBIDDEN",
        data:
          error.code === "organization_closed"
            ? { reason: "organization_closed" }
            : undefined,
      });
      expect(withTenantRequestContext).toHaveBeenCalledTimes(1);
      for (const work of Object.values(repository)) {
        expect(work).not.toHaveBeenCalled();
      }
    }
  );

  it("creates a goal with the identity from the session and an audit request ID", async () => {
    const createGoal = vi.fn(async () => row);
    const settleGoals = vi.fn(async () => []);
    await expect(
      client(
        createRpcRouter({
          goalRepository: {
            createGoal,
            evaluateActiveGoals: () => evaluated(),
            settleGoals,
          },
          withTenantRequestContext: tenantStub(),
        })
      ).goal.create({
        endsOn: "2026-10-31",
        kind: "net_sales",
        name: "Outubro",
        organizationId: "requested-org",
        startsOn: "2026-10-01",
        target: "1000",
      })
    ).resolves.toMatchObject({
      kind: "net_sales",
      status: "active",
      target: "1000.00",
    });
    // with nothing to settle no second transaction opens
    expect(settleGoals).not.toHaveBeenCalled();
    expect(createGoal).toHaveBeenCalledWith({}, identity, {
      endsOn: "2026-10-31",
      kind: "net_sales",
      name: "Outubro",
      requestId: expect.stringMatching(requestIdPattern),
      startsOn: "2026-10-01",
      target: "1000",
    });
  });

  it("refuses malformed input before opening a tenant context", async () => {
    const withTenantRequestContext = vi.fn(tenantStub());
    const strict = client(
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
      endsOn: "2026-10-31",
      kind: "net_sales",
      organizationId,
      startsOn: "2026-10-01",
      target: "10",
    };
    for (const bad of [
      { ...valid, kind: "profit" },
      { ...valid, startsOn: "01/10/2026" },
      { ...valid, target: "" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(strict.goal.create(bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid goal", new InvalidGoalError(), "BAD_REQUEST"],
    ["a stale version", new GoalVersionConflictError(), "CONFLICT"],
    ["a goal that is no longer active", new GoalNotActiveError(), "CONFLICT"],
    ["a goal the plan pauses", new GoalPausedByPlanError(), "CONFLICT"],
    ["a missing goal", new GoalNotFoundError(), "NOT_FOUND"],
  ])("maps %s to a safe RPC error", async (_label, error, code) => {
    await expect(
      client(
        createRpcRouter({
          goalRepository: {
            evaluateActiveGoals: () => evaluated(),
            settleGoals: () => Promise.resolve([]),
            updateGoal: () => Promise.reject(error),
          },
          withTenantRequestContext: tenantStub(),
        })
      ).goal.update({
        expectedVersion: 1,
        id: goalId,
        organizationId,
        target: "5",
      })
    ).rejects.toMatchObject({ code });
  });

  it("returns the target history in order", async () => {
    const listGoalTargetChanges = vi.fn(async () => [
      { changedAt: at, newTarget: "5", previousTarget: "10" },
    ]);
    await expect(
      client(
        createRpcRouter({
          goalRepository: { listGoalTargetChanges },
          withTenantRequestContext: tenantStub(),
        })
      ).goal.targetChanges({ id: goalId, organizationId })
    ).resolves.toEqual({
      changes: [
        { changedAt: at.toISOString(), newTarget: "5", previousTarget: "10" },
      ],
    });
  });
});

describe("goal RPCs: edits settle first", () => {
  const reached = {
    evaluation: {
      percent: "112.5",
      periodEnded: false,
      progress: "1125.00",
      reached: true,
    },
    goalId,
    settlement: "completed" as const,
    version: 1,
  };

  const edit = {
    cancel: (api: GoalClient) =>
      api.goal.cancel({ expectedVersion: 1, id: goalId, organizationId }),
    create: (api: GoalClient) =>
      api.goal.create({
        endsOn: "2026-10-31",
        kind: "net_sales",
        organizationId,
        startsOn: "2026-10-01",
        target: "10",
      }),
    update: (api: GoalClient) =>
      api.goal.update({
        expectedVersion: 1,
        id: goalId,
        organizationId,
        target: "5",
      }),
  };

  const order = async (
    action: keyof typeof edit,
    progress: (typeof reached)[]
  ) => {
    const steps: string[] = [];
    await edit[action](
      client(
        createRpcRouter({
          goalRepository: {
            cancelGoal: () => {
              steps.push("cancel");
              return Promise.resolve({ changed: true, goal: row });
            },
            createGoal: () => {
              steps.push("create");
              return Promise.resolve(row);
            },
            evaluateActiveGoals: () => {
              steps.push("evaluate");
              return evaluated(progress);
            },
            settleGoals: () => {
              steps.push("settle");
              return Promise.resolve([] as string[]);
            },
            updateGoal: () => {
              steps.push("update");
              return Promise.resolve({ changed: true, goal: row });
            },
          },
          withTenantRequestContext: tenantStub(),
        })
      )
    );
    return steps;
  };

  it.each(["create", "update", "cancel"] as const)(
    "%s settles a goal that reached its target before it changes anything",
    async (action) => {
      expect(await order(action, [reached])).toEqual([
        "evaluate",
        "settle",
        action,
      ]);
    }
  );

  it.each(["create", "update", "cancel"] as const)(
    "%s with nothing to settle opens no settlement transaction",
    async (action) => {
      expect(await order(action, [])).toEqual(["evaluate", action]);
    }
  );
});
