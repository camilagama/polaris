import { describe, expect, it } from "vitest";
import { type BillingFact, type BillingRecord, reconcileFact } from "./facts";
import {
  type BillingNoticeCheck,
  type BillingNoticeKind,
  BILLING_NOTICE_KINDS,
  noticeStillTrue,
  renewalFailedDayOf,
  renewalFailedOf,
} from "./notices";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const REF = "pol_0199f0aa-2b3c-7d4e-8f90-123456789abc";
const OTHER_REF = "pol_0199f0aa-2b3c-7d4e-8f90-999999999999";
const SAO_PAULO = "America/Sao_Paulo";
const MANAUS = "America/Manaus";
const RIO_BRANCO = "America/Rio_Branco";
/** The three zones have no daylight saving time: a fixed offset from UTC, in hours. */
const OFFSETS: Record<string, number> = {
  [SAO_PAULO]: -3,
  [MANAUS]: -4,
  [RIO_BRANCO]: -5,
};
const ZONES = [SAO_PAULO, MANAUS, RIO_BRANCO] as const;

/** The instant of a wall-clock time ("2026-10-14", 12, 30) in a zone, from the fixed offset (not from the code). */
function localAt(date: string, hour: number, zone: string, minute = 0): Date {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(
    Date.UTC(year, month - 1, day, hour - (OFFSETS[zone] as number), minute)
  );
}

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
const refundOf = (
  periodEndsAt: Date,
  reason: "chargeback" | "refund" | "won" = "refund"
): NonNullable<BillingRecord["revoked"]> => ({
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  periodEndsAt,
  reason,
});

const base = new Date("2026-10-14T15:00:00.000Z");
const PERIOD_END = new Date("2026-11-14T15:00:00.000Z");
const chargeSucceeded = (periodEndsAt = PERIOD_END): BillingFact => ({
  cycleMonths: 1,
  occurredAt: base,
  periodEndsAt,
  type: "charge_succeeded",
});
const chargeRefunded = (periodEndsAt = PERIOD_END): BillingFact => ({
  occurredAt: base,
  periodEndsAt,
  type: "charge_refunded",
});

/** The check for one notice: everything true and configured, so that each test changes only what it is about. */
function run(
  kind: BillingNoticeKind,
  dedupeKey: string,
  overrides: Partial<BillingNoticeCheck> = {}
) {
  return noticeStillTrue({
    amount: "24.90",
    emailEnabled: true,
    event: null,
    firstChargeOn: null,
    notice: { dedupeKey, kind, recordedAt: base },
    noticeProviderRef: null,
    now: base,
    organizationClosed: false,
    ownerActive: true,
    paidSinceNotice: false,
    providerRef: REF,
    record: free(),
    refundRequestedAt: null,
    renewalFailedSentAt: [],
    timeZone: SAO_PAULO,
    trialStartedSentAt: null,
    ...overrides,
  });
}

describe("noticeStillTrue: the common rules", () => {
  it("skips every kind, the welcome included, when the e-mail is off", () => {
    for (const kind of BILLING_NOTICE_KINDS) {
      expect(run(kind, REF, { emailEnabled: false })).toBe(
        "email_not_configured"
      );
    }
  });

  it("puts the e-mail off before the closed store", () => {
    expect(
      run("trial_started", REF, {
        emailEnabled: false,
        organizationClosed: true,
        record: pro("trialing", PERIOD_END),
      })
    ).toBe("email_not_configured");
  });

  it("skips a billing notice of a closed store, whatever its kind", () => {
    for (const kind of BILLING_NOTICE_KINDS.filter((k) => k !== "welcome")) {
      expect(run(kind, REF, { organizationClosed: true })).toBe(
        "organization_closed"
      );
    }
  });

  it("puts the closed store before the replaced link", () => {
    expect(
      run("trial_started", REF, {
        noticeProviderRef: OTHER_REF,
        organizationClosed: true,
      })
    ).toBe("organization_closed");
  });

  it("skips a billing notice recorded under another link", () => {
    expect(
      run("trial_started", REF, {
        noticeProviderRef: OTHER_REF,
        record: pro("trialing", PERIOD_END),
      })
    ).toBe("link_replaced");
  });

  it("skips a notice of a link when the store has no link now", () => {
    expect(
      run("trial_started", REF, {
        noticeProviderRef: REF,
        providerRef: null,
        record: pro("trialing", PERIOD_END),
      })
    ).toBe("link_replaced");
  });

  it("keeps a notice whose link cannot be told, or is the current one", () => {
    const record = pro("trialing", PERIOD_END);
    expect(run("trial_started", REF, { noticeProviderRef: null, record })).toBe(
      null
    );
    expect(run("trial_started", REF, { noticeProviderRef: REF, record })).toBe(
      null
    );
  });
});

describe("noticeStillTrue: welcome (E1)", () => {
  it("goes out to an active owner", () => {
    expect(run("welcome", "owner-1")).toBe(null);
  });

  it("is skipped when the owner is no longer active", () => {
    expect(run("welcome", "owner-1", { ownerActive: false })).toBe("no_owner");
  });

  it("is never suppressed by a closed store", () => {
    expect(run("welcome", "owner-1", { organizationClosed: true })).toBe(null);
  });

  it("is never suppressed by the billing state, a refund or another link", () => {
    expect(
      run("welcome", "owner-1", {
        noticeProviderRef: OTHER_REF,
        record: free({ revoked: refundOf(PERIOD_END) }),
      })
    ).toBe(null);
  });

  it("needs no amount", () => {
    expect(run("welcome", "owner-1", { amount: null })).toBe(null);
  });
});

describe("noticeStillTrue: trial_started (E-A)", () => {
  const trialing = pro("trialing", PERIOD_END);

  it("goes out while the store is trialing and nothing was refunded", () => {
    expect(run("trial_started", REF, { record: trialing })).toBe(null);
  });

  it("is skipped when the state changed", () => {
    expect(run("trial_started", REF, { record: free() })).toBe("state_changed");
    expect(
      run("trial_started", REF, { record: pro("active", PERIOD_END) })
    ).toBe("state_changed");
  });

  it("is skipped as refunded when the payment was refunded, before the state", () => {
    expect(
      run("trial_started", REF, {
        record: free({ revoked: refundOf(PERIOD_END) }),
      })
    ).toBe("refunded");
    expect(
      run("trial_started", REF, {
        record: pro("trialing", PERIOD_END, {
          revoked: refundOf(PERIOD_END),
        }),
      })
    ).toBe("refunded");
  });

  it("is not suppressed by a chargeback", () => {
    expect(
      run("trial_started", REF, {
        record: pro("trialing", PERIOD_END, {
          revoked: refundOf(PERIOD_END, "chargeback"),
        }),
      })
    ).toBe(null);
  });

  it("is skipped as price_unknown when no amount was recorded", () => {
    expect(run("trial_started", REF, { amount: null, record: trialing })).toBe(
      "price_unknown"
    );
  });

  it("gives the reason it is no longer true, not price_unknown", () => {
    expect(run("trial_started", REF, { amount: null, record: free() })).toBe(
      "state_changed"
    );
  });
});

describe("noticeStillTrue: trial_charge_eve (E-B)", () => {
  const trialing = pro("trialing", PERIOD_END);
  const eve = (overrides: Partial<BillingNoticeCheck>) =>
    run("trial_charge_eve", REF, {
      firstChargeOn: "2026-10-15",
      now: localAt("2026-10-14", 12, SAO_PAULO),
      record: trialing,
      ...overrides,
    });

  it("goes out on the eve of the first charge, before 20:00 local", () => {
    expect(eve({})).toBe(null);
  });

  it("is skipped as refunded before anything else", () => {
    expect(
      eve({
        record: free({
          cancelAtPeriodEnd: true,
          revoked: refundOf(PERIOD_END),
        }),
      })
    ).toBe("refunded");
  });

  it("is skipped when the store is not trialing any more", () => {
    expect(eve({ record: pro("active", PERIOD_END) })).toBe("state_changed");
    expect(eve({ record: free() })).toBe("state_changed");
  });

  it("is skipped as cancelled when the trial will not renew, before the window", () => {
    expect(
      eve({
        firstChargeOn: "2026-10-30",
        record: pro("trialing", PERIOD_END, { cancelAtPeriodEnd: true }),
      })
    ).toBe("cancelled");
  });

  it("is skipped as window_passed when the first charge is not tomorrow", () => {
    expect(eve({ firstChargeOn: "2026-10-14" })).toBe("window_passed");
    expect(eve({ firstChargeOn: "2026-10-16" })).toBe("window_passed");
    expect(eve({ firstChargeOn: null })).toBe("window_passed");
  });

  it("is skipped as window_passed from 20:00 local, even for the right day", () => {
    expect(eve({ now: localAt("2026-10-14", 20, SAO_PAULO) })).toBe(
      "window_passed"
    );
    expect(eve({ now: localAt("2026-10-14", 23, SAO_PAULO, 59) })).toBe(
      "window_passed"
    );
  });

  it("still goes out at 19:59 local", () => {
    expect(eve({ now: localAt("2026-10-14", 19, SAO_PAULO, 59) })).toBe(null);
  });

  it("is skipped when the E-A went out less than 24 h ago", () => {
    const now = localAt("2026-10-14", 12, SAO_PAULO);
    expect(
      eve({ now, trialStartedSentAt: new Date(now.getTime() - 23 * HOUR) })
    ).toBe("trial_started_recently");
    expect(eve({ now, trialStartedSentAt: new Date(now.getTime() - 1) })).toBe(
      "trial_started_recently"
    );
  });

  it("goes out when the E-A went out 24 h ago or more, or never", () => {
    const now = localAt("2026-10-14", 12, SAO_PAULO);
    expect(
      eve({ now, trialStartedSentAt: new Date(now.getTime() - 24 * HOUR) })
    ).toBe(null);
    expect(eve({ now, trialStartedSentAt: null })).toBe(null);
  });

  it("puts the window before the recent E-A", () => {
    const now = localAt("2026-10-14", 21, SAO_PAULO);
    expect(
      eve({ now, trialStartedSentAt: new Date(now.getTime() - HOUR) })
    ).toBe("window_passed");
  });

  it("is skipped as price_unknown only when everything else holds", () => {
    expect(eve({ amount: null })).toBe("price_unknown");
    expect(eve({ amount: null, firstChargeOn: "2026-10-16" })).toBe(
      "window_passed"
    );
  });

  describe.each(ZONES)("in %s", (zone) => {
    const local = (date: string, hour: number, minute = 0) =>
      localAt(date, hour, zone, minute);

    it("reads tomorrow and the hour in the store's zone", () => {
      expect(
        eve({
          firstChargeOn: "2026-10-15",
          now: local("2026-10-14", 12),
          timeZone: zone,
        })
      ).toBe(null);
      expect(
        eve({
          firstChargeOn: "2026-10-15",
          now: local("2026-10-14", 19, 59),
          timeZone: zone,
        })
      ).toBe(null);
      expect(
        eve({
          firstChargeOn: "2026-10-15",
          now: local("2026-10-14", 20),
          timeZone: zone,
        })
      ).toBe("window_passed");
      expect(
        eve({
          firstChargeOn: "2026-10-14",
          now: local("2026-10-14", 12),
          timeZone: zone,
        })
      ).toBe("window_passed");
    });

    it("is early in the morning for the local day, not the UTC day", () => {
      // 00:30 local is already the next UTC day in the three zones
      expect(
        eve({
          firstChargeOn: "2026-10-15",
          now: local("2026-10-14", 0, 30),
          timeZone: zone,
        })
      ).toBe(null);
      expect(
        eve({
          firstChargeOn: "2026-10-16",
          now: local("2026-10-14", 0, 30),
          timeZone: zone,
        })
      ).toBe("window_passed");
    });
  });

  it("tells the zones apart at one instant", () => {
    // 03:30 UTC on the 15th: 00:30 on the 15th in Sao Paulo, still the 14th (23:30 and 22:30) in the other two
    const now = new Date("2026-10-15T03:30:00.000Z");
    const answers = ZONES.map((zone) =>
      eve({ firstChargeOn: "2026-10-16", now, timeZone: zone })
    );
    expect(answers).toEqual([null, "window_passed", "window_passed"]);
  });
});

describe("noticeStillTrue: first_charge_failed (E-C1)", () => {
  it("goes out while the store is on Free and paid nothing since", () => {
    expect(run("first_charge_failed", REF, { record: free() })).toBe(null);
    expect(
      run("first_charge_failed", REF, {
        record: free({ state: "free_over_limit" }),
      })
    ).toBe(null);
  });

  it("is skipped as recovered when the store paid after all", () => {
    expect(
      run("first_charge_failed", REF, {
        paidSinceNotice: true,
        record: free(),
      })
    ).toBe("recovered");
  });

  it("is skipped as recovered when the store is on Pro again", () => {
    expect(
      run("first_charge_failed", REF, {
        record: pro("active", PERIOD_END),
      })
    ).toBe("recovered");
  });

  it("is skipped as price_unknown when no amount was recorded", () => {
    expect(run("first_charge_failed", REF, { amount: null })).toBe(
      "price_unknown"
    );
    expect(
      run("first_charge_failed", REF, { amount: null, paidSinceNotice: true })
    ).toBe("recovered");
  });
});

describe("noticeStillTrue: renewal_failed (E-C2)", () => {
  const PAID_END = new Date("2026-10-14T15:00:00.000Z");
  const GRACE_END = new Date(PAID_END.getTime() + 7 * DAY);
  const key = (milestone: string, paidEnd = PAID_END) =>
    `${paidEnd.toISOString()}:${milestone}`;
  const grace = (overrides: Partial<BillingRecord> = {}) =>
    pro("grace", GRACE_END, overrides);
  const failed = (
    milestone: string,
    now: Date,
    overrides: Partial<BillingNoticeCheck> = {}
  ) =>
    run("renewal_failed", key(milestone), {
      now,
      record: grace(),
      ...overrides,
    });
  // the milestone days in Sao Paulo: d0 the 14th, d3 the 17th, dlast the 20th (the grace ends on the 21st)
  const day = (date: string, zone = SAO_PAULO) => localAt(date, 12, zone);

  describe("the state of the renewal", () => {
    it("is skipped as recovered when the store is not in grace", () => {
      for (const milestone of ["d0", "d3", "dlast"]) {
        expect(
          failed(milestone, day("2026-10-17"), {
            record: pro("active", GRACE_END),
          })
        ).toBe("recovered");
        expect(failed(milestone, day("2026-10-17"), { record: free() })).toBe(
          "recovered"
        );
      }
    });

    it("is skipped as recovered when the grace is of another period", () => {
      const next = new Date(GRACE_END.getTime() + 30 * DAY);
      expect(
        failed("d0", day("2026-10-14"), { record: pro("grace", next) })
      ).toBe("recovered");
    });

    it("is skipped as recovered when there is no end of access", () => {
      expect(
        failed("d0", day("2026-10-14"), {
          record: { ...grace(), accessEndsAt: null },
        })
      ).toBe("recovered");
    });

    it("accepts the same period within a day, and not beyond", () => {
      expect(
        failed("d0", day("2026-10-14"), {
          record: pro("grace", new Date(GRACE_END.getTime() + DAY)),
        })
      ).toBe(null);
      expect(
        failed("d0", day("2026-10-14"), {
          record: pro("grace", new Date(GRACE_END.getTime() - DAY)),
        })
      ).toBe(null);
      expect(
        failed("d0", day("2026-10-14"), {
          record: pro("grace", new Date(GRACE_END.getTime() + DAY + 1)),
        })
      ).toBe("recovered");
      expect(
        failed("d0", day("2026-10-14"), {
          record: pro("grace", new Date(GRACE_END.getTime() - DAY - 1)),
        })
      ).toBe("recovered");
    });

    it("is skipped as recovered for a key that is not of the form", () => {
      expect(run("renewal_failed", "not-a-key", { record: grace() })).toBe(
        "recovered"
      );
      expect(
        run("renewal_failed", `${PAID_END.toISOString()}:d9`, {
          record: grace(),
        })
      ).toBe("recovered");
    });
  });

  describe("d0, the day of the failure", () => {
    it("always goes out, on its day", () => {
      expect(failed("d0", day("2026-10-14"))).toBe(null);
    });

    it("goes out even when the renewal was cancelled meanwhile", () => {
      expect(
        failed("d0", day("2026-10-14"), {
          record: grace({ cancelAtPeriodEnd: true }),
        })
      ).toBe(null);
    });

    it("goes out even when another E-C2 of the period went out the same day", () => {
      expect(
        failed("d0", day("2026-10-14"), {
          renewalFailedSentAt: [day("2026-10-14")],
        })
      ).toBe(null);
    });

    it("goes out late, after its day", () => {
      expect(failed("d0", day("2026-10-19"))).toBe(null);
    });

    it("is skipped as price_unknown when no amount was recorded", () => {
      expect(failed("d0", day("2026-10-14"), { amount: null })).toBe(
        "price_unknown"
      );
    });

    it("gives recovered, not price_unknown, when the store recovered", () => {
      expect(
        failed("d0", day("2026-10-14"), { amount: null, record: free() })
      ).toBe("recovered");
    });
  });

  describe.each(["d3", "dlast"])("%s", (milestone) => {
    const own = milestone === "d3" ? "2026-10-17" : "2026-10-20";

    it("goes out on its own day", () => {
      expect(failed(milestone, day(own))).toBe(null);
    });

    it("is skipped as cancelled when the renewal was cancelled", () => {
      expect(
        failed(milestone, day(own), {
          record: grace({ cancelAtPeriodEnd: true }),
        })
      ).toBe("cancelled");
    });

    it("is skipped as milestone_passed after its day", () => {
      expect(failed(milestone, day("2026-10-21"))).toBe("milestone_passed");
    });

    it("is skipped as same_day when another E-C2 of the period went out today", () => {
      expect(
        failed(milestone, day(own), { renewalFailedSentAt: [day(own)] })
      ).toBe("same_day");
    });

    it("is not held by an E-C2 sent on another local day", () => {
      expect(
        failed(milestone, day(own), {
          renewalFailedSentAt: [localAt("2026-10-14", 12, SAO_PAULO)],
        })
      ).toBe(null);
    });

    it("needs no amount", () => {
      expect(failed(milestone, day(own), { amount: null })).toBe(null);
    });

    it("puts cancelled before the day of the milestone", () => {
      expect(
        failed(milestone, day("2026-10-21"), {
          record: grace({ cancelAtPeriodEnd: true }),
        })
      ).toBe("cancelled");
    });

    it("puts the day of the milestone before the same day", () => {
      expect(
        failed(milestone, day("2026-10-21"), {
          renewalFailedSentAt: [day("2026-10-21")],
        })
      ).toBe("milestone_passed");
    });
  });

  describe("the late failure (the sweep notices it on the 5th, 6th or 7th day)", () => {
    it("on the 5th day: d3 is dropped, d0 goes out and d0 holds the dlast of that day", () => {
      const now = day("2026-10-19");
      expect(failed("d0", now)).toBe(null);
      expect(failed("d3", now)).toBe("milestone_passed");
      expect(failed("dlast", now)).toBe(null);
      expect(failed("dlast", now, { renewalFailedSentAt: [now] })).toBe(
        "same_day"
      );
    });

    it("on the 6th day: d3 is dropped, d0 goes out and the dlast of the same day is held", () => {
      const now = day("2026-10-20");
      expect(failed("d0", now)).toBe(null);
      expect(failed("d3", now)).toBe("milestone_passed");
      expect(failed("dlast", now)).toBe(null);
      expect(failed("dlast", now, { renewalFailedSentAt: [now] })).toBe(
        "same_day"
      );
    });

    it("on the 7th day: d3 and dlast are dropped and only d0 goes out", () => {
      const now = day("2026-10-21");
      expect(failed("d0", now)).toBe(null);
      expect(failed("d3", now)).toBe("milestone_passed");
      expect(failed("dlast", now)).toBe("milestone_passed");
    });

    it("never sends two on one day", () => {
      for (const date of ["2026-10-14", "2026-10-17", "2026-10-20"]) {
        const now = day(date);
        const sent = [now];
        expect(failed("d3", now, { renewalFailedSentAt: sent })).not.toBe(null);
        expect(failed("dlast", now, { renewalFailedSentAt: sent })).not.toBe(
          null
        );
      }
    });
  });

  describe.each(ZONES)("the day of the milestone in %s", (zone) => {
    // the paid period ends at 23:30 local of the 13th: d3 falls on the 16th, dlast on the 19th
    const paidEnd = localAt("2026-10-13", 23, zone, 30);
    const graceEnd = new Date(paidEnd.getTime() + 7 * DAY);
    const zoned = (
      milestone: string,
      now: Date,
      overrides: Partial<BillingNoticeCheck> = {}
    ) =>
      run("renewal_failed", key(milestone, paidEnd), {
        now,
        record: pro("grace", graceEnd),
        timeZone: zone,
        ...overrides,
      });

    it("sends d3 on the 16th and drops it from the 17th, by the local day", () => {
      expect(zoned("d3", localAt("2026-10-16", 0, zone, 5))).toBe(null);
      expect(zoned("d3", localAt("2026-10-16", 23, zone, 55))).toBe(null);
      expect(zoned("d3", localAt("2026-10-17", 0, zone, 5))).toBe(
        "milestone_passed"
      );
    });

    it("sends dlast on the 19th and drops it from the 20th, by the local day", () => {
      expect(zoned("dlast", localAt("2026-10-19", 0, zone, 5))).toBe(null);
      expect(zoned("dlast", localAt("2026-10-19", 23, zone, 55))).toBe(null);
      expect(zoned("dlast", localAt("2026-10-20", 0, zone, 5))).toBe(
        "milestone_passed"
      );
    });

    it("holds an E-C2 of the same local day and not of the day before", () => {
      const now = localAt("2026-10-16", 12, zone);
      expect(
        zoned("d3", now, {
          renewalFailedSentAt: [localAt("2026-10-16", 0, zone, 10)],
        })
      ).toBe("same_day");
      expect(
        zoned("d3", now, {
          renewalFailedSentAt: [localAt("2026-10-15", 23, zone, 50)],
        })
      ).toBe(null);
    });
  });

  it("tells the zones apart at one instant", () => {
    // paid until 03:30 UTC on the 14th: the 14th in Sao Paulo, the 13th in Manaus and Rio Branco
    const paidEnd = new Date("2026-10-14T03:30:00.000Z");
    const graceEnd = new Date(paidEnd.getTime() + 7 * DAY);
    const now = new Date("2026-10-17T14:00:00.000Z");
    const answers = ZONES.map((zone) =>
      run("renewal_failed", key("d3", paidEnd), {
        now,
        record: pro("grace", graceEnd),
        timeZone: zone,
      })
    );
    expect(answers).toEqual([null, "milestone_passed", "milestone_passed"]);
  });
});

describe("renewalFailedOf and renewalFailedDayOf", () => {
  const PAID_END = new Date("2026-10-14T15:00:00.000Z");

  it("reads the paid end and the milestone of a key", () => {
    for (const milestone of ["d0", "d3", "dlast"] as const) {
      expect(renewalFailedOf(`${PAID_END.toISOString()}:${milestone}`)).toEqual(
        { milestone, paidEnd: PAID_END }
      );
    }
  });

  it("answers null for a key that is not of the form", () => {
    expect(renewalFailedOf("")).toBe(null);
    expect(renewalFailedOf("d0")).toBe(null);
    expect(renewalFailedOf(PAID_END.toISOString())).toBe(null);
    expect(renewalFailedOf(`${PAID_END.toISOString()}:d1`)).toBe(null);
    expect(renewalFailedOf(`${PAID_END.toISOString()}:`)).toBe(null);
    expect(renewalFailedOf("garbage:d0")).toBe(null);
    expect(renewalFailedOf(":d0")).toBe(null);
  });

  it("puts d0 on the local day of the paid end, d3 three days after and dlast the day before the grace ends", () => {
    expect(renewalFailedDayOf("d0", PAID_END, SAO_PAULO)).toBe("2026-10-14");
    expect(renewalFailedDayOf("d3", PAID_END, SAO_PAULO)).toBe("2026-10-17");
    expect(renewalFailedDayOf("dlast", PAID_END, SAO_PAULO)).toBe("2026-10-20");
  });

  it("follows the zone at the edge of the day", () => {
    const paidEnd = new Date("2026-10-14T03:30:00.000Z");
    expect(renewalFailedDayOf("d0", paidEnd, SAO_PAULO)).toBe("2026-10-14");
    expect(renewalFailedDayOf("d0", paidEnd, MANAUS)).toBe("2026-10-13");
    expect(renewalFailedDayOf("d0", paidEnd, RIO_BRANCO)).toBe("2026-10-13");
    expect(renewalFailedDayOf("d3", paidEnd, MANAUS)).toBe("2026-10-16");
    expect(renewalFailedDayOf("dlast", paidEnd, SAO_PAULO)).toBe("2026-10-20");
    expect(renewalFailedDayOf("dlast", paidEnd, RIO_BRANCO)).toBe("2026-10-19");
  });

  it("crosses the end of a month", () => {
    const paidEnd = new Date("2026-10-29T15:00:00.000Z");
    expect(renewalFailedDayOf("d3", paidEnd, SAO_PAULO)).toBe("2026-11-01");
    expect(renewalFailedDayOf("dlast", paidEnd, SAO_PAULO)).toBe("2026-11-04");
  });
});

describe("noticeStillTrue: access_ended (E-D)", () => {
  it("goes out when the store is on Free", () => {
    expect(run("access_ended", REF, { record: free() })).toBe(null);
    expect(
      run("access_ended", REF, { record: free({ state: "free_over_limit" }) })
    ).toBe(null);
  });

  it("is skipped as state_changed when the store is on Pro again", () => {
    expect(
      run("access_ended", REF, { record: pro("active", PERIOD_END) })
    ).toBe("state_changed");
    expect(run("access_ended", REF, { record: pro("grace", PERIOD_END) })).toBe(
      "state_changed"
    );
  });

  it("is skipped as refunded, before the state", () => {
    expect(
      run("access_ended", REF, {
        record: free({ revoked: refundOf(PERIOD_END) }),
      })
    ).toBe("refunded");
    expect(
      run("access_ended", REF, {
        record: pro("active", PERIOD_END, { revoked: refundOf(PERIOD_END) }),
      })
    ).toBe("refunded");
  });

  it("needs no amount", () => {
    expect(run("access_ended", REF, { amount: null })).toBe(null);
  });
});

describe("noticeStillTrue: charge_receipt (E4)", () => {
  const receipt = (overrides: Partial<BillingNoticeCheck> = {}) =>
    run("charge_receipt", EVENT_ID, {
      event: chargeSucceeded(),
      record: pro("active", PERIOD_END),
      ...overrides,
    });
  const EVENT_ID = "0199f0aa-2b3c-7d4e-8f90-0000000000e1";

  it("goes out for a charge that stands", () => {
    expect(receipt()).toBe(null);
  });

  it("is skipped as state_changed when the row is not a charge_succeeded", () => {
    expect(receipt({ event: null })).toBe("state_changed");
    expect(receipt({ event: chargeRefunded() })).toBe("state_changed");
  });

  it("is skipped as refunded when the same period was refunded", () => {
    expect(
      receipt({
        record: free({ revoked: refundOf(PERIOD_END) }),
      })
    ).toBe("refunded");
  });

  it("matches the period within a day, and not beyond", () => {
    const edge = (offset: number) =>
      receipt({
        record: free({
          revoked: refundOf(new Date(PERIOD_END.getTime() + offset)),
        }),
      });
    expect(edge(DAY)).toBe("refunded");
    expect(edge(-DAY)).toBe("refunded");
    expect(edge(DAY + 1)).toBe(null);
    expect(edge(-DAY - 1)).toBe(null);
  });

  it("is not suppressed by a refund of another period", () => {
    expect(
      receipt({
        record: pro("active", PERIOD_END, {
          revoked: refundOf(new Date(PERIOD_END.getTime() - 30 * DAY)),
        }),
      })
    ).toBe(null);
  });

  it("is not suppressed by a chargeback or a won dispute of the same period", () => {
    for (const reason of ["chargeback", "won"] as const) {
      expect(
        receipt({
          record: free({
            revoked: refundOf(PERIOD_END, reason),
          }),
        })
      ).toBe(null);
    }
  });

  it("is skipped as price_unknown when no amount was recorded", () => {
    expect(receipt({ amount: null })).toBe("price_unknown");
    expect(
      receipt({ amount: null, record: free({ revoked: refundOf(PERIOD_END) }) })
    ).toBe("refunded");
  });
});

describe("noticeStillTrue: renewal_cancelled (E7)", () => {
  const cancelled = (overrides: Partial<BillingNoticeCheck> = {}) =>
    run("renewal_cancelled", "cancel-key", {
      record: pro("active", PERIOD_END, { cancelAtPeriodEnd: true }),
      ...overrides,
    });

  it("goes out while the renewal stays cancelled", () => {
    expect(cancelled()).toBe(null);
    expect(
      cancelled({
        record: pro("grace", PERIOD_END, { cancelAtPeriodEnd: true }),
      })
    ).toBe(null);
  });

  it("is skipped as refunded when the payment was refunded", () => {
    expect(
      cancelled({
        record: free({
          cancelAtPeriodEnd: true,
          revoked: refundOf(PERIOD_END),
        }),
      })
    ).toBe("refunded");
  });

  it("puts refunded before the refund in progress", () => {
    const now = base;
    expect(
      cancelled({
        now,
        record: free({
          cancelAtPeriodEnd: true,
          revoked: refundOf(PERIOD_END),
        }),
        refundRequestedAt: new Date(now.getTime() - HOUR),
      })
    ).toBe("refunded");
  });

  it("is skipped as refund_in_progress when the refund was asked for less than 24 h ago", () => {
    expect(
      cancelled({ refundRequestedAt: new Date(base.getTime() - 23 * HOUR) })
    ).toBe("refund_in_progress");
    expect(cancelled({ refundRequestedAt: new Date(base.getTime()) })).toBe(
      "refund_in_progress"
    );
  });

  it("goes out when the refund was asked for 24 h ago or more and did not come", () => {
    expect(
      cancelled({ refundRequestedAt: new Date(base.getTime() - 24 * HOUR) })
    ).toBe(null);
    expect(
      cancelled({ refundRequestedAt: new Date(base.getTime() - 48 * HOUR) })
    ).toBe(null);
  });

  it("is skipped as resubscribed when a Pro store no longer cancels", () => {
    for (const state of ["active", "grace", "trialing"] as const) {
      expect(
        cancelled({
          record: pro(state, PERIOD_END, { cancelAtPeriodEnd: false }),
        })
      ).toBe("resubscribed");
    }
  });

  it("is skipped as state_changed when the store is on Free without a cancellation", () => {
    expect(cancelled({ record: free() })).toBe("state_changed");
    expect(cancelled({ record: free({ state: "free_over_limit" }) })).toBe(
      "state_changed"
    );
  });

  it("needs no amount", () => {
    expect(cancelled({ amount: null })).toBe(null);
  });
});

describe("noticeStillTrue: refund_confirmed (E-R)", () => {
  const confirmed = (overrides: Partial<BillingNoticeCheck> = {}) =>
    run("refund_confirmed", "refund-key", {
      event: chargeRefunded(),
      record: free({ revoked: refundOf(PERIOD_END) }),
      ...overrides,
    });

  it("goes out for a refund of the period that stands", () => {
    expect(confirmed()).toBe(null);
  });

  it("is skipped as state_changed when the row is not a charge_refunded", () => {
    expect(confirmed({ event: null })).toBe("state_changed");
    expect(confirmed({ event: chargeSucceeded() })).toBe("state_changed");
  });

  it("is skipped as state_changed when the record holds no refund", () => {
    expect(confirmed({ record: free() })).toBe("state_changed");
    expect(
      confirmed({
        record: free({
          revoked: refundOf(PERIOD_END, "chargeback"),
        }),
      })
    ).toBe("state_changed");
  });

  it("is skipped as state_changed when the refund is of another period", () => {
    expect(
      confirmed({
        record: free({
          revoked: refundOf(new Date(PERIOD_END.getTime() + 30 * DAY)),
        }),
      })
    ).toBe("state_changed");
  });

  it("matches the period within a day", () => {
    expect(
      confirmed({
        record: free({
          revoked: refundOf(new Date(PERIOD_END.getTime() + DAY)),
        }),
      })
    ).toBe(null);
  });

  it("is skipped as price_unknown when no amount was recorded", () => {
    expect(confirmed({ amount: null })).toBe("price_unknown");
    expect(confirmed({ amount: null, record: free() })).toBe("state_changed");
  });
});

describe("noticeStillTrue: annual_renewal_reminder (E-A7)", () => {
  const ENDS = new Date("2027-03-20T15:00:00.000Z");
  const KEY = ENDS.toISOString();
  const annual = (overrides: Partial<BillingRecord> = {}) =>
    pro("active", ENDS, { cycleMonths: 12, ...overrides });
  const reminder = (overrides: Partial<BillingNoticeCheck> = {}, key = KEY) =>
    run("annual_renewal_reminder", key, {
      now: localAt("2027-03-13", 12, SAO_PAULO),
      record: annual(),
      ...overrides,
    });

  it("goes out 7 local days before the end of the yearly cycle", () => {
    expect(reminder()).toBe(null);
  });

  it("is skipped as state_changed on any other day", () => {
    expect(reminder({ now: localAt("2027-03-12", 12, SAO_PAULO) })).toBe(
      "state_changed"
    );
    expect(reminder({ now: localAt("2027-03-14", 12, SAO_PAULO) })).toBe(
      "state_changed"
    );
  });

  it("is skipped as refunded before anything else", () => {
    expect(
      reminder({
        record: annual({
          cancelAtPeriodEnd: true,
          revoked: refundOf(ENDS),
        }),
      })
    ).toBe("refunded");
  });

  it("is skipped as cancelled when the renewal is cancelled", () => {
    expect(reminder({ record: annual({ cancelAtPeriodEnd: true }) })).toBe(
      "cancelled"
    );
  });

  it("is skipped as state_changed when the store is not active", () => {
    expect(reminder({ record: annual({ state: "grace" }) })).toBe(
      "state_changed"
    );
    expect(reminder({ record: annual({ state: "trialing" }) })).toBe(
      "state_changed"
    );
    expect(reminder({ record: free() })).toBe("state_changed");
  });

  it("is skipped as state_changed when the cycle is not yearly", () => {
    expect(reminder({ record: annual({ cycleMonths: 1 }) })).toBe(
      "state_changed"
    );
    expect(reminder({ record: annual({ cycleMonths: 6 }) })).toBe(
      "state_changed"
    );
  });

  it("is skipped as state_changed when a chargeback or won dispute is remembered", () => {
    for (const reason of ["chargeback", "won"] as const) {
      expect(
        reminder({
          record: annual({ revoked: refundOf(ENDS, reason) }),
        })
      ).toBe("state_changed");
    }
  });

  it("is skipped as state_changed when the end of access moved from the key", () => {
    const moved = new Date(ENDS.getTime() + 365 * DAY);
    expect(
      reminder({
        now: localAt("2028-03-13", 12, SAO_PAULO),
        record: annual({ accessEndsAt: moved }),
      })
    ).toBe("state_changed");
  });

  it("is skipped as state_changed when there is no end of access", () => {
    expect(reminder({ record: annual({ accessEndsAt: null }) })).toBe(
      "state_changed"
    );
  });

  it("reads the day in the store's zone", () => {
    // 20:00 local of the 20th (the end) minus 7 days; the end is 03:30 UTC of the 21st: the 20th local in the three zones
    const ends = new Date("2027-03-21T03:30:00.000Z");
    const record = annual({ accessEndsAt: ends });
    const answers = ZONES.map((zone) =>
      reminder(
        {
          now: localAt("2027-03-14", 12, zone),
          record,
          timeZone: zone,
        },
        ends.toISOString()
      )
    );
    // the end falls on the 21st in Sao Paulo (00:30), on the 20th in Manaus and Rio Branco
    expect(answers).toEqual([null, "state_changed", "state_changed"]);
  });

  it("is skipped as price_unknown when no amount was recorded", () => {
    expect(reminder({ amount: null })).toBe("price_unknown");
    expect(reminder({ amount: null, record: free() })).toBe("state_changed");
  });
});

describe("noticeStillTrue: one store, one refund of a card payment (item 5)", () => {
  const ENDS = new Date("2026-11-14T15:00:00.000Z");
  const apply = (record: BillingRecord, fact: BillingFact): BillingRecord => {
    const result = reconcileFact(record, fact, {
      now: base,
      overFreeLimits: false,
    });
    expect(result.outcome).toBe("applied");
    return result.outcome === "applied" ? result.record : record;
  };
  const cancelFact: BillingFact = {
    occurredAt: base,
    type: "subscription_cancelled",
  };
  const e7 = (record: BillingRecord, overrides = {}) =>
    run("renewal_cancelled", "cancel-key", { record, ...overrides });
  const eR = (record: BillingRecord) =>
    run("refund_confirmed", "refund-key", {
      event: chargeRefunded(ENDS),
      record,
    });

  it("case 1: the cancellation reached the record first, then the refund: E7 is refunded, E-R goes out", () => {
    const afterCancel = apply(pro("active", ENDS), cancelFact);
    expect(afterCancel.cancelAtPeriodEnd).toBe(true);
    const afterRefund = apply(afterCancel, chargeRefunded(ENDS));
    expect(afterRefund.revoked?.reason).toBe("refund");
    expect(e7(afterRefund)).toBe("refunded");
    expect(eR(afterRefund)).toBe(null);
  });

  it("case 2: the refund reached the record first, then the cancellation: E7 is refunded, E-R goes out", () => {
    const afterRefund = apply(pro("active", ENDS), chargeRefunded(ENDS));
    expect(afterRefund.revoked?.reason).toBe("refund");
    expect(e7(afterRefund)).toBe("refunded");
    expect(eR(afterRefund)).toBe(null);
    // the cancellation that arrives after the refund leaves the refund in place
    const afterCancel = reconcileFact(afterRefund, cancelFact, {
      now: base,
      overFreeLimits: false,
    });
    const final =
      afterCancel.outcome === "applied" ? afterCancel.record : afterRefund;
    expect(final.revoked?.reason).toBe("refund");
    expect(e7(final)).toBe("refunded");
    expect(eR(final)).toBe(null);
  });

  it("case 5: a refund not completed in 24 h lets E7 go out", () => {
    const record = pro("active", ENDS, { cancelAtPeriodEnd: true });
    expect(
      e7(record, { refundRequestedAt: new Date(base.getTime() - 25 * HOUR) })
    ).toBe(null);
    expect(
      e7(record, { refundRequestedAt: new Date(base.getTime() - 2 * HOUR) })
    ).toBe("refund_in_progress");
  });

  it("case 6: the receipt (E4) of a charge refunded before it went out is refunded", () => {
    const record = apply(pro("active", ENDS), chargeRefunded(ENDS));
    expect(
      run("charge_receipt", EVENT_FOR_CASES, {
        event: chargeSucceeded(ENDS),
        record,
      })
    ).toBe("refunded");
  });

  it("case 7: the trial start (E-A) and the end of access (E-D) after a refund are refunded", () => {
    const refunded = free({ revoked: refundOf(ENDS) });
    expect(run("trial_started", REF, { record: refunded })).toBe("refunded");
    expect(run("access_ended", REF, { record: refunded })).toBe("refunded");
    expect(
      run("trial_charge_eve", REF, {
        firstChargeOn: "2026-10-15",
        record: refunded,
      })
    ).toBe("refunded");
  });
});

const EVENT_FOR_CASES = "0199f0aa-2b3c-7d4e-8f90-0000000000e1";
