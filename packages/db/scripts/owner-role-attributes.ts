import type { Client } from "pg";

/**
 * The attributes of the `polaris_*_owner` roles, read-only (used by `staging:verify-database after-migrate`
 * and proved by the definer-hardening gate). Each of these roles owns SECURITY DEFINER functions and is only a
 * target of ownership, never a login, so all of them must be NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB,
 * NOREPLICATION and NOBYPASSRLS. No migration gives any of them BYPASSRLS (each `CREATE ROLE`/`ALTER ROLE` of a
 * `*_owner` says NOBYPASSRLS), so there is no exception: if one ever needs it, list it in `ALLOWED_ATTRIBUTES`
 * with the reason, for that role only.
 */
const OWNER_ROLE_LIKE = "polaris\\_%\\_owner";

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

// role name -> attributes it may hold, with the reason in a comment; empty on purpose (checked in the migrations)
const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly Attribute[]>> = {};

const OWNER_ROLES_SQL = `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
   FROM pg_roles
  WHERE rolname LIKE '${OWNER_ROLE_LIKE}'
  ORDER BY 1`;

/** `role: ATTRIBUTE` for each attribute a `polaris_*_owner` role holds and must not. */
export function ownerAttributeFindings(rows: OwnerRoleRow[]): string[] {
  const findings: string[] = [];
  for (const row of rows) {
    const held: [Attribute, boolean][] = [
      ["LOGIN", row.rolcanlogin],
      ["SUPERUSER", row.rolsuper],
      ["CREATEROLE", row.rolcreaterole],
      ["CREATEDB", row.rolcreatedb],
      ["REPLICATION", row.rolreplication],
      ["BYPASSRLS", row.rolbypassrls],
    ];
    const allowed = ALLOWED_ATTRIBUTES[row.rolname] ?? [];
    for (const [attribute, isHeld] of held) {
      if (isHeld && !allowed.includes(attribute)) {
        findings.push(`${row.rolname}: ${attribute}`);
      }
    }
  }
  return findings;
}

export async function findOwnerAttributeViolations(
  client: Client
): Promise<{ checked: number; findings: string[] }> {
  const { rows } = await client.query<OwnerRoleRow>(OWNER_ROLES_SQL);
  return { checked: rows.length, findings: ownerAttributeFindings(rows) };
}
