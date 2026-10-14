import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    category: {
      create: (input: unknown) => Promise<{
        id: string;
        organizationId: string;
        name: string;
      }>;
      list: (input: unknown) => Promise<{
        categories: Array<{
          id: string;
          organizationId: string;
          name: string;
        }>;
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
        id: "4e7d8c0e-ea70-4ec4-a610-75818d4ab927",
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
      id: "4e7d8c0e-ea70-4ec4-a610-75818d4ab927",
      name: "Escritório",
      organizationId,
    });
    expect(observedCapability).toBe("category:create");
    expect(createCategory).toHaveBeenCalledWith({}, identity, {
      name: "Escritório",
      requestId: expect.stringMatching(requestIdPattern),
    });
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
});
