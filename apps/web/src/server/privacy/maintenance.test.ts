import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
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
    Promise.resolve({ scheduled: 0, scheduledLastDay: 0 })
  );

describe("the closure sweep", () => {
  it("asks once and stops when nothing was due", async () => {
    const finalizeExpiredClosures = vi.fn(() => Promise.resolve(0));
    await expect(
      runPrivacyMaintenance(
        {
          finalizeExpiredClosures,
          scheduleClosedOrganizationPurges: nothingToSchedule(),
        },
        off
      )
    ).resolves.toEqual({
      closedOrganizations: 0,
      purgeSchedulingEnabled: false,
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
        finalizeExpiredClosures,
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
        finalizeExpiredClosures,
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
          finalizeExpiredClosures: () => Promise.reject(new Error("db_down")),
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
        finalizeExpiredClosures: () => Promise.resolve(0),
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
          scheduled: number;
          scheduledLastDay: number;
        }>
      >()
      .mockImplementationOnce(() => {
        calls.push("schedule");
        return Promise.resolve({
          scheduled: CLOSURE_SWEEP_BATCH,
          scheduledLastDay: CLOSURE_SWEEP_BATCH,
        });
      })
      .mockImplementationOnce(() => {
        calls.push("schedule");
        return Promise.resolve({
          scheduled: 2,
          scheduledLastDay: CLOSURE_SWEEP_BATCH + 2,
        });
      });
    const report = await runPrivacyMaintenance(
      { finalizeExpiredClosures, scheduleClosedOrganizationPurges },
      on
    );
    expect(calls).toEqual(["close", "schedule", "schedule"]);
    expect(scheduleClosedOrganizationPurges).toHaveBeenCalledWith(
      CLOSURE_SWEEP_BATCH
    );
    expect(report).toEqual({
      closedOrganizations: 3,
      purgeSchedulingEnabled: true,
      scheduledPurges: CLOSURE_SWEEP_BATCH + 2,
      scheduledPurgesLastDay: CLOSURE_SWEEP_BATCH + 2,
    });
  });

  it("is bounded like the closure sweep", async () => {
    const scheduleClosedOrganizationPurges = vi.fn(() =>
      Promise.resolve({
        scheduled: CLOSURE_SWEEP_BATCH,
        scheduledLastDay: CLOSURE_SWEEP_BATCH,
      })
    );
    await runPrivacyMaintenance(
      {
        finalizeExpiredClosures: () => Promise.resolve(0),
        scheduleClosedOrganizationPurges,
      },
      on
    );
    expect(scheduleClosedOrganizationPurges).toHaveBeenCalledTimes(
      CLOSURE_SWEEP_MAX_BATCHES
    );
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
      closedOrganizations: 0,
      purgeSchedulingEnabled: true,
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
