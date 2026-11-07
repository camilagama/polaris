import { describe, expect, it } from "vitest";
import type { BillingRecord } from "./facts";
import {
  lastCoveredDay,
  noticeStillTrue,
  renewalFailedDayOf,
  sweepNoticesFor,
} from "./notices";
import { GRACE_DAYS } from "./subscription-state";

// A provider's period ends at midnight in São Paulo (`paidPeriodEndsAt`): the day of that instant is not covered.
const DAY = 86_400_000;
const SAO_PAULO = "America/Sao_Paulo";
const REF = "pol_0199f0aa-2b3c-7d4e-8f90-123456789abc";
/** 00:00 of `2026-11-01` in São Paulo: the paid period covered up to 31 October. */
const PAID_END = new Date("2026-11-01T03:00:00.000Z");
const GRACE_END = new Date(PAID_END.getTime() + GRACE_DAYS * DAY);

const record = (overrides: Partial<BillingRecord>): BillingRecord => ({
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  lastFactAt: null,
  pendingCycleMonths: null,
  revoked: null,
  state: "active",
  trialConsumed: true,
  ...overrides,
});

/** 10:00 of a local day in São Paulo. */
const morning = (date: string) => new Date(`${date}T13:00:00.000Z`);

describe("an access that ends at midnight", () => {
  it("covers the day before the instant, not the day of it", () => {
    expect(lastCoveredDay(GRACE_END, SAO_PAULO)).toBe("2026-11-07");
    expect(
      lastCoveredDay(new Date("2026-11-08T15:00:00.000Z"), SAO_PAULO)
    ).toBe("2026-11-08");
  });

  it("records the E-C2 of the day before the end on the day before the last day of Pro", () => {
    expect(renewalFailedDayOf("dlast", PAID_END, SAO_PAULO)).toBe("2026-11-06");
    const grace = record({ accessEndsAt: GRACE_END, state: "grace" });
    const marks = (date: string) =>
      sweepNoticesFor({
        firstChargeOn: null,
        now: morning(date),
        providerRef: REF,
        record: grace,
        timeZone: SAO_PAULO,
      }).map((mark) => mark.dedupeKey);
    expect(marks("2026-11-06")).toEqual([`${PAID_END.toISOString()}:dlast`]);
    // the last day of Pro itself is too late for "termina amanhã"
    expect(marks("2026-11-07")).toEqual([]);
  });

  it("records the yearly reminder 7 days before the day of the charge (the last day of the paid period)", () => {
    const yearEnd = new Date("2027-10-31T03:00:00.000Z");
    const annual = record({ accessEndsAt: yearEnd, cycleMonths: 12 });
    const marks = (date: string) =>
      sweepNoticesFor({
        firstChargeOn: null,
        now: morning(date),
        providerRef: REF,
        record: annual,
        timeZone: SAO_PAULO,
      }).map((mark) => mark.kind);
    // the charge is on 30 October 2027: 7 days before is 23 October
    expect(marks("2027-10-23")).toEqual(["annual_renewal_reminder"]);
    expect(marks("2027-10-24")).toEqual([]);
    const check = (date: string) =>
      noticeStillTrue({
        amount: "249.00",
        emailEnabled: true,
        event: null,
        firstChargeOn: null,
        notice: {
          dedupeKey: yearEnd.toISOString(),
          kind: "annual_renewal_reminder",
          recordedAt: morning("2027-10-23"),
        },
        noticeProviderRef: null,
        now: morning(date),
        organizationClosed: false,
        ownerActive: true,
        paidSinceNotice: false,
        providerRef: REF,
        record: annual,
        refundRequestedAt: null,
        renewalFailedSentAt: [],
        timeZone: SAO_PAULO,
        trialStartedSentAt: null,
      });
    expect(check("2027-10-23")).toBeNull();
    expect(check("2027-10-24")).toBe("state_changed");
  });
});

describe("a cancellation whose store is already back on Free", () => {
  it("is not sent: there is no Pro until a date to tell", () => {
    expect(
      noticeStillTrue({
        amount: null,
        emailEnabled: true,
        event: { occurredAt: PAID_END, type: "subscription_cancelled" },
        firstChargeOn: null,
        notice: {
          dedupeKey: "0199f0aa-2b3c-7d4e-8f90-0000000000e1",
          kind: "renewal_cancelled",
          recordedAt: PAID_END,
        },
        noticeProviderRef: REF,
        now: GRACE_END,
        organizationClosed: false,
        ownerActive: true,
        paidSinceNotice: false,
        providerRef: REF,
        record: record({
          cancelAtPeriodEnd: true,
          cycleMonths: null,
          state: "free",
        }),
        refundRequestedAt: null,
        renewalFailedSentAt: [],
        timeZone: SAO_PAULO,
        trialStartedSentAt: null,
      })
    ).toBe("state_changed");
  });
});
