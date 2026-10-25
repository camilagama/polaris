import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import {
  buildRefundWindowView,
  type RawRefundWindow,
  RefundWindowReadRefusedError,
} from "@polaris/domain/admin/refund-window";
import { describeError } from "@polaris/observability/wide-event";
import { Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import { readBody, sameOrigin, UUID } from "./support-routes";

/**
 * The window of the right of withdrawal of one store, for the support that answers a refund asked by e-mail (ADR 0104,
 * decisions 8 and 10; the Pix roteiro of R-1). One JSON route and no screen. The read writes an audit row, so it is a
 * POST with a small JSON body and a same-origin check (ADR 0072), and it asks for `billing:operate`. The operator
 * comes from the verified login, never from the body. The checks (active operator, open case of the same store) and
 * the audit belong to the database function, in one transaction; the window is computed here with the product's
 * `refundWindowOf`, on the database clock. A refusal is one answer for a closed case, a case of another store and an
 * inactive operator. Nothing of the answer is logged here.
 */

export interface RefundWindowDependencies {
  read: (
    principalId: string,
    caseId: string,
    organizationId: string,
    bindings: AdminBindings
  ) => Promise<RawRefundWindow>;
}

const MAX_ID_LENGTH = 128;

function plainText(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

export function refundWindowRoutes(
  dependencies: RefundWindowDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);

  routes.onError((error, context) => {
    if (error instanceof RefundWindowReadRefusedError) {
      // a refused attempt leaves no audit row (the transaction is undone), so it is at least in the operator's log
      report("refund_window_read_refused");
      return context.json({ error: "refund_window_read_refused" }, 403);
    }
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });

  routes.post(
    "/support-cases/:caseId/refund-window",
    requireCapability("billing:operate"),
    async (context) => {
      const caseId = context.req.param("caseId") ?? "";
      if (!UUID.test(caseId)) {
        return context.json({ error: "not_found" }, 404);
      }
      const body = await readBody(context);
      const organizationId = body?.organizationId;
      if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        organizationId.length > MAX_ID_LENGTH ||
        !plainText(organizationId)
      ) {
        return context.json({ error: "invalid_request" }, 400);
      }
      const raw = await dependencies.read(
        context.get("principal").id,
        caseId.toLowerCase(),
        organizationId,
        context.env
      );
      return context.json(buildRefundWindowView(raw));
    }
  );

  return routes;
}
