import { connectionsClosedByUs } from "@polaris/db/pool-errors";
import { isCriticalRoute } from "@polaris/observability/alerts";
import { startWideEvent } from "@polaris/observability/wide-event";
import type { MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import type { ServerEnv } from "../environment";
import { countIsolateInvocation } from "../observability/isolate";

/**
 * The latency signal of the alerts (PR119, ADR 0095): one `http_request_timed` wide event per request to a
 * critical route (`criticalRoutes` in the observability package), with `route`, `method`, `httpStatus`,
 * `durationMs` (wall-clock time) and `isolate` (CPU-1d): its random `id`, the `seq` of this request among the
 * invocations of the isolate (1 is the first one, of any kind: the cold one) and `closedByUs`, the running count of
 * the connection errors the isolate dropped as the close of a connection it was ending itself (`pool-errors.ts` of
 * the db package; the pools of this request close after the event, so they show in the next one). Every request
 * counts in `seq`, logged or not. Other routes emit nothing, so the volume in the Workers Logs stays small
 * (ADR 0094). The route is a pattern, never the URL: an oRPC call is `/rpc/<procedure>` (the arguments travel in
 * the body); anything that is not a critical route is not logged.
 */
function routeLabel(context: Parameters<MiddlewareHandler<ServerEnv>>[0]) {
  const { path } = context.req;
  if (path.startsWith("/rpc/")) {
    return path;
  }
  try {
    return routePath(context, -1);
  } catch {
    return path;
  }
}

/**
 * Called by the `/rpc` handler when oRPC matched a procedure: under `ROUTE_TIMING_ALL` only such a path is logged,
 * so a path the client made up never reaches the log. The label is the path as oRPC matched it, which takes one
 * slash off each end of what follows the prefix (`/rpc/sale/list/` and `/rpc//sale/list` are `/rpc/sale/list`).
 */
export function markMatchedProcedure(
  context: Parameters<MiddlewareHandler<ServerEnv>>[0]
) {
  const procedure = context.req.path
    .slice("/rpc".length)
    .replace(/^\/|\/$/g, "");
  context.set("timedProcedure", `/rpc/${procedure}`);
}

/**
 * The pattern of the route that answered, or `null` when the request stopped in a middleware. `routePath(context, -1)`
 * is the last route that matched, run or not; `routePath(context)` is the one the request reached last, but a
 * middleware can share the pattern of its handler (as a limit of the media upload would), so a route counts
 * only when it is not an `app.use` one (`method` `ALL`; an `app.all` handler is not labelled either, the safe side).
 */
function handlerPattern(context: Parameters<MiddlewareHandler<ServerEnv>>[0]) {
  const reached = matchedRoutes(context).at(context.req.routeIndex);
  return reached === undefined || reached.method === "ALL"
    ? null
    : reached.path;
}

/**
 * `ROUTE_TIMING_ALL` = `"true"` (staging only, ADR 0094 amended) widens the event to every
 * `/rpc` procedure and every named `/api` route, so a route can be measured by `isolate.seq` against another one in
 * the same deploy. The label is still a pattern: a `/rpc` path is logged only when oRPC matched a procedure
 * (`markMatchedProcedure`), and an `/api` path only when a route of the app named it (not the `/api/*` of a
 * middleware, and only when the request reached its handler: `handlerPattern`). A request refused before the handler
 * (origin, rate limit) or that matched nothing emits nothing.
 * Any other value of the variable, or none, keeps the critical routes only.
 */
function wideRouteLabel(context: Parameters<MiddlewareHandler<ServerEnv>>[0]) {
  if (context.env?.ROUTE_TIMING_ALL !== "true") {
    return null;
  }
  if (context.req.path.startsWith("/rpc/")) {
    return context.get("timedProcedure") ?? null;
  }
  if (!context.req.path.startsWith("/api/")) {
    return null;
  }
  try {
    const pattern = handlerPattern(context);
    return pattern?.startsWith("/api/") &&
      pattern !== "/api/*" &&
      !UNTIMED_API_ROUTES.has(pattern)
      ? pattern
      : null;
  } catch {
    return null;
  }
}

/**
 * Never timed, not even under `ROUTE_TIMING_ALL`: the reports of errors of the browser are public and refused in
 * their own handlers, so a timed line per request would be the line per refusal that their log budget forbids
 * (`client-error-log.ts`).
 */
const UNTIMED_API_ROUTES: ReadonlySet<string> = new Set(["/api/client-errors"]);

function outcomeOf(httpStatus: number): "failure" | "rejected" | "success" {
  if (httpStatus >= 500) {
    return "failure";
  }
  return httpStatus >= 400 ? "rejected" : "success";
}

export const routeTimingMiddleware: MiddlewareHandler<ServerEnv> = async (
  context,
  next
) => {
  const isolate = countIsolateInvocation();
  const wide = startWideEvent("http_request_timed", {
    method: context.req.method,
    requestId: context.get("requestId"),
  });
  try {
    await next();
  } finally {
    try {
      const label = routeLabel(context);
      const route = isCriticalRoute(label) ? label : wideRouteLabel(context);
      if (route !== null) {
        const httpStatus = context.res.status;
        wide.set({
          httpStatus,
          isolate: {
            closedByUs: connectionsClosedByUs(),
            id: isolate.id,
            seq: isolate.seq,
          },
          route,
        });
        wide.emit(outcomeOf(httpStatus));
      }
    } catch {
      // a diagnostic must never replace the answer (or the error) of the request
    }
  }
};
