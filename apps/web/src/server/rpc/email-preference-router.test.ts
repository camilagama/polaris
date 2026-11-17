import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ActivationPreference } from "@polaris/db/activation-preference";
import {
  ACTIVATION_PREFERENCE_STATEMENT,
  ACTIVATION_SET_TIPS_STATEMENT,
} from "@polaris/db/activation-preference";
import { renderActivationStatement } from "@polaris/db/activation-preference-testing";
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

function createClient(
  overrides: Record<string, unknown>,
  bindings: WorkerBindings = testBindings
) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, bindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as PreferenceClient;
}

/**
 * The database in memory: one row of preference per person, as the functions of the migration keep it. It is the
 * transaction the tenant context hands to the handler, so what it receives is the statement the handler really ran.
 */
function fakeDatabase() {
  const people = new Map<string, ActivationPreference>();
  const statements: { params: unknown[]; sql: string }[] = [];
  const stateOf = (userId: string) =>
    people.get(userId) ?? { sent: 0, tips: true };
  const transaction = {
    execute(query: Parameters<typeof renderActivationStatement>[0]) {
      const { params, sql } = renderActivationStatement(query);
      statements.push({ params, sql });
      const [userId, on] = params as [string, boolean | undefined];
      if (sql === ACTIVATION_SET_TIPS_STATEMENT) {
        people.set(userId, { ...stateOf(userId), tips: on === true });
      }
      return Promise.resolve({ rows: [{ preference: stateOf(userId) }] });
    },
  };
  return {
    seed(userId: string, state: ActivationPreference) {
      people.set(userId, state);
    },
    statements,
    transaction,
  };
}

function tenantOf(
  userId: string,
  database: ReturnType<typeof fakeDatabase>,
  seen: string[] = []
) {
  return (input: TenantRequestContextInput<unknown>) => {
    seen.push(input.capability);
    return input.operation(database.transaction as never, {
      capability: input.capability,
      organizationId: input.requestedOrganizationId,
      role: "owner",
      userId,
    });
  };
}

describe("account.emailPreference and account.setTips", () => {
  it("run under organization:export and call the database as the person of the session", async () => {
    const seen: string[] = [];
    const database = fakeDatabase();
    database.seed("session-user-17", { sent: 2, tips: false });
    const client = createClient({
      withTenantRequestContext: tenantOf("session-user-17", database, seen),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).resolves.toEqual({ sent: 2, tips: false });
    await expect(
      client.account.setTips({ on: true, organizationId })
    ).resolves.toEqual({ sent: 2, tips: true });
    expect(seen).toEqual(["organization:export", "organization:export"]);
    expect(database.statements).toEqual([
      { params: ["session-user-17"], sql: ACTIVATION_PREFERENCE_STATEMENT },
      { params: ["session-user-17", true], sql: ACTIVATION_SET_TIPS_STATEMENT },
    ]);
  });

  it("opens no connection of its own: the two functions run in the transaction of the tenant context", async () => {
    const database = fakeDatabase();
    const connectionStringReads: string[] = [];
    const watched = (name: "HYPERDRIVE" | "ONBOARDING_HYPERDRIVE") => ({
      get connectionString(): string {
        connectionStringReads.push(name);
        return testBindings[name].connectionString;
      },
    });
    const bindings = {
      ...testBindings,
      HYPERDRIVE: watched("HYPERDRIVE"),
      ONBOARDING_HYPERDRIVE: watched("ONBOARDING_HYPERDRIVE"),
    } as WorkerBindings;
    const client = createClient(
      { withTenantRequestContext: tenantOf("conta-a", database) },
      bindings
    );
    await client.account.emailPreference({ organizationId });
    await client.account.setTips({ on: false, organizationId });
    await client.account.setTips({ on: false, organizationId });
    expect(database.statements).toHaveLength(3);
    expect(connectionStringReads).toEqual([]);
  });

  it("hands over the switch it was given and answers the state the database reports", async () => {
    const database = fakeDatabase();
    const client = createClient({
      withTenantRequestContext: tenantOf("conta-a", database),
    });
    const first = await client.account.setTips({ on: false, organizationId });
    const second = await client.account.setTips({ on: false, organizationId });
    expect(first).toEqual({ sent: 0, tips: false });
    expect(second).toEqual(first);
    expect(database.statements.map((statement) => statement.params)).toEqual([
      ["conta-a", false],
      ["conta-a", false],
    ]);
  });

  it("keeps two accounts apart: what A reads and writes never reaches B (AC-8b.6a)", async () => {
    const database = fakeDatabase();
    database.seed("conta-a", { sent: 3, tips: true });
    database.seed("conta-b", { sent: 1, tips: true });
    const as = (userId: string) =>
      createClient({
        withTenantRequestContext: tenantOf(userId, database),
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
    expect(
      new Set(database.statements.map((statement) => statement.params[0]))
    ).toEqual(new Set(["conta-a", "conta-b"]));
  });

  it("never takes the person from the input: a user field is refused and nothing reaches the database", async () => {
    const database = fakeDatabase();
    const client = createClient({
      withTenantRequestContext: tenantOf("conta-a", database),
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
    expect(database.statements).toEqual([]);
  });

  it("answers 403 to who lacks the capability and never reaches the database", async () => {
    const readActivationPreference = vi.fn();
    const setActivationTips = vi.fn();
    const client = createClient({
      readActivationPreference,
      setActivationTips,
      withTenantRequestContext: () =>
        Promise.reject(new TenantAuthorizationError("capability_denied")),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client.account.setTips({ on: false, organizationId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readActivationPreference).not.toHaveBeenCalled();
    expect(setActivationTips).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    const readActivationPreference = vi.fn();
    const client = createClient({
      readActivationPreference,
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(readActivationPreference).not.toHaveBeenCalled();
  });

  it("lets the error of the database leave as an error of the server, so the screen says it could not save", async () => {
    const client = createClient({
      setActivationTips: () =>
        Promise.reject(new Error("connection terminated")),
      withTenantRequestContext: tenantOf("conta-a", fakeDatabase()),
    });
    await expect(
      client.account.setTips({ on: false, organizationId })
    ).rejects.toMatchObject({
      code: expect.stringMatching(SERVER_FAULT),
    });
  });

  it("refuses an answer that is not the two fields of the preference", async () => {
    const client = createClient({
      withTenantRequestContext: (input: TenantRequestContextInput<unknown>) =>
        input.operation(
          {
            execute: () => Promise.resolve({ rows: [{ preference: null }] }),
          } as never,
          {
            capability: input.capability,
            organizationId: input.requestedOrganizationId,
            role: "owner",
            userId: "conta-a",
          }
        ),
    });
    await expect(
      client.account.emailPreference({ organizationId })
    ).rejects.toMatchObject({ code: expect.stringMatching(SERVER_FAULT) });
  });
});
