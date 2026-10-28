import { logger } from "@polaris/observability/logger";
import type { Context, MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";
import { rpcRoute } from "./rate-limit";

/**
 * The largest body `/rpc` reads: the biggest single input is one `sync.push` command, at most
 * `OUTBOX_MAX_PAYLOAD_BYTES` (256 KiB) of payload plus its envelope (~262 KiB), and the largest input of any
 * other procedure is below that; the sync closes its batches at 400 KiB (`PUSH_BATCH_TARGET_BYTES`). The
 * derivation test (`rpc-body-limit.test.ts`) fails if the outbox ceiling or a contract input outgrows it.
 */
export const RPC_BODY_MAX_BYTES = 512 * 1024;

const DIGITS = /^\d+$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const KIB = 1024;
const MIB = 1024 * KIB;

/** The size a request declared, as a band: never the number, so the log says how far over without a measure to copy. */
function declaredBand(declared: number | null): string {
  if (declared === null) {
    return "absent";
  }
  if (declared <= RPC_BODY_MAX_BYTES) {
    return "within_limit";
  }
  if (declared <= MIB) {
    return "up_to_1MiB";
  }
  if (declared <= 8 * MIB) {
    return "up_to_8MiB";
  }
  if (declared <= 64 * MIB) {
    return "up_to_64MiB";
  }
  return "above_64MiB";
}

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

function refuse(
  context: Context<ServerEnv>,
  status: 400 | 413 | 415,
  code: string
): Response {
  return context.json(
    { error: { code }, requestId: context.get("requestId") },
    status,
    { "Cache-Control": "no-store" }
  );
}

function tooLarge(
  context: Context<ServerEnv>,
  declared: number | null,
  cut: "declared" | "stream"
): Response {
  logger.warn("rpc_payload_too_large", {
    cut,
    declared: declaredBand(declared),
    requestId: context.get("requestId"),
    route: rpcRoute(context.req.raw),
  });
  return refuse(context, 413, "payload_too_large");
}

/** The body, passed on as it is read: it errors the moment it goes past the ceiling, and nothing is kept. */
function limitedStream(
  body: ReadableStream<Uint8Array>,
  onExceeded: () => void
): ReadableStream<Uint8Array> {
  let read = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.byteLength;
        if (read > RPC_BODY_MAX_BYTES) {
          onExceeded();
          controller.error(new Error("rpc_body_too_large"));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

/**
 * The size and the encoding of the body of an RPC call, before anything parses it (a big body costs the JSON
 * parse and the validation before any refusal, and the Free plan kills the Worker for it: 1102). It runs after
 * the origin check and the rate limit, so a refusal here still counts in the bucket of the procedure's kind.
 *
 * - `Content-Encoding` other than `identity`: 415. Nothing in `/rpc` decompresses a request, and nothing must:
 *   the ceiling would count compressed bytes and the expansion would have no end.
 * - `Content-Length` that is not one integer in digits: 400. A declared size above the ceiling: 413 without
 *   reading the body (it is cancelled).
 * - Any body: counted as it is read, even with a `Content-Length` (the client states it, so it proves nothing).
 *   The first byte past the ceiling ends the read and the answer is the 413, whatever the handler made of it.
 *
 * The 413 is fixed: `payload_too_large`, no size or ceiling, `no-store`.
 */
export const rpcBodyLimitMiddleware: MiddlewareHandler<ServerEnv> = async (
  context,
  next
) => {
  const request = context.req.raw;
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    await next();
    return;
  }

  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    await request.body?.cancel().catch(() => undefined);
    return refuse(context, 415, "unsupported_content_encoding");
  }

  const declared = declaredLength(request);
  if (declared === "invalid") {
    await request.body?.cancel().catch(() => undefined);
    return refuse(context, 400, "invalid_content_length");
  }
  if (declared !== null && declared > RPC_BODY_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge(context, declared, "declared");
  }
  if (request.body === null) {
    await next();
    return;
  }

  let exceeded = false;
  context.req.raw = new Request(request, {
    body: limitedStream(request.body, () => {
      exceeded = true;
    }),
    duplex: "half",
  } as RequestInit);
  await next();
  if (exceeded) {
    // the handler already finalized its own answer (a 400 for a body that did not parse): a returned response
    // would be ignored, so the 413 takes its place by assignment
    context.res = tooLarge(context, declared, "stream");
  }
};
