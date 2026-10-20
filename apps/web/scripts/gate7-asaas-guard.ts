import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The guards of the Gate 7 script (ADR 0101): it runs only against the Asaas
 * sandbox, only on a staging or local billing database, and hands the checkout
 * link to the QA in a private file outside the repository, never on the
 * terminal. Nothing here opens a connection or calls the provider.
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
 * The billing database must be staging (`polaris.environment = 'staging'`) or
 * a local one: never production, never a database without the marker
 * somewhere else, because sandbox references would be mixed with real ones.
 */
export function assertGate7Database(
  connectionString: string,
  environmentMarker: string | null
): void {
  const url = URL.parse(connectionString);
  if (!(url && ["postgres:", "postgresql:"].includes(url.protocol))) {
    throw new Gate7RefusedError("gate7_database_url_invalid");
  }
  const marker = (environmentMarker ?? "").trim().toLowerCase();
  const local = LOCAL_HOSTS.includes(url.hostname) && marker === "";
  if (!(marker === "staging" || local)) {
    throw new Gate7RefusedError("gate7_database_not_staging");
  }
}

/**
 * Where the checkout link goes: an absolute path outside the repository (a
 * file there could be committed). The script writes it with mode 0600 and
 * refuses a file that already exists.
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
