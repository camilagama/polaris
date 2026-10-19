import assert from "node:assert/strict";
import type { Client } from "pg";

/**
 * The read-only part of the definer-hardening gate (ADR 0093): the queries that list what is wrong in
 * the whole database, with no probe and no change. The gate (`verify-definer-hardening-gate.ts`) runs
 * them before and after each of its throwaway probes; the staging check (`verify-staging-database.ts`)
 * runs them after every migration of the staging database, where nothing may be written.
 */
// a runtime role is a `polaris_*_runtime` group, a temporary gate login, or any role that is a member of such a group
// (production logins have free names); PUBLIC is checked on its own, because every role inherits from it. Membership is explicit (pg_auth_members, followed through groups): pg_has_role says a superuser is a member of everything. A runtime role that is a superuser or the database owner is reported as such and left out of the membership checks
export const RUNTIME_GROUP_PATTERN = "^polaris_.+_runtime$";
const RUNTIME_ROLE_PATTERN = "^polaris_gate_runner_[0-9a-f]+$";
const SEARCH_PATH_PREFIX = "search_path=";
const SEARCH_PATH_SPLIT = /\s*,\s*/;

interface DefinerRow {
  config: string[] | null;
  publicExecute: boolean;
  signature: string;
}

export interface Findings {
  createInPublic: string[];
  ownerMembership: string[];
  privilegedRuntime: string[];
  publicExecute: string[];
  temporary: string[];
  unpinned: string[];
}

function endsInPgTemp(config: string[] | null): boolean {
  const entry = (config ?? []).find((item) =>
    item.startsWith(SEARCH_PATH_PREFIX)
  );
  if (!entry) {
    return false;
  }
  const path = entry
    .slice(SEARCH_PATH_PREFIX.length)
    .split(SEARCH_PATH_SPLIT)
    .map((item) => item.replaceAll('"', ""));
  return path.at(-1) === "pg_temp";
}

export async function findViolations(client: Client): Promise<Findings> {
  // functions that belong to an extension are not ours to change (today the only extension is plpgsql, with none)
  const definers = await client.query<DefinerRow>(
    `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            p.proconfig AS config,
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute"
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY 1`
  );
  const unpinned = definers.rows
    .filter((row) => !endsInPgTemp(row.config))
    .map((row) => row.signature);
  const publicExecute = definers.rows
    .filter((row) => row.publicExecute)
    .map((row) => row.signature);
  // runtime roles (see RUNTIME_*_PATTERN); the checks below also follow SET ROLE chains through pg_has_role
  const runtime = `
    WITH RECURSIVE closure(member, roleid) AS (
      SELECT member, roleid FROM pg_auth_members
      UNION
      SELECT c.member, m.roleid FROM closure c JOIN pg_auth_members m ON m.member = c.roleid
    ),
    runtime AS (
      SELECT r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.oid = d.datdba AS is_owner
        FROM pg_roles r, pg_database d
       WHERE d.datname = current_database()
         AND (r.rolname ~ $2
          OR r.rolname ~ $1
          OR EXISTS (
            SELECT 1 FROM closure c JOIN pg_roles g ON g.oid = c.roleid
             WHERE c.member = r.oid AND g.rolname ~ $1
          ))
    )`;
  const privileged = await client.query<{ reason: string; rolname: string }>(
    `${runtime}
     SELECT rolname,
            CASE WHEN is_owner THEN 'database owner'
                 WHEN rolsuper THEN 'superuser'
                 ELSE 'CREATEROLE, REPLICATION or BYPASSRLS' END AS reason
       FROM runtime
      WHERE is_owner OR rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  // owner roles: the database owner, neon_superuser (when it exists), every *_owner role (pg_database_owner is the database owner
  // by another name), any superuser and the predefined roles that read or write files, run programs or bypass table privileges;
  // the login reaches one when a role it can become with SET ROLE (itself included) inherits it, can SET to it or has ADMIN OPTION on it
  // (whoever has ADMIN OPTION can grant itself SET and INHERIT)
  const membership = await client.query<{ login: string; target: string }>(
    `${runtime}
     SELECT DISTINCT runtime.rolname AS login, t.rolname AS target
       FROM runtime
       JOIN pg_roles via ON pg_has_role(runtime.oid, via.oid, 'SET')
       JOIN pg_roles t ON t.oid <> via.oid
        AND (t.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
          OR t.rolname = 'neon_superuser'
          OR t.rolname LIKE '%\\_owner'
          OR t.rolsuper
          OR t.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_read_all_data', 'pg_write_all_data'))
      WHERE NOT runtime.rolsuper AND NOT runtime.is_owner
        AND t.rolname <> 'pg_database_owner'
        AND (pg_has_role(via.oid, t.oid, 'SET')
          OR pg_has_role(via.oid, t.oid, 'USAGE')
          OR EXISTS (
            SELECT 1 FROM pg_auth_members a
             WHERE a.roleid = t.oid AND a.admin_option
               AND (pg_has_role(via.oid, a.member, 'SET') OR pg_has_role(via.oid, a.member, 'USAGE'))
          ))
      ORDER BY 1, 2`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  const roles = await client.query<{
    can_create: boolean;
    can_temp: boolean;
    rolname: string;
  }>(
    `${runtime}
     SELECT DISTINCT t.rolname,
            has_database_privilege(t.oid, current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege(t.oid, 'public', 'CREATE') AS can_create
       FROM runtime
       JOIN pg_roles t ON pg_has_role(runtime.oid, t.oid, 'SET')
      WHERE NOT runtime.rolsuper AND NOT runtime.is_owner
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  const publicRights = await client.query<{
    can_create: boolean;
    can_temp: boolean;
  }>(
    `SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege('public', 'public', 'CREATE') AS can_create`
  );
  const [pub] = publicRights.rows;
  assert.ok(pub);
  return {
    createInPublic: [
      ...(pub.can_create ? ["PUBLIC"] : []),
      ...roles.rows.filter((row) => row.can_create).map((row) => row.rolname),
    ],
    ownerMembership: membership.rows.map(
      (row) => `${row.login}->${row.target}`
    ),
    privilegedRuntime: privileged.rows.map(
      (row) => `${row.rolname} (${row.reason})`
    ),
    publicExecute,
    temporary: [
      ...(pub.can_temp ? ["PUBLIC"] : []),
      ...roles.rows.filter((row) => row.can_temp).map((row) => row.rolname),
    ],
    unpinned,
  };
}

export function assertClean(findings: Findings) {
  assert.deepEqual(
    findings.unpinned,
    [],
    "SECURITY DEFINER functions whose search_path does not end in pg_temp"
  );
  assert.deepEqual(
    findings.temporary,
    [],
    "runtime roles with TEMPORARY on the database"
  );
  assert.deepEqual(
    findings.createInPublic,
    [],
    "runtime roles with CREATE on schema public"
  );
  assert.deepEqual(
    findings.privilegedRuntime,
    [],
    "runtime roles that are the database owner or a superuser"
  );
  assert.deepEqual(
    findings.ownerMembership,
    [],
    "runtime roles that are members (SET or INHERIT) of the database owner, neon_superuser or a *_owner role"
  );
  assert.deepEqual(
    findings.publicExecute,
    [],
    "SECURITY DEFINER functions executable by PUBLIC"
  );
}
