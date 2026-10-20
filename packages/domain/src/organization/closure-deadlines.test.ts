import { describe, expect, it } from "vitest";
import {
  CLOSURE_DELETABLE_AFTER_DAYS,
  CLOSURE_PURGE_GRACE_HOURS,
  CLOSURE_PURGE_MIN_NOTICE_DAYS,
  CLOSURE_PURGE_SCHEDULE_LEAD_DAYS,
  closureDeadlines,
  closurePhaseAt,
  closurePurgeNotBefore,
  closurePurgeSchedulable,
  localDayStart,
} from "./closure-deadlines";

const iso = (date: Date) => date.toISOString();

describe("the day the data may be deleted (D)", () => {
  it("is the local date of the request plus 90 calendar days, from the start of that local day", () => {
    expect(CLOSURE_DELETABLE_AFTER_DAYS).toBe(90);
    const deadlines = closureDeadlines(
      new Date("2026-10-19T15:00:00.000Z"),
      "America/Sao_Paulo"
    );
    expect(deadlines.deletionDate).toBe("2027-01-17");
    expect(iso(deadlines.deletableFrom)).toBe("2027-01-17T03:00:00.000Z");
    expect(iso(deadlines.d30At)).toBe("2026-12-18T03:00:00.000Z");
    expect(iso(deadlines.d7At)).toBe("2027-01-10T03:00:00.000Z");
    expect(iso(deadlines.exportOpenUntil)).toBe("2027-01-17T03:00:00.000Z");
  });

  it("counts the request by the organization's calendar, to the second", () => {
    const lastSecond = closureDeadlines(
      new Date("2026-10-20T02:59:59.000Z"),
      "America/Sao_Paulo"
    );
    const nextDay = closureDeadlines(
      new Date("2026-10-20T03:00:00.000Z"),
      "America/Sao_Paulo"
    );
    expect(lastSecond.deletionDate).toBe("2027-01-17");
    expect(nextDay.deletionDate).toBe("2027-01-18");
    expect(iso(nextDay.deletableFrom)).toBe("2027-01-18T03:00:00.000Z");
  });

  it("uses the organization's own time zone, in Brazil or outside it", () => {
    const manaus = closureDeadlines(
      new Date("2026-10-20T03:30:00.000Z"),
      "America/Manaus"
    );
    expect(manaus.deletionDate).toBe("2027-01-17");
    expect(iso(manaus.deletableFrom)).toBe("2027-01-17T04:00:00.000Z");
    // 00:30 in Lisbon (summer time, +01:00) is already the 20th there
    const lisbon = closureDeadlines(
      new Date("2026-10-19T23:30:00.000Z"),
      "Europe/Lisbon"
    );
    expect(lisbon.deletionDate).toBe("2027-01-18");
    expect(iso(lisbon.deletableFrom)).toBe("2027-01-18T00:00:00.000Z");
  });

  it("starts the day at its first instant across a change of daylight saving time", () => {
    // São Paulo, 4/11/2018: midnight did not exist (the clock jumped to 01:00)
    const gap = closureDeadlines(
      new Date("2018-08-06T15:00:00.000Z"),
      "America/Sao_Paulo"
    );
    expect(gap.deletionDate).toBe("2018-11-04");
    expect(iso(gap.deletableFrom)).toBe("2018-11-04T03:00:00.000Z");
    // Havana, 4/11/2012: midnight happened twice (01:00 went back to 00:00); the first one counts
    const twice = closureDeadlines(
      new Date("2012-08-06T16:00:00.000Z"),
      "America/Havana"
    );
    expect(twice.deletionDate).toBe("2012-11-04");
    expect(iso(twice.deletableFrom)).toBe("2012-11-04T04:00:00.000Z");
    // New York: the milestones fall on both sides of the change of 14/3/2027
    const newYork = closureDeadlines(
      new Date("2026-12-14T17:00:00.000Z"),
      "America/New_York"
    );
    expect(newYork.deletionDate).toBe("2027-03-14");
    expect(iso(newYork.deletableFrom)).toBe("2027-03-14T05:00:00.000Z");
    expect(iso(newYork.d7At)).toBe("2027-03-07T05:00:00.000Z");
    expect(iso(newYork.d30At)).toBe("2027-02-12T05:00:00.000Z");
  });

  it("finds the start of any local day", () => {
    expect(iso(localDayStart("2026-03-01", "UTC"))).toBe(
      "2026-03-01T00:00:00.000Z"
    );
    expect(iso(localDayStart("2026-03-01", "Asia/Tokyo"))).toBe(
      "2026-02-28T15:00:00.000Z"
    );
  });

  it("refuses a time zone or a date that does not exist", () => {
    expect(() =>
      closureDeadlines(new Date("2026-10-19T15:00:00.000Z"), "Nowhere/City")
    ).toThrow();
    expect(() => localDayStart("2026-02-30", "UTC")).toThrow();
  });
});

describe("the phase of a closed organization", () => {
  const requestedAt = new Date("2026-10-19T15:00:00.000Z");
  const recoverUntil = new Date("2026-11-18T15:00:00.000Z");
  const phase = (now: string, purgedAt: Date | null = null) =>
    closurePhaseAt(
      { purgedAt, recoverUntil, requestedAt, timeZone: "America/Sao_Paulo" },
      new Date(now)
    );

  it("moves only with the dates", () => {
    expect(phase("2026-11-18T14:59:59.999Z")).toBe("closing");
    expect(phase("2026-11-18T15:00:00.000Z")).toBe("closed");
    expect(phase("2027-01-10T02:59:59.999Z")).toBe("closed");
    expect(phase("2027-01-10T03:00:00.000Z")).toBe("deletion_scheduled");
    expect(phase("2027-01-17T02:59:59.999Z")).toBe("deletion_scheduled");
    expect(phase("2027-01-17T03:00:00.000Z")).toBe("deletable");
    expect(phase("2027-06-01T00:00:00.000Z")).toBe("deletable");
  });

  it("is purged once the data is gone, whatever the date", () => {
    expect(
      phase("2026-11-01T00:00:00.000Z", new Date("2026-11-01T00:00:00.000Z"))
    ).toBe("purged");
  });

  it("keeps the schedule's numbers in one place", () => {
    expect(CLOSURE_PURGE_SCHEDULE_LEAD_DAYS).toBe(7);
    expect(CLOSURE_PURGE_GRACE_HOURS).toBe(48);
  });
});

describe("the automatic schedule of the purge (ADR 0102)", () => {
  const requestedAt = new Date("2026-10-19T15:00:00.000Z");
  const zone = "America/Sao_Paulo";

  it("starts at the first instant of D minus 7 local days, to the second", () => {
    expect(CLOSURE_PURGE_SCHEDULE_LEAD_DAYS).toBe(7);
    // D is 2027-01-17 local; D - 7 is 2027-01-10 local, which starts at 03:00 UTC
    expect(
      closurePurgeSchedulable(
        requestedAt,
        zone,
        new Date("2027-01-10T02:59:59.000Z")
      )
    ).toBe(false);
    expect(
      closurePurgeSchedulable(
        requestedAt,
        zone,
        new Date("2027-01-10T03:00:00.000Z")
      )
    ).toBe(true);
  });

  it("never runs before D plus 48 hours when scheduled on time", () => {
    expect(CLOSURE_PURGE_GRACE_HOURS).toBe(48);
    expect(
      iso(
        closurePurgeNotBefore(
          requestedAt,
          zone,
          new Date("2027-01-10T03:00:00.000Z")
        )
      )
    ).toBe("2027-01-19T03:00:00.000Z");
  });

  it("never runs before the schedule plus 7 days when the sweep was late", () => {
    expect(CLOSURE_PURGE_MIN_NOTICE_DAYS).toBe(7);
    const late = new Date("2027-01-15T10:30:00.000Z");
    expect(iso(closurePurgeNotBefore(requestedAt, zone, late))).toBe(
      "2027-01-22T10:30:00.000Z"
    );
  });

  it("counts D in the organization's zone, across a change of daylight saving time", () => {
    // New York: the clock goes forward on 2027-03-14; D - 7 is in standard time and D in daylight time
    const requested = new Date("2026-12-16T17:00:00.000Z");
    const deadlines = closureDeadlines(requested, "America/New_York");
    expect(deadlines.deletionDate).toBe("2027-03-16");
    expect(iso(deadlines.d7At)).toBe("2027-03-09T05:00:00.000Z");
    expect(iso(deadlines.deletableFrom)).toBe("2027-03-16T04:00:00.000Z");
    expect(
      iso(closurePurgeNotBefore(requested, "America/New_York", deadlines.d7At))
    ).toBe("2027-03-18T04:00:00.000Z");
  });
});
