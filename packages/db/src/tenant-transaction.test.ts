import { describe, expect, it, vi } from "vitest";
import type { createDatabase } from "./client";
import { memberships, organizations } from "./schema/organization";
import {
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "./tenant-transaction";

type Database = ReturnType<typeof createDatabase>["db"];

interface DatabaseStubOptions {
  membership?: { role: string; status: string };
  organization?: { status: string };
}

function createDatabaseStub(options: DatabaseStubOptions = {}) {
  const events: string[] = [];
  let selectedTable: unknown;

  const query = {
    from: vi.fn((table: unknown) => {
      selectedTable = table;
      if (table === memberships) {
        events.push("membership-select");
      } else if (table === organizations) {
        events.push("organization-select");
      } else {
        events.push("other-select");
      }
      return query;
    }),
    limit: vi.fn(() => {
      if (selectedTable === memberships) {
        return Promise.resolve(options.membership ? [options.membership] : []);
      }
      return Promise.resolve(
        options.organization ? [options.organization] : []
      );
    }),
    where: vi.fn(() => query),
  };

  let executeCalls = 0;
  const transaction = {
    execute: vi.fn(async () => {
      // the first statement of a tenant transaction sets the timeouts; the others set contexts
      events.push(
        executeCalls === 0 ? "set-local-guards" : "set-local-context"
      );
      executeCalls += 1;
      await Promise.resolve();
    }),
    select: vi.fn(() => query),
  };

  const database = {
    transaction: vi.fn(
      <T>(
        callback: (transaction: TenantRequestTransaction) => Promise<T>,
        _options?: { isolationLevel?: string }
      ) => {
        executeCalls = 0;
        return callback(transaction as unknown as TenantRequestTransaction);
      }
    ),
  } as unknown as Database;

  return { database, events, transaction };
}

function createInput(
  overrides: Partial<{
    authenticatedUserId: string;
    capability: string;
    requestedOrganizationId: string;
  }> = {}
) {
  return {
    authenticatedUserId: "authenticated-user",
    capability: "catalog:read",
    requestedOrganizationId: "requested-organization",
    ...overrides,
  };
}

describe("withAuthorizedTenantTransaction", () => {
  it("sets the authenticated user before reading membership, then sets organization before tenant work", async () => {
    const fixture = createDatabaseStub({
      membership: { role: "owner", status: "active" },
      organization: { status: "active" },
    });
    const operation = vi.fn(
      async (
        _transaction: TenantRequestTransaction,
        identity: TenantRequestIdentity
      ) => identity
    );

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      )
    ).resolves.toEqual({
      capability: "catalog:read",
      organizationId: "requested-organization",
      role: "owner",
      userId: "authenticated-user",
    });

    expect(fixture.events).toEqual([
      "set-local-guards",
      "set-local-context",
      "membership-select",
      "set-local-context",
      "organization-select",
    ]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("denies a requested organization without the authenticated user's membership before setting organization context", async () => {
    const fixture = createDatabaseStub();
    const operation = vi.fn(async () => undefined);

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      )
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      )
    ).rejects.toMatchObject({ code: "tenant_access_denied" });

    expect(fixture.events).toEqual([
      "set-local-guards",
      "set-local-context",
      "membership-select",
      "set-local-guards",
      "set-local-context",
      "membership-select",
    ]);
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed for unknown roles or capabilities before setting organization context", async () => {
    const fixture = createDatabaseStub({
      membership: { role: "unknown-role", status: "active" },
    });
    const operation = vi.fn(async () => undefined);

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput({ capability: "catalog:read" }),
        operation
      )
    ).rejects.toMatchObject({ code: "capability_denied" });

    expect(fixture.events).toEqual([
      "set-local-guards",
      "set-local-context",
      "membership-select",
    ]);
    expect(operation).not.toHaveBeenCalled();
  });

  it("denies a non-active organization even after membership and capability pass", async () => {
    const fixture = createDatabaseStub({
      membership: { role: "owner", status: "active" },
      organization: { status: "suspended" },
    });
    const operation = vi.fn(async () => undefined);

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      )
    ).rejects.toMatchObject({ code: "tenant_access_denied" });

    expect(fixture.events).toEqual([
      "set-local-guards",
      "set-local-context",
      "membership-select",
      "set-local-context",
      "organization-select",
    ]);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects malformed server identity or requested organization before opening a transaction", async () => {
    const fixture = createDatabaseStub();

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput({ authenticatedUserId: " authenticated-user" }),
        async () => undefined
      )
    ).rejects.toMatchObject({ code: "tenant_access_denied" });

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput({ requestedOrganizationId: " " }),
        async () => undefined
      )
    ).rejects.toMatchObject({ code: "tenant_access_denied" });

    expect(fixture.database.transaction).not.toHaveBeenCalled();
  });

  it("sets the statement, lock and idle timeouts as the first statement of the transaction", async () => {
    const fixture = createDatabaseStub({
      membership: { role: "owner", status: "active" },
      organization: { status: "active" },
    });
    await withAuthorizedTenantTransaction(
      fixture.database,
      createInput(),
      async () => undefined
    );
    const [firstStatement] = fixture.transaction.execute.mock
      .calls as unknown as [[{ queryChunks: unknown[] }]];
    const rendered = JSON.stringify(firstStatement[0].queryChunks);
    expect(rendered).toContain("statement_timeout");
    expect(rendered).toContain("lock_timeout");
    expect(rendered).toContain("idle_in_transaction_session_timeout");
    expect(TENANT_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TENANT_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("uses READ COMMITTED unless a read model asks for REPEATABLE READ", async () => {
    const fixture = createDatabaseStub({
      membership: { role: "owner", status: "active" },
      organization: { status: "active" },
    });
    await withAuthorizedTenantTransaction(
      fixture.database,
      createInput(),
      async () => undefined
    );
    await withAuthorizedTenantTransaction(
      fixture.database,
      { ...createInput(), isolationLevel: "repeatable read" },
      async () => undefined
    );
    expect(fixture.database.transaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      { isolationLevel: "read committed" }
    );
    expect(fixture.database.transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { isolationLevel: "repeatable read" }
    );
  });
});
