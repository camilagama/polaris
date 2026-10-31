import { Client, type Pool, type QueryResult, type QueryResultRow } from "pg";
import { sqlState } from "./sales-gate-support";

/**
 * The two ways a gate acts as another role, so it runs the same with an owner who is a superuser (the CI service)
 * and with one who is not (`neondb_owner` on Neon).
 *
 * PostgreSQL 16+ makes a non-superuser with CREATEROLE an ADMIN-only member of every role it creates (INHERIT FALSE,
 * SET FALSE): it may grant the role, not become it, and it has no EXECUTE on a definer owned by a `polaris_*_owner`.
 * A bare `SET ROLE` of the owner only passes where the owner is a superuser.
 *
 * - `withGateRole`: the gate needs the power of the role itself (a definer probe, a write as a `*_owner`). The owner
 *   grants itself SET on the role for the duration of the work, as the migrations do, and gives it back.
 * - `runtimeConnection`: the assertion is about what the product does. The call goes through a login of the runtime
 *   group, the one the gate already created, never through the owner.
 */

export interface GateQueryable {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}

const roleNamePattern = /^[a-z_][a-z0-9_]*$/;
const abortedTransaction = "25P02";

function quotedRole(role: string): string {
  if (!roleNamePattern.test(role)) {
    throw new Error(`Not a role name a gate uses: ${JSON.stringify(role)}`);
  }
  return `"${role}"`;
}

async function firstRow<T>(
  client: GateQueryable,
  text: string,
  values: unknown[]
): Promise<T> {
  const result = (await client.query(text, values)) as { rows: T[] };
  const [row] = result.rows;
  if (!row) {
    throw new Error("The role check returned no row.");
  }
  return row;
}

/**
 * Runs `work` on `client` as `role`, then returns the session to its own user. The GRANT happens only when the
 * session user cannot already SET to the role (a superuser always can), so a membership that existed before is never
 * revoked. Inside a transaction the GRANT and the SET ROLE belong to it: if the transaction aborts, the caller's
 * ROLLBACK undoes both, and the error of `work` is the one that propagates.
 */
export async function withGateRole<T>(
  client: GateQueryable,
  role: string,
  work: () => Promise<T>
): Promise<T> {
  const quoted = quotedRole(role);
  const state = await firstRow<{ at_session: boolean; can_set: boolean }>(
    client,
    "SELECT current_user = session_user AS at_session, pg_has_role(session_user, $1, 'SET') AS can_set",
    [role]
  );
  if (!state.at_session) {
    throw new Error(
      `withGateRole(${role}) called while the session already acts as another role.`
    );
  }
  const granted = !state.can_set;
  if (granted) {
    await becomeOrThrow(
      client,
      role,
      `GRANT ${quoted} TO SESSION_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
    );
  }
  let failed = false;
  try {
    await becomeOrThrow(client, role, `SET ROLE ${quoted}`);
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await restoreSession(client, quoted, granted, failed);
  }
}

/**
 * A refusal of the gate's own GRANT or SET ROLE is a broken setup, never the refusal a check expects: the error carries
 * no SQLSTATE (and no cause), so `expectSqlState(…, "42501", …)` around the work cannot pass on it.
 */
async function becomeOrThrow(
  client: GateQueryable,
  role: string,
  statement: string
): Promise<void> {
  try {
    await client.query(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The gate could not become ${role}: ${message}`);
  }
}

async function restoreSession(
  client: GateQueryable,
  quoted: string,
  granted: boolean,
  failed: boolean
): Promise<void> {
  try {
    await client.query("RESET ROLE");
    if (granted) {
      await client.query(`REVOKE ${quoted} FROM SESSION_USER`);
    }
  } catch (error) {
    // an aborted transaction refuses both statements; the caller's ROLLBACK undoes the GRANT and the SET ROLE
    if (failed || sqlState(error) === abortedTransaction) {
      return;
    }
    throw error;
  }
}

/**
 * The login's own SET ROLE, the step the product itself takes (a runtime login to a group it may SET to). It never
 * grants: a login without the right fails here as it would in production, which is what a refusal test asserts.
 * `transaction` is SET LOCAL (ends with the transaction); `session` lasts until `resetLoginRole`.
 */
export async function setLoginRole(
  client: GateQueryable,
  role: string,
  scope: "session" | "transaction" = "transaction"
): Promise<void> {
  const quoted = quotedRole(role);
  await client.query(
    scope === "transaction" ? `SET LOCAL ROLE ${quoted}` : `SET ROLE ${quoted}`
  );
}

export async function resetLoginRole(client: GateQueryable): Promise<void> {
  await client.query("RESET ROLE");
}

/** One connection of a runtime login the gate created (its URL), closed after `operation`. */
export async function runtimeConnection<T>(
  loginUrl: string,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString: loginUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

/** One statement as `role` (withGateRole), in a transaction that is always rolled back. */
export async function queryAsGateRole<R extends QueryResultRow>(
  pool: Pool,
  role: string,
  text: string,
  values: unknown[] = []
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await withGateRole(client, role, () =>
      client.query<R>(text, values)
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
