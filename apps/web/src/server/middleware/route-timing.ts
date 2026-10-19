import { isCriticalRoute } from "@polaris/observability/alerts";
import { startWideEvent } from "@polaris/observability/wide-event";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { ServerEnv } from "../environment";

/**
 * The latency signal of the alerts (PR119, ADR 0095): one `http_request_timed` wide event per request to a
 * critical route (`criticalRoutes` in the observability package), with `route`, `method`, `httpStatus` and
 * `durationMs` (wall-clock time). Other routes emit nothing, so the volume in the Workers Logs stays small
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
  const wide = startWideEvent("http_request_timed", {
    method: context.req.method,
    requestId: context.get("requestId"),
  });
  try {
    await next();
  } finally {
    try {
      const route = routeLabel(context);
      if (isCriticalRoute(route)) {
        const httpStatus = context.res.status;
        wide.set({ httpStatus, route });
        wide.emit(outcomeOf(httpStatus));
      }
    } catch {
      // a diagnostic must never replace the answer (or the error) of the request
    }
  }
};
