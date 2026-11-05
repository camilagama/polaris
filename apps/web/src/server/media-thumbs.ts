import { mediaDerivativeKey } from "@polaris/domain/catalog/media";
import type { MediaBucketBinding } from "./environment";

const MAX_MEDIA_THUMBS_PER_REQUEST = 24;
/** A Worker invocation keeps at most six storage operations open at once. */
const MEDIA_THUMBS_STORAGE_CONCURRENCY = 6;
export const MEDIA_THUMBS_HEADER = "X-Polaris-Thumbs";
const MEDIA_THUMBS_SIZE = 320;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 24 UUIDs and their commas; anything longer is refused before it is split. */
const MAX_IDS_PARAMETER_LENGTH = MAX_MEDIA_THUMBS_PER_REQUEST * 37;

export class InvalidMediaThumbsRequestError extends Error {
  readonly code = "invalid_media_thumbs_request";

  constructor() {
    super("invalid_media_thumbs_request");
    this.name = "InvalidMediaThumbsRequestError";
  }
}

/** The thumbnail of an id was sized, then changed or vanished before it was streamed. */
export class MediaThumbChangedError extends Error {
  constructor() {
    super("media_thumb_changed");
    this.name = "MediaThumbChangedError";
  }
}

/**
 * 1 to 24 UUIDs separated by commas, lower-cased and without repeats, in the
 * order asked. A repeated id is answered once.
 */
export function parseMediaThumbIds(value: string | undefined): string[] {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_IDS_PARAMETER_LENGTH
  ) {
    throw new InvalidMediaThumbsRequestError();
  }
  const ids: string[] = [];
  for (const part of value.split(",")) {
    if (!uuidPattern.test(part)) {
      throw new InvalidMediaThumbsRequestError();
    }
    const id = part.toLowerCase();
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export interface MediaThumbEntry {
  id: string;
  /** `null` is "missing": unknown, of another organization, removed or without a 320 px derivative. */
  size: number | null;
}

export function mediaThumbsHeaderValue(
  entries: readonly MediaThumbEntry[]
): string {
  return entries
    .map((entry) => `${entry.id}:${entry.size ?? "missing"}`)
    .join(",");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: each worker takes the next item; the pool caps the parallelism.
      results[index] = await operation(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * Sizes the stored 320 px derivative of each authorized id with metadata-only
 * reads, so the header can list every size before the first byte is sent
 * without holding unread bodies open. An id that was not authorized is never
 * looked up, and nothing is ever transformed.
 */
export async function sizeMediaThumbs(input: {
  authorizedIds: ReadonlySet<string>;
  bucket: Pick<MediaBucketBinding, "head">;
  ids: readonly string[];
}): Promise<MediaThumbEntry[]> {
  return await mapWithConcurrency(
    input.ids,
    MEDIA_THUMBS_STORAGE_CONCURRENCY,
    async (id): Promise<MediaThumbEntry> => {
      if (!input.authorizedIds.has(id)) {
        return { id, size: null };
      }
      const object = await input.bucket.head(
        mediaDerivativeKey(id, MEDIA_THUMBS_SIZE)
      );
      return { id, size: object ? object.size : null };
    }
  );
}

interface ByteStreamPair {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

type FixedLengthStreamConstructor = new (
  expectedLength: number
) => ByteStreamPair;

/**
 * On Workers, `FixedLengthStream` sends a Content-Length and lets the runtime
 * pipe the stored bodies without running JavaScript per chunk; elsewhere (the
 * unit tests) a plain identity stream stands in.
 */
function createByteStream(totalBytes: number): ByteStreamPair {
  const fixedLength = (
    globalThis as { FixedLengthStream?: FixedLengthStreamConstructor }
  ).FixedLengthStream;
  return fixedLength
    ? new fixedLength(totalBytes)
    : new TransformStream<Uint8Array, Uint8Array>();
}

async function cancelStoredBody(
  object: ReturnType<MediaBucketBinding["get"]>
): Promise<void> {
  try {
    const stored = await object;
    await stored?.body.cancel();
  } catch {
    // a read that failed or a body already gone holds nothing open
  }
}

function releaseStoredBodies(
  pending: readonly ReturnType<MediaBucketBinding["get"]>[]
): void {
  for (const object of pending) {
    cancelStoredBody(object).catch(() => undefined);
  }
}

/**
 * The bodies of the found thumbnails, one after the other in the order of the
 * header, never decoded nor buffered whole. At most six reads are open: the one
 * being piped and the next five, already started. A body that disappeared or
 * changed size since it was sized aborts the response, so the client never
 * slices bytes against a wrong header.
 */
export function streamMediaThumbs(input: {
  bucket: Pick<MediaBucketBinding, "get">;
  entries: readonly MediaThumbEntry[];
  onAbort: (error: unknown) => void;
}): ReadableStream<Uint8Array> {
  const found = input.entries.filter(
    (entry): entry is { id: string; size: number } => entry.size !== null
  );
  const byteLength = found.reduce((total, entry) => total + entry.size, 0);
  const { readable, writable } = createByteStream(byteLength);

  const pump = async () => {
    const pending: ReturnType<MediaBucketBinding["get"]>[] = [];
    let started = 0;
    try {
      for (const entry of found) {
        while (
          started < found.length &&
          pending.length < MEDIA_THUMBS_STORAGE_CONCURRENCY
        ) {
          const next = found[started] as { id: string };
          pending.push(
            input.bucket.get(mediaDerivativeKey(next.id, MEDIA_THUMBS_SIZE))
          );
          started += 1;
        }
        // biome-ignore lint/performance/noAwaitInLoops: the bodies go out in the header's order, one after the other.
        const object = await (pending.shift() as Promise<{
          body: ReadableStream<Uint8Array>;
          size: number;
        } | null>);
        if (!object || object.size !== entry.size) {
          await object?.body.cancel();
          throw new MediaThumbChangedError();
        }
        await object.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (error: unknown) {
      releaseStoredBodies(pending);
      input.onAbort(error);
      await writable.abort(error).catch(() => undefined);
    }
  };
  pump().catch(() => undefined);

  return readable;
}
