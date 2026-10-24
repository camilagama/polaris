import {
  type BillingProviderPort,
  NotFirstChargeError,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  type RefundOutcome,
} from "@polaris/billing/provider-port";
import {
  BillingCommandInProgressError,
  type OwnerCommandRecord,
} from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { cancelRenewalEventId, refundCancelEventId } from "./commands";
import {
  OWNER_COMMAND_BUDGET_MS,
  type OwnerCommandAudit,
  OwnerCommandProviderFailure,
  OwnerCommandRefusal,
  type OwnerCommandRefusalCode,
  ownerCancelRenewal,
  ownerOpenOverduePayment,
  ownerRequestRefund,
  PROVIDER_CALL_TIMEOUT_MS,
} from "./owner-commands";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST = "22222222-2222-4222-8222-222222222222";
const HOUR = 3_600_000;

/** An instant in São Paulo (UTC-3, no daylight saving time since 2019). */
const sp = (local: string) => new Date(`${local}-03:00`);

const link = {
  provider: "asaas",
  providerRef: "link-ref-0001",
  providerSubscriptionId: "sub_link0001",
};

/** The `billing_events` row of the first charge (`first_charge_event_id`). */
const FIRST_CHARGE_EVENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/**
 * Paid by card on 10/10 at 15:00 in São Paulo (the window of the right of withdrawal ends 17/10 at 23:59:59), a
 * price that is not the first charge's amount, so the response is told apart.
 */
const activeRecord: OwnerCommandRecord = {
  accessEndsAt: sp("2026-11-11T00:00:00"),
  cancelAtPeriodEnd: false,
  cycleMonths: 12,
  firstCharge: {
    eventId: FIRST_CHARGE_EVENT,
    periodEndsAt: sp("2026-11-11T00:00:00"),
  },
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

const NOON_10 = sp("2026-10-10T16:00:00");

type Mocked<T> = { [K in keyof T]: T[K] & Mock };

interface WorldOptions {
  /** What `claimProviderCommand` answers. */
  claim?: boolean;
  /** The ledger already holds these provider event IDs. */
  ledger?: string[];
  /** The organization's command lock is held elsewhere. */
  locked?: boolean;
  now?: Date;
  /** `portFor` cannot build the port (not configured). */
  portThrows?: boolean;
  record?: Partial<OwnerCommandRecord>;
  refundsEnabled?: boolean;
}

/**
 * The store and the provider's port in memory, with one log of every call that matters in order. The store applies
 * what the real one would apply of a fact (a cancellation sets `cancelAtPeriodEnd`, a refund revokes the payment)
 * and keeps the anchor of the first refund request; the database's clock answers one second later on each read under
 * the lock (the read before it, of the refusals that call nothing, does not move it).
 */
function world(options: WorldOptions = {}) {
  const log: string[] = [];
  const record: OwnerCommandRecord = { ...activeRecord, ...options.record };
  const ledger = new Set(options.ledger ?? []);
  const events: Record<string, unknown>[] = [];
  const clock = { ms: 0, now: options.now ?? NOON_10, reads: 0 };
  const signals: {
    controller: AbortController;
    ms: number;
    signal: AbortSignal;
  }[] = [];
  const state: {
    anchorNull: boolean;
    claim: boolean;
    inLock: boolean;
    locked: boolean;
    portThrows: boolean;
  } = {
    anchorNull: false,
    claim: options.claim ?? true,
    inLock: false,
    locked: options.locked ?? false,
    portThrows: options.portThrows ?? false,
  };

  const port = {
    cancelRenewal: vi.fn(() => {
      log.push("cancelRenewal");
      return Promise.resolve("cancelled" as const);
    }),
    overduePaymentPage: vi.fn(() => {
      log.push("overduePaymentPage");
      return Promise.resolve<string | null>(
        "https://www.asaas.com/i/secret-invoice-page"
      );
    }),
    provider: record.link?.provider ?? "asaas",
    refundCurrentPeriod: vi.fn(() => {
      log.push("refund");
      return Promise.resolve<RefundOutcome>("refund_requested");
    }),
    refundsEnabled: options.refundsEnabled ?? true,
  };
  const portFor = vi.fn((_provider: string, _signal: AbortSignal) => {
    if (state.portThrows) {
      throw new ProviderNotConfiguredError();
    }
    return port as unknown as BillingProviderPort;
  });

  const store = {
    anchorRefundRequest: vi.fn(
      (
        _organizationId: string,
        input: { at: Date; providerRef: string; requestId: string }
      ) => {
        log.push("anchor");
        if (state.anchorNull) {
          return Promise.resolve(null);
        }
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
      log.push("claim");
      return Promise.resolve(state.claim);
    }),
    databaseNow: vi.fn(() => {
      if (!state.inLock) {
        // the read before the lock, for the refusals that call nothing: the clock does not move for it
        return Promise.resolve(new Date(clock.now.getTime()));
      }
      const read = new Date(clock.now.getTime() + 1000 * clock.reads);
      clock.reads += 1;
      return Promise.resolve(read);
    }),
    hasLedgerEvent: vi.fn((_provider: string, providerEventId: string) =>
      Promise.resolve(ledger.has(providerEventId))
    ),
    processEvent: vi.fn((eventId: string, _now?: Date) => {
      log.push("process");
      return Promise.resolve({
        eventId,
        organizationId,
        outcomeCode: null,
        status: "applied" as const,
      });
    }),
    readOwnerCommandRecord: vi.fn(() => Promise.resolve({ ...record })),
    recordCancellationFeedback: vi.fn(
      (_input: {
        cycleMonths: number | null;
        reason: string;
        state: string;
      }) => {
        log.push("feedback");
        return Promise.resolve();
      }
    ),
    recordEvent: vi.fn(
      (input: {
        fact: { type: string };
        providerEventId: string;
        [key: string]: unknown;
      }) => {
        log.push(`recordEvent:${input.fact.type}`);
        events.push(input);
        ledger.add(input.providerEventId);
        if (input.fact.type === "subscription_cancelled") {
          record.cancelAtPeriodEnd = true;
        }
        if (input.fact.type === "charge_refunded") {
          record.revoked = { reason: "refund" };
        }
        return Promise.resolve({ duplicate: false, id: `ev-${events.length}` });
      }
    ),
    withOrganizationLock: vi.fn(
      async (_organizationId: string, operation: () => Promise<unknown>) => {
        if (state.locked) {
          throw new BillingCommandInProgressError();
        }
        state.inLock = true;
        try {
          return await operation();
        } finally {
          state.inLock = false;
        }
      }
    ),
  };

  const timeoutSignal = vi.fn((ms: number) => {
    const controller = new AbortController();
    signals.push({ controller, ms, signal: controller.signal });
    return controller.signal;
  });

  return {
    /** Moves the database's clock for the next command and restarts its reads. */
    at(next: Date) {
      clock.now = next;
      clock.reads = 0;
    },
    clock,
    dependencies: {
      elapsedMs: () => clock.ms,
      portFor,
      store: store as unknown as Parameters<
        typeof ownerCancelRenewal
      >[0]["store"],
      timeoutSignal,
    },
    events,
    ledger,
    log,
    port: port as unknown as Mocked<typeof port>,
    portFor,
    record,
    signals,
    state,
    store: store as unknown as Mocked<typeof store>,
  };
}

type World = ReturnType<typeof world>;

const cancel = (w: World, input: { reason?: string | null } = {}) =>
  ownerCancelRenewal(w.dependencies, {
    organizationId,
    requestId: REQUEST,
    ...input,
  });
const refund = (w: World, requestId = REQUEST) =>
  ownerRequestRefund(w.dependencies, { organizationId, requestId });
const overdue = (w: World) =>
  ownerOpenOverduePayment(w.dependencies, {
    organizationId,
    requestId: REQUEST,
  });

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error
  );
}

/** Awaits a command that must refuse, and checks the refusal's code and the audit type of the request. */
async function expectRefusal(
  promise: Promise<unknown>,
  code: OwnerCommandRefusalCode,
  audit: OwnerCommandAudit
): Promise<void> {
  const error = await failureOf(promise);
  expect(error).toBeInstanceOf(OwnerCommandRefusal);
  expect(error).toMatchObject({ audit, code });
}

/** Awaits a command that must fail at the provider, audited as accepted. */
async function expectProviderFailure(
  promise: Promise<unknown>,
  audit: OwnerCommandAudit
): Promise<void> {
  const error = await failureOf(promise);
  expect(error).toBeInstanceOf(OwnerCommandProviderFailure);
  expect(error).toMatchObject({ audit, code: "provider_unavailable" });
}

let consoleSpies: ReturnType<typeof vi.spyOn>[];
let loggerSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  consoleSpies = (["debug", "info", "warn", "error", "log"] as const).map(
    (method) => vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  loggerSpies = (["debug", "info", "warn", "error"] as const).map((method) =>
    vi.spyOn(logger, method)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function everythingLogged(): string {
  return JSON.stringify(
    [...consoleSpies, ...loggerSpies].map((spy) => spy.mock.calls)
  );
}

const providerCalled = (w: World) =>
  w.port.cancelRenewal.mock.calls.length +
  w.port.refundCurrentPeriod.mock.calls.length +
  w.port.overduePaymentPage.mock.calls.length;

describe.each([
  ["ownerCancelRenewal", cancel, {}],
  ["ownerRequestRefund", (w: World) => refund(w), {}],
  ["ownerOpenOverduePayment", overdue, { state: "grace" as const }],
])("%s: the lock and the limit", (_name, run, record) => {
  it("answers command_in_progress, audited as in progress, when the lock is held elsewhere, and calls nothing", async () => {
    const w = world({ locked: true, record });

    await expectRefusal(
      run(w),
      "command_in_progress",
      "billing.command_in_progress"
    );

    expect(providerCalled(w)).toBe(0);
    expect(w.dependencies.timeoutSignal).not.toHaveBeenCalled();
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
    expect(w.store.recordEvent).not.toHaveBeenCalled();
  });

  it("answers billing_command_rate_limited, audited as rate limited, when the store's limit says no, and calls no provider", async () => {
    const w = world({ claim: false, record });

    await expectRefusal(
      run(w),
      "billing_command_rate_limited",
      "billing.command_rate_limited"
    );

    expect(providerCalled(w)).toBe(0);
    expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
    expect(w.store.recordEvent).not.toHaveBeenCalled();
  });

  it("counts the limit with the database's clock, the one reading of the command", async () => {
    const w = world({ now: sp("2026-10-10T16:00:00"), record });

    await run(w).catch(() => undefined);

    expect(w.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(w.store.claimProviderCommand).toHaveBeenCalledWith(
      organizationId,
      sp("2026-10-10T16:00:00")
    );
    // the clock was read once before the provider (a later read is the cancellation's own, after the answer)
    const [first] = w.store.databaseNow.mock.results;
    await expect(first?.value).resolves.toEqual(sp("2026-10-10T16:00:00"));
  });

  it("with the lock refused, has only read the record before it: nothing counted, anchored or written", async () => {
    const w = world({ locked: true, record });

    await run(w).catch(() => undefined);

    expect(w.store.readOwnerCommandRecord).toHaveBeenCalledTimes(1);
    expect(w.store.withOrganizationLock).toHaveBeenCalledTimes(1);
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
    expect(w.store.recordEvent).not.toHaveBeenCalled();
    expect(w.store.recordCancellationFeedback).not.toHaveBeenCalled();
  });
});

describe("ownerCancelRenewal", () => {
  it("cancels at the provider, writes its own fact through the inbox and leaves the end of the access alone", async () => {
    const w = world();

    const outcome = await cancel(w);

    expect(w.port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
    const recorded = w.events[0] as {
      fact: { occurredAt: Date; type: string };
      providerEventId: string;
    };
    expect(recorded).toMatchObject({
      fact: { type: "subscription_cancelled" },
      organizationId,
      provider: "asaas",
      providerRef: link.providerRef,
    });
    expect(recorded.providerEventId).toBe(
      await cancelRenewalEventId(REQUEST, link.providerRef)
    );
    expect(recorded.providerEventId).toMatch(
      new RegExp(`^command:cancel_renewal:${REQUEST}:[0-9a-f]{32}$`)
    );
    // the cancellation's moment is the database's clock after the provider answered (the second read)
    expect(recorded.fact.occurredAt).toEqual(
      new Date(NOON_10.getTime() + 1000)
    );
    expect(w.store.processEvent).toHaveBeenCalledWith(
      "ev-1",
      new Date(NOON_10.getTime() + 1000)
    );
    expect(w.log).toEqual([
      "claim",
      "cancelRenewal",
      "recordEvent:subscription_cancelled",
      "process",
    ]);
    expect(outcome).toEqual({
      audit: "billing.owner_renewal_cancel_requested",
      response: {
        accessEndsAt: activeRecord.accessEndsAt,
        result: "cancelled",
      },
    });
    expect(w.record.accessEndsAt).toEqual(activeRecord.accessEndsAt);
  });

  it("also cancels in grace, where it ends the provider's new tries (AS-28)", async () => {
    const w = world({ record: { state: "grace" } });

    const outcome = await cancel(w, { reason: "Too expensive" });

    expect(outcome.response.result).toBe("cancelled");
    expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(w.store.recordCancellationFeedback).toHaveBeenCalledWith({
      cycleMonths: 12,
      reason: "Too expensive",
      state: "grace",
    });
  });

  it("cancels in a trial too", async () => {
    const w = world({ record: { state: "trialing" } });

    await expect(cancel(w)).resolves.toMatchObject({
      response: { result: "cancelled" },
    });
  });

  it("records the cancellation when the provider already had it cancelled", async () => {
    const w = world();
    w.port.cancelRenewal.mockResolvedValueOnce("already_cancelled");

    await expect(cancel(w)).resolves.toMatchObject({
      audit: "billing.owner_renewal_cancel_requested",
      response: { result: "cancelled" },
    });
    expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("answers already_cancelled, audited as refused, for a record that already shows the cancellation, with no provider and no limit", async () => {
    const w = world({ record: { cancelAtPeriodEnd: true } });

    const outcome = await cancel(w);

    expect(outcome).toEqual({
      audit: "billing.command_refused",
      response: {
        accessEndsAt: activeRecord.accessEndsAt,
        result: "already_cancelled",
      },
    });
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(providerCalled(w)).toBe(0);
    expect(w.store.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no link", { link: null, provider: null }],
    ["a free record with a link", { state: "free" as const }],
    ["a record still setting up the trial", { state: "trial_setup" as const }],
    [
      "a free record that still carries cancelAtPeriodEnd",
      { cancelAtPeriodEnd: true, state: "free" as const },
    ],
  ])(
    "refuses with nothing_to_cancel for %s, with no limit and no provider",
    async (_name, record) => {
      const w = world({ record });

      await expectRefusal(
        cancel(w),
        "nothing_to_cancel",
        "billing.command_refused"
      );

      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    }
  );

  it("refuses with nothing_to_cancel, audited as accepted and writing nothing, when the provider has no subscription behind the link", async () => {
    const w = world();
    w.port.cancelRenewal.mockResolvedValueOnce("nothing_to_cancel");

    await expectRefusal(
      cancel(w),
      "nothing_to_cancel",
      "billing.owner_renewal_cancel_requested"
    );

    expect(w.store.recordEvent).not.toHaveBeenCalled();
  });

  it("recognizes its own request again (its audit failed): the same answer as accepted, with no limit, no provider and no second reason", async () => {
    const w = world();
    const first = await cancel(w, { reason: "Too expensive" });
    w.log.length = 0;

    const again = await cancel(w, { reason: "Too expensive" });

    expect(again).toEqual(first);
    expect(again.audit).toBe("billing.owner_renewal_cancel_requested");
    expect(again.response.result).toBe("cancelled");
    expect(w.log).toEqual([]);
    expect(w.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
    expect(w.store.recordCancellationFeedback).toHaveBeenCalledTimes(1);
  });

  it("recognizes its own request by the fact's ID even when the record shows no cancellation yet, and processes that fact again", async () => {
    const w = world();
    const eventId = await cancelRenewalEventId(REQUEST, link.providerRef);
    w.ledger.add(eventId);

    const outcome = await cancel(w, { reason: "again" });

    expect(outcome.audit).toBe("billing.owner_renewal_cancel_requested");
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(providerCalled(w)).toBe(0);
    expect(w.store.recordCancellationFeedback).not.toHaveBeenCalled();
    // the fact stored and not applied (its processing failed) goes through the inbox again, under its own ID
    expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
    expect(w.store.recordEvent.mock.calls[0]?.[0]).toMatchObject({
      providerEventId: eventId,
    });
    expect(w.store.processEvent).toHaveBeenCalledTimes(1);
    expect(w.record.cancelAtPeriodEnd).toBe(true);
  });

  it("audits as accepted, with billing_provider_unavailable, a cancellation the provider made whose fact the inbox could not write; the repeat writes it", async () => {
    const w = world();
    w.store.recordEvent.mockImplementationOnce(() =>
      Promise.reject(new Error("connection terminated"))
    );

    await expectProviderFailure(
      cancel(w),
      "billing.owner_renewal_cancel_requested"
    );
    expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(w.record.cancelAtPeriodEnd).toBe(false);

    const again = await cancel(w);

    expect(again.response.result).toBe("cancelled");
    expect(w.record.cancelAtPeriodEnd).toBe(true);
  });

  it("does not recognize a refund's cancellation fact (refund_cancel) of the same request ID: it goes the normal way", async () => {
    const w = world();
    w.ledger.add(await refundCancelEventId(REQUEST, link.providerRef));

    const outcome = await cancel(w);

    expect(outcome.response.result).toBe("cancelled");
    expect(w.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("does not recognize another request's cancellation fact", async () => {
    const w = world();
    w.ledger.add(await cancelRenewalEventId(OTHER_REQUEST, link.providerRef));

    await cancel(w);

    expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
  });

  it("fails with the provider's failure, audited as accepted, writing nothing and keeping the reason out", async () => {
    const w = world();
    w.port.cancelRenewal.mockRejectedValueOnce(new ProviderUnavailableError());

    await expectProviderFailure(
      cancel(w, { reason: "Too expensive" }),
      "billing.owner_renewal_cancel_requested"
    );

    expect(w.store.claimProviderCommand).toHaveBeenCalledTimes(1);
    expect(w.store.recordEvent).not.toHaveBeenCalled();
    expect(w.store.processEvent).not.toHaveBeenCalled();
    expect(w.store.recordCancellationFeedback).not.toHaveBeenCalled();
  });

  describe("the optional reason", () => {
    it("is kept after the cancellation, with the record's state and cycle, trimmed", async () => {
      const w = world({ record: { cycleMonths: 1, state: "trialing" } });

      await cancel(w, { reason: "  Too expensive  " });

      expect(w.store.recordCancellationFeedback).toHaveBeenCalledTimes(1);
      expect(w.store.recordCancellationFeedback).toHaveBeenCalledWith({
        cycleMonths: 1,
        reason: "Too expensive",
        state: "trialing",
      });
      expect(w.log.at(-1)).toBe("feedback");
      expect(w.log.indexOf("process")).toBeLessThan(w.log.indexOf("feedback"));
    });

    it("is kept with a null cycle when the record has none", async () => {
      const w = world({ record: { cycleMonths: null } });

      await cancel(w, { reason: "Too expensive" });

      expect(w.store.recordCancellationFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ cycleMonths: null })
      );
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["only spaces", "   \n "],
    ])("is not kept when it is %s", async (_name, reason) => {
      const w = world();

      await cancel(w, reason === undefined ? {} : { reason });

      expect(w.store.recordCancellationFeedback).not.toHaveBeenCalled();
    });

    it("is not kept for a request already answered as already_cancelled", async () => {
      const w = world({ record: { cancelAtPeriodEnd: true } });

      await cancel(w, { reason: "Too expensive" });

      expect(w.store.recordCancellationFeedback).not.toHaveBeenCalled();
    });

    it("does not fail the cancellation when keeping it fails", async () => {
      const w = world();
      w.store.recordCancellationFeedback.mockRejectedValueOnce(
        new Error("insert failed")
      );

      await expect(
        cancel(w, { reason: "Too expensive" })
      ).resolves.toMatchObject({
        audit: "billing.owner_renewal_cancel_requested",
        response: { result: "cancelled" },
      });
      expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
    });

    it("never reaches a log, not even when keeping it fails with the text in the error", async () => {
      const reason = "Ligue para fulana@example.com ou (11) 98765-4321";
      const ok = world();
      await cancel(ok, { reason });
      const failing = world();
      failing.store.recordCancellationFeedback.mockRejectedValueOnce(
        new Error(`insert failed for ${reason}`)
      );
      await cancel(failing, { reason });
      const providerDown = world();
      providerDown.port.cancelRenewal.mockRejectedValueOnce(
        new Error(`down while holding ${reason}`)
      );
      await failureOf(cancel(providerDown, { reason }));

      const logged = everythingLogged();
      expect(logged).not.toContain("fulana@example.com");
      expect(logged).not.toContain("98765-4321");
      expect(logged).not.toContain("Ligue para");
      // the loggers did write something (the commands log codes and opaque IDs)
      expect(logged).toContain("billing_owner_cancel_renewal");
    });
  });
});

describe("ownerRequestRefund", () => {
  describe("what is refused before anything is called", () => {
    it("sends a provider that does not refund here (Pix) to support, with no limit and no anchor", async () => {
      const w = world({ refundsEnabled: false });

      await expectRefusal(
        refund(w),
        "refund_via_support",
        "billing.command_refused"
      );

      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    });

    it("sends a provider whose port cannot be built to support too", async () => {
      const w = world({ portThrows: true });

      await expectRefusal(
        refund(w),
        "refund_via_support",
        "billing.command_refused"
      );

      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
    });

    it("refuses with nothing_to_refund when no first charge was recorded (it fails closed)", async () => {
      const w = world({
        record: { firstChargeAmount: null, firstChargeAt: null },
      });

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );

      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    });

    it("refuses with nothing_to_refund when there is no link", async () => {
      const w = world({ record: { link: null } });

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );
      expect(providerCalled(w)).toBe(0);
    });
  });

  describe("the window of the right of withdrawal", () => {
    it("refuses a first request after the window with nothing_to_refund, with no anchor and no provider", async () => {
      const w = world({ now: sp("2026-10-18T00:00:00") });

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );

      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
      expect(w.record.refundRequestedAt).toBeNull();
    });

    it("accepts a first request in the last second of the 7th day", async () => {
      const w = world({ now: sp("2026-10-17T23:59:59") });

      const outcome = await refund(w);

      expect(outcome.response.result).toBe("refund_requested");
      expect(w.store.anchorRefundRequest).toHaveBeenCalledTimes(1);
    });

    it("counts the window from the moment of the fact (firstChargeAt), not from when a late webhook was processed", async () => {
      // only `firstChargeAt` exists on the record: the fact's own time (10/10), even if the webhook came on 12/10
      const record = {
        firstChargeAt: sp("2026-10-10T15:00:00"),
        firstChargeOn: "2026-10-10",
      };
      const late = world({ now: sp("2026-10-18T00:00:01"), record });
      const inTime = world({ now: sp("2026-10-17T23:59:59"), record });

      await expectRefusal(
        refund(late),
        "nothing_to_refund",
        "billing.command_refused"
      );
      await expect(refund(inTime)).resolves.toMatchObject({
        response: { result: "refund_requested" },
      });
    });

    it("answers with the first charge's amount, not the price, and the window's last second", async () => {
      const w = world();

      const { response } = await refund(w);

      expect(response).toEqual({
        amount: "24.90",
        result: "refund_requested",
        until: sp("2026-10-17T23:59:59"),
      });
    });
  });

  describe("the first request", () => {
    it("claims the limit, writes the anchor at the database's clock with the request ID, and only then calls the provider", async () => {
      const w = world();

      const outcome = await refund(w);

      expect(w.log).toEqual([
        "claim",
        "anchor",
        "cancelRenewal",
        "recordEvent:subscription_cancelled",
        "process",
        "refund",
      ]);
      expect(w.store.anchorRefundRequest).toHaveBeenCalledWith(organizationId, {
        at: NOON_10,
        providerRef: link.providerRef,
        requestId: REQUEST,
      });
      expect(w.store.claimProviderCommand).toHaveBeenCalledWith(
        organizationId,
        NOON_10
      );
      // the refund is judged with the same reading, not with the later one of the cancellation, and only for the
      // first charge recorded
      expect(w.port.refundCurrentPeriod).toHaveBeenCalledWith(
        link.providerRef,
        NOON_10,
        link.providerSubscriptionId,
        {
          eventId: FIRST_CHARGE_EVENT,
          periodEndsAt: sp("2026-11-11T00:00:00"),
        }
      );
      expect(outcome.audit).toBe("billing.refund_requested");
      expect(w.record.refundRequestId).toBe(REQUEST);
    });

    it("does not write the anchor for a request the limit barred", async () => {
      const w = world({ claim: false });

      await expectRefusal(
        refund(w),
        "billing_command_rate_limited",
        "billing.command_rate_limited"
      );

      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
      expect(w.record.refundRequestedAt).toBeNull();
    });

    it("refuses with nothing_to_refund when the link changed between the read and the anchor, calling no provider", async () => {
      const w = world();
      w.state.anchorNull = true;

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );

      expect(providerCalled(w)).toBe(0);
    });

    it("hands Woovi's fact to the inbox when the port answers one (refundsEnabled)", async () => {
      const wooviLink = {
        provider: "woovi",
        providerRef: "woovi-sub-ref-0001",
        providerSubscriptionId: "woovi-sub-0001",
      };
      const w = world({
        record: { link: wooviLink, provider: "woovi" },
      });
      const periodEndsAt = sp("2026-11-11T00:00:00");
      w.port.refundCurrentPeriod.mockResolvedValueOnce({
        event: {
          fact: {
            occurredAt: sp("2026-10-10T16:00:05"),
            periodEndsAt,
            type: "charge_refunded",
          },
          providerEventId: "woovi-refund-event-1",
          providerRef: wooviLink.providerRef,
          providerSubscriptionId: wooviLink.providerSubscriptionId,
        },
        kind: "refund_requested",
      });

      const outcome = await refund(w);

      expect(outcome.response.result).toBe("refund_requested");
      const refundEvent = w.events.find(
        (event) => (event.fact as { type: string }).type === "charge_refunded"
      );
      expect(refundEvent).toMatchObject({
        fact: { periodEndsAt, type: "charge_refunded" },
        organizationId,
        provider: "woovi",
        providerEventId: "woovi-refund-event-1",
        providerRef: wooviLink.providerRef,
        providerSubscriptionId: wooviLink.providerSubscriptionId,
      });
      expect(w.log.at(-2)).toBe("recordEvent:charge_refunded");
      expect(w.log.at(-1)).toBe("process");
    });
  });

  describe("the cancellation that goes before the refund", () => {
    it("cancels the renewal, writes the fact under the refund's own ID, and then refunds", async () => {
      const w = world();

      await refund(w);

      const fact = w.events[0] as { providerEventId: string };
      expect(fact.providerEventId).toBe(
        await refundCancelEventId(REQUEST, link.providerRef)
      );
      expect(fact.providerEventId).toMatch(
        new RegExp(`^command:refund_cancel:${REQUEST}:[0-9a-f]{32}$`)
      );
      expect(w.port.cancelRenewal).toHaveBeenCalledWith(
        link.providerRef,
        link.providerSubscriptionId
      );
      expect(w.log.indexOf("cancelRenewal")).toBeLessThan(
        w.log.indexOf("recordEvent:subscription_cancelled")
      );
      expect(w.log.indexOf("recordEvent:subscription_cancelled")).toBeLessThan(
        w.log.indexOf("refund")
      );
    });

    it("skips the cancellation step when the record already shows the renewal cancelled, and writes no second fact", async () => {
      const w = world({ record: { cancelAtPeriodEnd: true } });

      const outcome = await refund(w);

      expect(w.port.cancelRenewal).not.toHaveBeenCalled();
      expect(w.store.recordEvent).not.toHaveBeenCalled();
      expect(w.port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
      expect(outcome.response.result).toBe("refund_requested");
    });

    it("cancels at the provider but writes no fact for a record that no longer gives Pro", async () => {
      const w = world({ record: { state: "free" } });

      await refund(w);

      expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
      expect(w.store.recordEvent).not.toHaveBeenCalled();
      expect(w.port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
    });

    it("refunds nothing and keeps the anchor when the cancellation fails, audited as accepted", async () => {
      const w = world();
      w.port.cancelRenewal.mockRejectedValueOnce(
        new ProviderUnavailableError()
      );

      await expectProviderFailure(refund(w), "billing.refund_requested");

      expect(w.store.anchorRefundRequest).toHaveBeenCalledTimes(1);
      expect(w.record.refundRequestedAt).toEqual(NOON_10);
      expect(w.port.refundCurrentPeriod).not.toHaveBeenCalled();
      expect(w.store.recordEvent).not.toHaveBeenCalled();
    });

    it("is not repeated when the refund failed: one cancelled fact and one refund in all, across two request IDs", async () => {
      const w = world();
      w.port.refundCurrentPeriod.mockRejectedValueOnce(
        new ProviderUnavailableError()
      );

      const first = await refund(w, REQUEST);
      expect(first.response.result).toBe("refund_pending");
      expect(first.audit).toBe("billing.refund_requested");
      // the renewal is cancelled and the anchor stands
      expect(w.record.cancelAtPeriodEnd).toBe(true);
      expect(w.record.refundRequestId).toBe(REQUEST);

      w.at(sp("2026-10-10T17:00:00"));
      const second = await refund(w, OTHER_REQUEST);

      expect(second.response.result).toBe("refund_requested");
      expect(second.audit).toBe("billing.refund_requested");
      expect(
        w.events.filter(
          (event) =>
            (event.fact as { type: string }).type === "subscription_cancelled"
        )
      ).toHaveLength(1);
      expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
      expect(w.store.anchorRefundRequest).toHaveBeenCalledTimes(1);
      expect(w.port.refundCurrentPeriod).toHaveBeenCalledTimes(2);
      const outcomes = await Promise.allSettled(
        w.port.refundCurrentPeriod.mock.results.map((result) => result.value)
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "rejected",
        "fulfilled",
      ]);
    });
  });

  describe("the refund step", () => {
    it("answers refund_pending, not an error, when the refund fails, with the renewal already cancelled", async () => {
      const w = world();
      w.port.refundCurrentPeriod.mockRejectedValueOnce(
        new ProviderUnavailableError()
      );

      const outcome = await refund(w);

      expect(outcome).toEqual({
        audit: "billing.refund_requested",
        response: {
          amount: "24.90",
          result: "refund_pending",
          until: sp("2026-10-17T23:59:59"),
        },
      });
      expect(w.store.recordEvent).toHaveBeenCalledTimes(1);
    });

    it("answers refund_pending when the port finds nothing to refund and the anchor is in time (never a conflict)", async () => {
      const w = world();
      w.port.refundCurrentPeriod.mockResolvedValueOnce("nothing_to_refund");

      const outcome = await refund(w);

      expect(outcome.response.result).toBe("refund_pending");
      expect(outcome.audit).toBe("billing.refund_requested");
    });

    it("finishes a request made on the 7th day and failed, when it is repeated 2 hours later", async () => {
      const w = world({ now: sp("2026-10-17T20:00:00") });
      w.port.refundCurrentPeriod.mockRejectedValueOnce(
        new ProviderUnavailableError()
      );
      expect((await refund(w)).response.result).toBe("refund_pending");

      w.at(sp("2026-10-17T22:00:00"));
      const again = await refund(w);

      expect(again.response.result).toBe("refund_requested");
      expect(again.response.until).toEqual(sp("2026-10-17T23:59:59"));
    });

    it("judges a repeat at the anchor: asked at 23:58 of the last day, finished at 00:05 of the 8th", async () => {
      const w = world({ now: sp("2026-10-17T23:58:00") });
      w.port.refundCurrentPeriod.mockRejectedValueOnce(
        new ProviderUnavailableError()
      );
      expect((await refund(w)).response.result).toBe("refund_pending");
      expect(w.record.refundRequestedAt).toEqual(sp("2026-10-17T23:58:00"));

      w.at(sp("2026-10-18T00:05:00"));
      const again = await refund(w);

      expect(again.response.result).toBe("refund_requested");
      expect(again.audit).toBe("billing.refund_requested");
      expect(w.store.anchorRefundRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("72 hours after the anchor", () => {
    const anchoredAt = sp("2026-10-17T23:00:00");
    const anchored = {
      cancelAtPeriodEnd: true,
      refundRequestedAt: anchoredAt,
      refundRequestId: REQUEST,
    };

    it("still finishes the refund exactly 72 hours later (the anchor, not today, is what the window is judged at)", async () => {
      const w = world({
        now: new Date(anchoredAt.getTime() + 72 * HOUR),
        record: anchored,
      });

      const outcome = await refund(w);

      expect(outcome.response.result).toBe("refund_requested");
      expect(w.port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
    });

    it("answers refund_window_expired 72 hours and 1 second later, calling no provider, and logs only codes and opaque IDs", async () => {
      const w = world({
        now: new Date(anchoredAt.getTime() + 72 * HOUR + 1000),
        record: anchored,
      });

      await expectRefusal(
        refund(w),
        "refund_window_expired",
        "billing.command_refused"
      );

      expect(providerCalled(w)).toBe(0);
      const warns = loggerSpies
        .flatMap((spy) => spy.mock.calls)
        .filter(([event]) => event === "billing_refund_window_expired");
      expect(warns).toHaveLength(1);
      const fields = warns[0]?.[1] as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual([
        "organizationId",
        "provider",
        "renewalCancelled",
      ]);
      expect(fields).toMatchObject({
        provider: "asaas",
        renewalCancelled: true,
      });
      // the store's ID is the logger's canonical opaque ID (an id the system minted, not a name); the request ID,
      // the link's reference and the provider's subscription are not in the log
      expect(fields.organizationId).toBe(organizationId);
      const logged = everythingLogged();
      for (const value of [
        REQUEST,
        link.providerRef,
        link.providerSubscriptionId,
      ]) {
        expect(logged).not.toContain(value);
      }
    });
  });

  it("leaves the renewal to cancel when the cancellation failed and the 72 hours ran out: refund_window_expired, then cancelRenewal works", async () => {
    const w = world();
    w.port.cancelRenewal.mockImplementationOnce(() =>
      Promise.reject(new ProviderUnavailableError())
    );
    await expectProviderFailure(refund(w), "billing.refund_requested");
    expect(w.record.refundRequestedAt).toEqual(NOON_10);
    expect(w.record.cancelAtPeriodEnd).toBe(false);

    w.at(new Date(NOON_10.getTime() + 73 * HOUR));
    await expectRefusal(
      refund(w, OTHER_REQUEST),
      "refund_window_expired",
      "billing.command_refused"
    );
    // the read shows the renewal alive (`renewalCancelled` is the record's flag), and the owner may still cancel it
    expect(w.record.cancelAtPeriodEnd).toBe(false);
    const cancelled = await cancel(w);
    expect(cancelled.response.result).toBe("cancelled");
    expect(w.record.cancelAtPeriodEnd).toBe(true);
  });

  describe("a refund already done", () => {
    const done = {
      cancelAtPeriodEnd: true,
      refundRequestedAt: NOON_10,
      refundRequestId: REQUEST,
      revoked: { reason: "refund" as const },
      state: "free" as const,
    };
    const sameAnswer = {
      amount: "24.90",
      result: "refund_requested",
      until: sp("2026-10-17T23:59:59"),
    };

    it("answers the request that anchored it again as accepted, with no limit and no provider", async () => {
      const w = world({ now: sp("2026-10-12T09:00:00"), record: done });

      const outcome = await refund(w, REQUEST);

      expect(outcome).toEqual({
        audit: "billing.refund_requested",
        response: sameAnswer,
      });
      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    });

    it("gives the same answer to another request ID, audited as refused", async () => {
      const w = world({ now: sp("2026-10-12T09:00:00"), record: done });

      const outcome = await refund(w, OTHER_REQUEST);

      expect(outcome).toEqual({
        audit: "billing.command_refused",
        response: sameAnswer,
      });
      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    });

    it("recognizes the request whose own refund_cancel fact is in the ledger, as accepted", async () => {
      const w = world({
        now: sp("2026-10-12T09:00:00"),
        record: { ...done, refundRequestId: "someone-elses-request" },
      });
      w.ledger.add(await refundCancelEventId(OTHER_REQUEST, link.providerRef));

      const outcome = await refund(w, OTHER_REQUEST);

      expect(outcome.audit).toBe("billing.refund_requested");
      expect(outcome.response).toEqual(sameAnswer);
      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    });

    it("does not recognize the cancel-renewal command's fact for the same request ID", async () => {
      const w = world({
        now: sp("2026-10-12T09:00:00"),
        record: { ...done, refundRequestId: "someone-elses-request" },
      });
      w.ledger.add(await cancelRenewalEventId(OTHER_REQUEST, link.providerRef));

      const outcome = await refund(w, OTHER_REQUEST);

      expect(outcome.audit).toBe("billing.command_refused");
    });

    it("answers nothing_to_refund, never a made-up amount, when the first charge's amount is not recorded", async () => {
      const w = world({ record: { ...done, firstChargeAmount: null } });

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );
    });

    it("sends Pix to support first, even without a first charge recorded", async () => {
      const w = world({
        record: { firstChargeAmount: null, firstChargeAt: null },
        refundsEnabled: false,
      });

      await expectRefusal(
        refund(w),
        "refund_via_support",
        "billing.command_refused"
      );
    });

    it("keeps sending Pix to support even after a refund (the first step wins)", async () => {
      const w = world({ record: done, refundsEnabled: false });

      await expectRefusal(
        refund(w),
        "refund_via_support",
        "billing.command_refused"
      );
    });
  });

  it("documents gap (b) of ADR 0104: a request that finished a pending refund with another request ID is accepted, but its repeat after the refund is audited as refused", async () => {
    // the renewal was already cancelled and the anchor is another request's: this request writes no fact and no anchor
    const w = world({
      now: sp("2026-10-11T09:00:00"),
      record: {
        cancelAtPeriodEnd: true,
        refundRequestedAt: sp("2026-10-10T16:00:00"),
        refundRequestId: OTHER_REQUEST,
      },
    });

    const finishing = await refund(w, REQUEST);

    expect(finishing.audit).toBe("billing.refund_requested");
    expect(finishing.response.result).toBe("refund_requested");
    expect(w.store.recordEvent).not.toHaveBeenCalled();
    expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();

    // the refund is done now (the webhook came) and the audit of the finishing request is retried
    w.record.revoked = { reason: "refund" };
    const repeated = await refund(w, REQUEST);

    expect(repeated.response).toEqual(finishing.response);
    expect(repeated.audit).toBe("billing.command_refused");
  });
});

describe("the refusals that call nothing come before the lock (the isolate's one command lock)", () => {
  // `locked`: the lock is refused, as when another command of this isolate (of any store) holds the one it allows
  it.each([
    [
      "ownerCancelRenewal, nothing_to_cancel with no link",
      cancel,
      { link: null },
      "nothing_to_cancel",
    ],
    [
      "ownerCancelRenewal, nothing_to_cancel out of trial, paid or grace",
      cancel,
      { state: "free_over_limit" as const },
      "nothing_to_cancel",
    ],
    [
      "ownerRequestRefund, nothing_to_refund with no link",
      (w: World) => refund(w),
      { link: null },
      "nothing_to_refund",
    ],
    [
      "ownerRequestRefund, nothing_to_refund with no first charge event",
      (w: World) => refund(w),
      { firstCharge: { eventId: null, periodEndsAt: null } },
      "nothing_to_refund",
    ],
    [
      "ownerOpenOverduePayment, no_overdue_payment out of grace",
      overdue,
      {},
      "no_overdue_payment",
    ],
  ] as const)(
    "%s: answered with the lock taken elsewhere, without asking for it",
    async (_name, run, record, code) => {
      const w = world({ locked: true, record });

      await expectRefusal(run(w), code, "billing.command_refused");

      expect(w.store.withOrganizationLock).not.toHaveBeenCalled();
      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    }
  );

  it("ownerCancelRenewal, already_cancelled: answered with the lock taken elsewhere, without asking for it", async () => {
    const w = world({ locked: true, record: { cancelAtPeriodEnd: true } });

    const outcome = await cancel(w);

    expect(outcome).toEqual({
      audit: "billing.command_refused",
      response: {
        accessEndsAt: activeRecord.accessEndsAt,
        result: "already_cancelled",
      },
    });
    expect(w.store.withOrganizationLock).not.toHaveBeenCalled();
    expect(providerCalled(w)).toBe(0);
  });

  it("ownerRequestRefund, refund_via_support: answered with the lock taken elsewhere, without asking for it", async () => {
    const w = world({ locked: true, refundsEnabled: false });

    await expectRefusal(
      refund(w),
      "refund_via_support",
      "billing.command_refused"
    );

    expect(w.store.withOrganizationLock).not.toHaveBeenCalled();
    expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
  });

  it("ownerRequestRefund, the window closed with no anchor: judged at the database's clock before the lock, and not counted in the limit", async () => {
    const w = world({ locked: true, now: sp("2026-10-18T00:00:00") });

    await expectRefusal(
      refund(w),
      "nothing_to_refund",
      "billing.command_refused"
    );

    expect(w.store.databaseNow).toHaveBeenCalledTimes(1);
    expect(w.store.withOrganizationLock).not.toHaveBeenCalled();
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
  });

  it("still judges under the lock what the read before it let through: a cancellation seen meanwhile is already_cancelled, with no provider", async () => {
    const w = world();
    w.store.readOwnerCommandRecord
      .mockResolvedValueOnce({ ...activeRecord })
      .mockResolvedValueOnce({ ...activeRecord, cancelAtPeriodEnd: true });

    const outcome = await cancel(w);

    expect(outcome.response.result).toBe("already_cancelled");
    expect(w.store.withOrganizationLock).toHaveBeenCalledTimes(1);
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(providerCalled(w)).toBe(0);
  });

  it("still judges under the lock what the read before it let through: a refund whose link went away meanwhile is nothing_to_refund", async () => {
    const w = world();
    w.store.readOwnerCommandRecord
      .mockResolvedValueOnce({ ...activeRecord })
      .mockResolvedValueOnce({ ...activeRecord, link: null });

    await expectRefusal(
      refund(w),
      "nothing_to_refund",
      "billing.command_refused"
    );

    expect(w.store.withOrganizationLock).toHaveBeenCalledTimes(1);
    expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
    expect(providerCalled(w)).toBe(0);
  });
});

describe("the owner's refund refunds only the first charge recorded (first_charge_event_id)", () => {
  it.each([
    ["no event", { eventId: null, periodEndsAt: sp("2026-11-11T00:00:00") }],
    [
      "no period of that event",
      { eventId: FIRST_CHARGE_EVENT, periodEndsAt: null },
    ],
  ])(
    "refuses with nothing_to_refund when the record has %s, cancelling and refunding nothing",
    async (_label, firstCharge) => {
      const w = world({ record: { firstCharge } });

      await expectRefusal(
        refund(w),
        "nothing_to_refund",
        "billing.command_refused"
      );

      expect(providerCalled(w)).toBe(0);
      expect(w.store.anchorRefundRequest).not.toHaveBeenCalled();
    }
  );

  it("answers refund_pending, refunding nothing, when the port finds another charge in force, and tells the operator's log why", async () => {
    const w = world();
    w.port.refundCurrentPeriod.mockImplementationOnce(() => {
      w.log.push("refund");
      return Promise.reject(new NotFirstChargeError());
    });

    const outcome = await refund(w);

    expect(outcome.response.result).toBe("refund_pending");
    expect(w.port.refundCurrentPeriod).toHaveBeenCalledWith(
      link.providerRef,
      expect.any(Date),
      link.providerSubscriptionId,
      activeRecord.firstCharge
    );
    expect(w.log).not.toContain("recordEvent:charge_refunded");
    expect(w.record.revoked).toBeNull();
    expect(everythingLogged()).toContain(
      "billing_owner_refund_not_first_charge"
    );
  });
});

describe("the provider calls' deadlines", () => {
  it("gives one call at most 15 s, below the 60 s the lock's idle transaction lasts", async () => {
    const w = world();

    await cancel(w);

    expect(PROVIDER_CALL_TIMEOUT_MS).toBe(15_000);
    expect(PROVIDER_CALL_TIMEOUT_MS).toBeLessThan(60_000);
    expect(OWNER_COMMAND_BUDGET_MS).toBe(45_000);
    expect(w.signals.map((entry) => entry.ms)).toEqual([15_000]);
  });

  it("builds the port of each call with the very signal the timeout gave", async () => {
    const w = world();

    await refund(w);

    const timed = w.signals.map((entry) => entry.signal);
    const signed = w.portFor.mock.calls.filter(([, signal]) =>
      timed.includes(signal)
    );
    expect(w.signals.length).toBe(2);
    expect(signed.map(([, signal]) => signal)).toEqual(timed);
    expect(signed.every(([provider]) => provider === "asaas")).toBe(true);
    // the read of refundsEnabled (no request goes through it) also gets a signal, one that never aborts
    const others = w.portFor.mock.calls.filter(
      ([, signal]) => !timed.includes(signal)
    );
    expect(others.length).toBeGreaterThan(0);
    expect(others.every(([, signal]) => signal instanceof AbortSignal)).toBe(
      true
    );
    expect(others.some(([, signal]) => signal.aborted)).toBe(false);
  });

  it("answers in time, and makes no next call, when the port ignores the signal (AbortSignal required, ADR 0104)", async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      // the real deadline: an AbortSignal after `ms` on the (fake) timers
      w.dependencies.timeoutSignal.mockImplementation((ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        w.signals.push({ controller, ms, signal: controller.signal });
        return controller.signal;
      });
      // a port that never looks at its signal: it answers 20 s later, past the 15 s of the call
      w.port.cancelRenewal.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("cancelled" as const), 20_000);
          })
      );
      let settled = false;
      const pending = failureOf(refund(w)).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(PROVIDER_CALL_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;

      expect(error).toBeInstanceOf(OwnerCommandProviderFailure);
      expect(error).toMatchObject({ audit: "billing.refund_requested" });
      // the late answer of the ignored call changes nothing: no fact, no refund, no next call
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.port.cancelRenewal).toHaveBeenCalledTimes(1);
      expect(w.port.refundCurrentPeriod).not.toHaveBeenCalled();
      expect(w.store.recordEvent).not.toHaveBeenCalled();
      expect(w.signals).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [0, 15_000],
    [30_000, 15_000],
    [30_001, 14_999],
    [40_000, 5000],
    [44_999, 1],
  ])(
    "with %i ms spent, gives the next call min(15 s, what is left of 45 s) = %i ms",
    async (spent, expected) => {
      const w = world();
      w.port.cancelRenewal.mockImplementationOnce(() => {
        w.clock.ms = spent;
        return Promise.resolve("cancelled" as const);
      });

      await refund(w);

      expect(w.signals.map((entry) => entry.ms)).toEqual([15_000, expected]);
    }
  );

  it.each([45_000, 46_000])(
    "answers refund_pending, calling no refund, when %i ms are gone before the second call",
    async (spent) => {
      const w = world();
      w.port.cancelRenewal.mockImplementationOnce(() => {
        w.clock.ms = spent;
        return Promise.resolve("cancelled" as const);
      });

      const outcome = await refund(w);

      expect(outcome.response.result).toBe("refund_pending");
      expect(w.port.refundCurrentPeriod).not.toHaveBeenCalled();
      expect(w.signals).toHaveLength(1);
    }
  );

  it("rejects a call whose port never answers once the signal aborts: the cancellation fails as the provider's", async () => {
    const w = world();
    w.port.cancelRenewal.mockImplementationOnce(
      () => new Promise<never>(() => undefined)
    );

    const pending = failureOf(cancel(w));
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    w.signals[0]?.controller.abort();

    const error = await pending;
    expect(error).toBeInstanceOf(OwnerCommandProviderFailure);
    expect(error).toMatchObject({
      audit: "billing.owner_renewal_cancel_requested",
    });
    expect(w.store.recordEvent).not.toHaveBeenCalled();
  });

  it("makes a refund whose port never answers refund_pending when the signal aborts", async () => {
    const w = world();
    w.port.refundCurrentPeriod.mockImplementationOnce(
      () => new Promise<never>(() => undefined)
    );

    const pending = refund(w);
    await vi.waitFor(() => expect(w.signals).toHaveLength(2));
    w.signals[1]?.controller.abort();

    await expect(pending).resolves.toMatchObject({
      response: { result: "refund_pending" },
    });
  });

  it("does not call a port whose signal is already aborted", async () => {
    const w = world();
    w.dependencies.timeoutSignal.mockImplementationOnce((ms: number) => {
      const controller = new AbortController();
      controller.abort();
      w.signals.push({ controller, ms, signal: controller.signal });
      return controller.signal;
    });

    await expectProviderFailure(
      cancel(w),
      "billing.owner_renewal_cancel_requested"
    );

    expect(w.port.cancelRenewal).not.toHaveBeenCalled();
  });
});

describe("ownerOpenOverduePayment", () => {
  const PAGE = "https://www.asaas.com/i/secret-invoice-page";
  const grace = { state: "grace" as const };

  it("gives the provider's page in grace with the card, audited as opened, and never logs the address", async () => {
    const w = world({ record: grace });

    const outcome = await overdue(w);

    expect(outcome).toEqual({
      audit: "billing.overdue_payment_opened",
      response: { url: PAGE },
    });
    expect(w.port.overduePaymentPage).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(w.log).toEqual(["claim", "overduePaymentPage"]);
    expect(everythingLogged()).not.toContain("secret-invoice-page");
    expect(everythingLogged()).toContain("billing_overdue_payment_opened");
  });

  it.each([
    ["active", { state: "active" as const }],
    ["trialing", { state: "trialing" as const }],
    ["free", { state: "free" as const }],
    [
      "grace with Pix",
      {
        link: { ...link, provider: "woovi" },
        provider: "woovi",
        state: "grace" as const,
      },
    ],
    ["grace with no link", { link: null, state: "grace" as const }],
  ])(
    "refuses with no_overdue_payment, with no limit and no provider, in %s",
    async (_name, record) => {
      const w = world({ record });

      await expectRefusal(
        overdue(w),
        "no_overdue_payment",
        "billing.command_refused"
      );

      expect(w.store.claimProviderCommand).not.toHaveBeenCalled();
      expect(providerCalled(w)).toBe(0);
    }
  );

  it("refuses with no_overdue_payment, audited as accepted, when the provider has no charge that failed", async () => {
    const w = world({ record: grace });
    w.port.overduePaymentPage.mockResolvedValueOnce(null);

    await expectRefusal(
      overdue(w),
      "no_overdue_payment",
      "billing.overdue_payment_opened"
    );

    expect(w.store.claimProviderCommand).toHaveBeenCalledTimes(1);
  });

  it("fails with the provider's failure, audited as accepted, and logs nothing of the address", async () => {
    const w = world({ record: grace });
    w.port.overduePaymentPage.mockRejectedValueOnce(
      new Error(`bad answer with ${PAGE}`)
    );

    await expectProviderFailure(overdue(w), "billing.overdue_payment_opened");

    expect(everythingLogged()).not.toContain("secret-invoice-page");
  });
});
