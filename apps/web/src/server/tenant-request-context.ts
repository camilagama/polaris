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
  session: { createdAt: Date | string; id: string };
  user: { emailVerified?: boolean; id: string };
}

export interface TenantRequestContextDependencies
  extends AuthenticatedRequestContextDependencies {
  withAuthorizedTenantTransaction: typeof withAuthorizedTenantTransaction;
}

export interface TenantRequestContextInput<T> {
  bindings: WorkerBindings;
  capability: string;
  isolationLevel?: "read committed" | "repeatable read";
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
            ...(input.isolationLevel
              ? { isolationLevel: input.isolationLevel }
              : {}),
            requestedOrganizationId: input.requestedOrganizationId,
            sessionId: session.session.id,
          },
          input.operation
        );
      },
      request: input.request,
    });
  };
}

/** Runs one tenant transaction of a sequence, authorized again on its own (membership, capability, organization). */
export type TenantTransactionRunner = <T>(
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
) => Promise<T>;

interface TenantRequestSequenceInput<T>
  extends Omit<TenantRequestContextInput<T>, "isolationLevel" | "operation"> {
  operation: (inTransaction: TenantTransactionRunner) => Promise<T>;
}

/**
 * One authenticated request that runs SEVERAL tenant transactions one after another (the rows of an import, each in
 * its own transaction): the session is read once, and each transaction checks the membership, the capability and
 * the organization again, as a request of its own would. An error of one transaction rolls back only that one; the
 * operation decides whether it stops the sequence.
 */
export function createTenantRequestSequence(
  overrides: Partial<TenantRequestContextDependencies> = {}
) {
  const authenticatedRequest = createAuthenticatedRequestContext(overrides);
  const tenantTransaction =
    overrides.withAuthorizedTenantTransaction ??
    withAuthorizedTenantTransaction;

  return function runTenantRequestSequence<T>(
    input: TenantRequestSequenceInput<T>
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
        return input.operation((operation) =>
          tenantTransaction(
            database as Database,
            {
              authenticatedUserId: session.user.id,
              capability: input.capability,
              requestedOrganizationId: input.requestedOrganizationId,
              sessionId: session.session.id,
            },
            operation
          )
        );
      },
      request: input.request,
    });
  };
}

export const withTenantRequestContext = createTenantRequestContext();
export const withTenantRequestSequence = createTenantRequestSequence();
