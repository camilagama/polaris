import type { Context, MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";

const DIGITS = /^\d+$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Why a body was refused: its answer is 400, 413 or 415 with this code. */
export type BodyRefusal =
  | "invalid_content_length"
  | "payload_too_large"
  | "unsupported_content_encoding";

interface BodyRefusalDetail {
  /** Where a too large body was cut: by its `Content-Length`, or as it was read. */
  cut?: "declared" | "stream";
  /** The `Content-Length` the request declared (null when absent). */
  declared: number | null;
}

export interface BodyLimitOptions {
  /** The largest body read, in bytes. */
  maxBytes: number;
  /** Called once per refused request, before its answer: what the route logs of it, if anything. */
  onRefusal?: (
    context: Context<ServerEnv>,
    refusal: BodyRefusal,
    detail: BodyRefusalDetail
  ) => void;
}

const STATUS: Record<BodyRefusal, 400 | 413 | 415> = {
  invalid_content_length: 400,
  payload_too_large: 413,
  unsupported_content_encoding: 415,
};

/**
 * The `Content-Length` the request declares: null when absent, `"invalid"` when it is not one non-negative
 * safe integer in digits (a list, a sign, a fraction, a huge number). Never read as zero.
 */
function declaredLength(request: Request): number | null | "invalid" {
  const value = request.headers.get("content-length");
  if (value === null) {
    return null;
  }
  if (!DIGITS.test(value)) {
    return "invalid";
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : "invalid";
}

/** The body, passed on as it is read: it errors the moment it goes past the ceiling, and nothing is kept. */
function limitedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => void
): ReadableStream<Uint8Array> {
  let read = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.byteLength;
        if (read > maxBytes) {
          onExceeded();
          controller.terminate();
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

/**
 * The size and the encoding of a request body, before anything parses it (a big body costs the parse and the
 * validation before any refusal, and the Free plan kills the Worker for it: 1102).
 *
 * - `Content-Encoding` other than `identity`: 415. Nothing here decompresses a request, and nothing must: the
 *   ceiling would count compressed bytes and the expansion would have no end.
 * - `Content-Length` that is not one integer in digits: 400. A declared size above the ceiling: 413 without
 *   reading the body (it is cancelled).
 * - Any body: counted as it is read, even with a `Content-Length` (the client states it, so it proves nothing).
 *   The first byte past the ceiling ends the read and the answer is the 413, whatever the handler made of it.
 *
 * The answers are fixed: the code, no size or ceiling, `no-store`.
 */
export function createBodyLimitMiddleware({
  maxBytes,
  onRefusal,
}: BodyLimitOptions): MiddlewareHandler<ServerEnv> {
  const refuse = (
    context: Context<ServerEnv>,
    refusal: BodyRefusal,
    detail: BodyRefusalDetail
  ): Response => {
    onRefusal?.(context, refusal, detail);
    return context.json(
      { error: { code: refusal }, requestId: context.get("requestId") },
      STATUS[refusal],
      { "Cache-Control": "no-store" }
    );
  };

  return async (context, next) => {
    const request = context.req.raw;
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      await next();
      return;
    }

    const encoding = request.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      await request.body?.cancel().catch(() => undefined);
      return refuse(context, "unsupported_content_encoding", {
        declared: null,
      });
    }

    const declared = declaredLength(request);
    if (declared === "invalid") {
      await request.body?.cancel().catch(() => undefined);
      return refuse(context, "invalid_content_length", { declared: null });
    }
    if (declared !== null && declared > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      return refuse(context, "payload_too_large", {
        cut: "declared",
        declared,
      });
    }
    if (request.body === null) {
      await next();
      return;
    }

    let exceeded = false;
    context.req.raw = new Request(request, {
      body: limitedStream(request.body, maxBytes, () => {
        exceeded = true;
      }),
      duplex: "half",
    } as RequestInit);
    await next();
    if (exceeded) {
      // the handler already finalized its own answer (a 400 for a body that did not parse): a returned response
      // would be ignored, so the 413 takes its place by assignment
      context.res = refuse(context, "payload_too_large", {
        cut: "stream",
        declared,
      });
    }
  };
}
