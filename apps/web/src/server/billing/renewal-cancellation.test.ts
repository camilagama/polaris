import {
  type BillingProviderPort,
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import type { BillingStore } from "@polaris/db/billing-store";
import { billingProviderHandled } from "@polaris/domain/billing/renewal-cancellation";
import { queueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermanentHandlerError } from "../queue/consumer";
import { cancelRenewalEventId } from "./commands";
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
const checkoutLink = {
  provider: "asaas",
  providerRef: "pol_checkout01",
  providerSubscriptionId: null,
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
  const state: {
    linked: typeof link | typeof checkoutLink | null;
    record: Record<string, unknown> | null;
  } = { linked: record ? link : null, record };
  const stored = new Map<string, string>();
  // the ledger rows of the checkouts given up, by request ID (the same request twice is one row)
  const discarded = new Map<string, string>();
  const store = {
    checkoutDiscarded: vi.fn(
      (_organization: string, given: { providerRef: string }) =>
        Promise.resolve([...discarded.values()].includes(given.providerRef))
    ),
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
    recordCheckoutDiscarded: vi.fn(
      (input: { link: { providerRef: string }; requestId: string }) => {
        discarded.set(input.requestId, input.link.providerRef);
        return Promise.resolve();
      }
    ),
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
  return {
    discarded,
    state,
    store: store as unknown as BillingStore & typeof store,
  };
}

function fakePort(
  cancel: BillingProviderPort["cancelRenewal"] = () =>
    Promise.resolve("cancelled"),
  discard: BillingProviderPort["discardCheckout"] = () =>
    Promise.resolve("discarded"),
  subscribed: BillingProviderPort["hasSubscription"] = () =>
    Promise.resolve(false)
) {
  return {
    cancelRenewal: vi.fn(cancel),
    discardCheckout: vi.fn(discard),
    hasSubscription: vi.fn(subscribed),
    provider: "asaas",
    readState: vi.fn(() => Promise.resolve([])),
  } as unknown as BillingProviderPort & {
    cancelRenewal: ReturnType<typeof vi.fn>;
    discardCheckout: ReturnType<typeof vi.fn>;
    hasSubscription: ReturnType<typeof vi.fn>;
    readState: ReturnType<typeof vi.fn>;
  };
}

function dependencies(
  store: BillingStore,
  port: BillingProviderPort,
  handles: (provider: string) => boolean = (provider) => provider === "asaas"
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
        providerEventId: await cancelRenewalEventId(EVENT_ID, link.providerRef),
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

  it.each(["free", "trial_setup"] as const)(
    "gives up a checkout opened before the closure and not paid (%s), records it once, and asks nothing after",
    async (billingState) => {
      const { discarded, state, store } = fakeStore({
        accessEndsAt: null,
        cancelAtPeriodEnd: false,
        state: billingState,
      });
      state.linked = checkoutLink;
      const port = fakePort();
      const run = (attempt: number) =>
        handleRenewalCancelRequested(
          dependencies(store, port),
          envelope({ attempt })
        );

      await expect(run(1)).resolves.toBe("checkout_discarded");
      // for Asaas the reference is the checkout's own ID
      expect(port.discardCheckout).toHaveBeenCalledWith(
        checkoutLink.providerRef
      );
      expect(store.recordCheckoutDiscarded).toHaveBeenCalledWith(
        { link: checkoutLink, organizationId, requestId: EVENT_ID },
        now
      );
      expect([...discarded.values()]).toEqual([checkoutLink.providerRef]);
      // nothing renews: no cancellation is asked or written
      expect(port.cancelRenewal).not.toHaveBeenCalled();
      expect(store.recordEvent).not.toHaveBeenCalled();

      // a redelivery, or the event of a later closure cycle, finds it in the ledger
      await expect(run(2)).resolves.toBe("nothing_owed");
      expect(port.discardCheckout).toHaveBeenCalledTimes(1);
    }
  );

  it("records nothing when the provider fails to give the checkout up, so the queue retries", async () => {
    const { discarded, state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "free",
    });
    state.linked = checkoutLink;
    const port = fakePort(
      undefined,
      vi
        .fn<BillingProviderPort["discardCheckout"]>()
        .mockRejectedValueOnce(new ProviderUnavailableError())
        .mockResolvedValue("already_closed")
    );

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(discarded.size).toBe(0);

    // a checkout the provider already closed is recorded as given up too
    await expect(
      handleRenewalCancelRequested(
        dependencies(store, port),
        envelope({ attempt: 2 })
      )
    ).resolves.toBe("checkout_discarded");
    expect(discarded.size).toBe(1);
  });

  it("cancels the subscription a checkout made when it was paid before it could be given up", async () => {
    const { discarded, state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "free",
    });
    state.linked = checkoutLink;
    const port = fakePort(
      undefined,
      () => Promise.resolve("already_closed"),
      () => {
        // the reconciliation that follows brings the subscription's facts in
        state.linked = link;
        state.record = { ...alive };
        return Promise.resolve(true);
      }
    );

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("cancelled");
    expect(port.hasSubscription).toHaveBeenCalledWith(
      checkoutLink.providerRef,
      null
    );
    expect(port.readState).toHaveBeenCalled();
    expect(port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(discarded.size).toBe(0);
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("throws, recording nothing, when the paid checkout's subscription does not show in the record", async () => {
    const { discarded, state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "trial_setup",
    });
    state.linked = checkoutLink;
    const port = fakePort(
      undefined,
      () => Promise.resolve("already_closed"),
      () => Promise.resolve(true)
    );

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).rejects.toThrow("billing_closure_checkout_subscription_unapplied");
    expect(discarded.size).toBe(0);
    expect(port.cancelRenewal).not.toHaveBeenCalled();
  });

  it("records as given up a checkout the provider already closed and that made no subscription", async () => {
    const { discarded, state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "free",
    });
    state.linked = checkoutLink;
    const port = fakePort(
      undefined,
      () => Promise.resolve("already_closed"),
      () => Promise.reject(new ProviderNotFoundError())
    );

    await expect(
      handleRenewalCancelRequested(dependencies(store, port), envelope())
    ).resolves.toBe("checkout_discarded");
    expect(discarded.size).toBe(1);
  });

  it("leaves an open checkout of a provider Polaris does not act through, without calling it", async () => {
    const { state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "free",
    });
    state.linked = { ...checkoutLink, provider: "woovi" };
    const port = fakePort();
    const deps = dependencies(store, port);

    await expect(handleRenewalCancelRequested(deps, envelope())).resolves.toBe(
      "not_handled"
    );
    expect(deps.portFor).not.toHaveBeenCalled();
    expect(store.recordCheckoutDiscarded).not.toHaveBeenCalled();
  });

  it("writes a fact of its own when a resent event cancels a subscription the organization made again, so the record says cancelled", async () => {
    const { state, store } = fakeStore();
    const port = fakePort();
    const run = () =>
      handleRenewalCancelRequested(dependencies(store, port), envelope());

    await expect(run()).resolves.toBe("cancelled");
    // undone, the paid access ended, and a new checkout became a subscription: alive again, another reference
    state.linked = {
      provider: "asaas",
      providerRef: "pol_link0002",
      providerSubscriptionId: "sub_link0002",
    };
    state.record = { ...alive, cancelAtPeriodEnd: false };

    await expect(run()).resolves.toBe("cancelled");
    expect(store.recordEvent).toHaveBeenCalledTimes(2);
    const ids = store.recordEvent.mock.calls.map(
      ([input]) => input.providerEventId
    );
    expect(new Set(ids).size).toBe(2);
    expect(store.processEvent).toHaveBeenLastCalledWith("ev-2", now);
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
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

describe("handleRenewalCancelRequested with Woovi", () => {
  const wooviSubscription = {
    provider: "woovi",
    providerRef: "woovi-sub-ref-0001",
    providerSubscriptionId: "woovi-sub-0001",
  };
  const wooviCheckout = {
    provider: "woovi",
    providerRef: "woovi-sub-ref-0002",
    providerSubscriptionId: null,
  };

  function wooviPort(
    cancel?: BillingProviderPort["cancelRenewal"],
    discard?: BillingProviderPort["discardCheckout"]
  ) {
    const port = fakePort(cancel, discard);
    Object.assign(port, { provider: "woovi" });
    return port;
  }

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a provider the domain says Polaris cancels through", () => {
    expect(billingProviderHandled("woovi")).toBe(true);
  });

  it("gives up a Pix checkout still open (no subscription matched, trial_setup), and records it", async () => {
    const { discarded, state, store } = fakeStore({
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      state: "trial_setup",
    });
    state.linked = wooviCheckout;
    const port = wooviPort();

    await expect(
      handleRenewalCancelRequested(
        dependencies(store, port, billingProviderHandled),
        envelope()
      )
    ).resolves.toBe("checkout_discarded");

    expect(port.discardCheckout).toHaveBeenCalledWith(
      wooviCheckout.providerRef
    );
    expect(store.recordCheckoutDiscarded).toHaveBeenCalledWith(
      { link: wooviCheckout, organizationId, requestId: EVENT_ID },
      now
    );
    expect([...discarded.values()]).toEqual([wooviCheckout.providerRef]);
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("cancels a live Woovi subscription and writes subscription_cancelled with provider woovi", async () => {
    const { state, store } = fakeStore();
    state.linked = wooviSubscription;
    const port = wooviPort();

    await expect(
      handleRenewalCancelRequested(
        dependencies(store, port, billingProviderHandled),
        envelope()
      )
    ).resolves.toBe("cancelled");

    expect(port.cancelRenewal).toHaveBeenCalledWith(
      wooviSubscription.providerRef,
      wooviSubscription.providerSubscriptionId
    );
    expect(store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        fact: { occurredAt: now, type: "subscription_cancelled" },
        organizationId,
        provider: "woovi",
        providerEventId: await cancelRenewalEventId(
          EVENT_ID,
          wooviSubscription.providerRef
        ),
        providerRef: wooviSubscription.providerRef,
      })
    );
    expect(store.processEvent).toHaveBeenCalledWith("ev-1", now);
    expect(state.record).toMatchObject({ cancelAtPeriodEnd: true });
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
      RENEWAL_CANCEL_REARM_BATCH,
      // only the providers Polaris cancels through: another is the person's to cancel
      ["asaas", "woovi"]
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
