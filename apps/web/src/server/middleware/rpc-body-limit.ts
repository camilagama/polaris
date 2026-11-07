import { logger } from "@polaris/observability/logger";
import { createBodyLimitMiddleware } from "./body-limit";
import { rpcRoute } from "./rate-limit";

/**
 * The largest body `/rpc` reads: the biggest single input is one `sync.push` command, at most
 * `OUTBOX_MAX_PAYLOAD_BYTES` (256 KiB) of payload plus its envelope (~262 KiB), and the largest input of any
 * other procedure is below that; the sync closes its batches at 400 KiB (`PUSH_BATCH_TARGET_BYTES`). The
 * derivation test (`rpc-body-limit-derivation.test.ts`) fails if the outbox ceiling or a contract input outgrows it.
 */
export const RPC_BODY_MAX_BYTES = 512 * 1024;

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
 * The size and the encoding of the body of an RPC call (`createBodyLimitMiddleware` with the ceiling of `/rpc`). It
 * runs after the origin check and the rate limit, so a refusal here still counts in the bucket of the procedure's
 * kind. A body too large is logged (`rpc_payload_too_large`, with the band of the declared size and the route); the
 * 400 and the 415 are not.
 */
export const rpcBodyLimitMiddleware = createBodyLimitMiddleware({
  maxBytes: RPC_BODY_MAX_BYTES,
  onRefusal: (context, refusal, { cut, declared }) => {
    if (refusal !== "payload_too_large") {
      return;
    }
    logger.warn("rpc_payload_too_large", {
      cut,
      declared: declaredBand(declared),
      requestId: context.get("requestId"),
      route: rpcRoute(context.req.raw),
    });
  },
});
