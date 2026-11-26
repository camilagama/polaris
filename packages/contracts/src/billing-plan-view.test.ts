import { describe, expect, it } from "vitest";
import { type BillingPlanView, billingPlanView } from "./index";

const plan: BillingPlanView = {
  accessEndsAt: "2026-11-11T03:00:00.000Z",
  cycleMonths: 1,
  kept: { historyMonths: 3, products: 12, sales: 140 },
  limits: { goals: 3, images: 5000, variants: 2000 },
  method: "card",
  nextCharge: { amount: "24.90", cycleMonths: 1, on: "2026-11-10" },
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [{ amount: "24.90", cycleMonths: 1 }],
  },
  proLimits: { goals: 3, images: 5000, variants: 2000 },
  recovery: null,
  refund: { amount: "24.90", until: "2026-10-18T02:59:59.000Z", via: "app" },
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "active",
  trialAvailable: false,
  usage: {
    freeable: { products: 2, variants: 5 },
    goals: 1,
    images: 9,
    variants: 31,
  },
};

describe("billing.readPlan output (AS-2)", () => {
  it("takes the plan as the server builds it", () => {
    expect(billingPlanView.parse(plan)).toEqual(plan);
  });

  it("takes the answer of an older server without proLimits, and does not add the key", () => {
    const { proLimits: _omitted, ...older } = plan;

    const parsed = billingPlanView.parse(older);

    expect(parsed).toEqual(older);
    expect(parsed).not.toHaveProperty("proLimits");
  });

  it("takes the answer of an older server without usage.freeable, and does not add the key", () => {
    const { freeable: _omitted, ...usage } = plan.usage;
    const older = { ...plan, usage };

    const parsed = billingPlanView.parse(older);

    expect(parsed).toEqual(older);
    expect(parsed.usage).not.toHaveProperty("freeable");
  });

  it("refuses a usage.freeable that is negative, fractional or carries another key", () => {
    for (const freeable of [
      { products: -1, variants: 0 },
      { products: 1.5, variants: 0 },
      { products: 1 },
      { products: 1, variants: 1, providerRef: "sub_123" },
    ]) {
      expect(
        billingPlanView.safeParse({
          ...plan,
          usage: { ...plan.usage, freeable },
        }).success
      ).toBe(false);
    }
  });

  it("takes a Pro limit that is null (no limit) and refuses a negative or fractional one", () => {
    const unlimited = {
      ...plan,
      proLimits: { goals: null, images: null, variants: null },
    };
    expect(billingPlanView.parse(unlimited)).toEqual(unlimited);
    for (const variants of [-1, 1.5]) {
      expect(
        billingPlanView.safeParse({
          ...plan,
          proLimits: { ...plan.proLimits, variants },
        }).success
      ).toBe(false);
    }
  });

  it("takes the day the window of the right of withdrawal ended, and only a calendar day", () => {
    const ended = { ...plan, refund: null, refundWindowEndedOn: "2026-10-17" };
    expect(billingPlanView.parse(ended)).toEqual(ended);
    expect(
      billingPlanView.safeParse({
        ...ended,
        refundWindowEndedOn: "2026-10-17T23:59:59.000Z",
      }).success
    ).toBe(false);
  });

  it.each([
    ["the plan", (value: BillingPlanView) => value],
    ["nextCharge", (value: BillingPlanView) => value.nextCharge],
    ["refund", (value: BillingPlanView) => value.refund],
    ["offer", (value: BillingPlanView) => value.offer],
    ["a price of the offer", (value: BillingPlanView) => value.offer.prices[0]],
    ["limits", (value: BillingPlanView) => value.limits],
    ["proLimits", (value: BillingPlanView) => value.proLimits],
    ["usage", (value: BillingPlanView) => value.usage],
    ["freeable", (value: BillingPlanView) => value.usage.freeable],
    ["kept", (value: BillingPlanView) => value.kept],
  ])(
    "refuses a key the list does not have in %s: a provider reference never leaves",
    (_label, pick) => {
      const leaked = JSON.parse(JSON.stringify(plan)) as BillingPlanView;
      Object.assign(pick(leaked) as object, { providerRef: "sub_123" });

      expect(billingPlanView.safeParse(leaked).success).toBe(false);
    }
  );

  it("refuses money with other than two decimals, and a method or a recovery outside V1", () => {
    for (const leaked of [
      { ...plan, nextCharge: { amount: "24.9", on: "2026-11-10" } },
      { ...plan, method: "boleto" },
      { ...plan, recovery: "provider_retries" },
      { ...plan, refund: { ...plan.refund, via: "email" } },
    ]) {
      expect(billingPlanView.safeParse(leaked).success).toBe(false);
    }
  });
});
