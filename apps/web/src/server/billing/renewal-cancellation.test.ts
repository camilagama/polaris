import {
  type BillingProviderPort,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import type { BillingStore } from "@polaris/db/billing-store";
import { queueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermanentHandlerError } from "../queue/consumer";
import {
  handleRenewalCancelRequested,
  RENEWAL_CANCEL_REARM_BATCH,
  RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS,
  rearmRenewalCancellations,
} from "./renewal-cancellation";

const now = new Date("2026-10-20T12:00:00.000Z");
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const REQUESTED_AT = 1_792_457_258_261;
const EVENT_ID = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2d";
const link = {
  provider: "asaas",
  providerRef: "pol_link0001",
  providerSubscriptionId: "sub_link0001",
};
const alive = {
  accessEndsAt: new Date("2026-11-20T12:00:00.000Z"),
  cancelAtPeriodEnd: false,
  state: "active",
};

function envelope(overrides: Record<string, unknown> = {}) {
  return queueEnvelope({
    attempt: 1,
    correlationId: "req-1",
    event: { requestedAt: REQUESTED_AT },
    eventId: EVENT_ID,
    idempotencyKey: `billing.renewal_cancel_requested:${REQUESTED_AT}`,
    organizationId,
    type: "billing.renewal_cancel_requested",
    ...overrides,
  });
}

/**
 * A billing record that behaves like the store: the cancellation fact, once
 * applied, marks the cancellation at the end of the period, and a repeat of
 * the same provider event ID is a duplicate that changes nothing.
 */
function fakeStore(record: Record<string, unknown> | null = alive) {
  const state = { record, linked: record ? link : null };
  const stored = new Map<string, string>();
  const store = {
    processEvent: vi.fn((id: string) => {
      if (state.record) {
        state.record = { ...state.record, cancelAtPeriodEnd: true };
      }
      return Promise.resolve({
        eventId: id,
        organizationId,
        outcomeCode: null,
        status: "applied",
      });
    }),
    readProviderLink: vi.fn(() => Promise.resolve(state.linked)),
    readRecord: vi.fn(() => Promise.resolve(state.record)),
    recordEvent: vi.fn((input: { providerEventId: string }) => {
      const known = stored.get(input.providerEventId);
      if (known) {
        return Promise.resolve({ duplicate: true, id: known });
      }
      const id = `ev-${stored.size + 1}`;
      stored.set(input.providerEventId, id);
      return Promise.resolve({ duplicate: false, id });
    }),
  };
  return { state, store: store as unknown as BillingStore & typeof store };
}

function fakePort(
  cancel: BillingProviderPort["cancelRenewal"] = () =>
    Promise.resolve("cancelled")
) {
  return {
    cancelRenewal: vi.fn(cancel),
    provider: "asaas",
  } as unknown as BillingProviderPort & {
    cancelRenewal: ReturnType<typeof vi.fn>;
  };
}

function dependencies(
  store: BillingStore,
  port: BillingProviderPort,
  handles = (provider: string) => provider === "asaas"
) {
  return {
    handles,
    now: () => now,
    portFor: vi.fn(() => port),
    store,
  };
}

describe("handleRenewalCancelRequested", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels the renewal at the provider and records it through the inbox, once per closure cycle", async () => {
    const { store, state } = fakeStore();
    const port = fakePort();

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("cancelled");

    // the subscription the record stored, by its `sub_`
    expect(port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        fact: { occurredAt: now, type: "subscription_cancelled" },
        organizationId,
        provider: "asaas",
        providerEventId: `command:cancel_renewal:${EVENT_ID}`,
        providerRef: link.providerRef,
      })
    );
    expect(store.processEvent).toHaveBeenCalledWith("ev-1", now);
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("does nothing on a second delivery: the record already says cancelled (idempotent)", async () => {
    const { store } = fakeStore();
    const port = fakePort();
    const run = () =>
      handleRenewalCancelRequested(dependencies(store, port), envelope());

    await run();
    await expect(run()).resolves.toBe("nothing_owed");

    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a provider linked (a free organization, or one that never subscribed)", async () => {
    const { store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "free",
    });
    store.readProviderLink.mockResolvedValue(null);
    const port = fakePort();

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("nothing_owed");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no billing record", null],
    [
      "a record that no longer gives Pro",
      { accessEndsAt: null, cancelAtPeriodEnd: false, state: "free" },
    ],
    ["a renewal already cancelled", { ...alive, cancelAtPeriodEnd: true }],
  ])("does nothing with %s", async (_label, record) => {
    const { store } = fakeStore(record);
    store.readProviderLink.mockResolvedValue(link);
    const port = fakePort();

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("nothing_owed");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
  });

  it("leaves a provider Polaris does not cancel through to the person, without calling it", async () => {
    const { store } = fakeStore();
    store.readProviderLink.mockResolvedValue({ ...link, provider: "woovi" });
    const port = fakePort();
    const deps = dependencies(store, port);

    await expect(handleRenewalCancelRequested(deps, envelope())).resolves.toBe(
      "not_handled"
    );
    expect(deps.portFor).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("throws when the provider is down, records nothing, and works on the next delivery", async () => {
    const { store, state } = fakeStore();
    // down on the first call, back on the next
    const port = fakePort(
      vi
        .fn<BillingProviderPort["cancelRenewal"]>()
        .mockRejectedValueOnce(new ProviderUnavailableError())
        .mockResolvedValue("cancelled")
    );

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: false });

    // the queue's retry (or the hourly rearm) brings the same event back
    await expect(
      handleRenewalCancelRequested(
        dependencies(store, port),
        envelope({ attempt: 2 })
      )
    ).resolves.toBe("cancelled");
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("throws when the provider's settings are missing, so the queue retries and the dead letter tells", async () => {
    const { store } = fakeStore();
    const deps = {
      ...dependencies(store, fakePort()),
      portFor: vi.fn(() => {
        throw new ProviderNotConfiguredError();
      }),
    };

    await expect(
      handleRenewalCancelRequested(deps, envelope())
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("records an already cancelled renewal at the provider too, so the record stops asking", async () => {
    const { store, state } = fakeStore();
    const port = fakePort(() => Promise.resolve("already_cancelled"));

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("already_cancelled");
    expect(store.recordEvent).toHaveBeenCalledTimes(1);
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("records nothing when the provider shows no subscription for the reference", async () => {
    const { store, state } = fakeStore();
    const port = fakePort(() => Promise.resolve("nothing_to_cancel"));

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("nothing_to_cancel");
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: false });
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing_renewal_cancel_nothing_found" })
    );
  });

  it("refuses for good a message whose key does not name the cycle of its body", async () => {
    const { store } = fakeStore();
    const port = fakePort();
    const forged = envelope({
      idempotencyKey: "billing.renewal_cancel_requested:1",
    });

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), forged)
    ).rejects.toBeInstanceOf(PermanentHandlerError);
    expect(store.readRecord).not.toHaveBeenCalled();
    expect(port.cancelRenewal).not.toHaveBeenCalled();
  });

  it("logs only codes and opaque IDs (the organization's, the event's), never the provider's references", async () => {
    const { store } = fakeStore();
    await handleRenewalCancelRequested(
      dependencies(store, fakePort()),
      envelope()
    );
    const logged = JSON.stringify(
      vi
        .mocked(console.info)
        .mock.calls.concat(vi.mocked(console.warn).mock.calls)
    );
    expect(logged).not.toContain(link.providerRef);
    expect(logged).not.toContain(link.providerSubscriptionId);
    expect(logged).toContain(EVENT_ID);
  });
});

describe("rearmRenewalCancellations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the database for the retry by state, an hour after a dispatch, and warns when something was owed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = {
      rearmRenewalCancellations: vi.fn(() =>
        Promise.resolve({ inserted: 1, rearmed: 2 })
      ),
    };

    await expect(rearmRenewalCancellations(store)).resolves.toEqual({
      inserted: 1,
      rearmed: 2,
    });
    expect(store.rearmRenewalCancellations).toHaveBeenCalledWith(
      RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS,
      RENEWAL_CANCEL_REARM_BATCH
    );
    expect(RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS).toBe(3600);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing_renewal_cancel_rearmed" })
    );
  });

  it("stays quiet when nothing was owed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await rearmRenewalCancellations({
      rearmRenewalCancellations: () =>
        Promise.resolve({ inserted: 0, rearmed: 0 }),
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
