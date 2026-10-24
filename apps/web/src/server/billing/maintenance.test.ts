import { ProviderNotFoundError } from "@polaris/billing/provider-port";
import type { BillingStore } from "@polaris/db/billing-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runBillingMaintenance,
  runUnclaimedTrialSettlement,
  runWelcomeNoticeSweep,
  runWooviReconciliation,
  welcomeEmailEnabled,
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

describe("the hourly reconciliation with Woovi", () => {
  const woovi = {
    BETTER_AUTH_BASE_URL: "https://app.example.test",
    WOOVI_APP_ID: "fake",
    WOOVI_BASE_URL: "https://api.woovi-sandbox.com",
  };

  function wooviStore(
    organizations: string[],
    readProviderLink: (organizationId: string) => Promise<null> = () =>
      Promise.resolve(null)
  ) {
    return {
      listReconcilableOrganizations: vi.fn(() =>
        Promise.resolve(organizations)
      ),
      processEvent: vi.fn(),
      readProviderLink: vi.fn(readProviderLink),
      recordEvent: vi.fn(),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["WOOVI_APP_ID", "WOOVI_BASE_URL"] as const)(
    "does nothing and says so when %s is missing",
    async (missing) => {
      const warned = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const waiting = wooviStore(["org-1"]);

      const report = await runWooviReconciliation(
        { ...woovi, [missing]: undefined },
        waiting,
        now
      );

      expect(report).toBeNull();
      expect(waiting.listReconcilableOrganizations).not.toHaveBeenCalled();
      expect(waiting.readProviderLink).not.toHaveBeenCalled();
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "billing_woovi_reconcile_not_configured",
        })
      );
    }
  );

  it("asks for the Woovi organizations of one batch plus one, and reads each of them", async () => {
    const waiting = wooviStore(["org-1", "org-2", "org-3"]);

    await expect(runWooviReconciliation(woovi, waiting, now)).resolves.toEqual({
      applied: 0,
      failed: 0,
      notFound: 0,
      organizations: 3,
      truncated: false,
    });

    expect(waiting.listReconcilableOrganizations).toHaveBeenCalledWith(
      "woovi",
      201,
      now
    );
    expect(waiting.readProviderLink.mock.calls).toEqual([
      ["org-1"],
      ["org-2"],
      ["org-3"],
    ]);
  });

  it("reports zeros when nothing is due", async () => {
    const waiting = wooviStore([]);

    await expect(runWooviReconciliation(woovi, waiting, now)).resolves.toEqual({
      applied: 0,
      failed: 0,
      notFound: 0,
      organizations: 0,
      truncated: false,
    });
    expect(waiting.readProviderLink).not.toHaveBeenCalled();
  });

  it("reads every organization even when one fails, then reports itself as incomplete", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const waiting = wooviStore(["org-1", "org-2", "org-3"], (organizationId) =>
      organizationId === "org-2"
        ? Promise.reject(new Error("database down"))
        : Promise.resolve(null)
    );

    await expect(runWooviReconciliation(woovi, waiting, now)).rejects.toThrow(
      "billing_woovi_reconcile_incomplete"
    );

    expect(waiting.readProviderLink).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing_woovi_reconcile_failed" })
    );
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_woovi_reconcile_incomplete",
        failed: 1,
        notFound: 0,
        organizations: 3,
      })
    );
  });

  it("counts an organization Woovi does not know as not found: a warning, never a failure", async () => {
    const warned = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const waiting = wooviStore(["org-1", "org-2", "org-3"], (organizationId) =>
      organizationId === "org-2"
        ? Promise.reject(new ProviderNotFoundError())
        : Promise.resolve(null)
    );

    await expect(runWooviReconciliation(woovi, waiting, now)).resolves.toEqual({
      applied: 0,
      failed: 0,
      notFound: 1,
      organizations: 3,
      truncated: false,
    });

    expect(waiting.readProviderLink).toHaveBeenCalledTimes(3);
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing_woovi_reconcile_not_found" })
    );
  });

  it("still fails the run for another error next to a not found one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waiting = wooviStore(["org-1", "org-2"], (organizationId) =>
      Promise.reject(
        organizationId === "org-1"
          ? new ProviderNotFoundError()
          : new Error("database down")
      )
    );

    await expect(runWooviReconciliation(woovi, waiting, now)).rejects.toThrow(
      "billing_woovi_reconcile_incomplete"
    );
  });

  it("takes only 200 when more are due, marks it truncated and warns", async () => {
    const warned = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const ids = Array.from({ length: 201 }, (_, index) => `org-${index}`);
    const waiting = wooviStore(ids);

    await expect(runWooviReconciliation(woovi, waiting, now)).resolves.toEqual({
      applied: 0,
      failed: 0,
      notFound: 0,
      organizations: 200,
      truncated: true,
    });

    expect(waiting.readProviderLink).toHaveBeenCalledTimes(200);
    expect(waiting.readProviderLink).not.toHaveBeenCalledWith("org-200");
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_woovi_reconcile_truncated",
        truncated: true,
      })
    );
  });
});

describe("the hourly sweep of the welcome (ADR 0104, decision 6)", () => {
  const welcomeStore = () => ({
    recordWelcomeNotices: vi.fn(() =>
      Promise.resolve({ candidates: 2, recorded: 1 })
    ),
  });

  it("is off unless the switch is exactly the text true", () => {
    expect(welcomeEmailEnabled("true")).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", " true", "1"]) {
      expect(welcomeEmailEnabled(value)).toBe(false);
    }
  });

  it("writes nothing with the switch off, so turning it on later sends no late welcome", async () => {
    const fake = welcomeStore();
    expect(await runWelcomeNoticeSweep({}, fake, now)).toBeNull();
    expect(
      await runWelcomeNoticeSweep({ WELCOME_EMAIL_ENABLED: "false" }, fake, now)
    ).toBeNull();
    expect(fake.recordWelcomeNotices).not.toHaveBeenCalled();
  });

  it("records the welcomes with the switch on and reports them", async () => {
    const fake = welcomeStore();
    expect(
      await runWelcomeNoticeSweep({ WELCOME_EMAIL_ENABLED: "true" }, fake, now)
    ).toEqual({ candidates: 2, recorded: 1 });
    expect(fake.recordWelcomeNotices).toHaveBeenCalledWith(now);
  });
});
