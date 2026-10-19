import { existsSync, readdirSync, readFileSync } from "node:fs";
import { SCHEDULER_LANES } from "@polaris/domain/scheduling/scheduled-jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billingClose: vi.fn(),
  createAuthLoginLockMaintenanceClient: vi.fn(),
  createBillingStore: vi.fn(),
  createMediaCleanupClient: vi.fn(),
  createOutboxClient: vi.fn(),
  createPrivacyMaintenanceClient: vi.fn(),
  dispatchOutbox: vi.fn(),
  loginLockClose: vi.fn(),
  loginLockExpire: vi.fn(),
  mediaClose: vi.fn(),
  outboxClose: vi.fn(),
  privacyClose: vi.fn(),
  reconcileRemovedMedia: vi.fn(),
  reconcileStagedMedia: vi.fn(),
  runBillingMaintenance: vi.fn(),
  runDataExports: vi.fn(),
  runOrganizationPurges: vi.fn(),
  runPrivacyMaintenance: vi.fn(),
}));

vi.mock("@polaris/db/auth-login-lock-maintenance", () => ({
  createAuthLoginLockMaintenanceClient:
    mocks.createAuthLoginLockMaintenanceClient,
}));
vi.mock("@polaris/db/billing-store", () => ({
  createBillingStore: mocks.createBillingStore,
}));
vi.mock("@polaris/db/media-cleanup", () => ({
  createMediaCleanupClient: mocks.createMediaCleanupClient,
}));
vi.mock("@polaris/db/outbox-dispatch", () => ({
  createOutboxClient: mocks.createOutboxClient,
}));
vi.mock("../src/server/queue/dispatcher", () => ({
  dispatchOutbox: mocks.dispatchOutbox,
}));
vi.mock("@polaris/db/privacy-maintenance", () => ({
  createPrivacyMaintenanceClient: mocks.createPrivacyMaintenanceClient,
}));
vi.mock("../src/server/privacy/data-export-job", () => ({
  runDataExports: mocks.runDataExports,
}));
vi.mock("../src/server/privacy/organization-purge-job", () => ({
  runOrganizationPurges: mocks.runOrganizationPurges,
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

/** The scheduler's state as the database gives it: every job due, every lease free. */
function schedulerState() {
  return {
    claimScheduledJob: vi.fn().mockResolvedValue({
      missedWindows: 0,
      recovered: false,
      result: "claimed",
      token: "lease-token",
    }),
    completeScheduledJob: vi.fn().mockResolvedValue(true),
    releaseScheduledJob: vi.fn().mockResolvedValue(true),
  };
}

function runScheduled(env: Record<string, unknown>) {
  return worker.scheduled({} as ScheduledController, env as never);
}

describe("the scheduled maintenance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.createOutboxClient.mockReturnValue({
      ...schedulerState(),
      close: mocks.outboxClose.mockResolvedValue(undefined),
    });
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
    mocks.runOrganizationPurges.mockResolvedValue({
      failed: 0,
      purged: 0,
      swept: 0,
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

  it("masks personal data and secrets in a job report that grew a field, through the real logger", async () => {
    // a report spread into the log (`{ ...report }`) carries whatever it grows
    mocks.reconcileStagedMedia.mockResolvedValue({
      removed: 2,
      customerEmail: "maria@example.com",
      detail: {
        lines: ["cliente 123.456.789-09", { note: "ligar 11 98888-7777" }],
      },
      note: "de 203.0.113.9 com Bearer abcdef0123456789",
      sessionToken: "s3cr3t-value",
      cause: new Error("falhou para joao@example.com", {
        cause: { password: "hunter2" },
      }),
    });

    await expect(runScheduled(configured)).resolves.toBeUndefined();

    const event = vi
      .mocked(console.info)
      .mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .find((entry) => entry.event === "media_staging_reconciliation_complete");
    expect(event).toMatchObject({ removed: 2, service: "polaris-web" });
    const json = JSON.stringify(event);
    for (const secret of [
      "maria@example.com",
      "joao@example.com",
      "123.456.789-09",
      "98888-7777",
      "203.0.113.9",
      "abcdef0123456789",
      "s3cr3t-value",
      "hunter2",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain("[REDACTED:");
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
      expect(mocks.runOrganizationPurges).not.toHaveBeenCalled();
      expect(mocks.runPrivacyMaintenance).toHaveBeenCalledTimes(1);
    });

    it("runs the scheduled purges on the same connection, after the exports, with the bucket", async () => {
      await expect(
        runScheduled({ ...configured, ...privacy })
      ).resolves.toBeUndefined();

      expect(mocks.runOrganizationPurges).toHaveBeenCalledTimes(1);
      expect(mocks.runOrganizationPurges).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: configured.MEDIA_BUCKET,
          client: expect.objectContaining({ close: mocks.privacyClose }),
        })
      );
      expect(
        mocks.runDataExports.mock.invocationCallOrder[0] ?? 0
      ).toBeLessThan(
        mocks.runOrganizationPurges.mock.invocationCallOrder[0] ?? 0
      );
      expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
    });

    it("still runs the purges when the exports fail, and reports both failures", async () => {
      mocks.runDataExports.mockRejectedValue(new Error("export_failed"));
      mocks.runOrganizationPurges.mockRejectedValue(new Error("purge_failed"));

      const error = await runScheduled({ ...configured, ...privacy }).catch(
        (cause: unknown) => cause
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(
        (error as AggregateError).errors.map((entry: Error) => entry.message)
      ).toEqual(["export_failed", "purge_failed"]);
      expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
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

    describe("with the queue path live", () => {
      const live = {
        ...configured,
        ...privacy,
        OUTBOX_HYPERDRIVE: {
          connectionString: "postgresql://outbox.invalid/db",
        },
        QUEUE_DEFAULT: { sendBatch: vi.fn() },
      };

      it("re-arms the export events and only sweeps, leaving the build to the consumer", async () => {
        const rearm = vi.fn().mockResolvedValue(0);
        mocks.createPrivacyMaintenanceClient.mockReturnValue({
          close: mocks.privacyClose,
          rearmDataExportEvents: rearm,
        });

        await expect(runScheduled(live)).resolves.toBeUndefined();

        expect(rearm).toHaveBeenCalledOnce();
        expect(rearm).toHaveBeenCalledWith(1800, 100);
        expect(mocks.runDataExports).toHaveBeenCalledOnce();
        expect(mocks.runDataExports).toHaveBeenCalledWith(
          expect.objectContaining({ maxExports: 0 })
        );
      });

      it("reports a failed re-arm without stopping the sweep", async () => {
        mocks.createPrivacyMaintenanceClient.mockReturnValue({
          close: mocks.privacyClose,
          rearmDataExportEvents: vi
            .fn()
            .mockRejectedValue(new Error("rearm_failed")),
        });

        await expect(runScheduled(live)).rejects.toThrow("rearm_failed");

        expect(mocks.runDataExports).toHaveBeenCalledOnce();
        expect(mocks.privacyClose).toHaveBeenCalledOnce();
      });
    });

    it.each([
      ["the outbox role", { QUEUE_DEFAULT: { sendBatch: vi.fn() } }],
      [
        "the default queue",
        {
          OUTBOX_HYPERDRIVE: { connectionString: "postgresql://o.invalid/db" },
        },
      ],
    ])(
      "builds as before, with no re-arm, when %s is missing",
      async (_name, extra) => {
        const rearm = vi.fn();
        mocks.createPrivacyMaintenanceClient.mockReturnValue({
          close: mocks.privacyClose,
          rearmDataExportEvents: rearm,
        });

        await expect(
          runScheduled({ ...configured, ...privacy, ...extra })
        ).resolves.toBeUndefined();

        expect(rearm).not.toHaveBeenCalled();
        const [options] = mocks.runDataExports.mock.calls[0] ?? [];
        expect(options).not.toHaveProperty("maxExports");
      }
    );

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

describe("the outbox cron", () => {
  const outbox = {
    OUTBOX_HYPERDRIVE: { connectionString: "postgresql://outbox.invalid/db" },
  };
  const OUTBOX_CRON = "19 * * * *";
  const everything = {
    ...configured,
    ...outbox,
    PRIVACY_HYPERDRIVE: { connectionString: "postgresql://privacy.invalid/db" },
  };
  let client: ReturnType<typeof schedulerState> & {
    close: ReturnType<typeof vi.fn>;
    expireProcessing: ReturnType<typeof vi.fn>;
    recordExhaustedOutboxEvents: ReturnType<typeof vi.fn>;
  };

  const runCron = (cron: string | undefined, env: Record<string, unknown>) =>
    worker.scheduled(
      (cron === undefined ? {} : { cron }) as ScheduledController,
      env as never
    );

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    client = {
      ...schedulerState(),
      close: mocks.outboxClose.mockResolvedValue(undefined),
      expireProcessing: vi.fn().mockResolvedValue(0),
      recordExhaustedOutboxEvents: vi.fn().mockResolvedValue(0),
    };
    mocks.createOutboxClient.mockReturnValue(client);
    mocks.dispatchOutbox.mockResolvedValue({ claimed: 0 });
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
    mocks.runPrivacyMaintenance.mockResolvedValue({});
    mocks.runDataExports.mockResolvedValue({});
  });

  it("runs only the dispatcher and the expiry of the processing records, and closes its connection", async () => {
    await expect(runCron(OUTBOX_CRON, everything)).resolves.toBeUndefined();

    expect(mocks.createOutboxClient).toHaveBeenCalledWith(
      outbox.OUTBOX_HYPERDRIVE.connectionString
    );
    expect(mocks.dispatchOutbox).toHaveBeenCalledOnce();
    expect(mocks.dispatchOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ store: client })
    );
    expect(client.expireProcessing).toHaveBeenCalledOnce();
    expect(client.expireProcessing).toHaveBeenCalledWith(168, 500);
    expect(mocks.outboxClose).toHaveBeenCalledOnce();
    expect(mocks.reconcileStagedMedia).not.toHaveBeenCalled();
    expect(mocks.runBillingMaintenance).not.toHaveBeenCalled();
    expect(mocks.runPrivacyMaintenance).not.toHaveBeenCalled();
    expect(mocks.runDataExports).not.toHaveBeenCalled();
  });

  it("hands the dispatcher the queues that are bound", async () => {
    const queues = {
      QUEUE_CRITICAL: { sendBatch: vi.fn() },
      QUEUE_DEFAULT: { sendBatch: vi.fn() },
      QUEUE_MEDIA: { sendBatch: vi.fn() },
    };
    await runCron(OUTBOX_CRON, { ...outbox, ...queues });
    expect(mocks.dispatchOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        queues: {
          critical: queues.QUEUE_CRITICAL,
          default: queues.QUEUE_DEFAULT,
          media: queues.QUEUE_MEDIA,
        },
      })
    );
  });

  it("warns and finishes where the outbox role is not provisioned", async () => {
    await expect(runCron(OUTBOX_CRON, {})).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "outbox_dispatch_not_configured" })
    );
    expect(mocks.createOutboxClient).not.toHaveBeenCalled();
    expect(mocks.dispatchOutbox).not.toHaveBeenCalled();
  });

  it("throws a dispatch failure, but still expires the records and closes", async () => {
    mocks.dispatchOutbox.mockRejectedValue(new Error("dispatch_failed"));

    await expect(runCron(OUTBOX_CRON, outbox)).rejects.toThrow(
      "dispatch_failed"
    );

    expect(client.expireProcessing).toHaveBeenCalledOnce();
    expect(mocks.outboxClose).toHaveBeenCalledOnce();
  });

  it("records the events past the attempt cap after the dispatcher, 100 at a time, and warns only when some were new", async () => {
    const order: string[] = [];
    mocks.dispatchOutbox.mockImplementation(() => {
      order.push("dispatch");
      return Promise.resolve({ claimed: 0 });
    });
    client.recordExhaustedOutboxEvents.mockImplementation(() => {
      order.push("exhausted");
      return Promise.resolve(0);
    });
    client.expireProcessing.mockImplementation(() => {
      order.push("expire");
      return Promise.resolve(0);
    });

    await expect(runCron(OUTBOX_CRON, outbox)).resolves.toBeUndefined();

    expect(client.recordExhaustedOutboxEvents).toHaveBeenCalledOnce();
    expect(client.recordExhaustedOutboxEvents).toHaveBeenCalledWith(100);
    expect(order).toEqual(["dispatch", "exhausted", "expire"]);
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "outbox_events_exhausted" })
    );

    client.recordExhaustedOutboxEvents.mockResolvedValue(3);
    await runCron(OUTBOX_CRON, outbox);
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "outbox_events_exhausted", recorded: 3 })
    );
  });

  it("still expires the records, and closes, when recording the exhausted events fails, and throws that failure", async () => {
    client.recordExhaustedOutboxEvents.mockRejectedValue(
      new Error("exhausted_failed")
    );

    await expect(runCron(OUTBOX_CRON, outbox)).rejects.toThrow(
      "exhausted_failed"
    );

    expect(client.expireProcessing).toHaveBeenCalledOnce();
    expect(mocks.outboxClose).toHaveBeenCalledOnce();
  });

  it("throws the dispatch and the exhausted-events failures together", async () => {
    mocks.dispatchOutbox.mockRejectedValue(new Error("dispatch_failed"));
    client.recordExhaustedOutboxEvents.mockRejectedValue(
      new Error("exhausted_failed")
    );

    const error = await runCron(OUTBOX_CRON, outbox).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.map((entry: Error) => entry.message)
    ).toEqual(["dispatch_failed", "exhausted_failed"]);
    expect(client.expireProcessing).toHaveBeenCalledOnce();
  });

  it("reports a connection that cannot be opened", async () => {
    mocks.createOutboxClient.mockImplementation(() => {
      throw new Error("outbox_connection_failed");
    });

    await expect(runCron(OUTBOX_CRON, outbox)).rejects.toThrow(
      "outbox_connection_failed"
    );
    expect(mocks.dispatchOutbox).not.toHaveBeenCalled();
  });

  it.each([
    ["the hourly cron", "17 * * * *"],
    ["no cron at all", undefined],
  ])(
    "runs the maintenance as before, not the dispatcher, on %s",
    async (_name, cron) => {
      await expect(runCron(cron, everything)).resolves.toBeUndefined();

      expect(mocks.reconcileStagedMedia).toHaveBeenCalledOnce();
      expect(mocks.runBillingMaintenance).toHaveBeenCalledOnce();
      expect(mocks.runPrivacyMaintenance).toHaveBeenCalledOnce();
      expect(mocks.dispatchOutbox).not.toHaveBeenCalled();
      expect(client.expireProcessing).not.toHaveBeenCalled();
    }
  );
});

describe("the queue consumer", () => {
  const privacy = {
    PRIVACY_HYPERDRIVE: { connectionString: "postgresql://privacy.invalid/db" },
  };
  const exportEvent = {
    attempt: 1,
    correlationId: "req-1",
    event: { exportId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" },
    eventId: "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c",
    idempotencyKey:
      "data_export.requested:0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
    organizationId: "org_1",
    type: "data_export.requested",
    version: 1,
  };

  function message(body: unknown) {
    return { ack: vi.fn(), attempts: 1, body, id: "m", retry: vi.fn() };
  }

  function runQueue(env: Record<string, unknown>, ...sent: unknown[]) {
    return worker.queue(
      { messages: sent, queue: "polaris-default" } as never,
      env as never
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createPrivacyMaintenanceClient.mockReturnValue({
      close: mocks.privacyClose,
    });
    mocks.privacyClose.mockResolvedValue(undefined);
    mocks.runDataExports.mockResolvedValue({
      deleted: 0,
      expired: 0,
      failed: 0,
      ready: 1,
    });
  });

  it("runs the data export job for a data_export.requested message and acks it", async () => {
    const sent = message(exportEvent);
    await runQueue({ ...configured, ...privacy }, sent);

    expect(mocks.runDataExports).toHaveBeenCalledTimes(1);
    // that export only, by ID and organization, and no sweep of expired exports (the hourly run's)
    expect(mocks.runDataExports).toHaveBeenCalledWith(
      expect.objectContaining({
        sweep: false,
        target: {
          exportId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
          organizationId: "org_1",
        },
      })
    );
    expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
    expect(sent.ack).toHaveBeenCalledTimes(1);
    expect(sent.retry).not.toHaveBeenCalled();
    // the consumer only starts the export: nothing else of the hourly run
    expect(mocks.runPrivacyMaintenance).not.toHaveBeenCalled();
    expect(mocks.runBillingMaintenance).not.toHaveBeenCalled();
  });

  it("retries, and closes the connection, when the job fails", async () => {
    mocks.runDataExports.mockRejectedValue(new Error("export_failed"));
    const sent = message({
      ...exportEvent,
      event: { exportId: "0199a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa" },
      idempotencyKey:
        "data_export.requested:0199a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa",
    });
    await runQueue({ ...configured, ...privacy }, sent);

    expect(sent.retry).toHaveBeenCalledTimes(1);
    expect(sent.ack).not.toHaveBeenCalled();
    expect(mocks.privacyClose).toHaveBeenCalledTimes(1);
  });

  it("acks without running where exports are not provisioned", async () => {
    const sent = message({
      ...exportEvent,
      event: { exportId: "0199a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb" },
      idempotencyKey:
        "data_export.requested:0199a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb",
    });
    await runQueue({}, sent);

    expect(mocks.runDataExports).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledTimes(1);
  });

  it("acks without running a message whose body names another export than its key", async () => {
    const sent = message({
      ...exportEvent,
      event: { exportId: "0199a1b2-c3d4-7e5f-8a6b-dddddddddddd" },
      idempotencyKey:
        "data_export.requested:0199a1b2-c3d4-7e5f-8a6b-eeeeeeeeeeee",
    });
    await runQueue({ ...configured, ...privacy }, sent);

    expect(mocks.runDataExports).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledTimes(1);
    expect(sent.retry).not.toHaveBeenCalled();
  });

  it("warns when the ledger is only in memory", async () => {
    await runQueue({ ...configured, ...privacy }, message(exportEvent));

    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "queue_ledger_in_memory" })
    );
  });

  it("acks a body that is not an envelope and runs nothing", async () => {
    const sent = message({ type: "data_export.requested" });
    await runQueue({ ...configured, ...privacy }, sent);

    expect(mocks.runDataExports).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledTimes(1);
  });

  describe("the dead-letter queue", () => {
    const outbox = {
      OUTBOX_HYPERDRIVE: { connectionString: "postgresql://outbox.invalid/db" },
    };

    function runDlq(env: Record<string, unknown>, ...sent: unknown[]) {
      return worker.queue(
        { messages: sent, queue: "polaris-dlq" } as never,
        env as never
      );
    }

    it("records the message through the outbox client, closes it, and never runs the normal consumer", async () => {
      const recordDeadLetter = vi.fn().mockResolvedValue(undefined);
      mocks.createOutboxClient.mockReturnValue({
        close: mocks.outboxClose.mockResolvedValue(undefined),
        recordDeadLetter,
      });
      const sent = message(exportEvent);

      await runDlq({ ...configured, ...privacy, ...outbox }, sent);

      expect(mocks.createOutboxClient).toHaveBeenCalledWith(
        outbox.OUTBOX_HYPERDRIVE.connectionString
      );
      expect(recordDeadLetter).toHaveBeenCalledOnce();
      expect(recordDeadLetter).toHaveBeenCalledWith({
        cause: "retries_exhausted",
        event: { id: exportEvent.eventId, organizationId: "org_1" },
        reference: exportEvent.eventId,
        subject: "data_export.requested",
      });
      expect(sent.ack).toHaveBeenCalledOnce();
      expect(mocks.outboxClose).toHaveBeenCalledOnce();
      // the consumer of the normal queues did not see it
      expect(mocks.runDataExports).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "queue_ledger_in_memory" })
      );
    });

    it("retries an hour later, and warns, without the outbox role", async () => {
      const sent = message(exportEvent);

      await runDlq({ ...configured, ...privacy }, sent);

      expect(mocks.createOutboxClient).not.toHaveBeenCalled();
      expect(sent.retry).toHaveBeenCalledOnce();
      expect(sent.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
      expect(sent.ack).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "dead_letter_not_recorded_unconfigured",
        })
      );
    });

    it("also takes the queue of an environment suffix", async () => {
      const sent = message(exportEvent);
      await worker.queue(
        { messages: [sent], queue: "polaris-dlq-staging" } as never,
        {} as never
      );
      expect(sent.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    });

    it("gives the normal consumer the dead-letter producer only with the outbox role (the in-memory ledger could not record what lands there)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const QUEUE_DLQ = { send };
      const refused = message({ junk: true });

      // in-memory ledger: the message is dropped with a warning, nothing is sent
      await runQueue({ QUEUE_DLQ }, refused);
      expect(send).not.toHaveBeenCalled();
      expect(refused.ack).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "queue_dead_letter_not_configured",
          messageId: "m",
        })
      );

      // durable ledger
      mocks.createOutboxClient.mockReturnValue({
        close: mocks.outboxClose.mockResolvedValue(undefined),
      });
      const again = message({ junk: true });
      await runQueue({ ...outbox, QUEUE_DLQ }, again);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ cause: "invalid_envelope" }),
        { contentType: "json" }
      );
      expect(again.ack).toHaveBeenCalledOnce();
      expect(mocks.outboxClose).toHaveBeenCalledOnce();
    });

    it("acks a refused message and warns where the dead-letter queue is not bound", async () => {
      const refused = message({ junk: true });
      await runQueue({}, refused);
      expect(refused.ack).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "queue_dead_letter_not_configured",
          messageId: "m",
        })
      );
    });
  });

  describe("the processing ledger", () => {
    const outbox = {
      OUTBOX_HYPERDRIVE: { connectionString: "postgresql://outbox.invalid/db" },
    };
    const exportId = "0199a1b2-c3d4-7e5f-8a6b-cccccccccccc";
    const body = {
      ...exportEvent,
      event: { exportId },
      idempotencyKey: `data_export.requested:${exportId}`,
    };

    it("is the durable one, and its connection is closed after the batch, when the outbox role is bound", async () => {
      const store = {
        claimProcessing: vi
          .fn()
          .mockResolvedValue({ result: "claimed", token: "t" }),
        close: mocks.outboxClose.mockResolvedValue(undefined),
        completeProcessing: vi.fn().mockResolvedValue(undefined),
        releaseProcessing: vi.fn().mockResolvedValue(undefined),
      };
      mocks.createOutboxClient.mockReturnValue(store);
      const sent = message(body);

      await runQueue({ ...configured, ...privacy, ...outbox }, sent);

      expect(mocks.createOutboxClient).toHaveBeenCalledWith(
        outbox.OUTBOX_HYPERDRIVE.connectionString
      );
      expect(store.claimProcessing).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          eventId: body.eventId,
          idempotencyKey: body.idempotencyKey,
        }),
        960
      );
      expect(store.completeProcessing).toHaveBeenCalledOnce();
      expect(mocks.runDataExports).toHaveBeenCalledOnce();
      expect(sent.ack).toHaveBeenCalledOnce();
      expect(mocks.outboxClose).toHaveBeenCalledOnce();
    });

    it("closes the connection and leaves the message to retry when the durable ledger is down", async () => {
      mocks.createOutboxClient.mockReturnValue({
        claimProcessing: vi.fn().mockRejectedValue(new Error("down")),
        close: mocks.outboxClose.mockResolvedValue(undefined),
        completeProcessing: vi.fn(),
        releaseProcessing: vi.fn(),
      });
      const sent = message(body);

      await runQueue({ ...configured, ...privacy, ...outbox }, sent);

      expect(mocks.runDataExports).not.toHaveBeenCalled();
      expect(sent.retry).toHaveBeenCalledOnce();
      expect(mocks.outboxClose).toHaveBeenCalledOnce();
    });

    it("is in memory, with no outbox connection, when the outbox role is not bound", async () => {
      const memoryId = "0199a1b2-c3d4-7e5f-8a6b-dddddddddddd";
      const first = message({
        ...body,
        event: { exportId: memoryId },
        idempotencyKey: `data_export.requested:${memoryId}`,
      });
      const duplicate = message(first.body);

      await runQueue({ ...configured, ...privacy }, first, duplicate);

      expect(mocks.createOutboxClient).not.toHaveBeenCalled();
      // the in-memory ledger still absorbs the duplicate
      expect(mocks.runDataExports).toHaveBeenCalledOnce();
      expect(first.ack).toHaveBeenCalledOnce();
      expect(duplicate.ack).toHaveBeenCalledOnce();
    });
  });
});

const CRONS_LIST = /"crons":\s*\[([^\]]*)\]/;
const QUOTED = /"([^"]+)"/g;

describe("the cron triggers", () => {
  const declaredCrons = () => {
    const config = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8"
    );
    const [, list] = CRONS_LIST.exec(config) ?? [];
    return [...(list ?? "").matchAll(QUOTED)].map((match) => match[1]);
  };

  it("declare exactly the crons of the scheduler's lanes: one tick per lane, not one trigger per job", () => {
    expect(declaredCrons().sort()).toEqual(
      SCHEDULER_LANES.map((lane) => lane.cron).sort()
    );
  });

  it("stay within the five Cron Triggers of the Workers Free plan, across every Worker of the account", () => {
    const apps = new URL("../../", import.meta.url);
    const others = readdirSync(apps)
      .filter((name) => name !== "web")
      .filter((name) => existsSync(new URL(`${name}/wrangler.jsonc`, apps)))
      .filter((name) =>
        readFileSync(new URL(`${name}/wrangler.jsonc`, apps), "utf8").includes(
          '"crons"'
        )
      );
    expect(others).toEqual([]);
    expect(declaredCrons().length).toBeLessThanOrEqual(5);
  });
});

describe("Cloudflare Workflows", () => {
  it("are not bound by any Worker: on the Free plan a step gets 10 ms of CPU, less than the queue consumer (ADR 0088)", () => {
    const apps = new URL("../../", import.meta.url);
    const withWorkflows = readdirSync(apps)
      .filter((name) => existsSync(new URL(`${name}/wrangler.jsonc`, apps)))
      .filter((name) =>
        readFileSync(new URL(`${name}/wrangler.jsonc`, apps), "utf8").includes(
          '"workflows"'
        )
      );
    expect(withWorkflows).toEqual([]);
  });
});

describe("the scheduler tick", () => {
  const outbox = {
    OUTBOX_HYPERDRIVE: { connectionString: "postgresql://outbox.invalid/db" },
  };
  const everything = {
    ...configured,
    ...outbox,
    AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/db" },
    PRIVACY_HYPERDRIVE: { connectionString: "postgresql://privacy.invalid/db" },
  };
  let state: ReturnType<typeof schedulerState>;

  const tick = (cron: string | undefined, env: Record<string, unknown>) =>
    worker.scheduled(
      (cron === undefined ? {} : { cron }) as ScheduledController,
      env as never
    );

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state = schedulerState();
    mocks.createOutboxClient.mockReturnValue({
      ...state,
      close: mocks.outboxClose.mockResolvedValue(undefined),
      expireProcessing: vi.fn().mockResolvedValue(0),
      recordExhaustedOutboxEvents: vi.fn().mockResolvedValue(0),
    });
    mocks.createMediaCleanupClient.mockReturnValue({ close: mocks.mediaClose });
    mocks.mediaClose.mockResolvedValue(undefined);
    mocks.createBillingStore.mockReturnValue({ close: mocks.billingClose });
    mocks.billingClose.mockResolvedValue(undefined);
    mocks.createAuthLoginLockMaintenanceClient.mockReturnValue({
      close: mocks.loginLockClose.mockResolvedValue(undefined),
      expire: mocks.loginLockExpire.mockResolvedValue(0),
    });
    mocks.reconcileStagedMedia.mockResolvedValue({});
    mocks.reconcileRemovedMedia.mockResolvedValue({});
    mocks.runBillingMaintenance.mockResolvedValue({});
    mocks.createPrivacyMaintenanceClient.mockReturnValue({
      close: mocks.privacyClose,
    });
    mocks.privacyClose.mockResolvedValue(undefined);
    mocks.runPrivacyMaintenance.mockResolvedValue({});
    mocks.runDataExports.mockResolvedValue({});
    mocks.dispatchOutbox.mockResolvedValue({ claimed: 0 });
  });

  it("takes the lease of each maintenance job with its cadence, runs it and records the success", async () => {
    await tick("17 * * * *", everything);

    expect(state.claimScheduledJob.mock.calls).toEqual([
      ["media.maintenance", 3600, 960],
      ["billing.maintenance", 3600, 960],
      ["privacy.maintenance", 3600, 960],
      ["auth.login_lock_expiry", 3600, 960],
    ]);
    expect(state.completeScheduledJob.mock.calls).toEqual([
      ["media.maintenance", "lease-token"],
      ["billing.maintenance", "lease-token"],
      ["privacy.maintenance", "lease-token"],
      ["auth.login_lock_expiry", "lease-token"],
    ]);
    expect(state.releaseScheduledJob).not.toHaveBeenCalled();
    // one connection for the whole tick, closed once
    expect(mocks.createOutboxClient).toHaveBeenCalledOnce();
    expect(mocks.outboxClose).toHaveBeenCalledOnce();
  });

  it("runs only the dispatcher on the dispatcher's cron, on the connection that holds the lease", async () => {
    await tick("19 * * * *", everything);

    expect(state.claimScheduledJob.mock.calls).toEqual([
      ["outbox.dispatch", 3600, 960],
    ]);
    expect(mocks.createOutboxClient).toHaveBeenCalledOnce();
    expect(mocks.dispatchOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.objectContaining({
          claimScheduledJob: state.claimScheduledJob,
        }),
      })
    );
    expect(state.completeScheduledJob).toHaveBeenCalledWith(
      "outbox.dispatch",
      "lease-token"
    );
    expect(mocks.reconcileStagedMedia).not.toHaveBeenCalled();
  });

  it("expires the sign-in lock rows through the authentication role and closes the connection", async () => {
    mocks.loginLockExpire.mockResolvedValue(3);

    await tick("17 * * * *", everything);

    expect(mocks.createAuthLoginLockMaintenanceClient).toHaveBeenCalledWith(
      "postgresql://auth.invalid/db"
    );
    expect(mocks.loginLockExpire).toHaveBeenCalledOnce();
    expect(mocks.loginLockClose).toHaveBeenCalledOnce();
    expect(state.completeScheduledJob).toHaveBeenCalledWith(
      "auth.login_lock_expiry",
      "lease-token"
    );
  });

  it("leaves the window of the sign-in lock expiry open without the authentication role, and fails the cron when the expiry fails", async () => {
    await tick("17 * * * *", { ...everything, AUTH_HYPERDRIVE: undefined });

    expect(mocks.createAuthLoginLockMaintenanceClient).not.toHaveBeenCalled();
    expect(state.releaseScheduledJob).toHaveBeenCalledWith(
      "auth.login_lock_expiry",
      "lease-token",
      "skipped"
    );

    mocks.loginLockExpire.mockRejectedValue(new Error("expire_failed"));
    await expect(tick("17 * * * *", everything)).rejects.toThrow(
      "expire_failed"
    );
    expect(state.releaseScheduledJob).toHaveBeenCalledWith(
      "auth.login_lock_expiry",
      "lease-token",
      "failed"
    );
    expect(mocks.loginLockClose).toHaveBeenCalled();
  });

  it("does not run a job that is not due or whose lease is held, and does not fail the cron", async () => {
    state.claimScheduledJob
      .mockResolvedValueOnce({ result: "not_due" })
      .mockResolvedValueOnce({ result: "busy" });

    await expect(tick("17 * * * *", everything)).resolves.toBeUndefined();

    expect(mocks.reconcileStagedMedia).not.toHaveBeenCalled();
    expect(mocks.runBillingMaintenance).not.toHaveBeenCalled();
    expect(mocks.runPrivacyMaintenance).toHaveBeenCalledOnce();
  });

  it("gives the lease back as failed, leaves the window open and fails the cron when a job fails", async () => {
    mocks.runBillingMaintenance.mockRejectedValue(
      new Error("billing_maintenance_incomplete")
    );

    await expect(tick("17 * * * *", everything)).rejects.toThrow(
      "billing_maintenance_incomplete"
    );

    expect(state.releaseScheduledJob).toHaveBeenCalledWith(
      "billing.maintenance",
      "lease-token",
      "failed"
    );
    expect(state.completeScheduledJob).toHaveBeenCalledWith(
      "media.maintenance",
      "lease-token"
    );
    expect(state.completeScheduledJob).toHaveBeenCalledWith(
      "privacy.maintenance",
      "lease-token"
    );
  });

  it("does not cover the window of a job whose role is not provisioned yet", async () => {
    await tick("17 * * * *", {
      ...outbox,
      MEDIA_BUCKET: {},
      MEDIA_CLEANUP_HYPERDRIVE: configured.MEDIA_CLEANUP_HYPERDRIVE,
    });

    expect(state.releaseScheduledJob).toHaveBeenCalledWith(
      "billing.maintenance",
      "lease-token",
      "skipped"
    );
    expect(state.releaseScheduledJob).toHaveBeenCalledWith(
      "privacy.maintenance",
      "lease-token",
      "skipped"
    );
    expect(state.completeScheduledJob).not.toHaveBeenCalledWith(
      "billing.maintenance",
      expect.anything()
    );
  });

  it("runs nothing when the lease cannot be asked for, and fails the cron", async () => {
    state.claimScheduledJob.mockRejectedValue(new Error("connection refused"));

    await expect(tick("19 * * * *", everything)).rejects.toThrow(
      "connection refused"
    );
    expect(mocks.dispatchOutbox).not.toHaveBeenCalled();
    expect(mocks.outboxClose).toHaveBeenCalledOnce();
  });

  it("runs the maintenance on an expression it does not declare, and says so", async () => {
    await tick("*/5 * * * *", everything);

    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduler_unknown_cron" })
    );
    expect(mocks.runBillingMaintenance).toHaveBeenCalledOnce();
    expect(mocks.dispatchOutbox).not.toHaveBeenCalled();
  });

  it("does without the scheduler's state where the outbox role is not provisioned: every job, every tick", async () => {
    await tick("17 * * * *", { ...configured });
    await tick("17 * * * *", { ...configured });

    expect(mocks.createOutboxClient).not.toHaveBeenCalled();
    expect(mocks.runBillingMaintenance).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduler_state_unavailable",
        lane: "maintenance",
      })
    );
  });
});
