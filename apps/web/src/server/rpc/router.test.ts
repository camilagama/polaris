import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { CategoryNameConflictError } from "@polaris/domain/catalog/category";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import { CreateInitialOrganizationError } from "../use-cases/create-initial-organization";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    category: {
      archive: (input: unknown) => Promise<{
        category: CategoryReadModelForTest;
        changed: boolean;
      }>;
      create: (input: unknown) => Promise<CategoryReadModelForTest>;
      delete: (input: unknown) => Promise<{
        category: CategoryReadModelForTest;
        changed: boolean;
      }>;
      list: (input: unknown) => Promise<{
        categories: CategoryReadModelForTest[];
      }>;
      rename: (input: unknown) => Promise<{
        category: CategoryReadModelForTest;
        changed: boolean;
      }>;
      restore: (input: unknown) => Promise<{
        category: CategoryReadModelForTest;
        changed: boolean;
      }>;
    };
    organization: {
      createInitial: (input: unknown) => Promise<{
        created: boolean;
        organization: {
          id: string;
          name: string;
          timezone: string;
          currency: string;
          status: string;
        };
      }>;
    };
  };
}

interface CategoryReadModelForTest {
  archivedAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  id: string;
  name: string;
  organizationId: string;
  status: "active" | "archived" | "deleted";
  updatedAt: string;
}

const categoryRow = {
  archivedAt: null,
  createdAt: new Date("2026-10-08T12:00:00.000Z"),
  deletedAt: null,
  id: "4e7d8c0e-ea70-4ec4-a610-75818d4ab927",
  name: "Escritório",
  organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
  updatedAt: new Date("2026-10-08T12:00:00.000Z"),
};

describe("tenant RPCs", () => {
  it("rejects category reads when there is no Better Auth session", async () => {
    const rpcRouter = createRpcRouter({
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    const client = createRpcClient(rpcRouter);

    await expect(
      client.category.list({ organizationId: "org-requested" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates a category using the requested organization and category capability", async () => {
    const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
    const identity = {
      capability: "category:create",
      organizationId,
      role: "owner",
      userId: "verified-session-user",
    };
    let observedCapability = "";
    const createCategory = vi.fn(
      async (
        _transaction: unknown,
        authorizedIdentity: typeof identity,
        input: { name: string }
      ) => ({
        ...categoryRow,
        name: input.name,
        organizationId: authorizedIdentity.organizationId,
      })
    );
    const routerDependencies = {
      createCategory,
      withTenantRequestContext: (input: {
        capability: string;
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
        requestedOrganizationId: string;
      }) => {
        observedCapability = input.capability;
        return input.operation({}, identity);
      },
    };
    const rpcRouter = createRpcRouter(
      routerDependencies as unknown as Parameters<typeof createRpcRouter>[0]
    );
    const client = createRpcClient(rpcRouter);

    await expect(
      client.category.create({ name: "  Escritório  ", organizationId })
    ).resolves.toEqual({
      archivedAt: null,
      createdAt: "2026-10-08T12:00:00.000Z",
      deletedAt: null,
      id: "4e7d8c0e-ea70-4ec4-a610-75818d4ab927",
      name: "Escritório",
      organizationId,
      status: "active",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    expect(observedCapability).toBe("category:create");
    expect(createCategory).toHaveBeenCalledWith({}, identity, {
      name: "Escritório",
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("counts category name limits in Unicode code points at the RPC boundary", async () => {
    const emojiName = "😀".repeat(100);
    const identity = {
      capability: "category:create",
      organizationId: categoryRow.organizationId,
      role: "owner",
      userId: "verified-session-user",
    };
    const createCategory = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        input: { name: string }
      ) => ({ ...categoryRow, name: input.name })
    );
    const rpcRouter = createRpcRouter({
      createCategory,
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => input.operation({}, identity),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(rpcRouter);

    await expect(
      client.category.create({
        name: emojiName,
        organizationId: categoryRow.organizationId,
      })
    ).resolves.toMatchObject({ name: emojiName });
    await expect(
      client.category.create({
        name: `${emojiName}😀`,
        organizationId: categoryRow.organizationId,
      })
    ).rejects.toBeDefined();
    expect(createCategory).toHaveBeenCalledTimes(1);
  });

  it("maps duplicate normalized category names to a conflict", async () => {
    const identity = {
      capability: "category:create",
      organizationId: categoryRow.organizationId,
      role: "owner",
      userId: "verified-session-user",
    };
    const router = createRpcRouter({
      createCategory: vi.fn(() =>
        Promise.reject(new CategoryNameConflictError())
      ),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => input.operation({}, identity),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.category.create({
        name: "escritório",
        organizationId: categoryRow.organizationId,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  for (const action of ["archive", "restore", "delete", "rename"] as const) {
    it(`requires the category management capability to ${action} a category`, async () => {
      const repositoryName = {
        archive: "archiveCategory",
        delete: "deleteCategory",
        rename: "renameCategory",
        restore: "restoreCategory",
      }[action];
      const lifecycleOperation = vi.fn(async () => ({
        category: categoryRow,
        changed: true,
      }));
      const identity = {
        capability: "category:manage",
        organizationId: categoryRow.organizationId,
        role: "owner",
        userId: "verified-session-user",
      };
      let observedCapability = "";
      const router = createRpcRouter({
        [repositoryName]: lifecycleOperation,
        withTenantRequestContext: (input: {
          capability: string;
          operation: (
            transaction: unknown,
            authorizedIdentity: typeof identity
          ) => Promise<unknown>;
        }) => {
          observedCapability = input.capability;
          return input.operation({}, identity);
        },
      } as unknown as Parameters<typeof createRpcRouter>[0]);
      const client = createRpcClient(router);

      await client.category[action]({
        id: categoryRow.id,
        name: categoryRow.name,
        organizationId: categoryRow.organizationId,
      });

      expect(observedCapability).toBe("category:manage");
      expect(lifecycleOperation).toHaveBeenCalledOnce();
    });
  }

  it("serializes lifecycle timestamps for a read-only offline contract", async () => {
    const archivedAt = new Date("2026-10-08T13:30:00.000Z");
    let observedStatus = "";
    const identity = {
      capability: "catalog:read",
      organizationId: categoryRow.organizationId,
      role: "owner",
      userId: "verified-session-user",
    };
    const listCategories = vi.fn(
      (
        _transaction: unknown,
        _identity: typeof identity,
        options?: { status?: string }
      ) => {
        observedStatus = options?.status ?? "active";
        return [{ ...categoryRow, archivedAt }];
      }
    );
    const router = createRpcRouter({
      listCategories,
      withTenantRequestContext: (input: {
        capability: string;
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => input.operation({}, identity),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.category.list({
        organizationId: categoryRow.organizationId,
        status: "archived",
      })
    ).resolves.toEqual({
      categories: [
        {
          archivedAt: archivedAt.toISOString(),
          createdAt: categoryRow.createdAt.toISOString(),
          deletedAt: null,
          id: categoryRow.id,
          name: categoryRow.name,
          organizationId: categoryRow.organizationId,
          status: "archived",
          updatedAt: categoryRow.updatedAt.toISOString(),
        },
      ],
    });
    expect(listCategories).toHaveBeenCalledWith({}, identity, {
      status: "archived",
    });
    expect(observedStatus).toBe("archived");
  });

  it("uses the Better Auth session user for initial organization creation", async () => {
    const session = { user: { emailVerified: true, id: "session-user-17" } };
    const createInitialOrganization = vi.fn(
      async (
        _database: unknown,
        input: {
          authenticatedUserId: string;
          name: string;
          timezone: string;
        }
      ) => ({
        created: true,
        organization: {
          currency: "BRL",
          id: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
          name: input.name,
          status: "active",
          timezone: input.timezone,
        },
      })
    );
    const createOnboardingDatabase = vi.fn(() => ({
      db: {},
      pool: { end: () => Promise.resolve() },
    }));
    const routerDependencies = {
      createInitialOrganization,
      createOnboardingDatabase,
      withAuthenticatedRequestContext: async (input: {
        operation: (
          database: unknown,
          authenticatedSession: typeof session
        ) => Promise<unknown>;
      }) => input.operation({}, session),
    };
    const rpcRouter = createRpcRouter(
      routerDependencies as unknown as Parameters<typeof createRpcRouter>[0]
    );
    const client = createRpcClient(rpcRouter);

    await expect(
      client.organization.createInitial({
        authenticatedUserId: "attacker-controlled-id",
        name: "Polaris",
        timezone: "America/Sao_Paulo",
      })
    ).resolves.toMatchObject({
      created: true,
      organization: { name: "Polaris" },
    });
    expect(createInitialOrganization).toHaveBeenCalledWith(expect.anything(), {
      authenticatedUserId: session.user.id,
      name: "Polaris",
      requestId: expect.any(String),
      timezone: "America/Sao_Paulo",
    });
    expect(createOnboardingDatabase).toHaveBeenCalledWith(
      testBindings.ONBOARDING_HYPERDRIVE.connectionString,
      { maxConnections: 1 }
    );
  });

  it("tells a member of a closed organization so, with the reason", async () => {
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () =>
          Promise.reject(new TenantAuthorizationError("organization_closed")),
      })
    );

    await expect(
      client.category.list({ organizationId: "org-requested" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "organization_closed" },
    });
  });

  it("keeps every other authorization refusal without a reason", async () => {
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () =>
          Promise.reject(new TenantAuthorizationError("tenant_access_denied")),
      })
    );

    const error = await client.category
      .list({ organizationId: "org-requested" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "FORBIDDEN" });
    expect((error as { data?: unknown }).data).toBeUndefined();
  });

  it("answers a conflict with the reason when the organization ceiling is reached", async () => {
    const session = { user: { emailVerified: true, id: "session-user-17" } };
    const client = createRpcClient(
      createRpcRouter({
        createInitialOrganization: () =>
          Promise.reject(
            new CreateInitialOrganizationError("organization_limit_reached")
          ),
        createOnboardingDatabase: () => ({
          db: {},
          pool: { end: () => Promise.resolve() },
        }),
        withAuthenticatedRequestContext: (input: {
          operation: (database: unknown, current: typeof session) => unknown;
        }) => Promise.resolve(input.operation({}, session)),
      } as unknown as Parameters<typeof createRpcRouter>[0])
    );

    await expect(
      client.organization.createInitial({
        name: "Polaris",
        timezone: "America/Sao_Paulo",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "organization_limit_reached" },
    });
  });
});
