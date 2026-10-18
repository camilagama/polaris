import type { MediaCleanupClient } from "@polaris/db/media-cleanup";
import type { MediaBucketBinding } from "./environment";
import { mediaDerivativeKey } from "@polaris/domain/catalog/media";
import { approvedRetention } from "@polaris/domain/privacy/retention";
import { isMediaObjectKey } from "./media-upload-command";

const MEDIA_STAGING_PREFIX = "media/staging/v1/";
/** How long a staging marker is kept (retention class `media_staging_marker`, ADR 0079). */
export const MEDIA_STAGING_RETENTION_MS = approvedRetention(
  "media_staging_marker"
);
const MAX_STAGING_MARKER_BYTES = 4096;
const PAGE_SIZE = 500;

export interface MediaReconcileReport {
  failed: number;
  markersDeleted: number;
  orphanObjectsDeleted: number;
  referencedObjectsKept: number;
  scanned: number;
  skippedRecent: number;
}

interface MediaStagingMarker {
  storageKey: string;
  version: 1;
}

type MarkerResult =
  | "failed"
  | "missing"
  | "orphan-deleted"
  | "recent"
  | "referenced";

function parseStagingMarker(bytes: ArrayBuffer): MediaStagingMarker {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STAGING_MARKER_BYTES) {
    throw new Error("media_staging_marker_size_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause: unknown) {
    throw new Error("media_staging_marker_invalid", { cause });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("storageKey" in value) ||
    typeof value.storageKey !== "string" ||
    !isMediaObjectKey(value.storageKey)
  ) {
    throw new Error("media_staging_marker_invalid");
  }
  return { storageKey: value.storageKey, version: 1 };
}

async function processStagingMarker(input: {
  cleanupClient: MediaCleanupClient;
  marker: { key: string; uploaded: Date };
  mediaBucket: MediaBucketBinding;
  now: Date;
}): Promise<MarkerResult> {
  if (
    input.now.getTime() - input.marker.uploaded.getTime() <
    MEDIA_STAGING_RETENTION_MS
  ) {
    return "recent";
  }

  try {
    if (
      !(
        input.marker.key.startsWith(MEDIA_STAGING_PREFIX) &&
        input.marker.key.endsWith(".json")
      )
    ) {
      throw new Error("media_staging_key_invalid");
    }
    const markerObject = await input.mediaBucket.get(input.marker.key);
    if (!markerObject) {
      return "missing";
    }
    if (markerObject.size > MAX_STAGING_MARKER_BYTES) {
      throw new Error("media_staging_marker_size_invalid");
    }
    const staged = parseStagingMarker(await markerObject.arrayBuffer());
    const claimed = await input.cleanupClient.claimOrphan(staged.storageKey);
    if (claimed) {
      await input.mediaBucket.delete(staged.storageKey);
    }
    await input.mediaBucket.delete(input.marker.key);
    return claimed ? "orphan-deleted" : "referenced";
  } catch {
    return "failed";
  }
}

function recordMarkerResult(
  report: MediaReconcileReport,
  result: MarkerResult
): void {
  report.scanned += 1;
  if (result === "recent") {
    report.skippedRecent += 1;
  } else if (result === "orphan-deleted") {
    report.orphanObjectsDeleted += 1;
    report.markersDeleted += 1;
  } else if (result === "referenced") {
    report.referencedObjectsKept += 1;
    report.markersDeleted += 1;
  } else if (result === "failed") {
    report.failed += 1;
  }
}

export async function reconcileStagedMedia(input: {
  cleanupClient: MediaCleanupClient;
  mediaBucket: MediaBucketBinding;
  now?: Date;
}): Promise<MediaReconcileReport> {
  const now = input.now ?? new Date();
  const report: MediaReconcileReport = {
    failed: 0,
    markersDeleted: 0,
    orphanObjectsDeleted: 0,
    referencedObjectsKept: 0,
    scanned: 0,
    skippedRecent: 0,
  };
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasMorePages = true;

  while (hasMorePages) {
    // biome-ignore lint/performance/noAwaitInLoops: The next R2 page depends on this page's opaque continuation cursor.
    const page = await input.mediaBucket.list({
      ...(cursor === undefined ? {} : { cursor }),
      limit: PAGE_SIZE,
      prefix: MEDIA_STAGING_PREFIX,
    });

    for (const marker of page.objects) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential marker processing bounds calls to the cleanup DB role and R2.
      const result = await processStagingMarker({
        cleanupClient: input.cleanupClient,
        marker,
        mediaBucket: input.mediaBucket,
        now,
      });
      recordMarkerResult(report, result);
    }

    const { cursor: nextCursor, truncated } = page;
    hasMorePages = truncated;
    if (!truncated) {
      continue;
    }
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("media_staging_cursor_invalid");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (report.failed > 0) {
    throw new Error("media_staging_reconciliation_incomplete");
  }
  return report;
}

/**
 * An image removed from a product waits this long, counted from the creation of
 * its asset (retention class `media_removed_image`, ADR 0079).
 */
export const MEDIA_REMOVED_RETENTION_MS = approvedRetention(
  "media_removed_image"
);
// Each asset costs three bucket calls, and a Worker invocation has a ceiling on
// the calls it may make: keep a run small, the next hourly run continues.
const REMOVED_BATCH_SIZE = 50;
const MAX_REMOVED_BATCHES = 3;

export interface RemovedMediaReport {
  deleted: number;
  failed: number;
  scanned: number;
}

type RemovedAssetResult = "deleted" | "failed";

/**
 * Deletes the master and the derivatives of one removed image, and only then
 * finishes its cleanup in the database. The order matters: if the bucket call
 * fails nothing was recorded and the next run finds the asset again; if the
 * database call fails the next run deletes the (already absent) objects again,
 * which is harmless. An object can therefore never be left without an owner.
 * Every failure is logged with the asset ID, so an operator can find it.
 */
async function reclaimRemovedAsset(input: {
  asset: { assetId: string; storageKey: string };
  cleanupClient: MediaCleanupClient;
  mediaBucket: MediaBucketBinding;
}): Promise<RemovedAssetResult> {
  const { assetId, storageKey } = input.asset;
  try {
    if (!isMediaObjectKey(storageKey)) {
      throw new Error("media_removed_storage_key_invalid");
    }
    await input.mediaBucket.delete(storageKey);
    await input.mediaBucket.delete(mediaDerivativeKey(assetId, 320));
    await input.mediaBucket.delete(mediaDerivativeKey(assetId, 640));
    if (await input.cleanupClient.finalizeUnlinked(assetId)) {
      return "deleted";
    }
    // The asset gained a link (or vanished) after its objects were deleted: the
    // database guard says a link is only added to a new asset, so this should
    // never happen. If it does, an image may have lost its files: never silent.
    console.error("media_removed_asset_not_finalized", { assetId });
    return "failed";
  } catch (error: unknown) {
    console.error("media_removed_asset_failed", {
      assetId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return "failed";
  }
}

/**
 * Reclaims the stored objects of images that were removed from their product
 * (nothing links to their asset anymore). Safe to run again at any time. An
 * asset that fails is left out of the rest of the run, so it cannot starve the
 * others.
 */
export async function reconcileRemovedMedia(input: {
  cleanupClient: MediaCleanupClient;
  mediaBucket: MediaBucketBinding;
}): Promise<RemovedMediaReport> {
  const report: RemovedMediaReport = { deleted: 0, failed: 0, scanned: 0 };
  const seen = new Set<string>();
  const failedAssetIds: string[] = [];

  for (let batch = 0; batch < MAX_REMOVED_BATCHES; batch += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each batch is read after the previous one was finished, so finished assets are not listed again.
    const assets = await input.cleanupClient.listUnlinked(
      REMOVED_BATCH_SIZE,
      MEDIA_REMOVED_RETENTION_MS,
      failedAssetIds
    );
    const fresh = assets.filter((asset) => !seen.has(asset.assetId));
    if (fresh.length === 0) {
      break;
    }
    for (const asset of fresh) {
      seen.add(asset.assetId);
      // biome-ignore lint/performance/noAwaitInLoops: Sequential processing bounds the calls to the cleanup DB role and R2.
      const result = await reclaimRemovedAsset({
        asset,
        cleanupClient: input.cleanupClient,
        mediaBucket: input.mediaBucket,
      });
      report.scanned += 1;
      if (result === "deleted") {
        report.deleted += 1;
      } else {
        report.failed += 1;
        failedAssetIds.push(asset.assetId);
      }
    }
  }

  if (report.failed > 0) {
    console.error("media_removed_reconciliation_incomplete", report);
    throw new Error("media_removed_reconciliation_incomplete");
  }
  return report;
}
