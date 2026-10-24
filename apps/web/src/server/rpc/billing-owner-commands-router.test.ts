import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { BillingProviderPort } from "@polaris/billing/provider-port";
import {
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import {
  BillingCommandInProgressError,
  type OwnerCommandRecord,
} from "@polaris/db/billing-store";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestedOrganizationId = "organization-the-client-claims";
const serverOrganizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const sessionUserId = "verified-session-user";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const HOUR = 3_600_000;

/** An instant in São Paulo (UTC-3). */
const sp = (local: string) => new Date(`${local}-03:00`);

const bindings: WorkerBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BILLING_HYPERDRIVE: {
    connectionString: "postgresql://billing.invalid/neondb",
  },
  BILLING_PAYER_KEY: "b".repeat(32),
  BILLING_SELF_SERVICE_ENABLED: "true",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
};

function withFlag(flag: string | undefined): WorkerBindings {
  const { BILLING_SELF_SERVICE_ENABLED: _flag, ...rest } = bindings;
  return flag === undefined
    ? rest
    : { ...rest, BILLING_SELF_SERVICE_ENABLED: flag };
}

function withoutBillingRole(): WorkerBindings {
  const { BILLING_HYPERDRIVE: _role, ...rest } = bindings;
  return rest;
}

const link = {
  provider: "asaas",
  providerRef: "link-ref-0001",
  providerSubscriptionId: "sub_link0001",
};

/** Paid by card on 10/10 at 15:00 in São Paulo; the store's clock is 12/10 09:00 (inside the window). */
const activeRecord: OwnerCommandRecord = {
  accessEndsAt: sp("2026-11-11T00:00:00"),
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  firstChargeAmount: "24.90",
  firstChargeAt: sp("2026-10-10T15:00:00"),
  firstChargeOn: "2026-10-10",
  link,
  priceAmount: "29.90",
  provider: "asaas",
  refundRequestedAt: null,
  refundRequestId: null,
  revoked: null,
  state: "active",
};

const NOW = sp("2026-10-12T09:00:00");

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

type CommandName = "cancelRenewal" | "openOverduePayment" | "requestRefund";

interface OwnerClient {
  billing: Record<CommandName, (input: unknown) => Promise<unknown>>;
}

/** The three commands, and the record each succeeds with. */
const COMMANDS: readonly [CommandName, Partial<OwnerCommandRecord>][] = [
  ["cancelRenewal", {}],
  ["requestRefund", {}],
  ["openOverduePayment", { state: "grace" }],
];

interface SetupOptions {
  /** Audit rows are lost: the INSERT fails this many times (then works). */
  auditFailures?: number;
  bindings?: WorkerBindings;
  claim?: boolean;
  locked?: boolean;
  /** What a provider call does instead of answering well. */
  portFails?: boolean;
  record?: Partial<OwnerCommandRecord>;
  refundsEnabled?: boolean;
  refuse?: TenantAuthorizationError;
}

function setup(options: SetupOptions = {}) {
  const log: string[] = [];
  const record: OwnerCommandRecord = { ...activeRecord, ...options.record };
  const ledger = new Set<string>();
  const audited: { eventType: string; requestId: string }[] = [];
  const auditIdentities: unknown[] = [];
  const signals: AbortSignal[] = [];
  const state = {
    auditFailures: options.auditFailures ?? 0,
    claim: options.claim ?? true,
    locked: options.locked ?? false,
  };
  const capabilities: string[] = [];
  const requested: string[] = [];

  const port = {
    cancelRenewal: vi.fn(() => {
      log.push("provider:cancelRenewal");
      return options.portFails
        ? Promise.reject(new ProviderUnavailableError())
        : Promise.resolve("cancelled" as const);
    }),
    overduePaymentPage: vi.fn(() => {
      log.push("provider:overduePaymentPage");
      return options.portFails
        ? Promise.reject(new ProviderUnavailableError())
        : Promise.resolve<string | null>("https://www.asaas.com/i/invoice-1");
    }),
    provider: "asaas",
    refundCurrentPeriod: vi.fn(() => {
      log.push("provider:refund");
      return options.portFails
        ? Promise.reject(new ProviderUnavailableError())
        : Promise.resolve("refund_requested" as const);
    }),
    refundsEnabled: options.refundsEnabled ?? true,
  };
  const store = {
    anchorRefundRequest: vi.fn(
      (
        _organizationId: string,
        input: { at: Date; requestId: string; providerRef: string }
      ) => {
        log.push("store:anchor");
        if (record.refundRequestedAt === null) {
          record.refundRequestedAt = input.at;
          record.refundRequestId = input.requestId;
        }
        return Promise.resolve({
          refundRequestedAt: record.refundRequestedAt,
          refundRequestId: record.refundRequestId,
        });
      }
    ),
    claimProviderCommand: vi.fn((_organizationId: string, _now?: Date) => {
      log.push("store:claim");
      return Promise.resolve(state.claim);
    }),
    close: vi.fn(() => Promise.resolve()),
    databaseNow: vi.fn(() => Promise.resolve(NOW)),
    hasLedgerEvent: vi.fn((_provider: string, providerEventId: string) =>
      Promise.resolve(ledger.has(providerEventId))
    ),
    processEvent: vi.fn((eventId: string, _now?: Date) =>
      Promise.resolve({
        eventId,
        organizationId: serverOrganizationId,
        outcomeCode: null,
        status: "applied" as const,
      })
    ),
    readOwnerCommandRecord: vi.fn((_organizationId: string) =>
      Promise.resolve({ ...record })
    ),
    recordCancellationFeedback: vi.fn(() => Promise.resolve()),
    recordEvent: vi.fn(
      (input: { fact: { type: string }; providerEventId: string }) => {
        log.push(`store:recordEvent:${input.fact.type}`);
        ledger.add(input.providerEventId);
        if (input.fact.type === "subscription_cancelled") {
          record.cancelAtPeriodEnd = true;
        }
        return Promise.resolve({ duplicate: false, id: "ev-1" });
      }
    ),
    withOrganizationLock: vi.fn(
      (_organizationId: string, operation: () => Promise<unknown>) =>
        state.locked
          ? Promise.reject(new BillingCommandInProgressError())
          : operation()
    ),
  };
  const createBillingStore = vi.fn((_connection: string) => store);
  const providerPortOf = vi.fn(
    (
      _bindings: WorkerBindings,
      provider: string,
      _options?: { signal?: AbortSignal }
    ) => {
      if (provider !== "asaas") {
        throw new ProviderNotConfiguredError();
      }
      return port as unknown as BillingProviderPort;
    }
  );
  const recordBillingRequestAudit = vi.fn(
    (
      _transaction: unknown,
      identity: unknown,
      input: { eventType: string; requestId: string }
    ) => {
      log.push(`audit:${input.eventType}`);
      if (state.auditFailures > 0) {
        state.auditFailures -= 1;
        return Promise.reject(new Error("insert failed"));
      }
      auditIdentities.push(identity);
      audited.push(input);
      return Promise.resolve();
    }
  );
  const withTenantRequestContext = vi.fn(
    (input: TenantRequestContextInput<unknown>) => {
      capabilities.push(input.capability);
      requested.push(input.requestedOrganizationId);
      if (options.refuse) {
        return Promise.reject(options.refuse);
      }
      return input.operation({} as never, {
        capability: input.capability,
        organizationId: serverOrganizationId,
        role: "owner",
        userId: sessionUserId,
      });
    }
  );
  const timeoutSignal = vi.fn((_ms: number) => {
    const { signal } = new AbortController();
    signals.push(signal);
    return signal;
  });
  const router = createRpcRouter({
    billing: {
      createBillingStore,
      ownerCommandTiming: { elapsedMs: () => 0, timeoutSignal },
      providerPortOf,
      recordBillingRequestAudit,
    },
    withTenantRequestContext,
  } as unknown as Overrides);
  const app = createServerApp({ rpcRouter: router });
  const workerBindings = options.bindings ?? bindings;
  const rpcLink = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, workerBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  const raw = async (
    command: CommandName,
    organizationId: string,
    requestId = REQUEST
  ) => {
    const response = await app.fetch(
      new Request(`https://polaris.example.invalid/rpc/billing/${command}`, {
        body: JSON.stringify({ json: { organizationId, requestId } }),
        headers: {
          "content-type": "application/json",
          origin: "https://polaris.example.invalid",
        },
        method: "POST",
      }),
      workerBindings
    );
    return { body: await response.text(), status: response.status };
  };
  return {
    audited,
    auditIdentities,
    capabilities,
    client: createORPCClient(rpcLink) as unknown as OwnerClient,
    createBillingStore,
    ledger,
    log,
    port,
    providerPortOf,
    raw,
    record,
    recordBillingRequestAudit,
    requested,
    signals,
    state,
    store,
    timeoutSignal,
    withTenantRequestContext,
  };
}

type Fixture = ReturnType<typeof setup>;

function call(
  fixture: Fixture,
  command: CommandName,
  extra: Record<string, unknown> = {}
) {
  return fixture.client.billing[command]({
    organizationId: requestedOrganizationId,
    requestId: REQUEST,
    ...extra,
  });
}

/** Nothing of the billing or of the tenant was touched. */
function expectUntouched(fixture: Fixture) {
  expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
  expect(fixture.createBillingStore).not.toHaveBeenCalled();
  expect(fixture.recordBillingRequestAudit).not.toHaveBeenCalled();
  expect(fixture.providerPortOf).not.toHaveBeenCalled();
}

describe.each(COMMANDS)("billing.%s: the flag", (command, record) => {
  it.each([undefined, "false", "TRUE", "1"])(
    "with BILLING_SELF_SERVICE_ENABLED %s answers NOT_FOUND billing_self_service_off and calls nothing, not even the tenant",
    async (flag) => {
      const fixture = setup({ bindings: withFlag(flag), record });

      await expect(call(fixture, command)).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { reason: "billing_self_service_off" },
      });

      expectUntouched(fixture);
    }
  );

  it("with the flag off, the owner and someone who is not a member get the same bytes", async () => {
    const off = withFlag("false");
    const owner = await setup({ bindings: off, record }).raw(
      command,
      serverOrganizationId
    );
    const stranger = await setup({
      bindings: off,
      refuse: new TenantAuthorizationError("tenant_access_denied"),
    }).raw(command, serverOrganizationId);

    expect(owner.status).toBe(404);
    expect(stranger).toEqual(owner);
  });
});

describe.each(COMMANDS)("billing.%s: authorization", (command, record) => {
  it("asks for billing:manage on the organization the client names, and uses the server's organization everywhere after", async () => {
    const fixture = setup({ record });

    await call(fixture, command);

    expect(fixture.capabilities[0]).toBe("billing:manage");
    expect(fixture.requested[0]).toBe(requestedOrganizationId);
    const organizations = [
      ...fixture.store.withOrganizationLock.mock.calls.map(([id]) => id),
      ...fixture.store.readOwnerCommandRecord.mock.calls.map(([id]) => id),
      ...fixture.store.claimProviderCommand.mock.calls.map(([id]) => id),
      ...fixture.store.anchorRefundRequest.mock.calls.map(([id]) => id),
    ];
    expect(organizations.length).toBeGreaterThanOrEqual(3);
    expect(organizations.every((value) => value === serverOrganizationId)).toBe(
      true
    );
    expect(JSON.stringify(fixture.store.recordEvent.mock.calls)).not.toContain(
      requestedOrganizationId
    );
    expect(fixture.auditIdentities).toEqual([
      expect.objectContaining({
        organizationId: serverOrganizationId,
        userId: sessionUserId,
      }),
    ]);
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a member without the capability with FORBIDDEN billing_manage_required, touching no billing", async () => {
    const fixture = setup({
      record,
      refuse: new TenantAuthorizationError("capability_denied"),
    });

    await expect(call(fixture, command)).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "billing_manage_required" },
    });

    expect(fixture.createBillingStore).not.toHaveBeenCalled();
    expect(fixture.recordBillingRequestAudit).not.toHaveBeenCalled();
  });

  it("gives someone who is not a member and an organization that does not exist the very same bytes", async () => {
    const refuse = new TenantAuthorizationError("tenant_access_denied");
    const stranger = await setup({ refuse }).raw(command, serverOrganizationId);
    const missing = await setup({ refuse }).raw(
      command,
      "00000000-0000-4000-8000-000000000000"
    );

    expect(stranger.status).toBe(404);
    expect(JSON.parse(stranger.body)).toMatchObject({
      json: { code: "NOT_FOUND", data: { reason: "organization_not_found" } },
    });
    expect(missing).toEqual(stranger);
  });

  it("tells the member of a closed organization so, as every tenant call does", async () => {
    const fixture = setup({
      refuse: new TenantAuthorizationError("organization_closed"),
    });

    await expect(call(fixture, command)).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "organization_closed" },
    });
    expect(fixture.createBillingStore).not.toHaveBeenCalled();
  });

  it("without the billing role answers SERVICE_UNAVAILABLE billing_not_configured, touching no store and no audit", async () => {
    const fixture = setup({ bindings: withoutBillingRole(), record });

    await expect(call(fixture, command)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_not_configured" },
    });

    expect(fixture.createBillingStore).not.toHaveBeenCalled();
    expect(fixture.recordBillingRequestAudit).not.toHaveBeenCalled();
    expect(fixture.providerPortOf).not.toHaveBeenCalled();
  });
});

describe.each(COMMANDS)("billing.%s: the request ID", (command, record) => {
  it.each([
    ["not a UUID", "abc"],
    ["empty", ""],
    ["the nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["a version that does not exist", "11111111-1111-9111-8111-111111111111"],
    ["a variant that does not exist", "11111111-1111-4111-7111-111111111111"],
    ["a UUID with trailing text", `${REQUEST}-x`],
  ])(
    "refuses %s with BAD_REQUEST by the contract, calling nothing",
    async (_name, requestId) => {
      const fixture = setup({ record });

      await expect(call(fixture, command, { requestId })).rejects.toMatchObject(
        {
          code: "BAD_REQUEST",
        }
      );

      expectUntouched(fixture);
    }
  );

  it("accepts capitals, and the command and the audit get it in lowercase", async () => {
    const fixture = setup({ record });
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

    await call(fixture, command, { requestId: upper });

    expect(fixture.audited).toHaveLength(1);
    expect(fixture.audited[0]?.requestId).toBe(upper.toLowerCase());
    if (command === "cancelRenewal") {
      // the command's own fact carries the ID the command got
      expect(fixture.ledger.size).toBe(1);
      const [eventId] = [...fixture.ledger];
      expect(eventId).toContain(upper.toLowerCase());
      expect(eventId).not.toContain(upper);
    }
    if (command === "requestRefund") {
      expect(fixture.record.refundRequestId).toBe(upper.toLowerCase());
    }
  });
});

describe("billing.cancelRenewal: the answer", () => {
  it("answers exactly result and accessEndsAt, as an ISO string, and nothing of the provider", async () => {
    const fixture = setup();

    const answer = await call(fixture, "cancelRenewal");

    expect(Object.keys(answer as object).sort()).toEqual([
      "accessEndsAt",
      "result",
    ]);
    expect(answer).toEqual({
      accessEndsAt: activeRecord.accessEndsAt?.toISOString(),
      result: "cancelled",
    });
    expect(JSON.stringify(answer)).not.toContain(link.providerRef);
    expect(JSON.stringify(answer)).not.toContain(link.providerSubscriptionId);
  });

  it("answers accessEndsAt null for a record with no end of access", async () => {
    const fixture = setup({ record: { accessEndsAt: null } });

    await expect(call(fixture, "cancelRenewal")).resolves.toEqual({
      accessEndsAt: null,
      result: "cancelled",
    });
  });

  it("answers already_cancelled with the same two keys, audited as refused", async () => {
    const fixture = setup({ record: { cancelAtPeriodEnd: true } });

    const answer = await call(fixture, "cancelRenewal");

    expect(Object.keys(answer as object).sort()).toEqual([
      "accessEndsAt",
      "result",
    ]);
    expect(answer).toMatchObject({ result: "already_cancelled" });
    expect(fixture.audited.map((row) => row.eventType)).toEqual([
      "billing.command_refused",
    ]);
  });

  it("keeps the reason of the cancellation out of the answer and the audit", async () => {
    const fixture = setup();

    const answer = await call(fixture, "cancelRenewal", {
      reason: "Ligue para fulana@example.com",
    });

    expect(fixture.store.recordCancellationFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Ligue para fulana@example.com" })
    );
    expect(JSON.stringify(answer)).not.toContain("fulana");
    expect(JSON.stringify(fixture.audited)).not.toContain("fulana");
    expect(JSON.stringify(fixture.auditIdentities)).not.toContain("fulana");
  });

  it("refuses a reason longer than 500 characters with BAD_REQUEST", async () => {
    const fixture = setup();

    await expect(
      call(fixture, "cancelRenewal", { reason: "x".repeat(501) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expectUntouched(fixture);
  });
});

describe("billing.requestRefund: the answer", () => {
  it("answers exactly result, amount and until, with the first charge's amount and the window's last second", async () => {
    const fixture = setup();

    const answer = await call(fixture, "requestRefund");

    expect(Object.keys(answer as object).sort()).toEqual([
      "amount",
      "result",
      "until",
    ]);
    expect(answer).toEqual({
      amount: "24.90",
      result: "refund_requested",
      until: sp("2026-10-17T23:59:59").toISOString(),
    });
    expect(fixture.audited.map((row) => row.eventType)).toEqual([
      "billing.refund_requested",
    ]);
  });

  it("answers refund_pending, not an error, when the refund fails after the cancellation", async () => {
    const fixture = setup();
    fixture.port.refundCurrentPeriod.mockRejectedValueOnce(
      new ProviderUnavailableError()
    );

    await expect(call(fixture, "requestRefund")).resolves.toMatchObject({
      amount: "24.90",
      result: "refund_pending",
    });
    expect(fixture.audited.map((row) => row.eventType)).toEqual([
      "billing.refund_requested",
    ]);
  });
});

describe("billing.openOverduePayment: the answer", () => {
  it("answers exactly a redirect handoff with the provider's page", async () => {
    const fixture = setup({ record: { state: "grace" } });

    const answer = await call(fixture, "openOverduePayment");

    expect(Object.keys(answer as object)).toEqual(["handoff"]);
    expect(Object.keys((answer as { handoff: object }).handoff).sort()).toEqual(
      ["kind", "url"]
    );
    expect(answer).toEqual({
      handoff: { kind: "redirect", url: "https://www.asaas.com/i/invoice-1" },
    });
    expect(fixture.audited.map((row) => row.eventType)).toEqual([
      "billing.overdue_payment_opened",
    ]);
  });
});

describe("the audit of the request is written after the billing, with the type of the outcome", () => {
  it("writes the accepted type after every call of the store and the provider", async () => {
    const fixture = setup();

    await call(fixture, "cancelRenewal");

    expect(fixture.log.at(-1)).toBe(
      "audit:billing.owner_renewal_cancel_requested"
    );
    expect(
      fixture.log.slice(0, -1).every((entry) => !entry.startsWith("audit:"))
    ).toBe(true);
    expect(fixture.log.indexOf("provider:cancelRenewal")).toBeLessThan(
      fixture.log.indexOf("audit:billing.owner_renewal_cancel_requested")
    );
    expect(fixture.audited).toEqual([
      {
        eventType: "billing.owner_renewal_cancel_requested",
        requestId: REQUEST,
      },
    ]);
  });

  it("writes billing.command_rate_limited for a request the limit barred, and answers CONFLICT", async () => {
    const fixture = setup({ claim: false });

    await expect(call(fixture, "cancelRenewal")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "billing_command_rate_limited" },
    });

    expect(fixture.audited).toEqual([
      { eventType: "billing.command_rate_limited", requestId: REQUEST },
    ]);
    expect(fixture.port.cancelRenewal).not.toHaveBeenCalled();
  });

  it("writes billing.command_in_progress for a request that found the lock held, and answers CONFLICT", async () => {
    const fixture = setup({ locked: true });

    await expect(call(fixture, "requestRefund")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "command_in_progress" },
    });

    expect(fixture.audited).toEqual([
      { eventType: "billing.command_in_progress", requestId: REQUEST },
    ]);
  });

  it.each([
    ["nothing_to_cancel", "cancelRenewal", { state: "free" as const }, {}],
    [
      "nothing_to_refund",
      "requestRefund",
      { firstChargeAt: null as Date | null },
      {},
    ],
    ["refund_via_support", "requestRefund", {}, { refundsEnabled: false }],
    [
      "refund_window_expired",
      "requestRefund",
      {
        cancelAtPeriodEnd: true,
        refundRequestedAt: new Date(NOW.getTime() - 72 * HOUR - 1000),
        refundRequestId: "99999999-9999-4999-8999-999999999999",
      },
      {},
    ],
    [
      "no_overdue_payment",
      "openOverduePayment",
      { state: "active" as const },
      {},
    ],
  ] as const)(
    "answers CONFLICT with the reason %s, audited as refused, with the provider not called",
    async (reason, command, record, extra) => {
      const fixture = setup({ record, ...extra });

      await expect(call(fixture, command)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason },
      });

      expect(fixture.audited).toEqual([
        { eventType: "billing.command_refused", requestId: REQUEST },
      ]);
      expect(fixture.port.cancelRenewal).not.toHaveBeenCalled();
      expect(fixture.port.refundCurrentPeriod).not.toHaveBeenCalled();
      expect(fixture.port.overduePaymentPage).not.toHaveBeenCalled();
    }
  );

  it.each(COMMANDS)(
    "answers SERVICE_UNAVAILABLE billing_provider_unavailable when the provider fails (%s), audited as accepted",
    async (command, record) => {
      const fixture = setup({ portFails: true, record });

      if (command === "requestRefund") {
        // a failing refund after the cancellation is refund_pending; a failing cancellation is the failure
        fixture.port.cancelRenewal.mockRejectedValueOnce(
          new ProviderUnavailableError()
        );
      }
      await expect(call(fixture, command)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_provider_unavailable" },
      });

      const accepted = {
        cancelRenewal: "billing.owner_renewal_cancel_requested",
        openOverduePayment: "billing.overdue_payment_opened",
        requestRefund: "billing.refund_requested",
      }[command];
      expect(fixture.audited).toEqual([
        { eventType: accepted, requestId: REQUEST },
      ]);
    }
  );

  it("passes the signal of each call to the port of the provider, and none to the read of whether it refunds", async () => {
    const fixture = setup();

    await call(fixture, "requestRefund");

    const options = fixture.providerPortOf.mock.calls.map(
      ([, provider, portOptions]) => ({ portOptions, provider })
    );
    expect(options.every(({ provider }) => provider === "asaas")).toBe(true);
    const signed = options.filter(
      ({ portOptions }) => portOptions?.signal !== undefined
    );
    expect(signed.map(({ portOptions }) => portOptions)).toEqual(
      fixture.signals.map((signal) => ({ signal }))
    );
    expect(fixture.signals).toHaveLength(2);
    // the first request of the command asks only whether the port refunds, with no signal
    expect(options[0]?.portOptions).toEqual({});
  });
});

describe("a request whose audit cannot be written", () => {
  it("answers SERVICE_UNAVAILABLE billing_audit_unavailable, never success, though the act was done", async () => {
    const fixture = setup({ auditFailures: 1 });

    await expect(call(fixture, "cancelRenewal")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_audit_unavailable" },
    });

    expect(fixture.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(fixture.audited).toEqual([]);
  });

  it("recognizes the same request ID on the repeat: success, no new provider call, and exactly one accepted line in all", async () => {
    const fixture = setup({ auditFailures: 1 });
    await expect(call(fixture, "cancelRenewal")).rejects.toMatchObject({
      data: { reason: "billing_audit_unavailable" },
    });

    const again = await call(fixture, "cancelRenewal");

    expect(again).toMatchObject({ result: "cancelled" });
    expect(fixture.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(fixture.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(fixture.audited).toEqual([
      {
        eventType: "billing.owner_renewal_cancel_requested",
        requestId: REQUEST,
      },
    ]);
  });

  it("recognizes a refund already done on the repeat, with the accepted line written once and no new limit count", async () => {
    const fixture = setup({ auditFailures: 1 });
    await expect(call(fixture, "requestRefund")).rejects.toMatchObject({
      data: { reason: "billing_audit_unavailable" },
    });
    // the provider's webhook of the refund arrived meanwhile
    fixture.record.revoked = { reason: "refund" };

    const again = await call(fixture, "requestRefund");

    expect(again).toMatchObject({
      amount: "24.90",
      result: "refund_requested",
    });
    expect(fixture.audited).toEqual([
      { eventType: "billing.refund_requested", requestId: REQUEST },
    ]);
    expect(fixture.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(fixture.port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
  });

  it("answers the refusal it is when the audit of a refusal fails too", async () => {
    const fixture = setup({ auditFailures: 1, locked: true });

    await expect(call(fixture, "cancelRenewal")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "command_in_progress" },
    });
    expect(fixture.recordBillingRequestAudit).toHaveBeenCalledTimes(1);
    expect(fixture.audited).toEqual([]);
  });

  it("answers the provider's failure it is when the audit of that failure fails too", async () => {
    const fixture = setup({ auditFailures: 1, portFails: true });

    await expect(call(fixture, "cancelRenewal")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_provider_unavailable" },
    });
  });

  it("does not leak the error of the insert into the answer", async () => {
    const fixture = setup({ auditFailures: 1 });

    const error = await call(fixture, "cancelRenewal").then(
      () => null,
      (caught: unknown) => caught
    );

    expect(JSON.stringify(error)).not.toContain("insert failed");
  });
});
