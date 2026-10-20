import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The guards of the Gate 7 script (ADR 0101): it runs only against the Asaas
 * sandbox, only on a staging or local billing database, and hands the checkout
 * link to the QA in a private file outside the repository, never on the
 * terminal. These functions open no connection and call no provider; the
 * script runs the URL checks before it connects.
 */

const SANDBOX_KEY_PREFIX = "$aact_hmlg_";
const SANDBOX_HOST = "api-sandbox.asaas.com";
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

export class Gate7RefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "Gate7RefusedError";
    this.code = code;
  }
}

/**
 * Refuses anything but the sandbox: the key must be a homologation key and the
 * base URL the sandbox host. A key loaded with `. file` instead of `set -a`
 * with single quotes comes out empty (the `$` is expanded) and is refused here,
 * before any call. The key is never part of the error.
 */
export function assertAsaasSandbox(environment: {
  ASAAS_API_KEY?: string | undefined;
  ASAAS_BASE_URL?: string | undefined;
}): void {
  const key = environment.ASAAS_API_KEY ?? "";
  if (!key.startsWith(SANDBOX_KEY_PREFIX)) {
    throw new Gate7RefusedError("gate7_sandbox_key_required");
  }
  const url = URL.parse(environment.ASAAS_BASE_URL ?? "");
  if (!(url?.protocol === "https:" && url.hostname === SANDBOX_HOST)) {
    throw new Gate7RefusedError("gate7_sandbox_url_required");
  }
}

/**
 * The only query parameters accepted: the driver reads any other one over the
 * URL (`host`, `hostaddr`, `port`, `database`, `options`…), so the URL would no
 * longer say where it connects or what the session's marker is.
 */
const ALLOWED_PARAMETERS: readonly string[] = ["sslmode", "channel_binding"];

/**
 * Checked before any connection opens: a PostgreSQL URL whose host, port and
 * database are the ones it shows, and that sets no session option
 * (`?options=-c polaris.environment=…` would fake the marker): only `sslmode`
 * and `channel_binding` may follow it.
 */
export function assertGate7DatabaseUrl(connectionString: string): URL {
  const url = URL.parse(connectionString);
  if (
    !(url && ["postgres:", "postgresql:"].includes(url.protocol)) ||
    url.hostname === "" ||
    [...url.searchParams.keys()].some(
      (name) => !ALLOWED_PARAMETERS.includes(name)
    )
  ) {
    throw new Gate7RefusedError("gate7_database_url_invalid");
  }
  return url;
}

/** The two readings of `polaris.environment`, as in `packages/db/scripts/gate-target.ts`. */
export interface EnvironmentMarkers {
  /** What the session sees (`current_setting`). */
  current: string | null;
  /** What `ALTER DATABASE … SET` wrote (`pg_db_role_setting`). */
  stored: string | null;
}

const PROTECTED = ["production", "restore-drill"];

/**
 * The billing database must be staging (`ALTER DATABASE … SET
 * polaris.environment = 'staging'`, the stored marker) or a local one with no
 * marker at all: never production, never a remote database without the
 * marker, because sandbox references would be mixed with real ones.
 */
export function assertGate7Database(
  connectionString: string,
  markers: EnvironmentMarkers
): void {
  const url = assertGate7DatabaseUrl(connectionString);
  const current = (markers.current ?? "").trim().toLowerCase();
  const stored = (markers.stored ?? "").trim().toLowerCase();
  const staging =
    stored === "staging" && (current === "" || current === "staging");
  const local =
    LOCAL_HOSTS.includes(url.hostname) && current === "" && stored === "";
  if (PROTECTED.includes(current) || PROTECTED.includes(stored)) {
    throw new Gate7RefusedError("gate7_database_not_staging");
  }
  if (!(staging || local)) {
    throw new Gate7RefusedError("gate7_database_not_staging");
  }
}

/** The tenant and the billing connections must reach the same database (host, port and name). */
export function assertSameDatabase(first: string, second: string): void {
  const a = assertGate7DatabaseUrl(first);
  const b = assertGate7DatabaseUrl(second);
  if (
    a.hostname !== b.hostname ||
    (a.port || "5432") !== (b.port || "5432") ||
    a.pathname !== b.pathname
  ) {
    throw new Gate7RefusedError("gate7_databases_differ");
  }
}

/**
 * Where the checkout link goes: an absolute path outside the repository (a
 * file there could be committed). The script writes it with mode 0600 and
 * refuses a file that already exists. The script checks the real path of
 * the parent directory again (a symlink into the repository is refused).
 */
export function checkedLinkFile(path: string, repositoryRoot: string): string {
  if (!isAbsolute(path)) {
    throw new Gate7RefusedError("gate7_link_file_must_be_absolute");
  }
  const resolved = resolve(path);
  const fromRoot = relative(resolve(repositoryRoot), resolved);
  // `..link.txt` is a file in the root: only a whole `..` segment leaves it
  const outside =
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot);
  if (!outside) {
    throw new Gate7RefusedError("gate7_link_file_inside_repository");
  }
  return resolved;
}

const CYCLES = [1, 6, 12] as const;

/** `1`, `6` or `12`; anything else is refused. */
export function cycleOf(value: string | undefined): 1 | 6 | 12 {
  const cycle = CYCLES.find((entry) => String(entry) === value);
  if (cycle === undefined) {
    throw new Gate7RefusedError("gate7_cycle_invalid");
  }
  return cycle;
}
