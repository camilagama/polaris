import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  AnotherOrganizationActiveError,
  ClosureConfirmationError,
  ClosureNotRecoverableError,
  OrganizationNotActiveError,
} from "@polaris/domain/organization/closure";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const recoverUntil = new Date("2026-11-16T12:00:00.000Z");
const session = { user: { emailVerified: true, id: "session-user-17" } };

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

function createClient(overrides: Record<string, unknown>) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    organization: {
      listClosing: () => Promise<{
        organizations: Array<{
          id: string;
          name: string;
          recoverUntil: string;
        }>;
      }>;
      recoverClosure: (input: unknown) => Promise<{ recovered: true }>;
      listClosed: () => Promise<{ organizations: unknown[] }>;
      closedStatus: (input: unknown) => Promise<{ organization: unknown }>;
      requestClosure: (
        input: unknown
      ) => Promise<{ recoverUntil: string; revokedLeases: number }>;
    };
  };
}

function authenticated() {
  return (input: {
    operation: (database: unknown, current: typeof session) => Promise<unknown>;
  }) => input.operation({}, session);
}

function tenant(capabilities: { seen?: string[] } = {}) {
  return (input: TenantRequestContextInput<unknown>) => {
    capabilities.seen?.push(input.capability);
    return input.operation({} as never, {
      capability: input.capability,
      organizationId: input.requestedOrganizationId,
      role: "owner",
      userId: session.user.id,
    });
  };
}

describe("organization.requestClosure", () => {
  it("runs in the organization's tenant context with its own capability and hands over only the typed name", async () => {
    const seen: string[] = [];
    const requestOrganizationClosure = vi.fn(() =>
      Promise.resolve({ recoverUntil, revokedLeases: 3 })
    );
    const client = createClient({
      closureRepository: { requestOrganizationClosure },
      withTenantRequestContext: tenant({ seen }),
    });

    await expect(
      client.organization.requestClosure({
        confirmation: "Loja Horizonte",
        organizationId,
      })
    ).resolves.toEqual({
      recoverUntil: recoverUntil.toISOString(),
      revokedLeases: 3,
    });
    expect(seen).toEqual(["organization:close"]);
    expect(requestOrganizationClosure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId }),
      { confirmation: "Loja Horizonte" }
    );
  });

  it("answers 401 without a session and does nothing", async () => {
    const requestOrganizationClosure = vi.fn();
    const client = createClient({
      closureRepository: { requestOrganizationClosure },
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });

    await expect(
      client.organization.requestClosure({
        confirmation: "Loja",
        organizationId,
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requestOrganizationClosure).not.toHaveBeenCalled();
  });

  it("refuses a wrong confirmation as a bad request", async () => {
    const client = createClient({
      closureRepository: {
        requestOrganizationClosure: () =>
          Promise.reject(new ClosureConfirmationError()),
      },
      withTenantRequestContext: tenant(),
    });

    await expect(
      client.organization.requestClosure({
        confirmation: "outra loja",
        organizationId,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "closure_confirmation_mismatch" },
    });
  });

  it("answers a conflict for an organization that is not active", async () => {
    const client = createClient({
      closureRepository: {
        requestOrganizationClosure: () =>
          Promise.reject(new OrganizationNotActiveError()),
      },
      withTenantRequestContext: tenant(),
    });

    await expect(
      client.organization.requestClosure({
        confirmation: "Loja",
        organizationId,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an empty confirmation before it reaches the repository", async () => {
    const requestOrganizationClosure = vi.fn();
    const client = createClient({
      closureRepository: { requestOrganizationClosure },
      withTenantRequestContext: tenant(),
    });

    await expect(
      client.organization.requestClosure({ confirmation: "", organizationId })
    ).rejects.toBeDefined();
    expect(requestOrganizationClosure).not.toHaveBeenCalled();
  });
});

describe("organization.listClosing", () => {
  it("lists the session user's own closing organizations, ignoring any input", async () => {
    const listOrganizationsInClosure = vi.fn(
      async (_database: unknown, _userId: string) => [
        { id: organizationId, name: "Loja Horizonte", recoverUntil },
      ]
    );
    const client = createClient({
      closureRepository: { listOrganizationsInClosure },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(client.organization.listClosing()).resolves.toEqual({
      organizations: [
        {
          id: organizationId,
          name: "Loja Horizonte",
          recoverUntil: recoverUntil.toISOString(),
        },
      ],
    });
    expect(listOrganizationsInClosure.mock.calls[0]?.[1]).toBe(session.user.id);
  });

  it("answers 401 without a session", async () => {
    const client = createClient({
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });

    await expect(client.organization.listClosing()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("organization.recoverClosure", () => {
  it("recovers for the session user, never for a user named by the client", async () => {
    const recoverOrganizationClosure = vi.fn(
      async (_database: unknown, _userId: string, _organizationId: string) =>
        undefined
    );
    const client = createClient({
      closureRepository: { recoverOrganizationClosure },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.recoverClosure({
        organizationId,
        userId: "attacker-controlled-id",
      })
    ).resolves.toEqual({ recovered: true });
    expect(recoverOrganizationClosure).toHaveBeenCalledWith(
      expect.anything(),
      session.user.id,
      organizationId
    );
  });

  it("answers a conflict when the window is over or it is not the owner's to undo", async () => {
    const client = createClient({
      closureRepository: {
        recoverOrganizationClosure: () =>
          Promise.reject(new ClosureNotRecoverableError()),
      },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.recoverClosure({ organizationId })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

const closedView = {
  canRecover: true,
  deletableFrom: new Date("2027-01-15T03:00:00.000Z"),
  deletionDate: "2027-01-15",
  exportOpenUntil: new Date("2027-01-15T03:00:00.000Z"),
  id: organizationId,
  milestones: {
    closure: new Date("2026-10-16T12:00:00.000Z"),
    d7: new Date("2027-01-08T03:00:00.000Z"),
    d30: new Date("2026-12-16T03:00:00.000Z"),
    deletionDay: new Date("2027-01-15T03:00:00.000Z"),
  },
  name: "Loja Horizonte",
  phase: "closed" as const,
  recoverUntil,
  requestedAt: new Date("2026-10-16T12:00:00.000Z"),
  timezone: "America/Sao_Paulo",
};

const closedReadModel = {
  canRecover: true,
  deletableFrom: "2027-01-15T03:00:00.000Z",
  deletionDate: "2027-01-15",
  exportOpenUntil: "2027-01-15T03:00:00.000Z",
  id: organizationId,
  milestones: {
    closure: "2026-10-16T12:00:00.000Z",
    d7: "2027-01-08T03:00:00.000Z",
    d30: "2026-12-16T03:00:00.000Z",
    deletionDay: "2027-01-15T03:00:00.000Z",
  },
  name: "Loja Horizonte",
  phase: "closed",
  recoverUntil: "2026-11-16T12:00:00.000Z",
  // the test bindings have no billing role: nothing Polaris could cancel
  renewal: "not_handled",
  requestedAt: "2026-10-16T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};

describe("organization.listClosed", () => {
  it("lists the session user's closed organizations with dates as ISO text and D as a calendar date", async () => {
    const listClosedOrganizations = vi.fn(
      async (_database: unknown, _userId: string) => [closedView]
    );
    const client = createClient({
      closureRepository: { listClosedOrganizations },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(client.organization.listClosed()).resolves.toEqual({
      organizations: [closedReadModel],
    });
    expect(listClosedOrganizations.mock.calls[0]?.[1]).toBe(session.user.id);
  });

  it("says each organization's renewal, as the server derived it", async () => {
    const other = { ...closedView, id: "8c0d323b-0a1c-4f16-8f1a-1d1fc2d0d0c1" };
    const client = createClient({
      closureRepository: {
        listClosedOrganizations: () => Promise.resolve([closedView, other]),
      },
      readRenewalStatuses: (_bindings: unknown, ids: readonly string[]) =>
        Promise.resolve(
          new Map([
            [ids[0], "cancelled"],
            [ids[1], "pending"],
          ])
        ),
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(client.organization.listClosed()).resolves.toEqual({
      organizations: [
        { ...closedReadModel, renewal: "cancelled" },
        { ...closedReadModel, id: other.id, renewal: "pending" },
      ],
    });
  });

  it("answers 401 without a session", async () => {
    const client = createClient({
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });

    await expect(client.organization.listClosed()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("organization.closedStatus", () => {
  it("reads one closed organization for the session user", async () => {
    const getClosedOrganizationStatus = vi.fn(
      async (_database: unknown, _userId: string, _organizationId: string) =>
        closedView
    );
    const client = createClient({
      closureRepository: { getClosedOrganizationStatus },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.closedStatus({ organizationId })
    ).resolves.toEqual({ organization: closedReadModel });
    expect(getClosedOrganizationStatus).toHaveBeenCalledWith(
      expect.anything(),
      session.user.id,
      organizationId
    );
  });

  it("says the renewal the server derived from the billing record, read only after the ownership check", async () => {
    const order: string[] = [];
    const getClosedOrganizationStatus = vi.fn(() => {
      order.push("status");
      return Promise.resolve(closedView);
    });
    const readRenewalStatuses = vi.fn(
      (_bindings: unknown, ids: readonly string[]) => {
        order.push("renewal");
        return Promise.resolve(
          new Map(ids.map((id) => [id, "pending" as const]))
        );
      }
    );
    const client = createClient({
      closureRepository: { getClosedOrganizationStatus },
      readRenewalStatuses,
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.closedStatus({ organizationId })
    ).resolves.toEqual({
      organization: { ...closedReadModel, renewal: "pending" },
    });
    expect(order).toEqual(["status", "renewal"]);
    expect(readRenewalStatuses.mock.calls[0]?.[1]).toEqual([organizationId]);
  });

  it("does not read billing for an organization that is not the user's", async () => {
    const readRenewalStatuses = vi.fn();
    const client = createClient({
      closureRepository: {
        getClosedOrganizationStatus: () => Promise.resolve(null),
      },
      readRenewalStatuses,
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.closedStatus({ organizationId })
    ).resolves.toEqual({ organization: null });
    expect(readRenewalStatuses).not.toHaveBeenCalled();
  });

  it("fails instead of guessing when the billing record cannot be read", async () => {
    const client = createClient({
      closureRepository: {
        getClosedOrganizationStatus: () => Promise.resolve(closedView),
      },
      readRenewalStatuses: () => Promise.reject(new Error("billing_down")),
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.closedStatus({ organizationId })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("answers a null organization when the repository finds none", async () => {
    const client = createClient({
      closureRepository: {
        getClosedOrganizationStatus: () => Promise.resolve(null),
      },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.closedStatus({ organizationId })
    ).resolves.toEqual({ organization: null });
  });
});

describe("organization.recoverClosure with another organization active", () => {
  it("answers a conflict with its reason", async () => {
    const client = createClient({
      closureRepository: {
        recoverOrganizationClosure: () =>
          Promise.reject(new AnotherOrganizationActiveError()),
      },
      withAuthenticatedRequestContext: authenticated(),
    });

    await expect(
      client.organization.recoverClosure({ organizationId })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "another_organization_active" },
    });
  });
});
