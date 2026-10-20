import type { ScheduledJobClaim } from "@polaris/db/outbox-dispatch";
import {
  jobsOfLane,
  SCHEDULED_JOBS,
  type ScheduledJobId,
  windowIndex,
} from "@polaris/domain/scheduling/scheduled-jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type JobHandler,
  type JobHandlers,
  runLane,
  type SchedulerStore,
} from "./runner";

/** What the database functions do, in memory: due once per window, a lease with a token, fenced outcomes. */
function memoryStore(clock: { now: Date }) {
  interface Row {
    coveredAt: Date | null;
    failures: number;
    leaseUntil: Date | null;
    startedAt: Date | null;
    token: string | null;
  }
  const rows = new Map<string, Row>();
  let counter = 0;
  const calls: string[] = [];
  const store: SchedulerStore = {
    claimScheduledJob(jobId, cadenceSeconds, leaseSeconds) {
      calls.push(`claim:${jobId}`);
      const row = rows.get(jobId) ?? {
        coveredAt: null,
        failures: 0,
        leaseUntil: null,
        startedAt: null,
        token: null,
      };
      rows.set(jobId, row);
      if (row.leaseUntil && row.leaseUntil > clock.now) {
        return Promise.resolve<ScheduledJobClaim>({ result: "busy" });
      }
      if (
        row.coveredAt &&
        windowIndex(row.coveredAt, cadenceSeconds) >=
          windowIndex(clock.now, cadenceSeconds)
      ) {
        return Promise.resolve<ScheduledJobClaim>({ result: "not_due" });
      }
      const recovered = row.token !== null;
      counter += 1;
      row.token = `token-${counter}`;
      row.startedAt = clock.now;
      row.leaseUntil = new Date(clock.now.getTime() + leaseSeconds * 1000);
      const missedWindows = row.coveredAt
        ? Math.max(
            0,
            windowIndex(clock.now, cadenceSeconds) -
              windowIndex(row.coveredAt, cadenceSeconds) -
              1
          )
        : 0;
      return Promise.resolve<ScheduledJobClaim>({
        missedWindows,
        recovered,
        result: "claimed",
        token: row.token,
      });
    },
    completeScheduledJob(jobId, token) {
      calls.push(`complete:${jobId}`);
      const row = rows.get(jobId);
      if (!row || row.token !== token) {
        return Promise.resolve(false);
      }
      row.coveredAt = row.startedAt;
      row.failures = 0;
      row.leaseUntil = null;
      row.token = null;
      return Promise.resolve(true);
    },
    releaseScheduledJob(jobId, token, outcome) {
      calls.push(`release:${jobId}:${outcome}`);
      const row = rows.get(jobId);
      if (!row || row.token !== token) {
        return Promise.resolve(false);
      }
      row.failures += outcome === "failed" ? 1 : 0;
      row.leaseUntil = null;
      row.token = null;
      return Promise.resolve(true);
    },
  };
  return { calls, rows, store };
}

const ok: JobHandler = () => Promise.resolve({ status: "completed" });

function handlersFor(
  lane: "maintenance" | "outbox",
  handler: JobHandler = ok
): JobHandlers {
  return Object.fromEntries(
    jobsOfLane(lane).map((id) => [id, vi.fn(handler)])
  ) as JobHandlers;
}

describe("a scheduler tick", () => {
  let clock: { now: Date };
  beforeEach(() => {
    clock = { now: new Date("2026-10-18T13:17:00Z") };
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const tick = (
    lane: "maintenance" | "outbox",
    handlers: JobHandlers,
    store: SchedulerStore | null
  ) => runLane({ handlers, lane, now: () => clock.now.getTime(), store });

  it("runs the jobs of its lane, in the order of the registry, and nothing of the other lane", async () => {
    const { store } = memoryStore(clock);
    const order: string[] = [];
    const maintenance = Object.fromEntries(
      jobsOfLane("maintenance").map((id) => [
        id,
        (): ReturnType<JobHandler> => {
          order.push(id);
          return Promise.resolve({ status: "completed" });
        },
      ])
    ) as JobHandlers;
    const outbox = handlersFor("outbox");

    await tick("maintenance", { ...maintenance, ...outbox }, store);

    expect(order).toEqual([
      "media.maintenance",
      "billing.maintenance",
      "privacy.maintenance",
      "auth.login_lock_expiry",
    ]);
    expect(outbox["outbox.dispatch"]).not.toHaveBeenCalled();
  });

  it("runs a job once per window, however many ticks the window sees", async () => {
    const { store } = memoryStore(clock);
    const handlers = handlersFor("outbox");
    await tick("outbox", handlers, store);
    clock.now = new Date("2026-10-18T13:49:00Z");
    await tick("outbox", handlers, store);
    expect(handlers["outbox.dispatch"]).toHaveBeenCalledTimes(1);

    clock.now = new Date("2026-10-18T14:19:00Z");
    await tick("outbox", handlers, store);
    expect(handlers["outbox.dispatch"]).toHaveBeenCalledTimes(2);
  });

  it("catches up with one run after a gap, telling it how many windows were missed", async () => {
    const { store } = memoryStore(clock);
    const handlers = handlersFor("outbox");
    await tick("outbox", handlers, store);

    clock.now = new Date("2026-10-18T17:19:00Z");
    await tick("outbox", handlers, store);

    expect(handlers["outbox.dispatch"]).toHaveBeenCalledTimes(2);
    expect(handlers["outbox.dispatch"]).toHaveBeenLastCalledWith({
      missedWindows: 3,
      recovered: false,
    });
    clock.now = new Date("2026-10-18T17:50:00Z");
    await tick("outbox", handlers, store);
    expect(handlers["outbox.dispatch"]).toHaveBeenCalledTimes(2);
  });

  it("does not run a job whose lease another run holds", async () => {
    const { rows, store } = memoryStore(clock);
    const handlers = handlersFor("outbox");
    rows.set("outbox.dispatch", {
      coveredAt: null,
      failures: 0,
      leaseUntil: new Date(clock.now.getTime() + 60_000),
      startedAt: null,
      token: "someone-else",
    });
    await expect(tick("outbox", handlers, store)).resolves.toBeUndefined();
    expect(handlers["outbox.dispatch"]).not.toHaveBeenCalled();
  });

  it("takes over a run that died and says so", async () => {
    const { rows, store } = memoryStore(clock);
    const handlers = handlersFor("outbox");
    rows.set("outbox.dispatch", {
      coveredAt: null,
      failures: 0,
      leaseUntil: new Date(clock.now.getTime() - 1000),
      startedAt: null,
      token: "dead-run",
    });
    await tick("outbox", handlers, store);
    expect(handlers["outbox.dispatch"]).toHaveBeenCalledWith({
      missedWindows: 0,
      recovered: true,
    });
  });

  describe("when a job does not finish well", () => {
    it("gives the lease back as failed, leaves the window open and throws what it found", async () => {
      const { calls, store } = memoryStore(clock);
      const failure = new Error("billing_maintenance_incomplete");
      const handlers = handlersFor("maintenance");
      (
        handlers["billing.maintenance"] as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ failures: [failure], status: "failed" });

      await expect(tick("maintenance", handlers, store)).rejects.toBe(failure);

      expect(calls).toContain("release:billing.maintenance:failed");
      expect(calls).not.toContain("complete:billing.maintenance");
      // the others were not stopped by it
      expect(handlers["privacy.maintenance"]).toHaveBeenCalledOnce();
      expect(calls).toContain("complete:privacy.maintenance");

      clock.now = new Date("2026-10-18T13:47:00Z");
      await expect(tick("maintenance", handlers, store)).rejects.toBe(failure);
      expect(handlers["billing.maintenance"]).toHaveBeenCalledTimes(2);
      expect(handlers["media.maintenance"]).toHaveBeenCalledTimes(1);
    });

    it("treats a job that throws as a failed job, not as a failed tick", async () => {
      const { calls, store } = memoryStore(clock);
      const handlers = handlersFor("maintenance");
      const boom = new Error("boom");
      (
        handlers["media.maintenance"] as ReturnType<typeof vi.fn>
      ).mockRejectedValue(boom);

      await expect(tick("maintenance", handlers, store)).rejects.toBe(boom);

      expect(calls).toContain("release:media.maintenance:failed");
      expect(handlers["billing.maintenance"]).toHaveBeenCalledOnce();
      expect(handlers["privacy.maintenance"]).toHaveBeenCalledOnce();
    });

    it("throws several failures together", async () => {
      const { store } = memoryStore(clock);
      const handlers = handlersFor("maintenance", () =>
        Promise.resolve({ failures: [new Error("one")], status: "failed" })
      );
      await expect(tick("maintenance", handlers, store)).rejects.toThrow(
        "scheduled_jobs_failed"
      );
    });

    it("does not cover the window of a job that had nothing to do here, and does not count it", async () => {
      const { calls, store } = memoryStore(clock);
      const handlers = handlersFor("outbox", () =>
        Promise.resolve({ reason: "not_configured", status: "skipped" })
      );
      await expect(tick("outbox", handlers, store)).resolves.toBeUndefined();
      expect(calls).toContain("release:outbox.dispatch:skipped");

      clock.now = new Date("2026-10-18T13:47:00Z");
      await tick("outbox", handlers, store);
      expect(handlers["outbox.dispatch"]).toHaveBeenCalledTimes(2);
    });
  });

  describe("when the state of the scheduler cannot be used", () => {
    it("fails the job, runs nothing unguarded, and still tries the next job", async () => {
      const { store } = memoryStore(clock);
      const lost = new Error("connection refused");
      const claim = vi
        .spyOn(store, "claimScheduledJob")
        .mockRejectedValueOnce(lost);
      const handlers = handlersFor("maintenance");

      await expect(tick("maintenance", handlers, store)).rejects.toBe(lost);

      expect(claim).toHaveBeenCalledTimes(4);
      expect(handlers["media.maintenance"]).not.toHaveBeenCalled();
      expect(handlers["billing.maintenance"]).toHaveBeenCalledOnce();
    });

    it("fails the tick when a successful run could not be recorded, so the cron shows it", async () => {
      const { store } = memoryStore(clock);
      vi.spyOn(store, "completeScheduledJob").mockRejectedValue(
        new Error("write failed")
      );
      await expect(
        tick("outbox", handlersFor("outbox"), store)
      ).rejects.toThrow("write failed");
    });

    it("warns, without failing, when the run took longer than its lease and another took over", async () => {
      const { store } = memoryStore(clock);
      vi.spyOn(store, "completeScheduledJob").mockResolvedValue(false);
      await expect(
        tick("outbox", handlersFor("outbox"), store)
      ).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scheduled_job_lease_lost",
          job: "outbox.dispatch",
        })
      );
    });
  });

  describe("without a state store (not provisioned, or local development)", () => {
    it("runs every job of the lane on every tick, as the crons did before the scheduler", async () => {
      const handlers = handlersFor("maintenance");
      await tick("maintenance", handlers, null);
      await tick("maintenance", handlers, null);
      for (const id of jobsOfLane("maintenance")) {
        expect(handlers[id]).toHaveBeenCalledTimes(2);
      }
      expect(console.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scheduler_state_unavailable",
          lane: "maintenance",
        })
      );
    });

    it("still throws a failure and treats a throw as one", async () => {
      const handlers = handlersFor("outbox");
      (
        handlers["outbox.dispatch"] as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("dispatch_failed"));
      await expect(tick("outbox", handlers, null)).rejects.toThrow(
        "dispatch_failed"
      );
    });
  });

  it("reports a job of the lane that has no handler as a failure, and runs the others", async () => {
    const { store } = memoryStore(clock);
    const { "billing.maintenance": _missing, ...handlers } =
      handlersFor("maintenance");
    await expect(tick("maintenance", handlers, store)).rejects.toThrow(
      "scheduled_job_handler_missing"
    );
    expect(handlers["privacy.maintenance"]).toHaveBeenCalledOnce();
  });

  it("never runs a disabled job, even if someone gives it a handler", async () => {
    const { calls, store } = memoryStore(clock);
    const sneaky = vi.fn(ok);
    const handlers = {
      ...handlersFor("maintenance"),
      ...handlersFor("outbox"),
      "billing.provider_reconcile": sneaky,
      "expenses.recurring_generation": sneaky,
    } satisfies JobHandlers;
    await tick("maintenance", handlers, store);
    await tick("outbox", handlers, store);
    expect(sneaky).not.toHaveBeenCalled();
    expect(calls.join(" ")).not.toContain("provider_reconcile");
    expect(calls.join(" ")).not.toContain("recurring_generation");
    expect(
      SCHEDULED_JOBS.filter((job) => job.status === "disabled")
    ).toHaveLength(2);
  });

  describe("what it logs", () => {
    it("records one metric line per job with its name, outcome, duration and windows, and nothing personal", async () => {
      const { store } = memoryStore(clock);
      const handlers = handlersFor("outbox", () => {
        clock.now = new Date(clock.now.getTime() + 250);
        return Promise.resolve({ status: "completed" });
      });
      await tick("outbox", handlers, store);
      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: 250,
          event: "scheduled_job_run",
          job: "outbox.dispatch",
          lane: "outbox",
          missedWindows: 0,
          outcome: "success",
          recovered: false,
        })
      );
    });

    it("closes a skipped run with the skipped outcome and its reason", async () => {
      const { store } = memoryStore(clock);
      const handlers = handlersFor("outbox", () =>
        Promise.resolve({ reason: "not_configured", status: "skipped" })
      );
      await tick("outbox", handlers, store);
      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: 0,
          event: "scheduled_job_run",
          outcome: "skipped",
          reason: "not_configured",
        })
      );
    });

    it("tags the lines of a lease that was not taken with the canonical outcome", async () => {
      const { store } = memoryStore(clock);
      vi.spyOn(store, "claimScheduledJob").mockRejectedValueOnce(
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })
      );
      await expect(
        tick("outbox", handlersFor("outbox"), store)
      ).rejects.toThrow("connection refused");
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorClass: "Error",
          errorCode: "ECONNREFUSED",
          event: "scheduled_job_claim_failed",
          outcome: "failure",
        })
      );

      await tick("outbox", handlersFor("outbox"), store);
      await tick("outbox", handlersFor("outbox"), store);
      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scheduled_job_skipped",
          outcome: "skipped",
          reason: "not_due",
        })
      );
    });

    it("names a failure by its class and code only, never its message", async () => {
      const { store } = memoryStore(clock);
      const secret = Object.assign(
        new Error("cliente Maria Souza, 11 99999-0000, falhou"),
        { code: "23505" }
      );
      const handlers = handlersFor("outbox", () =>
        Promise.resolve({ failures: [secret], status: "failed" })
      );
      await expect(tick("outbox", handlers, store)).rejects.toBe(secret);
      const logged = JSON.stringify([
        vi.mocked(console.info).mock.calls,
        vi.mocked(console.warn).mock.calls,
        vi.mocked(console.error).mock.calls,
      ]);
      expect(logged).not.toContain("Maria");
      expect(logged).not.toContain("99999");
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorClass: "Error",
          errorCode: "23505",
          event: "scheduled_job_run",
          job: "outbox.dispatch",
          outcome: "failure",
        })
      );
    });
  });
});

describe("the jobs of the registry", () => {
  it("are all handled by a lane the runner knows", () => {
    const ids: ScheduledJobId[] = SCHEDULED_JOBS.flatMap((job) =>
      job.status === "enabled" ? [job.id] : []
    );
    expect(ids.sort()).toEqual(
      [...jobsOfLane("maintenance"), ...jobsOfLane("outbox")].sort()
    );
  });
});
