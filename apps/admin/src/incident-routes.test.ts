import { InvalidIncidentRetryError } from "@polaris/domain/admin/operational-incident";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";
import type { IncidentDependencies } from "./incident-routes";

// The domain has one role, which holds everything; a reader that may not retry is a role only this
// test knows, so the route's own capability check is what gets exercised.
vi.mock("@polaris/domain/admin/platform-capabilities", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@polaris/domain/admin/platform-capabilities")
    >();
  return {
    ...actual,
    hasPlatformCapability: (role: string, capability: string) =>
      role === "incident_reader"
        ? capability === "operational_incident:read"
        : actual.hasPlatformCapability(role, capability),
  };
});

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
const incidentId = "0199a0a0-0000-7000-8000-0000000000a1";
const eventId = "0199a0a0-0000-7000-8000-0000000000b2";
const retryPath = `/api/operational-incidents/${incidentId}/events/${eventId}/retry`;

function incidents(
  overrides: Partial<IncidentDependencies> = {}
): IncidentDependencies {
  return {
    detail: vi.fn(() => Promise.resolve(null)),
    list: vi.fn(() => Promise.resolve({ incidents: [], next: null })),
    retry: vi.fn(() => Promise.resolve("retried" as const)),
    ...overrides,
  };
}

function setup(
  overrides: Partial<IncidentDependencies> = {},
  role = "platform_owner"
) {
  const incidentDependencies = incidents(overrides);
  const report = vi.fn();
  const dependencies: AdminDependencies = {
    accessLog: { read: vi.fn() },
    activationFunnel: { read: vi.fn() },
    refundWindow: { read: vi.fn() },
    authenticate: vi.fn(() =>
      Promise.resolve({
        email: null,
        expiresAt: 2_000_000_000,
        issuedAt: 1_000_000_000,
        issuer: "https://polaris.cloudflareaccess.com",
        subject: "subject-1",
      })
    ),
    incidents: incidentDependencies,
    organizations: { diagnostics: vi.fn(), list: vi.fn() },
    privacy: {} as never,
    report,
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: {} as never,
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
          // a write must name the Admin's own origin, as the browser does
          origin: "https://admin.example.invalid",
          ...headers,
        },
        method,
      }),
      bindings
    );
  return { calls: incidentDependencies, report, send };
}

describe("listing the incidents", () => {
  it("returns the page the repository gives, with the default size and no cursor", async () => {
    const page = { incidents: [], next: null };
    const { calls, send } = setup({ list: vi.fn(() => Promise.resolve(page)) });
    const response = await send("GET", "/api/operational-incidents");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(calls.list).toHaveBeenCalledWith(
      { after: null, limit: 25 },
      bindings
    );
  });

  it("passes the limit and the cursor, the cursor in lower case", async () => {
    const { calls, send } = setup();
    const response = await send(
      "GET",
      `/api/operational-incidents?limit=50&after=${incidentId.toUpperCase()}`
    );
    expect(response.status).toBe(200);
    expect(calls.list).toHaveBeenCalledWith(
      { after: incidentId, limit: 50 },
      bindings
    );
  });

  it("refuses a limit outside 1 to 50 and a cursor that is not a UUID", async () => {
    const { calls, send } = setup();
    for (const query of [
      "limit=0",
      "limit=51",
      "limit=1.5",
      "limit=abc",
      "after=nope",
      "after=",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send("GET", `/api/operational-incidents?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(calls.list).not.toHaveBeenCalled();
  });

  it("needs the read capability and a login", async () => {
    const denied = setup({}, "somebody_else");
    expect(
      (await denied.send("GET", "/api/operational-incidents")).status
    ).toBe(403);
    expect(denied.calls.list).not.toHaveBeenCalled();

    const anonymous = setup();
    const response = await anonymous.send(
      "GET",
      "/api/operational-incidents",
      undefined,
      { "cf-access-jwt-assertion": "" }
    );
    expect(response.status).toBe(401);
    expect(anonymous.calls.list).not.toHaveBeenCalled();
  });

  it("lets a role that only reads list and read", async () => {
    const { send } = setup({}, "incident_reader");
    expect((await send("GET", "/api/operational-incidents")).status).toBe(200);
  });
});

describe("reading one incident", () => {
  const found = {
    events: [],
    incident: {} as never,
    next: null,
  };

  it("returns it, asking for its events with the page", async () => {
    const { calls, send } = setup({
      detail: vi.fn(() => Promise.resolve(found)),
    });
    const response = await send(
      "GET",
      `/api/operational-incidents/${incidentId.toUpperCase()}?limit=10&after=${eventId}`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(found);
    expect(calls.detail).toHaveBeenCalledWith(
      incidentId,
      { after: eventId, limit: 10 },
      bindings
    );
  });

  it("answers not found for an ID that is not a UUID, without asking the repository", async () => {
    const { calls, send } = setup();
    const response = await send("GET", "/api/operational-incidents/not-a-uuid");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(calls.detail).not.toHaveBeenCalled();
  });

  it("answers not found for an incident that does not exist", async () => {
    const { send } = setup();
    expect(
      (await send("GET", `/api/operational-incidents/${incidentId}`)).status
    ).toBe(404);
  });

  it("refuses an invalid limit or cursor", async () => {
    const { calls, send } = setup();
    for (const query of ["limit=0", "limit=51", "after=nope"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send(
        "GET",
        `/api/operational-incidents/${incidentId}?${query}`
      );
      expect(response.status).toBe(400);
    }
    expect(calls.detail).not.toHaveBeenCalled();
  });

  it("needs the read capability", async () => {
    const { calls, send } = setup({}, "somebody_else");
    expect(
      (await send("GET", `/api/operational-incidents/${incidentId}`)).status
    ).toBe(403);
    expect(calls.detail).not.toHaveBeenCalled();
  });
});

describe("retrying a dead event", () => {
  it("sends it again for the verified operator with the trimmed reason and the IDs in lower case", async () => {
    const { calls, send } = setup();
    const response = await send(
      "POST",
      `/api/operational-incidents/${incidentId.toUpperCase()}/events/${eventId.toUpperCase()}/retry`,
      { principalId: "someone-else", reason: "  Fila voltou ao normal  " }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "retried" });
    expect(calls.retry).toHaveBeenCalledOnce();
    expect(calls.retry).toHaveBeenCalledWith(
      principal.id,
      incidentId,
      eventId,
      "Fila voltou ao normal",
      bindings
    );
  });

  it("maps each outcome to its answer", async () => {
    const expected = {
      already_pending: 200,
      busy: 409,
      event_gone: 409,
      retried: 200,
      unknown_item: 404,
    } as const;
    for (const [result, status] of Object.entries(expected)) {
      const { send } = setup({
        retry: vi.fn(() => Promise.resolve(result as never)),
      });
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send("POST", retryPath, { reason: "motivo" });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ result });
    }
  });

  it("refuses a reason that is missing, empty, with a control character or over 150, and does not retry", async () => {
    const { calls, send } = setup();
    for (const body of [
      {},
      { reason: "" },
      { reason: "   " },
      { reason: 5 },
      { reason: "a\u0000b" },
      { reason: "a\nb" },
      { reason: "a".repeat(151) },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send("POST", retryPath, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_incident_reason",
      });
    }
    expect(calls.retry).not.toHaveBeenCalled();
  });

  it("accepts a reason of exactly 150 characters", async () => {
    const { calls, send } = setup();
    const response = await send("POST", retryPath, {
      reason: "a".repeat(150),
    });
    expect(response.status).toBe(200);
    expect(calls.retry).toHaveBeenCalledOnce();
  });

  it("refuses IDs that are not UUIDs", async () => {
    const { calls, send } = setup();
    for (const path of [
      `/api/operational-incidents/nope/events/${eventId}/retry`,
      `/api/operational-incidents/${incidentId}/events/nope/retry`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send("POST", path, { reason: "motivo" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(calls.retry).not.toHaveBeenCalled();
  });

  it("needs a JSON body and the same origin", async () => {
    const { calls, send } = setup();
    const crossOrigin = await send(
      "POST",
      retryPath,
      { reason: "motivo" },
      { origin: "https://evil.example.invalid" }
    );
    expect(crossOrigin.status).toBe(403);
    const notJson = await send("POST", retryPath, undefined, {
      "content-type": "text/plain",
    });
    expect(notJson.status).toBe(400);
    const brokenJson = await send("POST", retryPath, undefined, {
      "content-type": "application/json",
    });
    // an empty body reads as {}: it has no reason
    expect(brokenJson.status).toBe(400);
    expect(calls.retry).not.toHaveBeenCalled();
  });

  it("needs its own capability: a role that only reads is refused", async () => {
    const reader = setup({}, "incident_reader");
    expect(
      (await reader.send("POST", retryPath, { reason: "motivo" })).status
    ).toBe(403);
    const unknown = setup({}, "somebody_else");
    expect(
      (await unknown.send("POST", retryPath, { reason: "motivo" })).status
    ).toBe(403);
    expect(reader.calls.retry).not.toHaveBeenCalled();
    expect(unknown.calls.retry).not.toHaveBeenCalled();
  });

  it("answers an unexpected error with internal_error and a report, without its message", async () => {
    const { report, send } = setup({
      retry: vi.fn(() => Promise.reject(new Error("secret@example.com"))),
    });
    const response = await send("POST", retryPath, { reason: "motivo" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("secret@example.com");
    expect(report).toHaveBeenCalledWith("admin_error", { errorClass: "Error" });
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "secret@example.com"
    );
  });

  it("answers 400 when the repository refuses the reason itself", async () => {
    const { send } = setup({
      retry: vi.fn(() => Promise.reject(new InvalidIncidentRetryError())),
    });
    const response = await send("POST", retryPath, { reason: "motivo" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_incident_reason" });
  });

  it("answers 503 and reports when the Admin is not configured", async () => {
    const { report, send } = setup({
      retry: vi.fn(() => Promise.reject(new Error("admin_not_configured"))),
    });
    const response = await send("POST", retryPath, { reason: "motivo" });
    expect(response.status).toBe(503);
    expect(report).toHaveBeenCalledWith("admin_not_configured");
  });
});
