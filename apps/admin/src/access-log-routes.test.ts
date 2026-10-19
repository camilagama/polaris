import { describe, expect, it, vi } from "vitest";
import type { AccessLogDependencies } from "./access-log-routes";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

// The domain has one role, which holds everything; a role that cannot read the access log is one only this
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
const reference = "1234567-42.2026.8.26.0100";
const request = {
  from: "2026-10-01T00:00:00.000Z",
  legalReference: reference,
  to: "2026-10-08T00:00:00.000Z",
  user: "user-1",
};

function setup(
  read: AccessLogDependencies["read"] = vi.fn(() =>
    Promise.resolve({ entries: [], next: null, result: "ok" as const })
  ),
  role = "platform_owner"
) {
  const report = vi.fn();
  const dependencies: AdminDependencies = {
    accessLog: { read },
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
    organizations: { diagnostics: vi.fn(), list: vi.fn() },
    privacy: {} as never,
    report,
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: {} as never,
  };
  const app = createAdminApp(dependencies);
  const send = (
    body?: unknown,
    headers: Record<string, string> = {},
    path = "/api/access-log/read"
  ) =>
    app.fetch(
      new Request(`https://admin.example.invalid${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "cf-access-jwt-assertion": "token",
          "content-type": "application/json",
          ...headers,
        },
        method: "POST",
      }),
      bindings
    );
  return { read, report, send };
}

describe("reading the access log", () => {
  it("asks the database with the operator of the login and the normalized request, and returns the page", async () => {
    const page = {
      entries: [
        {
          event: "login_succeeded" as const,
          id: "0199a0a0-0000-7000-8000-0000000000c1",
          ip: "203.0.113.5",
          occurredAt: "2026-10-02T12:00:00.000Z",
          requestId: "req-1",
          userId: "user-1",
        },
      ],
      next: null,
      result: "ok" as const,
    };
    const { read, send } = setup(vi.fn(() => Promise.resolve(page)));

    const response = await send(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entries: page.entries,
      next: null,
    });
    expect(read).toHaveBeenCalledWith(
      principal.id,
      {
        after: null,
        filter: { kind: "user", userId: "user-1" },
        from: new Date(request.from),
        legalReference: reference,
        limit: 25,
        to: new Date(request.to),
      },
      bindings
    );
  });

  it("takes the operator from the login, never from the body", async () => {
    const { read, send } = setup();
    await send({
      ...request,
      principalId: "0199a0a0-0000-7000-8000-0000000000ff",
    });
    expect(vi.mocked(read).mock.calls[0]?.[0]).toBe(principal.id);
  });

  it("refuses a case number that is not in the CNJ format, and anything free-form, before the database", async () => {
    const { read, send } = setup();
    for (const legalReference of [
      undefined,
      "",
      "ordem judicial do juiz fulano",
      "1234567-42.2026.8.26",
      "1234567-42.2026.8.26.0100 ",
      "12345678-89.2026.8.26.0100",
      "1234567-42.2026.8.26.0100; DROP TABLE x",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send({ ...request, legalReference });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_reference" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("wants exactly one filter, a user or an IP", async () => {
    const { read, send } = setup();
    const { user: _user, ...withoutUser } = request;
    for (const body of [
      withoutUser,
      { ...request, ip: "203.0.113.5" },
      { ...request, user: "" },
      { ...withoutUser, ip: "203.0.113.5/24" },
      { ...withoutUser, ip: "not an ip" },
      { ...withoutUser, ip: "999.1.1.1" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_filter" });
    }
    expect(read).not.toHaveBeenCalled();

    const byIp = await send({ ...withoutUser, ip: "2001:db8::1" });
    expect(byIp.status).toBe(200);
    expect(vi.mocked(read).mock.calls[0]?.[1].filter).toEqual({
      ip: "2001:db8::1",
      kind: "ip",
    });
  });

  it("limits the window to 31 days and the page to 50 rows", async () => {
    const { read, send } = setup();
    for (const [body, error] of [
      [{ ...request, from: request.to, to: request.from }, "invalid_window"],
      [{ ...request, to: "2026-11-02T00:00:00.000Z" }, "invalid_window"],
      [{ ...request, from: "yesterday" }, "invalid_window"],
      [{ ...request, from: undefined }, "invalid_window"],
      [{ ...request, limit: 0 }, "invalid_page"],
      [{ ...request, limit: 51 }, "invalid_page"],
      [{ ...request, limit: "5" }, "invalid_page"],
      [{ ...request, after: "nope" }, "invalid_cursor"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      const response = await send(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(read).not.toHaveBeenCalled();

    const edge = await send({
      ...request,
      from: "2026-10-01T00:00:00.000Z",
      limit: 50,
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(edge.status).toBe(200);
  });

  it("answers the refusal the database gives as a 400 with its code", async () => {
    const { send } = setup(
      vi.fn(() => Promise.resolve({ result: "invalid_cursor" as const }))
    );
    const response = await send(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_cursor" });
  });

  it("needs the capability, a login and the same origin for a browser", async () => {
    const denied = setup(undefined, "somebody_else");
    expect((await denied.send(request)).status).toBe(403);
    expect(denied.read).not.toHaveBeenCalled();

    const reader = setup(undefined, "incident_reader");
    expect((await reader.send(request)).status).toBe(403);
    expect(reader.read).not.toHaveBeenCalled();

    const anonymous = setup();
    expect(
      (await anonymous.send(request, { "cf-access-jwt-assertion": "" })).status
    ).toBe(401);
    expect(anonymous.read).not.toHaveBeenCalled();

    const crossSite = setup();
    expect(
      (await crossSite.send(request, { origin: "https://evil.example" })).status
    ).toBe(403);
    expect(crossSite.read).not.toHaveBeenCalled();
  });

  it("exposes no GET: the filter and the case number never travel in a URL", async () => {
    const { read, send } = setup();
    const response = await send(undefined, {}, "/api/access-log/read");
    expect(response.status).toBe(400);
    const get = await createAdminApp({
      ...({} as AdminDependencies),
      accessLog: { read },
      authenticate: vi.fn(() =>
        Promise.resolve({
          email: null,
          expiresAt: 2_000_000_000,
          issuedAt: 1_000_000_000,
          issuer: "https://polaris.cloudflareaccess.com",
          subject: "subject-1",
        })
      ),
      report: vi.fn(),
      resolvePrincipal: vi.fn(() => Promise.resolve(principal)),
    }).fetch(
      new Request(
        `https://admin.example.invalid/api/access-log/read?user=user-1&legalReference=${reference}`,
        { headers: { "cf-access-jwt-assertion": "token" } }
      ),
      bindings
    );
    expect(get.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not log the answer, the IP or the user when the database fails", async () => {
    const { report, send } = setup(
      vi.fn(() => Promise.reject(new Error("boom 203.0.113.5 user-1")))
    );
    const response = await send(request);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("203.0.113.5");
    expect(JSON.stringify(report.mock.calls)).not.toContain("user-1");
  });
});
