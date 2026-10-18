import {
  ClosureConfirmationError,
  ClosureNotRecoverableError,
  CLOSURE_RECOVERY_WINDOW_DAYS,
  closureConfirmationMatches,
  OrganizationNotActiveError,
} from "@polaris/domain/organization/closure";
import { eq, sql } from "drizzle-orm";
import { organizations } from "./schema/organization";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";
import { withUserTransaction } from "./user-transaction";

type Database = Parameters<typeof withUserTransaction>[0];

/**
 * Closing an organization (plan PR101, ADR 0074). The closure itself is a database
 * function: it changes the status, the authorization epoch and the offline leases
 * in one transaction, under the same per-user key lease issuance takes. These
 * wrappers add what the function does not know (the typed confirmation) and give
 * its refusals their names.
 */

const CAPABILITY = "organization:close";
const ACCESS_DENIED = "42501";
const NOT_IN_STATE = "55000";
const INVALID_PARAMETER = "22023";

export interface ClosureRequested {
  recoverUntil: Date;
  revokedLeases: number;
}

export interface OrganizationInClosure {
  id: string;
  name: string;
  recoverUntil: Date;
}

/**
 * True when the database raised exactly this refusal: its SQLSTATE and the message
 * the closure functions give it. 42501 is also PostgreSQL's "insufficient privilege",
 * so the code alone would turn a missing grant into a polite refusal instead of an error.
 */
function raised(error: unknown, state: string, message: string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return candidate.code === state && candidate.message === message;
    }
    current = candidate.cause;
  }
  return false;
}

function rows<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : (candidate.rows ?? []);
}

/**
 * The owner closes their organization from inside a tenant transaction. The
 * organization stops being active in the same transaction, so nothing after it
 * (in this or any later request) is authorized.
 */
export async function requestOrganizationClosure(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { confirmation: string }
): Promise<ClosureRequested> {
  if (identity.capability !== CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
  const [organization] = await transaction
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  if (!closureConfirmationMatches(input.confirmation, organization.name)) {
    throw new ClosureConfirmationError();
  }
  try {
    const result = await transaction.execute(
      sql`SELECT public.request_organization_closure(${CLOSURE_RECOVERY_WINDOW_DAYS}::integer) AS result`
    );
    const [row] = rows<{
      result: { recoverUntil: string; revokedLeases: number };
    }>(result);
    if (!row) {
      throw new Error("closure_not_recorded");
    }
    return {
      recoverUntil: new Date(row.result.recoverUntil),
      revokedLeases: row.result.revokedLeases,
    };
  } catch (error: unknown) {
    if (
      raised(error, ACCESS_DENIED, "tenant_access_denied") ||
      raised(error, ACCESS_DENIED, "tenant_context_required")
    ) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
      throw new TenantAuthorizationError("tenant_access_denied");
    }
    if (raised(error, NOT_IN_STATE, "organization_not_active")) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
      throw new OrganizationNotActiveError();
    }
    throw error;
  }
}

/**
 * The owner undoes a closure while the recovery window is open. The organization
 * is no longer active, so this takes only the authenticated user (a server-verified
 * session): the database function checks the owner's membership itself.
 */
export function recoverOrganizationClosure(
  database: Database,
  authenticatedUserId: string,
  organizationId: string
): Promise<void> {
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) => {
      try {
        await transaction.execute(
          sql`SELECT public.recover_organization_closure(${organizationId}) AS result`
        );
      } catch (error: unknown) {
        if (
          raised(error, ACCESS_DENIED, "tenant_access_denied") ||
          raised(error, ACCESS_DENIED, "tenant_context_required")
        ) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new TenantAuthorizationError("tenant_access_denied");
        }
        if (raised(error, INVALID_PARAMETER, "closure_not_recoverable")) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new ClosureNotRecoverableError();
        }
        throw error;
      }
    }
  );
}

/** The user's own organizations whose closure can still be undone. */
export function listOrganizationsInClosure(
  database: Database,
  authenticatedUserId: string
): Promise<OrganizationInClosure[]> {
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) => {
      const result = await transaction.execute(
        sql`SELECT id, name, recover_until FROM public.list_organizations_in_closure()`
      );
      return rows<{ id: string; name: string; recover_until: Date | string }>(
        result
      ).map((row) => ({
        id: row.id,
        name: row.name,
        recoverUntil: new Date(row.recover_until),
      }));
    }
  );
}
