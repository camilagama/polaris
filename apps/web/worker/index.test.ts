import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billingClose: vi.fn(),
  createBillingStore: vi.fn(),
  createMediaCleanupClient: vi.fn(),
  createPrivacyMaintenanceClient: vi.fn(),
  mediaClose: vi.fn(),
  privacyClose: vi.fn(),
  runDataExports: vi.fn(),
  runPrivacyMaintenance: vi.fn(),
  reconcileRemovedMedia: vi.fn(),
  reconcileStagedMedia: vi.fn(),
  runBillingMaintenance: vi.fn(),
}));

vi.mock("@polaris/db/billing-store", () => ({
  createBillingStore: mocks.createBillingStore,
}));
vi.mock("@polaris/db/media-cleanup", () => ({
  createMediaCleanupClient: mocks.createMediaCleanupClient,
}));
vi.mock("@polaris/db/privacy-maintenance", () => ({
  createPrivacyMaintenanceClient: mocks.createPrivacyMaintenanceClient,
}));
vi.mock("../src/server/privacy/data-export-job", () => ({
  runDataExports: mocks.runDataExports,
}));
vi.mock("../src/server/privacy/data-export-reader", () => ({
  createRequesterReader: vi.fn(),
}));
vi.mock("../src/server/privacy/maintenance", () => ({
  runPrivacyMaintenance: mocks.runPrivacyMaintenance,
}));
vi.mock("../src/server/app", () => ({ app: { fetch: vi.fn() } }));
vi.mock("../src/server/media-reconciler", () => ({
  reconcileRemovedMedia: mocks.reconcileRemovedMedia,
  reconcileStagedMedia: mocks.reconcileStagedMedia,
}));
vi.mock("../src/server/billing/maintenance", () => ({
  runBillingMaintenance: mocks.runBillingMaintenance,
}));

const { default: worker } = await import("./index");

const configured = {
  BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
  MEDIA_BUCKET: {},
  MEDIA_CLEANUP_HYPERDRIVE: {
    connectionString: "postgresql://cleanup.invalid/db",
  },
};

function runScheduled(env: Record<string, unknown>) {
  return worker.scheduled({} as ScheduledController, env as never);
}

describe("the scheduled maintenance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.createMediaCleanupClient.mockReturnValue({ close: mocks.mediaClose });
    mocks.mediaClose.mockResolvedValue(undefined);
    mocks.createBillingStore.mockReturnValue({ close: mocks.billingClose });
    mocks.billingClose.mockResolvedValue(undefined);
    mocks.reconcileStagedMedia.mockResolvedValue({});
    mocks.reconcileRemovedMedia.mockResolvedValue({});
    mocks.runBillingMaintenance.mockResolvedValue({});
    mocks.createPrivacyMaintenanceClient.mockReturnValue({
      close: mocks.privacyClose,
    });
    mocks.privacyClose.mockResolvedValue(undefined);
    mocks.runPrivacyMaintenance.mockResolvedValue({ closedOrganizations: 0 });
    mocks.runDataExports.mockResolvedValue({
      deleted: 0,
      expired: 0,
      failed: 0,
      ready: 0,
    });
  });

  it("runs media and billing and finishes quietly when both succeed", async () => {
    await expect(runScheduled(configured)).resolves.toBeUndefined();

    expect(mocks.reconcileStagedMedia).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileRemovedMedia).toHaveBeenCalledTimes(1);
    expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.mediaClose).toHaveBeenCalledTimes(1);
    expect(mocks.billingClose).toHaveBeenCalledTimes(1);
  });

  it("still runs billing when media is not configured, and reports the media failure", async () => {
    await expect(
      runScheduled({ BILLING_HYPERDRIVE: configured.BILLING_HYPERDRIVE })
    ).rejects.toThrow("media_staging_reconciler_not_configured");

    expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
  });

  it("still runs billing when media cannot even open its connection", async () => {
    mocks.createMediaCleanupClient.mockImplementation(() => {
      throw new Error("media_connection_failed");
    });

    await expect(runScheduled(configured)).rejects.toThrow(
      "media_connection_failed"
    );
    expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
  });

  it("skips billing, without failing, where it is not provisioned", async () => {
    await expect(
      runScheduled({
        MEDIA_BUCKET: configured.MEDIA_BUCKET,
        MEDIA_CLEANUP_HYPERDRIVE: configured.MEDIA_CLEANUP_HYPERDRIVE,
      })
    ).resolves.toBeUndefined();

    expect(mocks.createBillingStore).not.toHaveBeenCalled();
    expect(mocks.runBillingMaintenance).not.toHaveBeenCalled();
  });

  it("does not let a connection that fails to close replace what the job found", async () => {
    mocks.runBillingMaintenance.mockRejectedValue(
      new Error("billing_maintenance_incomplete")
    );
    mocks.billingClose.mockRejectedValue(new Error("close_failed"));
    mocks.mediaClose.mockRejectedValue(new Error("close_failed"));

    await expect(runScheduled(configured)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );
  });

  it("reports both failures when media and billing both fail", async () => {
    mocks.reconcileStagedMedia.mockRejectedValue(new Error("staged_failed"));
    mocks.runBillingMaintenance.mockRejectedValue(new Error("billing_failed"));

    const error = await runScheduled(configured).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.map((entry: Error) => entry.message)
    ).toEqual(["staged_failed", "billing_failed"]);
    // the removed-media reconciler ran although the staged one failed
    expect(mocks.reconcileRemovedMedia).toHaveBeenCalledTimes(1);
  });

  describe("the privacy job", () => {
    const privacy = {
      PRIVACY_HYPERDRIVE: {
        connectionString: "postgresql://privacy.invalid/db",
      },
    };

    it("marks expired closures as closed and closes its connection", async () => {
      await expect(
        runScheduled({ ...configured, ...privacy })
      ).resolves.toBeUndefined();

      expect(mocks.createPrivacyMaintenanceClient).toHaveBeenCalledWith(
        privacy.PRIVACY_HYPERDRIVE.connectionString
      );
      expect(mocks.runPrivacyMaintenance).toHaveBeenCalledTimes(1);
      expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
    });

    it("is skipped, without failing, where the privacy role is not provisioned", async () => {
      await expect(runScheduled(configured)).resolves.toBeUndefined();

      expect(mocks.createPrivacyMaintenanceClient).not.toHaveBeenCalled();
      expect(mocks.runPrivacyMaintenance).not.toHaveBeenCalled();
    });

    it("reports its failure without stopping media or billing", async () => {
      mocks.runPrivacyMaintenance.mockRejectedValue(
        new Error("privacy_failed")
      );
      mocks.privacyClose.mockRejectedValue(new Error("close_failed"));

      await expect(runScheduled({ ...configured, ...privacy })).rejects.toThrow(
        "privacy_failed"
      );

      expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
      expect(mocks.reconcileStagedMedia).toHaveBeenCalledTimes(1);
    });

    it("builds the data exports on the same connection, with the bucket and the current time", async () => {
      await expect(
        runScheduled({ ...configured, ...privacy })
      ).resolves.toBeUndefined();

      expect(mocks.runDataExports).toHaveBeenCalledTimes(1);
      expect(mocks.runDataExports).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: configured.MEDIA_BUCKET,
          client: expect.objectContaining({ close: mocks.privacyClose }),
        })
      );
      expect(mocks.createPrivacyMaintenanceClient).toHaveBeenCalledTimes(1);
      expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
    });

    it("skips the data exports, without failing, where there is no bucket", async () => {
      await expect(
        runScheduled({
          ...privacy,
          BILLING_HYPERDRIVE: configured.BILLING_HYPERDRIVE,
        })
      ).rejects.toThrow("media_staging_reconciler_not_configured");

      expect(mocks.runDataExports).not.toHaveBeenCalled();
      expect(mocks.runPrivacyMaintenance).toHaveBeenCalledTimes(1);
    });

    it("reports a data export failure without hiding the closures or stopping the rest", async () => {
      mocks.runDataExports.mockRejectedValue(new Error("export_failed"));

      await expect(runScheduled({ ...configured, ...privacy })).rejects.toThrow(
        "export_failed"
      );

      expect(mocks.runPrivacyMaintenance).toHaveBeenCalledTimes(1);
      expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
      expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
    });

    it("still runs the data exports when the closure sweep fails, and reports both", async () => {
      mocks.runPrivacyMaintenance.mockRejectedValue(new Error("sweep_failed"));
      mocks.runDataExports.mockRejectedValue(new Error("export_failed"));

      const error = await runScheduled({ ...configured, ...privacy }).catch(
        (cause: unknown) => cause
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(
        (error as AggregateError).errors.map((entry: Error) => entry.message)
      ).toEqual(["sweep_failed", "export_failed"]);
    });

    it("reports a connection that cannot be opened", async () => {
      mocks.createPrivacyMaintenanceClient.mockImplementation(() => {
        throw new Error("privacy_connection_failed");
      });

      await expect(runScheduled({ ...configured, ...privacy })).rejects.toThrow(
        "privacy_connection_failed"
      );
      expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(1);
    });
  });
});
