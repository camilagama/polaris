import {
  InvalidSupportRequestError,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import {
  OrganizationPurgeRefusedError,
  organizationPurgeRefusalMessage,
} from "@polaris/domain/privacy/organization-purge";
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

/** An ISO instant in UTC, this many days from now (a day only counts whole: the tests stay away from the edges). */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
const customerId = "0199a0a0-0000-7000-8000-0000000000d1";
const grantId = "0199a0a0-0000-7000-8000-0000000000e1";

function support(
  overrides: Partial<SupportDependencies> = {}
): SupportDependencies {
  return {
    cancelPurge: vi.fn(() =>
      Promise.resolve({ changed: true, status: "closed" })
    ),
    close: vi.fn(() =>
      Promise.resolve({ changed: true, id: caseId, status: "closed" })
    ),
    closureNotice: vi.fn(
      (
        _principal: string,
        _case: string,
        _organization: string,
        action: { kind: string }
      ) =>
        Promise.resolve({
          dismissed: action.kind === "dismiss",
          noticeId: "0199a0a0-0000-7000-8000-0000000000f1",
          reissue: 1,
        })
    ),
    customers: vi.fn(() => Promise.resolve({ customers: [], next: null })),
    // the purge confirms the organization named is the case's own (org_1)
    detail: vi.fn(() =>
      Promise.resolve({
        audit: [],
        case: { organizationId: "org_1" } as never,
        grants: [],
      })
    ),
    grant: vi.fn(() =>
      Promise.resolve({
        caseId,
        expiresAt: "2026-10-16T13:00:00.000Z",
        id: grantId,
        organizationId: "org-1",
        startsAt: "2026-10-16T12:00:00.000Z",
      })
    ),
    grantEntitlement: vi.fn(() =>
      Promise.resolve({
        created: true,
        id: grantId,
        organizationId: "org-1",
        outcomeRecorded: true,
      })
    ),
    legalHold: vi.fn((_principal, _case, _organization, action) =>
      Promise.resolve({ changed: true, held: action === "place" })
    ),
    list: vi.fn(() => Promise.resolve({ cases: [], next: null })),
    listLegalHolds: vi.fn(() =>
      Promise.resolve({ dueForReview: 0, holds: [], next: null })
    ),
    open: vi.fn(() => Promise.resolve({ id: caseId })),
    purge: vi.fn(() =>
      Promise.resolve({
        changed: true,
        notBefore: "2026-11-01T12:00:00.000Z",
        status: "purge_pending",
      })
    ),
    reactivate: vi.fn(() =>
      Promise.resolve({ changed: true, status: "active" })
    ),
    renewalBlocksPurge: vi.fn(() => Promise.resolve(false)),
    reveal: vi.fn(() =>
      Promise.resolve({ customerId, field: "email", value: "ana@exemplo.com" })
    ),
    revoke: vi.fn(() => Promise.resolve(true)),
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
    accessLog: { read: vi.fn() },
    incidents: { detail: vi.fn(), list: vi.fn(), retry: vi.fn() },
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
      { context: 7, kind: "support", organizationId: "org-1", reason: "x" },
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
    const missing = setup({ detail: vi.fn(() => Promise.resolve(null)) });
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

    // the caller's command ID already holds a different grant: a conflict, not a server error
    const conflict = setup({
      grantEntitlement: () =>
        Promise.reject(new Error("entitlement_grant_id_conflict")),
    });
    const conflicted = await conflict.send(
      "POST",
      `/api/support-cases/${caseId}/entitlement-grants`,
      { commandId: grantId, hours: 1, key: "k", reason: "r", value: 1 }
    );
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toEqual({ error: "grant_id_conflict" });
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

  it("schedules the purge of a case's organization, with the operator from the login", async () => {
    const { send, support: calls } = setup();
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_1",
      principalId: "forged",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      notBefore: "2026-11-01T12:00:00.000Z",
      status: "purge_pending",
    });
    expect(calls.purge).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "org_1",
      bindings
    );
    expect(
      (await send("POST", `/api/support-cases/${caseId}/purge`, {})).status
    ).toBe(400);
    expect(calls.purge).toHaveBeenCalledTimes(1);
    expect(
      (
        await send("POST", "/api/support-cases/not-a-uuid/purge", {
          organizationId: "org_1",
        })
      ).status
    ).toBe(404);
    const other = setup({}, "somebody_else");
    expect(
      (
        await other.send("POST", `/api/support-cases/${caseId}/purge`, {
          organizationId: "org_1",
        })
      ).status
    ).toBe(403);
    expect(other.support.purge).not.toHaveBeenCalled();
  });

  it("reads the renewal of the named organization before the purge, and goes on when none is alive", async () => {
    const { send, support: calls } = setup();
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_1",
    });
    expect(response.status).toBe(200);
    expect(calls.renewalBlocksPurge).toHaveBeenCalledWith("org_1", bindings);
    expect(calls.purge).toHaveBeenCalledTimes(1);
  });

  it("refuses the purge with 409 while the renewal is still alive at a provider Polaris cancels through", async () => {
    const {
      dependencies,
      send,
      support: calls,
    } = setup({
      renewalBlocksPurge: vi.fn(() => Promise.resolve(true)),
    });
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_1",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "renewal_alive",
      message: expect.any(String),
    });
    expect(calls.purge).not.toHaveBeenCalled();
    expect(dependencies.report).toHaveBeenCalledWith(
      "organization_purge_refused",
      { errorCode: "renewal_alive" }
    );
  });

  it("reads no billing of an organization that is not the case's, nor of an unknown case", async () => {
    const { send, support: calls } = setup();
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_other",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "organization_mismatch",
      message: organizationPurgeRefusalMessage("organization_mismatch"),
    });
    const unknown = setup({ detail: vi.fn(() => Promise.resolve(null)) });
    expect(
      (
        await unknown.send("POST", `/api/support-cases/${caseId}/purge`, {
          organizationId: "org_1",
        })
      ).status
    ).toBe(404);
    for (const calls_ of [calls, unknown.support]) {
      expect(calls_.renewalBlocksPurge).not.toHaveBeenCalled();
      expect(calls_.purge).not.toHaveBeenCalled();
    }
  });

  it("refuses the purge when the billing of the organization cannot be read", async () => {
    const {
      dependencies,
      send,
      support: calls,
    } = setup({
      renewalBlocksPurge: vi.fn(() =>
        Promise.reject(new Error("connection refused"))
      ),
    });
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_1",
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: "renewal_status_unavailable",
      message: expect.any(String),
    });
    // nothing of the failure reaches the operator; its cause goes to the log
    expect(JSON.stringify(body)).not.toContain("connection refused");
    expect(dependencies.report).toHaveBeenCalledWith(
      "admin_error",
      expect.any(Object)
    );
    expect(calls.purge).not.toHaveBeenCalled();
  });

  it("answers 409 with the reason when the organization cannot be purged yet", async () => {
    const { send } = setup({
      purge: vi.fn(() =>
        Promise.reject(
          new OrganizationPurgeRefusedError("organization_mismatch")
        )
      ),
    });
    const response = await send("POST", `/api/support-cases/${caseId}/purge`, {
      organizationId: "org_other",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "organization_mismatch",
      message: organizationPurgeRefusalMessage("organization_mismatch"),
    });
  });

  it("sends the closure notice again or dismisses it, the operator from the login and the organization named", async () => {
    const { send, support: calls } = setup();
    const reissued = await send(
      "POST",
      `/api/support-cases/${caseId}/closure-notice/reissue`,
      { organizationId: "org_1", principalId: "forged" }
    );
    expect(reissued.status).toBe(200);
    expect(await reissued.json()).toEqual({
      dismissed: false,
      noticeId: "0199a0a0-0000-7000-8000-0000000000f1",
      reissue: 1,
    });
    expect(calls.closureNotice).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "org_1",
      { kind: "reissue" },
      bindings
    );
    const dismissed = await send(
      "POST",
      `/api/support-cases/${caseId}/closure-notice/dismiss`,
      { organizationId: "org_1", reason: "owner_account_deleted" }
    );
    expect(dismissed.status).toBe(200);
    expect(calls.closureNotice).toHaveBeenLastCalledWith(
      principal.id,
      caseId,
      "org_1",
      { kind: "dismiss", reason: "owner_account_deleted" },
      bindings
    );
  });

  it("refuses a closure notice act without the organization, a dismissal without a reason of the list, an unknown case or a missing capability", async () => {
    const { send, support: calls } = setup();
    const dismiss = `/api/support-cases/${caseId}/closure-notice/dismiss`;
    const reissue = `/api/support-cases/${caseId}/closure-notice/reissue`;
    const refused = await Promise.all([
      send("POST", reissue, {}),
      send("POST", reissue, { organizationId: "" }),
      send("POST", reissue, { organizationId: "org\n1" }),
      send("POST", dismiss, { organizationId: "org_1" }),
      send("POST", dismiss, { organizationId: "org_1", reason: "outro" }),
      send("POST", dismiss, {
        organizationId: "org_1",
        reason: "O dono pediu por telefone",
      }),
      send("POST", dismiss, { reason: "owner_account_deleted" }),
    ]);
    expect(refused.map((response) => response.status)).toEqual(
      new Array(7).fill(400)
    );
    expect(
      (
        await send(
          "POST",
          "/api/support-cases/not-a-uuid/closure-notice/reissue",
          { organizationId: "org_1" }
        )
      ).status
    ).toBe(404);
    const other = setup({}, "somebody_else");
    expect(
      (await other.send("POST", reissue, { organizationId: "org_1" })).status
    ).toBe(403);
    expect(calls.closureNotice).not.toHaveBeenCalled();
    expect(other.support.closureNotice).not.toHaveBeenCalled();
  });

  it("answers 409 with the reason when the closure notice act is refused", async () => {
    for (const code of [
      "organization_mismatch",
      "organization_not_in_closure",
      "closure_notice_not_due",
      "closure_notice_pending",
      "closure_notice_delivered",
      "closure_notice_no_owner",
      "closure_notice_owner_present",
      "closure_notice_not_refused",
      "closure_notice_not_unverified",
      "closure_notice_owner_verified",
      "privacy_case_required",
      "privacy_case_not_deletion",
      "privacy_case_not_accepted",
    ] as const) {
      const { dependencies, send } = setup({
        closureNotice: vi.fn(() =>
          Promise.reject(new OrganizationPurgeRefusedError(code))
        ),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each code has its own app, answered in turn.
      const response = await send(
        "POST",
        `/api/support-cases/${caseId}/closure-notice/dismiss`,
        { organizationId: "org_1", reason: "email_not_verified" }
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: code,
        message: organizationPurgeRefusalMessage(code),
      });
      expect(dependencies.report).toHaveBeenCalledWith(
        "organization_purge_refused",
        { errorCode: code }
      );
    }
  });

  it("cancels a scheduled purge with a reason, the operator from the login and the organization named", async () => {
    const { send, support: calls } = setup();
    const response = await send(
      "POST",
      `/api/support-cases/${caseId}/purge/cancel`,
      {
        organizationId: "org_1",
        principalId: "forged",
        reason: "  Pedido retirado pelo dono  ",
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true, status: "closed" });
    expect(calls.cancelPurge).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "org_1",
      "Pedido retirado pelo dono",
      bindings
    );
  });

  it("refuses to cancel a purge without a usable reason or organization, an unknown case or a missing capability", async () => {
    const { send, support: calls } = setup();
    const path = `/api/support-cases/${caseId}/purge/cancel`;
    const refused = await Promise.all(
      [
        { organizationId: "org_1" },
        { organizationId: "org_1", reason: "   " },
        { organizationId: "org_1", reason: 42 },
        { organizationId: "org_1", reason: "linha\nquebrada" },
        { organizationId: "org_1", reason: "x".repeat(501) },
        { organizationId: "", reason: "motivo" },
        { reason: "motivo" },
      ].map((body) => send("POST", path, body))
    );
    expect(refused.map((response) => response.status)).toEqual(
      new Array(7).fill(400)
    );
    expect(
      (
        await send("POST", "/api/support-cases/not-a-uuid/purge/cancel", {
          organizationId: "org_1",
          reason: "motivo",
        })
      ).status
    ).toBe(404);
    const other = setup({}, "somebody_else");
    expect(
      (
        await other.send("POST", path, {
          organizationId: "org_1",
          reason: "motivo",
        })
      ).status
    ).toBe(403);
    expect(calls.cancelPurge).not.toHaveBeenCalled();
    expect(other.support.cancelPurge).not.toHaveBeenCalled();
  });

  it("answers 409 with the reason when the purge cannot be cancelled", async () => {
    for (const code of [
      "purge_in_progress",
      "purge_storage_touched",
      "purge_already_done",
      "purge_not_scheduled",
    ] as const) {
      const { dependencies, send } = setup({
        cancelPurge: vi.fn(() =>
          Promise.reject(new OrganizationPurgeRefusedError(code))
        ),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each code has its own app, answered in turn.
      const response = await send(
        "POST",
        `/api/support-cases/${caseId}/purge/cancel`,
        { organizationId: "org_1", reason: "motivo" }
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: string;
        message: string;
      };
      expect(body).toEqual({
        error: code,
        message: organizationPurgeRefusalMessage(code),
      });
      expect(body.message.length).toBeGreaterThan(10);
      // the refused attempt leaves no row, so it is in the log: the code only, nothing of the request
      expect(dependencies.report).toHaveBeenCalledWith(
        "organization_purge_refused",
        { errorCode: code }
      );
    }
  });

  it("places and releases a legal hold on the case's organization, with the operator from the login", async () => {
    const { send, support: calls } = setup();
    const reviewAt = daysFromNow(90);
    const placed = await send(
      "POST",
      `/api/support-cases/${caseId}/legal-hold`,
      {
        organizationId: "org_1",
        principalId: "forged",
        reviewAt,
      }
    );
    expect(placed.status).toBe(200);
    expect(await placed.json()).toEqual({ changed: true, held: true });
    expect(calls.legalHold).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "org_1",
      "place",
      reviewAt,
      bindings
    );
    const released = await send(
      "POST",
      `/api/support-cases/${caseId}/legal-hold/release`,
      { organizationId: "org_1" }
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ changed: true, held: false });
    expect(calls.legalHold).toHaveBeenLastCalledWith(
      principal.id,
      caseId,
      "org_1",
      "release",
      null,
      bindings
    );
  });

  it("requires a review date to place a legal hold: an ISO instant, in the future, at most 366 days away", async () => {
    const { send, support: calls } = setup();
    const path = `/api/support-cases/${caseId}/legal-hold`;
    const bad: unknown[] = [
      undefined,
      null,
      42,
      "",
      "amanhã",
      "2026-13-40T00:00:00Z",
      // no offset: the date would depend on the server's zone
      daysFromNow(10).replace("Z", ""),
      // a day only, in the past, now, and past the limit
      daysFromNow(10).slice(0, 10),
      daysFromNow(-1),
      daysFromNow(367),
    ];
    for (const reviewAt of bad) {
      // biome-ignore lint/performance/noAwaitInLoops: each value is answered in turn.
      const refused = await send("POST", path, {
        organizationId: "org_1",
        reviewAt,
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_review_at" });
    }
    expect(calls.legalHold).not.toHaveBeenCalled();
    const edge = await send("POST", path, {
      organizationId: "org_1",
      reviewAt: daysFromNow(365),
    });
    expect(edge.status).toBe(200);
  });

  it("lists the legal holds in force, read only, with the capability and a page", async () => {
    const page = {
      dueForReview: 1,
      holds: [
        {
          id: caseId,
          organizationId: "org_1",
          organizationName: "Loja",
          placedAt: "2026-10-01T12:00:00.000Z",
          placedBy: principal.id,
          reviewAt: "2026-10-10T12:00:00.000Z",
          reviewDue: true,
          supportCaseId: caseId,
        },
      ],
      next: null,
    };
    const { call, support: calls } = setup({
      listLegalHolds: vi.fn(() => Promise.resolve(page)),
    });
    const listed = await call("/api/legal-holds?limit=10");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(page);
    expect(calls.listLegalHolds).toHaveBeenCalledWith(
      { after: null, limit: 10 },
      bindings
    );
    expect((await call("/api/legal-holds?limit=0")).status).toBe(400);
    expect((await call("/api/legal-holds?after=not-a-uuid")).status).toBe(400);
    const other = setup({}, "somebody_else");
    expect((await other.call("/api/legal-holds")).status).toBe(403);
    expect(other.support.listLegalHolds).not.toHaveBeenCalled();
  });

  it("refuses a legal hold without the organization named, on an unknown case or without the capability", async () => {
    const { send, support: calls } = setup();
    for (const path of ["legal-hold", "legal-hold/release"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two paths, answered in turn.
      const refused = await Promise.all(
        [{}, { organizationId: "" }, { organizationId: "org\n1" }].map((body) =>
          send("POST", `/api/support-cases/${caseId}/${path}`, body)
        )
      );
      expect(refused.map((response) => response.status)).toEqual([
        400, 400, 400,
      ]);
      expect(
        (
          await send("POST", `/api/support-cases/not-a-uuid/${path}`, {
            organizationId: "org_1",
          })
        ).status
      ).toBe(404);
      const other = setup({}, "somebody_else");
      expect(
        (
          await other.send("POST", `/api/support-cases/${caseId}/${path}`, {
            organizationId: "org_1",
          })
        ).status
      ).toBe(403);
      expect(other.support.legalHold).not.toHaveBeenCalled();
    }
    expect(calls.legalHold).not.toHaveBeenCalled();
  });

  it("answers 409 with the reason when a legal hold or a purge is refused for the hold or the closure period", async () => {
    const hold = setup({
      legalHold: vi.fn(() =>
        Promise.reject(new OrganizationPurgeRefusedError("purge_already_done"))
      ),
    });
    const refusedHold = await hold.send(
      "POST",
      `/api/support-cases/${caseId}/legal-hold`,
      { organizationId: "org_1", reviewAt: daysFromNow(30) }
    );
    expect(refusedHold.status).toBe(409);
    expect(await refusedHold.json()).toEqual({
      error: "purge_already_done",
      message: organizationPurgeRefusalMessage("purge_already_done"),
    });
    for (const code of [
      "legal_hold_active",
      "closure_period_not_elapsed",
    ] as const) {
      const { send } = setup({
        purge: vi.fn(() =>
          Promise.reject(new OrganizationPurgeRefusedError(code))
        ),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each code has its own app, answered in turn.
      const response = await send(
        "POST",
        `/api/support-cases/${caseId}/purge`,
        { organizationId: "org_1" }
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: code,
        message: organizationPurgeRefusalMessage(code),
      });
    }
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
