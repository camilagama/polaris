import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";
import { InvalidOperatorReasonError } from "./provider-commands";

// The domain has one role, which holds everything; roles that hold only part of it are known only to this test, so the
// route's own capability check is what gets exercised.
vi.mock("@polaris/domain/admin/platform-capabilities", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@polaris/domain/admin/platform-capabilities")
    >();
  const partial: Record<string, readonly string[]> = {
    incident_reader: ["operational_incident:read"],
    operate_only: ["billing:operate"],
  };
  return {
    ...actual,
    hasPlatformCapability: (role: string, capability: string) =>
      role in partial
        ? (partial[role]?.includes(capability) ?? false)
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
const CASE_ID = "0199a0a0-0000-7000-8000-0000000000c1";
const COMMAND_ID = "0199a0a0-0000-7000-8000-0000000000d1";
const CANCEL_PATH = `/api/support-cases/${CASE_ID}/billing/cancel-renewal`;
const REFUND_PATH = `/api/support-cases/${CASE_ID}/billing/refund`;
const ORIGIN = "https://admin.example.invalid";

const cancelBody = { commandId: COMMAND_ID, reason: "Cliente pediu" };
const refundBody = { ...cancelBody, expectedAmount: "24.90" };

function setup(role = "platform_owner") {
  const report = vi.fn();
  const cancelRenewal = vi.fn(() =>
    Promise.resolve({ outcomeRecorded: true, result: "cancelled" as const })
  );
  const refund = vi.fn(() =>
    Promise.resolve({
      outcomeRecorded: true,
      result: "refund_requested" as const,
    })
  );
  const dependencies: AdminDependencies = {
    accessLog: { read: vi.fn() },
    activationFunnel: { read: vi.fn() },
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
    providerCommands: { cancelRenewal, refund } as never,
    refundWindow: { read: vi.fn() },
    report,
    resolvePrincipal: vi.fn(() => Promise.resolve({ ...principal, role })),
    support: {} as never,
  };
  const app = createAdminApp(dependencies);
  const headers = (extra: Record<string, string> = {}) => ({
    "cf-access-jwt-assertion": "token",
    "content-type": "application/json",
    origin: ORIGIN,
    ...extra,
  });
  const send = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {}
  ) =>
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: headers(extra),
        method: "POST",
      }),
      bindings
    );
  return { app, cancelRenewal, headers, refund, report, send };
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("the operator's provider commands: who may ask", () => {
  it("refuses the refund to a role with billing:operate but not billing:refund, and never reads the body or calls the dependency", async () => {
    const { app, headers, refund } = setup("operate_only");
    const request = new Request(`${ORIGIN}${REFUND_PATH}`, {
      body: JSON.stringify(refundBody),
      headers: headers(),
      method: "POST",
    });

    const response = await app.fetch(request, bindings);

    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toEqual({ error: "forbidden" });
    expect(refund).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("lets the same role cancel the renewal", async () => {
    const { cancelRenewal, send } = setup("operate_only");

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(200);
    expect(cancelRenewal).toHaveBeenCalledOnce();
  });

  it("refuses the cancellation to a role without billing:operate, before the dependency", async () => {
    const { cancelRenewal, send } = setup("incident_reader");

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(403);
    expect(cancelRenewal).not.toHaveBeenCalled();
  });

  it("refuses the refund to a role without any billing capability", async () => {
    const { refund, send } = setup("incident_reader");

    const response = await send(REFUND_PATH, refundBody);

    expect(response.status).toBe(403);
    expect(refund).not.toHaveBeenCalled();
  });

  it("lets the platform owner refund", async () => {
    const { refund, send } = setup();

    const response = await send(REFUND_PATH, refundBody);

    expect(response.status).toBe(200);
    expect(refund).toHaveBeenCalledOnce();
  });

  it.each([
    ["cancel-renewal", CANCEL_PATH, cancelBody],
    ["refund", REFUND_PATH, refundBody],
  ])(
    "refuses %s without the Access token with 401",
    async (_name, path, body) => {
      const { cancelRenewal, refund, send } = setup();

      const response = await send(path, body, {
        "cf-access-jwt-assertion": "",
      });

      expect(response.status).toBe(401);
      expect(cancelRenewal).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["cancel-renewal", CANCEL_PATH, cancelBody],
    ["refund", REFUND_PATH, refundBody],
  ])(
    "refuses %s with an Origin that is not the Admin's",
    async (_name, path, body) => {
      const { cancelRenewal, refund, send } = setup();

      const response = await send(path, body, {
        origin: "https://evil.example.invalid",
      });

      expect(response.status).toBe(403);
      expect(cancelRenewal).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["cancel-renewal", CANCEL_PATH, cancelBody],
    ["refund", REFUND_PATH, refundBody],
  ])("refuses %s with no Origin at all", async (_name, path, body) => {
    const { cancelRenewal, refund, send } = setup();

    const response = await send(path, body, { origin: "" });

    expect(response.status).toBe(403);
    expect(cancelRenewal).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });
});

describe("the operator's provider commands: the request", () => {
  it.each([
    ["cancel-renewal", "cancel-renewal", cancelBody],
    ["refund", "refund", refundBody],
  ])(
    "answers 404 on %s for a case ID that is not a UUID",
    async (_name, tail, body) => {
      const { cancelRenewal, refund, send } = setup();

      const response = await send(
        `/api/support-cases/not-a-uuid/billing/${tail}`,
        body
      );

      expect(response.status).toBe(404);
      expect(cancelRenewal).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    }
  );

  const invalidCommon: [string, Record<string, unknown>][] = [
    ["no command ID", { reason: "motivo" }],
    ["a command ID that is not a UUID", { commandId: "abc", reason: "motivo" }],
    ["a numeric command ID", { commandId: 7, reason: "motivo" }],
    ["an empty reason", { commandId: COMMAND_ID, reason: "" }],
    ["a blank reason", { commandId: COMMAND_ID, reason: "   " }],
    ["no reason", { commandId: COMMAND_ID }],
    ["a reason that is not text", { commandId: COMMAND_ID, reason: 1 }],
    [
      "a reason of 301 characters",
      { commandId: COMMAND_ID, reason: "a".repeat(301) },
    ],
    [
      "a reason with a control character",
      { commandId: COMMAND_ID, reason: "linha\u0000nova" },
    ],
    [
      "a reason with a line break",
      { commandId: COMMAND_ID, reason: "linha\nnova" },
    ],
  ];

  it.each(invalidCommon)(
    "refuses the cancellation with %s",
    async (_name, body) => {
      const { cancelRenewal, send } = setup();

      const response = await send(CANCEL_PATH, body);

      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toEqual({ error: "invalid_request" });
      expect(cancelRenewal).not.toHaveBeenCalled();
    }
  );

  it.each(invalidCommon)("refuses the refund with %s", async (_name, body) => {
    const { refund, send } = setup();

    const response = await send(REFUND_PATH, {
      ...body,
      expectedAmount: "24.90",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "invalid_request" });
    expect(refund).not.toHaveBeenCalled();
  });

  it.each([
    ["no amount", {}],
    ["a zero amount", { expectedAmount: "0.00" }],
    ["an amount with one decimal place", { expectedAmount: "24.9" }],
    ["an amount with three decimal places", { expectedAmount: "24.900" }],
    ["a negative amount", { expectedAmount: "-1.00" }],
    ["an amount as a number", { expectedAmount: 24.9 }],
    ["an amount with a comma", { expectedAmount: "24,90" }],
    ["an empty amount", { expectedAmount: "" }],
    ["an amount with a leading zero", { expectedAmount: "024.90" }],
    ["a null amount", { expectedAmount: null }],
  ])("refuses the refund with %s", async (_name, amount) => {
    const { refund, send } = setup();

    const response = await send(REFUND_PATH, { ...cancelBody, ...amount });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "invalid_request" });
    expect(refund).not.toHaveBeenCalled();
  });

  it("accepts the smallest amount above zero", async () => {
    const { refund, send } = setup();

    const response = await send(REFUND_PATH, {
      ...cancelBody,
      expectedAmount: "0.01",
    });

    expect(response.status).toBe(200);
    expect(refund).toHaveBeenCalledOnce();
  });

  it.each([
    ["a body that is not JSON", "{"],
    ["a body that is not an object", "[1]"],
    [
      "a body past the limit",
      JSON.stringify({ ...cancelBody, x: "a".repeat(9000) }),
    ],
  ])("refuses %s with 400", async (_name, text) => {
    const { app, cancelRenewal, headers } = setup();

    const response = await app.fetch(
      new Request(`${ORIGIN}${CANCEL_PATH}`, {
        body: text,
        headers: headers(),
        method: "POST",
      }),
      bindings
    );

    expect(response.status).toBe(400);
    expect(cancelRenewal).not.toHaveBeenCalled();
  });

  it("passes the principal of the login, the lowercase case and command IDs, and the reason as sent", async () => {
    const { cancelRenewal, refund, send } = setup();
    const upperCase = CASE_ID.toUpperCase();
    const upperCommand = COMMAND_ID.toUpperCase();

    await send(`/api/support-cases/${upperCase}/billing/cancel-renewal`, {
      commandId: upperCommand,
      reason: "Motivo",
    });
    await send(`/api/support-cases/${upperCase}/billing/refund`, {
      commandId: upperCommand,
      expectedAmount: "24.90",
      reason: "Motivo",
    });

    expect(cancelRenewal).toHaveBeenCalledExactlyOnceWith(
      principal.id,
      CASE_ID,
      { commandId: COMMAND_ID, reason: "Motivo" },
      bindings
    );
    expect(refund).toHaveBeenCalledExactlyOnceWith(
      principal.id,
      CASE_ID,
      { commandId: COMMAND_ID, expectedAmount: "24.90", reason: "Motivo" },
      bindings
    );
  });

  it("never takes the store, the operator or the case from the body", async () => {
    const { cancelRenewal, refund, send } = setup();
    const claimed = {
      caseId: "0199a0a0-0000-7000-8000-0000000000ff",
      organizationId: "org-do-corpo",
      principalId: "0199a0a0-0000-7000-8000-0000000000ee",
    };

    await send(CANCEL_PATH, { ...cancelBody, ...claimed });
    await send(REFUND_PATH, { ...refundBody, ...claimed });

    expect(cancelRenewal).toHaveBeenCalledExactlyOnceWith(
      principal.id,
      CASE_ID,
      { commandId: COMMAND_ID, reason: "Cliente pediu" },
      bindings
    );
    expect(refund).toHaveBeenCalledExactlyOnceWith(
      principal.id,
      CASE_ID,
      {
        commandId: COMMAND_ID,
        expectedAmount: "24.90",
        reason: "Cliente pediu",
      },
      bindings
    );
  });
});

describe("the operator's provider commands: the answer", () => {
  it.each([
    ["cancelled", 200],
    ["already_cancelled", 200],
    ["nothing_to_cancel", 200],
    ["not_linked", 409],
    ["command_in_progress", 409],
    ["provider_unavailable", 503],
  ] as const)("cancel-renewal: %s is %i", async (result, status) => {
    const { cancelRenewal, send } = setup();
    cancelRenewal.mockResolvedValueOnce({
      outcomeRecorded: result !== "provider_unavailable",
      result,
    } as never);

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(status);
    expect(await jsonOf(response)).toEqual(
      status === 200
        ? { outcomeRecorded: true, result }
        : {
            error: result,
            outcomeRecorded: result !== "provider_unavailable",
            result,
          }
    );
  });

  it.each([
    ["refund_requested", 200],
    ["nothing_to_refund", 200],
    ["not_linked", 409],
    ["command_in_progress", 409],
    ["refund_not_supported", 409],
    ["amount_changed", 409],
    ["amount_mismatch", 409],
    ["provider_unavailable", 503],
  ] as const)("refund: %s is %i", async (result, status) => {
    const { refund, send } = setup();
    refund.mockResolvedValueOnce({
      outcomeRecorded: result !== "provider_unavailable",
      result,
    } as never);

    const response = await send(REFUND_PATH, refundBody);

    expect(response.status).toBe(status);
    expect(await jsonOf(response)).toEqual(
      status === 200
        ? { outcomeRecorded: true, result }
        : {
            error: result,
            outcomeRecorded: result !== "provider_unavailable",
            result,
          }
    );
  });

  it("tells the page when the command ran but its outcome was not recorded", async () => {
    const { cancelRenewal, send } = setup();
    cancelRenewal.mockResolvedValueOnce({
      outcomeRecorded: false,
      result: "cancelled",
    });

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      outcomeRecorded: false,
      result: "cancelled",
    });
  });

  it("shows only the closed list of keys, whatever the dependency returns", async () => {
    const { refund, send } = setup();
    refund.mockResolvedValueOnce({
      outcomeRecorded: true,
      providerRef: "chk_REF-BRUTA",
      result: "refund_requested",
    } as never);

    const text = await (await send(REFUND_PATH, refundBody)).text();

    expect(text).not.toContain("chk_REF-BRUTA");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "outcomeRecorded",
      "result",
    ]);
  });
});

describe("the operator's provider commands: failures", () => {
  it.each([
    ["cancel-renewal", CANCEL_PATH, cancelBody, "cancelRenewal"],
    ["refund", REFUND_PATH, refundBody, "refund"],
  ] as const)(
    "answers 404 on %s for a case that is not open",
    async (_name, path, body, dependency) => {
      const ctx = setup();
      ctx[dependency].mockRejectedValueOnce(
        new InvalidSupportRequestError("case_not_open")
      );

      const response = await ctx.send(path, body);

      expect(response.status).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "not_found" });
    }
  );

  it("answers 429 rate_limited on the refund and reports it", async () => {
    const { refund, report, send } = setup();
    refund.mockRejectedValueOnce(
      new InvalidSupportRequestError("operator_refund_rate_limited")
    );

    const response = await send(REFUND_PATH, refundBody);

    expect(response.status).toBe(429);
    expect(await jsonOf(response)).toEqual({ error: "rate_limited" });
    expect(report).toHaveBeenCalledWith("operator_refund_rate_limited");
  });

  it.each([
    ["cancel-renewal", CANCEL_PATH, cancelBody, "cancelRenewal"],
    ["refund", REFUND_PATH, refundBody, "refund"],
  ] as const)(
    "answers 503 admin_not_configured on %s when the provider is not configured",
    async (_name, path, body, dependency) => {
      const ctx = setup();
      ctx[dependency].mockRejectedValueOnce(new ProviderNotConfiguredError());

      const response = await ctx.send(path, body);

      expect(response.status).toBe(503);
      expect(await jsonOf(response)).toEqual({ error: "admin_not_configured" });
      expect(ctx.report).toHaveBeenCalledWith("admin_not_configured");
    }
  );

  it("answers 503 admin_not_configured when the Admin itself is not configured", async () => {
    const { cancelRenewal, send } = setup();
    cancelRenewal.mockRejectedValueOnce(new Error("admin_not_configured"));

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(503);
    expect(await jsonOf(response)).toEqual({ error: "admin_not_configured" });
  });

  it("answers 400 when the command refuses the reason after the route accepted it", async () => {
    const { cancelRenewal, send } = setup();
    cancelRenewal.mockRejectedValueOnce(new InvalidOperatorReasonError());

    const response = await send(CANCEL_PATH, cancelBody);

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "invalid_request" });
  });

  it("answers 500 without the cause when the dependency breaks", async () => {
    const { refund, report, send } = setup();
    refund.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.0.0.1 chk_REF-BRUTA")
    );

    const response = await send(REFUND_PATH, refundBody);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("ECONNREFUSED");
    expect(report).toHaveBeenCalledWith("admin_error", expect.any(Object));
    expect(JSON.stringify(report.mock.calls)).not.toContain("chk_REF-BRUTA");
  });
});
