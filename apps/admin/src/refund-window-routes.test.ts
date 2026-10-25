import type { RawRefundWindow } from "@polaris/domain/admin/refund-window";
import { RefundWindowReadRefusedError } from "@polaris/domain/admin/refund-window";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";
import type { RefundWindowDependencies } from "./refund-window-routes";

// The domain has one role, which holds everything; a role without `billing:operate` is one only this test knows,
// so the route's own capability check is what gets exercised.
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
const LEAKS = /dono@|sub_123|providerRef|subscriptionId/;
const CASE_ID = "0199a0a0-0000-7000-8000-0000000000c1";
const PATH = `/api/support-cases/${CASE_ID}/refund-window`;
const sp = (local: string) => new Date(`${local}-03:00`);

// first charge at 15:30 of 2026-10-10 in São Paulo: the window's last second is 23:59:59 of 2026-10-17
function raw(overrides: Partial<RawRefundWindow> = {}): RawRefundWindow {
  return {
    firstChargeAmount: "24.90",
    firstChargeAt: sp("2026-10-10T15:30:00"),
    method: "pix_automatic",
    now: sp("2026-10-12T09:00:00"),
    refundRequestedAt: null,
    state: "active",
    ...overrides,
  };
}

function setup(
  read: RefundWindowDependencies["read"] = vi.fn(() => Promise.resolve(raw())),
  role = "platform_owner"
) {
  const report = vi.fn();
  const dependencies: AdminDependencies = {
    accessLog: { read: vi.fn() },
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
    refundWindow: { read },
    report,
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: {} as never,
  };
  const app = createAdminApp(dependencies);
  const send = (
    body?: unknown,
    headers: Record<string, string> = {},
    path = PATH,
    method = "POST"
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
  const sendText = (text: string, type: string) =>
    app.fetch(
      new Request(`https://admin.example.invalid${PATH}`, {
        body: text,
        headers: { "cf-access-jwt-assertion": "token", "content-type": type },
        method: "POST",
      }),
      bindings
    );
  return { read, report, send, sendText };
}

describe("reading the window of the right of withdrawal (ADR 0104, decisions 8 and 10)", () => {
  it("asks the database with the operator of the login, the case of the path and the store of the body", async () => {
    const { read, send } = setup();

    const response = await send({ organizationId: "org-1" });

    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      principal.id,
      CASE_ID,
      "org-1",
      bindings
    );
  });

  it("returns the facts and the window computed with the product's code on the database clock", async () => {
    const { send } = setup();

    const body = (await (await send({ organizationId: "org-1" })).json()) as {
      refundable: boolean;
      request: { completable: boolean };
      window: { open: boolean };
    };

    expect(body).toEqual({
      firstChargeAmount: "24.90",
      firstChargeAt: "2026-10-10T18:30:00.000Z",
      method: "pix_automatic",
      now: "2026-10-12T12:00:00.000Z",
      refundable: true,
      refundRequestedAt: null,
      request: null,
      state: "active",
      window: { open: true, until: "2026-10-18T02:59:59.000Z" },
    });
  });

  it("shows no e-mail, reference, subscription, price ID or payer: only the closed list of keys", async () => {
    const { send } = setup(
      vi.fn(() =>
        Promise.resolve({
          ...raw({ refundRequestedAt: sp("2026-10-14T10:00:00") }),
          // what a careless repository could let through: the route must not echo it
          email: "dono@example.com",
          providerRef: "sub_123",
          subscriptionId: "sub_123",
        } as RawRefundWindow)
      )
    );

    const text = await (await send({ organizationId: "org-1" })).text();

    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "firstChargeAmount",
      "firstChargeAt",
      "method",
      "now",
      "refundRequestedAt",
      "refundable",
      "request",
      "state",
      "window",
    ]);
    expect(text).not.toMatch(LEAKS);
  });

  describe("the clock at the borders", () => {
    it.each([
      ["23:59:59 of the 7th day in São Paulo", "2026-10-17T23:59:59", true],
      ["00:00:00 of the 8th day in São Paulo", "2026-10-18T00:00:00", false],
    ])("%s: the window is open = %s", async (_name, now, open) => {
      const { send } = setup(
        vi.fn(() => Promise.resolve(raw({ now: sp(now) })))
      );

      const body = (await (await send({ organizationId: "org-1" })).json()) as {
        refundable: boolean;
        request: { completable: boolean };
        window: { open: boolean };
      };

      expect(body.window.open).toBe(open);
      expect(body.refundable).toBe(open);
    });

    it.each([
      ["72 hours exactly", "2026-10-17T10:00:00", true],
      ["72 hours and 1 second", "2026-10-17T10:00:01", false],
    ])(
      "a request is completable at %s = %s",
      async (_name, now, completable) => {
        const { send } = setup(
          vi.fn(() =>
            Promise.resolve(
              raw({
                now: sp(now),
                refundRequestedAt: sp("2026-10-14T10:00:00"),
              })
            )
          )
        );

        const body = (await (
          await send({ organizationId: "org-1" })
        ).json()) as {
          refundable: boolean;
          request: { completable: boolean };
          window: { open: boolean };
        };

        expect(body.request.completable).toBe(completable);
        expect(body.refundable).toBe(completable);
      }
    );
  });

  describe("who may read", () => {
    it("refuses an operator whose role lacks billing:operate, before the database", async () => {
      const { read, send } = setup(undefined, "incident_reader");

      const response = await send({ organizationId: "org-1" });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(read).not.toHaveBeenCalled();
    });

    it("refuses a request without the Access token with 401, before the database", async () => {
      const { read, send } = setup();
      const response = await send(
        { organizationId: "org-1" },
        { "cf-access-jwt-assertion": "" }
      );

      expect(response.status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    });

    it("answers one 403 for a closed case, a case of another store and an inactive operator, and reports it", async () => {
      const { report, send } = setup(
        vi.fn(() => Promise.reject(new RefundWindowReadRefusedError()))
      );

      const response = await send({ organizationId: "org-1" });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "refund_window_read_refused",
      });
      expect(report).toHaveBeenCalledWith("refund_window_read_refused");
    });
  });

  describe("the request", () => {
    it("is a POST: a GET reads nothing and reaches no dependency", async () => {
      const { read, send } = setup();

      const response = await send(undefined, {}, PATH, "GET");

      expect(response.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    });

    it("refuses an Origin that is not the Admin's, as every route that writes an audit row", async () => {
      const { read, send } = setup();

      const response = await send(
        { organizationId: "org-1" },
        { origin: "https://evil.example.invalid" }
      );

      expect(response.status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    });

    it("accepts the Admin's own Origin", async () => {
      const { send } = setup();

      const response = await send(
        { organizationId: "org-1" },
        { origin: "https://admin.example.invalid" }
      );

      expect(response.status).toBe(200);
    });

    it.each([
      ["a body that is not JSON", "{", "application/json"],
      ["a body that is not an object", "[1]", "application/json"],
      ["another content type", '{"organizationId":"org-1"}', "text/plain"],
      ["no store", "{}", "application/json"],
      ["a store that is not text", '{"organizationId":1}', "application/json"],
      ["an empty store", '{"organizationId":""}', "application/json"],
      [
        "a store with a control character",
        '{"organizationId":"org\\u0000-1"}',
        "application/json",
      ],
      [
        "a store ID that is too long",
        `{"organizationId":"${"a".repeat(129)}"}`,
        "application/json",
      ],
      [
        "a body past the limit",
        `{"organizationId":"org-1","x":"${"a".repeat(9000)}"}`,
        "application/json",
      ],
    ])(
      "refuses %s with 400, before the database",
      async (_name, text, type) => {
        const { read, sendText } = setup();

        const response = await sendText(text, type);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
        expect(read).not.toHaveBeenCalled();
      }
    );

    it("answers 404 for a case ID that is not a UUID, before the database", async () => {
      const { read, send } = setup();

      const response = await send(
        { organizationId: "org-1" },
        {},
        "/api/support-cases/not-a-uuid/refund-window"
      );

      expect(response.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    });

    it("ignores an operator or a case that the body claims: only the login and the path count", async () => {
      const { read, send } = setup();

      await send({
        caseId: "0199a0a0-0000-7000-8000-0000000000ff",
        organizationId: "org-1",
        principalId: "0199a0a0-0000-7000-8000-0000000000ee",
      });

      expect(read).toHaveBeenCalledExactlyOnceWith(
        principal.id,
        CASE_ID,
        "org-1",
        bindings
      );
    });
  });

  it("answers 500 without the cause when the database fails", async () => {
    const { report, send } = setup(
      vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1")))
    );

    const response = await send({ organizationId: "org-1" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(report).toHaveBeenCalledWith("admin_error", expect.any(Object));
  });
});
