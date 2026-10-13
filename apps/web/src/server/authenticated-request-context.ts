import { createDatabase as createHyperdriveDatabase } from "@polaris/db/client";
import { createBetterAuth } from "./auth";
import {
  AuthDatabaseNotConfiguredError,
  resolveAuthConnectionString,
} from "./auth/auth-database";
import { isSessionPastAbsoluteExpiration } from "./auth/session-policy";
import type { WorkerBindings } from "./environment";
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
  session: { createdAt: Date | string };
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
    secret: string;
  }) => SessionAuth;
  createDatabase: typeof createHyperdriveDatabase;
}

export interface AuthenticatedRequestContextInput<T> {
  bindings: WorkerBindings;
  operation: (
    database: Database,
    session: AuthenticatedRequestSession
  ) => Promise<T>;
  request: Request;
}

export function createAuthenticatedRequestContext(
  overrides: Partial<AuthenticatedRequestContextDependencies> = {}
) {
  const databaseFactory = overrides.createDatabase ?? createHyperdriveDatabase;
  const authFactory =
    overrides.createAuth ??
    ((options) => createBetterAuth(options) as SessionAuth);

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
        console.error({ event: "auth_database_not_configured" });
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
      const auth = authFactory({
        baseURL,
        database: authDatabase.db,
        secret,
      });
      const session = await auth.api.getSession({
        headers: input.request.headers,
      });

      if (!session?.user.id.trim()) {
        throw new TenantRequestContextError("session_required");
      }
      // Better Auth only enforces the idle window here; the 30-day absolute
      // lifetime must be checked on every authenticated request. An unreadable
      // creation time counts as expired.
      if (isSessionPastAbsoluteExpiration(session.session.createdAt)) {
        throw new TenantRequestContextError("session_required");
      }

      if (tenantConnectionString !== authConnectionString) {
        tenantDatabase = databaseFactory(
          tenantConnectionString,
          databaseOptions
        );
      }

      return await input.operation(
        (tenantDatabase ?? authDatabase).db,
        session
      );
    } finally {
      await Promise.all([authDatabase.pool.end(), tenantDatabase?.pool.end()]);
    }
  };
}

export const withAuthenticatedRequestContext =
  createAuthenticatedRequestContext();
