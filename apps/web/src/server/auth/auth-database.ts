import type { WorkerBindings } from "../environment";
import { isLoopbackBaseURL } from "./security-options";

export class AuthDatabaseNotConfiguredError extends Error {
  readonly code = "auth_database_not_configured";

  constructor() {
    super("auth_database_not_configured");
    this.name = "AuthDatabaseNotConfiguredError";
  }
}

/**
 * Connection string for Better Auth's own database role.
 *
 * Authentication tables (user, account, session, verification) must be reachable
 * only through a dedicated Hyperdrive/role (`AUTH_HYPERDRIVE`), never through the
 * tenant role behind `HYPERDRIVE`; otherwise any SQL executed with tenant
 * privileges could read every user and forge identities.
 *
 * Failing closed: outside local development (a loopback `BETTER_AUTH_BASE_URL`)
 * a missing `AUTH_HYPERDRIVE` is an error. Local development and the test
 * suites fall back to `HYPERDRIVE` because a single local role owns everything
 * there; that fallback must never apply to a deployed Worker.
 */
export function resolveAuthConnectionString(
  bindings: Pick<
    WorkerBindings,
    "AUTH_HYPERDRIVE" | "BETTER_AUTH_BASE_URL" | "HYPERDRIVE"
  >
): string {
  if (bindings.AUTH_HYPERDRIVE) {
    return bindings.AUTH_HYPERDRIVE.connectionString;
  }
  if (isLoopbackBaseURL(bindings.BETTER_AUTH_BASE_URL)) {
    return bindings.HYPERDRIVE.connectionString;
  }
  throw new AuthDatabaseNotConfiguredError();
}
