import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import {
  InvalidSupportRequestError,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";
import type { SupportDependencies } from "./support-routes";

const bindings: AdminBindings = {
  ACCESS_AUDIENCE: "a".repeat(64),
  ACCESS_TEAM_DOMAIN: "polaris.cloudflareaccess.com",
  ADMIN_HYPERDRIVE: { connectionString: "postgresql://admin.invalid/db" },
};
const principal = {
  emailSnapshot: null,
  id: "0199a0a0-0000-7000-8000-000000000001",
  issuer: "https://polaris.cloudflareaccess.com",
  role: "platform_owner",
  subject: "subject-1",
};
const caseId = "0199a0a0-0000-7000-8000-0000000000c1";
const customerId = "0199a0a0-0000-7000-8000-0000000000d1";
const grantId = "0199a0a0-0000-7000-8000-0000000000e1";

function support(
  overrides: Partial<SupportDependencies> = {}
): SupportDependencies {
  return {
    close: vi.fn(() =>
      Promise.resolve({ changed: true, id: caseId, status: "closed" })
    ),
    customers: vi.fn(() => Promise.resolve({ customers: [], next: null })),
    detail: vi.fn(() => Promise.resolve(null)),
    grant: vi.fn(() =>
      Promise.resolve({
        caseId,
        expiresAt: "2026-10-16T13:00:00.000Z",
        id: grantId,
        organizationId: "org-1",
        startsAt: "2026-10-16T12:00:00.000Z",
      })
    ),
    list: vi.fn(() => Promise.resolve({ cases: [], next: null })),
    open: vi.fn(() => Promise.resolve({ id: caseId })),
    reveal: vi.fn(() =>
      Promise.resolve({ customerId, field: "email", value: "ana@exemplo.com" })
    ),
    revoke: vi.fn(() => Promise.resolve(true)),
    grantEntitlement: vi.fn(() =>
      Promise.resolve({
        created: true,
        id: grantId,
        organizationId: "org-1",
        outcomeRecorded: true,
      })
    ),
    reactivate: vi.fn(() =>
      Promise.resolve({ changed: true, status: "active" })
    ),
    revokeEntitlement: vi.fn(() =>
      Promise.resolve({ outcomeRecorded: true, revoked: true })
    ),
    suspend: vi.fn(() =>
      Promise.resolve({ changed: true, revokedLeases: 2, status: "suspended" })
    ),
    ...overrides,
  };
}

function setup(
  overrides: Partial<SupportDependencies> = {},
  role = "platform_owner"
) {
  const supportDependencies = support(overrides);
  const dependencies: AdminDependencies = {
    authenticate: vi.fn(() =>
      Promise.resolve({
        email: null,
        expiresAt: 2_000_000_000,
        issuedAt: 1_000_000_000,
        issuer: "https://polaris.cloudflareaccess.com",
        subject: "subject-1",
      })
    ),
    organizations: {
      diagnostics: vi.fn(() => Promise.resolve(null)),
      list: vi.fn(() => Promise.resolve({ next: null, organizations: [] })),
    },
    privacy: {
      action: vi.fn(),
      decision: vi.fn(),
      detail: vi.fn(),
      identity: vi.fn(),
      list: vi.fn(),
      open: vi.fn(),
      resolve: vi.fn(),
      role: vi.fn(),
      scope: vi.fn(),
    },
    report: vi.fn(),
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: supportDependencies,
  };
  const app = createAdminApp(dependencies);
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`https://admin.example.invalid${path}`, {
        ...init,
        headers: {
          "cf-access-jwt-assertion": "token",
          ...(init.headers ?? {}),
        },
      }),
      bindings
    );
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    call(path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { "content-type": "application/json", ...headers },
      method,
    });
  return { call, dependencies, send, support: supportDependencies };
}

describe("opening and listing cases", () => {
  it("opens a case for the verified operator, never one the body names", async () => {
    const { send, support: calls } = setup();
    const response = await send("POST", "/api/support-cases", {
      context: " ticket 42 ",
      kind: "support",
      operator: "someone-else",
      organizationId: "org-1",
      reason: "  Cliente sem acesso  ",
    });
    expect(response.status).toBe(201);
    expect(calls.open).toHaveBeenCalledWith(
      principal.id,
      {
        context: "ticket 42",
        kind: "support",
        organizationId: "org-1",
        reason: "Cliente sem acesso",
      },
      bindings
    );
  });

  it("sends a privacy case to its own workflow instead of opening it here", async () => {
    const { send, support: calls } = setup();
    const response = await send("POST", "/api/support-cases", {
      kind: "privacy",
      organizationId: "org-1",
      reason: "Pedido de acesso",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "privacy_case_workflow_required",
    });
    expect(calls.open).not.toHaveBeenCalled();
  });

  it("refuses a request that is not a case before asking the database", async () => {
    const { send, call, support: calls } = setup();
    const refused = [
      {},
      { kind: "support", reason: "x" },
      { kind: "support", organizationId: "org-1", reason: 5 },
      { kind: "support", organizationId: "a\u0000b", reason: "x" },
      { kind: "audit", organizationId: "org-1", reason: "x" },
      { kind: "support", organizationId: "org-1", reason: "   " },
      { kind: "support", organizationId: "org-1", reason: "x", context: 7 },
    ].map((body) => send("POST", "/api/support-cases", body));
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(400);
    }
    const notJson = await call("/api/support-cases", {
      body: "kind=support",
      headers: { "content-type": "text/plain" },
      method: "POST",
    });
    expect(notJson.status).toBe(400);
    const huge = await call("/api/support-cases", {
      body: JSON.stringify({ reason: "x".repeat(9000) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(huge.status).toBe(400);
    expect(calls.open).not.toHaveBeenCalled();
  });

  it("refuses control characters in what an operator types, and reports a refused attempt", async () => {
    const { send, support: calls } = setup();
    const nul = await send("POST", "/api/support-cases", {
      kind: "support",
      organizationId: "o",
      reason: "a\u0000b",
    });
    expect(nul.status).toBe(400);
    expect(await nul.json()).toEqual({ error: "invalid_case_reason" });
    const bad = await send("POST", `/api/support-cases/${caseId}/close`, {
      resolution: "x\u0000",
    });
    expect(bad.status).toBe(400);
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.close).not.toHaveBeenCalled();
    const denied = setup({
      customers: () => Promise.reject(new TenantAccessDeniedError()),
    });
    await denied.call(`/api/support-cases/${caseId}/customers`);
    expect(denied.dependencies.report).toHaveBeenCalledWith(
      "tenant_access_denied",
      { route: "/api/support-cases/:id/customers" }
    );
  });

  it("answers a database refusal with its code and a status, never the database's words", async () => {
    const unknown = setup({
      open: () =>
        Promise.reject(new InvalidSupportRequestError("unknown_organization")),
    });
    const response = await unknown.send("POST", "/api/support-cases", {
      kind: "support",
      organizationId: "nope",
      reason: "x",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_organization" });
    const denied = setup({
      open: () => Promise.reject(new TenantAccessDeniedError()),
    });
    expect(
      (
        await denied.send("POST", "/api/support-cases", {
          kind: "support",
          organizationId: "o",
          reason: "x",
        })
      ).status
    ).toBe(403);
    const broken = setup({
      open: () => Promise.reject(new Error('password for user "x"')),
    });
    const failed = await broken.send("POST", "/api/support-cases", {
      kind: "support",
      organizationId: "o",
      reason: "x",
    });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("password");
  });

  it("lists with bounded filters and reads one case", async () => {
    const { call, support: calls } = setup({
      detail: () =>
        Promise.resolve({ audit: [], case: {} as never, grants: [] }),
    });
    expect(
      (
        await call(
          `/api/support-cases?status=open&organizationId=org-1&limit=10&after=${caseId}`
        )
      ).status
    ).toBe(200);
    expect(calls.list).toHaveBeenCalledWith(
      { after: caseId, limit: 10, organizationId: "org-1", status: "open" },
      bindings
    );
    const badPaths = [
      "/api/support-cases?status=weird",
      "/api/support-cases?limit=0",
      "/api/support-cases?limit=51",
      "/api/support-cases?after=not-a-uuid",
      `/api/support-cases?organizationId=${"x".repeat(129)}`,
    ];
    for (const response of await Promise.all(
      badPaths.map((path) => call(path))
    )) {
      expect(response.status).toBe(400);
    }
    expect((await call(`/api/support-cases/${caseId}`)).status).toBe(200);
    expect((await call("/api/support-cases/not-a-uuid")).status).toBe(404);
    const missing = setup();
    expect((await missing.call(`/api/support-cases/${caseId}`)).status).toBe(
      404
    );
  });
});

describe("granting and ending access", () => {
  it("grants for an hour by default and for the minutes asked within bounds", async () => {
    const { send, support: calls } = setup();
    expect(
      (await send("POST", `/api/support-cases/${caseId}/access`, {})).status
    ).toBe(201);
    expect(calls.grant).toHaveBeenLastCalledWith(
      principal.id,
      caseId,
      60,
      bindings
    );
    await send("POST", `/api/support-cases/${caseId}/access`, { minutes: 15 });
    expect(calls.grant).toHaveBeenLastCalledWith(
      principal.id,
      caseId,
      15,
      bindings
    );
    const badMinutes = [4, 241, 1.5, "60"].map((minutes) =>
      send("POST", `/api/support-cases/${caseId}/access`, { minutes })
    );
    for (const response of await Promise.all(badMinutes)) {
      expect(response.status).toBe(400);
    }
    expect(
      (await send("POST", "/api/support-cases/not-a-uuid/access", {})).status
    ).toBe(404);
  });

  it("revokes by grant and closes a case, once", async () => {
    const { call, send, support: calls } = setup();
    expect(
      await (
        await call(`/api/tenant-access/${grantId}`, { method: "DELETE" })
      ).json()
    ).toEqual({ revoked: true });
    expect(calls.revoke).toHaveBeenCalledWith(principal.id, grantId, bindings);
    expect(
      (await call("/api/tenant-access/nope", { method: "DELETE" })).status
    ).toBe(404);
    const closed = await send("POST", `/api/support-cases/${caseId}/close`, {
      resolution: "  Resolvido  ",
    });
    expect(closed.status).toBe(200);
    expect(calls.close).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "Resolvido",
      bindings
    );
    expect(
      (
        await send("POST", `/api/support-cases/${caseId}/close`, {
          resolution: 5,
        })
      ).status
    ).toBe(400);
  });
});

describe("reading and revealing", () => {
  it("reads customers through the case and refuses without an active grant", async () => {
    const { call, support: calls } = setup();
    expect(
      (await call(`/api/support-cases/${caseId}/customers?limit=5`)).status
    ).toBe(200);
    expect(calls.customers).toHaveBeenCalledWith(
      principal.id,
      caseId,
      { after: null, limit: 5 },
      bindings
    );
    expect(
      (await call(`/api/support-cases/${caseId}/customers?limit=99`)).status
    ).toBe(400);
    const noGrant = setup({
      customers: () => Promise.reject(new TenantAccessDeniedError()),
    });
    const response = await noGrant.call(
      `/api/support-cases/${caseId}/customers`
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "tenant_access_denied" });
  });

  it("reveals one named field, and only a known one", async () => {
    const { send, support: calls } = setup();
    const response = await send(
      "POST",
      `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
      { field: "email" }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: "ana@exemplo.com" });
    expect(calls.reveal).toHaveBeenCalledWith(
      principal.id,
      caseId,
      customerId,
      "email",
      bindings
    );
    const badFields = ["password", "token", "", 5, undefined].map((value) =>
      send(
        "POST",
        `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
        { field: value }
      )
    );
    for (const answer of await Promise.all(badFields)) {
      expect(answer.status).toBe(400);
    }
    const gone = setup({ reveal: () => Promise.resolve(null) });
    expect(
      (
        await gone.send(
          "POST",
          `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
          { field: "name" }
        )
      ).status
    ).toBe(404);
  });
});

describe("who may do what, and from where", () => {
  it("needs each route's own capability", async () => {
    const { call, send, support: calls } = setup({}, "somebody_else");
    const answers = await Promise.all([
      send("POST", "/api/support-cases", {
        kind: "support",
        organizationId: "o",
        reason: "x",
      }),
      call("/api/support-cases"),
      call(`/api/support-cases/${caseId}`),
      send("POST", `/api/support-cases/${caseId}/access`, {}),
      call(`/api/support-cases/${caseId}/customers`),
      send(
        "POST",
        `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
        { field: "email" }
      ),
      call(`/api/tenant-access/${grantId}`, { method: "DELETE" }),
    ]);
    for (const response of answers) {
      expect(response.status).toBe(403);
    }
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("refuses a change that a browser sends from another origin", async () => {
    const { send, support: calls } = setup();
    const response = await send(
      "POST",
      `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
      { field: "email" },
      { origin: "https://evil.example" }
    );
    expect(response.status).toBe(403);
    expect(calls.reveal).not.toHaveBeenCalled();
    const sameOrigin = await send(
      "POST",
      `/api/support-cases/${caseId}/customers/${customerId}/reveal`,
      { field: "email" },
      { origin: "https://admin.example.invalid" }
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("needs the login like every other API route", async () => {
    const { dependencies } = setup();
    const app = createAdminApp(dependencies);
    const response = await app.fetch(
      new Request("https://admin.example.invalid/api/support-cases"),
      bindings
    );
    expect(response.status).toBe(401);
  });
});

describe("suspension and billing commands", () => {
  it("suspends and reactivates the organization of a case, for an operator who may", async () => {
    const { send, support: calls } = setup();
    const suspended = await send(
      "POST",
      `/api/support-cases/${caseId}/suspend`,
      {}
    );
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual({
      changed: true,
      revokedLeases: 2,
      status: "suspended",
    });
    expect(calls.suspend).toHaveBeenCalledWith(principal.id, caseId, bindings);
    expect(
      (await send("POST", `/api/support-cases/${caseId}/reactivate`, {})).status
    ).toBe(200);
    expect(calls.reactivate).toHaveBeenCalledWith(
      principal.id,
      caseId,
      bindings
    );
    expect(
      (await send("POST", "/api/support-cases/not-a-uuid/suspend", {})).status
    ).toBe(404);
    const other = setup({}, "somebody_else");
    expect(
      (await other.send("POST", `/api/support-cases/${caseId}/suspend`, {}))
        .status
    ).toBe(403);
    expect(other.support.suspend).not.toHaveBeenCalled();
  });

  it("gives and ends an entitlement through the case, with the operator from the login", async () => {
    const { call, send, support: calls } = setup();
    const response = await send(
      "POST",
      `/api/support-cases/${caseId}/entitlement-grants`,
      {
        hours: 48,
        key: "variants.active.max",
        reason: "Compensação",
        value: 200,
      }
    );
    expect(response.status).toBe(201);
    expect(calls.grantEntitlement).toHaveBeenCalledWith(
      principal.id,
      caseId,
      {
        hours: 48,
        key: "variants.active.max",
        reason: "Compensação",
        value: 200,
      },
      bindings
    );
    const ended = await call(
      `/api/support-cases/${caseId}/entitlement-grants/${grantId}`,
      { method: "DELETE" }
    );
    expect(await ended.json()).toEqual({
      outcomeRecorded: true,
      revoked: true,
    });
    expect(calls.revokeEntitlement).toHaveBeenCalledWith(
      principal.id,
      caseId,
      grantId,
      bindings
    );
    const noCapability = setup({}, "somebody_else");
    expect(
      (
        await noCapability.send(
          "POST",
          `/api/support-cases/${caseId}/entitlement-grants`,
          { hours: 1, key: "k", reason: "r", value: 1 }
        )
      ).status
    ).toBe(403);
  });

  it("refuses a malformed grant request, names the grant refusals and says when billing is not configured", async () => {
    const { send, support: calls } = setup();
    const bad = await Promise.all(
      [
        {},
        { hours: 48, key: "k", reason: "r" },
        { hours: 1.5, key: "k", reason: "r", value: 1 },
        { hours: "48", key: "k", reason: "r", value: 1 },
        { hours: 48, key: 5, reason: "r", value: 1 },
        { hours: 48, key: "k", reason: "r", value: "1" },
        { commandId: "not-a-uuid", hours: 48, key: "k", reason: "r", value: 1 },
        { commandId: 5, hours: 48, key: "k", reason: "r", value: 1 },
      ].map((body) =>
        send("POST", `/api/support-cases/${caseId}/entitlement-grants`, body)
      )
    );
    for (const response of bad) {
      expect(response.status).toBe(400);
    }
    expect(calls.grantEntitlement).not.toHaveBeenCalled();

    const invalidGrant = setup({
      grantEntitlement: () =>
        Promise.reject(new InvalidEntitlementGrantError("invalid_key")),
    });
    const refused = await invalidGrant.send(
      "POST",
      `/api/support-cases/${caseId}/entitlement-grants`,
      { hours: 1, key: "plan.pro", reason: "r", value: 1 }
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_key" });

    const unconfigured = setup({
      revokeEntitlement: () =>
        Promise.reject(new Error("admin_not_configured")),
    });
    const response = await unconfigured.call(
      `/api/support-cases/${caseId}/entitlement-grants/${grantId}`,
      { method: "DELETE" }
    );
    expect(response.status).toBe(503);
    const gone = setup({
      grantEntitlement: () =>
        Promise.reject(new Error("organization_not_found")),
    });
    expect(
      (
        await gone.send(
          "POST",
          `/api/support-cases/${caseId}/entitlement-grants`,
          { hours: 1, key: "k", reason: "r", value: 1 }
        )
      ).status
    ).toBe(404);
  });
});
