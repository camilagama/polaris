import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { and, eq, sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import type { createRlsPocDatabase } from "./rls-poc-client";
import { memberships, organizations } from "./schema/organization";

type PocDatabase = ReturnType<typeof createRlsPocDatabase>["db"];
type Database = ReturnType<typeof createDatabase>["db"];

export type TenantTransaction = Parameters<
  Parameters<PocDatabase["transaction"]>[0]
>[0];

export type TenantRequestTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface TenantRequestIdentity {
  capability: string;
  organizationId: string;
  role: string;
  userId: string;
}

export interface AuthorizedTenantTransactionInput {
  authenticatedUserId: string;
  capability: string;
  requestedOrganizationId: string;
}

export type TenantAuthorizationErrorCode =
  | "tenant_access_denied"
  | "capability_denied";

export class TenantAuthorizationError extends Error {
  readonly code: TenantAuthorizationErrorCode;

  constructor(code: TenantAuthorizationErrorCode) {
    super(code);
    this.code = code;
    this.name = "TenantAuthorizationError";
  }
}

/**
 * Runs the synthetic PR11 RLS fixture callback with transaction-local scope.
 * This helper is for the isolated POC table; product tenant queries use
 * withAuthorizedTenantTransaction below.
 */
export function withRlsPocTransaction<T>(
  database: PocDatabase,
  organizationId: string,
  operation: (transaction: TenantTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('app.organization_id', ${organizationId}, true)`
    );

    return operation(transaction);
  });
}

/**
 * The caller must pass the user ID from a server-verified Better Auth session.
 * The requested organization ID is untrusted context and is authorized here.
 * Membership, capability, organization status, and tenant work share one
 * transaction. The organization GUC is not set until membership and capability
 * have passed.
 */
export function withAuthorizedTenantTransaction<T>(
  database: Database,
  input: AuthorizedTenantTransactionInput,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  const { authenticatedUserId, capability, requestedOrganizationId } = input;

  if (
    !authenticatedUserId.trim() ||
    authenticatedUserId !== authenticatedUserId.trim() ||
    !requestedOrganizationId.trim() ||
    requestedOrganizationId !== requestedOrganizationId.trim()
  ) {
    return Promise.reject(new TenantAuthorizationError("tenant_access_denied"));
  }

  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('app.user_id', ${authenticatedUserId}, true)`
      );

      const [membership] = await transaction
        .select({
          role: memberships.role,
          status: memberships.status,
        })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, requestedOrganizationId),
            eq(memberships.userId, authenticatedUserId)
          )
        )
        .limit(1);

      if (membership?.status !== "active") {
        return Promise.reject(
          new TenantAuthorizationError("tenant_access_denied")
        );
      }

      if (!hasCapabilityForRole(membership.role, capability)) {
        throw new TenantAuthorizationError("capability_denied");
      }

      await transaction.execute(
        sql`SELECT set_config('app.organization_id', ${requestedOrganizationId}, true)`
      );

      const [organization] = await transaction
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, requestedOrganizationId))
        .limit(1);

      if (organization?.status !== "active") {
        return Promise.reject(
          new TenantAuthorizationError("tenant_access_denied")
        );
      }

      return operation(transaction, {
        capability,
        organizationId: requestedOrganizationId,
        role: membership.role,
        userId: authenticatedUserId,
      });
    },
    { isolationLevel: "read committed" }
  );
}
