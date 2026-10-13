import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import { createRpcRouter } from "./router";

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

const session = { user: { emailVerified: true, id: "session-user-17" } };

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

function createClient(overrides: Record<string, unknown>) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    organization: {
      listMine: (input?: unknown) => Promise<{
        organizations: Array<{
          id: string;
          name: string;
          role: string;
          timezone: string;
        }>;
      }>;
    };
  };
}

function authenticated() {
  return (input: {
    operation: (database: unknown, current: typeof session) => Promise<unknown>;
  }) => input.operation({}, session);
}

describe("organization.listMine", () => {
  it("answers 401 when there is no session", async () => {
    const listUserOrganizations = vi.fn();
    const client = createClient({
      listUserOrganizations,
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });

    await expect(client.organization.listMine()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(listUserOrganizations).not.toHaveBeenCalled();
  });

  it("returns an empty list when the user has no memberships", async () => {
    const client = createClient({
      listUserOrganizations: () => Promise.resolve([]),
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(client.organization.listMine()).resolves.toEqual({
      organizations: [],
    });
  });

  it("lists only what the repository returns for the session user, ignoring the input", async () => {
    const mine = {
      id: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
      name: "Loja Horizonte",
      role: "owner",
      timezone: "America/Sao_Paulo",
    };
    const listUserOrganizations = vi.fn(
      async (_database: unknown, _userId: string) => [mine]
    );
    const client = createClient({
      listUserOrganizations,
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.listMine({
        organizationId: "someone-elses-organization",
        userId: "attacker-controlled-id",
      })
    ).resolves.toEqual({ organizations: [mine] });
    expect(listUserOrganizations).toHaveBeenCalledTimes(1);
    expect(listUserOrganizations.mock.calls[0]?.[1]).toBe(session.user.id);
  });
});
