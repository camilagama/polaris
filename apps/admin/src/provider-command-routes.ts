import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import { normalizeOperatorReason } from "@polaris/domain/billing/operator-commands";
import { describeError } from "@polaris/observability/wide-event";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import type {
  CancelOutcome,
  ProviderCommandResult,
  RefundOutcome,
} from "./provider-commands";
import { InvalidOperatorReasonError } from "./provider-commands";
import { readBody, sameOrigin, UUID } from "./support-routes";

/**
 * The operator's provider commands (ADR 0105), two JSON routes under an open support case. The store is always the
 * case's, never one named by the body; a closed or unknown case is a 404 and nothing is recorded or done. The body
 * carries the command ID the page made when it opened the confirmation (a UUID, kept until a definite answer), the
 * reason (1 to 300 characters, no control character) and, for the refund, the amount the page showed. Each result is
 * a code the page has a text for; `provider_unavailable` (503) means the outcome is unknown and the same command ID
 * may be sent again. The refund asks for `billing:refund`, which `billing:operate` alone does not give, and the
 * capability is checked before the body is read. Nothing of the provider reaches the answer or the log.
 */

export interface ProviderCommandDependencies {
  cancelRenewal: (
    principalId: string,
    caseId: string,
    command: { commandId: string; reason: string },
    bindings: AdminBindings
  ) => Promise<ProviderCommandResult<CancelOutcome>>;
  refund: (
    principalId: string,
    caseId: string,
    command: { commandId: string; expectedAmount: string; reason: string },
    bindings: AdminBindings
  ) => Promise<ProviderCommandResult<RefundOutcome>>;
}

/** An amount as `money.md` writes it, above zero, with the two decimal places the page shows. */
const AMOUNT = /^(?:0|[1-9]\d{0,8})\.\d{2}$/;
const ZERO = /^0\.00$/;

const STATUS: Readonly<Record<CancelOutcome | RefundOutcome, 200 | 409 | 503>> =
  {
    already_cancelled: 200,
    amount_changed: 409,
    amount_mismatch: 409,
    cancelled: 200,
    command_in_progress: 409,
    not_linked: 409,
    nothing_to_cancel: 200,
    nothing_to_refund: 200,
    provider_unavailable: 503,
    refund_not_supported: 409,
    refund_requested: 200,
  };

function answer(
  context: Context<AdminEnv>,
  outcome: ProviderCommandResult<CancelOutcome | RefundOutcome>
) {
  const status = STATUS[outcome.result];
  return context.json(
    status === 200
      ? { outcomeRecorded: outcome.outcomeRecorded, result: outcome.result }
      : {
          error: outcome.result,
          outcomeRecorded: outcome.outcomeRecorded,
          result: outcome.result,
        },
    status
  );
}

/** The command ID and the reason every command needs, or null when the body does not carry them as asked. */
function commandOf(
  body: Record<string, unknown> | null
): { commandId: string; reason: string } | null {
  if (
    !body ||
    typeof body.commandId !== "string" ||
    !UUID.test(body.commandId) ||
    typeof body.reason !== "string" ||
    normalizeOperatorReason(body.reason) === null
  ) {
    return null;
  }
  return { commandId: body.commandId.toLowerCase(), reason: body.reason };
}

export function providerCommandRoutes(
  dependencies: ProviderCommandDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);

  routes.onError((error, context) => {
    if (error instanceof InvalidOperatorReasonError) {
      return context.json({ error: "invalid_request" }, 400);
    }
    if (error instanceof InvalidSupportRequestError) {
      if (error.code === "operator_refund_rate_limited") {
        // the operator's id, not a customer's: who is refunding this much is what the alert is for
        report("operator_refund_rate_limited");
        return context.json({ error: "rate_limited" }, 429);
      }
      if (error.code === "case_not_open" || error.code === "unknown_case") {
        return context.json({ error: "not_found" }, 404);
      }
      return context.json({ error: "invalid_request" }, 400);
    }
    if (
      error instanceof ProviderNotConfiguredError ||
      (error instanceof Error && error.message === "admin_not_configured")
    ) {
      // a secret or a setting of the provider is missing in this deployment: nothing was asked of it
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });

  routes.post(
    "/support-cases/:caseId/billing/cancel-renewal",
    requireCapability("billing:operate"),
    async (context) => {
      const caseId = context.req.param("caseId") ?? "";
      if (!UUID.test(caseId)) {
        return context.json({ error: "not_found" }, 404);
      }
      const command = commandOf(await readBody(context));
      if (!command) {
        return context.json({ error: "invalid_request" }, 400);
      }
      return answer(
        context,
        await dependencies.cancelRenewal(
          context.get("principal").id,
          caseId.toLowerCase(),
          command,
          context.env
        )
      );
    }
  );

  routes.post(
    "/support-cases/:caseId/billing/refund",
    requireCapability("billing:refund"),
    async (context) => {
      const caseId = context.req.param("caseId") ?? "";
      if (!UUID.test(caseId)) {
        return context.json({ error: "not_found" }, 404);
      }
      const body = await readBody(context);
      const command = commandOf(body);
      const expectedAmount = body?.expectedAmount;
      if (
        !command ||
        typeof expectedAmount !== "string" ||
        !AMOUNT.test(expectedAmount) ||
        ZERO.test(expectedAmount)
      ) {
        return context.json({ error: "invalid_request" }, 400);
      }
      return answer(
        context,
        await dependencies.refund(
          context.get("principal").id,
          caseId.toLowerCase(),
          { ...command, expectedAmount },
          context.env
        )
      );
    }
  );

  return routes;
}
