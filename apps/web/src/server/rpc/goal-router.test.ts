import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { GoalReadModel } from "@polaris/contracts";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import {
  GoalNotActiveError,
  GoalNotFoundError,
  GoalVersionConflictError,
  InvalidGoalError,
} from "@polaris/domain/goals/goal";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
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

describe("goal RPCs", () => {
  it("listing evaluates in a repeatable-read snapshot, settles in a second transaction and reads the goals as they are then", async () => {
    const calls: { capability: string; isolationLevel?: string }[] = [];
    const evaluateActiveGoals = vi.fn(async () => [
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
        goalId: "0199c2d0-0000-7000-8000-0000000000a2",
        settlement: null,
        version: 3,
      },
    ]);
    const settleGoals = vi.fn(async () => [goalId]);
    const listGoals = vi.fn(async () => [
      {
        ...row,
        achievedValue: "1125.00",
        settledAt: at,
        status: "completed",
        version: 2,
      },
      {
        ...row,
        id: "0199c2d0-0000-7000-8000-0000000000a2",
        version: 3,
      },
    ]);
    const result = await client(
      createRpcRouter({
        goalRepository: { evaluateActiveGoals, listGoals, settleGoals },
        withTenantRequestContext: tenantStub((input) => calls.push(input)),
      })
    ).goal.list({ organizationId });

    expect(calls).toEqual([
      { capability: "goal:manage", isolationLevel: "repeatable read" },
      { capability: "goal:manage" },
      { capability: "goal:manage" },
    ]);
    expect(settleGoals).toHaveBeenCalledWith({}, identity, [
      {
        achievedValue: "1125.00",
        expectedVersion: 1,
        goalId,
        settlement: "completed",
      },
    ]);
    expect(listGoals).toHaveBeenCalledWith({}, identity, { status: "all" });
    const [done, running] = result.goals;
    expect(done).toMatchObject({
      achievedValue: "1125.00",
      progress: null,
      status: "completed",
    });
    expect(running).toMatchObject({
      progress: {
        percent: "10.0",
        periodEnded: false,
        reached: false,
        value: "100.00",
      },
      status: "active",
    });
  });

  it("creates a goal with the identity from the session and an audit request ID", async () => {
    const createGoal = vi.fn(async () => row);
    await expect(
      client(
        createRpcRouter({
          goalRepository: { createGoal },
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
    ["a missing goal", new GoalNotFoundError(), "NOT_FOUND"],
  ])("maps %s to a safe RPC error", async (_label, error, code) => {
    await expect(
      client(
        createRpcRouter({
          goalRepository: {
            evaluateActiveGoals: () => Promise.resolve([]),
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
  it("updating evaluates and settles the active goals before it changes anything", async () => {
    const order: string[] = [];
    await client(
      createRpcRouter({
        goalRepository: {
          evaluateActiveGoals: () => {
            order.push("evaluate");
            return Promise.resolve([]);
          },
          settleGoals: () => {
            order.push("settle");
            return Promise.resolve([] as string[]);
          },
          updateGoal: () => {
            order.push("update");
            return Promise.resolve({ changed: true, goal: row });
          },
        },
        withTenantRequestContext: tenantStub(),
      })
    ).goal.update({
      expectedVersion: 1,
      id: goalId,
      organizationId,
      target: "5",
    });
    expect(order).toEqual(["evaluate", "settle", "update"]);
  });
});
