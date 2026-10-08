import { createDatabase as createHyperdriveDatabase } from "@polaris/db/client";
import {
  withAuthorizedTenantTransaction,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { createBetterAuth } from "./auth";
import type { WorkerBindings } from "./environment";

type Database = ReturnType<typeof createHyperdriveDatabase>["db"];

type TenantRequestErrorCode =
  | "authentication_unavailable"
  | "session_required"
  | "organization_id_required";

export class TenantRequestContextError extends Error {
  readonly code: TenantRequestErrorCode;

  constructor(code: TenantRequestErrorCode) {
    super(code);
    this.code = code;
    this.name = "TenantRequestContextError";
  }
}

export interface TenantRequestSession {
  user: { id: string };
}

interface TenantSessionAuth {
  api: {
    getSession: (input: {
      headers: Headers;
    }) => Promise<TenantRequestSession | null>;
  };
}

export interface TenantRequestContextDependencies {
  createAuth: (options: {
    baseURL: string;
    database: Database;
    secret: string;
  }) => TenantSessionAuth;
  createDatabase: typeof createHyperdriveDatabase;
  withAuthorizedTenantTransaction: typeof withAuthorizedTenantTransaction;
}

export interface TenantRequestContextInput<T> {
  bindings: WorkerBindings;
  capability: string;
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>;
  request: Request;
  requestedOrganizationId: string;
}

/**
 * Resolves Better Auth before opening the tenant transaction. The user ID is
 * taken only from the verified server session; callers provide organization
 * context and a required capability, never an authenticated user ID.
 */
export function createTenantRequestContext(
  overrides: Partial<TenantRequestContextDependencies> = {}
) {
  const databaseFactory = overrides.createDatabase ?? createHyperdriveDatabase;
  const authFactory =
    overrides.createAuth ??
    ((options) => createBetterAuth(options) as TenantSessionAuth);
  const tenantTransaction =
    overrides.withAuthorizedTenantTransaction ??
    withAuthorizedTenantTransaction;

  return async function runTenantRequestContext<T>(
    input: TenantRequestContextInput<T>
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

      if (
        !input.requestedOrganizationId.trim() ||
        input.requestedOrganizationId !== input.requestedOrganizationId.trim()
      ) {
        throw new TenantRequestContextError("organization_id_required");
      }

      return await tenantTransaction(
        db,
        {
          authenticatedUserId: session.user.id,
          capability: input.capability,
          requestedOrganizationId: input.requestedOrganizationId,
        },
        input.operation
      );
    } finally {
      await pool.end();
    }
  };
}

export const withTenantRequestContext = createTenantRequestContext();
