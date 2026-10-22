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

export const ENVIRONMENT_MARKER_SQL = `SELECT current_setting('polaris.environment', true) AS current,
       (SELECT substring(c FROM '^polaris\\.environment=(.*)$')
          FROM pg_db_role_setting s
          JOIN pg_database d ON d.oid = s.setdatabase,
               unnest(s.setconfig) AS c
         WHERE d.datname = current_database() AND s.setrole = 0
           AND c LIKE 'polaris.environment=%'
         LIMIT 1) AS stored,
       (SELECT shobj_description(d.oid, 'pg_database')
          FROM pg_database d
         WHERE d.datname = current_database()) AS comment`;

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
 * exist they must agree), and the session must not say something else. Anything else is not a marker.
 */
export function declaredEnvironment(
  readings: EnvironmentReadings
): string | null {
  const fromBoth = [
    fromComment(readings.comment),
    fromStored(readings.stored),
  ].filter((value) => value !== null);
  const [declared] = fromBoth;
  if (declared === undefined || fromBoth.some((value) => value !== declared)) {
    return null;
  }
  const current = (readings.current ?? "").trim().toLowerCase();
  return current === "" || current === declared ? declared : null;
}

function normalized(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** The environment a comment names, read loosely (case, spaces) so that it can only add to a refusal. */
function looseComment(comment: string | null): string {
  const text = normalized(comment);
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length).trim() : "";
}

/**
 * True when any reading, even a sloppy one (`Production `, a comment with other case or spaces), names one of
 * the environments: a refusal is never hidden by formatting.
 */
export function readsAsEnvironment(
  readings: EnvironmentReadings,
  environments: readonly string[]
): boolean {
  return [
    normalized(readings.current),
    normalized(readings.stored),
    looseComment(readings.comment),
  ].some((value) => environments.includes(value));
}

/**
 * True when the database carries something that looks like a marker: any reading, or a comment that mentions
 * `polaris.environment`. A local database with no marker at all is the only one with none.
 */
export function hasMarkerText(readings: EnvironmentReadings): boolean {
  return (
    normalized(readings.current) !== "" ||
    normalized(readings.stored) !== "" ||
    normalized(readings.comment).includes("polaris.environment")
  );
}
