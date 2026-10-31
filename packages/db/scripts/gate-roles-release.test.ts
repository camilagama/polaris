import { describe, expect, it } from "vitest";
import { withGateRole } from "./gate-roles";
import { sqlState } from "./sales-gate-support";

const READ_ONLY = "25006";
const NO_PRIVILEGE = "42501";
const GIVE_BACK = /could not give back polaris_x/;
const BECOME = /could not become polaris_x/;
const STILL_HOLDS = /still holds polaris_x/;

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
