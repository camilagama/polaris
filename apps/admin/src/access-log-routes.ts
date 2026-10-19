import type { AccessLogReadResult } from "@polaris/db/admin-access-log-repository";
import {
  InvalidAccessLogRequestError,
  normalizeAccessLogRequest,
} from "@polaris/domain/admin/access-log";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { describeError } from "@polaris/observability/wide-event";
import { Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import { readBody, sameOrigin } from "./support-routes";

/**
 * The access log in the Admin (ADR 0092): one JSON route and no screen. It answers a court order: the case number in
 * the CNJ format, one user or one IP, a window of at most 31 days, a page at a time. Reading asks for
 * `access_log:read`, takes the operator from the verified login, and leaves the checks and the audit to a database
 * function (one transaction). The request is a POST so that the IP, the user and the case number travel in the body,
 * not in a URL that an access log would keep. Nothing of the answer is logged here.
 */

export interface AccessLogDependencies {
  read: (
    principalId: string,
    request: ReturnType<typeof normalizeAccessLogRequest>,
    bindings: AdminBindings
  ) => Promise<AccessLogReadResult>;
}

export function accessLogRoutes(
  dependencies: AccessLogDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);
  const canRead = requireCapability("access_log:read");

  routes.onError((error, context) => {
    if (error instanceof InvalidAccessLogRequestError) {
      return context.json({ error: error.code }, 400);
    }
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });

  routes.post("/access-log/read", canRead, async (context) => {
    const body = await readBody(context);
    if (!body) {
      return context.json({ error: "invalid_request" }, 400);
    }
    const request = normalizeAccessLogRequest(body);
    const answer = await dependencies.read(
      context.get("principal").id,
      request,
      context.env
    );
    return answer.result === "ok"
      ? context.json({ entries: answer.entries, next: answer.next })
      : context.json({ error: answer.result }, 400);
  });

  return routes;
}
