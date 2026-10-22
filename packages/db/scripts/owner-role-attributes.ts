import assert from "node:assert/strict";
import type { Client } from "pg";
import { findReachableRoles } from "./definer-hardening-checks";

/**
 * The attributes and the memberships of the roles that run with elevated rights, read-only (used by
 * `staging:verify-database after-migrate` and by the migrations-without-superuser gate, and proved by the
 * definer-hardening gate). Two sets, checked the same way:
 *
 * - every `polaris_*_owner` role: it owns SECURITY DEFINER functions and is only a target of ownership, never a login;
 * - every role a runtime role reaches (`findReachableRoles`: itself, or by SET or INHERIT, through groups and chains),
 *   the `*_runtime` groups and the roles they can become, such as `polaris_closed_export_reader`. A BYPASSRLS or
 *   CREATEROLE there would go over the RLS of every tenant. The logins of the app are runtime roles too, but a login
 *   must be able to log in, so only its LOGIN is not asked of it (its other attributes are).
 *
 * Both must be NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS. No migration gives any
 * of them one of these (each `CREATE ROLE`/`ALTER ROLE` says NO…), so there is no exception; if one ever needs an
 * attribute, accept it here for that role only, with the reason.
 *
 * A `polaris_*_owner` role is also not a member (SET, INHERIT, or ADMIN OPTION, which can grant itself both) of a
 * privileged role: `neon_superuser`, the predefined roles that read or write data or files or run programs, any role
 * with SUPERUSER, BYPASSRLS or CREATEROLE, or the database owner.
 */
const OWNER_ROLE_LIKE = "polaris\\_%\\_owner";

/** The `polaris_*_owner` roles the migrations create today: fewer means a role was renamed or is missing. */
export const MIN_OWNER_ROLES = 14;
/** What the migrations and the runbook leave reachable besides the logins: the 9 `*_runtime` groups (`polaris_pr11_runtime` is created by hand) and `polaris_closed_export_reader`. */
export const MIN_REACHABLE_ROLES = 10;
/** The one reachable role besides the groups that the migrations name: a rename would leave the count unchanged, so it is asked for by name. */
const CLOSED_EXPORT_READER = "polaris_closed_export_reader";

export interface OwnerRoleRow {
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolname: string;
  rolreplication: boolean;
  rolsuper: boolean;
}

type Attribute =
  | "BYPASSRLS"
  | "CREATEDB"
  | "CREATEROLE"
  | "LOGIN"
  | "REPLICATION"
  | "SUPERUSER";

const OWNER_ROLES_SQL = `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
   FROM pg_roles
  WHERE rolname LIKE '${OWNER_ROLE_LIKE}'
  ORDER BY 1`;

// the owner reaches a privileged role when a role it can become with SET ROLE (itself included) inherits it, can SET to it or has ADMIN OPTION on it
const OWNER_MEMBERSHIP_SQL = `SELECT DISTINCT o.rolname AS owner, t.rolname AS target
   FROM pg_roles o
   JOIN pg_roles via ON pg_has_role(o.oid, via.oid, 'SET')
   JOIN pg_roles t ON t.oid <> via.oid
    AND (t.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
      OR t.rolname = 'neon_superuser'
      OR t.rolsuper OR t.rolbypassrls OR t.rolcreaterole
      OR t.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_read_all_data', 'pg_write_all_data'))
  WHERE o.rolname LIKE '${OWNER_ROLE_LIKE}'
    AND NOT o.rolsuper
    AND t.rolname <> 'pg_database_owner'
    AND (pg_has_role(via.oid, t.oid, 'SET')
      OR pg_has_role(via.oid, t.oid, 'USAGE')
      OR EXISTS (
        SELECT 1 FROM pg_auth_members a
         WHERE a.roleid = t.oid AND a.admin_option
           AND (pg_has_role(via.oid, a.member, 'SET') OR pg_has_role(via.oid, a.member, 'USAGE'))
      ))
  ORDER BY 1, 2`;

/** `role: ATTRIBUTE` for each attribute a role holds and must not; `skipLogin` names the roles that may log in. */
export function ownerAttributeFindings(
  rows: OwnerRoleRow[],
  skipLogin: ReadonlySet<string> = new Set()
): string[] {
  const findings: string[] = [];
  for (const row of rows) {
    const held: [Attribute, boolean][] = [
      ["LOGIN", row.rolcanlogin && !skipLogin.has(row.rolname)],
      ["SUPERUSER", row.rolsuper],
      ["CREATEROLE", row.rolcreaterole],
      ["CREATEDB", row.rolcreatedb],
      ["REPLICATION", row.rolreplication],
      ["BYPASSRLS", row.rolbypassrls],
    ];
    for (const [attribute, isHeld] of held) {
      if (isHeld) {
        findings.push(`${row.rolname}: ${attribute}`);
      }
    }
  }
  return findings;
}

export interface RoleCheck {
  /** `role: ATTRIBUTE` for the attributes held, then `owner->target` for the memberships */
  findings: string[];
  owners: number;
  /** the reachable roles that are not owners or logins of the app, those that must exist */
  reachable: number;
  reachableNames: string[];
}

export async function findOwnerAttributeViolations(
  client: Client
): Promise<RoleCheck> {
  const { rows: owners } = await client.query<OwnerRoleRow>(OWNER_ROLES_SQL);
  const ownerNames = new Set(owners.map((row) => row.rolname));
  const reachable = (await findReachableRoles(client)).filter(
    (row) => !ownerNames.has(row.rolname)
  );
  const logins = new Set(
    reachable.filter((row) => row.is_login).map((row) => row.rolname)
  );
  const { rows: memberships } = await client.query<{
    owner: string;
    target: string;
  }>(OWNER_MEMBERSHIP_SQL);
  return {
    findings: [
      ...ownerAttributeFindings(owners),
      ...ownerAttributeFindings(reachable, logins),
      ...memberships.map((row) => `${row.owner}->${row.target}`),
    ],
    owners: owners.length,
    reachable: reachable.length - logins.size,
    reachableNames: reachable.map((row) => row.rolname),
  };
}

/** The check as the staging after-migrate and the gates run it: a floor on what was looked at, then no finding. */
export async function assertOwnerRolesClean(
  client: Client
): Promise<RoleCheck> {
  const check = await findOwnerAttributeViolations(client);
  assert.ok(
    check.owners >= MIN_OWNER_ROLES,
    `fewer polaris_*_owner roles than the migrations create (${check.owners}, at least ${MIN_OWNER_ROLES}): a role was renamed or is missing`
  );
  assert.ok(
    check.reachable >= MIN_REACHABLE_ROLES,
    `fewer roles reachable from a runtime role than the migrations create (${check.reachable}, at least ${MIN_REACHABLE_ROLES}): a role was renamed or is missing`
  );
  assert.ok(
    check.reachableNames.includes(CLOSED_EXPORT_READER),
    `${CLOSED_EXPORT_READER} is not reachable from a runtime role: it was renamed or lost its edge`
  );
  assert.deepEqual(
    check.findings,
    [],
    "owner and runtime-reachable roles with an attribute they must not have (role: attribute) or a membership in a privileged role (owner->target)"
  );
  return check;
}
