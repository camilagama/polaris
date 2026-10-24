import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CANCELLATION_FEEDBACK_EXPIRY_BATCH,
  CLOSURE_AUTO_PURGE_ALERT_PER_DAY,
  CLOSURE_SWEEP_BATCH,
  CLOSURE_SWEEP_MAX_BATCHES,
  closureAutoPurgeEnabled,
  closureAutoPurgeVolumeHigh,
  runPrivacyMaintenance,
} from "./maintenance";

const off = { autoPurgeEnabled: false };
const on = { autoPurgeEnabled: true };

const nothingToSchedule = () =>
  vi.fn((_limit: number) =>
    Promise.resolve({ overdue: 0, scheduled: 0, scheduledLastDay: 0 })
  );

const noneHeldBack = () => vi.fn(() => Promise.resolve(0));

const noneExpired = () => vi.fn((_limit: number) => Promise.resolve(0));

const nothingToRecord = () =>
  vi.fn((_limit: number) =>
    Promise.resolve({ organizations: 0, overdue: 0, recorded: 0, skipped: 0 })
  );

describe("the closure sweep", () => {
  it("asks once and stops when nothing was due", async () => {
    const finalizeExpiredClosures = vi.fn(() => Promise.resolve(0));
    await expect(
      runPrivacyMaintenance(
        {
          countPurgesHeldBack: noneHeldBack(),
          expireCancellationFeedback: noneExpired(),
          finalizeExpiredClosures,
          recordClosureNotices: nothingToRecord(),
          scheduleClosedOrganizationPurges: nothingToSchedule(),
        },
        off
      )
    ).resolves.toEqual({
      cancellationFeedbackExpired: 0,
      closedOrganizations: 0,
      closureNoticesOverdue: 0,
      closureNoticesRecorded: 0,
      closureNoticesSkipped: 0,
      overduePurges: 0,
      purgeSchedulingEnabled: false,
      purgesHeldBack: 0,
      scheduledPurges: 0,
      scheduledPurgesLastDay: 0,
    });
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(1);
    expect(finalizeExpiredClosures).toHaveBeenCalledWith(CLOSURE_SWEEP_BATCH);
  });

  it("keeps going while a whole batch was closed, and counts them all", async () => {
    const finalizeExpiredClosures = vi
      .fn<(limit: number) => Promise<number>>()
      .mockResolvedValueOnce(CLOSURE_SWEEP_BATCH)
      .mockResolvedValueOnce(7);
    const report = await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures,
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(report.closedOrganizations).toBe(CLOSURE_SWEEP_BATCH + 7);
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(2);
  });

  it("is bounded: a long backlog is left for the next run", async () => {
    const finalizeExpiredClosures = vi.fn(() =>
      Promise.resolve(CLOSURE_SWEEP_BATCH)
    );
    await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures,
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(
      CLOSURE_SWEEP_MAX_BATCHES
    );
  });

  it("lets a failure reach the caller", async () => {
    await expect(
      runPrivacyMaintenance(
        {
          countPurgesHeldBack: noneHeldBack(),
          expireCancellationFeedback: noneExpired(),
          finalizeExpiredClosures: () => Promise.reject(new Error("db_down")),
          recordClosureNotices: nothingToRecord(),
          scheduleClosedOrganizationPurges: nothingToSchedule(),
        },
        on
      )
    ).rejects.toThrow("db_down");
  });
});

describe("the automatic schedule of the purge (ADR 0102, AC-62)", () => {
  it("schedules nothing with the switch off", async () => {
    const scheduleClosedOrganizationPurges = nothingToSchedule();
    const report = await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures: () => Promise.resolve(0),
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges,
      },
      off
    );
    expect(scheduleClosedOrganizationPurges).not.toHaveBeenCalled();
    expect(report.purgeSchedulingEnabled).toBe(false);
    expect(report.scheduledPurges).toBe(0);
  });

  it("schedules after closing, in bounded batches, with the switch on", async () => {
    const calls: string[] = [];
    const finalizeExpiredClosures = vi.fn(() => {
      calls.push("close");
      return Promise.resolve(3);
    });
    const scheduleClosedOrganizationPurges = vi
      .fn<
        (limit: number) => Promise<{
          overdue: number;
          scheduled: number;
          scheduledLastDay: number;
        }>
      >()
      .mockImplementationOnce(() => {
        calls.push("schedule");
        return Promise.resolve({
          overdue: 1,
          scheduled: CLOSURE_SWEEP_BATCH,
          scheduledLastDay: CLOSURE_SWEEP_BATCH,
        });
      })
      .mockImplementationOnce(() => {
        calls.push("schedule");
        return Promise.resolve({
          overdue: 1,
          scheduled: 2,
          scheduledLastDay: CLOSURE_SWEEP_BATCH + 2,
        });
      });
    const report = await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures,
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges,
      },
      on
    );
    expect(calls).toEqual(["close", "schedule", "schedule"]);
    expect(scheduleClosedOrganizationPurges).toHaveBeenCalledWith(
      CLOSURE_SWEEP_BATCH
    );
    expect(report).toEqual({
      cancellationFeedbackExpired: 0,
      closedOrganizations: 3,
      closureNoticesOverdue: 0,
      closureNoticesRecorded: 0,
      closureNoticesSkipped: 0,
      overduePurges: 1,
      purgeSchedulingEnabled: true,
      purgesHeldBack: 0,
      scheduledPurges: CLOSURE_SWEEP_BATCH + 2,
      scheduledPurgesLastDay: CLOSURE_SWEEP_BATCH + 2,
    });
  });

  it("is bounded like the closure sweep", async () => {
    const scheduleClosedOrganizationPurges = vi.fn(() =>
      Promise.resolve({
        overdue: 0,
        scheduled: CLOSURE_SWEEP_BATCH,
        scheduledLastDay: CLOSURE_SWEEP_BATCH,
      })
    );
    await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures: () => Promise.resolve(0),
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges,
      },
      on
    );
    expect(scheduleClosedOrganizationPurges).toHaveBeenCalledTimes(
      CLOSURE_SWEEP_MAX_BATCHES
    );
  });

  it("counts the purges held back past their time with the switch on or off, after the notices", async () => {
    for (const options of [off, on]) {
      const calls: string[] = [];
      const countPurgesHeldBack = vi.fn(() => {
        calls.push("held back");
        return Promise.resolve(3);
      });
      // biome-ignore lint/performance/noAwaitInLoops: the switch off, then on, one after the other
      const report = await runPrivacyMaintenance(
        {
          countPurgesHeldBack,
          expireCancellationFeedback: noneExpired(),
          finalizeExpiredClosures: () => Promise.resolve(0),
          recordClosureNotices: vi.fn((_limit: number) => {
            calls.push("notices");
            return Promise.resolve({
              organizations: 0,
              overdue: 0,
              recorded: 0,
              skipped: 0,
            });
          }),
          scheduleClosedOrganizationPurges: nothingToSchedule(),
        },
        options
      );
      expect(report.purgesHeldBack).toBe(3);
      expect(calls).toEqual(["notices", "held back"]);
    }
  });

  it("is turned on only by the exact text true", () => {
    expect(closureAutoPurgeEnabled("true")).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      expect(closureAutoPurgeEnabled(value), String(value)).toBe(false);
    }
  });

  it("raises the alert above 5 organizations in a day, not at 5", () => {
    expect(CLOSURE_AUTO_PURGE_ALERT_PER_DAY).toBe(5);
    const report = (scheduledPurgesLastDay: number) => ({
      cancellationFeedbackExpired: 0,
      closedOrganizations: 0,
      closureNoticesOverdue: 0,
      closureNoticesRecorded: 0,
      closureNoticesSkipped: 0,
      overduePurges: 0,
      purgeSchedulingEnabled: true,
      purgesHeldBack: 0,
      scheduledPurges: 0,
      scheduledPurgesLastDay,
    });
    expect(closureAutoPurgeVolumeHigh(report(5))).toBe(false);
    expect(closureAutoPurgeVolumeHigh(report(6))).toBe(true);
  });

  it("is off in every environment of the repository", () => {
    const config = readFileSync(
      new URL("../../../wrangler.jsonc", import.meta.url),
      "utf8"
    );
    const values = [
      ...config.matchAll(/"CLOSURE_AUTO_PURGE_ENABLED":\s*"([^"]*)"/g),
    ].map((match) => match[1]);
    // the local top level, staging and production each declare it, and each one off
    expect(values).toEqual(["false", "false", "false"]);
  });
});

describe("the notices of the closure milestones (ADR 0102, amended)", () => {
  it("are written after the schedule, whatever the switch", async () => {
    for (const options of [off, on]) {
      const calls: string[] = [];
      const recordClosureNotices = vi.fn((_limit: number) => {
        calls.push("notices");
        return Promise.resolve({
          organizations: 2,
          overdue: 4,
          recorded: 2,
          skipped: 1,
        });
      });
      // biome-ignore lint/performance/noAwaitInLoops: the switch off, then on, one after the other
      const report = await runPrivacyMaintenance(
        {
          countPurgesHeldBack: noneHeldBack(),
          expireCancellationFeedback: noneExpired(),
          finalizeExpiredClosures: () => {
            calls.push("close");
            return Promise.resolve(0);
          },
          recordClosureNotices,
          scheduleClosedOrganizationPurges: vi.fn(() => {
            calls.push("schedule");
            return Promise.resolve({
              overdue: 0,
              scheduled: 0,
              scheduledLastDay: 0,
            });
          }),
        },
        options
      );
      expect(calls).toEqual(
        options.autoPurgeEnabled
          ? ["close", "schedule", "notices"]
          : ["close", "notices"]
      );
      expect(recordClosureNotices).toHaveBeenCalledWith(CLOSURE_SWEEP_BATCH);
      expect(report.closureNoticesRecorded).toBe(2);
      expect(report.closureNoticesSkipped).toBe(1);
      expect(report.closureNoticesOverdue).toBe(4);
    }
  });

  it("keep going while a whole batch of organizations was looked at, and are bounded", async () => {
    const recordClosureNotices = vi
      .fn<
        (limit: number) => Promise<{
          organizations: number;
          overdue: number;
          recorded: number;
          skipped: number;
        }>
      >()
      .mockResolvedValueOnce({
        organizations: CLOSURE_SWEEP_BATCH,
        overdue: 5,
        recorded: CLOSURE_SWEEP_BATCH,
        skipped: 3,
      })
      .mockResolvedValueOnce({
        organizations: 4,
        overdue: 2,
        recorded: 4,
        skipped: 0,
      });
    const report = await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures: () => Promise.resolve(0),
        recordClosureNotices,
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(recordClosureNotices).toHaveBeenCalledTimes(2);
    expect(report.closureNoticesRecorded).toBe(CLOSURE_SWEEP_BATCH + 4);
    expect(report.closureNoticesSkipped).toBe(3);
    // the count is the database's, at the end of the last batch: it is not added up
    expect(report.closureNoticesOverdue).toBe(2);
    const endless = vi.fn(() =>
      Promise.resolve({
        organizations: CLOSURE_SWEEP_BATCH,
        overdue: 0,
        recorded: 1,
        skipped: 0,
      })
    );
    await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback: noneExpired(),
        finalizeExpiredClosures: () => Promise.resolve(0),
        recordClosureNotices: endless,
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(endless).toHaveBeenCalledTimes(CLOSURE_SWEEP_MAX_BATCHES);
  });
});

describe("the expiry of the reasons of a cancelled renewal (ADR 0104)", () => {
  it("deletes in batches while a whole batch was due, and counts them all", async () => {
    const expireCancellationFeedback = vi
      .fn<(limit: number) => Promise<number>>()
      .mockResolvedValueOnce(CANCELLATION_FEEDBACK_EXPIRY_BATCH)
      .mockResolvedValueOnce(3);
    const report = await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback,
        finalizeExpiredClosures: vi.fn(() => Promise.resolve(0)),
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(report.cancellationFeedbackExpired).toBe(
      CANCELLATION_FEEDBACK_EXPIRY_BATCH + 3
    );
    expect(expireCancellationFeedback).toHaveBeenCalledTimes(2);
    expect(expireCancellationFeedback).toHaveBeenCalledWith(
      CANCELLATION_FEEDBACK_EXPIRY_BATCH
    );
  });

  it("runs whatever the switch of the automatic purge says", async () => {
    const expireCancellationFeedback = noneExpired();
    await runPrivacyMaintenance(
      {
        countPurgesHeldBack: noneHeldBack(),
        expireCancellationFeedback,
        finalizeExpiredClosures: vi.fn(() => Promise.resolve(0)),
        recordClosureNotices: nothingToRecord(),
        scheduleClosedOrganizationPurges: nothingToSchedule(),
      },
      off
    );
    expect(expireCancellationFeedback).toHaveBeenCalledTimes(1);
  });
});
