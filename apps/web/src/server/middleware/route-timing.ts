import { connectionsClosedByUs } from "@polaris/db/pool-errors";
import { isCriticalRoute } from "@polaris/observability/alerts";
import { startWideEvent } from "@polaris/observability/wide-event";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
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
 * so a path the client made up never reaches the log.
 */
export function markMatchedProcedure(
  context: Parameters<MiddlewareHandler<ServerEnv>>[0]
) {
  context.set("timedProcedure", context.req.path);
}

/**
 * `ROUTE_TIMING_ALL` = `"true"` (staging only, CPU-1e, ADR 0094 amended on 26/10/2026) widens the event to every
 * `/rpc` procedure and every named `/api` route, so a route can be measured by `isolate.seq` against another one in
 * the same deploy. The label is still a pattern: a `/rpc` path is logged only when oRPC matched a procedure
 * (`markMatchedProcedure`), and an `/api` path only when a route of the app named it (not the `/api/*` of a
 * middleware). A request refused before the handler (origin, rate limit) or that matched nothing emits nothing.
 * Any other value of the variable, or none, keeps the critical routes only.
 */
function wideRouteLabel(
  context: Parameters<MiddlewareHandler<ServerEnv>>[0],
  label: string
) {
  if (context.env?.ROUTE_TIMING_ALL !== "true") {
    return null;
  }
  if (context.req.path.startsWith("/rpc/")) {
    return context.get("timedProcedure") === label ? label : null;
  }
  if (!context.req.path.startsWith("/api/")) {
    return null;
  }
  try {
    const pattern = routePath(context, -1);
    return pattern.startsWith("/api/") && pattern !== "/api/*" ? pattern : null;
  } catch {
    return null;
  }
}

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
      const route = isCriticalRoute(label)
        ? label
        : wideRouteLabel(context, label);
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
