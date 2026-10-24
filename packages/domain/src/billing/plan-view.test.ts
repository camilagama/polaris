import { describe, expect, it } from "vitest";
import {
  nextChargeOf,
  type PlanViewRecord,
  planMethodOf,
  recoveryOf,
  refundOfferOf,
  refundPendingOf,
  refundWindowOf,
  resubscribeFromOf,
} from "./plan-view";

/** An instant in São Paulo (UTC-3, no daylight saving time since 2019). */
const sp = (local: string) => new Date(`${local}-03:00`);

const free: PlanViewRecord = {
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
  firstChargeAmount: null,
  firstChargeAt: null,
  firstChargeOn: null,
  priceAmount: null,
  provider: null,
  refundRequestedAt: null,
  revoked: null,
  state: "free",
};

const trialing: PlanViewRecord = {
  ...free,
  accessEndsAt: sp("2026-10-17T15:00:00"),
  firstChargeOn: "2026-10-17",
  priceAmount: "24.90",
  provider: "asaas",
  state: "trialing",
};

/** Paid on 10/10 at 15:00 in São Paulo, monthly: the period runs through 10/11. */
const active: PlanViewRecord = {
  ...trialing,
  accessEndsAt: sp("2026-11-11T00:00:00"),
  firstChargeAmount: "24.90",
  firstChargeAt: sp("2026-10-10T15:00:00"),
  state: "active",
};

describe("nextChargeOf (AS-3)", () => {
  it("in a trial is the day of the first charge set at the provider, never the end of the trial", () => {
    // a Pix approved on day 2: the trial ends a day after the charge the provider has set
    const lateApproval = {
      ...trialing,
      accessEndsAt: sp("2026-10-18T09:00:00"),
    };

    expect(nextChargeOf(lateApproval, sp("2026-10-12T10:00:00"))).toEqual({
      amount: "24.90",
      on: "2026-10-17",
    });
  });

  it.each([
    ["the eve", "2026-10-16T23:59:59"],
    ["the day itself", "2026-10-17T00:00:00"],
    ["23:59 of the day before", "2026-10-16T23:59:00"],
    ["00:01 of the day", "2026-10-17T00:01:00"],
  ])("keeps the provider's day on %s, in São Paulo", (_label, local) => {
    expect(nextChargeOf(trialing, sp(local))?.on).toBe("2026-10-17");
  });

  it("while paid and renewing is the last day of the paid period, with the price recorded at the checkout", () => {
    expect(nextChargeOf(active, sp("2026-10-20T12:00:00"))).toEqual({
      amount: "24.90",
      on: "2026-11-10",
    });
    // 23:59 and 00:01 around the end of the period, in São Paulo
    expect(nextChargeOf(active, sp("2026-11-10T23:59:00"))?.on).toBe(
      "2026-11-10"
    );
    expect(nextChargeOf(active, sp("2026-11-11T00:01:00"))).toBeNull();
  });

  it("is none with the renewal cancelled, in grace, on Free and in trial setup", () => {
    const now = sp("2026-10-20T12:00:00");
    expect(nextChargeOf({ ...active, cancelAtPeriodEnd: true }, now)).toBe(
      null
    );
    expect(nextChargeOf({ ...trialing, cancelAtPeriodEnd: true }, now)).toBe(
      null
    );
    expect(nextChargeOf({ ...active, state: "grace" }, now)).toBeNull();
    expect(nextChargeOf(free, now)).toBeNull();
    expect(nextChargeOf({ ...free, state: "free_over_limit" }, now)).toBe(null);
    expect(
      nextChargeOf(
        { ...trialing, accessEndsAt: null, state: "trial_setup" },
        now
      )
    ).toBeNull();
  });

  it("invents nothing for a link older than the recorded price or day", () => {
    const now = sp("2026-10-12T10:00:00");
    expect(nextChargeOf({ ...trialing, firstChargeOn: null }, now)).toBeNull();
    expect(nextChargeOf({ ...active, priceAmount: null }, now)).toBeNull();
  });
});

describe("refundWindowOf (AS-7, T-5)", () => {
  const until = sp("2026-10-17T23:59:59");

  it("ends at 23:59:59 in São Paulo of the 7th calendar day after the first charge, with its amount", () => {
    expect(refundWindowOf(active, sp("2026-10-12T09:00:00"))).toEqual({
      amount: "24.90",
      until,
    });
  });

  it.each([
    ["the eve of the 7th day", "2026-10-16T23:59:59", true],
    ["noon of the 7th day", "2026-10-17T12:00:00", true],
    ["23:59:59 of the 7th day", "2026-10-17T23:59:59", true],
    ["23:59:59.999 of the 7th day", "2026-10-17T23:59:59.999", true],
    ["00:00:00 of the 8th day", "2026-10-18T00:00:00", false],
    ["00:01 of the 8th day", "2026-10-18T00:01:00", false],
  ])("on %s it is open: %s", (_label, local, open) => {
    expect(refundWindowOf(active, sp(local)) !== null).toBe(open);
  });

  it.each([
    ["00:00:30", "2026-10-10T00:00:30"],
    ["23:59", "2026-10-10T23:59:00"],
    ["23:59:59.999", "2026-10-10T23:59:59.999"],
  ])(
    "a first charge at %s on 10/10 closes on 17/10 all the same",
    (_label, local) => {
      const record = { ...active, firstChargeAt: sp(local) };
      expect(refundWindowOf(record, sp("2026-10-15T08:00:00"))?.until).toEqual(
        until
      );
      expect(refundWindowOf(record, sp("2026-10-18T00:00:00"))).toBeNull();
    }
  );

  it("counts the day in São Paulo, not in UTC: 22:00 of 10/10 in São Paulo is already 11/10 in UTC", () => {
    const record = { ...active, firstChargeAt: sp("2026-10-10T22:00:00") };
    expect(refundWindowOf(record, sp("2026-10-12T08:00:00"))?.until).toEqual(
      until
    );
  });

  it("a webhook delivered two days late does not push the window: it runs from the provider's moment", () => {
    // the charge happened on 10/10 at 15:00 and was processed on 12/10; the record keeps the provider's moment
    const lateWebhook = { ...active, firstChargeAt: sp("2026-10-10T15:00:00") };
    expect(
      refundWindowOf(lateWebhook, sp("2026-10-12T15:00:00"))?.until
    ).toEqual(until);
    expect(refundWindowOf(lateWebhook, sp("2026-10-19T15:00:00"))).toBeNull();
  });

  it("is none without a first charge, after a refund or a chargeback; a chargeback won keeps it", () => {
    const now = sp("2026-10-12T09:00:00");
    expect(refundWindowOf(trialing, now)).toBeNull();
    expect(refundWindowOf(free, now)).toBeNull();
    expect(
      refundWindowOf({ ...active, firstChargeAmount: null }, now)
    ).toBeNull();
    expect(
      refundWindowOf(
        { ...active, revoked: { reason: "refund" }, state: "free" },
        now
      )
    ).toBeNull();
    expect(
      refundWindowOf(
        { ...active, revoked: { reason: "chargeback" }, state: "free" },
        now
      )
    ).toBeNull();
    expect(
      refundWindowOf({ ...active, revoked: { reason: "won" } }, now)
    ).not.toBeNull();
  });

  it("is judged at the first request: asked at 23:58 of the 7th day, a retry at 00:05 of the 8th still has it", () => {
    const asked = { ...active, refundRequestedAt: sp("2026-10-17T23:58:00") };
    expect(refundWindowOf(asked, sp("2026-10-18T00:05:00"))).toEqual({
      amount: "24.90",
      until,
    });
    // without the request, 00:05 of the 8th is closed
    expect(refundWindowOf(active, sp("2026-10-18T00:05:00"))).toBeNull();
  });

  it("keeps a request for exactly 72 hours: one second more and it is the operator's", () => {
    const requestedAt = sp("2026-10-17T23:58:00");
    const asked = { ...active, refundRequestedAt: requestedAt };
    const hours72 = 72 * 3_600_000;
    expect(
      refundWindowOf(asked, new Date(requestedAt.getTime() + hours72))
    ).not.toBeNull();
    expect(
      refundWindowOf(asked, new Date(requestedAt.getTime() + hours72 + 1000))
    ).toBeNull();
  });
});

describe("refundOfferOf (R-1, AS-44)", () => {
  const now = sp("2026-10-12T09:00:00");

  it("the card refunds in the app, Pix goes to support, and both read the same window", () => {
    const pix = { ...active, provider: "woovi" };
    const card = refundOfferOf(active, now, true);
    const support = refundOfferOf(pix, now, false);

    expect(card).toEqual({ ...refundWindowOf(active, now), via: "app" });
    expect(support).toEqual({ ...refundWindowOf(pix, now), via: "suporte" });
    expect(support?.until).toEqual(card?.until);
  });

  it("is none when the window is closed, whatever the way", () => {
    const later = sp("2026-10-18T00:00:00");
    expect(refundOfferOf(active, later, true)).toBeNull();
    expect(refundOfferOf(active, later, false)).toBeNull();
  });
});

describe("refundPendingOf (AS-42)", () => {
  it("is true from the request until the refund is completed or the request expires", () => {
    const asked = { ...active, refundRequestedAt: sp("2026-10-12T10:00:00") };
    expect(refundPendingOf(asked, sp("2026-10-12T10:01:00"))).toBe(true);
    expect(
      refundPendingOf(
        { ...asked, revoked: { reason: "refund" }, state: "free" },
        sp("2026-10-12T10:02:00")
      )
    ).toBe(false);
    expect(refundPendingOf(asked, sp("2026-10-15T10:00:01"))).toBe(false);
    expect(refundPendingOf(active, sp("2026-10-12T10:01:00"))).toBe(false);
  });
});

describe("resubscribeFromOf (AS-27)", () => {
  it("is the end of the paid access when the renewal was cancelled", () => {
    expect(resubscribeFromOf({ ...active, cancelAtPeriodEnd: true })).toEqual(
      active.accessEndsAt
    );
    expect(resubscribeFromOf({ ...trialing, cancelAtPeriodEnd: true })).toEqual(
      trialing.accessEndsAt
    );
  });

  it("is none while renewing, on Free and after a refund", () => {
    expect(resubscribeFromOf(active)).toBeNull();
    expect(resubscribeFromOf(free)).toBeNull();
    expect(
      resubscribeFromOf({
        ...active,
        accessEndsAt: null,
        cancelAtPeriodEnd: false,
        revoked: { reason: "refund" },
        state: "free",
      })
    ).toBeNull();
    // even if the memory of the refund sits on a record still read as Pro
    expect(
      resubscribeFromOf({
        ...active,
        cancelAtPeriodEnd: true,
        revoked: { reason: "refund" },
      })
    ).toBeNull();
  });
});

describe("recoveryOf (AS-43) and planMethodOf", () => {
  it("offers the provider's page only in grace with the card", () => {
    expect(recoveryOf({ ...active, state: "grace" })).toBe("provider_page");
    expect(recoveryOf({ ...active, provider: "woovi", state: "grace" })).toBe(
      null
    );
    expect(recoveryOf(active)).toBeNull();
  });

  it("names the method, never the provider", () => {
    expect(planMethodOf("asaas")).toBe("card");
    expect(planMethodOf("woovi")).toBe("pix_automatic");
    expect(planMethodOf(null)).toBeNull();
    expect(planMethodOf("other")).toBeNull();
  });
});
