import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";

const REQUEST_ID_HEADER = "X-Request-Id";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Correlates logs and audit rows. A client-supplied identifier is accepted only
 * when it is a well-formed UUID; anything else is replaced by a server-generated
 * UUID so arbitrary client text never reaches logs, audit rows or responses.
 * Every response carries it: it is also how the client tells the Worker's answer
 * from a captive portal's or a proxy's (emenda do ADR 0043).
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
  // A route that hands back its own Response (Better Auth, a redirect) skips the header above. The client
  // takes an answer for the Worker's only by this mark (emenda do ADR 0043), so every response carries it.
  if (context.res.headers.get(REQUEST_ID_HEADER) !== requestId) {
    try {
      context.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // immutable headers (`Response.redirect`, a fetched response): the same response, with headers of its own
      context.res = new Response(context.res.body, context.res);
      context.res.headers.set(REQUEST_ID_HEADER, requestId);
    }
  }
};
