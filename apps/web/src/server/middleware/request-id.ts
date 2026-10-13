import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";

const REQUEST_ID_HEADER = "X-Request-Id";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Correlates logs and audit rows. A client-supplied identifier is accepted only
 * when it is a well-formed UUID; anything else is replaced by a server-generated
 * UUID so arbitrary client text never reaches logs, audit rows or responses.
 */
export const requestIdMiddleware: MiddlewareHandler<ServerEnv> = async (
  context,
  next
) => {
  const supplied = context.req.header(REQUEST_ID_HEADER);
  const requestId =
    supplied !== undefined && uuidPattern.test(supplied)
      ? supplied.toLowerCase()
      : crypto.randomUUID();

  context.set("requestId", requestId);
  context.header(REQUEST_ID_HEADER, requestId);
  await next();
};
