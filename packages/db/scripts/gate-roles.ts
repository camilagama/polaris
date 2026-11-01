import type { Pool, QueryResult, QueryResultRow } from "pg";
import { redactConnectionStrings, sqlState } from "./sales-gate-support";

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
 * - `setLoginRole`: the assertion is about what the product does, on an object whose existence the gate already
 *   confirmed. The gate's own login of the runtime group does the SET ROLE, never the owner, and never grants.
 *   `withGateRole` also plays the group in the mutants (the definition replaced as its owner), where the object is the
 *   thing under test.
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
 * session user cannot already SET to the role (a superuser always can), so a membership that already allowed SET is
 * never revoked; the REVOKE is checked (the session user can no longer SET to the role). Inside a transaction the GRANT and the SET ROLE belong to it: if the transaction aborts, the caller's
 * ROLLBACK undoes both, and the error of `work` is the one that propagates.
 */
export async function withGateRole<T>(
  client: GateQueryable,
  role: string,
  work: () => Promise<T>
): Promise<T> {
  const release = await becomeGateRole(client, role);
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await release(failed);
  }
}

/**
 * The two halves of `withGateRole`, for a session that acts as the role across the whole gate: becomes the role now
 * and returns the call that gives the session back (RESET ROLE, and the REVOKE of what it granted). Pass `failed` when
 * an error is already on its way, so a failure of the release does not hide it.
 */
export async function becomeGateRole(
  client: GateQueryable,
  role: string
): Promise<(failed?: boolean) => Promise<void>> {
  const quoted = quotedRole(role);
  const state = await firstRow<{ at_session: boolean; can_set: boolean }>(
    client,
    "SELECT current_user = session_user AS at_session, pg_has_role(session_user, $1, 'SET') AS can_set",
    [role]
  );
  if (!state.at_session) {
    throw new Error(
      `The gate asked for ${role} while the session already acts as another role.`
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
  try {
    await becomeOrThrow(client, role, `SET ROLE ${quoted}`);
  } catch (error) {
    await restoreSession(client, role, granted, true);
    throw error;
  }
  return (failed = false) => restoreSession(client, role, granted, failed);
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
    // biome-ignore lint/style/useErrorCause: sqlState follows `cause`, and this error must carry no SQLSTATE
    throw new Error(`The gate could not become ${role}: ${message}`);
  }
}

async function restoreSession(
  client: GateQueryable,
  role: string,
  granted: boolean,
  failed: boolean
): Promise<void> {
  const quoted = quotedRole(role);
  try {
    await client.query("RESET ROLE");
    if (granted) {
      await client.query(`REVOKE ${quoted} FROM SESSION_USER`);
      const { can_set } = await firstRow<{ can_set: boolean }>(
        client,
        "SELECT pg_has_role(session_user, $1, 'SET') AS can_set",
        [role]
      );
      if (can_set) {
        throw new Error(`The gate still holds ${role} after its REVOKE.`);
      }
    }
  } catch (error) {
    // an aborted transaction refuses both statements; the caller's ROLLBACK undoes the GRANT and the SET ROLE
    if (failed || sqlState(error) === abortedTransaction) {
      return;
    }
    // without SQLSTATE: a refusal of the gate's own RESET or REVOKE (a read-only transaction refuses the REVOKE with
    // 25006) must never pass for the refusal a check expects around the work
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: sqlState follows `cause`, and this error must carry no SQLSTATE
    throw new Error(`The gate could not give back ${role}: ${message}`);
  }
}

/**
 * The login's own SET ROLE, the step the product itself takes (a runtime login to a group it may SET to). It never
 * grants: a login without the right fails here as it would in production, which is what a refusal test asserts.
 * `transaction` is SET LOCAL (ends with the transaction); `session` lasts until the connection closes.
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
    const rolledBack = await client.query("ROLLBACK").then(
      () => true,
      () => false
    );
    client.release(!rolledBack);
  }
}

/**
 * Replaces a function with `definition` (a mutant, or the live body with a fixed clock) as the role that owns it, so it
 * keeps its owner and its grants. CREATE OR REPLACE needs CREATE on the schema, which the owner roles hold only while a
 * migration runs: it is granted for the statement and taken back. Call it inside a transaction the caller rolls back.
 */
export async function replaceFunctionAsOwner(
  client: GateQueryable,
  signature: string,
  definition: string
): Promise<void> {
  const { can_create, owner } = await firstRow<{
    can_create: boolean;
    owner: string;
  }>(
    client,
    "SELECT proowner::regrole::text AS owner, has_schema_privilege(proowner, 'public', 'CREATE') AS can_create FROM pg_proc WHERE oid = $1::regprocedure",
    [signature]
  );
  const quoted = quotedRole(owner);
  if (!can_create) {
    await client.query(`GRANT CREATE ON SCHEMA public TO ${quoted}`);
  }
  await withGateRole(client, owner, () => client.query(definition));
  if (!can_create) {
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${quoted}`);
  }
}

/**
 * A statement on a function that only its owner may run (GRANT or REVOKE EXECUTE), as that owner, outside a transaction.
 * When the statement fails, the connection is discarded and the GRANT of the role this call made is revoked from a new
 * one, so the edge does not stay in the database, and the error of the statement propagates. If that revoke fails
 * too, or runs but leaves the session able to SET to the role, the call rejects with an AggregateError that names both
 * failures and carries no SQLSTATE: a caller that expects a refusal of the statement must not take it for one while
 * the grant may still be in the database.
 */
export async function queryAsFunctionOwner(
  pool: Pool,
  signature: string,
  statement: string
): Promise<void> {
  const client = await pool.connect();
  let owner: string | undefined;
  let granted = false;
  try {
    ({ owner } = await firstRow<{ owner: string }>(
      client,
      "SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = $1::regprocedure",
      [signature]
    ));
    ({ needs_grant: granted } = await firstRow<{ needs_grant: boolean }>(
      client,
      "SELECT NOT pg_has_role(session_user, $1, 'SET') AS needs_grant",
      [owner]
    ));
    await withGateRole(client, owner, () => client.query(statement));
    client.release();
  } catch (error) {
    // outside a transaction a failed give-back stays committed: the connection must not return to the pool
    client.release(true);
    if (owner && granted) {
      try {
        await giveBackGrant(pool, owner);
      } catch (giveBackError) {
        // biome-ignore lint/style/useErrorCause: sqlState follows `cause`, and this error must carry no SQLSTATE
        throw new AggregateError(
          [
            new Error(failureMessage(error)),
            new Error(failureMessage(giveBackError)),
          ],
          `The statement failed (${failureMessage(error)}) and the gate could not revoke ${owner} from a new connection (${failureMessage(giveBackError)}): the grant may still be in the database.`
        );
      }
    }
    throw error;
  }
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactConnectionStrings(message);
}

/**
 * Revokes, from a new connection, the GRANT a failed `queryAsFunctionOwner` made, and checks it as `restoreSession`
 * does: a REVOKE that runs but leaves the session able to SET to the role (the right also reaches it through another
 * membership) is a failure, not a clean give-back. The error carries no SQLSTATE; the connection is discarded on any
 * failure because outside a transaction nothing undoes what it did.
 */
async function giveBackGrant(pool: Pool, role: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`REVOKE ${quotedRole(role)} FROM SESSION_USER`);
    const { can_set } = await firstRow<{ can_set: boolean }>(
      client,
      "SELECT pg_has_role(session_user, $1, 'SET') AS can_set",
      [role]
    );
    if (can_set) {
      throw new Error(`The gate still holds ${role} after its REVOKE.`);
    }
    client.release();
  } catch (error) {
    client.release(true);
    throw error;
  }
}
