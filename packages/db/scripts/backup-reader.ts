import type { Client } from "pg";

/**
 * The backup login (ADR 0099): the one login outside the `polaris_*_runtime` groups that the environment checks accept,
 * by its exact name and only with exactly these attributes. It reads everything (BYPASSRLS, because pg_dump refuses a
 * table its row security would filter, and `pg_read_all_data`), so anything more than that is a finding: a write
 * privilege, an object it owns, a policy or grant naming it, another membership, or someone able to become it.
 */
export const BACKUP_READER = "polaris_backup_reader";
export const BACKUP_READER_CONNECTION_LIMIT = 2;
const READ_ALL_DATA = "pg_read_all_data";
const READ_ONLY_SETTING = "default_transaction_read_only=on";

export interface BackupReaderRow {
  /** members of the login other than the database owner's ADMIN-only edge of PostgreSQL 16+ */
  members: string[];
  memberships: {
    admin: boolean;
    inherit: boolean;
    role: string;
    set: boolean;
  }[];
  /** objects, grants, policies and default privileges that name the login (pg_shdepend, every database) */
  references: number;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolconfig: string[] | null;
  rolconnlimit: number;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolsuper: boolean;
}

export const BACKUP_READER_SQL = `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
       r.rolbypassrls, r.rolinherit, r.rolconnlimit, r.rolconfig,
       coalesce((SELECT json_agg(json_build_object('role', g.rolname, 'inherit', m.inherit_option,
                                                   'set', m.set_option, 'admin', m.admin_option) ORDER BY g.rolname)
                   FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid), '[]'::json) AS memberships,
       coalesce((SELECT json_agg(u.rolname ORDER BY u.rolname)
                   FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid = m.member
                  WHERE m.roleid = r.oid
                    AND NOT (u.oid = (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
                             AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option)), '[]'::json) AS members,
       (SELECT count(*)::int FROM pg_catalog.pg_shdepend s
         WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid = r.oid) AS "references"
  FROM pg_catalog.pg_roles r
 WHERE r.rolname = $1`;

const ATTRIBUTES: [keyof BackupReaderRow, boolean, string][] = [
  ["rolcanlogin", true, "LOGIN"],
  ["rolsuper", false, "NOSUPERUSER"],
  ["rolcreatedb", false, "NOCREATEDB"],
  ["rolcreaterole", false, "NOCREATEROLE"],
  ["rolreplication", false, "NOREPLICATION"],
  ["rolbypassrls", true, "BYPASSRLS"],
  ["rolinherit", false, "NOINHERIT"],
];

function membershipFindings(row: BackupReaderRow): string[] {
  const read = row.memberships.find(
    (membership) => membership.role === READ_ALL_DATA
  );
  const findings = row.memberships
    .filter((membership) => membership.role !== READ_ALL_DATA)
    .map(
      (membership) => `member of ${membership.role}, besides ${READ_ALL_DATA}`
    );
  if (!read) {
    findings.unshift(`not a member of ${READ_ALL_DATA}`);
  } else if (!read.inherit || read.set || read.admin) {
    findings.unshift(
      `${READ_ALL_DATA} must be granted WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`
    );
  }
  return findings;
}

export function backupReaderFindings(row: BackupReaderRow): string[] {
  const findings = ATTRIBUTES.filter(
    ([column, expected]) => row[column] !== expected
  ).map(([, , attribute]) => `not ${attribute}`);
  if (row.rolconnlimit !== BACKUP_READER_CONNECTION_LIMIT) {
    findings.push(`CONNECTION LIMIT is not ${BACKUP_READER_CONNECTION_LIMIT}`);
  }
  if (!(row.rolconfig ?? []).includes(READ_ONLY_SETTING)) {
    findings.push("default_transaction_read_only is not on for the login");
  }
  findings.push(...membershipFindings(row));
  findings.push(
    ...row.members.map((member) => `${member} can become the backup login`)
  );
  if (row.references > 0) {
    findings.push(
      "owns objects or is named by a grant, policy or default privilege"
    );
  }
  return findings;
}

/** The findings of the backup login, or null when it does not exist (the backup is not set up). */
export async function readBackupReader(
  client: Client
): Promise<string[] | null> {
  const { rows } = await client.query<BackupReaderRow>(BACKUP_READER_SQL, [
    BACKUP_READER,
  ]);
  const [row] = rows;
  return row ? backupReaderFindings(row) : null;
}
