import { createDatabase as createHyperdriveDatabase } from "@polaris/db/client";
import { logger } from "@polaris/observability/logger";
import { createBetterAuth } from "./auth";
import {
  AuthDatabaseNotConfiguredError,
  resolveAuthConnectionString,
} from "./auth/auth-database";
import {
  currentRequestId,
  requestScopedDatabase,
  runWithRequestScope,
} from "./auth/request-database";
import { isSessionPastAbsoluteExpiration } from "./auth/session-policy";
import type { WorkerBindings } from "./environment";
import {
  isExemptFromLegalAcceptance,
  isLegalAcceptanceEnforced,
  type LegalAcceptanceQueryable,
  pendingLegalAcceptance,
  readAcceptedLegalVersions,
} from "./legal-acceptance";
import { TenantRequestContextError } from "./request-context-error";

type Database = ReturnType<typeof createHyperdriveDatabase>["db"];
const timeoutValuePattern = /^\d+$/;

function authDatabaseConnectionOption(configuredTimeout: string | undefined): {
  connectionTimeoutMillis?: number;
} {
  if (configuredTimeout === undefined) {
    return {};
  }

  const value = configuredTimeout.trim();
  if (!timeoutValuePattern.test(value)) {
    throw new TenantRequestContextError("authentication_unavailable");
  }
  const connectionTimeoutMillis = Number(value);
  if (
    !Number.isSafeInteger(connectionTimeoutMillis) ||
    connectionTimeoutMillis < 1000 ||
    connectionTimeoutMillis > 30_000
  ) {
    throw new TenantRequestContextError("authentication_unavailable");
  }
  return { connectionTimeoutMillis };
}

interface AuthenticatedRequestSession {
  /** `id` identifies the session (it is not the token); devices link to it. */
  session: { createdAt: Date | string; id: string };
  user: { emailVerified?: boolean; id: string };
}

interface SessionAuth {
  api: {
    getSession: (input: {
      headers: Headers;
    }) => Promise<AuthenticatedRequestSession | null>;
  };
}

export interface AuthenticatedRequestContextDependencies {
  createAuth: (options: {
    baseURL: string;
    database: Database;
    requestId: () => string;
    secret: string;
  }) => SessionAuth;
  createDatabase: typeof createHyperdriveDatabase;
  readAcceptedLegalVersions?: typeof readAcceptedLegalVersions;
}

export interface AuthenticatedRequestContextInput<T> {
  bindings: WorkerBindings;
  operation: (
    database: Database,
    session: AuthenticatedRequestSession,
    /** The authentication connection: the only one that may read and record the legal acceptance. */
    authConnection: LegalAcceptanceQueryable
  ) => Promise<T>;
  request: Request;
}

/**
 * The single control of the legal acceptance (ADR 0100): every RPC, the sync, the leases and the
 * authenticated `/api/*` routes come through the request context. Only the exempt procedures and routes
 * skip it, and only with `LEGAL_ACCEPTANCE_ENFORCED=true` does it refuse anyone.
 */
async function assertLegalAcceptance(input: {
  bindings: WorkerBindings;
  connection: LegalAcceptanceQueryable;
  readAccepted: typeof readAcceptedLegalVersions;
  request: Request;
  userId: string;
}): Promise<void> {
  if (
    !isLegalAcceptanceEnforced(input.bindings) ||
    isExemptFromLegalAcceptance(input.request)
  ) {
    return;
  }
  let pending: ReturnType<typeof pendingLegalAcceptance>;
  try {
    pending = pendingLegalAcceptance(
      await input.readAccepted(input.connection, input.userId)
    );
  } catch (error) {
    // fails closed: an unreadable record never lets the request through
    logger.error("legal_acceptance_unavailable", {
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    // biome-ignore lint/style/useErrorCause: The database detail is logged above and must not reach clients.
    throw new TenantRequestContextError("authentication_unavailable");
  }
  if (pending.length > 0) {
    throw new TenantRequestContextError("legal_acceptance_required", pending);
  }
}

export function createAuthenticatedRequestContext(
  overrides: Partial<AuthenticatedRequestContextDependencies> = {}
) {
  const databaseFactory = overrides.createDatabase ?? createHyperdriveDatabase;
  const authFactory =
    overrides.createAuth ??
    ((options) => createBetterAuth(options) as SessionAuth);
  const readAccepted =
    overrides.readAcceptedLegalVersions ?? readAcceptedLegalVersions;
  // Built once per isolate: assembling Better Auth costs more CPU than a cold isolate has left in the Free plan.
  // It holds configuration only. The `db` it reads through is the one of the running request, resolved at each
  // call from the request scope; no `pool` and no `db` of a request stays here (ADR 0017, emenda de 24/10/2026).
  let sessionAuth:
    | { auth: SessionAuth; baseURL: string; secret: string }
    | undefined;
  const sessionAuthFor = (baseURL: string, secret: string): SessionAuth => {
    if (sessionAuth?.baseURL !== baseURL || sessionAuth.secret !== secret) {
      sessionAuth = {
        auth: authFactory({
          baseURL,
          database: requestScopedDatabase(),
          requestId: currentRequestId,
          secret,
        }),
        baseURL,
        secret,
      };
    }
    return sessionAuth.auth;
  };

  return async function runAuthenticatedRequestContext<T>(
    input: AuthenticatedRequestContextInput<T>
  ): Promise<T> {
    const { BETTER_AUTH_BASE_URL: baseURL, BETTER_AUTH_SECRET: secret } =
      input.bindings;

    if (!secret || secret.length < 32 || !baseURL) {
      throw new TenantRequestContextError("authentication_unavailable");
    }

    const connectionOptions = authDatabaseConnectionOption(
      input.bindings.AUTH_DATABASE_CONNECT_TIMEOUT_MS
    );
    const tenantConnectionString = input.bindings.HYPERDRIVE.connectionString;
    let authConnectionString: string;
    try {
      authConnectionString = resolveAuthConnectionString(input.bindings);
    } catch (error) {
      if (error instanceof AuthDatabaseNotConfiguredError) {
        logger.error("auth_database_not_configured");
        // biome-ignore lint/style/useErrorCause: The configuration detail is logged above and must not reach clients.
        throw new TenantRequestContextError("authentication_unavailable");
      }
      throw error;
    }
    const databaseOptions = { maxConnections: 1, ...connectionOptions };
    const authDatabase = databaseFactory(authConnectionString, databaseOptions);
    // Authentication and tenant data use different database roles. Only when
    // both resolve to the same connection (local development) is one pool shared.
    let tenantDatabase: typeof authDatabase | undefined;

    try {
      const auth = sessionAuthFor(baseURL, secret);
      const session = await runWithRequestScope(
        { database: authDatabase.db, requestId: crypto.randomUUID() },
        () => auth.api.getSession({ headers: input.request.headers })
      );

      // the session id links devices to this session; a session without one is refused
      const sessionId: unknown = session?.session.id;
      if (
        !session?.user.id.trim() ||
        typeof sessionId !== "string" ||
        !sessionId.trim()
      ) {
        throw new TenantRequestContextError("session_required");
      }
      // Better Auth only enforces the idle window here; the 30-day absolute
      // lifetime must be checked on every authenticated request. An unreadable
      // creation time counts as expired.
      if (isSessionPastAbsoluteExpiration(session.session.createdAt)) {
        throw new TenantRequestContextError("session_required");
      }
      const authConnection =
        authDatabase.pool as unknown as LegalAcceptanceQueryable;
      await assertLegalAcceptance({
        bindings: input.bindings,
        connection: authConnection,
        readAccepted,
        request: input.request,
        userId: session.user.id,
      });

      if (tenantConnectionString !== authConnectionString) {
        tenantDatabase = databaseFactory(
          tenantConnectionString,
          databaseOptions
        );
      }

      return await input.operation(
        (tenantDatabase ?? authDatabase).db,
        session,
        authConnection
      );
    } finally {
      await Promise.all([authDatabase.pool.end(), tenantDatabase?.pool.end()]);
    }
  };
}

export const withAuthenticatedRequestContext =
  createAuthenticatedRequestContext();
