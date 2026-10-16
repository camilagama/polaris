import { describe, expect, it, vi } from "vitest";
import { type AccessClaims, AccessJwtError } from "./access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

const bindings: AdminBindings = {
  ACCESS_AUDIENCE: "a".repeat(64),
  ACCESS_TEAM_DOMAIN: "polaris.cloudflareaccess.com",
  ADMIN_HYPERDRIVE: { connectionString: "postgresql://admin.invalid/db" },
};
const claims: AccessClaims = {
  email: "owner@example.com",
  expiresAt: 2_000_000_000,
  issuedAt: 1_000_000_000,
  issuer: "https://polaris.cloudflareaccess.com",
  subject: "subject-1",
};
const principal = {
  emailSnapshot: "owner@example.com",
  id: "0199a0a0-0000-7000-8000-000000000001",
  issuer: "https://polaris.cloudflareaccess.com",
  role: "platform_owner",
  subject: "subject-1",
};

function setup(overrides: Partial<AdminDependencies> = {}) {
  const dependencies: AdminDependencies = {
    authenticate: vi.fn(() => Promise.resolve(claims)),
    report: vi.fn(),
    resolvePrincipal: vi.fn(() => Promise.resolve(principal)),
    ...overrides,
  };
  const app = createAdminApp(dependencies);
  const call = (
    path: string,
    init: RequestInit = {},
    env: AdminBindings = bindings
  ) =>
    app.fetch(new Request(`https://admin.example.invalid${path}`, init), env);
  return { call, dependencies };
}

const withToken = { headers: { "cf-access-jwt-assertion": "token" } };

describe("the Admin API", () => {
  it("answers a health check without a login, saying nothing about the platform", async () => {
    const { call, dependencies } = setup();
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(dependencies.authenticate).not.toHaveBeenCalled();
  });

  it("tells a verified principal who they are and what they may do", async () => {
    const { call, dependencies } = setup();
    const response = await call("/api/whoami", withToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      capabilities: string[];
      principal: Record<string, unknown>;
    };
    expect(body.principal).toEqual({
      emailSnapshot: "owner@example.com",
      id: principal.id,
      role: "platform_owner",
    });
    expect(body.capabilities).toContain("platform:read");
    expect(JSON.stringify(body)).not.toContain("subject-1");
    // the identity looked up is the issuer the token was verified against
    expect(dependencies.resolvePrincipal).toHaveBeenCalledWith(
      {
        email: "owner@example.com",
        issuer: "https://polaris.cloudflareaccess.com",
        subject: "subject-1",
      },
      bindings
    );
  });

  it("never caches and never lets a browser sniff or leak, on every kind of answer", async () => {
    const answers = [
      await setup().call("/api/whoami", withToken),
      await setup().call("/api/whoami"),
      await setup({ resolvePrincipal: () => Promise.resolve(null) }).call(
        "/api/whoami",
        withToken
      ),
      await setup().call("/nothing"),
      await setup().call("/health"),
      await setup({
        authenticate: () => {
          throw new Error("boom");
        },
      }).call("/api/whoami", withToken),
    ];
    for (const response of answers) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("tells a badly configured deployment from keys that cannot be reached", async () => {
    const { call, dependencies } = setup({
      authenticate: () => Promise.reject(new Error("admin_not_configured")),
    });
    expect((await call("/api/whoami", withToken)).status).toBe(503);
    expect(dependencies.report).toHaveBeenCalledWith("admin_not_configured");
  });

  it("refuses a request with no token, and does not trust an identity header on its own", async () => {
    const { call, dependencies } = setup();
    const response = await call("/api/whoami", {
      headers: {
        "cf-access-authenticated-user-email": "owner@example.com",
        "x-forwarded-user": "owner",
      },
    });
    expect(response.status).toBe(401);
    expect(dependencies.authenticate).not.toHaveBeenCalled();
    expect(dependencies.resolvePrincipal).not.toHaveBeenCalled();
  });

  it("refuses a token that does not verify, naming the reason only to the operator's log", async () => {
    const { call, dependencies } = setup({
      authenticate: () => Promise.reject(new AccessJwtError("wrong_audience")),
    });
    const response = await call("/api/whoami", withToken);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(dependencies.report).toHaveBeenCalledWith("access_token_rejected", {
      reason: "wrong_audience",
    });
    expect(dependencies.resolvePrincipal).not.toHaveBeenCalled();
  });

  it("is unavailable, not a login failure, when the keys or the database cannot be reached", async () => {
    const keys = setup({
      authenticate: () => Promise.reject(new Error("offline")),
    });
    expect((await keys.call("/api/whoami", withToken)).status).toBe(503);
    const database = setup({
      resolvePrincipal: () => Promise.reject(new Error("db down")),
    });
    expect((await database.call("/api/whoami", withToken)).status).toBe(503);
  });

  it("gives no access to a valid login that is not a platform principal", async () => {
    const { call, dependencies } = setup({
      resolvePrincipal: () => Promise.resolve(null),
    });
    const response = await call("/api/whoami", withToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(dependencies.report).toHaveBeenCalledWith(
      "not_a_platform_principal"
    );
  });

  it("asks for a named capability: a principal whose role has none is refused", async () => {
    const { call } = setup({
      resolvePrincipal: () =>
        Promise.resolve({ ...principal, role: "somebody_else" }),
    });
    expect((await call("/api/whoami", withToken)).status).toBe(403);
  });

  it("refuses every API request when the deployment is not configured, instead of running unverified", async () => {
    for (const missing of [
      "ACCESS_AUDIENCE",
      "ACCESS_TEAM_DOMAIN",
      "ADMIN_HYPERDRIVE",
    ] as const) {
      const { call, dependencies } = setup();
      // biome-ignore lint/performance/noAwaitInLoops: each case is checked on its own
      const response = await call("/api/whoami", withToken, {
        ...bindings,
        [missing]: undefined,
      });
      expect(response.status).toBe(503);
      expect(dependencies.authenticate).not.toHaveBeenCalled();
    }
  });

  it("answers 404 for what does not exist, with no login needed to learn it", async () => {
    const { call } = setup();
    expect((await call("/nothing")).status).toBe(404);
    expect((await call("/api/nothing", withToken)).status).toBe(404);
  });
});
