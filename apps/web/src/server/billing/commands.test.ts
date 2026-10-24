import {
  type BillingProviderPort,
  type PreparedSubscription,
  type PrepareSubscriptionInput,
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import { WooviCustomerMismatchError } from "@polaris/billing/woovi/customer";
import {
  BillingCommandInProgressError,
  type BillingStore,
  type UnclaimedTrialEvent,
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
  PIX_CHECKOUT_MINIMUM_MS,
  payerCustomerKey,
  payerLockKey,
  reconcileOrganization,
  refundCancelEventId,
  refundCurrentPeriod,
  type StartPixCheckoutDependencies,
  settleUnclaimedTrials,
  startCardCheckout,
  startPixCheckout,
} from "./commands";

const CANCEL_RENEWAL_EVENT_ID = /^command:cancel_renewal:req-42:[0-9a-f]{32}$/;
const REFUND_CANCEL_EVENT_ID = /^command:refund_cancel:req-42:[0-9a-f]{32}$/;
const EIGHT_HEX = /^[\da-f]{8}$/;
const PAYER_CUSTOMER_KEY = /^polaris-payer-[\da-f]{32}$/;

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
    hasSubscription: vi.fn(() => Promise.resolve(false)),
    prepareSubscription: vi.fn(() => Promise.resolve(prepared)),
    provider: "asaas" as const,
    readState: vi.fn(() => Promise.resolve([])),
    refundCurrentPeriod: vi.fn(() =>
      Promise.resolve("refund_requested" as const)
    ),
    refundsEnabled: true,
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
    withOrganizationLock: vi.fn(
      (_organizationId: string, operation: () => Promise<unknown>) =>
        operation()
    ),
    ...overrides,
  } as unknown as Mocked<BillingStore>;
}

const input = {
  amount: "249.00",
  cycleMonths: 12 as const,
  organizationId,
  priceId: "pro-12",
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
    { amount: "24.90", id: "pro-1", intervalMonths: 1, planId: "pro" },
    {
      amount: "99.00",
      id: "business-6",
      intervalMonths: 6,
      planId: "business",
    },
    { amount: "249.00", id: "pro-12", intervalMonths: 12, planId: "pro" },
  ];

  it("returns the exact text of the Pro price of the cycle, with its catalog ID", () => {
    expect(checkoutPriceOf(prices, 12)).toEqual({
      amount: "249.00",
      priceId: "pro-12",
    });
    expect(checkoutPriceOf(prices, 1)).toEqual({
      amount: "24.90",
      priceId: "pro-1",
    });
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
    // the price and the day of the first charge sent to the provider stay with the link (ADR 0104)
    expect(store.attachProvider).toHaveBeenCalledWith(
      organizationId,
      "asaas",
      CHECKOUT_ID,
      { firstChargeOn: "2026-10-21", priceAmount: "249.00", priceId: "pro-12" }
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
          // a checkout nobody paid: no subscription, no old renewal to cancel
          readProviderLink: vi.fn(() => Promise.resolve(null)),
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

describe("startPixCheckout", () => {
  const PAYER = {
    email: "pagador.pix@example.com",
    name: "Pagador Pix de Teste",
    taxId: "52998224725",
  };
  const OTHER_TAX_ID = "11144477735";
  const EMV = "00020126580014br.gov.bcb.pix0136SECRET-EMV-PAYLOAD6304ABCD";
  const AUTH_URL = "https://woovi-sandbox.com/pay/secret-authorization";
  const SUBSCRIPTION_REF = "woovi-sub-ref-0001";
  const pixPrepared: PreparedSubscription = {
    checkoutId: "woovi-checkout-0001",
    handoff: { emv: EMV, kind: "pix_authorization", url: AUTH_URL },
    providerRef: SUBSCRIPTION_REF,
  };
  const pixInput = { ...input, payer: PAYER };
  const SECRET = "a".repeat(32);

  function startPix(
    dependencies: Omit<StartPixCheckoutDependencies, "payerKey">,
    request: Parameters<typeof startPixCheckout>[1]
  ) {
    return startPixCheckout(
      {
        payerKey: SECRET,
        // the store's old link is a card subscription already ended at Asaas
        portFor: () =>
          fakePort({
            cancelRenewal: vi.fn(() =>
              Promise.resolve("already_cancelled" as const)
            ),
          }),
        ...dependencies,
      },
      request
    );
  }

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

  function wooviPort(overrides: Partial<BillingProviderPort> = {}) {
    return fakePort({
      prepareSubscription: vi.fn(() => Promise.resolve(pixPrepared)),
      provider: "woovi" as never,
      ...overrides,
    });
  }

  /** The lock with the log of when it was entered and left; the operation runs inside. */
  function recordingStore(
    log: string[],
    overrides: Record<string, unknown> = {}
  ) {
    return fakeStore({
      withPayerLock: vi.fn(
        async (lockKey: string, operation: () => Promise<unknown>) => {
          log.push(`enter:${lockKey}`);
          try {
            return await operation();
          } finally {
            log.push(`exit:${lockKey}`);
          }
        }
      ),
      ...overrides,
    });
  }

  /** A clock where each call to `elapsedMs` answers the next value, and a sleep that only records. */
  function timing(...readings: number[]) {
    const queue = [...readings];
    return {
      elapsedMs: vi.fn(() => queue.shift() ?? 0),
      sleep: vi.fn(() => Promise.resolve()),
    };
  }

  function deferred() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  function settle() {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  it("journey 2 (with the trial): reserves it, creates the subscription for the day it ends, links it, and hands the Pix over", async () => {
    const port = wooviPort();
    const store = recordingStore([]);

    const result = await startPix(
      { now: () => now, port, store, ...timing(0, 3000) },
      pixInput
    );

    expect(store.startTrial).toHaveBeenCalledWith(organizationId, userId, now);
    expect(port.prepareSubscription).toHaveBeenCalledWith({
      amount: "249.00",
      cycleMonths: 12,
      firstChargeOn: "2026-10-21",
      payer: {
        ...PAYER,
        customerKey: await payerCustomerKey(SECRET, PAYER.taxId),
      },
      trial: true,
    });
    expect(store.attachProvider).toHaveBeenCalledWith(
      organizationId,
      "woovi",
      SUBSCRIPTION_REF,
      { firstChargeOn: "2026-10-21", priceAmount: "249.00", priceId: "pro-12" }
    );
    expect(result).toEqual({
      handoff: { emv: EMV, kind: "pix_authorization", url: AUTH_URL },
    });
  });

  it("journey 3 (without the trial): reserves nothing, and the first charge is today", async () => {
    const port = wooviPort();
    const store = recordingStore([]);

    await startPix(
      { now: () => now, port, store, ...timing(0, 3000) },
      { ...pixInput, trial: false }
    );

    expect(store.startTrial).not.toHaveBeenCalled();
    expect(port.prepareSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ firstChargeOn: "2026-10-14", trial: false })
    );
    expect(store.attachProvider).toHaveBeenCalledWith(
      organizationId,
      "woovi",
      SUBSCRIPTION_REF,
      { firstChargeOn: "2026-10-14", priceAmount: "249.00", priceId: "pro-12" }
    );
  });

  it("hands over a handoff with no page when Woovi gave none", async () => {
    const port = wooviPort({
      prepareSubscription: vi.fn(() =>
        Promise.resolve({
          ...pixPrepared,
          handoff: { emv: EMV, kind: "pix_authorization", url: null },
        } as PreparedSubscription)
      ),
    });

    await expect(
      startPix(
        {
          now: () => now,
          port,
          store: recordingStore([]),
          ...timing(0, 3000),
        },
        pixInput
      )
    ).resolves.toEqual({
      handoff: { emv: EMV, kind: "pix_authorization", url: null },
    });
  });

  it("refuses a handoff that is not a Pix authorization, and gives up what was created", async () => {
    const port = wooviPort({
      prepareSubscription: vi.fn(() => Promise.resolve(prepared)),
    });
    const store = recordingStore([]);

    await expect(
      startPix({ now: () => now, port, store, ...timing(0, 3000) }, pixInput)
    ).rejects.toThrow("billing_unexpected_handoff");

    expect(store.attachProvider).not.toHaveBeenCalled();
    expect(port.discardCheckout).toHaveBeenCalledWith(CHECKOUT_ID);
  });

  describe("the payer's lock", () => {
    it("runs the creation and the link inside it, with a key of 8 hex digits that does not carry the document", async () => {
      const log: string[] = [];
      const port = wooviPort({
        prepareSubscription: vi.fn(() => {
          log.push("prepare");
          return Promise.resolve(pixPrepared);
        }),
      });
      const store = recordingStore(log, {
        attachProvider: vi.fn(() => {
          log.push("attach");
          return Promise.resolve(null);
        }),
      });

      await startPix(
        { now: () => now, port, store, ...timing(0, 3000) },
        pixInput
      );

      const lockKey = await payerLockKey(SECRET, PAYER.taxId);
      expect(lockKey).toMatch(EIGHT_HEX);
      expect(PAYER.taxId).not.toContain(lockKey);
      expect(log).toEqual([
        `enter:${lockKey}`,
        "prepare",
        "attach",
        `exit:${lockKey}`,
      ]);
      expect(store.withPayerLock).toHaveBeenCalledWith(
        lockKey,
        expect.any(Function)
      );
    });

    it("is the same key for the same document, whoever the organization is", async () => {
      expect(await payerLockKey(SECRET, PAYER.taxId)).toBe(
        await payerLockKey(SECRET, PAYER.taxId)
      );
      const lockKeys: string[] = [];
      for (const org of [organizationId, "another-organization"]) {
        const store = fakeStore({
          withPayerLock: vi.fn(
            (lockKey: string, operation: () => Promise<unknown>) => {
              lockKeys.push(lockKey);
              return operation();
            }
          ),
        });
        // biome-ignore lint/performance/noAwaitInLoops: Two cases, in order.
        await startPix(
          { now: () => now, port: wooviPort(), store, ...timing(0, 3000) },
          { ...pixInput, organizationId: org }
        );
      }
      expect(lockKeys).toHaveLength(2);
      expect(lockKeys[0]).toBe(lockKeys[1]);
    });

    it("never lets two checkouts of the same document interleave: prepare1, attach1, prepare2, attach2", async () => {
      const order: string[] = [];
      const firstGate = deferred();
      const secondGate = deferred();
      const gates = [firstGate, secondGate];
      let prepares = 0;
      const port = wooviPort({
        prepareSubscription: vi.fn(
          async (request: PrepareSubscriptionInput) => {
            const turn = prepares;
            prepares += 1;
            order.push(`prepare:${request.payer?.name}`);
            await gates[turn]?.promise;
            return pixPrepared;
          }
        ),
      });
      // a real mutex by lockKey: the next operation starts when the previous one ends
      const tails = new Map<string, Promise<unknown>>();
      const store = fakeStore({
        attachProvider: vi.fn((org: string) => {
          order.push(`attach:${org === "org-1" ? "payer-1" : "payer-2"}`);
          return Promise.resolve(null);
        }),
        withPayerLock: vi.fn(
          (lockKey: string, operation: () => Promise<unknown>) => {
            const run = (tails.get(lockKey) ?? Promise.resolve()).then(
              operation
            );
            tails.set(
              lockKey,
              run.catch(() => undefined)
            );
            return run;
          }
        ),
      });
      const dependencies = {
        now: () => now,
        port,
        store,
        ...timing(0, 3000),
      };

      const first = startPix(dependencies, {
        ...pixInput,
        organizationId: "org-1",
        payer: { ...PAYER, name: "payer-1" },
      });
      const second = startPix(dependencies, {
        ...pixInput,
        organizationId: "org-2",
        payer: { ...PAYER, name: "payer-2" },
      });
      await settle();
      // only one of them is inside; the other waits at the lock with nothing created
      expect(order).toHaveLength(1);
      const [firstPrepare] = order;
      const winner = firstPrepare === "prepare:payer-1" ? "payer-1" : "payer-2";
      const loser = winner === "payer-1" ? "payer-2" : "payer-1";

      firstGate.release();
      await settle();
      expect(order).toEqual([
        `prepare:${winner}`,
        `attach:${winner}`,
        `prepare:${loser}`,
      ]);
      secondGate.release();
      await Promise.all([first, second]);

      expect(order).toEqual([
        `prepare:${winner}`,
        `attach:${winner}`,
        `prepare:${loser}`,
        `attach:${loser}`,
      ]);
    });

    it("lets checkouts of different keys run together", async () => {
      expect(await payerLockKey(SECRET, PAYER.taxId)).not.toBe(
        await payerLockKey(SECRET, OTHER_TAX_ID)
      );
      const order: string[] = [];
      const gate = deferred();
      const port = wooviPort({
        prepareSubscription: vi.fn(
          async (request: PrepareSubscriptionInput) => {
            order.push(`prepare:${request.payer?.taxId}`);
            await gate.promise;
            return pixPrepared;
          }
        ),
      });
      const tails = new Map<string, Promise<unknown>>();
      const store = fakeStore({
        withPayerLock: vi.fn(
          (lockKey: string, operation: () => Promise<unknown>) => {
            const run = (tails.get(lockKey) ?? Promise.resolve()).then(
              operation
            );
            tails.set(
              lockKey,
              run.catch(() => undefined)
            );
            return run;
          }
        ),
      });
      const dependencies = {
        now: () => now,
        port,
        store,
        ...timing(0, 3000),
      };

      const first = startPix(dependencies, pixInput);
      const second = startPix(dependencies, {
        ...pixInput,
        organizationId: "org-2",
        payer: { ...PAYER, taxId: OTHER_TAX_ID },
      });
      await settle();

      expect(order.sort()).toEqual(
        [`prepare:${PAYER.taxId}`, `prepare:${OTHER_TAX_ID}`].sort()
      );
      gate.release();
      await Promise.all([first, second]);
    });

    it("derives the key from the secret and the document: stable, 8 hex, secret-dependent, no document in it", async () => {
      const key = await payerLockKey(SECRET, PAYER.taxId);
      expect(key).toMatch(EIGHT_HEX);
      expect(key).toBe(await payerLockKey(SECRET, PAYER.taxId));
      expect(await payerLockKey("b".repeat(32), PAYER.taxId)).not.toBe(key);
      expect(await payerLockKey(SECRET, OTHER_TAX_ID)).not.toBe(key);
      expect(PAYER.taxId).not.toContain(key);
      expect(key).not.toContain(PAYER.taxId);
    });

    it("refuses a secret shorter than 32 characters", async () => {
      await expect(
        payerLockKey("a".repeat(31), PAYER.taxId)
      ).rejects.toBeInstanceOf(TypeError);
      await expect(payerLockKey("a".repeat(32), PAYER.taxId)).resolves.toMatch(
        EIGHT_HEX
      );
    });

    describe("payerCustomerKey", () => {
      it("is polaris-payer- and 32 hex digits, the same for the same secret and document", async () => {
        const key = await payerCustomerKey(SECRET, PAYER.taxId);
        expect(key).toMatch(PAYER_CUSTOMER_KEY);
        expect(key).toBe(await payerCustomerKey(SECRET, PAYER.taxId));
      });

      it("does not carry the document", async () => {
        for (const taxId of [PAYER.taxId, "11222333000181"]) {
          // biome-ignore lint/performance/noAwaitInLoops: Two cases, in order.
          const key = await payerCustomerKey(SECRET, taxId);
          expect(key).not.toContain(taxId);
          expect(key).toMatch(PAYER_CUSTOMER_KEY);
        }
      });

      it("changes with the document and with the secret", async () => {
        const key = await payerCustomerKey(SECRET, PAYER.taxId);
        expect(await payerCustomerKey(SECRET, OTHER_TAX_ID)).not.toBe(key);
        expect(await payerCustomerKey("b".repeat(32), PAYER.taxId)).not.toBe(
          key
        );
      });

      it("has its own label: it is not the 8 hex digits of the lock key", async () => {
        const lockKey = await payerLockKey(SECRET, PAYER.taxId);
        const key = await payerCustomerKey(SECRET, PAYER.taxId);
        expect(lockKey).toMatch(EIGHT_HEX);
        expect(key).not.toBe(lockKey);
        expect(key.startsWith(`polaris-payer-${lockKey}`)).toBe(false);
        expect(key).not.toContain(lockKey);
      });

      it("refuses a secret shorter than 32 characters", async () => {
        await expect(
          payerCustomerKey("a".repeat(31), PAYER.taxId)
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          payerCustomerKey("a".repeat(32), PAYER.taxId)
        ).resolves.toMatch(PAYER_CUSTOMER_KEY);
      });

      it("startPixCheckout gives the port that key as payer.customerKey, and no organization", async () => {
        const port = wooviPort();

        await startPix(
          {
            now: () => now,
            port,
            store: recordingStore([]),
            ...timing(0, 3000),
          },
          pixInput
        );

        expect(port.prepareSubscription).toHaveBeenCalledTimes(1);
        const [request] =
          vi.mocked(port.prepareSubscription).mock.calls[0] ?? [];
        expect(request?.payer?.customerKey).toBe(
          await payerCustomerKey(SECRET, PAYER.taxId)
        );
        expect(request?.payer).toMatchObject({
          email: PAYER.email,
          name: PAYER.name,
          taxId: PAYER.taxId,
        });
        expect(request).not.toHaveProperty("organizationId");
      });
    });

    it("asks again, inside the lock and before creating anything, whether the old checkout made a subscription", async () => {
      const oldLink = {
        provider: "woovi",
        providerRef: "woovi-old-ref",
        providerSubscriptionId: null,
      };
      const order: string[] = [];
      const hasSubscription = vi
        .fn<BillingProviderPort["hasSubscription"]>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const port = wooviPort({
        hasSubscription: hasSubscription.mockName("hasSubscription"),
      });
      const store = recordingStore(order, {
        readProviderLink: vi.fn(() => Promise.resolve(oldLink)),
      });

      await expect(
        startPix(
          { now: () => now, port, store, ...timing(0, 3000) },
          { ...pixInput, trial: false }
        )
      ).rejects.toMatchObject({ code: "checkout_pending_confirmation" });

      // once before the lock, once inside it
      expect(hasSubscription).toHaveBeenCalledTimes(2);
      expect(hasSubscription).toHaveBeenCalledWith("woovi-old-ref", null);
      expect(store.withPayerLock).toHaveBeenCalledTimes(1);
      expect(port.prepareSubscription).not.toHaveBeenCalled();
      expect(store.attachProvider).not.toHaveBeenCalled();
    });

    it("answers checkout_in_progress when the lock times out (55P03)", async () => {
      const store = fakeStore({
        withPayerLock: vi.fn(() =>
          Promise.reject(
            Object.assign(new Error("lock timeout"), { code: "55P03" })
          )
        ),
      });
      const port = wooviPort();

      await expect(
        startPix({ now: () => now, port, store, ...timing(0, 3000) }, pixInput)
      ).rejects.toMatchObject({
        code: "checkout_in_progress",
        name: "BillingCommandError",
      });
      expect(port.prepareSubscription).not.toHaveBeenCalled();
      expect(store.attachProvider).not.toHaveBeenCalled();
    });
  });

  describe("the answer does not tell what Woovi held", () => {
    it.each([
      ["unreported", undefined],
      ["created", "created"],
      ["matches", "matches"],
    ] as const)(
      "customer %s: the same handoff only, and never sooner than 3000 ms",
      async (_name, alignment) => {
        const port = wooviPort({
          prepareSubscription: vi.fn(() =>
            Promise.resolve({
              ...pixPrepared,
              ...(alignment ? { customerAlignment: alignment } : {}),
            })
          ),
        });
        const clock = timing(100, 1100);

        const result = await startPix(
          { now: () => now, port, store: recordingStore([]), ...clock },
          pixInput
        );

        expect(result).toStrictEqual({
          handoff: { emv: EMV, kind: "pix_authorization", url: AUTH_URL },
        });
        expect(clock.sleep).toHaveBeenCalledTimes(1);
        expect(clock.sleep).toHaveBeenCalledWith(
          PIX_CHECKOUT_MINIMUM_MS - 1000
        );
      }
    );

    it("does not sleep when the work already took the minimum", async () => {
      const clock = timing(0, 3500);

      await startPix(
        {
          now: () => now,
          port: wooviPort(),
          store: recordingStore([]),
          ...clock,
        },
        pixInput
      );

      expect(clock.sleep).not.toHaveBeenCalled();
    });

    it("waits the minimum on a refusal too, so a refusal is no faster than a success", async () => {
      const clock = timing(0, 400);
      const port = wooviPort({
        prepareSubscription: vi.fn(() =>
          Promise.reject(new WooviCustomerMismatchError())
        ),
      });

      await expect(
        startPix(
          { now: () => now, port, store: recordingStore([]), ...clock },
          pixInput
        )
      ).rejects.toMatchObject({ code: "payer_not_accepted" });

      expect(clock.sleep).toHaveBeenCalledWith(PIX_CHECKOUT_MINIMUM_MS - 400);
    });

    it("waits the minimum on a failure that is not a refusal too", async () => {
      const clock = timing(0, 0);
      const failure = new Error("boom");
      const port = wooviPort({
        prepareSubscription: vi.fn(() => Promise.reject(failure)),
      });

      await expect(
        startPix(
          { now: () => now, port, store: recordingStore([]), ...clock },
          pixInput
        )
      ).rejects.toBe(failure);

      expect(clock.sleep).toHaveBeenCalledWith(PIX_CHECKOUT_MINIMUM_MS);
    });

    it("waits the minimum even when the checkout is refused before the provider is asked", async () => {
      const clock = timing(0, 10);
      const store = recordingStore([], {
        readRecord: vi.fn(() =>
          Promise.resolve({ accessEndsAt: null, state: "active" })
        ),
      });

      await expect(
        startPix(
          { now: () => now, port: wooviPort(), store, ...clock },
          pixInput
        )
      ).rejects.toMatchObject({ code: "already_subscribed" });

      expect(clock.sleep).toHaveBeenCalledWith(PIX_CHECKOUT_MINIMUM_MS - 10);
    });
  });

  describe("a refusal about the payer's data", () => {
    it("WooviCustomerMismatchError is payer_not_accepted, nothing linked", async () => {
      const port = wooviPort({
        prepareSubscription: vi.fn(() =>
          Promise.reject(new WooviCustomerMismatchError())
        ),
      });
      const store = recordingStore([]);

      const refusal = await startPix(
        { now: () => now, port, store, ...timing(0, 3000) },
        pixInput
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(BillingCommandError);
      expect(refusal).toMatchObject({
        code: "payer_not_accepted",
        message: "payer_not_accepted",
      });
      expect(store.attachProvider).not.toHaveBeenCalled();
    });

    it("the refusal says nothing of the customer: no document, e-mail or name in it", async () => {
      const port = wooviPort({
        prepareSubscription: vi.fn(() =>
          Promise.reject(new WooviCustomerMismatchError())
        ),
      });

      const refusal = (await startPix(
        {
          now: () => now,
          port,
          store: recordingStore([]),
          ...timing(0, 3000),
        },
        pixInput
      ).catch((error: unknown) => error)) as BillingCommandError;

      expect(refusal).toBeInstanceOf(BillingCommandError);
      const shown = `${refusal.name} ${refusal.code} ${refusal.message}`;
      for (const value of [PAYER.taxId, PAYER.email, PAYER.name]) {
        expect(shown).not.toContain(value);
      }
    });
  });

  it("gives the open checkout up when the link fails", async () => {
    const failure = new Error("attach_failed");
    const port = wooviPort();
    const store = recordingStore([], {
      attachProvider: vi.fn(() => Promise.reject(failure)),
    });

    await expect(
      startPix({ now: () => now, port, store, ...timing(0, 3000) }, pixInput)
    ).rejects.toBe(failure);

    expect(port.discardCheckout).toHaveBeenCalledWith(pixPrepared.checkoutId);
  });

  describe("what reaches the logs", () => {
    function assertNoPersonalData(logged: string) {
      for (const secret of [
        PAYER.taxId,
        PAYER.email,
        PAYER.name,
        EMV,
        AUTH_URL,
        SUBSCRIPTION_REF,
        pixPrepared.checkoutId,
      ]) {
        expect(logged).not.toContain(secret);
      }
    }

    it("logs billing_payer_customer_created, with no personal data, only when the customer was created", async () => {
      const port = wooviPort({
        prepareSubscription: vi.fn(() =>
          Promise.resolve({
            ...pixPrepared,
            customerAlignment: "created" as const,
          })
        ),
      });

      await startPix(
        {
          now: () => now,
          port,
          store: recordingStore([]),
          ...timing(0, 3000),
        },
        pixInput
      );

      const created = loggerSpies.flatMap((spy) =>
        spy.mock.calls.filter(
          ([event]: unknown[]) => event === "billing_payer_customer_created"
        )
      );
      expect(created).toHaveLength(1);
      expect(JSON.stringify(created)).not.toContain("alignment");
      assertNoPersonalData(everythingLogged());
    });

    it.each(["unreported", "matches"] as const)(
      "does not log the creation when the customer was %s",
      async (alignment) => {
        const port = wooviPort({
          prepareSubscription: vi.fn(() =>
            Promise.resolve({
              ...pixPrepared,
              ...(alignment === "matches"
                ? { customerAlignment: "matches" as const }
                : {}),
            })
          ),
        });

        await startPix(
          {
            now: () => now,
            port,
            store: recordingStore([]),
            ...timing(0, 3000),
          },
          pixInput
        );

        expect(everythingLogged()).not.toContain(
          "billing_payer_customer_created"
        );
        assertNoPersonalData(everythingLogged());
      }
    );

    it("logs no personal data on a refusal, nor on a failure that quotes the payer", async () => {
      for (const failure of [
        new WooviCustomerMismatchError(),
        new Error(
          `failed for ${PAYER.taxId} ${PAYER.email} ${PAYER.name} ${EMV}`
        ),
      ]) {
        const port = wooviPort({
          prepareSubscription: vi.fn(() => Promise.reject(failure)),
        });
        // biome-ignore lint/performance/noAwaitInLoops: Two cases, in order.
        await expect(
          startPix(
            {
              now: () => now,
              port,
              store: recordingStore([]),
              ...timing(0, 3000),
            },
            pixInput
          )
        ).rejects.toThrow();
      }

      assertNoPersonalData(everythingLogged());
    });
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
  const request = { organizationId, requestId: "req-refund-1" };
  const active = { cancelAtPeriodEnd: false, state: "active" };

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("is not_linked without a link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("not_linked");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
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
          request
        )
      ).resolves.toBe(answer);
      expect(port.refundCurrentPeriod).toHaveBeenCalledWith(
        link.providerRef,
        now,
        link.providerSubscriptionId
      );
    }
  );

  it("cancels the renewal and writes it before it refunds", async () => {
    const calls: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() => {
        calls.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
      refundCurrentPeriod: vi.fn(() => {
        calls.push("refund");
        return Promise.resolve("refund_requested" as const);
      }),
    });
    const store = fakeStore({
      processEvent: vi.fn(() => {
        calls.push("process");
        return Promise.resolve({ status: "applied" });
      }),
      readRecord: vi.fn(() => Promise.resolve(active)),
      recordEvent: vi.fn(() => {
        calls.push("record");
        return Promise.resolve({ duplicate: false, id: "ev-cancel" });
      }),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");

    expect(calls).toEqual(["cancel", "record", "process", "refund"]);
    expect(port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(store.recordEvent).toHaveBeenCalledWith({
      fact: { occurredAt: now, type: "subscription_cancelled" },
      organizationId,
      provider: "asaas",
      providerEventId: await refundCancelEventId(
        request.requestId,
        link.providerRef
      ),
      providerRef: link.providerRef,
    });
    expect(store.processEvent).toHaveBeenCalledWith("ev-cancel", now);
  });

  it("refunds nothing when the cancellation fails", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() =>
        Promise.reject(new ProviderUnavailableError())
      ),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("does not cancel again a renewal the record already shows cancelled", async () => {
    const port = fakePort();
    const store = fakeStore({
      readRecord: vi.fn(() =>
        Promise.resolve({ cancelAtPeriodEnd: true, state: "active" })
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
  });

  it("cancel ok, refund fails, a repeat with another request ID: one cancellation and one refund", async () => {
    // the record as the inbox leaves it: the cancellation fact applied sets cancelAtPeriodEnd
    const record = { ...active };
    const cancellations: string[] = [];
    const store = fakeStore({
      processEvent: vi.fn(() => {
        record.cancelAtPeriodEnd = true;
        return Promise.resolve({ status: "applied" });
      }),
      readRecord: vi.fn(() => Promise.resolve({ ...record })),
      recordEvent: vi.fn((event: { providerEventId: string }) => {
        cancellations.push(event.providerEventId);
        return Promise.resolve({ duplicate: false, id: "ev-cancel" });
      }),
    });
    const port = fakePort({
      refundCurrentPeriod: vi
        .fn()
        .mockRejectedValueOnce(new ProviderUnavailableError())
        .mockResolvedValueOnce("refund_requested"),
    });
    const dependencies = { now: () => now, portFor: () => port, store };

    await expect(
      refundCurrentPeriod(dependencies, request)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      refundCurrentPeriod(dependencies, {
        organizationId,
        requestId: "req-refund-2",
      })
    ).resolves.toBe("refund_requested");

    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(cancellations).toEqual([
      await refundCancelEventId(request.requestId, link.providerRef),
    ]);
    expect(port.refundCurrentPeriod).toHaveBeenCalledTimes(2);
  });

  it("still cancels at the provider when the record no longer gives Pro, without writing a fact it would ignore", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("already_cancelled" as const)),
      refundCurrentPeriod: vi.fn(() =>
        Promise.resolve("nothing_to_refund" as const)
      ),
    });
    const store = fakeStore({
      readRecord: vi.fn(() =>
        Promise.resolve({ cancelAtPeriodEnd: false, state: "free" })
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("nothing_to_refund");
    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it.each(["trialing", "grace"])(
    "writes the cancellation of a record in %s (it gives Pro)",
    async (state) => {
      const store = fakeStore({
        readRecord: vi.fn(() =>
          Promise.resolve({ cancelAtPeriodEnd: false, state })
        ),
      });

      await refundCurrentPeriod(
        { now: () => now, portFor: () => fakePort(), store },
        request
      );
      expect(store.recordEvent).toHaveBeenCalledTimes(1);
    }
  );

  it("still cancels at the provider without a record, and writes nothing", async () => {
    const port = fakePort();
    const store = fakeStore();

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");
    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("writes the cancellation when the provider had it cancelled but the record did not", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("already_cancelled" as const)),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await refundCurrentPeriod(
      { now: () => now, portFor: () => port, store },
      request
    );
    expect(store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("touches nothing at a provider that cannot refund here (Woovi before S3.2)", async () => {
    const port = fakePort({ refundsEnabled: false });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("runs under the organization's lock, and a lock held elsewhere does nothing", async () => {
    const port = fakePort();
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
      withOrganizationLock: vi.fn(() =>
        Promise.reject(new BillingCommandInProgressError())
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).rejects.toBeInstanceOf(BillingCommandInProgressError);
    expect(store.withOrganizationLock).toHaveBeenCalledWith(
      organizationId,
      expect.any(Function)
    );
    expect(store.readProviderLink).not.toHaveBeenCalled();
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
  });

  it("names the cancellation apart from the owner's, one per request and subscription", async () => {
    const id = await refundCancelEventId("req-42", link.providerRef);
    expect(id).toMatch(REFUND_CANCEL_EVENT_ID);
    expect(id).not.toBe(await cancelRenewalEventId("req-42", link.providerRef));
    expect(await refundCancelEventId("req-42", "another-ref")).not.toBe(id);
  });

  describe("when the port returns the refund's own fact (Woovi)", () => {
    const refundEvent = {
      fact: { occurredAt: now, type: "subscription_cancelled" as const },
      providerEventId: "woovi:refund:ref-0001",
      providerRef: "woovi-sub-ref-0001",
      providerSubscriptionId: "woovi-sub-0001",
    };
    const wooviLink = {
      provider: "woovi",
      providerRef: "woovi-sub-ref-0001",
      providerSubscriptionId: "woovi-sub-0001",
    };

    it("writes the fact through the inbox with the organization, processes it, and returns refund_requested", async () => {
      const calls: string[] = [];
      const port = fakePort({
        provider: "woovi" as never,
        refundCurrentPeriod: vi.fn(() =>
          Promise.resolve({
            event: refundEvent,
            kind: "refund_requested" as const,
          })
        ),
      });
      const store = fakeStore({
        processEvent: vi.fn(() => {
          calls.push("process");
          return Promise.resolve({ status: "applied" });
        }),
        readProviderLink: vi.fn(() => Promise.resolve(wooviLink)),
        recordEvent: vi.fn(() => {
          calls.push("record");
          return Promise.resolve({ duplicate: false, id: "ev-refund" });
        }),
      });

      await expect(
        refundCurrentPeriod(
          { now: () => now, portFor: () => port, store },
          request
        )
      ).resolves.toBe("refund_requested");

      expect(store.recordEvent).toHaveBeenCalledWith({
        fact: refundEvent.fact,
        organizationId,
        provider: "woovi",
        providerEventId: "woovi:refund:ref-0001",
        providerRef: "woovi-sub-ref-0001",
        providerSubscriptionId: "woovi-sub-0001",
      });
      expect(store.processEvent).toHaveBeenCalledWith("ev-refund", now);
      expect(calls).toEqual(["record", "process"]);
    });

    it("writes nothing when the port answers with a string (the older behavior)", async () => {
      const store = fakeStore();

      await refundCurrentPeriod(
        { now: () => now, portFor: () => fakePort(), store },
        request
      );

      expect(store.recordEvent).not.toHaveBeenCalled();
      expect(store.processEvent).not.toHaveBeenCalled();
    });
  });
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

describe("the old link's renewal is cancelled before a new checkout (ADR 0104, PR 296)", () => {
  const SUBSCRIPTION_REF = "woovi-sub-ref-0001";
  const pixPrepared: PreparedSubscription = {
    checkoutId: "woovi-checkout-0001",
    handoff: {
      emv: "00020126580014br.gov.bcb.pix0136EMV6304ABCD",
      kind: "pix_authorization",
      url: "https://woovi-sandbox.com/pay/secret",
    },
    providerRef: SUBSCRIPTION_REF,
  };
  const oldWooviLink = {
    provider: "woovi",
    providerRef: "old-woovi-ref-0001",
    providerSubscriptionId: "old-woovi-sub-0001",
  };

  beforeEach(() => {
    for (const method of ["debug", "info", "warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels the subscription of the old link at the provider before the new subscription is prepared", async () => {
    const order: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() => {
        order.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
      prepareSubscription: vi.fn(() => {
        order.push("prepare");
        return Promise.resolve(prepared);
      }),
    });
    const store = fakeStore();

    await startCardCheckout({ now: () => now, port, store }, input);

    expect(port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(order).toEqual(["cancel", "prepare"]);
  });

  it("reaches the old provider's own port when the old link is of the other provider", async () => {
    const cardPort = fakePort();
    const wooviPort = fakePort({ provider: "woovi" as never });
    const portFor = vi.fn((_provider: string) => wooviPort);
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(oldWooviLink)),
    });

    await startCardCheckout(
      { now: () => now, port: cardPort, portFor, store },
      input
    );

    expect(portFor).toHaveBeenCalledWith("woovi");
    expect(wooviPort.cancelRenewal).toHaveBeenCalledWith(
      oldWooviLink.providerRef,
      oldWooviLink.providerSubscriptionId
    );
    expect(cardPort.cancelRenewal).not.toHaveBeenCalled();
    expect(cardPort.prepareSubscription).toHaveBeenCalledTimes(1);
  });

  it("uses the checkout's own port, not portFor, when the old link is of the same provider", async () => {
    const port = fakePort();
    const portFor = vi.fn((_provider: string) => fakePort());

    await startCardCheckout(
      { now: () => now, port, portFor, store: fakeStore() },
      input
    );

    expect(portFor).not.toHaveBeenCalled();
    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
  });

  it("refuses with billing_provider_not_configured, creating nothing, when the old link is of another provider and no port for it is given", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(oldWooviLink)),
    });

    await expect(
      startCardCheckout({ now: () => now, port, store }, input)
    ).rejects.toMatchObject({
      code: "billing_provider_not_configured",
    });

    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.prepareSubscription).not.toHaveBeenCalled();
    expect(store.startTrial).not.toHaveBeenCalled();
    expect(store.attachProvider).not.toHaveBeenCalled();
  });

  it("refuses with provider_unavailable, creating nothing, when the provider cannot cancel the old renewal", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.reject(new Error("socket hang up"))),
    });
    const store = fakeStore();

    const error = await startCardCheckout(
      { now: () => now, port, store },
      input
    ).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(port.prepareSubscription).not.toHaveBeenCalled();
    expect(store.startTrial).not.toHaveBeenCalled();
    expect(store.attachProvider).not.toHaveBeenCalled();
  });

  it("does not call the provider for an old link that no subscription came from", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() =>
        Promise.resolve({ ...link, providerSubscriptionId: null })
      ),
    });

    await startCardCheckout({ now: () => now, port, store }, input);

    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.prepareSubscription).toHaveBeenCalledTimes(1);
    expect(store.attachProvider).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when the organization has no link at all", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await startCardCheckout({ now: () => now, port, store }, input);

    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.prepareSubscription).toHaveBeenCalledTimes(1);
  });

  it("applies the same rule to the Pix checkout: the card's old renewal is cancelled through the other provider's port, before the Pix is prepared", async () => {
    const order: string[] = [];
    const asaasPort = fakePort({
      cancelRenewal: vi.fn(() => {
        order.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
    });
    const pixPort = fakePort({
      prepareSubscription: vi.fn(() => {
        order.push("prepare");
        return Promise.resolve(pixPrepared);
      }),
      provider: "woovi" as never,
    });
    const portFor = vi.fn((_provider: string) => asaasPort);
    const store = fakeStore({
      withPayerLock: vi.fn(
        (_lockKey: string, operation: () => Promise<unknown>) => operation()
      ),
    });

    await startPixCheckout(
      {
        elapsedMs: vi
          .fn()
          .mockReturnValueOnce(0)
          .mockReturnValue(PIX_CHECKOUT_MINIMUM_MS),
        now: () => now,
        payerKey: "a".repeat(32),
        port: pixPort,
        portFor,
        sleep: () => Promise.resolve(),
        store,
      },
      {
        ...input,
        payer: {
          email: "pagador.pix@example.com",
          name: "Pagador Pix de Teste",
          taxId: "52998224725",
        },
      }
    );

    expect(portFor).toHaveBeenCalledWith("asaas");
    expect(order).toEqual(["cancel", "prepare"]);
  });
});
