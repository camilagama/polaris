import type { createDatabase } from "@polaris/db/client";
import type {
  AuthorizedTenantTransactionInput,
  TenantRequestIdentity,
  TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "./environment";
import { TenantRequestContextError } from "./request-context-error";
import {
  createTenantRequestContext,
  type TenantRequestContextDependencies,
  type TenantRequestContextInput,
  type TenantRequestSession,
  withTenantRequestContext,
} from "./tenant-request-context";

type Database = ReturnType<typeof createDatabase>["db"];

function createBindings(
  overrides: Partial<WorkerBindings> = {}
): WorkerBindings {
  return {
    BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
    BETTER_AUTH_SECRET: "a".repeat(32),
    AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
    HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
    ...overrides,
  };
}

function createFixture(session: TenantRequestSession | null) {
  const database = { db: {} as Database, pool: { end: vi.fn() } };
  const getSession = vi.fn(async () => session);
  const createDatabaseMock = vi.fn(() => database);
  const createAuth = vi.fn(
    (_options: { baseURL: string; database: Database; secret: string }) => ({
      api: { getSession },
    })
  );

  const runTransaction = vi.fn(
    async <T>(
      _db: Database,
      input: AuthorizedTenantTransactionInput,
      operation: (
        transaction: TenantRequestTransaction,
        identity: TenantRequestIdentity
      ) => Promise<T>
    ) =>
      operation({} as TenantRequestTransaction, {
        capability: input.capability,
        organizationId: input.requestedOrganizationId,
        role: "owner",
        userId: input.authenticatedUserId,
      })
  );

  const dependencies: TenantRequestContextDependencies = {
    createAuth:
      createAuth as unknown as TenantRequestContextDependencies["createAuth"],
    createDatabase:
      createDatabaseMock as unknown as TenantRequestContextDependencies["createDatabase"],
    withAuthorizedTenantTransaction:
      runTransaction as unknown as typeof withAuthorizedTenantTransaction,
  };

  return {
    context: createTenantRequestContext(dependencies),
    createAuth,
    createDatabase: createDatabaseMock,
    database,
    getSession,
    runTransaction,
  };
}

const baseInput = {
  bindings: createBindings(),
  capability: "catalog:read",
  operation: vi.fn(async () => "tenant result"),
  request: new Request("https://polaris.example.invalid/rpc/catalog", {
    headers: { cookie: "better-auth.session_token=fake" },
  }),
  requestedOrganizationId: "org-requested-by-client",
} satisfies TenantRequestContextInput<string>;

describe("tenant request context", () => {
  it("requires a server session before invoking tenant authorization", async () => {
    const fixture = createFixture(null);

    await expect(fixture.context(baseInput)).rejects.toMatchObject({
      code: "session_required",
    });

    expect(fixture.getSession).toHaveBeenCalledWith({
      headers: baseInput.request.headers,
    });
    expect(fixture.runTransaction).not.toHaveBeenCalled();
    expect(fixture.database.pool.end).toHaveBeenCalledOnce();
  });

  it("passes only the Better Auth session user and requested organization to the transaction", async () => {
    const fixture = createFixture({
      session: { createdAt: new Date() },
      user: { id: "session-user-42" },
    });

    await expect(fixture.context(baseInput)).resolves.toBe("tenant result");

    expect(fixture.runTransaction).toHaveBeenCalledWith(
      fixture.database.db,
      {
        authenticatedUserId: "session-user-42",
        capability: "catalog:read",
        requestedOrganizationId: "org-requested-by-client",
      },
      baseInput.operation
    );
    expect(fixture.createDatabase).toHaveBeenNthCalledWith(
      1,
      baseInput.bindings.AUTH_HYPERDRIVE?.connectionString,
      { maxConnections: 1 }
    );
    expect(fixture.createDatabase).toHaveBeenNthCalledWith(
      2,
      baseInput.bindings.HYPERDRIVE.connectionString,
      { maxConnections: 1 }
    );
    expect(fixture.database.pool.end).toHaveBeenCalledTimes(2);
  });

  it("default context entrypoint fails closed when Better Auth is unavailable", async () => {
    await expect(
      withTenantRequestContext({
        ...baseInput,
        bindings: createBindings({ BETTER_AUTH_SECRET: "" }),
      })
    ).rejects.toBeInstanceOf(TenantRequestContextError);
  });
  it("fails when Better Auth configuration is unavailable without opening a database pool", async () => {
    const fixture = createFixture({
      session: { createdAt: new Date() },
      user: { id: "session-user-42" },
    });

    await expect(
      fixture.context({
        ...baseInput,
        bindings: createBindings({ BETTER_AUTH_SECRET: "" }),
      })
    ).rejects.toMatchObject({ code: "authentication_unavailable" });

    expect(fixture.createDatabase).not.toHaveBeenCalled();
    expect(fixture.createAuth).not.toHaveBeenCalled();
  });

  it("closes the database pool when the requested organization is invalid", async () => {
    const fixture = createFixture({
      session: { createdAt: new Date() },
      user: { id: "session-user-42" },
    });

    await expect(
      fixture.context({ ...baseInput, requestedOrganizationId: "  " })
    ).rejects.toMatchObject({ code: "organization_id_required" });

    expect(fixture.runTransaction).not.toHaveBeenCalled();
    expect(fixture.database.pool.end).toHaveBeenCalledTimes(2);
  });

  it("rejects a session older than the 30-day absolute lifetime without touching tenant data", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const fixture = createFixture({
      session: { createdAt: thirtyOneDaysAgo },
      user: { id: "session-user-42" },
    });

    await expect(fixture.context(baseInput)).rejects.toMatchObject({
      code: "session_required",
    });

    expect(fixture.createDatabase).toHaveBeenCalledOnce();
    expect(fixture.runTransaction).not.toHaveBeenCalled();
    expect(fixture.database.pool.end).toHaveBeenCalledOnce();
  });

  it("rejects a session whose creation time is unknown", async () => {
    const fixture = createFixture({
      session: { createdAt: "not-a-date" },
      user: { id: "session-user-42" },
    });

    await expect(fixture.context(baseInput)).rejects.toMatchObject({
      code: "session_required",
    });
    expect(fixture.runTransaction).not.toHaveBeenCalled();
  });

  it("accepts a session just inside the absolute lifetime", async () => {
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const fixture = createFixture({
      session: { createdAt: twentyNineDaysAgo },
      user: { id: "session-user-42" },
    });

    await expect(fixture.context(baseInput)).resolves.toBe("tenant result");
  });

  it("fails closed when a deployed Worker has no dedicated auth Hyperdrive", async () => {
    const fixture = createFixture({
      session: { createdAt: new Date() },
      user: { id: "session-user-42" },
    });
    const { AUTH_HYPERDRIVE: _removed, ...withoutAuthDatabase } =
      createBindings();

    await expect(
      fixture.context({ ...baseInput, bindings: withoutAuthDatabase })
    ).rejects.toMatchObject({ code: "authentication_unavailable" });

    expect(fixture.createDatabase).not.toHaveBeenCalled();
    expect(fixture.getSession).not.toHaveBeenCalled();
  });

  it("uses one shared pool in local development when both roles share a connection", async () => {
    const fixture = createFixture({
      session: { createdAt: new Date() },
      user: { id: "session-user-42" },
    });
    const { AUTH_HYPERDRIVE: _removed, ...withoutAuthDatabase } =
      createBindings();

    await expect(
      fixture.context({
        ...baseInput,
        bindings: {
          ...withoutAuthDatabase,
          BETTER_AUTH_BASE_URL: "http://127.0.0.1:5173",
        },
      })
    ).resolves.toBe("tenant result");

    expect(fixture.createDatabase).toHaveBeenCalledOnce();
    expect(fixture.database.pool.end).toHaveBeenCalledOnce();
  });
});
