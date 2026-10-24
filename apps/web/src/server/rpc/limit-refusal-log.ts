import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import { logger, opaqueId } from "@polaris/observability/logger";
import type { createTenantRequestContext } from "../tenant-request-context";

type TenantRunner = ReturnType<typeof createTenantRequestContext>;

/** The organization of a refusal, as the server's transaction identity named it (never what the client asked for). */
const refusedOrganizations = new WeakMap<object, string>();

/**
 * Wraps the tenant runner so a plan-limit refusal remembers the organization the transaction authorized.
 * The error itself carries no organization, and the id in the request input is only the one requested.
 */
export function rememberLimitRefusals(run: TenantRunner): TenantRunner {
  return (input) =>
    run({
      ...input,
      operation: async (transaction, identity) => {
        try {
          return await input.operation(transaction, identity);
        } catch (error) {
          if (error instanceof EntitlementLimitReachedError) {
            refusedOrganizations.set(error, identity.organizationId);
          }
          throw error;
        }
      },
    });
}

/**
 * One countable line per plan-limit refusal of an RPC call (any procedure whose transaction throws `EntitlementLimitReachedError`: the registration and the variants; the images leave through the media route, which is not covered): the rule's name, the
 * request and the organization (left out when the error did not pass through the tenant runner), and nothing of the product, the person or the body. The error carries the
 * refusal as its `cause` (see `clientRpcError`).
 */
export function logLimitRefusal(error: unknown, requestId: string | undefined) {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (!(cause instanceof EntitlementLimitReachedError)) {
    return;
  }
  logger.warn("entitlement_limit_reached", {
    // `key` alone is masked by the redaction policy (a bare `key` is a secret): the rule name goes as `limitKey`
    limitKey: cause.key,
    organizationId: opaqueId(refusedOrganizations.get(cause)),
    requestId,
  });
}
