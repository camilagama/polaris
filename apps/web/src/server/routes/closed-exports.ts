import { getClosedDataExportDownload } from "@polaris/db/closed-organization-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { DataExportUnavailableError } from "@polaris/domain/privacy/data-export";
import { type Context, Hono } from "hono";
import { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { ServerEnv } from "../environment";
import {
  logServerErrorFromContext,
  logServerEvent,
} from "../observability/server-log";
import { TenantRequestContextError } from "../request-context-error";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDINAL = /^[1-9][0-9]{0,2}$/;

export interface ClosedExportRouteDependencies {
  getClosedDataExportDownload: typeof getClosedDataExportDownload;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
}

function refusal(
  context: Context<ServerEnv>,
  status: 401 | 403 | 404 | 405 | 500 | 503,
  code: string
): Response {
  return context.json(
    { error: { code }, requestId: context.get("requestId") },
    status,
    // a refusal is never kept by a cache either
    { "Cache-Control": "private, no-store" }
  );
}

/** What a failed download answers: never why a copy is unavailable, never whether an organization exists. */
function failureResponse(
  context: Context<ServerEnv>,
  error: unknown
): Response {
  if (error instanceof DataExportUnavailableError) {
    return refusal(context, 404, "not_found");
  }
  if (error instanceof TenantRequestContextError) {
    const status = error.code === "session_required" ? 401 : 503;
    if (status === 503) {
      logServerErrorFromContext(context, error, status);
    }
    return refusal(context, status, error.code);
  }
  if (error instanceof TenantAuthorizationError) {
    return refusal(context, 403, "tenant_access_denied");
  }
  logServerErrorFromContext(context, error, 500);
  return refusal(context, 500, "internal_error");
}

/**
 * The download of a closed organization's copy (ADR 0081 and 0078, amended). The organization no longer opens as a
 * tenant, so the Worker checks only the session; the database function checks that the user owns the export's
 * organization (someone else, or an export that does not exist: 403, the same), that the copy is a closed one, ready,
 * not expired, and that the organization is still in closure (any of those: 404, the same), and audits the download.
 * The object is streamed, never cached, named by the date. Unlike asking for the copy, a recent sign-in is not needed.
 */
export function createClosedExportRoutes(
  overrides: Partial<ClosedExportRouteDependencies> = {}
): Hono<ServerEnv> {
  const download =
    overrides.getClosedDataExportDownload ?? getClosedDataExportDownload;
  const authenticatedRequest =
    overrides.withAuthenticatedRequestContext ??
    withAuthenticatedRequestContext;
  const app = new Hono<ServerEnv>();

  app.get("/api/closed-exports/:exportId/files/:ordinal", async (context) => {
    // a HEAD request would run the download (and audit it) without handing the file over
    if (context.req.method === "HEAD") {
      return refusal(context, 405, "method_not_allowed");
    }
    const exportId = context.req.param("exportId");
    const ordinal = context.req.param("ordinal");
    // A malformed identifier can never name a copy; answer before opening a transaction.
    if (!(UUID.test(exportId) && ORDINAL.test(ordinal))) {
      return refusal(context, 404, "not_found");
    }
    const bucket = context.env.MEDIA_BUCKET;
    if (!bucket) {
      return refusal(context, 503, "export_storage_unavailable");
    }
    try {
      const file = await authenticatedRequest({
        bindings: context.env,
        operation: (database, session) =>
          download(database, session.user.id, {
            exportId,
            ordinal: Number(ordinal),
            requestId: context.get("requestId"),
          }),
        request: context.req.raw,
      });
      const object = await bucket.get(file.storageKey);
      if (!object) {
        // the copy says it is ready and the object is gone: that is the system's fault, not the caller's
        logServerEvent("data_export_object_missing", context);
        return refusal(context, 404, "not_found");
      }
      return new Response(object.body, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${file.name}"`,
          "Content-Length": String(object.size),
          "Content-Type": "application/zip",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error: unknown) {
      return failureResponse(context, error);
    }
  });

  return app;
}
