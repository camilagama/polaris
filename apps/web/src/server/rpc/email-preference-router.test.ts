import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  ActivationPreference,
  ActivationPreferenceClient,
} from "@polaris/db/activation-preference";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "org_7b9c212a";
const SERVER_FAULT = /^(INTERNAL|SERVICE)/;

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface PreferenceClient {
  account: {
    emailPreference: (input: unknown) => Promise<ActivationPreference>;
    setTips: (input: unknown) => Promise<ActivationPreference>;
  };
}

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
  return createORPCClient(link) as unknown as PreferenceClient;
}

function tenantOf(userId: string, seen: string[] = []) {
  return (input: TenantRequestContextInput<unknown>) => {
    seen.push(input.capability);
    return input.operation({} as never, {
      capability: input.capability,
      organizationId: input.requestedOrganizationId,
      role: "owner",
      userId,
    });
  };
}

/** The database in memory: one row of preference per person, as the functions of the migration keep it. */
function fakeDatabase() {
  const people = new Map<string, ActivationPreference>();
  const calls: { connectionString: string; userId: string }[] = [];
  let closed = 0;
  const stateOf = (userId: string) =>
    people.get(userId) ?? { sent: 0, tips: true };
  return {
    calls,
    closedCount: () => closed,
    createPreferenceClient(
      connectionString: string
    ): ActivationPreferenceClient {
      return {
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
        read: (userId) => {
          calls.push({ connectionString, userId });
          return Promise.resolve(stateOf(userId));
        },
        setTips: (userId, on) => {
          calls.push({ connectionString, userId });
          const next = { ...stateOf(userId), tips: on };
          people.set(userId, next);
          return Promise.resolve(next);
        },
      };
    },
    seed(userId: string, state: ActivationPreference) {
      people.set(userId, state);
    },
  };
}

describe("account.emailPreference and account.setTips", () => {
  it("run under organization:export and call the database as the person of the session", async () => {
    const seen: string[] = [];
    const database = fakeDatabase();
    database.seed("session-user-17", { sent: 2, tips: false });
    const client = createClient({
      createPreferenceClient: database.createPreferenceClient,
      withTenantRequestContext: tenantOf("session-user-17", seen),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).resolves.toEqual({ sent: 2, tips: false });
    await expect(
      client.account.setTips({ on: true, organizationId })
    ).resolves.toEqual({ sent: 2, tips: true });
    expect(seen).toEqual(["organization:export", "organization:export"]);
    expect(database.calls).toEqual([
      {
        connectionString: testBindings.HYPERDRIVE.connectionString,
        userId: "session-user-17",
      },
      {
        connectionString: testBindings.HYPERDRIVE.connectionString,
        userId: "session-user-17",
      },
    ]);
    expect(database.closedCount()).toBe(2);
  });

  it("keeps two accounts apart: what A reads and writes never reaches B (AC-8b.6a)", async () => {
    const database = fakeDatabase();
    database.seed("conta-a", { sent: 3, tips: true });
    database.seed("conta-b", { sent: 1, tips: true });
    const as = (userId: string) =>
      createClient({
        createPreferenceClient: database.createPreferenceClient,
        withTenantRequestContext: tenantOf(userId),
      });
    const a = as("conta-a");
    const b = as("conta-b");

    await a.account.setTips({ on: false, organizationId });
    await expect(
      b.account.emailPreference({ organizationId })
    ).resolves.toEqual({ sent: 1, tips: true });
    await expect(
      a.account.emailPreference({ organizationId })
    ).resolves.toEqual({ sent: 3, tips: false });
    await b.account.setTips({ on: false, organizationId });
    await a.account.setTips({ on: true, organizationId });
    await expect(
      b.account.emailPreference({ organizationId })
    ).resolves.toEqual({ sent: 1, tips: false });
    expect(new Set(database.calls.map((call) => call.userId))).toEqual(
      new Set(["conta-a", "conta-b"])
    );
  });

  it("never takes the person from the input: a user field is refused and nothing reaches the database", async () => {
    const database = fakeDatabase();
    const client = createClient({
      createPreferenceClient: database.createPreferenceClient,
      withTenantRequestContext: tenantOf("conta-a"),
    });
    await expect(
      client.account.emailPreference({ organizationId, userId: "conta-b" })
    ).rejects.toBeDefined();
    await expect(
      client.account.setTips({ on: false, organizationId, userId: "conta-b" })
    ).rejects.toBeDefined();
    await expect(
      client.account.setTips({ on: "no", organizationId })
    ).rejects.toBeDefined();
    expect(database.calls).toEqual([]);
  });

  it("answers 403 to who lacks the capability and never opens the database connection", async () => {
    const createPreferenceClient = vi.fn();
    const client = createClient({
      createPreferenceClient,
      withTenantRequestContext: () =>
        Promise.reject(new TenantAuthorizationError("capability_denied")),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client.account.setTips({ on: false, organizationId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(createPreferenceClient).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    const createPreferenceClient = vi.fn();
    const client = createClient({
      createPreferenceClient,
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createPreferenceClient).not.toHaveBeenCalled();
  });

  it("closes the connection when the database fails, and the error leaves as an error of the server", async () => {
    let closed = 0;
    const client = createClient({
      createPreferenceClient: () => ({
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
        read: () => Promise.reject(new Error("connection terminated")),
        setTips: () => Promise.reject(new Error("connection terminated")),
      }),
      withTenantRequestContext: tenantOf("conta-a"),
    });
    await expect(
      client.account.setTips({ on: false, organizationId })
    ).rejects.toMatchObject({
      code: expect.stringMatching(SERVER_FAULT),
    });
    expect(closed).toBe(1);
  });
});
