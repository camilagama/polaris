import type { BillingStore } from "@polaris/db/billing-store";
import { describe, expect, it, vi } from "vitest";
import { runBillingMaintenance } from "./maintenance";

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
