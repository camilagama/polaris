import type { BillingStore } from "@polaris/db/billing-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runBillingMaintenance,
  runUnclaimedTrialSettlement,
} from "./maintenance";

const now = new Date("2026-10-14T12:00:00.000Z");

function store(
  retry = { failed: 0, processed: 1, scanned: 1, unresolved: 0 },
  sweep = { failed: 0, scanned: 2, transitioned: 2 }
) {
  const calls: string[] = [];
  const fake = {
    retryPending: vi.fn(() => {
      calls.push("retry");
      return Promise.resolve(retry);
    }),
    sweepDue: vi.fn(() => {
      calls.push("sweep");
      return Promise.resolve(sweep);
    }),
  } as unknown as BillingStore;
  return { calls, store: fake };
}

describe("the hourly billing maintenance", () => {
  it("applies the events that were not applied before the sweep reads the end of a period", async () => {
    const fixture = store();

    const report = await runBillingMaintenance(fixture.store, now);

    // a renewal already confirmed must be on the record before time is applied to it
    expect(fixture.calls).toEqual(["retry", "sweep"]);
    expect(fixture.store.retryPending).toHaveBeenCalledWith(now);
    expect(fixture.store.sweepDue).toHaveBeenCalledWith(now);
    expect(report).toEqual({
      retry: { failed: 0, processed: 1, scanned: 1, unresolved: 0 },
      sweep: { failed: 0, scanned: 2, transitioned: 2 },
    });
  });

  it("reports itself as incomplete when anything failed, after running both parts", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const retryFailed = store(
      { failed: 1, processed: 0, scanned: 1, unresolved: 0 },
      { failed: 0, scanned: 0, transitioned: 0 }
    );
    await expect(runBillingMaintenance(retryFailed.store, now)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );
    // the sweep still ran: one failing never hides the other
    expect(retryFailed.calls).toEqual(["retry", "sweep"]);

    const sweepFailed = store(
      { failed: 0, processed: 0, scanned: 0, unresolved: 0 },
      { failed: 2, scanned: 2, transitioned: 0 }
    );
    await expect(runBillingMaintenance(sweepFailed.store, now)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_maintenance_incomplete",
        sweep: expect.objectContaining({ failed: 2 }),
      })
    );
    logged.mockRestore();
  });

  it("runs the sweep even when the retry pass throws, and the retry pass even when the sweep does", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const retryThrows = store();
    (
      retryThrows.store.retryPending as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("database down"));
    await expect(runBillingMaintenance(retryThrows.store, now)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );
    expect(retryThrows.calls).toEqual(["sweep"]);

    const sweepThrows = store();
    (sweepThrows.store.sweepDue as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("database down")
    );
    await expect(runBillingMaintenance(sweepThrows.store, now)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );
    expect(sweepThrows.calls).toEqual(["retry"]);
    logged.mockRestore();
  });
});

describe("the hourly settling of unclaimed trials", () => {
  const sandbox = {
    ASAAS_API_KEY: "$aact_hmlg_fake",
    ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
    BETTER_AUTH_BASE_URL: "https://app.example.test",
  };

  function trialStore(
    pending: { eventId: string; organizationId: string }[] = []
  ) {
    return {
      listUnclaimedTrials: vi.fn(() =>
        Promise.resolve(
          pending.map((event) => ({
            ...event,
            provider: "asaas",
            providerRef: "ref",
            providerSubscriptionId: null,
          }))
        )
      ),
      settleUnclaimedTrial: vi.fn(),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["ASAAS_API_KEY", "ASAAS_BASE_URL", "BETTER_AUTH_BASE_URL"] as const)(
    "does nothing and says so when %s is missing",
    async (missing) => {
      const warned = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const waiting = trialStore();

      const report = await runUnclaimedTrialSettlement(
        { ...sandbox, [missing]: undefined },
        waiting,
        now
      );

      expect(report).toBeNull();
      expect(waiting.listUnclaimedTrials).not.toHaveBeenCalled();
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "billing_unclaimed_trials_not_configured",
        })
      );
    }
  );

  it("reports zeros when no trial is waiting", async () => {
    const waiting = trialStore();

    await expect(
      runUnclaimedTrialSettlement(sandbox, waiting, now)
    ).resolves.toEqual({ cancelled: 0, failed: 0, leftPaid: 0, scanned: 0 });
    expect(waiting.listUnclaimedTrials).toHaveBeenCalledTimes(1);
  });

  it("settles what waits and reports it", async () => {
    const waiting = trialStore([{ eventId: "e1", organizationId: "org-1" }]);
    waiting.settleUnclaimedTrial.mockResolvedValue("cancelled");
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      runUnclaimedTrialSettlement(sandbox, waiting, now)
    ).resolves.toEqual({ cancelled: 1, failed: 0, leftPaid: 0, scanned: 1 });
    expect(waiting.settleUnclaimedTrial).toHaveBeenCalledWith(
      "e1",
      expect.any(Function),
      now
    );
  });

  it("reports itself as incomplete when one trial failed, after trying the others", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const waiting = trialStore([
      { eventId: "e1", organizationId: "org-1" },
      { eventId: "e2", organizationId: "org-2" },
    ]);
    waiting.settleUnclaimedTrial
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce("cancelled");

    await expect(
      runUnclaimedTrialSettlement(sandbox, waiting, now)
    ).rejects.toThrow("billing_unclaimed_trials_incomplete");

    expect(waiting.settleUnclaimedTrial).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_unclaimed_trials_incomplete",
        failed: 1,
      })
    );
  });
});
