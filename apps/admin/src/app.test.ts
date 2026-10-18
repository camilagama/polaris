import { securityHeaders } from "@polaris/http-security";
import { describe, expect, it, vi } from "vitest";
import { type AccessClaims, AccessJwtError } from "./access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

const UNSAFE_OR_WILDCARD = /unsafe-|\*/;

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

function noOperations() {
  return {
    cancelPurge: vi.fn(() => Promise.resolve(null)),
    grantEntitlement: vi.fn(() =>
      Promise.resolve({
        created: true,
        id: "g",
        organizationId: "o",
        outcomeRecorded: true,
      })
    ),
    legalHold: vi.fn(() => Promise.resolve(null)),
    purge: vi.fn(() => Promise.resolve(null)),
    reactivate: vi.fn(() => Promise.resolve(null)),
    revokeEntitlement: vi.fn(() =>
      Promise.resolve({ outcomeRecorded: true, revoked: false })
    ),
    suspend: vi.fn(() => Promise.resolve(null)),
  };
}

function noSupport() {
  const nothing = vi.fn(() => Promise.resolve(null));
  return {
    close: nothing,
    customers: vi.fn(() => Promise.resolve({ customers: [], next: null })),
    detail: nothing,
    grant: nothing,
    list: vi.fn(() => Promise.resolve({ cases: [], next: null })),
    open: nothing,
    reveal: nothing,
    revoke: vi.fn(() => Promise.resolve(false)),
    ...noOperations(),
  };
}

function noPrivacy() {
  const step = vi.fn(() => Promise.resolve(null));
  return {
    action: step,
    decision: step,
    detail: step,
    identity: step,
    list: vi.fn(() => Promise.resolve({ cases: [], next: null })),
    open: step,
    resolve: step,
    role: step,
    scope: step,
  };
}

function setup(overrides: Partial<AdminDependencies> = {}) {
  const dependencies: AdminDependencies = {
    authenticate: vi.fn(() => Promise.resolve(claims)),
    report: vi.fn(),
    incidents: { detail: vi.fn(), list: vi.fn(), retry: vi.fn() },
    organizations: {
      diagnostics: vi.fn(() => Promise.resolve(null)),
      list: vi.fn(() => Promise.resolve({ next: null, organizations: [] })),
    },
    privacy: noPrivacy(),
    resolvePrincipal: vi.fn(() => Promise.resolve(principal)),
    support: noSupport(),
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
      for (const [name, value] of Object.entries(securityHeaders("admin"))) {
        expect(response.headers.get(name), name).toBe(value);
      }
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toMatch(UNSAFE_OR_WILDCARD);
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

describe("the organization directory", () => {
  const raw = {
    billing: null,
    billingEvents: {
      byStatus: {},
      lastReceivedAt: null,
      maxAttempts: 0,
      oldestUnprocessedAt: null,
    },
    grants: [],
    now: "2026-10-16T12:00:00.000Z",
    offline: { activeGrants: 0, devices: 0, lastSeenAt: null },
    organization: {
      authorizationEpoch: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      currency: "BRL",
      id: "org-1",
      members: 1,
      name: "Loja",
      status: "active",
      timezone: "America/Sao_Paulo",
    },
    planCatalog: [
      ...["free", "pro"].flatMap((planId) => [
        { flagValue: null, key: "goals.active.max", limitValue: 1, planId },
        { flagValue: null, key: "images.active.max", limitValue: 50, planId },
        {
          flagValue: null,
          key: "images.per_product.max",
          limitValue: 1,
          planId,
        },
        { flagValue: false, key: "offline.write", limitValue: null, planId },
        { flagValue: false, key: "public_catalog", limitValue: null, planId },
        { flagValue: null, key: "variants.active.max", limitValue: 50, planId },
      ]),
    ],
    sync: { last7Days: {}, lastReceivedAt: null, rejectedByCode: {} },
    usage: {
      activeGoals: 0,
      archivedProducts: 0,
      maxImagesPerProduct: 0,
      images: 0,
      products: 0,
      variants: 0,
    },
  };

  it("lists organizations for a principal who may diagnose, passing a bounded page request", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        next: "org-2",
        organizations: [
          {
            accessEndsAt: null,
            billingState: "free",
            createdAt: "x",
            id: "org-1",
            name: "Loja",
            planInForce: "free",
            status: "active",
          },
        ],
      })
    );
    const { call } = setup({
      organizations: { diagnostics: () => Promise.resolve(null), list },
    });
    const response = await call(
      "/api/organizations?query=lo&limit=10&after=org-0",
      withToken
    );
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      { after: "org-0", limit: 10, query: "lo" },
      bindings
    );
    expect(((await response.json()) as { next: string }).next).toBe("org-2");
    await call("/api/organizations", withToken);
    expect(list).toHaveBeenLastCalledWith(
      { after: null, limit: 25, query: null },
      bindings
    );
  });

  it("refuses a page request that is out of bounds before asking the database", async () => {
    const list = vi.fn();
    const { call } = setup({
      organizations: { diagnostics: () => Promise.resolve(null), list },
    });
    for (const path of [
      "/api/organizations?limit=0",
      "/api/organizations?limit=51",
      "/api/organizations?limit=abc",
      "/api/organizations?limit=1.5",
      `/api/organizations?query=${"x".repeat(101)}`,
      `/api/organizations?after=${"x".repeat(129)}`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case is checked on its own
      expect((await call(path, withToken)).status).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("builds the report for one organization, and says not found for one that does not exist", async () => {
    const found = setup({
      organizations: { diagnostics: () => Promise.resolve(raw), list: vi.fn() },
    });
    const response = await found.call(
      "/api/organizations/org-1/diagnostics",
      withToken
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entitlements: { plan: string };
      organization: { id: string };
    };
    expect(body.organization.id).toBe("org-1");
    expect(body.entitlements.plan).toBe("free");
    const missing = setup();
    expect(
      (await missing.call("/api/organizations/nope/diagnostics", withToken))
        .status
    ).toBe(404);
    expect(
      (
        await missing.call(
          `/api/organizations/${"x".repeat(129)}/diagnostics`,
          withToken
        )
      ).status
    ).toBe(404);
  });

  it("refuses control characters before asking the database, and tells a damaged plan catalog from a blank error", async () => {
    const list = vi.fn();
    const { call } = setup({
      organizations: { diagnostics: () => Promise.resolve(null), list },
    });
    expect(
      (await call("/api/organizations?query=a%00b", withToken)).status
    ).toBe(400);
    expect(
      (await call("/api/organizations?after=%0Ax", withToken)).status
    ).toBe(400);
    expect(
      (await call("/api/organizations/a%00b/diagnostics", withToken)).status
    ).toBe(404);
    expect(list).not.toHaveBeenCalled();
    const damaged = setup({
      organizations: {
        diagnostics: () =>
          Promise.resolve({ ...raw, planCatalog: raw.planCatalog.slice(0, 5) }),
        list: vi.fn(),
      },
    });
    const response = await damaged.call(
      "/api/organizations/org-1/diagnostics",
      withToken
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "plan_catalog_incomplete" });
    expect(damaged.dependencies.report).toHaveBeenCalledWith(
      "plan_catalog_incomplete"
    );
  });

  it("needs the diagnose capability and a verified principal", async () => {
    const without = setup({
      resolvePrincipal: () =>
        Promise.resolve({ ...principal, role: "somebody_else" }),
    });
    expect((await without.call("/api/organizations", withToken)).status).toBe(
      403
    );
    expect(
      (await without.call("/api/organizations/org-1/diagnostics", withToken))
        .status
    ).toBe(403);
    const anonymous = setup();
    expect((await anonymous.call("/api/organizations")).status).toBe(401);
    expect(anonymous.dependencies.organizations.list).not.toHaveBeenCalled();
  });
});
