import { createDatabase as createHyperdriveDatabase } from "@polaris/db/client";
import { createBetterAuth } from "./auth";
import type { WorkerBindings } from "./environment";
import { TenantRequestContextError } from "./request-context-error";

type Database = ReturnType<typeof createHyperdriveDatabase>["db"];

interface AuthenticatedRequestSession {
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

    const { db, pool } = databaseFactory(
      input.bindings.HYPERDRIVE.connectionString,
      { maxConnections: 1 }
    );

    try {
      const auth = authFactory({ baseURL, database: db, secret });
      const session = await auth.api.getSession({
        headers: input.request.headers,
      });

      if (!session?.user.id.trim()) {
        throw new TenantRequestContextError("session_required");
      }

      return await input.operation(db, session);
    } finally {
      await pool.end();
    }
  };
}

export const withAuthenticatedRequestContext =
  createAuthenticatedRequestContext();
