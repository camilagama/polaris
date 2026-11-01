import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { queryAsFunctionOwner, withGateRole } from "./gate-roles";
import { sqlState } from "./sales-gate-support";

const READ_ONLY = "25006";
const NO_PRIVILEGE = "42501";
const GIVE_BACK = /could not give back polaris_x/;
const BECOME = /could not become polaris_x/;
const STILL_HOLDS = /still holds polaris_x/;
const STATEMENT_FAILURE = /refused \(42501\)/;
const REVOKE_FAILURE = /could not revoke polaris_x/;
const REDACTED_URL = /connection to \[redacted\] lost/;
const SECRET = /s3cret|owner:/;

function pgError(code: string): Error {
  return Object.assign(new Error(`refused (${code})`), { code });
}

/**
 * A session the owner cannot SET from (as on Neon), so withGateRole grants. `refuse` makes the statement that starts
 * with the key fail with the error given; `canSetAfterRevoke` makes the check after the REVOKE still find the role.
 */
function fakeClient(
  refuse: Record<string, Error> = {},
  canSetAfterRevoke = false
) {
  const statements: string[] = [];
  let revoked = false;
  return {
    client: {
      query: (text: string) => {
        statements.push(text);
        for (const [start, error] of Object.entries(refuse)) {
          if (text.startsWith(start)) {
            return Promise.reject(error);
          }
        }
        if (text.startsWith("REVOKE")) {
          revoked = true;
        }
        if (text.includes("AS at_session")) {
          return Promise.resolve({
            rows: [{ at_session: true, can_set: false }],
          });
        }
        if (text.includes("AS can_set")) {
          return Promise.resolve({
            rows: [{ can_set: revoked ? canSetAfterRevoke : true }],
          });
        }
        return Promise.resolve({ rows: [] });
      },
    },
    statements,
  };
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("withGateRole", () => {
  it("grants, becomes, gives back and checks the REVOKE", async () => {
    const { client, statements } = fakeClient();
    await withGateRole(client, "polaris_x", () => Promise.resolve());
    expect(statements.slice(1)).toEqual([
      'GRANT "polaris_x" TO SESSION_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE',
      'SET ROLE "polaris_x"',
      "RESET ROLE",
      'REVOKE "polaris_x" FROM SESSION_USER',
      "SELECT pg_has_role(session_user, $1, 'SET') AS can_set",
    ]);
  });

  it("turns a refused give-back into an error with no SQLSTATE, so no expected refusal passes on it", async () => {
    const { client } = fakeClient({ REVOKE: pgError(READ_ONLY) });
    const error = await failureOf(() =>
      withGateRole(client, "polaris_x", () => Promise.resolve())
    );
    expect(String(error)).toMatch(GIVE_BACK);
    expect(sqlState(error)).toBeUndefined();
  });

  it("turns a refused GRANT into an error with no SQLSTATE", async () => {
    const { client } = fakeClient({ GRANT: pgError(NO_PRIVILEGE) });
    const error = await failureOf(() =>
      withGateRole(client, "polaris_x", () => Promise.resolve())
    );
    expect(String(error)).toMatch(BECOME);
    expect(sqlState(error)).toBeUndefined();
  });

  it("lets the error of the work through when the give-back fails after it", async () => {
    const { client } = fakeClient({ REVOKE: pgError(READ_ONLY) });
    const error = await failureOf(() =>
      withGateRole(client, "polaris_x", () =>
        Promise.reject(pgError(NO_PRIVILEGE))
      )
    );
    expect(sqlState(error)).toBe(NO_PRIVILEGE);
  });

  it("fails when the session still holds the role after its REVOKE", async () => {
    const { client } = fakeClient({}, true);
    const error = await failureOf(() =>
      withGateRole(client, "polaris_x", () => Promise.resolve())
    );
    expect(String(error)).toMatch(STILL_HOLDS);
    expect(sqlState(error)).toBeUndefined();
  });
});

function fakeOwnerPool(options: {
  canSetAlready: boolean;
  failGiveBack?: boolean;
  failWork: boolean;
  holdsAfterRevoke?: boolean;
}) {
  const connections: Array<{ released: boolean | undefined; sql: string[] }> =
    [];
  const pool = {
    connect: () => {
      const connection: {
        released: boolean | undefined;
        sql: string[];
      } = { released: undefined, sql: [] };
      let revoked = false;
      connections.push(connection);
      return Promise.resolve({
        query: (text: string) => {
          connection.sql.push(text);
          if (text.includes("AS owner")) {
            return Promise.resolve({ rows: [{ owner: "polaris_x" }] });
          }
          if (text.includes("AS at_session")) {
            return Promise.resolve({
              rows: [{ at_session: true, can_set: options.canSetAlready }],
            });
          }
          if (text.includes("AS needs_grant")) {
            return Promise.resolve({
              rows: [{ needs_grant: !options.canSetAlready }],
            });
          }
          if (text.includes("AS can_set")) {
            return Promise.resolve({
              rows: [
                {
                  can_set: revoked
                    ? options.holdsAfterRevoke === true
                    : options.canSetAlready,
                },
              ],
            });
          }
          if (text.startsWith("REVOKE")) {
            revoked = true;
          }
          if (options.failGiveBack && text.startsWith("REVOKE")) {
            return Promise.reject(
              new Error(
                "connection to postgresql://owner:s3cret@db.internal/neondb lost"
              )
            );
          }
          if (text === "GRANT EXECUTE ON FUNCTION f() TO PUBLIC") {
            return options.failWork
              ? Promise.reject(pgError(NO_PRIVILEGE))
              : Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        },
        release: (destroy?: boolean) => {
          connection.released = destroy === true;
        },
      });
    },
  };
  return { connections, pool: pool as unknown as Pool };
}

const OWNER_STATEMENT = "GRANT EXECUTE ON FUNCTION f() TO PUBLIC";

describe("queryAsFunctionOwner", () => {
  it("revokes what it granted from a new connection when the statement fails, and the error of the statement propagates", async () => {
    const { connections, pool } = fakeOwnerPool({
      canSetAlready: false,
      failWork: true,
    });
    const error = await failureOf(() =>
      queryAsFunctionOwner(pool, "f()", OWNER_STATEMENT)
    );
    expect(sqlState(error)).toBe(NO_PRIVILEGE);
    expect(connections).toHaveLength(2);
    expect(connections[0]?.released).toBe(true);
    expect(connections[1]?.sql).toEqual([
      'REVOKE "polaris_x" FROM SESSION_USER',
      "SELECT pg_has_role(session_user, $1, 'SET') AS can_set",
    ]);
    expect(connections[1]?.released).toBe(false);
  });

  it("rejects naming both failures, with no SQLSTATE and no secret, when the revoke from the new connection fails too", async () => {
    const { connections, pool } = fakeOwnerPool({
      canSetAlready: false,
      failGiveBack: true,
      failWork: true,
    });
    const error = await failureOf(() =>
      queryAsFunctionOwner(pool, "f()", OWNER_STATEMENT)
    );
    expect(error).toBeInstanceOf(AggregateError);
    const message = String(error);
    expect(message).toMatch(STATEMENT_FAILURE);
    expect(message).toMatch(REVOKE_FAILURE);
    expect(message).toMatch(REDACTED_URL);
    expect(message).not.toMatch(SECRET);
    expect(inspect(error, { depth: 5 })).not.toMatch(SECRET);
    expect(sqlState(error)).toBeUndefined();
    expect(connections).toHaveLength(2);
    expect(connections[0]?.released).toBe(true);
    expect(connections[1]?.sql).toEqual([
      'REVOKE "polaris_x" FROM SESSION_USER',
    ]);
  });

  it("rejects with both failures, no SQLSTATE and the connection discarded when the revoke runs but the role stays", async () => {
    const { connections, pool } = fakeOwnerPool({
      canSetAlready: false,
      failWork: true,
      holdsAfterRevoke: true,
    });
    const error = await failureOf(() =>
      queryAsFunctionOwner(pool, "f()", OWNER_STATEMENT)
    );
    expect(error).toBeInstanceOf(AggregateError);
    const message = String(error);
    expect(message).toMatch(STATEMENT_FAILURE);
    expect(message).toMatch(REVOKE_FAILURE);
    expect(message).toMatch(STILL_HOLDS);
    expect(sqlState(error)).toBeUndefined();
    expect(connections).toHaveLength(2);
    expect(connections[1]?.released).toBe(true);
  });

  it("opens no second connection when it granted nothing", async () => {
    const { connections, pool } = fakeOwnerPool({
      canSetAlready: true,
      failWork: true,
    });
    await failureOf(() => queryAsFunctionOwner(pool, "f()", OWNER_STATEMENT));
    expect(connections).toHaveLength(1);
  });

  it("returns the connection to the pool when the statement works", async () => {
    const { connections, pool } = fakeOwnerPool({
      canSetAlready: false,
      failWork: false,
    });
    await queryAsFunctionOwner(pool, "f()", OWNER_STATEMENT);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.released).toBe(false);
  });
});
