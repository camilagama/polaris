import {
  ACTIVATION_FUNNEL_NOT_COUNTED,
  type ActivationFunnelResponse,
  activationFunnelResponse,
  type RawActivationFunnel,
} from "@polaris/contracts/admin-activation-funnel";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_FUNNEL_READS_PER_HOUR,
  type ActivationFunnelDependencies,
  activationFunnelView,
  createReadLimiter,
  percent,
} from "./activation-funnel-routes";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

// The domain has one role, which holds everything; a role without `platform:read` is one only this test knows, so
// the route's own capability check is what gets exercised.
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

const ZERO_VALUE = /"value":0[,}]/;

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

const shown = (value: number) => ({ state: "shown" as const, value });
const suppressed = { state: "suppressed" as const };
const windowOpen = {
  reason: "activation_window_open" as const,
  state: "unavailable" as const,
};
const notClosed = {
  reason: "week_not_closed" as const,
  state: "unavailable" as const,
};

/** One row a week as the function writes them: closed weeks with numbers shown, then the current one. */
function raw(weeks = 2): RawActivationFunnel {
  const answer = twoWeeks(weeks);
  const pad = <T>([closed, current]: T[]): T[] => [
    ...Array.from({ length: weeks - 1 }, () => closed as T),
    current as T,
  ];
  return {
    ...answer,
    activeStores: pad(answer.activeStores),
    cohorts: pad(answer.cohorts),
    signups: pad(answer.signups),
  };
}

function twoWeeks(weeks: number): RawActivationFunnel {
  return {
    activeStores: [
      {
        inProgress: false,
        stores: shown(12),
        week: "2026-W42",
        weekStart: "2026-10-12",
      },
      {
        inProgress: true,
        stores: notClosed,
        week: "2026-W43",
        weekStart: "2026-10-19",
      },
    ],
    cohorts: [
      {
        activatedIn7Days: shown(7),
        inProgress: false,
        retention: { week2: shown(5), week3: suppressed, week5: notClosed },
        stores: shown(21),
        timeToFirstSale: {
          after7Days: suppressed,
          upTo1Day: suppressed,
          upTo1Hour: suppressed,
          upTo7Days: suppressed,
          upTo10Minutes: suppressed,
        },
        week: "2026-W42",
        weekStart: "2026-10-12",
        withFirstProduct: shown(15),
        withFirstSale: shown(10),
        withoutSale: shown(11),
      },
      {
        activatedIn7Days: windowOpen,
        inProgress: true,
        retention: { week2: notClosed, week3: notClosed, week5: notClosed },
        stores: suppressed,
        timeToFirstSale: {
          after7Days: windowOpen,
          upTo1Day: windowOpen,
          upTo1Hour: windowOpen,
          upTo7Days: windowOpen,
          upTo10Minutes: windowOpen,
        },
        week: "2026-W43",
        weekStart: "2026-10-19",
        withFirstProduct: suppressed,
        withFirstSale: suppressed,
        withoutSale: suppressed,
      },
    ],
    generatedAt: "2026-10-27T14:05:07.123456-03:00",
    internalStoresExcluded: 3,
    k: 5,
    signups: [
      {
        accounts: shown(30),
        inProgress: false,
        week: "2026-W42",
        weekStart: "2026-10-12",
        withStore: shown(20),
      },
      {
        accounts: suppressed,
        inProgress: true,
        week: "2026-W43",
        weekStart: "2026-10-19",
        withStore: suppressed,
      },
    ],
    timezone: "America/Sao_Paulo",
    weeks,
  };
}

function setup(
  read: ActivationFunnelDependencies["read"] = vi.fn(() =>
    Promise.resolve(raw())
  ),
  options: {
    resolvePrincipal?: AdminDependencies["resolvePrincipal"];
    role?: string;
  } = {}
) {
  const report = vi.fn();
  const dependencies: AdminDependencies = {
    accessLog: { read: vi.fn() },
    activationFunnel: { read },
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
    refundWindow: { read: vi.fn() },
    report,
    resolvePrincipal:
      options.resolvePrincipal ??
      vi.fn(() =>
        Promise.resolve({
          ...principal,
          role: options.role ?? "platform_owner",
        })
      ),
    support: {} as never,
  };
  const app = createAdminApp(dependencies);
  const get = (query: string, token: string | null = "token") =>
    app.fetch(
      new Request(`https://admin.example.invalid/api/funnel${query}`, {
        headers: token === null ? {} : { "cf-access-jwt-assertion": token },
      }),
      bindings
    );
  return { app, get, read, report };
}

describe("GET /api/funnel", () => {
  describe("who may read", () => {
    it("refuses a request without the Access token with 401, before the database", async () => {
      const { get, read } = setup();
      const response = await get("?weeks=4", null);
      expect(response.status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    });

    it("refuses a valid login that is not a platform principal with 403, before the database", async () => {
      const { get, read } = setup(undefined, {
        resolvePrincipal: vi.fn(() => Promise.resolve(null)),
      });
      const response = await get("?weeks=4");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(read).not.toHaveBeenCalled();
    });

    it("refuses an operator whose role lacks platform:read with 403, before the database", async () => {
      const { get, read } = setup(undefined, { role: "incident_reader" });
      const response = await get("?weeks=4");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("weeks, and nothing else", () => {
    it.each([
      ["0", "?weeks=0"],
      ["27", "?weeks=27"],
      ["text", "?weeks=abc"],
      ["empty", "?weeks="],
      ["missing", ""],
      ["a leading zero", "?weeks=04"],
      ["a decimal", "?weeks=4.0"],
      ["a sign", "?weeks=%2B4"],
      ["a space", "?weeks=%204"],
      ["negative", "?weeks=-1"],
      ["twice", "?weeks=4&weeks=5"],
      ["a window", "?weeks=4&from=2026-01-01"],
      ["a store", "?weeks=4&organizationId=org-1"],
    ])(
      "answers 400 to weeks %s, before the limit and the database",
      async (_name, query) => {
        const { get, read } = setup();
        const response = await get(query);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(read).not.toHaveBeenCalled();
      }
    );

    it.each([1, 26])("takes %i weeks", async (weeks) => {
      const { get, read } = setup(vi.fn(() => Promise.resolve(raw(weeks))));
      const response = await get(`?weeks=${weeks}`);
      expect(response.status).toBe(200);
      expect(read).toHaveBeenCalledWith(principal.id, weeks, bindings);
    });
  });

  it("answers 200 with no-store and the closed contract, reading once with the operator from the login", async () => {
    const { get, read } = setup();
    const response = await get("?weeks=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(activationFunnelResponse.parse(body)).toEqual(body);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(principal.id, 2, bindings);
    expect((body as ActivationFunnelResponse).updatedAt).toBe(
      "2026-10-27T17:05:07.123Z"
    );
  });

  it.each([
    ["a key more", { ...raw(), storeIds: ["org-1"] }],
    [
      "a key more in a cohort",
      {
        ...raw(),
        cohorts: [{ ...raw().cohorts[0], organizationId: "org-1" }],
      },
    ],
    [
      "a cell with a value and a reason",
      {
        ...raw(),
        activeStores: [
          {
            ...raw().activeStores[0],
            stores: { state: "suppressed", value: 3 },
          },
        ],
      },
    ],
    ["another number of weeks", raw(3)],
    [
      "a count under k shown (a regression of the suppression)",
      {
        ...raw(),
        activeStores: [
          { ...raw().activeStores[0], stores: shown(4) },
          raw().activeStores[1],
        ],
      },
    ],
    [
      "0 shown",
      {
        ...raw(),
        signups: [
          { ...raw().signups[0], withStore: shown(0) },
          raw().signups[1],
        ],
      },
    ],
    [
      "one row fewer than the weeks asked for",
      { ...raw(), activeStores: [raw().activeStores[0]] },
    ],
    [
      "a part over its whole",
      {
        ...raw(),
        signups: [
          { ...raw().signups[0], withStore: shown(31) },
          raw().signups[1],
        ],
      },
    ],
    ["nothing", null],
  ])(
    "refuses a database answer with %s, logging none of it",
    async (_name, answer) => {
      const { get, report } = setup(vi.fn(() => Promise.resolve(answer)));
      const response = await get("?weeks=2");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(report).toHaveBeenCalledWith("activation_funnel_unexpected_shape");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(report.mock.calls)).not.toContain("org-1");
    }
  );

  it.each(["cross-site", "same-site"])(
    "refuses a read started from another origin (%s) with 403, without spending a read",
    async (site) => {
      const { app, read } = setup();
      const response = await app.fetch(
        new Request("https://admin.example.invalid/api/funnel?weeks=2", {
          headers: {
            "cf-access-jwt-assertion": "token",
            "sec-fetch-site": site,
          },
        }),
        bindings
      );
      expect(response.status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each(["same-origin", "none", undefined])(
    "reads for the Admin's own page, the address bar and a tool (Sec-Fetch-Site %s)",
    async (site) => {
      const { app, read } = setup();
      const response = await app.fetch(
        new Request("https://admin.example.invalid/api/funnel?weeks=2", {
          headers: {
            "cf-access-jwt-assertion": "token",
            ...(site === undefined ? {} : { "sec-fetch-site": site }),
          },
        }),
        bindings
      );
      expect(response.status).toBe(200);
      expect(read).toHaveBeenCalledTimes(1);
    }
  );

  it("answers 503 when the database cancels the read for its time", async () => {
    const { get, report } = setup(
      vi.fn(() => Promise.reject(new Error("activation_funnel_timeout")))
    );
    const response = await get("?weeks=2");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(report).toHaveBeenCalledWith("activation_funnel_timeout");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it(`answers 429 with Retry-After after ${ACTIVATION_FUNNEL_READS_PER_HOUR} reads of the same operator, without reading`, async () => {
    const { get, read, report } = setup();
    for (let index = 0; index < ACTIVATION_FUNNEL_READS_PER_HOUR; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: The reads count in order.
      expect((await get("?weeks=2")).status).toBe(200);
    }
    const refused = await get("?weeks=2");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledTimes(ACTIVATION_FUNNEL_READS_PER_HOUR);
    expect(report).toHaveBeenCalledWith("activation_funnel_rate_limited", {
      principal: principal.id,
    });
  });
});

describe("the read limit", () => {
  it("counts each operator apart over a sliding hour", () => {
    let now = 0;
    const limiter = createReadLimiter(2, () => now);
    expect(limiter.take("a")).toEqual({ allowed: true });
    now = 10 * 60_000;
    expect(limiter.take("a")).toEqual({ allowed: true });
    expect(limiter.take("b")).toEqual({ allowed: true });
    expect(limiter.take("a")).toEqual({
      allowed: false,
      retryAfterSeconds: 50 * 60,
    });
    // the first read leaves the hour: one more
    now = 60 * 60_000;
    expect(limiter.take("a")).toEqual({ allowed: true });
    expect(limiter.take("a").allowed).toBe(false);
  });
});

describe("the answer's contract", () => {
  const view = activationFunnelView(raw());
  const [closed, current] = view.cohorts;

  it("keeps every number the function showed and puts null with a reason where it showed none, never 0", () => {
    expect(closed?.stores).toEqual({ reason: null, value: 21 });
    expect(closed?.retention).toEqual({
      week2: { reason: null, value: 5 },
      week3: { reason: "suppressed", value: null },
      week5: { reason: "week_not_closed", value: null },
    });
    expect(current?.activatedIn7Days).toEqual({
      reason: "activation_window_open",
      value: null,
    });
    expect(view.activeStores[1]?.stores).toEqual({
      reason: "week_not_closed",
      value: null,
    });
    const cells = JSON.stringify(view);
    expect(cells).not.toMatch(ZERO_VALUE);
    expect(activationFunnelResponse.parse(view)).toEqual(view);
  });

  it("computes a percentage only between two numbers shown, one decimal", () => {
    expect(closed?.percent).toEqual({
      activatedIn7Days: { reason: null, value: 33.3 },
      retentionWeek2: { reason: null, value: 23.8 },
      retentionWeek3: { reason: "suppressed", value: null },
      retentionWeek5: { reason: "week_not_closed", value: null },
      withFirstProduct: { reason: null, value: 71.4 },
      withFirstSale: { reason: null, value: 47.6 },
    });
    expect(view.signups[0]?.percentWithStore).toEqual({
      reason: null,
      value: 66.7,
    });
  });

  it("leaves the percentage null when one side is suppressed, with that side's reason", () => {
    // the current cohort's stores are suppressed: no share, whatever the other side
    expect(current?.percent.withFirstProduct).toEqual({
      reason: "suppressed",
      value: null,
    });
    expect(current?.percent.activatedIn7Days).toEqual({
      reason: "activation_window_open",
      value: null,
    });
    expect(
      percent({ reason: null, value: 6 }, { reason: "suppressed", value: null })
    ).toEqual({ reason: "suppressed", value: null });
    expect(
      percent(
        { reason: "suppressed", value: null },
        { reason: null, value: 20 }
      )
    ).toEqual({ reason: "suppressed", value: null });
    expect(view.signups[1]?.percentWithStore).toEqual({
      reason: "suppressed",
      value: null,
    });
  });

  it("does not make up a share the function could not have shown", () => {
    expect(() =>
      percent({ reason: null, value: 6 }, { reason: null, value: 5 })
    ).toThrow("activation_funnel_inconsistent");
    expect(() =>
      percent({ reason: null, value: 0 }, { reason: null, value: 0 })
    ).toThrow("activation_funnel_inconsistent");
  });

  it("says when it was read and what the numbers leave out", () => {
    expect(view.updatedAt).toBe("2026-10-27T17:05:07.123Z");
    expect(view.internalStoresExcluded).toBe(3);
    expect(view.minimumStores).toBe(5);
    expect(view.notCounted).toEqual(ACTIVATION_FUNNEL_NOT_COUNTED);
  });

  it.each([
    ["a key more", { ...view, storeNames: [] }],
    [
      "0 in place of a suppressed count",
      {
        ...view,
        activeStores: [
          {
            ...view.activeStores[1],
            stores: { reason: "week_not_closed", value: 0 },
          },
        ],
      },
    ],
    [
      "a null with no reason",
      {
        ...view,
        activeStores: [
          { ...view.activeStores[1], stores: { reason: null, value: null } },
        ],
      },
    ],
    [
      "a share over 100",
      {
        ...view,
        signups: [
          {
            ...view.signups[0],
            percentWithStore: { reason: null, value: 101 },
          },
        ],
      },
    ],
    [
      "another note",
      { ...view, notCounted: { ...view.notCounted, signups: "tudo" } },
    ],
  ])("the contract refuses %s", (_name, body) => {
    expect(activationFunnelResponse.safeParse(body).success).toBe(false);
  });
});
