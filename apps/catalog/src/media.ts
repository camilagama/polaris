import {
  MEDIA_DERIVATIVE_SIZES,
  type MediaDerivativeSize,
  mediaDerivativeKey,
} from "@polaris/domain/catalog/media";
import { parseSlug, parseUuid } from "./input";

/**
 * The public image route (plan PR89, ADR 0069). The bucket stays private: every
 * request is authorized again by the database (the image must belong to a product
 * that is being shown right now), and only then is the object read. What is
 * served never reveals where it lives; the storage path is used here and goes no
 * further.
 */

/** What the public database function says about an image that may be shown. */
export interface AuthorizedMedia {
  byteSize: number;
  contentType: string;
  storageKey: string;
}

interface MediaObject {
  body: ReadableStream;
  size: number;
}

export interface MediaDependencies {
  /** The private bucket, read only: nothing here ever writes to it. */
  getObject: (key: string) => Promise<MediaObject | null>;
  /** Asks the database whether this image of this product of this store may be shown now. */
  authorize: (input: {
    assetId: string;
    productId: string;
    slug: string;
  }) => Promise<AuthorizedMedia | null>;
  report: (message: string, error?: unknown) => void;
}

export interface MediaRequest {
  assetId: string;
  ifNoneMatch: string | null;
  productId: string;
  /** The `s` query value: absent (the master), "320" or "640". */
  size: string | null;
  slug: string;
}

/**
 * The plan and the product can change at any moment, so an image is cached only
 * briefly: it may stay visible for this long after it was taken down, never longer.
 */
export const MEDIA_MAX_AGE_SECONDS = 60;
const MISSING_MAX_AGE_SECONDS = 15;

const WEAK_PREFIX = /^W\//;

const sharedHeaders = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function notFound(): Response {
  return new Response("Not found", {
    headers: {
      ...sharedHeaders,
      "Cache-Control": `public, max-age=${MISSING_MAX_AGE_SECONDS}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    status: 404,
  });
}

function unavailable(): Response {
  return new Response("Unavailable", {
    headers: {
      ...sharedHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
    status: 502,
  });
}

function derivativeSize(
  raw: string | null
): MediaDerivativeSize | null | "bad" {
  if (raw === null) {
    return null;
  }
  const size = MEDIA_DERIVATIVE_SIZES.find(
    (candidate) => String(candidate) === raw
  );
  return size ?? "bad";
}

function matches(ifNoneMatch: string | null, etag: string): boolean {
  return (
    ifNoneMatch
      ?.split(",")
      .some(
        (candidate) => candidate.trim().replace(WEAK_PREFIX, "") === etag
      ) === true
  );
}

export async function serveMedia(
  request: MediaRequest,
  dependencies: MediaDependencies
): Promise<Response> {
  const slug = parseSlug(request.slug);
  const productId = parseUuid(request.productId);
  const assetId = parseUuid(request.assetId);
  const size = derivativeSize(request.size);
  if (
    slug === null ||
    productId === null ||
    assetId === null ||
    size === "bad"
  ) {
    return notFound();
  }

  let authorized: AuthorizedMedia | null;
  try {
    authorized = await dependencies.authorize({ assetId, productId, slug });
  } catch (error: unknown) {
    dependencies.report("catalog media authorization failed", error);
    return unavailable();
  }
  if (authorized === null) {
    return notFound();
  }

  try {
    // a derivative exists once the ERP has shown the image at that size; until then the master is served
    const derivative =
      size === null
        ? null
        : await dependencies.getObject(mediaDerivativeKey(assetId, size));
    const object =
      derivative ?? (await dependencies.getObject(authorized.storageKey));
    if (object === null) {
      dependencies.report("catalog media object is missing");
      return notFound();
    }
    const etag = `"${assetId}-${derivative ? size : "master"}"`;
    const headers = {
      ...sharedHeaders,
      "Cache-Control": `public, max-age=${MEDIA_MAX_AGE_SECONDS}, s-maxage=${MEDIA_MAX_AGE_SECONDS}`,
      ETag: etag,
    };
    if (matches(request.ifNoneMatch, etag)) {
      // the body is not needed; failing to cancel it must not turn a 304 into an error
      await object.body.cancel().catch(() => undefined);
      return new Response(null, { headers, status: 304 });
    }
    return new Response(object.body, {
      headers: {
        ...headers,
        "Content-Length": String(object.size),
        "Content-Type": authorized.contentType,
      },
      status: 200,
    });
  } catch (error: unknown) {
    dependencies.report("catalog media read failed", error);
    return unavailable();
  }
}
