import { getDataExportDownload } from "@polaris/db/data-export-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { DataExportUnavailableError } from "@polaris/domain/privacy/data-export";
import { type Context, Hono } from "hono";
import type { ServerEnv } from "../environment";
import { exemptRouteRequest } from "../legal-acceptance";
import {
  logServerErrorFromContext,
  logServerEvent,
} from "../observability/server-log";
import {
  requestContextErrorStatus,
  TenantRequestContextError,
} from "../request-context-error";
import { withTenantRequestContext } from "../tenant-request-context";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDINAL = /^[1-9][0-9]{0,2}$/;

export interface DataExportRouteDependencies {
  getDataExportDownload: typeof getDataExportDownload;
  withTenantRequestContext: typeof withTenantRequestContext;
}

function refusal(
  context: Context<ServerEnv>,
  status: 400 | 401 | 403 | 404 | 405 | 500 | 503,
  code: string
): Response {
  return context.json(
    { error: { code }, requestId: context.get("requestId") },
    status,
    // a refusal is never kept by a cache either
    { "Cache-Control": "private, no-store" }
  );
}

/** What a failed download answers: never why an export is unavailable, and never a cause. */
function failureResponse(
  context: Context<ServerEnv>,
  error: unknown
): Response {
  if (error instanceof DataExportUnavailableError) {
    return refusal(context, 404, "not_found");
  }
  if (error instanceof TenantRequestContextError) {
    const status = requestContextErrorStatus(error.code);
    if (status === 503) {
      logServerErrorFromContext(context, error, status);
    }
    return refusal(context, status, error.code);
  }
  if (error instanceof TenantAuthorizationError) {
    return refusal(
      context,
      403,
      error.code === "capability_denied" ? "forbidden" : "tenant_access_denied"
    );
  }
  logServerErrorFromContext(context, error, 500);
  return refusal(context, 500, "internal_error");
}

/**
 * The download of a finished data export (ADR 0078). The file is a private object that the
 * browser never gets a link to: the Worker checks the session, the membership and the capability
 * of the person who asks, the state and the expiry of the export, and then streams the object.
 * It is audited, never cached, and named by the date, never by the organization.
 */
export function createDataExportRoutes(
  overrides: Partial<DataExportRouteDependencies> = {}
): Hono<ServerEnv> {
  const download = overrides.getDataExportDownload ?? getDataExportDownload;
  const tenantRequest =
    overrides.withTenantRequestContext ?? withTenantRequestContext;
  const app = new Hono<ServerEnv>();

  app.get("/api/data-exports/:exportId/files/:ordinal", async (context) => {
    // a HEAD request would run the download (and audit it) without handing the file over
    if (context.req.method === "HEAD") {
      return refusal(context, 405, "method_not_allowed");
    }
    const exportId = context.req.param("exportId");
    const ordinal = context.req.param("ordinal");
    const organizationId = context.req.query("organizationId") ?? "";
    // A malformed identifier can never name an export; answer before opening a transaction.
    if (!(UUID.test(exportId) && ORDINAL.test(ordinal))) {
      return refusal(context, 404, "not_found");
    }
    if (!organizationId.trim() || organizationId !== organizationId.trim()) {
      return refusal(context, 400, "organization_id_required");
    }
    const bucket = context.env.MEDIA_BUCKET;
    if (!bucket) {
      return refusal(context, 503, "export_storage_unavailable");
    }
    // a copy of the data is a request of the data subject: it never waits for the legal acceptance (ADR 0100)
    exemptRouteRequest(
      context.req.raw,
      "/api/data-exports/:exportId/files/:ordinal"
    );
    try {
      const file = await tenantRequest({
        bindings: context.env,
        capability: "organization:export",
        operation: (transaction, identity) =>
          download(transaction, identity, {
            exportId,
            ordinal: Number(ordinal),
            requestId: context.get("requestId"),
          }),
        request: context.req.raw,
        requestedOrganizationId: organizationId,
      });
      const object = await bucket.get(file.storageKey);
      if (!object) {
        // the export says it is ready and the object is gone: that is the system's fault, not the caller's
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
