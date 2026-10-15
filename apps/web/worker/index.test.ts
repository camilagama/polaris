import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billingClose: vi.fn(),
  createBillingStore: vi.fn(),
  createMediaCleanupClient: vi.fn(),
  mediaClose: vi.fn(),
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
});
