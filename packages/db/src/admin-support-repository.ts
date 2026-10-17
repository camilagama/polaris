import {
  InvalidSupportRequestError,
  type RevealableCustomerField,
  supportRefusalFromMessage,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import type { AdminQueryable } from "./platform-principal-repository";

/**
 * The Admin's support cases, temporary tenant access and masked reads (plan PR96
 * to PR98, ADR 0072): thin calls to database functions that do the work, check
 * the grant and write the audit in one transaction. The Admin role reads no
 * table; a refusal from the database becomes a named error here, never raw.
 */

export interface SupportCaseSummary {
  closedAt: string | null;
  id: string;
  kind: string;
  openedAt: string;
  organizationId: string;
  organizationName: string;
  reason: string;
  status: string;
}

export interface SupportCasePage {
  cases: SupportCaseSummary[];
  next: string | null;
}

export interface TenantAccessGrantRecord {
  caseId: string;
  expiresAt: string;
  id: string;
  organizationId: string;
  startsAt: string;
}

export interface SupportCaseDetail {
  audit: {
    createdAt: string;
    detail: string | null;
    entityId: string | null;
    entityType: string | null;
    eventType: string;
    id: string;
    principalId: string;
  }[];
  case: SupportCaseSummary & {
    closedAt: string | null;
    context: string | null;
    openedBy: string;
    resolution: string | null;
  };
  grants: {
    active: boolean;
    expiresAt: string;
    id: string;
    principalId: string;
    revokedAt: string | null;
    startsAt: string;
  }[];
}

/** A customer as the Admin sees them by default: masked, never the real contact. */
export interface MaskedCustomer {
  archived: boolean;
  email: string | null;
  hasNotes: boolean;
  id: string;
  name: string;
  phone: string | null;
}

export interface MaskedCustomerPage {
  customers: MaskedCustomer[];
  next: string | null;
}

const ACCESS_DENIED = "42501";
const INVALID_PARAMETER = "22023";

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return candidate.code;
    }
    current = candidate.cause;
  }
}

async function call<T>(
  client: AdminQueryable,
  statement: string,
  values: unknown[]
): Promise<T | null> {
  try {
    // clock_timestamp() makes each statement volatile, so a pooler that caches reads never answers one of these
    // (the audit and the grant check must run every time)
    const { rows } = await client.query(
      `SELECT ${statement} AS result, pg_catalog.clock_timestamp() AS at`,
      values
    );
    return (rows[0]?.result ?? null) as T | null;
  } catch (error: unknown) {
    const state = sqlState(error);
    if (state === ACCESS_DENIED) {
      // biome-ignore lint/style/useErrorCause: TenantAccessDeniedError forwards this cause to Error.
      throw new TenantAccessDeniedError({ cause: error });
    }
    if (state === INVALID_PARAMETER) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks its code.
      throw new InvalidSupportRequestError(
        supportRefusalFromMessage(error instanceof Error ? error.message : "")
      );
    }
    throw error;
  }
}

export function openSupportCase(
  client: AdminQueryable,
  principalId: string,
  input: {
    context: string | null;
    kind: string;
    organizationId: string;
    reason: string;
  }
) {
  return call<{
    id: string;
    kind: string;
    openedAt: string;
    organizationId: string;
    reason: string;
    status: string;
  }>(client, "public.admin_open_support_case($1, $2, $3, $4, $5)", [
    principalId,
    input.organizationId,
    input.kind,
    input.reason,
    input.context,
  ]);
}

/** Null when there is no such case; `changed` is false when it was already closed. */
export function closeSupportCase(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  resolution: string | null
) {
  return call<{
    changed: boolean;
    id: string;
    revokedGrants?: number;
    status: string;
  }>(client, "public.admin_close_support_case($1, $2, $3)", [
    principalId,
    caseId,
    resolution,
  ]);
}

export async function listSupportCases(
  client: AdminQueryable,
  input: {
    after: string | null;
    limit: number;
    organizationId: string | null;
    status: string | null;
  }
): Promise<SupportCasePage> {
  const page = await call<SupportCasePage>(
    client,
    "public.admin_list_support_cases($1, $2, $3, $4)",
    [input.status, input.organizationId, input.limit, input.after]
  );
  return page ?? { cases: [], next: null };
}

export function readSupportCase(client: AdminQueryable, caseId: string) {
  return call<SupportCaseDetail>(
    client,
    "public.admin_support_case_detail($1)",
    [caseId]
  );
}

export function grantTenantAccess(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  minutes: number
) {
  return call<TenantAccessGrantRecord>(
    client,
    "public.admin_grant_tenant_access($1, $2, $3)",
    [principalId, caseId, minutes]
  );
}

export async function revokeTenantAccess(
  client: AdminQueryable,
  principalId: string,
  grantId: string
): Promise<boolean> {
  const result = await call<{ revoked: boolean }>(
    client,
    "public.admin_revoke_tenant_access($1, $2)",
    [principalId, grantId]
  );
  return result?.revoked === true;
}

/** The organization's customers, masked, while the grant lasts (the read is audited). */
export async function listTenantCustomers(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { after: string | null; limit: number }
): Promise<MaskedCustomerPage> {
  const page = await call<MaskedCustomerPage>(
    client,
    "public.admin_tenant_customers($1, $2, $3, $4)",
    [principalId, caseId, input.limit, input.after]
  );
  return page ?? { customers: [], next: null };
}

/** One real field of one customer (audited); null when the customer is not in the organization. */
export function revealCustomerField(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  customerId: string,
  field: RevealableCustomerField
) {
  return call<{ customerId: string; field: string; value: string | null }>(
    client,
    "public.admin_reveal_customer_field($1, $2, $3, $4)",
    [principalId, caseId, customerId, field]
  );
}
