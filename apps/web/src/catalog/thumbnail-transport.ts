import { browserConnection } from "../lib/browser-connection";

/**
 * The one way the client asks the server for thumbnails: `GET /api/media/thumbs`, up to 24 ids per call. The answer
 * lists, in the order asked, `id:bytes` or `id:missing` in `X-Polaris-Thumbs`, and the body is the WebPs of the
 * `bytes` ones, one after the other. Nothing here falls back to the per-image route (`?size=320`): an id the server
 * does not answer with bytes shows the marker.
 */
export const THUMBNAIL_BATCH_LIMIT = 24;

const THUMBS_HEADER = "x-polaris-thumbs";
const THUMBNAIL_TYPE = "image/webp";

/**
 * - `ok`: every id asked has an answer; `null` is an id with no thumbnail (missing, another store's, removed).
 * - `refused`: the server said no to the call itself (no session, no permission, a bad request): asking again
 *   gives the same answer.
 * - `failed`: no usable answer (network, timeout, 429, 5xx, a body that does not match its header): worth another
 *   try, later.
 */
export type ThumbnailBatchResult =
  | { items: Map<string, Blob | null>; kind: "ok" }
  | { kind: "failed" }
  | { kind: "refused" };

export type ThumbnailTransport = (input: {
  ids: readonly string[];
  organizationId: string;
  signal: AbortSignal;
}) => Promise<ThumbnailBatchResult>;

type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;

export function thumbnailBatchUrl(
  organizationId: string,
  ids: readonly string[],
  origin?: string
): URL {
  const url = new URL(
    "/api/media/thumbs",
    origin || globalThis.location?.origin || "http://localhost"
  );
  url.searchParams.set("organizationId", organizationId);
  url.searchParams.set("ids", ids.join(","));
  return url;
}

const BYTES_PATTERN = /^\d+$/;

/**
 * Splits the body by the header. Any mismatch (an id out of order, a size that does not add up to the body) gives
 * `null`: bytes that do not match their header are never shown as somebody's image.
 */
export function parseThumbnailBatch(
  ids: readonly string[],
  header: string | null,
  body: ArrayBuffer
): Map<string, Blob | null> | null {
  if (header === null) {
    return null;
  }
  const entries = header === "" ? [] : header.split(",");
  if (entries.length !== ids.length) {
    return null;
  }
  const items = new Map<string, Blob | null>();
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const separator = entry.lastIndexOf(":");
    const id = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    const asked = ids[index];
    if (separator < 0 || asked === undefined || id !== asked.toLowerCase()) {
      return null;
    }
    if (value === "missing") {
      items.set(asked, null);
      continue;
    }
    if (!BYTES_PATTERN.test(value)) {
      return null;
    }
    const size = Number(value);
    if (size === 0 || offset + size > body.byteLength) {
      return null;
    }
    items.set(
      asked,
      new Blob([body.slice(offset, offset + size)], { type: THUMBNAIL_TYPE })
    );
    offset += size;
  }
  return offset === body.byteLength ? items : null;
}

function refusedStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createThumbnailTransport(
  fetcher: Fetcher = browserConnection.fetch,
  origin?: string
): ThumbnailTransport {
  const ask = asker(fetcher, origin);
  return async ({ ids, organizationId, signal }) => {
    // the server refuses the whole batch for one id that is not a UUID: such an id has no thumbnail, and only the
    // others are asked
    const valid = ids.filter((id) => UUID_PATTERN.test(id));
    const answered =
      valid.length === 0
        ? ({ items: new Map(), kind: "ok" } as const)
        : await ask(valid, organizationId, signal);
    if (answered.kind !== "ok" || valid.length === ids.length) {
      return answered;
    }
    return {
      items: new Map(ids.map((id) => [id, answered.items.get(id) ?? null])),
      kind: "ok",
    };
  };
}

function asker(fetcher: Fetcher, origin: string | undefined) {
  return async (
    ids: readonly string[],
    organizationId: string,
    signal: AbortSignal
  ): Promise<ThumbnailBatchResult> => {
    let response: Response;
    try {
      response = await fetcher(thumbnailBatchUrl(organizationId, ids, origin), {
        credentials: "same-origin",
        method: "GET",
        signal,
      });
    } catch {
      return { kind: "failed" };
    }
    if (response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      return { kind: refusedStatus(response.status) ? "refused" : "failed" };
    }
    let body: ArrayBuffer;
    try {
      body = await response.arrayBuffer();
    } catch {
      return { kind: "failed" };
    }
    const items = parseThumbnailBatch(
      ids,
      response.headers.get(THUMBS_HEADER),
      body
    );
    return items ? { items, kind: "ok" } : { kind: "failed" };
  };
}
