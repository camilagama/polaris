import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";
import type { PrivacyDependencies } from "./privacy-routes";

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
const entityId = "0199a0a0-0000-7000-8000-0000000000d1";

function privacy(
  overrides: Partial<PrivacyDependencies> = {}
): PrivacyDependencies {
  const step = (stage: string) =>
    vi.fn(() => Promise.resolve({ id: caseId, stage }));
  return {
    action: vi.fn(() =>
      Promise.resolve({ actionId: entityId, id: caseId, stage: "executed" })
    ),
    decision: step("decided"),
    detail: vi.fn(() => Promise.resolve(null)),
    identity: step("identity_checked"),
    list: vi.fn(() => Promise.resolve({ cases: [], next: null })),
    open: vi.fn(() => Promise.resolve({ id: caseId })),
    resolve: vi.fn(() =>
      Promise.resolve({ id: caseId, revokedGrants: 0, stage: "resolved" })
    ),
    role: step("role_determined"),
    scope: step("scoped"),
    ...overrides,
  };
}

function setup(
  overrides: Partial<PrivacyDependencies> = {},
  role = "platform_owner"
) {
  const privacyDependencies = privacy(overrides);
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
    incidents: { detail: vi.fn(), list: vi.fn(), retry: vi.fn() },
    organizations: {
      diagnostics: vi.fn(() => Promise.resolve(null)),
      list: vi.fn(() => Promise.resolve({ next: null, organizations: [] })),
    },
    privacy: privacyDependencies,
    report: vi.fn(),
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: {
      close: vi.fn(),
      customers: vi.fn(),
      detail: vi.fn(),
      grant: vi.fn(),
      grantEntitlement: vi.fn(),
      list: vi.fn(),
      open: vi.fn(),
      reactivate: vi.fn(),
      reveal: vi.fn(),
      revoke: vi.fn(),
      revokeEntitlement: vi.fn(),
      suspend: vi.fn(),
    } as never,
  };
  const app = createAdminApp(dependencies);
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    app.fetch(
      new Request(`https://admin.example.invalid${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "cf-access-jwt-assertion": "token",
          "content-type": "application/json",
          ...headers,
        },
        method,
      }),
      bindings
    );
  return { privacy: privacyDependencies, send };
}

const openBody = {
  channel: "email",
  note: "Pedido recebido por email",
  organizationId: "org-1",
  reason: "Pedido de privacidade de cliente",
  requesterKind: "data_subject",
  requestType: "deletion",
};

describe("opening a privacy case", () => {
  it("opens it for the verified operator with the response time the domain sets, never one the body names", async () => {
    const { privacy: calls, send } = setup();
    const response = await send("POST", "/api/privacy-cases", {
      ...openBody,
      dueDays: 3650,
      principalId: "someone-else",
    });
    expect(response.status).toBe(201);
    expect(calls.open).toHaveBeenCalledWith(
      principal.id,
      expect.objectContaining({
        channel: "email",
        dueDays: 15,
        organizationId: "org-1",
        receivedAt: null,
        requesterKind: "data_subject",
        requestType: "deletion",
      }),
      bindings
    );
  });

  it("accepts the moment it arrived, in the past only", async () => {
    const { privacy: calls, send } = setup();
    const ok = await send("POST", "/api/privacy-cases", {
      ...openBody,
      receivedAt: "2026-10-10T09:00:00.000Z",
    });
    expect(ok.status).toBe(201);
    expect(calls.open).toHaveBeenCalledWith(
      principal.id,
      expect.objectContaining({
        receivedAt: new Date("2026-10-10T09:00:00.000Z"),
      }),
      bindings
    );
    const future = await send("POST", "/api/privacy-cases", {
      ...openBody,
      receivedAt: "2999-01-01T00:00:00.000Z",
    });
    expect(future.status).toBe(400);
    expect(await future.json()).toEqual({ error: "invalid_privacy_request" });
    const notAnInstant = await send("POST", "/api/privacy-cases", {
      ...openBody,
      receivedAt: "yesterday",
    });
    expect(notAnInstant.status).toBe(400);
  });

  it("refuses what is not a privacy request, and does nothing", async () => {
    const { privacy: calls, send } = setup();
    for (const bad of [
      {},
      { ...openBody, organizationId: "" },
      { ...openBody, reason: 5 },
      { ...openBody, requestType: "sell" },
      { ...openBody, requesterKind: "friend" },
      { ...openBody, channel: "pigeon" },
      { ...openBody, note: "a\u0000b" },
      { ...openBody, reason: "a\u0000b" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send("POST", "/api/privacy-cases", bad);
      expect(response.status).toBe(400);
    }
    expect(calls.open).not.toHaveBeenCalled();
  });

  it("needs the privacy capability, a JSON body and the same origin", async () => {
    const { privacy: calls, send } = setup({}, "somebody_else");
    expect((await send("POST", "/api/privacy-cases", openBody)).status).toBe(
      403
    );
    const allowed = setup();
    const crossOrigin = await allowed.send(
      "POST",
      "/api/privacy-cases",
      openBody,
      { origin: "https://evil.example.invalid" }
    );
    expect(crossOrigin.status).toBe(403);
    const notJson = await allowed.send(
      "POST",
      "/api/privacy-cases",
      undefined,
      {
        "content-type": "text/plain",
      }
    );
    expect(notJson.status).toBe(400);
    expect(calls.open).not.toHaveBeenCalled();
    expect(allowed.privacy.open).not.toHaveBeenCalled();
  });
});

describe("the steps", () => {
  it("records each step for the verified operator with only the codes the domain knows", async () => {
    const { privacy: calls, send } = setup();
    const base = `/api/privacy-cases/${caseId}`;
    expect(
      (
        await send("POST", `${base}/identity`, {
          method: "owner_confirmation",
          status: "verified",
        })
      ).status
    ).toBe(200);
    expect(
      (await send("POST", `${base}/role`, { role: "processor" })).status
    ).toBe(200);
    expect(
      (
        await send("POST", `${base}/scope`, {
          categories: ["customers", "sales"],
          subjectReference: entityId,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await send("POST", `${base}/decision`, {
          decision: "redirect_to_controller",
          reason: "controller_is_reseller",
        })
      ).status
    ).toBe(200);
    const action = await send("POST", `${base}/actions`, {
      action: "redirected_to_reseller",
      entityId,
    });
    expect(action.status).toBe(201);
    expect(
      (await send("POST", `${base}/resolve`, { resolution: "Encaminhado" }))
        .status
    ).toBe(200);
    expect(calls.identity).toHaveBeenCalledWith(
      principal.id,
      caseId,
      { method: "owner_confirmation", status: "verified" },
      bindings
    );
    expect(calls.role).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "processor",
      bindings
    );
    expect(calls.scope).toHaveBeenCalledWith(
      principal.id,
      caseId,
      { categories: ["customers", "sales"], subjectReference: entityId },
      bindings
    );
    expect(calls.decision).toHaveBeenCalledWith(
      principal.id,
      caseId,
      {
        decision: "redirect_to_controller",
        note: null,
        reason: "controller_is_reseller",
      },
      bindings
    );
    expect(calls.action).toHaveBeenCalledWith(
      principal.id,
      caseId,
      { action: "redirected_to_reseller", entityId },
      bindings
    );
    expect(calls.resolve).toHaveBeenCalledWith(
      principal.id,
      caseId,
      "Encaminhado",
      bindings
    );
  });

  it("refuses a code the domain does not know before anything runs", async () => {
    const { privacy: calls, send } = setup();
    const base = `/api/privacy-cases/${caseId}`;
    const responses = await Promise.all([
      send("POST", `${base}/identity`, { method: "x", status: "verified" }),
      send("POST", `${base}/role`, { role: "joint" }),
      send("POST", `${base}/scope`, { categories: ["pictures"] }),
      send("POST", `${base}/scope`, { categories: [] }),
      send("POST", `${base}/decision`, { decision: "maybe" }),
      send("POST", `${base}/actions`, { action: "erase_everything" }),
      send("POST", `${base}/actions`, { action: "other", entityId: "Maria" }),
      send("POST", `${base}/resolve`, { resolution: 5 }),
      send("POST", "/api/privacy-cases/not-a-uuid/role", {
        role: "controller",
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(400);
    }
    for (const call of Object.values(calls)) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("says a step out of order is a conflict, a decision not allowed is a refusal and an unknown case is not found", async () => {
    const outOfOrder = setup({
      role: () =>
        Promise.reject(
          new InvalidSupportRequestError("privacy_stage_conflict")
        ),
    });
    const conflict = await outOfOrder.send(
      "POST",
      `/api/privacy-cases/${caseId}/role`,
      { role: "controller" }
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "privacy_stage_conflict" });

    const notAllowed = setup({
      decision: () =>
        Promise.reject(
          new InvalidSupportRequestError("privacy_decision_not_allowed")
        ),
    });
    const refused = await notAllowed.send(
      "POST",
      `/api/privacy-cases/${caseId}/decision`,
      { decision: "accept" }
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "privacy_decision_not_allowed",
    });

    const closed = setup({
      scope: () =>
        Promise.reject(new InvalidSupportRequestError("case_not_open")),
    });
    expect(
      (
        await closed.send("POST", `/api/privacy-cases/${caseId}/scope`, {
          categories: ["account"],
        })
      ).status
    ).toBe(409);

    const missing = setup({ identity: () => Promise.resolve(null) });
    expect(
      (
        await missing.send("POST", `/api/privacy-cases/${caseId}/identity`, {
          method: "other",
          status: "failed",
        })
      ).status
    ).toBe(404);
  });
});

describe("reading", () => {
  it("lists with a filter and a page, and reads one case", async () => {
    const { privacy: calls, send } = setup({
      detail: () =>
        Promise.resolve({
          actions: [],
          audit: [],
          case: {} as never,
          privacy: {} as never,
        }),
    });
    expect(
      (await send("GET", "/api/privacy-cases?filter=overdue&limit=10")).status
    ).toBe(200);
    expect(calls.list).toHaveBeenCalledWith(
      { after: null, filter: "overdue", limit: 10 },
      bindings
    );
    expect((await send("GET", `/api/privacy-cases/${caseId}`)).status).toBe(
      200
    );
    for (const bad of [
      "/api/privacy-cases?filter=everything",
      "/api/privacy-cases?limit=0",
      "/api/privacy-cases?limit=51",
      "/api/privacy-cases?after=nope",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      expect((await send("GET", bad)).status).toBe(400);
    }
    expect((await send("GET", "/api/privacy-cases/not-a-uuid")).status).toBe(
      404
    );
  });

  it("answers not found for a case that does not exist", async () => {
    const { send } = setup();
    expect((await send("GET", `/api/privacy-cases/${caseId}`)).status).toBe(
      404
    );
  });
});
