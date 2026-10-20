import { describe, expect, it } from "vitest";
import { BILLING_STATES } from "./entitlements";
import {
  RENEWAL_CANCELLATION_STATUSES,
  renewalAlive,
  renewalCancellationStatus,
} from "./renewal-cancellation";

const asaas = { provider: "asaas" };
const woovi = { provider: "woovi" };
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

  it("is pending while a checkout opened before the closure can still become a subscription", () => {
    expect(
      renewalCancellationStatus(
        { cancelAtPeriodEnd: false, state: "trial_setup" },
        asaas,
        handlesAsaas
      )
    ).toBe("pending");
  });

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
