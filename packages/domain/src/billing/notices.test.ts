import { describe, expect, it } from "vitest";
import {
  type BillingFact,
  type BillingRecord,
  dueTransition,
  reconcileFact,
} from "./facts";
import {
  BILLING_NOTICE_KINDS,
  BILLING_NOTICE_REFUND_WAIT_MS,
  BILLING_NOTICE_SETTLE_MS,
  type BillingNoticeMark,
  isBillingNoticeKind,
  noticesFor,
  sweepNoticesFor,
  welcomeNotice,
} from "./notices";
import { GRACE_DAYS } from "./subscription-state";

const DAY = 86_400_000;
const base = new Date("2026-10-14T12:00:00.000Z");
const at = (days: number, from = base) => new Date(from.getTime() + days * DAY);
const REF = "pol_0199f0aa-2b3c-7d4e-8f90-123456789abc";
const EVENT = "0199f0aa-2b3c-7d4e-8f90-0000000000e1";

const free = (overrides: Partial<BillingRecord> = {}): BillingRecord => ({
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
  cycleMonths: null,
  lastFactAt: null,
  pendingCycleMonths: null,
  revoked: null,
  state: "free",
  trialConsumed: false,
  ...overrides,
});
const pro = (
  state: "active" | "grace" | "trialing",
  accessEndsAt: Date,
  overrides: Partial<BillingRecord> = {}
): BillingRecord => ({
  accessEndsAt,
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  lastFactAt: null,
  pendingCycleMonths: null,
  revoked: null,
  state,
  trialConsumed: true,
  ...overrides,
});

interface Options {
  eventId?: string | null;
  now?: Date;
  providerRef?: string | null;
  refundRequestedAt?: Date | null;
}

/** What `processEvent` would record for one fact: nothing for a fact the domain ignores. */
function noticesOfFact(
  record: BillingRecord,
  fact: BillingFact,
  options: Options = {}
): BillingNoticeMark[] {
  const now = options.now ?? base;
  const result = reconcileFact(record, fact, { now, overFreeLimits: false });
  if (result.outcome !== "applied") {
    return [];
  }
  return noticesFor({
    after: result.record,
    before: record,
    eventId: options.eventId === undefined ? EVENT : options.eventId,
    fact,
    now,
    providerRef: options.providerRef === undefined ? REF : options.providerRef,
    refundRequestedAt: options.refundRequestedAt ?? null,
    transition: result.transition,
  });
}

/** What `sweepDue` would record for what time caused: nothing before the access ran out. */
function noticesOfTime(
  record: BillingRecord,
  now: Date,
  overFreeLimits = false
): BillingNoticeMark[] {
  const due = dueTransition(record, { now, overFreeLimits });
  if (!due) {
    return [];
  }
  return noticesFor({
    after: due.record,
    before: record,
    eventId: null,
    fact: null,
    now,
    providerRef: REF,
    refundRequestedAt: null,
    transition: due.transition,
  });
}

describe("the kinds of notice", () => {
  it("are the eight of the billing cycle, the yearly renewal and the welcome (ADR 0104)", () => {
    expect([...BILLING_NOTICE_KINDS]).toEqual([
      "trial_started",
      "trial_charge_eve",
      "first_charge_failed",
      "renewal_failed",
      "access_ended",
      "charge_receipt",
      "renewal_cancelled",
      "refund_confirmed",
      "annual_renewal_reminder",
      "welcome",
    ]);
    expect(isBillingNoticeKind("welcome")).toBe(true);
    expect(isBillingNoticeKind("closure")).toBe(false);
    expect(isBillingNoticeKind(1)).toBe(false);
  });
});

describe("noticesFor: one transition, one notice (EM-1, EM-2)", () => {
  it("E-A: the renewal method is ready and the trial runs, one per subscription", () => {
    const fact: BillingFact = {
      cycleMonths: 1,
      occurredAt: base,
      type: "trial_method_ready",
    };
    expect(noticesOfFact(free({ state: "trial_setup" }), fact)).toEqual([
      { dedupeKey: REF, dueAt: base, kind: "trial_started" },
    ]);
    // the fact again, with the trial already running, starts nothing
    expect(noticesOfFact(pro("trialing", at(7)), fact)).toEqual([]);
    // without the link's reference there is nothing to hold it to one per subscription
    expect(
      noticesOfFact(free({ state: "trial_setup" }), fact, {
        providerRef: null,
      })
    ).toEqual([]);
  });

  it("E-C1: the first charge failed and ended the trial", () => {
    expect(
      noticesOfFact(pro("trialing", at(1)), {
        occurredAt: base,
        type: "charge_failed",
      })
    ).toEqual([{ dedupeKey: REF, dueAt: base, kind: "first_charge_failed" }]);
  });

  it("E-C2 d0: the renewal failed, by the provider's fact or by the sweep, keyed by the end of the paid period", () => {
    const paidEnd = at(-1);
    const expected = [
      {
        dedupeKey: `${paidEnd.toISOString()}:d0`,
        dueAt: base,
        kind: "renewal_failed",
      },
    ];
    expect(
      noticesOfFact(pro("active", paidEnd), {
        occurredAt: base,
        type: "charge_failed",
      })
    ).toEqual(expected);
    // nobody reported anything: the sweep puts the period in grace, with the same key
    expect(noticesOfTime(pro("active", paidEnd), base)).toEqual(expected);
    // d0 is recorded even for a renewal cancelled while its charge was on its way (it has no day rule, §9); whether it
    // still goes out is the consumer's (noticeStillTrue and the 23 h delivery window, PR G)
    expect(
      noticesOfFact(pro("active", paidEnd, { cancelAtPeriodEnd: true }), {
        occurredAt: base,
        type: "charge_failed",
      })
    ).toEqual(expected);
    // a failure reported before the end of the period counts from that end too (RN:19)
    const early = pro("active", at(2));
    expect(
      noticesOfFact(early, { occurredAt: base, type: "charge_failed" })
    ).toEqual([
      {
        dedupeKey: `${at(2).toISOString()}:d0`,
        dueAt: base,
        kind: "renewal_failed",
      },
    ]);
  });

  it("E-D: the grace or the cancelled period ended, keyed by the end of the access", () => {
    const graceEnd = at(-1);
    expect(noticesOfTime(pro("grace", graceEnd), base)).toEqual([
      { dedupeKey: graceEnd.toISOString(), dueAt: base, kind: "access_ended" },
    ]);
    const periodEnd = at(-2);
    expect(
      noticesOfTime(pro("active", periodEnd, { cancelAtPeriodEnd: true }), base)
    ).toEqual([
      { dedupeKey: periodEnd.toISOString(), dueAt: base, kind: "access_ended" },
    ]);
    // a store over the free limits goes to free_over_limit: still E-D
    expect(noticesOfTime(pro("grace", graceEnd), base, true)).toEqual([
      { dedupeKey: graceEnd.toISOString(), dueAt: base, kind: "access_ended" },
    ]);
    // the trial that ended without a first charge is E-C1's, not E-D's
    expect(noticesOfTime(pro("trialing", at(-1)), base)).toEqual([]);
    // before the access ran out, time causes nothing
    expect(noticesOfTime(pro("grace", at(1)), base)).toEqual([]);
  });

  it("E4: a charge that went through, 10 minutes later, keyed by the ledger row", () => {
    const receipt = [
      {
        dedupeKey: EVENT,
        dueAt: new Date(base.getTime() + BILLING_NOTICE_SETTLE_MS),
        kind: "charge_receipt",
      },
    ];
    // the first charge after the trial, a renewal, a late one that revives a free store
    expect(
      noticesOfFact(pro("trialing", at(1)), {
        cycleMonths: 1,
        occurredAt: base,
        periodEndsAt: at(31),
        type: "charge_succeeded",
      })
    ).toEqual(receipt);
    expect(
      noticesOfFact(pro("active", at(1)), {
        cycleMonths: 1,
        occurredAt: base,
        periodEndsAt: at(31),
        type: "charge_succeeded",
      })
    ).toEqual(receipt);
    expect(
      noticesOfFact(free({ trialConsumed: true }), {
        cycleMonths: 1,
        occurredAt: base,
        periodEndsAt: at(30),
        type: "charge_succeeded",
      })
    ).toEqual(receipt);
    // the confirmation of a payment already refunded revives nothing and receipts nothing
    expect(
      noticesOfFact(
        free({
          revoked: {
            cancelAtPeriodEnd: false,
            cycleMonths: 1,
            periodEndsAt: at(30),
            reason: "refund",
          },
          trialConsumed: true,
        }),
        {
          cycleMonths: 1,
          occurredAt: base,
          periodEndsAt: at(30),
          type: "charge_succeeded",
        }
      )
    ).toEqual([]);
  });

  it("E7: the renewal was cancelled, 10 minutes later, or a day later when the owner asked for the refund", () => {
    const cancelled: BillingFact = {
      occurredAt: base,
      type: "subscription_cancelled",
    };
    expect(noticesOfFact(pro("active", at(20)), cancelled)).toEqual([
      {
        dedupeKey: EVENT,
        dueAt: new Date(base.getTime() + BILLING_NOTICE_SETTLE_MS),
        kind: "renewal_cancelled",
      },
    ]);
    expect(
      noticesOfFact(pro("trialing", at(5)), cancelled, {
        refundRequestedAt: at(-1),
      })
    ).toEqual([
      {
        dedupeKey: EVENT,
        dueAt: new Date(base.getTime() + BILLING_NOTICE_REFUND_WAIT_MS),
        kind: "renewal_cancelled",
      },
    ]);
    // a second cancellation of the same renewal (the webhook after the owner's command) is ignored: one E7
    expect(
      noticesOfFact(
        pro("active", at(20), { cancelAtPeriodEnd: true }),
        cancelled
      )
    ).toEqual([]);
    // a checkout abandoned before the trial had no renewal to cancel
    expect(noticesOfFact(free({ state: "trial_setup" }), cancelled)).toEqual(
      []
    );
  });

  it("E-R: a refund that took the paid access back; a chargeback is not a refund", () => {
    const refunded: BillingFact = {
      occurredAt: base,
      periodEndsAt: at(20),
      type: "charge_refunded",
    };
    expect(noticesOfFact(pro("active", at(20)), refunded)).toEqual([
      { dedupeKey: EVENT, dueAt: base, kind: "refund_confirmed" },
    ]);
    // the refund of an earlier period changes nothing, so nothing is told
    expect(
      noticesOfFact(pro("active", at(20)), {
        ...refunded,
        periodEndsAt: at(-20),
      })
    ).toEqual([]);
    expect(
      noticesOfFact(pro("active", at(20)), {
        occurredAt: base,
        periodEndsAt: at(20),
        type: "charge_disputed",
      })
    ).toEqual([]);
  });

  it("the notices keyed by the ledger row need the row: none without it", () => {
    expect(
      noticesOfFact(
        pro("active", at(20)),
        { occurredAt: base, type: "subscription_cancelled" },
        { eventId: null }
      )
    ).toEqual([]);
  });
});

describe("noticesFor: a fact the domain ignores records nothing (EM-3)", () => {
  it("a duplicated failure, a stale cancellation and a cycle change are not notices", () => {
    const grace = pro("grace", at(6));
    expect(
      noticesOfFact(grace, { occurredAt: base, type: "charge_failed" })
    ).toEqual([]);
    expect(
      noticesOfFact(pro("active", at(20), { lastFactAt: base }), {
        occurredAt: at(-1),
        type: "subscription_cancelled",
      })
    ).toEqual([]);
    expect(
      noticesOfFact(pro("active", at(20)), {
        cycleMonths: 12,
        occurredAt: base,
        type: "cycle_change_scheduled",
      })
    ).toEqual([]);
  });
});

describe("sweepNoticesFor: the hourly marks, on their local day, from 08:00 to 20:00 local", () => {
  const SAO_PAULO = "America/Sao_Paulo";

  it("E-B: the eve of the first charge set at the provider, only while the trial runs and is not cancelled", () => {
    // 2026-10-24 10:00 in São Paulo; the first charge is on the 25th
    const now = new Date("2026-10-24T13:00:00.000Z");
    const trial = pro("trialing", new Date("2026-10-31T13:00:00.000Z"));
    const sweep = (overrides: Partial<Parameters<typeof sweepNoticesFor>[0]>) =>
      sweepNoticesFor({
        firstChargeOn: "2026-10-25",
        now,
        providerRef: REF,
        record: trial,
        timeZone: SAO_PAULO,
        ...overrides,
      });
    expect(sweep({})).toEqual([
      { dedupeKey: REF, dueAt: now, kind: "trial_charge_eve" },
    ]);
    // the charge is today, or the day after tomorrow: not the eve
    expect(sweep({ firstChargeOn: "2026-10-24" })).toEqual([]);
    expect(sweep({ firstChargeOn: "2026-10-26" })).toEqual([]);
    // cancelled the day before, abandoned, or subscribed without a trial
    expect(sweep({ record: { ...trial, cancelAtPeriodEnd: true } })).toEqual(
      []
    );
    expect(sweep({ record: free() })).toEqual([]);
    expect(
      sweep({ record: pro("active", trial.accessEndsAt as Date) })
    ).toEqual([]);
    expect(sweep({ firstChargeOn: null })).toEqual([]);
    // 07:59 and 20:00 local are outside the window; 08:00 and 19:59 are inside
    expect(sweep({ now: new Date("2026-10-24T10:59:00.000Z") })).toEqual([]);
    expect(sweep({ now: new Date("2026-10-24T23:00:00.000Z") })).toEqual([]);
    expect(sweep({ now: new Date("2026-10-24T11:00:00.000Z") })).toHaveLength(
      1
    );
    expect(sweep({ now: new Date("2026-10-24T22:59:00.000Z") })).toHaveLength(
      1
    );
  });

  it("E-B in the three time zones of the country (EM-12): the same instant is inside the window in some, not in others", () => {
    const trial = pro("trialing", new Date("2026-10-31T13:00:00.000Z"));
    const sweep = (now: Date, timeZone: string, firstChargeOn: string) =>
      sweepNoticesFor({
        firstChargeOn,
        now,
        providerRef: REF,
        record: trial,
        timeZone,
      }).map((mark) => mark.kind);
    // 23:30 UTC: 20:30 in Brasília (out), 19:30 in Manaus and 18:30 in Rio Branco (in), all on the 24th
    const evening = new Date("2026-10-24T23:30:00.000Z");
    expect(sweep(evening, "America/Sao_Paulo", "2026-10-25")).toEqual([]);
    expect(sweep(evening, "America/Manaus", "2026-10-25")).toEqual([
      "trial_charge_eve",
    ]);
    expect(sweep(evening, "America/Rio_Branco", "2026-10-25")).toEqual([
      "trial_charge_eve",
    ]);
    // 11:30 UTC: 08:30 in Brasília (in), 07:30 in Manaus and 06:30 in Rio Branco (out)
    const morning = new Date("2026-10-25T11:30:00.000Z");
    expect(sweep(morning, "America/Sao_Paulo", "2026-10-26")).toEqual([
      "trial_charge_eve",
    ]);
    expect(sweep(morning, "America/Manaus", "2026-10-26")).toEqual([]);
    expect(sweep(morning, "America/Rio_Branco", "2026-10-26")).toEqual([]);
  });

  describe("E-C2: the 3rd day and the day before the end, counted from the end of the paid period (EM-5)", () => {
    // the paid period ended on the 10th at 12:00 in São Paulo; the grace ends on the 17th at 12:00
    const paidEnd = new Date("2026-10-10T15:00:00.000Z");
    const graceEnd = new Date(paidEnd.getTime() + GRACE_DAYS * DAY);
    const grace = pro("grace", graceEnd);
    const atLocalTen = (day: number) =>
      new Date(`2026-10-${String(day).padStart(2, "0")}T13:00:00.000Z`);
    const sweep = (now: Date, record: BillingRecord = grace) =>
      sweepNoticesFor({
        firstChargeOn: null,
        now,
        providerRef: REF,
        record,
        timeZone: SAO_PAULO,
      });

    it("records the 3rd day on the 13th and the day before the end on the 16th, and nothing on the other days", () => {
      expect(sweep(atLocalTen(13))).toEqual([
        {
          dedupeKey: `${paidEnd.toISOString()}:d3`,
          dueAt: atLocalTen(13),
          kind: "renewal_failed",
        },
      ]);
      expect(sweep(atLocalTen(16))).toEqual([
        {
          dedupeKey: `${paidEnd.toISOString()}:dlast`,
          dueAt: atLocalTen(16),
          kind: "renewal_failed",
        },
      ]);
      for (const day of [10, 11, 12, 14, 15, 17]) {
        expect(sweep(atLocalTen(day))).toEqual([]);
      }
    });

    it.each([
      // the failure reported on the 5th, 6th and 7th day: d0 on the transition, never the 3rd day late
      [15, ["d0"], ["dlast"]],
      [16, ["d0", "dlast"], []],
      [17, ["d0"], []],
    ])(
      "a failure reported late, on the %ith: the milestone already past is dropped, d0 always goes, never a negative day",
      (day, sameDay, nextDay) => {
        const reportedAt = atLocalTen(day);
        const transition = noticesOfFact(
          pro("active", paidEnd),
          { occurredAt: reportedAt, type: "charge_failed" },
          { now: reportedAt }
        );
        const sameDayMarks = [...transition, ...sweep(reportedAt)];
        expect(
          sameDayMarks.map((mark) => mark.dedupeKey.split(":").at(-1))
        ).toEqual(sameDay);
        // two of the same day (d0 and the day before the end) are settled when sent: only d0 goes (PR G)
        const after = sweep(atLocalTen(day + 1));
        expect(after.map((mark) => mark.dedupeKey.split(":").at(-1))).toEqual(
          nextDay
        );
      }
    );

    it("records the 3rd day only between 08:00 and 20:00 local", () => {
      expect(sweep(new Date("2026-10-13T10:59:00.000Z"))).toEqual([]);
      expect(sweep(new Date("2026-10-13T11:00:00.000Z"))).toHaveLength(1);
      expect(sweep(new Date("2026-10-13T22:59:00.000Z"))).toHaveLength(1);
      expect(sweep(new Date("2026-10-13T23:00:00.000Z"))).toEqual([]);
    });

    it("records nothing after the renewal was cancelled or paid", () => {
      expect(
        sweep(atLocalTen(13), { ...grace, cancelAtPeriodEnd: true })
      ).toEqual([]);
      expect(
        sweep(atLocalTen(13), pro("active", new Date("2026-11-10T15:00:00Z")))
      ).toEqual([]);
    });
  });

  it("the yearly renewal: 7 local days before the charge, only for a yearly cycle not cancelled and with nothing taken back", () => {
    const renewal = new Date("2027-10-24T15:00:00.000Z");
    const yearly = pro("active", renewal, { cycleMonths: 12 });
    const now = new Date("2027-10-17T13:00:00.000Z");
    const sweep = (record: BillingRecord, when = now) =>
      sweepNoticesFor({
        firstChargeOn: null,
        now: when,
        providerRef: REF,
        record,
        timeZone: SAO_PAULO,
      });
    expect(sweep(yearly)).toEqual([
      {
        dedupeKey: renewal.toISOString(),
        dueAt: now,
        kind: "annual_renewal_reminder",
      },
    ]);
    // only between 08:00 and 20:00 local
    expect(sweep(yearly, new Date("2027-10-17T10:59:00.000Z"))).toEqual([]);
    expect(sweep(yearly, new Date("2027-10-17T23:00:00.000Z"))).toEqual([]);
    expect(sweep(yearly, new Date("2027-10-16T13:00:00.000Z"))).toEqual([]);
    expect(sweep(yearly, new Date("2027-10-18T13:00:00.000Z"))).toEqual([]);
    expect(sweep({ ...yearly, cycleMonths: 1 })).toEqual([]);
    expect(sweep({ ...yearly, cycleMonths: 6 })).toEqual([]);
    expect(sweep({ ...yearly, cancelAtPeriodEnd: true })).toEqual([]);
    expect(
      sweep({
        ...yearly,
        revoked: {
          cancelAtPeriodEnd: false,
          cycleMonths: 12,
          periodEndsAt: renewal,
          reason: "won",
        },
      })
    ).toEqual([]);
    expect(sweep(pro("grace", renewal, { cycleMonths: 12 }))).toEqual([]);
  });
});

describe("welcomeNotice (E1)", () => {
  it("is one per person, keyed by the user, due at once", () => {
    expect(welcomeNotice("user_1", base)).toEqual({
      dedupeKey: "user_1",
      dueAt: base,
      kind: "welcome",
    });
  });
});
