import {
  hasCapabilityForRole,
  rolesWithCapability,
} from "@polaris/domain/authorization/capabilities";
import { type SQL, sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import { raised } from "./database-refusal";
import type { createRlsPocDatabase } from "./rls-poc-client";

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
  /**
   * The id (never the token) of the verified session of the request. The
   * request handlers always pass it, so a session that uses a device is linked
   * to it; scripts and gates that have no session leave it out.
   */
  sessionId?: string;
  userId: string;
}

export interface AuthorizedTenantTransactionInput {
  authenticatedUserId: string;
  capability: string;
  /**
   * READ COMMITTED by default. Read models assembled from several queries
   * (sale detail, lists) ask for REPEATABLE READ so every query sees one snapshot.
   */
  isolationLevel?: "read committed" | "repeatable read";
  requestedOrganizationId: string;
  /** The verified session's id; see `TenantRequestIdentity.sessionId`. */
  sessionId?: string;
}

/**
 * Per-transaction guards against a stuck statement or lock holding a product or
 * sale lock for everyone else. Values are milliseconds.
 */
export const TENANT_STATEMENT_TIMEOUT_MS = 30_000;
export const TENANT_LOCK_TIMEOUT_MS = 20_000;
export const TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export type TenantAuthorizationErrorCode =
  | "tenant_access_denied"
  | "capability_denied"
  /** The member's organization is in closure: it only opens for its owner's closed-organization panel (ADR 0081). */
  | "organization_closed";

export class TenantAuthorizationError extends Error {
  readonly code: TenantAuthorizationErrorCode;

  constructor(code: TenantAuthorizationErrorCode) {
    super(code);
    this.code = code;
    this.name = "TenantAuthorizationError";
  }
}

/**
 * Checks one more capability against the role the transaction read from `memberships`, for a use case that
 * needs more than the capability the request was opened with (a product with opening stock needs
 * `inventory:adjust` besides `product:create`). It throws before any write, so a refusal leaves nothing behind.
 */
export function requireCapabilityInTransaction(
  identity: Pick<TenantRequestIdentity, "role">,
  capability: string
): void {
  if (!hasCapabilityForRole(identity.role, capability)) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

/**
 * Re-issues the identity under another capability, for a repository that keeps its own capability check
 * (`inventory:adjust`, `sale:create`, ...). Only where that capability was already proved: in a use case, by
 * `requireCapabilityInTransaction` earlier in the same function; in a sync handler, by the signed lease that
 * `sync.push` required and the role the database revalidated (ADR 0033, ADR 0035). A structure test in
 * `apps/web` holds both rules.
 */
export function withCapability(
  identity: TenantRequestIdentity,
  capability: string
): TenantRequestIdentity {
  return { ...identity, capability };
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
 * have passed. The checks run in the database (`begin_tenant_request`, under the
 * same RLS as the tenant work) so the entry costs one statement after BEGIN.
 */
export function withAuthorizedTenantTransaction<T>(
  database: Database,
  input: AuthorizedTenantTransactionInput,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  const {
    authenticatedUserId,
    capability,
    isolationLevel = "read committed",
    requestedOrganizationId,
    sessionId,
  } = input;

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
      let role: string;
      try {
        const result = await transaction.execute(
          beginTenantRequestStatement(
            authenticatedUserId,
            requestedOrganizationId,
            capability
          )
        );
        const [row] = (result as unknown as { rows: { member_role: string }[] })
          .rows;
        if (!row) {
          throw new Error("begin_tenant_request_without_role");
        }
        role = row.member_role;
      } catch (error: unknown) {
        const refusal = tenantRefusalOf(error);
        if (refusal) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new TenantAuthorizationError(refusal);
        }
        throw error;
      }

      return operation(transaction, {
        capability,
        organizationId: requestedOrganizationId,
        role,
        ...(sessionId ? { sessionId } : {}),
        userId: authenticatedUserId,
      });
    },
    { isolationLevel }
  );
}

const TENANT_REFUSALS: readonly TenantAuthorizationErrorCode[] = [
  "tenant_access_denied",
  "capability_denied",
  "organization_closed",
];

function tenantRefusalOf(
  error: unknown
): TenantAuthorizationErrorCode | undefined {
  return TENANT_REFUSALS.find((code) => raised(error, "42501", code));
}

/**
 * The single statement after BEGIN: timeouts, `app.user_id`, membership, capability, `app.organization_id` and the
 * organization's status, checked by `public.begin_tenant_request` in that order. The roles go as one `text[]` built
 * element by element: drizzle expands a JS array inside `sql` into a parenthesized list, not an array parameter.
 */
function beginTenantRequestStatement(
  authenticatedUserId: string,
  requestedOrganizationId: string,
  capability: string
): SQL {
  const roles = rolesWithCapability(capability);
  return sql`SELECT member_role FROM public.begin_tenant_request(${authenticatedUserId}, ${requestedOrganizationId}, ARRAY[${sql.join(
    roles.map((role) => sql`${role}`),
    sql`, `
  )}]::text[], ${TENANT_STATEMENT_TIMEOUT_MS}::integer, ${TENANT_LOCK_TIMEOUT_MS}::integer, ${TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS}::integer)`;
}
