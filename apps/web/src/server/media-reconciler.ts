import type { MediaCleanupClient } from "@polaris/db/media-cleanup";
import type { MediaBucketBinding } from "./environment";
import { isMediaObjectKey } from "./media-upload-command";

const MEDIA_STAGING_PREFIX = "media/staging/v1/";
export const MEDIA_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;
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
