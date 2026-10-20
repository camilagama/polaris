import { describe, expect, it } from "vitest";
import { BILLING_STATES } from "./entitlements";
import {
  billingProviderHandled,
  checkoutOpen,
  HANDLED_BILLING_PROVIDERS,
  RENEWAL_CANCELLATION_STATUSES,
  renewalAlive,
  renewalBlocksPurge,
  renewalCancellationStatus,
} from "./renewal-cancellation";

const asaas = { provider: "asaas", providerSubscriptionId: "sub_1" };
const asaasCheckout = { provider: "asaas", providerSubscriptionId: null };
const woovi = { provider: "woovi", providerSubscriptionId: "sub_2" };
const handlesAsaas = (provider: string) => provider === "asaas";

describe("renewalAlive", () => {
  it.each(["trialing", "active", "grace"] as const)(
    "is alive with a provider linked, %s and no cancellation recorded",
    (state) => {
      expect(renewalAlive({ cancelAtPeriodEnd: false, state }, asaas)).toBe(
        true
      );
    }
  );

  it("is not alive once the cancellation at the end of the period is recorded", () => {
    expect(
      renewalAlive({ cancelAtPeriodEnd: true, state: "active" }, asaas)
    ).toBe(false);
  });

  it.each(["free", "free_over_limit", "trial_setup"] as const)(
    "is not alive in %s (nothing charges again)",
    (state) => {
      expect(renewalAlive({ cancelAtPeriodEnd: false, state }, asaas)).toBe(
        false
      );
    }
  );

  it("is not alive without a provider linked or without a record", () => {
    expect(
      renewalAlive({ cancelAtPeriodEnd: false, state: "active" }, null)
    ).toBe(false);
    expect(renewalAlive(null, asaas)).toBe(false);
  });

  it("covers exactly the states the hourly database function lists ('trialing', 'active', 'grace')", () => {
    const alive = BILLING_STATES.filter((state) =>
      renewalAlive({ cancelAtPeriodEnd: false, state }, asaas)
    );
    expect(alive).toEqual(["trialing", "active", "grace"]);
  });
});

describe("renewalCancellationStatus", () => {
  it("has three statuses, in the order the panel reads them", () => {
    expect(RENEWAL_CANCELLATION_STATUSES).toEqual([
      "not_handled",
      "pending",
      "cancelled",
    ]);
  });

  it("is pending while the renewal is alive at a provider Polaris cancels through", () => {
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: false, state: "active" },
        asaas,
        handlesAsaas
      )
    ).toBe("pending");
  });

  it.each(["free", "trial_setup"] as const)(
    "is pending in %s while a checkout opened before the closure is not given up, and cancelled once it is",
    (state) => {
      const record = { cancelAtPeriodEnd: false, state };
      expect(
        renewalCancellationStatus(record, asaasCheckout, handlesAsaas)
      ).toBe("pending");
      expect(
        renewalCancellationStatus(record, asaasCheckout, handlesAsaas, true)
      ).toBe("cancelled");
    }
  );

  it("is cancelled once the cancellation is recorded, and when nothing is left to renew", () => {
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: true, state: "active" },
        asaas,
        handlesAsaas
      )
    ).toBe("cancelled");
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: false, state: "free" },
        asaas,
        handlesAsaas
      )
    ).toBe("cancelled");
  });

  it("is not handled without a provider, without a record, or with a provider Polaris does not cancel through", () => {
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: false, state: "free" },
        null,
        handlesAsaas
      )
    ).toBe("not_handled");
    expect(renewalCancellationStatus(null, null, handlesAsaas)).toBe(
      "not_handled"
    );
    // the record says alive, but the cancellation is the person's to make: the screen never promises it
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: false, state: "active" },
        woovi,
        handlesAsaas
      )
    ).toBe("not_handled");
  });
});

describe("checkoutOpen", () => {
  it.each(["free", "free_over_limit", "trial_setup"] as const)(
    "is open in %s with a checkout linked and no subscription matched, until it is given up",
    (state) => {
      const record = { cancelAtPeriodEnd: false, state };
      expect(checkoutOpen(record, asaasCheckout, false)).toBe(true);
      expect(checkoutOpen(record, asaasCheckout, true)).toBe(false);
    }
  );

  it("is not open once a subscription matched, in a state that gives Pro, or without a link", () => {
    expect(
      checkoutOpen({ cancelAtPeriodEnd: false, state: "free" }, asaas, false)
    ).toBe(false);
    expect(
      checkoutOpen(
        { cancelAtPeriodEnd: false, state: "active" },
        asaasCheckout,
        false
      )
    ).toBe(false);
    expect(
      checkoutOpen({ cancelAtPeriodEnd: false, state: "free" }, null, false)
    ).toBe(false);
    expect(checkoutOpen(null, asaasCheckout, false)).toBe(false);
  });
});

describe("the providers Polaris acts through", () => {
  it("are Asaas and Woovi, each with its outbound port (cobrança PR 6)", () => {
    expect(HANDLED_BILLING_PROVIDERS).toEqual(["asaas", "woovi"]);
    expect(billingProviderHandled("asaas")).toBe(true);
    expect(billingProviderHandled("woovi")).toBe(true);
    expect(billingProviderHandled("stripe")).toBe(false);
  });
});

describe("renewalBlocksPurge", () => {
  it("blocks while the renewal is alive at a provider Polaris cancels through", () => {
    expect(
      renewalBlocksPurge({ cancelAtPeriodEnd: false, state: "active" }, asaas)
    ).toBe(true);
  });

  it("does not block once cancelled, without Pro, without a link or at a provider Polaris does not cancel through", () => {
    expect(
      renewalBlocksPurge({ cancelAtPeriodEnd: true, state: "active" }, asaas)
    ).toBe(false);
    expect(
      renewalBlocksPurge(
        { cancelAtPeriodEnd: false, state: "free" },
        asaasCheckout
      )
    ).toBe(false);
    expect(
      renewalBlocksPurge({ cancelAtPeriodEnd: false, state: "active" }, null)
    ).toBe(false);
    expect(
      renewalBlocksPurge(
        { cancelAtPeriodEnd: false, state: "active" },
        { provider: "stripe", providerSubscriptionId: "sub_3" }
      )
    ).toBe(false);
  });

  it("blocks a live Woovi renewal too, now that Polaris cancels through it", () => {
    expect(
      renewalBlocksPurge({ cancelAtPeriodEnd: false, state: "active" }, woovi)
    ).toBe(true);
  });
});
