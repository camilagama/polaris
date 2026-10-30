import { eq, sql } from "drizzle-orm";
import { type createRlsPocDatabase, rlsPocOperations } from "./rls-poc-client";
import {
  type TenantTransaction,
  withRlsPocTransaction,
} from "./tenant-transaction";

export type RlsPocOrganizationId = "org_a" | "org_b";
type Database = ReturnType<typeof createRlsPocDatabase>;

interface DatabaseState {
  backendPid: number;
  organizationId: string | null;
  transactionId: string;
}

// Fixed values (organizations, seed tokens) work only because the gate database
// is disposable: the bootstrap seeds them once into an empty database, and the
// gate cleans up after itself. Never point this gate at a database with data.
const seedTokens: Record<RlsPocOrganizationId, string> = {
  org_a: "seed-a",
  org_b: "seed-b",
};

const retryableSqlStates = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "57P01",
  "57P02",
  "57P03",
]);
const retryableConnectionMessage =
  /connection terminated|connection reset|socket hang up|connection error and is not queryable/i;

function getSqlState(
  error: unknown,
  visited = new Set<object>()
): string | undefined {
  if (!error || typeof error !== "object" || visited.has(error)) {
    return undefined;
  }
  visited.add(error);

  const candidate = error as { cause?: unknown; code?: unknown };
  if (typeof candidate.code === "string") {
    return candidate.code;
  }

  return getSqlState(candidate.cause, visited);
}

function isRetryableConnectionFailure(
  error: unknown,
  visited = new Set<object>()
): boolean {
  if (!error || typeof error !== "object" || visited.has(error)) {
    return false;
  }
  visited.add(error);

  const candidate = error as {
    cause?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message =
    typeof candidate.message === "string" ? candidate.message : "";

  if (
    code.startsWith("08") ||
    retryableSqlStates.has(code) ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    retryableConnectionMessage.test(message)
  ) {
    return true;
  }

  return isRetryableConnectionFailure(candidate.cause, visited);
}

/**
 * Private to this fixture. Only synthetic writes with a stable `(org, token)`
 * key use it, so a transaction can be replayed after a connection failure.
 */
async function withRetryableTenantTransaction<T>(
  database: Database,
  organizationId: RlsPocOrganizationId,
  operation: (transaction: TenantTransaction, attempt: number) => Promise<T>,
  maxAttempts = 2
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Retry attempts must be sequential and stop after the first success.
      return await withRlsPocTransaction(database.db, organizationId, (tx) =>
        operation(tx, attempt)
      );
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableConnectionFailure(error)) {
        throw error;
      }
    }
  }

  throw new Error("Tenant transaction exhausted its retry attempts.");
}

async function readDatabaseState(transaction: TenantTransaction) {
  const result = await transaction.execute(
    sql<DatabaseState>`SELECT
      current_setting('app.organization_id', true) AS "organizationId",
      pg_current_xact_id()::text AS "transactionId",
      pg_backend_pid() AS "backendPid"`
  );
  const state = result.rows[0] as DatabaseState | undefined;

  if (!state) {
    throw new Error("The RLS POC could not read transaction diagnostics.");
  }

  return state;
}

export function readRlsPocRows(
  database: Database,
  organizationId: RlsPocOrganizationId,
  crossTenant = false,
  delayMs = 0
) {
  return withRlsPocTransaction(
    database.db,
    organizationId,
    async (transaction) => {
      const firstState = await readDatabaseState(transaction);
      if (delayMs > 0) {
        await transaction.execute(sql`SELECT pg_sleep(${delayMs / 1000})`);
      }

      const tokenToRead = crossTenant
        ? seedTokens[organizationId === "org_a" ? "org_b" : "org_a"]
        : seedTokens[organizationId];
      const rows = await transaction
        .select({
          organizationId: rlsPocOperations.organizationId,
          token: rlsPocOperations.token,
          value: rlsPocOperations.value,
        })
        .from(rlsPocOperations)
        .where(eq(rlsPocOperations.token, tokenToRead));
      const secondState = await readDatabaseState(transaction);

      return { firstState, rows, secondState };
    }
  );
}

export function readRlsPocWithoutContext(database: Database) {
  return database.db.transaction(async (transaction) => {
    const state = await readDatabaseState(transaction);
    const rows = await transaction
      .select({
        organizationId: rlsPocOperations.organizationId,
        token: rlsPocOperations.token,
      })
      .from(rlsPocOperations);
    return { ...state, rows };
  });
}

export async function verifyRlsPocTransactionContextReset(
  database: Database,
  organizationId: RlsPocOrganizationId
) {
  const tenantState = await withRlsPocTransaction(
    database.db,
    organizationId,
    readDatabaseState
  );
  const contextless = await database.db.transaction(async (transaction) => {
    const state = await readDatabaseState(transaction);
    const rows = await transaction
      .select({
        organizationId: rlsPocOperations.organizationId,
        token: rlsPocOperations.token,
      })
      .from(rlsPocOperations);

    return { rows, state };
  });

  return {
    contextlessState: contextless.state,
    tenantState,
    visibleRows: contextless.rows,
  };
}

export async function verifyRlsPocRollback(
  database: Database,
  organizationId: RlsPocOrganizationId,
  token: string
) {
  try {
    await withRlsPocTransaction(database.db, organizationId, async (tx) => {
      await tx.insert(rlsPocOperations).values({
        organizationId,
        token,
        value: "must roll back",
      });
      throw new Error("intentional_poc_rollback");
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "intentional_poc_rollback"
    ) {
      throw error;
    }
  }

  const rows = await withRlsPocTransaction(database.db, organizationId, (tx) =>
    tx
      .select({ token: rlsPocOperations.token })
      .from(rlsPocOperations)
      .where(eq(rlsPocOperations.token, token))
  );

  return rows.length === 0;
}

export async function verifyRlsPocStatementFailure(
  database: Database,
  organizationId: RlsPocOrganizationId,
  token: string
) {
  let statementFailed = false;
  let attempts = 0;

  try {
    await withRetryableTenantTransaction(
      database,
      organizationId,
      async (tx) => {
        attempts += 1;
        await tx
          .insert(rlsPocOperations)
          .values({
            organizationId,
            token,
            value: "must roll back after statement error",
          })
          .onConflictDoNothing();
        await tx.execute(sql`SELECT 1 / 0`);
      }
    );
  } catch (error) {
    if (getSqlState(error) !== "22012") {
      throw error;
    }
    statementFailed = true;
  }

  const rows = await withRlsPocTransaction(database.db, organizationId, (tx) =>
    tx
      .select({ token: rlsPocOperations.token })
      .from(rlsPocOperations)
      .where(eq(rlsPocOperations.token, token))
  );

  return { attempts, rolledBack: rows.length === 0, statementFailed };
}

export async function verifyRlsPocCrossWrite(
  database: Database,
  organizationId: RlsPocOrganizationId,
  token: string
) {
  const otherOrganizationId: RlsPocOrganizationId =
    organizationId === "org_a" ? "org_b" : "org_a";

  try {
    await withRlsPocTransaction(database.db, organizationId, (tx) =>
      tx.insert(rlsPocOperations).values({
        organizationId: otherOrganizationId,
        token,
        value: "must be rejected by RLS",
      })
    );
    return false;
  } catch (error) {
    if (getSqlState(error) === "42501") {
      return true;
    }
    throw error;
  }
}

export async function retryRlsPocAfterConnectionFailure(
  database: Database,
  organizationId: RlsPocOrganizationId,
  token: string
) {
  let attempts = 0;
  const contexts: Array<string | null> = [];
  const transactionIds: string[] = [];
  const applicationName = `polaris_pr11_${token}`;

  const result = await withRetryableTenantTransaction(
    database,
    organizationId,
    async (tx, attempt) => {
      attempts += 1;
      await tx.execute(
        sql`SELECT set_config('application_name', ${applicationName}, true)`
      );
      const state = await readDatabaseState(tx);
      contexts.push(state.organizationId);
      transactionIds.push(state.transactionId);

      await tx
        .insert(rlsPocOperations)
        .values({ organizationId, token, value: "retry survives once" })
        .onConflictDoNothing();

      if (attempt === 1) {
        await tx.execute(sql`SELECT pg_sleep(30)`);
      }

      const rows = await tx
        .select({ token: rlsPocOperations.token })
        .from(rlsPocOperations)
        .where(eq(rlsPocOperations.token, token));

      return { rows };
    }
  );

  return {
    attempts,
    contexts,
    rowsFound: result.rows.length,
    transactionIds,
  };
}
