import { describe, expect, it } from "vitest";
import { RETENTION_POLICIES, RETENTION_PURGE_JOBS } from "../privacy/retention";
import {
  isScheduledJobId,
  jobsOfLane,
  SCHEDULED_JOBS,
  SCHEDULER_LANES,
  scheduledJob,
  windowIndex,
  windowsMissed,
} from "./scheduled-jobs";

const HOUR = 3600;
const JOB_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const HOURLY_CRON = /^\d{1,2} \* \* \* \*$/;

describe("scheduler windows", () => {
  it("puts an instant in the window of its cadence, counted from the epoch in UTC", () => {
    expect(windowIndex(new Date("1970-01-01T00:00:00Z"), HOUR)).toBe(0);
    expect(windowIndex(new Date("1970-01-01T00:59:59Z"), HOUR)).toBe(0);
    expect(windowIndex(new Date("1970-01-01T01:00:00Z"), HOUR)).toBe(1);
    expect(windowIndex(new Date("2026-10-18T13:17:00Z"), HOUR)).toBe(
      windowIndex(new Date("2026-10-18T13:59:00Z"), HOUR)
    );
    expect(windowIndex(new Date("2026-10-18T13:59:59Z"), HOUR)).not.toBe(
      windowIndex(new Date("2026-10-18T14:00:00Z"), HOUR)
    );
  });

  it("counts a daily window from midnight UTC", () => {
    expect(windowIndex(new Date("2026-10-18T00:00:00Z"), 86_400)).toBe(
      windowIndex(new Date("2026-10-18T23:59:59Z"), 86_400)
    );
  });

  it("refuses a cadence that is not a whole number of seconds", () => {
    expect(() => windowIndex(new Date(), 0)).toThrow("invalid_cadence");
    expect(() => windowIndex(new Date(), 1.5)).toThrow("invalid_cadence");
  });

  it("counts the windows that passed without a run, none for the first run", () => {
    const at = (iso: string) => new Date(iso);
    expect(windowsMissed(null, at("2026-10-18T13:17:00Z"), HOUR)).toBe(0);
    // ran at 12:17, now 13:17: the next window, nothing missed
    expect(
      windowsMissed(
        at("2026-10-18T12:17:00Z"),
        at("2026-10-18T13:17:00Z"),
        HOUR
      )
    ).toBe(0);
    // ran at 12:17, now 16:17: 13h, 14h and 15h were skipped
    expect(
      windowsMissed(
        at("2026-10-18T12:17:00Z"),
        at("2026-10-18T16:17:00Z"),
        HOUR
      )
    ).toBe(3);
    // the same window again is not a miss, and never negative
    expect(
      windowsMissed(
        at("2026-10-18T12:17:00Z"),
        at("2026-10-18T12:40:00Z"),
        HOUR
      )
    ).toBe(0);
  });
});

describe("the registry of scheduled jobs", () => {
  it("names every job once, in the dotted form the state table accepts", () => {
    const ids = SCHEDULED_JOBS.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(JOB_ID);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(isScheduledJobId(id)).toBe(true);
    }
    expect(isScheduledJobId("nothing.here")).toBe(false);
  });

  it("holds the jobs the plan lists, and the ones that already existed", () => {
    expect(SCHEDULED_JOBS.map((job) => job.id).sort()).toEqual([
      "auth.login_lock_expiry",
      "auth.unverified_user_purge",
      "billing.maintenance",
      "billing.provider_reconcile",
      "expenses.recurring_generation",
      "media.maintenance",
      "outbox.dispatch",
      "privacy.maintenance",
    ]);
  });

  it("gives each job a cadence the platform lease can hold and a lease the cron wall cannot outlive", () => {
    for (const job of SCHEDULED_JOBS) {
      expect(job.cadenceSeconds).toBeGreaterThanOrEqual(HOUR);
      expect(86_400 % job.cadenceSeconds).toBe(0);
      // the state function accepts 60 to 3600; a cron invocation lives at most 15 minutes
      expect(job.leaseSeconds).toBeGreaterThanOrEqual(900);
      expect(job.leaseSeconds).toBeLessThanOrEqual(3600);
      expect(job.idempotentBy.trim()).not.toBe("");
      expect(job.description.trim()).not.toBe("");
    }
  });

  it("uses few cron triggers: two lanes, well under the five of the Free plan", () => {
    expect(SCHEDULER_LANES.length).toBeLessThanOrEqual(5);
    expect(new Set(SCHEDULER_LANES.map((lane) => lane.cron)).size).toBe(
      SCHEDULER_LANES.length
    );
    for (const lane of SCHEDULER_LANES) {
      expect(lane.cron).toMatch(HOURLY_CRON);
    }
  });

  it("runs an enabled job in a lane that ticks at least as often as its cadence, and a disabled one nowhere", () => {
    for (const job of SCHEDULED_JOBS) {
      if (job.status === "enabled") {
        const lane = SCHEDULER_LANES.find(
          (candidate) => candidate.id === job.lane
        );
        expect(lane).toBeDefined();
        expect(lane?.tickSeconds).toBeLessThanOrEqual(job.cadenceSeconds);
        expect(jobsOfLane(job.lane)).toContain(job.id);
      } else {
        expect(job.lane).toBeNull();
        for (const lane of SCHEDULER_LANES) {
          expect(jobsOfLane(lane.id)).not.toContain(job.id);
        }
      }
    }
  });

  it("keeps the order the maintenance always had (media, billing, privacy) and then the two jobs of authentication", () => {
    expect(jobsOfLane("maintenance")).toEqual([
      "media.maintenance",
      "billing.maintenance",
      "privacy.maintenance",
      "auth.login_lock_expiry",
      "auth.unverified_user_purge",
    ]);
    expect(jobsOfLane("outbox")).toEqual(["outbox.dispatch"]);
  });

  it("says why a disabled job is off and what it waits for", () => {
    const disabled = SCHEDULED_JOBS.filter((job) => job.status === "disabled");
    expect(disabled.map((job) => job.id).sort()).toEqual([
      "billing.provider_reconcile",
      "expenses.recurring_generation",
    ]);
    for (const job of disabled) {
      if (job.status === "disabled") {
        expect(job.pending.trim()).not.toBe("");
        expect(job.waitsFor.trim()).not.toBe("");
      }
    }
    const reconcile = scheduledJob("billing.provider_reconcile");
    expect(reconcile.status === "disabled" && reconcile.waitsFor).toContain(
      "Gate 7"
    );
  });
});

describe("scheduled jobs and retention", () => {
  const purged = SCHEDULED_JOBS.flatMap((job) => job.purges);

  it("run exactly the purge jobs of the retention registry, each once", () => {
    expect([...purged].sort()).toEqual(
      RETENTION_PURGE_JOBS.map((job) => job.id).sort()
    );
  });

  it("never purge a class whose retention is only proposed", () => {
    for (const purge of RETENTION_PURGE_JOBS) {
      if (purged.includes(purge.id)) {
        const policy = RETENTION_POLICIES.find(
          (candidate) => candidate.class === purge.class
        );
        expect(policy?.status).toBe("aprovada");
      }
    }
  });

  it("keep a disabled job from purging anything", () => {
    for (const job of SCHEDULED_JOBS) {
      if (job.status === "disabled") {
        expect(job.purges).toEqual([]);
      }
    }
  });
});
