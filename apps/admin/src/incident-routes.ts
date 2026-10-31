import { describeError } from "@polaris/observability/wide-event";
import type {
  IncidentRetryResult,
  OperationalIncidentDetail,
  OperationalIncidentPage,
} from "@polaris/db/admin-incident-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import { readBody, sameOrigin, UUID } from "./support-routes";

/**
 * Operational incidents in the Admin (plan PR111, ADR 0085): a list of the incidents (one per cause, with
 * its count and dates), one incident with its dead events, and the retry of one dead event. Reading asks
 * for `operational_incident:read`; the retry asks for its own capability, `operational_incident:retry`,
 * takes the operator from the verified login and leaves the work and the audit to a
 * database function (one transaction). Nothing here deletes a message or an event, in bulk or one by
 * one: a retry sends the same outbox event again and the consumer deduplicates. An incident holds codes,
 * counts, dates and opaque IDs, never the body of a message.
 */

export interface IncidentDependencies {
  detail: (
    incidentId: string,
    input: { after: string | null; limit: number },
    bindings: AdminBindings
  ) => Promise<OperationalIncidentDetail | null>;
  list: (
    input: { after: string | null; limit: number },
    bindings: AdminBindings
  ) => Promise<OperationalIncidentPage>;
  retry: (
    principalId: string,
    incidentId: string,
    eventId: string,
    bindings: AdminBindings
  ) => Promise<IncidentRetryResult>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

/** Which answers a retry's outcome gets: the two that succeed, and the ones that ask the operator to look again. */
const RETRY_STATUS: Readonly<Record<IncidentRetryResult, 200 | 404 | 409>> = {
  already_pending: 200,
  busy: 409,
  event_gone: 409,
  retried: 200,
  unknown_item: 404,
};

export function incidentRoutes(
  dependencies: IncidentDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);
  const canRead = requireCapability("operational_incident:read");
  const canRetry = requireCapability("operational_incident:retry");

  routes.onError((error, context) => {
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });

  const invalid = (context: Context<AdminEnv>) =>
    context.json({ error: "invalid_request" }, 400);
  const notFound = (context: Context<AdminEnv>) =>
    context.json({ error: "not_found" }, 404);
  const uuidOf = (value: string | undefined | null) =>
    value && UUID.test(value) ? value.toLowerCase() : null;
  /** `limit` and `after` of a page, or null when either is not acceptable. */
  const pageOf = (context: Context<AdminEnv>) => {
    const limit = Number(context.req.query("limit") ?? DEFAULT_PAGE_SIZE);
    const afterText = context.req.query("after") ?? null;
    const after = afterText === null ? null : uuidOf(afterText);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      (afterText !== null && after === null)
    ) {
      return null;
    }
    return { after, limit };
  };

  routes.get("/operational-incidents", canRead, async (context) => {
    const page = pageOf(context);
    if (!page) {
      return invalid(context);
    }
    return context.json(await dependencies.list(page, context.env));
  });

  routes.get("/operational-incidents/:incidentId", canRead, async (context) => {
    const incidentId = uuidOf(context.req.param("incidentId"));
    const page = pageOf(context);
    if (!page) {
      return invalid(context);
    }
    const found = incidentId
      ? await dependencies.detail(incidentId, page, context.env)
      : null;
    return found ? context.json(found) : notFound(context);
  });

  routes.post(
    "/operational-incidents/:incidentId/events/:eventId/retry",
    canRetry,
    async (context) => {
      const incidentId = uuidOf(context.req.param("incidentId"));
      const eventId = uuidOf(context.req.param("eventId"));
      const body = await readBody(context);
      if (!(incidentId && eventId && body)) {
        return invalid(context);
      }
      const result = await dependencies.retry(
        context.get("principal").id,
        incidentId,
        eventId,
        context.env
      );
      return context.json({ result }, RETRY_STATUS[result]);
    }
  );

  return routes;
}
