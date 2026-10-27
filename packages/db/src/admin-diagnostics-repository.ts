import type { RawDiagnostics } from "@polaris/domain/admin/organization-diagnostics";
import type { AdminQueryable } from "./platform-principal-repository";

/**
 * What the Admin may read of an organization without tenant access (plan PR95,
 * ADR 0071): two database functions that return counts, dates and states and
 * nothing a person typed. The Admin role reads no table; these functions are
 * what it runs.
 */

export interface AdminOrganizationSummary {
  accessEndsAt: string | null;
  billingState: string;
  createdAt: string;
  id: string;
  name: string;
  /** The plan the billing record gives right now (a temporary grant is not counted). */
  planInForce: string;
  status: string;
}

export interface AdminOrganizationPage {
  next: string | null;
  organizations: AdminOrganizationSummary[];
}

export const ADMIN_MAX_PAGE_SIZE = 50;

/** The organizations, a page at a time, found by exact ID or by the start of the name. */
export async function listOrganizations(
  client: AdminQueryable,
  input: { after?: string | null; limit: number; query?: string | null }
): Promise<AdminOrganizationPage> {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit), 1),
    ADMIN_MAX_PAGE_SIZE
  );
  const { rows } = await client.query(
    "SELECT public.admin_organizations_overview($1, $2, $3) AS result",
    [input.query?.trim() || null, limit, input.after ?? null]
  );
  return rows[0]?.result as AdminOrganizationPage;
}

/** One organization's raw figures, or null when there is no such organization. */
export async function readOrganizationDiagnostics(
  client: AdminQueryable,
  organizationId: string
): Promise<RawDiagnostics | null> {
  const { rows } = await client.query(
    "SELECT public.admin_organization_diagnostics($1) AS result",
    [organizationId]
  );
  return (rows[0]?.result ?? null) as RawDiagnostics | null;
}

/** How many weeks back the activation funnel may go: the only choice it takes (ADR 0071 amended). */
export const ACTIVATION_FUNNEL_MAX_WEEKS = 26;

/**
 * The activation funnel of the stores (corte 2.4, ADR 0071 amended): counts by weekly cohort and by calendar week,
 * suppressed under 5 stores, with no store, person, amount or individual date. Read through the audited wrapper: one
 * `activation_funnel.read` event of the operator (no content) in the same transaction, so there is no read without
 * its record (the Admin runtime cannot call the aggregate function itself). Returned as the database wrote it; the
 * route validates it against its closed contract.
 */
export async function readActivationFunnel(
  client: AdminQueryable,
  principalId: string,
  weeks: number
): Promise<unknown> {
  if (
    !Number.isInteger(weeks) ||
    weeks < 1 ||
    weeks > ACTIVATION_FUNNEL_MAX_WEEKS
  ) {
    throw new RangeError("invalid_weeks");
  }
  // one transaction so that the timeout is this read's own (SET LOCAL ends with it, and the pooled connection goes
  // back without it); a read cancelled by it rolls back with its event
  await client.query("BEGIN", []);
  try {
    await client.query(
      `SET LOCAL statement_timeout = ${ACTIVATION_FUNNEL_STATEMENT_TIMEOUT_MS}`,
      []
    );
    const { rows } = await client.query(
      // `clock_timestamp() AS at` is not read: a pooler that caches by the text of the statement cannot tell that a
      // user function writes, and with it the statement is one it will not answer from a copy (no read without its event)
      "SELECT public.admin_read_activation_funnel($1, $2) AS result, pg_catalog.clock_timestamp() AS at",
      [principalId, weeks]
    );
    await client.query("COMMIT", []);
    return rows[0]?.result ?? null;
  } catch (error: unknown) {
    await client.query("ROLLBACK", []).catch(() => undefined);
    if ((error as { code?: unknown } | null)?.code === QUERY_CANCELED) {
      throw new Error("activation_funnel_timeout", { cause: error });
    }
    throw error;
  }
}

/**
 * How long the funnel may run before the database cancels it (SQLSTATE 57014): it must not hold the database. The
 * gate measured about 70 ms with 1,000 stores and 50,000 sales; 2 s leaves room and still frees the connection well
 * before the connection's own 5 s.
 */
export const ACTIVATION_FUNNEL_STATEMENT_TIMEOUT_MS = 2000;
const QUERY_CANCELED = "57014";
