import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../sync/push";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const leaseSecret = "s".repeat(40);
const identity = {
  capability: "sync:push",
  organizationId,
  role: "owner",
  userId: "session-user-17",
};
const bindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  OFFLINE_LEASE_SECRET: leaseSecret,
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface PushResultView {
  code: string | null;
  commandId: string;
  replayed: boolean;
  result: unknown;
  status: string;
}

function createClient(
  overrides: Record<string, unknown>,
  workerBindings: WorkerBindings = bindings
) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, workerBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    sync: {
      push: (input: unknown) => Promise<{ results: PushResultView[] }>;
    };
  };
}

function tenantContext() {
  return vi.fn(
    (input: {
      capability: string;
      operation: (
        transaction: unknown,
        authorized: typeof identity
      ) => Promise<unknown>;
      requestedOrganizationId: string;
    }) => input.operation({}, identity)
  );
}

async function lease() {
  const issuedAt = new Date(Date.now() - 3_600_000);
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["customer:update"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(issuedAt.getTime() + 72 * 3_600_000),
      grantId: uuid(900),
      issuedAt,
      organizationId,
      userId: identity.userId,
    }),
    { id: "k1", secret: leaseSecret }
  );
}

async function pushCommand(n: number, overrides: Record<string, unknown> = {}) {
  return {
    baseVersion: null,
    commandId: uuid(n),
    createdAt: new Date().toISOString(),
    deviceId,
    lease: await lease(),
    payload: { name: `Cliente ${n}` },
    type: "customer.create",
    ...overrides,
  };
}

const customerHandler: SyncCommandHandler = {
  capability: "customer:update",
  classify: () => null,
  execute: () => Promise.resolve({ created: true }),
  parse: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      throw new InvalidSyncPayloadError();
    }
    return payload;
  },
  type: "customer.create",
};

const acceptedOutcome = {
  code: null,
  replayed: false,
  result: { created: true },
  status: "accepted" as const,
};

describe("sync.push", () => {
  it("runs each command in its own sync:push transaction for the requested organization", async () => {
    const withTenantRequestContext = tenantContext();
    const runSyncCommand = vi.fn(() => Promise.resolve(acceptedOutcome));
    const client = createClient({
      runSyncCommand,
      syncCommandHandlers: [customerHandler],
      withTenantRequestContext,
    });

    const { results } = await client.sync.push({
      commands: [await pushCommand(1), await pushCommand(2)],
      organizationId,
    });

    expect(withTenantRequestContext).toHaveBeenCalledTimes(2);
    expect(withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "sync:push",
        requestedOrganizationId: organizationId,
      })
    );
    expect(runSyncCommand).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      {
        code: null,
        commandId: uuid(1),
        replayed: false,
        result: { created: true },
        status: "accepted",
      },
      {
        code: null,
        commandId: uuid(2),
        replayed: false,
        result: { created: true },
        status: "accepted",
      },
    ]);
  });

  it("reports commands after a rejection as not processed", async () => {
    const runSyncCommand = vi
      .fn()
      .mockResolvedValueOnce({
        code: "stock_insufficient",
        replayed: false,
        result: null,
        status: "rejected",
      })
      .mockResolvedValue(acceptedOutcome);
    const client = createClient({
      runSyncCommand,
      syncCommandHandlers: [customerHandler],
      withTenantRequestContext: tenantContext(),
    });
    const { results } = await client.sync.push({
      commands: [await pushCommand(1), await pushCommand(2)],
      organizationId,
    });
    expect(results.map((r) => r.status)).toEqual(["rejected", "not_processed"]);
    expect(runSyncCommand).toHaveBeenCalledTimes(1);
  });

  it("answers an unregistered command type with a stored-style rejection, not an error", async () => {
    const runSyncCommand = vi.fn(
      (_t, _i, input: { precheckFailure?: string | null }) =>
        Promise.resolve({
          code: input.precheckFailure ?? null,
          replayed: false,
          result: null,
          status: "rejected" as const,
        })
    );
    const client = createClient({
      runSyncCommand,
      withTenantRequestContext: tenantContext(),
    });
    const { results } = await client.sync.push({
      commands: [await pushCommand(1, { type: "sale.confirm" })],
      organizationId,
    });
    expect(results[0]).toMatchObject({
      code: "unsupported_command_type",
      status: "rejected",
    });
  });

  it("fails closed with 503, running nothing, when no lease secret is configured", async () => {
    const runSyncCommand = vi.fn();
    const withTenantRequestContext = tenantContext();
    const { OFFLINE_LEASE_SECRET: _omitted, ...withoutSecret } = bindings;
    const client = createClient(
      { runSyncCommand, withTenantRequestContext },
      withoutSecret
    );
    await expect(
      client.sync.push({ commands: [await pushCommand(1)], organizationId })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(runSyncCommand).not.toHaveBeenCalled();
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("rejects malformed batches before anything runs", async () => {
    const runSyncCommand = vi.fn();
    const client = createClient({
      runSyncCommand,
      withTenantRequestContext: tenantContext(),
    });
    const good = await pushCommand(1);
    const cases: unknown[] = [
      { commands: [], organizationId },
      { commands: Array.from({ length: 51 }, () => good), organizationId },
      { commands: [{ ...good, commandId: "nope" }], organizationId },
      { commands: [{ ...good, type: "Not A Type" }], organizationId },
      { commands: [{ ...good, createdAt: "yesterday" }], organizationId },
      { commands: [{ ...good, baseVersion: -1 }], organizationId },
      { commands: [{ ...good, lease: "" }], organizationId },
    ];
    for (const input of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: each input is verified on its own
      await expect(client.sync.push(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(runSyncCommand).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    const { TenantRequestContextError } = await import(
      "../request-context-error"
    );
    const client = createClient({
      runSyncCommand: vi.fn(),
      syncCommandHandlers: [customerHandler],
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(
      client.sync.push({ commands: [await pushCommand(1)], organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
