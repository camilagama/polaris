import {
  type BillingProviderPort,
  type PreparedSubscription,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import type {
  BillingStore,
  UnclaimedTrialEvent,
} from "@polaris/db/billing-store";
import { RejectedBillingEventError } from "@polaris/domain/billing/subscription-state";
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
import { FAKE_PAYER } from "../../../../../packages/billing/src/asaas/test-fixtures";
import {
  BillingCommandError,
  cancelRenewal,
  cancelRenewalEventId,
  checkoutPriceOf,
  firstChargeDateOf,
  reconcileOrganization,
  refundCurrentPeriod,
  settleUnclaimedTrials,
  startCardCheckout,
} from "./commands";

const CANCEL_RENEWAL_EVENT_ID = /^command:cancel_renewal:req-42:[0-9a-f]{32}$/;

const now = new Date("2026-10-14T12:00:00.000Z");
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const userId = "verified-session-user";
const CHECKOUT_ID = "c6d42a6f-0000-4000-8000-000000000001";
const CHECKOUT_URL = "https://sandbox.asaas.com/checkoutSession/show?id=secret";
const link = {
  provider: "asaas",
  providerRef: "link-ref-0001",
  providerSubscriptionId: "sub_link0001",
};

const prepared: PreparedSubscription = {
  checkoutId: CHECKOUT_ID,
  handoff: { kind: "redirect", url: CHECKOUT_URL },
  providerRef: CHECKOUT_ID,
};

type Mocked<T> = T & { [K in keyof T]: T[K] & Mock };

function fakePort(overrides: Partial<BillingProviderPort> = {}) {
  const port = {
    cancelRenewal: vi.fn(() => Promise.resolve("cancelled" as const)),
    discardCheckout: vi.fn(() => Promise.resolve("discarded" as const)),
    prepareSubscription: vi.fn(() => Promise.resolve(prepared)),
    provider: "asaas" as const,
    hasSubscription: vi.fn(() => Promise.resolve(false)),
    readState: vi.fn(() => Promise.resolve([])),
    refundCurrentPeriod: vi.fn(() =>
      Promise.resolve("refund_requested" as const)
    ),
    ...overrides,
  };
  return port as unknown as Mocked<BillingProviderPort>;
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    attachProvider: vi.fn(() => Promise.resolve()),
    listUnclaimedTrials: vi.fn(() => Promise.resolve([])),
    processEvent: vi.fn(() =>
      Promise.resolve({
        eventId: "e",
        organizationId,
        outcomeCode: null,
        status: "applied",
      })
    ),
    readProviderLink: vi.fn(() => Promise.resolve(link)),
    readRecord: vi.fn(() => Promise.resolve(null)),
    recordEvent: vi.fn(() => Promise.resolve({ duplicate: false, id: "ev-1" })),
    settleUnclaimedTrial: vi.fn(() => Promise.resolve("cancelled")),
    startTrial: vi.fn(() => Promise.resolve({})),
    ...overrides,
  } as unknown as Mocked<BillingStore>;
}

const input = {
  amount: "249.00",
  cycleMonths: 12 as const,
  organizationId,
  trial: true,
  userId,
};

describe("firstChargeDateOf", () => {
  it("is the day the trial ends, in São Paulo, with a trial", () => {
    expect(firstChargeDateOf(new Date("2026-10-20T02:00:00.000Z"), true)).toBe(
      "2026-10-26"
    );
  });

  it("is today in São Paulo without a trial, even when UTC is already tomorrow", () => {
    expect(firstChargeDateOf(new Date("2026-10-20T02:00:00.000Z"), false)).toBe(
      "2026-10-19"
    );
  });
});

describe("checkoutPriceOf", () => {
  const prices = [
    { amount: "24.90", intervalMonths: 1, planId: "pro" },
    { amount: "99.00", intervalMonths: 6, planId: "business" },
    { amount: "249.00", intervalMonths: 12, planId: "pro" },
  ];

  it("returns the exact text of the Pro price of the cycle", () => {
    expect(checkoutPriceOf(prices, 12)).toBe("249.00");
    expect(checkoutPriceOf(prices, 1)).toBe("24.90");
  });

  it("refuses a cycle with no active price, or one only another plan has (AC-42)", () => {
    for (const cycle of [6, 3] as const) {
      expect(() => checkoutPriceOf(prices, cycle as 6)).toThrow(
        expect.objectContaining({
          code: "cycle_not_offered",
          name: "BillingCommandError",
        })
      );
    }
  });
});

describe("startCardCheckout", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];
  let loggerSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    consoleSpies = (["debug", "info", "warn", "error", "log"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    loggerSpies = (["info", "warn", "error"] as const).map((method) =>
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

  function assertNoLeak(logged: string) {
    for (const secret of [
      CHECKOUT_URL,
      "secret",
      CHECKOUT_ID,
      link.providerRef,
      FAKE_PAYER.name,
      FAKE_PAYER.email,
      FAKE_PAYER.cpf,
    ]) {
      expect(logged).not.toContain(secret);
    }
  }

  it("reserves the trial, creates the checkout, links it, and only then hands the link over (AC-6)", async () => {
    const order: string[] = [];
    const port = fakePort({
      prepareSubscription: vi.fn(() => {
        order.push("prepare");
        return Promise.resolve(prepared);
      }),
    });
    const store = fakeStore({
      attachProvider: vi.fn(() => {
        order.push("attach");
        return Promise.resolve();
      }),
      startTrial: vi.fn(() => {
        order.push("startTrial");
        return Promise.resolve({});
      }),
    });

    const result = await startCardCheckout(
      { now: () => now, port, store },
      input
    );

    expect(order).toEqual(["startTrial", "prepare", "attach"]);
    expect(store.startTrial).toHaveBeenCalledWith(organizationId, userId, now);
    expect(store.attachProvider).toHaveBeenCalledWith(
      organizationId,
      "asaas",
      CHECKOUT_ID
    );
    expect(result).toEqual({
      handoff: { kind: "redirect", url: CHECKOUT_URL },
    });
  });

  it("gives up, after the link, the checkout this one replaced (a second tab or a retry), and only that one", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const OLD_CHECKOUT = "c6d42a6f-0000-4000-8000-0000000000aa";
    const order: string[] = [];
    const port = fakePort({
      discardCheckout: vi.fn(() => {
        order.push("discard");
        return Promise.resolve("discarded" as const);
      }),
    });
    const store = fakeStore({
      attachProvider: vi.fn(() => {
        order.push("attach");
        return Promise.resolve({
          provider: "asaas",
          providerRef: OLD_CHECKOUT,
        });
      }),
    });

    await startCardCheckout({ now: () => now, port, store }, input);

    expect(order).toEqual(["attach", "discard"]);
    expect(port.discardCheckout).toHaveBeenCalledWith(OLD_CHECKOUT);
    expect(port.discardCheckout).not.toHaveBeenCalledWith(CHECKOUT_ID);
  });

  it("gives nothing up when nothing was replaced, or the replaced reference is another provider's", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const replaced of [
      null,
      { provider: "woovi", providerRef: "sub_woovi" },
    ]) {
      const port = fakePort();
      // biome-ignore lint/performance/noAwaitInLoops: Two cases, in order.
      await startCardCheckout(
        {
          now: () => now,
          port,
          store: fakeStore({
            attachProvider: vi.fn(() => Promise.resolve(replaced)),
          }),
        },
        input
      );
      expect(port.discardCheckout).not.toHaveBeenCalled();
    }
  });

  it("still hands the link over when giving up the replaced checkout fails, and logs no link", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = fakePort({
      discardCheckout: vi.fn(() => Promise.reject(new Error(CHECKOUT_URL))),
    });

    const result = await startCardCheckout(
      {
        now: () => now,
        port,
        store: fakeStore({
          attachProvider: vi.fn(() =>
            Promise.resolve({
              provider: "asaas",
              providerRef: "c6d42a6f-0000-4000-8000-0000000000bb",
            })
          ),
        }),
      },
      input
    );

    expect(result.handoff.url).toBe(CHECKOUT_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CHECKOUT_URL);
  });

  describe("a checkout the organization already holds, with no subscription matched yet", () => {
    const OLD_CHECKOUT = "c6d42a6f-0000-4000-8000-0000000000aa";
    const unconfirmed = {
      provider: "asaas",
      providerRef: OLD_CHECKOUT,
      providerSubscriptionId: null,
    };
    const oldFact = {
      fact: {
        cycleMonths: 12 as const,
        occurredAt: now,
        type: "trial_method_ready" as const,
      },
      providerEventId: "reconcile:sub_old:CHECKOUT_PAID",
      providerRef: OLD_CHECKOUT,
      providerSubscriptionId: "sub_old",
    };

    it("paid at the provider with the webhook late: refuses the new checkout, reads the old fact in, and leaves nothing orphaned", async () => {
      // 1: the owner pays checkout A; 2: the webhook is late; 3: checkout B is asked for
      const warn = vi.spyOn(logger, "warn");
      const port = fakePort({
        hasSubscription: vi.fn(() => Promise.resolve(true)),
        readState: vi.fn(() => Promise.resolve([oldFact])),
      });
      const store = fakeStore({
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).rejects.toMatchObject({ code: "checkout_pending_confirmation" });

      // asked about the old checkout, with no sub_ (the link has none)
      expect(port.hasSubscription).toHaveBeenCalledWith(OLD_CHECKOUT, null);
      // 4: the reference is not swapped, nothing new is created or given up
      expect(store.attachProvider).not.toHaveBeenCalled();
      expect(port.prepareSubscription).not.toHaveBeenCalled();
      expect(port.discardCheckout).not.toHaveBeenCalled();
      expect(store.startTrial).not.toHaveBeenCalled();
      // the old fact enters through the inbox, with its sub_
      expect(store.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          fact: oldFact.fact,
          providerEventId: oldFact.providerEventId,
          providerRef: OLD_CHECKOUT,
          providerSubscriptionId: "sub_old",
        })
      );
      expect(store.processEvent).toHaveBeenCalledWith("ev-1", now);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(OLD_CHECKOUT);
    });

    it("says already_subscribed when the reconciliation made the old subscription the organization's", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const port = fakePort({
        hasSubscription: vi.fn(() => Promise.resolve(true)),
        readState: vi.fn(() => Promise.resolve([oldFact])),
      });
      const readRecord = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ state: "trialing" });
      const store = fakeStore({
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
        readRecord,
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).rejects.toMatchObject({ code: "already_subscribed" });
      expect(store.attachProvider).not.toHaveBeenCalled();
    });

    it("still refuses when the reconciliation itself fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const port = fakePort({
        hasSubscription: vi.fn(() => Promise.resolve(true)),
        readState: vi.fn(() => Promise.resolve([oldFact])),
      });
      const store = fakeStore({
        processEvent: vi.fn(() => Promise.reject(new Error("db down"))),
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).rejects.toMatchObject({ code: "checkout_pending_confirmation" });
      expect(store.attachProvider).not.toHaveBeenCalled();
    });

    it("an old checkout that made no subscription is swapped as before, and given up", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const port = fakePort();
      const store = fakeStore({
        attachProvider: vi.fn(() =>
          Promise.resolve({ provider: "asaas", providerRef: OLD_CHECKOUT })
        ),
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).resolves.toEqual({ handoff: { kind: "redirect", url: CHECKOUT_URL } });

      expect(port.hasSubscription).toHaveBeenCalledWith(OLD_CHECKOUT, null);
      expect(store.attachProvider).toHaveBeenCalledTimes(1);
      expect(port.discardCheckout).toHaveBeenCalledWith(OLD_CHECKOUT);
      expect(store.recordEvent).not.toHaveBeenCalled();
    });

    it("a provider that does not know the old checkout (not found) counts as no subscription", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const port = fakePort({
        hasSubscription: vi.fn(() =>
          Promise.reject(new ProviderNotFoundError())
        ),
      });
      const store = fakeStore({
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).resolves.toBeDefined();
      expect(store.attachProvider).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["unavailable", new ProviderUnavailableError()],
      ["rejected", new ProviderRejectedError(401)],
      ["malformed", new ProviderResponseMalformedError()],
    ])(
      "a provider that is down or fails (%s) refuses with provider_unavailable, failing closed",
      async (_name, failure) => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const port = fakePort({
          hasSubscription: vi.fn(() => Promise.reject(failure)),
        });
        const store = fakeStore({
          readProviderLink: vi.fn(() => Promise.resolve(unconfirmed)),
        });

        await expect(
          startCardCheckout({ now: () => now, port, store }, input)
        ).rejects.toBeInstanceOf(ProviderUnavailableError);

        expect(store.attachProvider).not.toHaveBeenCalled();
        expect(port.prepareSubscription).not.toHaveBeenCalled();
        expect(store.startTrial).not.toHaveBeenCalled();
      }
    );

    it("asks nothing when there is no link, the link has a sub_, or it is another provider's", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      for (const stored of [
        null,
        link,
        { ...unconfirmed, provider: "woovi" },
      ]) {
        const port = fakePort();
        // biome-ignore lint/performance/noAwaitInLoops: Three cases, in order.
        await startCardCheckout(
          {
            now: () => now,
            port,
            store: fakeStore({
              readProviderLink: vi.fn(() => Promise.resolve(stored)),
            }),
          },
          input
        );
        expect(port.hasSubscription).not.toHaveBeenCalled();
      }
    });
  });

  it("sends the price text, the cycle and the first charge on the day the trial ends, and no payer", async () => {
    const port = fakePort();

    await startCardCheckout(
      {
        now: () => new Date("2026-10-20T02:00:00.000Z"),
        port,
        store: fakeStore(),
      },
      input
    );

    expect(port.prepareSubscription).toHaveBeenCalledTimes(1);
    const sent = port.prepareSubscription.mock.calls[0]?.[0] as unknown;
    expect(sent).toEqual({
      amount: "249.00",
      cycleMonths: 12,
      firstChargeOn: "2026-10-26",
    });
    expect(sent).not.toHaveProperty("payer");
  });

  it("without a trial it never reserves one and the first charge is today in São Paulo", async () => {
    const port = fakePort();
    const store = fakeStore();

    await startCardCheckout(
      { now: () => new Date("2026-10-20T02:00:00.000Z"), port, store },
      { ...input, trial: false }
    );

    expect(store.startTrial).not.toHaveBeenCalled();
    expect(port.prepareSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ firstChargeOn: "2026-10-19" })
    );
  });

  it("gives up the checkout and raises the error when it cannot be linked", async () => {
    const failure = new Error("database down");
    const port = fakePort();
    const store = fakeStore({
      attachProvider: vi.fn(() => Promise.reject(failure)),
    });

    await expect(
      startCardCheckout({ now: () => now, port, store }, input)
    ).rejects.toBe(failure);

    expect(port.discardCheckout).toHaveBeenCalledWith(CHECKOUT_ID);
  });

  it("says already_subscribed when a subscription became live in between, still giving the checkout up", async () => {
    const port = fakePort();
    const store = fakeStore({
      attachProvider: vi.fn(() =>
        Promise.reject(new Error("billing_provider_already_attached"))
      ),
    });

    await expect(
      startCardCheckout({ now: () => now, port, store }, input)
    ).rejects.toMatchObject({
      code: "already_subscribed",
      name: "BillingCommandError",
    });
    expect(port.discardCheckout).toHaveBeenCalledWith(CHECKOUT_ID);
  });

  it("raises the original error and logs no link when giving the checkout up fails too", async () => {
    const failure = new Error("database down");
    const port = fakePort({
      discardCheckout: vi.fn(() =>
        Promise.reject(
          new Error(`provider said no for ${CHECKOUT_URL} ${FAKE_PAYER.email}`)
        )
      ),
    });
    const store = fakeStore({
      attachProvider: vi.fn(() => Promise.reject(failure)),
    });

    await expect(
      startCardCheckout({ now: () => now, port, store }, input)
    ).rejects.toBe(failure);

    expect(loggerSpies[1]).toHaveBeenCalledWith(
      "billing_checkout_discard_failed",
      expect.any(Object)
    );
    assertNoLeak(everythingLogged());
  });

  it("refuses a non-redirect handoff, since the card is typed on the provider's page", async () => {
    const port = fakePort({
      prepareSubscription: vi.fn(() =>
        Promise.resolve({
          ...prepared,
          handoff: {
            emv: "000201",
            kind: "pix_authorization",
            url: "https://x.test",
          },
        } as PreparedSubscription)
      ),
    });
    const store = fakeStore();

    await expect(
      startCardCheckout({ now: () => now, port, store }, input)
    ).rejects.toThrow("billing_unexpected_handoff");

    expect(store.attachProvider).not.toHaveBeenCalled();
    expect(port.discardCheckout).toHaveBeenCalledWith(CHECKOUT_ID);
  });

  it.each(["active", "trialing", "grace"])(
    "refuses to start when the record already gives Pro (%s), without calling the provider",
    async (state) => {
      const port = fakePort();
      const store = fakeStore({
        readRecord: vi.fn(() => Promise.resolve({ state })),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).rejects.toMatchObject({ code: "already_subscribed" });

      expect(port.prepareSubscription).not.toHaveBeenCalled();
      expect(store.startTrial).not.toHaveBeenCalled();
    }
  );

  it("refuses with the end of the paid access when the renewal was cancelled (a closure undone does not create it again)", async () => {
    const accessEndsAt = new Date("2026-11-14T12:00:00.000Z");
    const port = fakePort();
    const store = fakeStore({
      readRecord: vi.fn(() =>
        Promise.resolve({
          accessEndsAt,
          cancelAtPeriodEnd: true,
          state: "active",
        })
      ),
    });

    const refusal = await startCardCheckout(
      { now: () => now, port, store },
      input
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BillingCommandError);
    expect(refusal).toMatchObject({
      code: "renewal_cancelled_until",
      until: accessEndsAt,
    });
    expect(port.prepareSubscription).not.toHaveBeenCalled();
    expect(store.startTrial).not.toHaveBeenCalled();
    expect(store.attachProvider).not.toHaveBeenCalled();
  });

  it("starts from a record that does not give Pro", async () => {
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve({ state: "free" })),
    });

    await expect(
      startCardCheckout(
        { now: () => now, port: fakePort(), store },
        { ...input, trial: false }
      )
    ).resolves.toEqual({ handoff: { kind: "redirect", url: CHECKOUT_URL } });
  });

  it.each([
    [
      "trial_already_used",
      new Error("trial_already_used"),
      "trial_already_used",
    ],
    ["trial_in_progress", new Error("trial_in_progress"), "trial_in_progress"],
    [
      "trial_already_consumed",
      new RejectedBillingEventError(
        "trial_already_consumed",
        "free",
        "start_trial"
      ),
      "trial_already_used",
    ],
  ])(
    "turns %s from the trial reservation into a refusal without calling the provider",
    async (_label, failure, code) => {
      const port = fakePort();
      const store = fakeStore({
        startTrial: vi.fn(() => Promise.reject(failure)),
      });

      await expect(
        startCardCheckout({ now: () => now, port, store }, input)
      ).rejects.toMatchObject({ code, name: "BillingCommandError" });

      expect(port.prepareSubscription).not.toHaveBeenCalled();
      expect(store.attachProvider).not.toHaveBeenCalled();
    }
  );

  it("lets an unknown trial failure through as it is", async () => {
    const failure = new Error("connection reset");
    const store = fakeStore({
      startTrial: vi.fn(() => Promise.reject(failure)),
    });

    await expect(
      startCardCheckout({ now: () => now, port: fakePort(), store }, input)
    ).rejects.toBe(failure);
  });

  it("does not let a trial refusal named like an Object property through as a refusal", async () => {
    const failure = new Error("constructor");
    const store = fakeStore({
      startTrial: vi.fn(() => Promise.reject(failure)),
    });

    await expect(
      startCardCheckout({ now: () => now, port: fakePort(), store }, input)
    ).rejects.toBe(failure);
  });

  it("logs neither the link, the checkout ID nor the payer, after a success", async () => {
    await startCardCheckout(
      { now: () => now, port: fakePort(), store: fakeStore() },
      input
    );

    expect(loggerSpies[0]).toHaveBeenCalledWith(
      "billing_checkout_started",
      expect.objectContaining({ cycleMonths: 12, trial: true })
    );
    assertNoLeak(everythingLogged());
  });

  it("logs neither the link, the checkout ID nor the payer, after a failure", async () => {
    const store = fakeStore({
      attachProvider: vi.fn(() =>
        Promise.reject(new Error(`failed for ${CHECKOUT_URL} ${CHECKOUT_ID}`))
      ),
    });

    await expect(
      startCardCheckout({ now: () => now, port: fakePort(), store }, input)
    ).rejects.toThrow();

    assertNoLeak(everythingLogged());
  });
});

describe("reconcileOrganization", () => {
  it("does nothing, and does not ask the provider, when the organization has no link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    const report = await reconcileOrganization(
      { now: () => now, portFor: () => port, store },
      organizationId
    );

    expect(report).toEqual({
      applied: 0,
      duplicates: 0,
      failed: 0,
      ignored: 0,
      linked: false,
      read: 0,
      unresolved: 0,
    });
    expect(port.readState).not.toHaveBeenCalled();
  });

  it("reads the subscription by the stored link and writes each fact through the inbox, in order", async () => {
    const calls: string[] = [];
    const events = ["a", "b", "c", "d", "e"].map((id) => ({
      fact: { occurredAt: now, type: "subscription_cancelled" as const },
      providerEventId: `evt-${id}`,
      providerRef: link.providerRef,
      ...(id === "a" ? { providerSubscriptionId: "sub_a" } : {}),
    }));
    const statuses = [
      "applied",
      "ignored",
      "unresolved",
      "received",
      "applied",
    ];
    let recorded = 0;
    let processed = 0;
    const port = fakePort({ readState: vi.fn(() => Promise.resolve(events)) });
    const store = fakeStore({
      processEvent: vi.fn((id: string) => {
        calls.push(`process:${id}`);
        const status = statuses[processed];
        processed += 1;
        return Promise.resolve({
          eventId: id,
          organizationId,
          outcomeCode: null,
          status,
        });
      }),
      recordEvent: vi.fn(() => {
        recorded += 1;
        calls.push(`record:${recorded}`);
        // the second one is a redelivery
        return Promise.resolve({
          duplicate: recorded === 2,
          id: `id-${recorded}`,
        });
      }),
    });

    const report = await reconcileOrganization(
      { now: () => now, portFor: () => port, store },
      organizationId
    );

    expect(port.readState).toHaveBeenCalledWith(
      link.providerRef,
      now,
      link.providerSubscriptionId
    );
    expect(store.recordEvent).toHaveBeenNthCalledWith(1, {
      fact: events[0]?.fact,
      provider: "asaas",
      providerEventId: "evt-a",
      providerRef: link.providerRef,
      providerSubscriptionId: "sub_a",
    });
    // an event without a subscription ID is stored with null, not undefined
    expect(store.recordEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerEventId: "evt-b",
        providerSubscriptionId: null,
      })
    );
    expect(calls).toEqual([
      "record:1",
      "process:id-1",
      "record:2",
      "process:id-2",
      "record:3",
      "process:id-3",
      "record:4",
      "process:id-4",
      "record:5",
      "process:id-5",
    ]);
    expect(store.processEvent).toHaveBeenCalledWith("id-1", now);
    expect(report).toEqual({
      applied: 2,
      duplicates: 1,
      failed: 1,
      ignored: 1,
      linked: true,
      read: 5,
      unresolved: 1,
    });
  });

  it("asks the port of the provider the link names", async () => {
    const portFor = vi.fn(() => fakePort());
    await reconcileOrganization(
      { now: () => now, portFor, store: fakeStore() },
      organizationId
    );
    expect(portFor).toHaveBeenCalledWith("asaas");
  });
});

describe("refundCurrentPeriod", () => {
  it("is not_linked without a link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        organizationId
      )
    ).resolves.toBe("not_linked");
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
  });

  it.each(["refund_requested", "nothing_to_refund"] as const)(
    "asks the provider about the linked subscription and returns %s",
    async (answer) => {
      const port = fakePort({
        refundCurrentPeriod: vi.fn(() => Promise.resolve(answer)),
      });

      await expect(
        refundCurrentPeriod(
          { now: () => now, portFor: () => port, store: fakeStore() },
          organizationId
        )
      ).resolves.toBe(answer);
      expect(port.refundCurrentPeriod).toHaveBeenCalledWith(
        link.providerRef,
        now,
        link.providerSubscriptionId
      );
    }
  );
});

describe("cancelRenewal", () => {
  const request = { organizationId, requestId: "req-42" };

  it("is not_linked without a link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      cancelRenewal({ now: () => now, portFor: () => port, store }, request)
    ).resolves.toBe("not_linked");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "already_cancelled"] as const)(
    "records the cancellation through the inbox at once and processes it (%s)",
    async (answer) => {
      const port = fakePort({
        cancelRenewal: vi.fn(() => Promise.resolve(answer)),
      });
      const store = fakeStore({
        recordEvent: vi.fn(() =>
          Promise.resolve({ duplicate: false, id: "ev-9" })
        ),
      });

      await expect(
        cancelRenewal({ now: () => now, portFor: () => port, store }, request)
      ).resolves.toBe(answer);

      expect(port.cancelRenewal).toHaveBeenCalledWith(
        link.providerRef,
        link.providerSubscriptionId
      );
      expect(store.recordEvent).toHaveBeenCalledWith({
        fact: { occurredAt: now, type: "subscription_cancelled" },
        organizationId,
        provider: "asaas",
        providerEventId: await cancelRenewalEventId("req-42", link.providerRef),
        providerRef: link.providerRef,
      });
      expect(store.processEvent).toHaveBeenCalledWith("ev-9", now);
    }
  );

  it("names the fact by the request and the subscription, within the length of an event ID", async () => {
    const first = await cancelRenewalEventId("req-42", "pol_a");
    expect(first).toMatch(CANCEL_RENEWAL_EVENT_ID);
    // the same request for the same subscription is the same fact; for another subscription, another
    expect(await cancelRenewalEventId("req-42", "pol_a")).toBe(first);
    expect(await cancelRenewalEventId("req-42", "pol_b")).not.toBe(first);
    const longest = await cancelRenewalEventId(
      "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2d",
      "r".repeat(128)
    );
    expect(longest.length).toBeLessThanOrEqual(160);
    expect(longest).not.toContain("rrrr");
  });

  it("writes nothing when there was nothing to cancel", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("nothing_to_cancel" as const)),
    });
    const store = fakeStore();

    await expect(
      cancelRenewal({ now: () => now, portFor: () => port, store }, request)
    ).resolves.toBe("nothing_to_cancel");

    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(store.processEvent).not.toHaveBeenCalled();
  });
});

describe("settleUnclaimedTrials", () => {
  const unclaimed = (id: string): UnclaimedTrialEvent => ({
    eventId: id,
    organizationId,
    provider: "asaas",
    providerRef: `event-ref-${id}`,
    providerSubscriptionId: `sub_event_${id}`,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("settles each event, cancelling the subscription of the EVENT, not the organization's current link", async () => {
    const port = fakePort();
    const portFor = vi.fn(() => port);
    const events = [unclaimed("1"), unclaimed("2")];
    const store = fakeStore({
      listUnclaimedTrials: vi.fn(() => Promise.resolve(events)),
      settleUnclaimedTrial: vi.fn(
        async (
          _id: string,
          cancel: (event: UnclaimedTrialEvent) => Promise<unknown>
        ) => {
          await cancel(
            events.find((e) => e.eventId === _id) as UnclaimedTrialEvent
          );
          return "cancelled";
        }
      ),
    });

    const report = await settleUnclaimedTrials(
      { now: () => now, portFor, store },
      5
    );

    expect(store.listUnclaimedTrials).toHaveBeenCalledWith(5);
    expect(store.settleUnclaimedTrial).toHaveBeenNthCalledWith(
      1,
      "1",
      expect.any(Function),
      now
    );
    expect(portFor).toHaveBeenCalledWith("asaas");
    expect(port.cancelRenewal).toHaveBeenNthCalledWith(
      1,
      "event-ref-1",
      "sub_event_1"
    );
    expect(port.cancelRenewal).toHaveBeenNthCalledWith(
      2,
      "event-ref-2",
      "sub_event_2"
    );
    expect(port.cancelRenewal).not.toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(store.readProviderLink).not.toHaveBeenCalled();
    expect(report).toEqual({
      cancelled: 2,
      failed: 0,
      leftPaid: 0,
      scanned: 2,
    });
  });

  /** A store whose settling runs the command's `cancel` on the one event and answers what it gave. */
  function settlingStore(event: UnclaimedTrialEvent) {
    return fakeStore({
      listUnclaimedTrials: vi.fn(() => Promise.resolve([event])),
      settleUnclaimedTrial: vi.fn(
        async (
          _id: string,
          cancel: (entry: UnclaimedTrialEvent) => Promise<"cancelled" | "paid">
        ) => ((await cancel(event)) === "paid" ? "left_paid" : "cancelled")
      ),
    });
  }

  it("reads the subscription of the event first: a paid charge there is never cancelled (left paid)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = fakePort({
      readState: vi.fn(() =>
        Promise.resolve([
          {
            fact: {
              cycleMonths: 1 as const,
              occurredAt: now,
              periodEndsAt: new Date("2026-11-15T03:00:00.000Z"),
              type: "charge_succeeded" as const,
            },
            providerEventId: "reconcile:pay_1:CONFIRMED",
            providerRef: "event-ref-1",
          },
        ])
      ),
    });

    const report = await settleUnclaimedTrials({
      now: () => now,
      portFor: () => port,
      store: settlingStore(unclaimed("1")),
    });

    expect(port.readState).toHaveBeenCalledWith(
      "event-ref-1",
      now,
      "sub_event_1"
    );
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(report).toEqual({
      cancelled: 0,
      failed: 0,
      leftPaid: 1,
      scanned: 1,
    });
  });

  it("a provider that finds nothing to cancel is a failure: the event stays for the next pass", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("nothing_to_cancel" as const)),
    });

    const report = await settleUnclaimedTrials({
      now: () => now,
      portFor: () => port,
      store: settlingStore(unclaimed("1")),
    });

    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(report).toEqual({
      cancelled: 0,
      failed: 1,
      leftPaid: 0,
      scanned: 1,
    });
  });

  it("counts cancelled, left paid and not pending apart", async () => {
    const outcomes = ["cancelled", "left_paid", "not_pending", "left_paid"];
    const store = fakeStore({
      listUnclaimedTrials: vi.fn(() =>
        Promise.resolve(["1", "2", "3", "4"].map(unclaimed))
      ),
      settleUnclaimedTrial: vi.fn(() => Promise.resolve(outcomes.shift())),
    });

    const report = await settleUnclaimedTrials({
      now: () => now,
      portFor: () => fakePort(),
      store,
    });

    expect(report).toEqual({
      cancelled: 1,
      failed: 0,
      leftPaid: 2,
      scanned: 4,
    });
  });

  it("counts a failure, logs only IDs and codes, and still settles the others", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error(`provider body: ${FAKE_PAYER.email} ${FAKE_PAYER.cpf}`),
      { code: "provider_unavailable" }
    );
    failure.name = "ProviderUnavailableError";
    const results: (() => Promise<string>)[] = [
      () => Promise.reject(failure),
      () => Promise.resolve("cancelled"),
    ];
    const store = fakeStore({
      listUnclaimedTrials: vi.fn(() =>
        Promise.resolve([unclaimed("1"), unclaimed("2")])
      ),
      settleUnclaimedTrial: vi.fn(() =>
        (results.shift() as () => Promise<string>)()
      ),
    });

    const report = await settleUnclaimedTrials({
      now: () => now,
      portFor: () => fakePort(),
      store,
    });

    expect(report).toEqual({
      cancelled: 1,
      failed: 1,
      leftPaid: 0,
      scanned: 2,
    });
    expect(store.settleUnclaimedTrial).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "ProviderUnavailableError",
        errorCode: "provider_unavailable",
        event: "billing_unclaimed_trial_settle_failed",
        eventId: "1",
      })
    );
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(FAKE_PAYER.email);
    expect(logged).not.toContain(FAKE_PAYER.cpf);
    expect(logged).not.toContain("provider body");
  });
});

describe("BillingCommandError", () => {
  it("carries the code as its message and name", () => {
    const error = new BillingCommandError("trial_in_progress");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("trial_in_progress");
    expect(error.message).toBe("trial_in_progress");
  });
});
