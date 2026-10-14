import type { createDatabase } from "@polaris/db/client";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import {
  type AuthenticatedRequestContextDependencies,
  createAuthenticatedRequestContext,
} from "./authenticated-request-context";
import type { WorkerBindings } from "./environment";
import { TenantRequestContextError } from "./request-context-error";

type Database = ReturnType<typeof createDatabase>["db"];

export interface TenantRequestSession {
  user: { emailVerified?: boolean; id: string };
}

export interface TenantRequestContextDependencies
  extends AuthenticatedRequestContextDependencies {
  withAuthorizedTenantTransaction: typeof withAuthorizedTenantTransaction;
}

export interface TenantRequestContextInput<T> {
  bindings: WorkerBindings;
  capability: string;
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>;
  request: Request;
  requestedOrganizationId: string;
}

export function createTenantRequestContext(
  overrides: Partial<TenantRequestContextDependencies> = {}
) {
  const authenticatedRequest = createAuthenticatedRequestContext(overrides);
  const tenantTransaction =
    overrides.withAuthorizedTenantTransaction ??
    withAuthorizedTenantTransaction;

  return function runTenantRequestContext<T>(
    input: TenantRequestContextInput<T>
  ): Promise<T> {
    return authenticatedRequest({
      bindings: input.bindings,
      operation: (database, session) => {
        if (
          !input.requestedOrganizationId.trim() ||
          input.requestedOrganizationId !== input.requestedOrganizationId.trim()
        ) {
          throw new TenantRequestContextError("organization_id_required");
        }

        return tenantTransaction(
          database as Database,
          {
            authenticatedUserId: session.user.id,
            capability: input.capability,
            requestedOrganizationId: input.requestedOrganizationId,
          },
          input.operation
        );
      },
      request: input.request,
    });
  };
}

export const withTenantRequestContext = createTenantRequestContext();
