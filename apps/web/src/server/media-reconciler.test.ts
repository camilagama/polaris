import { describe, expect, it, vi } from "vitest";
import type { MediaCleanupClient } from "@polaris/db/media-cleanup";
import type { MediaBucketBinding } from "./environment";
import {
  MEDIA_REMOVED_RETENTION_MS,
  MEDIA_STAGING_RETENTION_MS,
  reconcileRemovedMedia,
  reconcileStagedMedia,
} from "./media-reconciler";

const now = new Date("2026-10-10T12:00:00.000Z");
const attemptId = "de305d54-75b4-431b-adb2-eb6b9e546015";
const storageKey = `media/v2/org/0199c2d0-0000-7000-8000-000000000001/de305d54-75b4-431b-adb2-eb6b9e546014/${"a".repeat(64)}/${attemptId}.webp`;
const markerKey = `media/staging/v1/2026/10/09/11/${attemptId}.json`;

function makeFixture(
  input: {
    referenced?: boolean;
    markerUploaded?: Date;
    failDelete?: boolean;
  } = {}
) {
  const objects = new Map<string, Uint8Array>([
    [
      markerKey,
      new TextEncoder().encode(JSON.stringify({ storageKey, version: 1 })),
    ],
    [storageKey, new Uint8Array([1, 2, 3])],
  ]);
  const list = vi.fn(() =>
    Promise.resolve({
      objects: [
        {
          key: markerKey,
          uploaded:
            input.markerUploaded ??
            new Date(now.getTime() - MEDIA_STAGING_RETENTION_MS - 1000),
        },
      ],
      truncated: false,
    })
  );
  const mediaBucket: MediaBucketBinding = {
    delete: vi.fn((key) => {
      if (input.failDelete) {
        return Promise.reject(new Error("r2 unavailable"));
      }
      objects.delete(key);
      return Promise.resolve();
    }),
    get: vi.fn((key) => {
      const bytes = objects.get(key);
      if (!bytes) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer as ArrayBuffer),
        body: new Response(bytes.slice().buffer as ArrayBuffer)
          .body as ReadableStream<Uint8Array>,
        httpEtag: '"test"',
        size: bytes.byteLength,
        uploaded: now,
      });
    }),
    list,
    put: vi.fn(() => Promise.resolve({ etag: '"test"' })),
  };
  const cleanupClient: MediaCleanupClient = {
    claimOrphan: vi.fn(() => Promise.resolve(input.referenced !== true)),
    close: vi.fn(() => Promise.resolve()),
    finalizeUnlinked: vi.fn(() => Promise.resolve(true)),
    listUnlinked: vi.fn(() => Promise.resolve([])),
  };
  return { cleanupClient, mediaBucket, objects };
}

describe("reconcileStagedMedia", () => {
  it("keeps recent markers until the 24-hour retention elapses", async () => {
    const fixture = makeFixture({
      markerUploaded: new Date(now.getTime() - MEDIA_STAGING_RETENTION_MS + 1),
    });

    const report = await reconcileStagedMedia({
      ...fixture,
      now,
    });

    expect(report.skippedRecent).toBe(1);
    expect(fixture.cleanupClient.claimOrphan).not.toHaveBeenCalled();
    expect(fixture.objects.has(markerKey)).toBe(true);
    expect(fixture.objects.has(storageKey)).toBe(true);
  });

  it("deletes an unreferenced final object only after claiming its key", async () => {
    const fixture = makeFixture();

    const report = await reconcileStagedMedia({
      ...fixture,
      now,
    });

    expect(report.orphanObjectsDeleted).toBe(1);
    expect(report.markersDeleted).toBe(1);
    expect(fixture.cleanupClient.claimOrphan).toHaveBeenCalledWith(storageKey);
    expect(fixture.objects.size).toBe(0);
  });

  it("keeps a referenced master and removes only its stale marker", async () => {
    const fixture = makeFixture({ referenced: true });

    const report = await reconcileStagedMedia({
      ...fixture,
      now,
    });

    expect(report.referencedObjectsKept).toBe(1);
    expect(fixture.objects.has(storageKey)).toBe(true);
    expect(fixture.objects.has(markerKey)).toBe(false);
  });

  it("retains the marker if deleting the final object fails", async () => {
    const fixture = makeFixture({ failDelete: true });

    await expect(reconcileStagedMedia({ ...fixture, now })).rejects.toThrow(
      "media_staging_reconciliation_incomplete"
    );
    expect(fixture.objects.has(markerKey)).toBe(true);
    expect(fixture.objects.has(storageKey)).toBe(true);
  });

  it("does not delete when the marker names a key outside the versioned media namespace", async () => {
    const fixture = makeFixture();
    fixture.objects.set(
      markerKey,
      new TextEncoder().encode(
        JSON.stringify({ storageKey: "other-tenant/data.webp", version: 1 })
      )
    );

    await expect(reconcileStagedMedia({ ...fixture, now })).rejects.toThrow(
      "media_staging_reconciliation_incomplete"
    );
    expect(fixture.cleanupClient.claimOrphan).not.toHaveBeenCalled();
    expect(fixture.objects.has(storageKey)).toBe(true);
    expect(fixture.objects.has(markerKey)).toBe(true);
  });
});

describe("reconcileRemovedMedia", () => {
  const assetId = "0199c2d0-0000-7000-8000-0000000000aa";
  const removedKey = `media/v2/org/0199c2d0-0000-7000-8000-000000000001/de305d54-75b4-431b-adb2-eb6b9e546014/${"b".repeat(64)}/${attemptId}.webp`;
  const derivative = (size: number) =>
    `media/derivatives/v1/${assetId}/${size}.webp`;

  function makeRemovedFixture(
    input: {
      batches?: { assetId: string; storageKey: string }[][];
      failDelete?: boolean;
      finalized?: boolean;
      failFinalize?: boolean;
    } = {}
  ) {
    const fixture = makeFixture();
    fixture.objects.clear();
    for (const key of [removedKey, derivative(320), derivative(640)]) {
      fixture.objects.set(key, new Uint8Array([1]));
    }
    if (input.failDelete) {
      fixture.mediaBucket.delete = vi.fn(() =>
        Promise.reject(new Error("r2 unavailable"))
      );
    }
    const queue = [
      ...(input.batches ?? [[{ assetId, storageKey: removedKey }]]),
    ];
    fixture.cleanupClient.listUnlinked = vi.fn(() =>
      Promise.resolve(queue.shift() ?? [])
    );
    fixture.cleanupClient.finalizeUnlinked = vi.fn(() =>
      input.failFinalize
        ? Promise.reject(new Error("db unavailable"))
        : Promise.resolve(input.finalized !== false)
    );
    return fixture;
  }

  it("deletes the master and both derivatives of a removed image, then finishes its cleanup", async () => {
    const fixture = makeRemovedFixture();

    const report = await reconcileRemovedMedia(fixture);

    expect(report).toEqual({ deleted: 1, failed: 0, scanned: 1 });
    expect(fixture.objects.size).toBe(0);
    expect(fixture.cleanupClient.listUnlinked).toHaveBeenCalledWith(
      50,
      MEDIA_REMOVED_RETENTION_MS,
      []
    );
    expect(fixture.cleanupClient.finalizeUnlinked).toHaveBeenCalledWith(
      assetId
    );
  });

  it("finishes the database only after every object is gone", async () => {
    const fixture = makeRemovedFixture();
    const order: string[] = [];
    const realDelete = fixture.mediaBucket.delete;
    fixture.mediaBucket.delete = vi.fn((key) => {
      order.push(`delete:${key}`);
      return realDelete(key);
    });
    fixture.cleanupClient.finalizeUnlinked = vi.fn(() => {
      order.push("finalize");
      return Promise.resolve(true);
    });

    await reconcileRemovedMedia(fixture);

    expect(order).toEqual([
      `delete:${removedKey}`,
      `delete:${derivative(320)}`,
      `delete:${derivative(640)}`,
      "finalize",
    ]);
  });

  it("records nothing and reports an incomplete run when the bucket fails, so the next run tries again", async () => {
    const fixture = makeRemovedFixture({ failDelete: true });

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow(
      "media_removed_reconciliation_incomplete"
    );
    expect(fixture.cleanupClient.finalizeUnlinked).not.toHaveBeenCalled();
  });

  it("reports an incomplete run when the database fails after the objects were deleted", async () => {
    const fixture = makeRemovedFixture({ failFinalize: true });

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow(
      "media_removed_reconciliation_incomplete"
    );
    // deleting what is already gone is harmless on the next run
    expect(fixture.objects.size).toBe(0);
  });

  it("deletes nothing for a storage key outside the versioned media namespace", async () => {
    const fixture = makeRemovedFixture({
      batches: [[{ assetId, storageKey: "other-tenant/data.webp" }]],
    });

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow(
      "media_removed_reconciliation_incomplete"
    );
    expect(fixture.mediaBucket.delete).not.toHaveBeenCalled();
    expect(fixture.cleanupClient.finalizeUnlinked).not.toHaveBeenCalled();
  });

  it("reports an asset that gained a link after its objects were deleted as a failure, with its id, never silently", async () => {
    const fixture = makeRemovedFixture({ finalized: false });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow(
      "media_removed_reconciliation_incomplete"
    );

    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        event: "media_removed_asset_not_finalized",
      })
    );
    logged.mockRestore();
  });

  it("logs every failure with the asset id and the reason", async () => {
    const fixture = makeRemovedFixture({ failFinalize: true });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow();

    // the class of the error is logged, never its text
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        errorClass: "Error",
        event: "media_removed_asset_failed",
      })
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("db unavailable");
    logged.mockRestore();
  });

  it("leaves an asset that failed out of the rest of the run, so it cannot hide the others", async () => {
    const stuck = "0199c2d0-0000-7000-8000-0000000000cc";
    const fine = "0199c2d0-0000-7000-8000-0000000000dd";
    const fixture = makeRemovedFixture({
      batches: [
        [{ assetId: stuck, storageKey: "other-tenant/data.webp" }],
        [{ assetId: fine, storageKey: removedKey }],
      ],
    });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(reconcileRemovedMedia(fixture)).rejects.toThrow(
      "media_removed_reconciliation_incomplete"
    );

    // the second listing was told to leave the stuck asset out and found the other one
    expect(fixture.cleanupClient.listUnlinked).toHaveBeenNthCalledWith(
      2,
      50,
      MEDIA_REMOVED_RETENTION_MS,
      [stuck]
    );
    expect(fixture.cleanupClient.finalizeUnlinked).toHaveBeenCalledWith(fine);
    logged.mockRestore();
  });

  it("does at most three batches of fifty in one run", async () => {
    const batch = (prefix: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        assetId: `0199c2d0-0000-7000-8000-${String(prefix * 100 + index).padStart(12, "0")}`,
        storageKey: removedKey,
      }));
    const fixture = makeRemovedFixture({
      batches: [batch(1), batch(2), batch(3), batch(4)],
    });

    const report = await reconcileRemovedMedia(fixture);

    expect(report).toEqual({ deleted: 150, failed: 0, scanned: 150 });
    expect(fixture.cleanupClient.listUnlinked).toHaveBeenCalledTimes(3);
  });

  it("works through several batches and stops when a batch brings nothing new", async () => {
    const second = "0199c2d0-0000-7000-8000-0000000000bb";
    const fixture = makeRemovedFixture({
      batches: [
        [{ assetId, storageKey: removedKey }],
        [{ assetId: second, storageKey: removedKey }],
        [{ assetId: second, storageKey: removedKey }],
      ],
    });

    const report = await reconcileRemovedMedia(fixture);

    expect(report).toEqual({ deleted: 2, failed: 0, scanned: 2 });
    expect(fixture.cleanupClient.listUnlinked).toHaveBeenCalledTimes(3);
  });

  it("does nothing when no image was removed", async () => {
    const fixture = makeRemovedFixture({ batches: [[]] });

    const report = await reconcileRemovedMedia(fixture);

    expect(report).toEqual({ deleted: 0, failed: 0, scanned: 0 });
    expect(fixture.mediaBucket.delete).not.toHaveBeenCalled();
  });
});
