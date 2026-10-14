import { describe, expect, it, vi } from "vitest";
import type { MediaCleanupClient } from "@polaris/db/media-cleanup";
import type { MediaBucketBinding } from "./environment";
import {
  MEDIA_STAGING_RETENTION_MS,
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
