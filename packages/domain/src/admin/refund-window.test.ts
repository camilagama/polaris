import { describe, expect, it } from "vitest";
import { nextChargeOf } from "../billing/plan-view";
import {
  buildRefundWindowView,
  type RawRefundWindow,
  RefundWindowReadRefusedError,
} from "./refund-window";

const sp = (local: string) => new Date(`${local}-03:00`);

// first charge on `2026-10-10` (São Paulo): the window ends at 23:59:59 of `2026-10-17`
const charged: RawRefundWindow = {
  accessEndsAt: sp("2026-11-10T09:00:00"),
  cancelAtPeriodEnd: false,
  firstChargeAmount: "24.90",
  firstChargeAt: sp("2026-10-10T15:30:00"),
  method: "pix_automatic",
  now: sp("2026-10-12T09:00:00"),
  refundRequestedAt: null,
  revokedReason: null,
  revokedThrough: null,
  state: "active",
};

const here = { refundsHere: true };

describe("buildRefundWindowView (ADR 0104, decision 8)", () => {
  it("shows the facts, the last second of the window and a verdict made with the product's code", () => {
    expect(buildRefundWindowView(charged, here)).toEqual({
      firstChargeAmount: "24.90",
      firstChargeAt: "2026-10-10T18:30:00.000Z",
      method: "pix_automatic",
      now: "2026-10-12T12:00:00.000Z",
      refundable: true,
      refundRequestedAt: null,
      refundsHere: true,
      renewal: {
        accessUntil: null,
        renewsOn: "2026-11-10",
        resubscribeFrom: null,
        status: "renewing",
      },
      request: null,
      state: "active",
      window: { open: true, until: "2026-10-18T02:59:59.000Z" },
    });
  });

  it.each([
    ["the eve of the 7th day", "2026-10-16T23:59:59", true],
    ["23:59:59 of the 7th day", "2026-10-17T23:59:59", true],
    ["23:59:59.999 of the 7th day", "2026-10-17T23:59:59.999", true],
    ["00:00:00 of the 8th day", "2026-10-18T00:00:00", false],
    ["noon of the 8th day", "2026-10-18T12:00:00", false],
  ])("judges %s with the database clock", (_name, now, open) => {
    const view = buildRefundWindowView({ ...charged, now: sp(now) }, here);
    expect(view.window?.open).toBe(open);
    expect(view.refundable).toBe(open);
  });

  it("counts the day in São Paulo, not in UTC (a charge at 22:30 there is already the next day in UTC)", () => {
    const late = buildRefundWindowView(
      {
        ...charged,
        firstChargeAt: sp("2026-10-10T22:30:00"),
        now: sp("2026-10-17T23:59:59"),
      },
      here
    );
    expect(late.window?.until).toBe("2026-10-18T02:59:59.000Z");
    expect(late.refundable).toBe(true);
  });

  describe("a request of the owner", () => {
    const requested = sp("2026-10-14T10:00:00");
    const asked: RawRefundWindow = {
      ...charged,
      refundRequestedAt: requested,
    };

    it.each([
      ["72 hours exactly", "2026-10-17T10:00:00", true],
      ["72 hours and 1 second", "2026-10-17T10:00:01", false],
      ["71 hours", "2026-10-17T09:00:00", true],
    ])("is completable at %s", (_name, now, completable) => {
      const view = buildRefundWindowView({ ...asked, now: sp(now) }, here);
      expect(view.request).toEqual({
        at: "2026-10-14T13:00:00.000Z",
        completable,
        completableUntil: "2026-10-17T13:00:00.000Z",
      });
      expect(view.refundable).toBe(completable);
    });

    it("keeps judging the request by its own moment: asked in time, completable after the window ended", () => {
      const view = buildRefundWindowView(
        {
          ...asked,
          now: sp("2026-10-18T10:00:00"),
          refundRequestedAt: sp("2026-10-17T23:59:59"),
        },
        here
      );
      expect(view.window?.open).toBe(false);
      expect(view.refundable).toBe(true);
      expect(view.request?.completable).toBe(true);
    });

    it("refuses a request made at 00:00:00 of the 8th day", () => {
      const view = buildRefundWindowView(
        {
          ...asked,
          now: sp("2026-10-18T00:00:01"),
          refundRequestedAt: sp("2026-10-18T00:00:00"),
        },
        here
      );
      expect(view.refundable).toBe(false);
    });
  });

  it("has no window and no verdict without a first charge", () => {
    const view = buildRefundWindowView(
      {
        accessEndsAt: null,
        cancelAtPeriodEnd: false,
        firstChargeAmount: null,
        firstChargeAt: null,
        method: null,
        now: sp("2026-10-12T09:00:00"),
        refundRequestedAt: null,
        revokedReason: null,
        revokedThrough: null,
        state: "free",
      },
      { refundsHere: false }
    );
    expect(view.refundsHere).toBe(false);
    expect(view.renewal).toEqual({
      accessUntil: null,
      renewsOn: null,
      resubscribeFrom: null,
      status: "none",
    });
    expect(view.window).toBeNull();
    expect(view.refundable).toBe(false);
    expect(view.request).toBeNull();
  });
});

describe("one code for the window (ADR 0104, decision 8)", () => {
  // from before the first charge to 20 days after it, every 7 hours and 59 seconds, with and without a request
  it("keeps `refundable` equal to what `window` and `request` say, at every instant", () => {
    const step = (7 * 3600 + 59) * 1000;
    const start = charged.firstChargeAt?.getTime() ?? 0;
    for (let at = start - step; at < start + 20 * 24 * 3_600_000; at += step) {
      for (const requestedOffsetHours of [null, 1, 30, 150, 168, 190]) {
        const view = buildRefundWindowView(
          {
            ...charged,
            now: new Date(at),
            refundRequestedAt:
              requestedOffsetHours === null
                ? null
                : new Date(start + requestedOffsetHours * 3_600_000),
          },
          here
        );
        const requestedAt =
          requestedOffsetHours === null
            ? null
            : start + requestedOffsetHours * 3_600_000;
        if (requestedAt !== null && requestedAt > at) {
          continue; // a request in the future of the database clock cannot exist
        }
        const closes = Date.parse(view.window?.until ?? "") + 1000;
        const judgedAt = requestedAt ?? at;
        expect(view.refundable).toBe(
          judgedAt < closes && (view.request?.completable ?? true)
        );
      }
    }
  });
});

describe("the renewal of the store (the owner's own record, read by the Admin)", () => {
  const now = sp("2026-10-12T09:00:00");

  it("is renewing while Pro, not cancelled and paid up: the day is the product's next charge", () => {
    const view = buildRefundWindowView({ ...charged, now }, here);
    const next = nextChargeOf(
      {
        accessEndsAt: charged.accessEndsAt,
        cancelAtPeriodEnd: false,
        firstChargeAmount: charged.firstChargeAmount,
        firstChargeAt: charged.firstChargeAt,
        firstChargeOn: null,
        priceAmount: charged.firstChargeAmount,
        provider: null,
        refundRequestedAt: null,
        revoked: null,
        state: "active",
      },
      now
    );
    expect(next?.on).toBe("2026-11-10");
    expect(view.renewal).toEqual({
      accessUntil: null,
      renewsOn: next?.on,
      resubscribeFrom: null,
      status: "renewing",
    });
  });

  it("is cancelled with the access already paid: the end and the day to subscribe again are the same instant", () => {
    const view = buildRefundWindowView(
      { ...charged, cancelAtPeriodEnd: true, now },
      here
    );
    expect(view.renewal).toEqual({
      accessUntil: "2026-11-10T12:00:00.000Z",
      renewsOn: null,
      resubscribeFrom: "2026-11-10T12:00:00.000Z",
      status: "cancelled",
    });
  });

  it("is none once the paid period is over, even with the cancellation still on the record", () => {
    const over = buildRefundWindowView(
      {
        ...charged,
        cancelAtPeriodEnd: true,
        now: sp("2026-11-10T09:00:01"),
        state: "free",
      },
      here
    );
    expect(over.renewal.status).toBe("none");
    expect(over.renewal.accessUntil).toBeNull();
  });

  it("has no day to subscribe again after a refund: the Pro ended at once", () => {
    const refunded = buildRefundWindowView(
      {
        ...charged,
        accessEndsAt: null,
        cancelAtPeriodEnd: false,
        now,
        revokedReason: "refund",
        revokedThrough: sp("2026-11-10T09:00:00"),
        state: "free",
      },
      here
    );
    expect(refunded.renewal).toEqual({
      accessUntil: null,
      renewsOn: null,
      resubscribeFrom: null,
      status: "none",
    });
    expect(refunded.refundable).toBe(false);
  });

  it("names no renewal day for a link recorded before its price, and still says it renews", () => {
    const view = buildRefundWindowView(
      { ...charged, firstChargeAmount: null, firstChargeAt: null, now },
      here
    );
    expect(view.renewal.status).toBe("renewing");
    expect(view.renewal.renewsOn).toBeNull();
  });

  it("copies the switch of the provider and nothing else of it", () => {
    expect(
      buildRefundWindowView(charged, { refundsHere: false }).refundsHere
    ).toBe(false);
    expect(buildRefundWindowView(charged, here).refundsHere).toBe(true);
  });
});

describe("RefundWindowReadRefusedError", () => {
  it("has one code for every cause of the refusal", () => {
    expect(new RefundWindowReadRefusedError().code).toBe(
      "refund_window_read_refused"
    );
  });
});
