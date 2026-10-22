/**
 * The environment marker of a database (ADR 0097): the one place that says how it is written and read.
 *
 * Neon gives no superuser, and PostgreSQL only lets a superuser put a placeholder variable in
 * `ALTER DATABASE … SET`, so the marker is the database comment, written once by the owner:
 *
 *   COMMENT ON DATABASE <database> IS 'polaris.environment=staging';
 *
 * Only the owner (or a superuser) changes that comment; the runtime logins are not owners. The old form
 * (`ALTER DATABASE … SET polaris.environment`, in `pg_db_role_setting` for every role) stays valid for the
 * local and CI databases, where the login is a superuser.
 *
 * A marker counts only when it is exactly `polaris.environment=<name>` (lowercase, no space). The session's
 * `current_setting` is an extra signal that a connection option could fake: it never makes a marker, but it
 * still counts to refuse and it must not contradict the marker.
 */

const PREFIX = "polaris.environment=";
const EXACT_MARKER = /^polaris\.environment=([a-z][a-z0-9-]*)$/;

/** The three readings, in the order `ENVIRONMENT_MARKER_SQL` selects them. */
export interface EnvironmentReadings {
  /** The comment of the current database (`shobj_description`), as stored. */
  comment: string | null;
  /** What the session sees (`current_setting`). */
  current: string | null;
  /** What `ALTER DATABASE … SET` stored (`pg_db_role_setting`, role 0): the text after `polaris.environment=`. */
  stored: string | null;
}

// every name is schema-qualified: the check never depends on the session's search_path
export const ENVIRONMENT_MARKER_SQL = `SELECT pg_catalog.current_setting('polaris.environment', true) AS current,
       (SELECT pg_catalog.substring(c, '^polaris\\.environment=(.*)$')
          FROM pg_catalog.pg_db_role_setting s
          JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase,
               pg_catalog.unnest(s.setconfig) AS c
         WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0
           AND c LIKE 'polaris.environment=%'
         LIMIT 1) AS stored,
       (SELECT pg_catalog.shobj_description(d.oid, 'pg_database')
          FROM pg_catalog.pg_database d
         WHERE d.datname = pg_catalog.current_database()) AS comment`;

/** The exact marker comment for an environment: what the runbook tells the owner to write. */
export function markerComment(environment: string): string {
  return `${PREFIX}${environment}`;
}

function fromComment(comment: string | null): string | null {
  return EXACT_MARKER.exec(comment ?? "")?.[1] ?? null;
}

function fromStored(stored: string | null): string | null {
  return EXACT_MARKER.exec(markerComment(stored ?? ""))?.[1] ?? null;
}

/**
 * The environment the database declares, or null: the exact comment, or the exact stored setting (when both
 * exist they must agree), and the session must not say something else. Anything else is not a marker, and a
 * reading that is present but is not exact (a comment that mentions the marker in another form, a stored
 * value with other case or spaces) makes the whole database undeclared instead of being ignored.
 */
export function declaredEnvironment(
  readings: EnvironmentReadings
): string | null {
  const stored = normalized(readings.stored);
  const exact = [fromComment(readings.comment), fromStored(readings.stored)];
  if (
    (mentionsMarker(readings.comment) && exact[0] === null) ||
    (stored !== "" && exact[1] === null)
  ) {
    return null;
  }
  const present = exact.filter((value) => value !== null);
  const [declared] = present;
  if (declared === undefined || present.some((value) => value !== declared)) {
    return null;
  }
  const current = normalized(readings.current);
  return current === "" || current === declared ? declared : null;
}

function normalized(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function mentionsMarker(comment: string | null): boolean {
  return normalized(comment).includes("polaris.environment");
}

// `polaris.environment = production`, `polaris.environment: 'production'`, with text before or after it
const LOOSE_COMMENT = /polaris\.environment\s*[=:]\s*['"]?\s*([a-z0-9-]+)/i;

/**
 * True when any reading names one of the environments, however it is written (`Production `, spaces around
 * the equal sign, quotes, text around it), or when the comment mentions `polaris.environment` in a form that is
 * not the exact marker at all (a sloppy marker never passes as "no marker"). A refusal is not hidden by
 * formatting; the only comment about the marker that does not refuse is the exact one of another environment
 * (`polaris.environment=staging-x`).
 */
export function readsAsEnvironment(
  readings: EnvironmentReadings,
  environments: readonly string[]
): boolean {
  const loose = LOOSE_COMMENT.exec(readings.comment ?? "")?.[1]?.toLowerCase();
  const sloppyComment =
    mentionsMarker(readings.comment) && fromComment(readings.comment) === null;
  return (
    [normalized(readings.current), normalized(readings.stored), loose].some(
      (value) => value !== undefined && environments.includes(value)
    ) ||
    sloppyComment ||
    environments.includes(fromComment(readings.comment) ?? "")
  );
}

/**
 * True when the database carries something that looks like a marker: any reading, or a comment that mentions
 * `polaris.environment`. A local database with no marker at all is the only one with none.
 */
export function hasMarkerText(readings: EnvironmentReadings): boolean {
  return (
    normalized(readings.current) !== "" ||
    normalized(readings.stored) !== "" ||
    mentionsMarker(readings.comment)
  );
}
