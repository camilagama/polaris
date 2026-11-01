export const RUNNER_LOGIN_GRANTS_SQL =
  'SELECT r.rolcanlogin AS "canLogin", r.rolbypassrls AS "bypassRls", ' +
  'r.rolsuper AS superuser, r.rolcreatedb AS "createDb", r.rolcreaterole AS "createRole", ' +
  'r.rolreplication AS replication, m.admin_option AS admin, m.inherit_option AS inherit, m.set_option AS "set" ' +
  "FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid " +
  "WHERE r.rolname = $1 AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $2)";

export interface RunnerLoginGrantRow {
  admin: boolean;
  bypassRls: boolean;
  canLogin: boolean;
  createDb: boolean;
  createRole: boolean;
  inherit: boolean;
  replication: boolean;
  set: boolean;
  superuser: boolean;
}

/**
 * pg_auth_members holds one row per grantor, so the same membership granted by two roles is two rows. They are folded
 * into the one membership the login really has (INHERIT and SET hold if any grant gives them, ADMIN if any gives it);
 * no row at all stays an empty list, so a missing grant still fails the comparison.
 */
export function runnerLoginState(
  rows: readonly RunnerLoginGrantRow[]
): RunnerLoginGrantRow[] {
  const [first] = rows;
  if (!first) {
    return [];
  }
  return [
    {
      ...first,
      admin: rows.some((row) => row.admin),
      inherit: rows.some((row) => row.inherit),
      set: rows.some((row) => row.set),
    },
  ];
}
