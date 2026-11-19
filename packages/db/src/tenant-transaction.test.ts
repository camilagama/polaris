import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { createDatabase } from "./client";
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

const dialect = new PgDialect();
const ROLES_ARRAY = /ARRAY\[[^\]]*\]::text\[\]/;

const roleList = vi.hoisted(() => ({
  override: undefined as readonly string[] | undefined,
}));

vi.mock("@polaris/domain/authorization/capabilities", async (original) => {
  const actual =
    await original<
      typeof import("@polaris/domain/authorization/capabilities")
    >();
  return {
    ...actual,
    rolesWithCapability: (capability: string) =>
      roleList.override ?? actual.rolesWithCapability(capability),
  };
});

class FakeDatabaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the entry function answers: a role, or the error it raises. */
type Entry = { role: string } | { error: unknown };

function createDatabaseStub(entry: Entry = { role: "owner" }) {
  const statements: SQL[] = [];
  const transaction = {
    execute: vi.fn(async (statement: SQL) => {
      statements.push(statement);
      await Promise.resolve();
      if ("error" in entry) {
        throw entry.error;
      }
      return { rows: [{ member_role: entry.role }] };
    }),
  };

  const database = {
    transaction: vi.fn(
      <T>(
        callback: (transaction: TenantRequestTransaction) => Promise<T>,
        _options?: { isolationLevel?: string }
      ) => callback(transaction as unknown as TenantRequestTransaction)
    ),
  } as unknown as Database;

  return { database, statements, transaction };
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

function rendered(statement: SQL | undefined) {
  if (!statement) {
    throw new Error("no statement was sent");
  }
  return dialect.sqlToQuery(statement);
}

describe("withAuthorizedTenantTransaction", () => {
  it("enters the tenant with one statement and hands the role the database read to the work", async () => {
    const fixture = createDatabaseStub({ role: "owner" });
    const operation = vi.fn(
      async (
        _transaction: TenantRequestTransaction,
        identity: TenantRequestIdentity
      ) => identity
    );

    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        { ...createInput(), sessionId: "session-1" },
        operation
      )
    ).resolves.toEqual({
      capability: "catalog:read",
      organizationId: "requested-organization",
      role: "owner",
      sessionId: "session-1",
      userId: "authenticated-user",
    });
    expect(fixture.statements).toHaveLength(1);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("passes user, organization, the roles as one text[] and the three timeouts, in that order", async () => {
    const fixture = createDatabaseStub();
    await withAuthorizedTenantTransaction(
      fixture.database,
      createInput({ capability: "sale:create" }),
      async () => undefined
    );
    expect(rendered(fixture.statements[0])).toMatchObject({
      params: [
        "authenticated-user",
        "requested-organization",
        "owner",
        TENANT_STATEMENT_TIMEOUT_MS,
        TENANT_LOCK_TIMEOUT_MS,
        TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      ],
      sql: "SELECT member_role FROM public.begin_tenant_request($1, $2, ARRAY[$3]::text[], $4::integer, $5::integer, $6::integer)",
    });
    expect(TENANT_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TENANT_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("builds the array of roles element by element: one role, several roles and none", async () => {
    const fixture = createDatabaseStub();
    try {
      const shapes: string[] = [];
      for (const list of [["owner"], ["owner", "manager"], []]) {
        roleList.override = list;
        // biome-ignore lint/performance/noAwaitInLoops: one transaction at a time, so each statement is the one of its list
        await withAuthorizedTenantTransaction(
          fixture.database,
          createInput(),
          async () => undefined
        );
        const query = rendered(fixture.statements.at(-1));
        shapes.push(ROLES_ARRAY.exec(query.sql)?.[0] ?? query.sql);
        expect(query.params.slice(2, 2 + list.length)).toEqual(list);
      }
      expect(shapes).toEqual([
        "ARRAY[$3]::text[]",
        "ARRAY[$3, $4]::text[]",
        "ARRAY[]::text[]",
      ]);
    } finally {
      roleList.override = undefined;
    }
  });

  it("sends no role for an unknown or inherited capability, so the database refuses it", async () => {
    const fixture = createDatabaseStub();
    for (const capability of ["unknown:read", "__proto__"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one transaction at a time, so each statement is the one of its capability
      await withAuthorizedTenantTransaction(
        fixture.database,
        createInput({ capability }),
        async () => undefined
      );
      expect(rendered(fixture.statements.at(-1)).sql).toContain(
        "ARRAY[]::text[]"
      );
    }
  });

  it.each([
    "tenant_access_denied",
    "capability_denied",
    "organization_closed",
  ] as const)(
    "turns the database refusal %s into the same TenantAuthorizationError code and runs nothing",
    async (code) => {
      const fixture = createDatabaseStub({
        error: new Error("Failed query", {
          cause: new FakeDatabaseError("42501", code),
        }),
      });
      const operation = vi.fn(async () => undefined);
      const outcome = withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      );
      await expect(outcome).rejects.toBeInstanceOf(TenantAuthorizationError);
      await expect(outcome).rejects.toMatchObject({ code });
      expect(operation).not.toHaveBeenCalled();
    }
  );

  it("lets any other database error through untouched: a missing grant is not a polite refusal", async () => {
    for (const error of [
      new FakeDatabaseError(
        "42501",
        "permission denied for function begin_tenant_request"
      ),
      new FakeDatabaseError("22023", "tenant_access_denied"),
      new FakeDatabaseError("22023", "invalid_tenant_timeout"),
      new FakeDatabaseError("08006", "connection failure"),
    ]) {
      const fixture = createDatabaseStub({ error });
      const operation = vi.fn(async () => undefined);
      // biome-ignore lint/performance/noAwaitInLoops: one transaction at a time
      await expect(
        withAuthorizedTenantTransaction(
          fixture.database,
          createInput(),
          operation
        )
      ).rejects.toBe(error);
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("refuses rather than runs the work when the entry answers no row", async () => {
    const fixture = createDatabaseStub();
    fixture.transaction.execute.mockResolvedValueOnce({ rows: [] });
    const operation = vi.fn(async () => undefined);
    await expect(
      withAuthorizedTenantTransaction(
        fixture.database,
        createInput(),
        operation
      )
    ).rejects.toThrow("begin_tenant_request_without_role");
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

  it("uses READ COMMITTED unless a read model asks for REPEATABLE READ", async () => {
    const fixture = createDatabaseStub();
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
