import type { AdminQueryable } from "./platform-principal-repository";

/**
 * What the Admin sees and does about operational incidents (plan PR111, ADR 0085): thin calls to
 * database functions. The Admin role reads no table. An incident has a cause, a count and dates; its
 * events are named by opaque IDs. The retry puts one dead outbox event back to pending and writes
 * the audit in the same transaction.
 */

export interface OperationalIncidentSummary {
  cause: string;
  /** How many of its events are dead now (not yet sent again). */
  deadEvents: number;
  firstSeenAt: string;
  id: string;
  kind: string;
  lastReference: string | null;
  lastSeenAt: string;
  occurrenceCount: number;
  subject: string;
}

export interface OperationalIncidentPage {
  incidents: OperationalIncidentSummary[];
  next: string | null;
}

export interface DeadEventSummary {
  eventId: string;
  eventType: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  organizationId: string;
  retriedAt: string | null;
  retryCount: number;
  state: "dead" | "retried";
}

export interface OperationalIncidentDetail {
  events: DeadEventSummary[];
  incident: Omit<OperationalIncidentSummary, "deadEvents">;
  next: string | null;
}

/** What a retry did: `retried` and `already_pending` are the two that succeed. */
export type IncidentRetryResult =
  | "already_pending"
  | "busy"
  | "event_gone"
  | "retried"
  | "unknown_item";

const RETRY_RESULTS = new Set<string>([
  "already_pending",
  "busy",
  "event_gone",
  "retried",
  "unknown_item",
]);

export async function listOperationalIncidents(
  client: AdminQueryable,
  input: { after: string | null; limit: number }
): Promise<OperationalIncidentPage> {
  const { rows } = await client.query(
    "SELECT public.admin_list_operational_incidents($1::integer, $2::uuid) AS result, pg_catalog.clock_timestamp() AS at",
    [input.limit, input.after]
  );
  return (rows[0]?.result ?? {
    incidents: [],
    next: null,
  }) as OperationalIncidentPage;
}

/** One incident and a page of its events, or null when there is no such incident. */
export async function readOperationalIncident(
  client: AdminQueryable,
  incidentId: string,
  input: { after: string | null; limit: number }
): Promise<OperationalIncidentDetail | null> {
  const { rows } = await client.query(
    "SELECT public.admin_read_operational_incident($1::uuid, $2::integer, $3::uuid) AS result, pg_catalog.clock_timestamp() AS at",
    [incidentId, input.limit, input.after]
  );
  return (rows[0]?.result ?? null) as OperationalIncidentDetail | null;
}

/**
 * Sends one dead event of an incident again. The database checks the operator and that the event belongs
 * to the incident, retries it (idempotent) and writes the audit, all in one transaction.
 * `clock_timestamp()` keeps a pooler that caches reads from ever answering this statement.
 */
export async function retryDeadLetter(
  client: AdminQueryable,
  principalId: string,
  incidentId: string,
  eventId: string
): Promise<IncidentRetryResult> {
  const { rows } = await client.query(
    "SELECT public.admin_retry_dead_letter($1::uuid, $2::uuid, $3::uuid) AS result, pg_catalog.clock_timestamp() AS at",
    [principalId, incidentId, eventId]
  );
  const result = (rows[0]?.result as { result?: unknown } | null)?.result;
  if (typeof result === "string" && RETRY_RESULTS.has(result)) {
    return result as IncidentRetryResult;
  }
  throw new Error("incident_retry_unreadable");
}
