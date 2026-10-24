import assert from "node:assert/strict";
import type { Client } from "pg";
import {
  findReachableRoles,
  OWNER_ROLE_LIKE,
} from "./definer-hardening-checks";

/**
 * The attributes and the memberships of the roles that run with elevated rights, read-only (used by
 * `staging:verify-database after-migrate` and by the migrations-without-superuser gate, and proved by the
 * definer-hardening gate). Two sets, checked the same way:
 *
 * - every `polaris_*_owner` role: it owns SECURITY DEFINER functions and is only a target of ownership, never a login;
 * - every role a runtime role reaches (`findReachableRoles`: itself, or by SET, INHERIT or ADMIN OPTION, through groups
 *   and chains), the `*_runtime` groups and the roles they can become, such as `polaris_closed_export_reader`. A
 *   BYPASSRLS or CREATEROLE there would go over the RLS of every tenant. The logins of the app are runtime roles too, but a login
 *   must be able to log in, so only its LOGIN is not asked of it (its other attributes are).
 *
 * Both must be NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS. No migration gives any
 * of them one of these (each `CREATE ROLE`/`ALTER ROLE` says NO…), so there is no exception; if one ever needs an
 * attribute, accept it here for that role only, with the reason.
 *
 * A `polaris_*_owner` role also has no edge out: it is a member (with INHERIT, SET or ADMIN OPTION, which can grant itself
 * both) of no other role. An owner role is only a target; an edge from one would widen what the SECURITY DEFINER functions
 * it owns can do, even if no runtime role reaches it. Today the only edge between `polaris_*` roles is
 * `polaris_privacy_runtime` being a member of `polaris_closed_export_reader` (SET), and that one is not an owner's. This rule replaces any list
 * of privileged roles for the owners. `pg_database_owner` does not count: it is implicit (the database owner by another
 * name), so no edge into it can exist.
 */
/** The `polaris_*_owner` roles the migrations create today (18 since 0100: polaris_billing_audit_owner): fewer means a role was renamed or is missing. */
export const MIN_OWNER_ROLES = 18;
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

// every edge that leaves an owner role with INHERIT, SET or ADMIN OPTION (a direct edge is enough: a chain starts with one)
const OWNER_MEMBERSHIP_SQL = `SELECT o.rolname AS owner, t.rolname AS target
   FROM pg_auth_members a
   JOIN pg_roles o ON o.oid = a.member
   JOIN pg_roles t ON t.oid = a.roleid
  WHERE o.rolname LIKE '${OWNER_ROLE_LIKE}'
    AND (a.inherit_option OR a.set_option OR a.admin_option)
    AND t.rolname <> 'pg_database_owner'
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
  /** `role: ATTRIBUTE` for the attributes held, then `owner->target` for each edge out of an owner role */
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
    "owner and runtime-reachable roles with an attribute they must not have (role: attribute) or an edge out of an owner role (owner->target)"
  );
  return check;
}
