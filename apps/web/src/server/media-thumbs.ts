import { mediaDerivativeKey } from "@polaris/domain/catalog/media";
import type { MediaBucketBinding } from "./environment";

/**
 * Every thumbnail costs one R2 `get` and its copy, about 1 ms of Worker CPU in
 * the local workerd bench; five keep the batch about 5 ms above a single image,
 * the budget on the Workers Free plan. The client batch size follows this value.
 */
export const MAX_MEDIA_THUMBS_PER_REQUEST = 5;
/** A Worker invocation keeps at most six storage operations open at once; a higher cap must not exceed it. */
const MEDIA_THUMBS_STORAGE_CONCURRENCY = 6;
export const MEDIA_THUMBS_HEADER = "X-Polaris-Thumbs";
const MEDIA_THUMBS_SIZE = 320;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The capped UUIDs and their commas; anything longer is refused before it is split. */
const MAX_IDS_PARAMETER_LENGTH = MAX_MEDIA_THUMBS_PER_REQUEST * 37;

export class InvalidMediaThumbsRequestError extends Error {
  readonly code = "invalid_media_thumbs_request";

  constructor() {
    super("invalid_media_thumbs_request");
    this.name = "InvalidMediaThumbsRequestError";
  }
}

/**
 * Up to `MAX_MEDIA_THUMBS_PER_REQUEST` UUIDs separated by commas, lower-cased and
 * without repeats, in the order asked. A repeated id is answered once.
 */
export function parseMediaThumbIds(value: string | undefined): string[] {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_IDS_PARAMETER_LENGTH
  ) {
    throw new InvalidMediaThumbsRequestError();
  }
  const parts = value.split(",");
  if (parts.length > MAX_MEDIA_THUMBS_PER_REQUEST) {
    throw new InvalidMediaThumbsRequestError();
  }
  const ids: string[] = [];
  for (const part of parts) {
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
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each worker takes the next item; the pool caps the parallelism.
        results[index] = await operation(items[index] as T);
      } catch (error: unknown) {
        // the others stop taking items: the request has already failed
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

export interface MediaThumbsRead {
  /** The found thumbnails' bytes, one after the other in the order of `entries`. */
  body: Uint8Array<ArrayBuffer>;
  entries: MediaThumbEntry[];
}

/**
 * Reads the stored 320 px derivative of each authorized id with one `get` each,
 * at most six at once, each body taken whole with `arrayBuffer` and copied into
 * one buffer, so the header lists exact sizes before anything is sent and no
 * stream is piped per image. An id that was not authorized is never looked up,
 * and nothing is ever transformed. A derivative that is not there is `missing`,
 * the same as any other id this organization cannot serve.
 */
export async function readMediaThumbs(input: {
  authorizedIds: ReadonlySet<string>;
  bucket: Pick<MediaBucketBinding, "get">;
  ids: readonly string[];
}): Promise<MediaThumbsRead> {
  const found = await mapWithConcurrency(
    input.ids,
    MEDIA_THUMBS_STORAGE_CONCURRENCY,
    async (id): Promise<ArrayBuffer | null> => {
      if (!input.authorizedIds.has(id)) {
        return null;
      }
      const object = await input.bucket.get(
        mediaDerivativeKey(id, MEDIA_THUMBS_SIZE)
      );
      return object ? await object.arrayBuffer() : null;
    }
  );
  const entries = input.ids.map(
    (id, index): MediaThumbEntry => ({
      id,
      size: found[index]?.byteLength ?? null,
    })
  );
  const body = new Uint8Array(
    found.reduce((total, bytes) => total + (bytes?.byteLength ?? 0), 0)
  );
  let offset = 0;
  for (const bytes of found) {
    if (bytes) {
      body.set(new Uint8Array(bytes), offset);
      offset += bytes.byteLength;
    }
  }
  return { body, entries };
}
