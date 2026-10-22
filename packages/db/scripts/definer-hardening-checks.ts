import assert from "node:assert/strict";
import type { Client } from "pg";

/**
 * The read-only part of the definer-hardening gate (ADR 0093): the queries that list what is wrong in
 * the whole database, with no probe and no change. The gate (`verify-definer-hardening-gate.ts`) runs
 * them before and after each of its throwaway probes; the staging check (`verify-staging-database.ts`)
 * runs them after every migration of the staging database, where nothing may be written.
 */
// a runtime role is a `polaris_*_runtime` group, a temporary gate login, or any role that is a member of such a group
// (production logins have free names); PUBLIC is checked on its own, because every role inherits from it. Membership is explicit (pg_auth_members, followed through groups): pg_has_role says a superuser is a member of everything. A runtime role that is a superuser or the database owner is reported as such and left out of the membership checks.
// ADMIN OPTION counts as reach everywhere below: whoever has it on a role can grant itself SET and INHERIT on it, so a runtime role that has it (or inherits it, or can SET to a role that has it) reaches that role, and what that role reaches in turn. The one edge that does not count is the database owner's own ADMIN-only edge, below.
// An edge of the database owner with ADMIN OPTION alone (inherit and set false) does not count toward membership: it lets the owner administer the group, not use its privileges. PostgreSQL 16+ creates exactly that edge when a role with CREATEROLE but no SUPERUSER creates a role: the creator is made a member WITH ADMIN OPTION, INHERIT FALSE, SET FALSE (on Neon the grantor is cloud_admin), so `neondb_owner` is an ADMIN-only member of every polaris_* role, and that does not make it a runtime login. The edge would let the owner put itself in the group (GRANT … TO self), but the owner and migrator already can: it owns the database and the objects and creates and drops these roles, so there is nothing to find. The exemption is only the owner's: any other role with an ADMIN-only edge on a runtime group is still a runtime role, because nothing explains that edge and the role could grant itself the group.

export const RUNTIME_GROUP_PATTERN = "^polaris_.+_runtime$";
/** The roles that own SECURITY DEFINER functions (a LIKE pattern): `polaris_<name>_owner`. */
export const OWNER_ROLE_LIKE = "polaris\\_%\\_owner";
/**
 * The settings that scope an owner role to the user or organization of a call (`app.owner_scope.<name>`), written by the
 * function itself (migration 0095). No runtime policy reads them, and a policy that reads them reads no runtime setting.
 */
export const OWNER_SCOPE_PREFIX = "app.owner_scope.";
/**
 * Roles Neon creates and manages itself (the same names `verify-staging-database.ts` treats as the platform's): never a
 * role of the app, and not checked by `rowSecurityWithoutPolicy` (a superuser or a role with BYPASSRLS is left out anyway).
 */
const NEON_PLATFORM_ROLES = ["cloud_admin", "neon_superuser", "neon_service"];
// fewer definer functions than the migrations create means the database is not the migrated one
export const MIN_DEFINER_FUNCTIONS = 88;
const RUNTIME_ROLE_PATTERN = "^polaris_gate_runner_[0-9a-f]+$";
const SEARCH_PATH_PREFIX = "search_path=";
const SEARCH_PATH_SPLIT = /\s*,\s*/;

interface DefinerRow {
  config: string[] | null;
  owner: string;
  ownerIsOwnerRole: boolean;
  publicExecute: boolean;
  signature: string;
}

export interface Findings {
  createInPublic: string[];
  /** `schema.table (owner)`: a table with forced row security whose owner is neither a superuser nor BYPASSRLS */
  forcedTableOwnerWithoutBypass: string[];
  /** SECURITY DEFINER functions (`signature (owner)`) whose owner is not a `polaris_*_owner` role */
  foreignOwner: string[];
  ownerMembership: string[];
  /** `schema.table.policy ({roles}): reason` for a policy that breaks the scope of the owners (`app.owner_scope.*`) */
  ownerScope: string[];
  privilegedRuntime: string[];
  publicExecute: string[];
  /** `schema.table role COMMAND`: a role with a privilege on a table with forced row security and no policy for it */
  rowSecurityWithoutPolicy: string[];
  /** `schema.table.policy (owner): setting` for a policy on `app.owner_scope.*` that no function of its owner writes */
  scopeWithoutWriter: string[];
  /** `public.table` a `polaris_*` role holds a privilege on, without row security enabled and forced (no exception) */
  tableWithoutRowSecurity: string[];
  temporary: string[];
  unpinned: string[];
}

// runtime roles (see RUNTIME_*_PATTERN); $1 is RUNTIME_GROUP_PATTERN and $2 is RUNTIME_ROLE_PATTERN
export const RUNTIME_ROLES_CTE = `
    WITH RECURSIVE closure(member, roleid) AS (
      SELECT member, roleid FROM pg_auth_members
       WHERE inherit_option OR set_option OR member <> (SELECT datdba FROM pg_database WHERE datname = current_database())
      UNION
      SELECT c.member, m.roleid FROM closure c JOIN pg_auth_members m ON m.member = c.roleid
       WHERE m.inherit_option OR m.set_option OR m.member <> (SELECT datdba FROM pg_database WHERE datname = current_database())
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

// `t` is reached from `via` (a role the runtime role can SET to, itself included) by ADMIN OPTION when `via` has it on `t`, directly or through a
// role it can become or inherits; the database owner's ADMIN-only edge does not count (see above)
const ADMIN_OPTION_REACHES = `EXISTS (
            SELECT 1 FROM pg_auth_members a
             WHERE a.roleid = t.oid AND a.admin_option
               AND NOT (a.member = (SELECT datdba FROM pg_database WHERE datname = current_database())
                    AND NOT a.inherit_option AND NOT a.set_option)
               AND (pg_has_role(via.oid, a.member, 'SET') OR pg_has_role(via.oid, a.member, 'USAGE'))
          )`;

// the roles a runtime role can SET to, itself included, followed through ADMIN OPTION: a role it has ADMIN OPTION on is one it can grant itself
// SET and INHERIT on, so it is one it can SET to, and what that role has (SET, INHERIT or ADMIN OPTION on others) is reached too, to any depth.
// A superuser is not followed (pg_has_role says it is a member of everything); it is reached, and reported, with its attributes.
// `$1` and `$2` as in RUNTIME_ROLES_CTE; the columns are the runtime role and a role it can SET to.
const BECOMES_CTE = `${RUNTIME_ROLES_CTE},
    becomes(runtime_oid, role_oid) AS (
      SELECT runtime.oid, via.oid
        FROM runtime
        JOIN pg_roles via ON pg_has_role(runtime.oid, via.oid, 'SET')
       WHERE NOT runtime.rolsuper AND NOT runtime.is_owner
      UNION
      SELECT becomes.runtime_oid, t.oid
        FROM becomes
        JOIN pg_roles via ON via.oid = becomes.role_oid AND NOT via.rolsuper
        JOIN pg_roles t ON ${ADMIN_OPTION_REACHES}
    )`;

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

/** The rows of `becomes` (a runtime role and a role it can become, itself included), for the fuzz of the definer-hardening gate. */
export async function findBecomes(
  client: Client
): Promise<{ role: string; runtime: string }[]> {
  const { rows } = await client.query<{ role: string; runtime: string }>(
    `${BECOMES_CTE}
     SELECT DISTINCT r.rolname AS runtime, t.rolname AS role
       FROM becomes
       JOIN pg_roles r ON r.oid = becomes.runtime_oid
       JOIN pg_roles t ON t.oid = becomes.role_oid
      ORDER BY 1, 2`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  return rows;
}

export interface ReachableRole {
  can_create: boolean;
  can_temp: boolean;
  /** a runtime role that is not a `*_runtime` group: a login of the app, which must be able to log in */
  is_login: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolname: string;
  rolreplication: boolean;
  rolsuper: boolean;
}

/**
 * Every role a runtime role is, or can become with SET ROLE, or inherits (itself included), or has ADMIN OPTION on
 * (directly, through a group it inherits or through a role it can become: ADMIN OPTION grants SET and INHERIT to
 * itself, so what that role reaches is reached too), with its attributes and its TEMPORARY and CREATE rights. The
 * chain is followed the way the membership check follows it (`BECOMES_CTE`): SET to a role, then SET, INHERIT or ADMIN
 * OPTION from there. A superuser or database owner among the runtime roles is left out: it is reported as such by
 * `privilegedRuntime`, and for a superuser pg_has_role says it is a member of everything (so nothing is followed from
 * a superuser that is only reached: the superuser itself is reported, with its attributes).
 */
export async function findReachableRoles(
  client: Client
): Promise<ReachableRole[]> {
  const { rows } = await client.query<ReachableRole>(
    `${BECOMES_CTE}
     SELECT DISTINCT t.rolname,
            has_database_privilege(t.oid, current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege(t.oid, 'public', 'CREATE') AS can_create,
            t.oid IN (SELECT oid FROM runtime WHERE rolname !~ $1) AS is_login,
            t.rolcanlogin, t.rolsuper, t.rolcreaterole, t.rolcreatedb, t.rolreplication, t.rolbypassrls
       FROM runtime
       JOIN becomes ON becomes.runtime_oid = runtime.oid
       JOIN pg_roles via ON via.oid = becomes.role_oid
       JOIN pg_roles t ON t.oid = via.oid
         OR (NOT via.rolsuper AND (pg_has_role(via.oid, t.oid, 'SET') OR pg_has_role(via.oid, t.oid, 'USAGE')))
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  return rows;
}

export async function findViolations(client: Client): Promise<Findings> {
  // functions that belong to an extension are not ours to change (today the only extension is plpgsql, with none)
  const definers = await client.query<DefinerRow>(
    `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            p.proconfig AS config,
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute",
            pg_get_userbyid(p.proowner) AS owner,
            pg_get_userbyid(p.proowner) LIKE '${OWNER_ROLE_LIKE}' AS "ownerIsOwnerRole"
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
  // a definer function runs with its owner's rights: the database owner (BYPASSRLS on Neon), or any role that is not an
  // owner role of its own, would run over the row security of every tenant. The same scope as the DO at the end of 0095.
  const foreignOwner = definers.rows
    .filter((row) => !row.ownerIsOwnerRole)
    .map((row) => `${row.signature} (${row.owner})`);
  // the checks below follow SET ROLE chains through pg_has_role (and ADMIN OPTION, see BECOMES_CTE)
  const privileged = await client.query<{ reason: string; rolname: string }>(
    `${RUNTIME_ROLES_CTE}
     SELECT rolname,
            CASE WHEN is_owner THEN 'database owner'
                 WHEN rolsuper THEN 'superuser'
                 ELSE 'CREATEROLE, REPLICATION or BYPASSRLS' END AS reason
       FROM runtime
      WHERE is_owner OR rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  // privileged roles: the database owner, neon_superuser (when it exists), every *_owner role (pg_database_owner is the database owner
  // by another name), any role with SUPERUSER, BYPASSRLS or CREATEROLE and every predefined pg_* role (pg_database_owner aside);
  // the login reaches one when a role it can become with SET ROLE (itself included) inherits it or can SET to it, or when it has ADMIN OPTION on
  // it, or on a role that has (whoever has ADMIN OPTION can grant itself SET and INHERIT, and so reaches what the role reaches)
  const membership = await client.query<{ login: string; target: string }>(
    `${BECOMES_CTE}
     SELECT DISTINCT runtime.rolname AS login, t.rolname AS target
       FROM runtime
       JOIN becomes ON becomes.runtime_oid = runtime.oid
       JOIN pg_roles via ON via.oid = becomes.role_oid
       JOIN pg_roles t ON t.oid <> runtime.oid
        AND (t.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
          OR t.rolname = 'neon_superuser'
          OR t.rolname LIKE '%\\_owner'
          OR t.rolsuper OR t.rolbypassrls OR t.rolcreaterole
          OR t.rolname LIKE 'pg\\_%')
      WHERE t.rolname <> 'pg_database_owner'
        AND (t.oid = via.oid
          OR (NOT via.rolsuper AND (pg_has_role(via.oid, t.oid, 'SET') OR pg_has_role(via.oid, t.oid, 'USAGE'))))
      ORDER BY 1, 2`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  const roles = await findReachableRoles(client);
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
      ...roles.filter((row) => row.can_create).map((row) => row.rolname),
    ],
    forcedTableOwnerWithoutBypass:
      await findForcedTableOwnerWithoutBypass(client),
    foreignOwner,
    ownerMembership: membership.rows.map(
      (row) => `${row.login}->${row.target}`
    ),
    ownerScope: await findOwnerScopeViolations(client),
    privilegedRuntime: privileged.rows.map(
      (row) => `${row.rolname} (${row.reason})`
    ),
    publicExecute,
    rowSecurityWithoutPolicy: await findRowSecurityWithoutPolicy(client),
    scopeWithoutWriter: await findScopeWithoutWriter(client),
    tableWithoutRowSecurity: await findTablesWithoutRowSecurity(client),
    temporary: [
      ...(pub.can_temp ? ["PUBLIC"] : []),
      ...roles.filter((row) => row.can_temp).map((row) => row.rolname),
    ],
    unpinned,
  };
}

interface PolicySettingsRow {
  /** every role of the policy is a `polaris_*_owner` role */
  allOwnerRoles: boolean;
  /** some role of the policy is a `polaris_*_owner` role (the others may be runtimes: the policy holds for the owner too) */
  anyOwnerRole: boolean;
  /** some `polaris_*_owner` role holds a privilege on the table of the policy */
  ownerOnTable: boolean;
  policy: string;
  roles: string[];
  settings: string[];
}

/**
 * Every GUC of the runtime lives under `app.` (ADR 0093): the policies read `app.user_id`, `app.organization_id` and the like,
 * and none reads a custom setting under another prefix. A name with a dot that is not `app.` is a custom setting
 * (`foo.bar`), not a PostgreSQL one (those have no dot), and `findOwnerScopeViolations` reports a policy that reads it.
 */
const RUNTIME_SETTING_PREFIX = "app.";
const isRuntimeSetting = (name: string) =>
  name.startsWith(RUNTIME_SETTING_PREFIX) &&
  !name.startsWith(OWNER_SCOPE_PREFIX);
const isCustomSettingOutsideApp = (name: string) =>
  name.includes(".") && !name.startsWith(RUNTIME_SETTING_PREFIX);

/** what a policy that names an owner role, or one TO PUBLIC on a table an owner uses, reads of the runtime */
function runtimeSettingFinding(row: PolicySettingsRow): string | undefined {
  const runtime = row.settings.filter(isRuntimeSetting);
  if (runtime.length === 0) {
    return;
  }
  if (row.roles.includes("public") && row.ownerOnTable) {
    return `a policy TO PUBLIC, on a table an owner role uses, reads the runtime setting ${runtime.join(", ")}`;
  }
  return row.anyOwnerRole
    ? `a policy of an owner role reads the runtime setting ${runtime.join(", ")}`
    : undefined;
}

/** a policy of any role that reads a custom setting under a prefix other than `app.` */
function customSettingFindings(label: string, settings: string[]): string[] {
  const outside = settings.filter(isCustomSettingOutsideApp);
  return outside.length > 0
    ? [`${label}: reads the custom setting ${outside.join(", ")}, outside app.`]
    : [];
}

/**
 * The scope of the owners, in both directions (migration 0095):
 * - a policy that reads an `app.owner_scope.*` setting is `TO` exactly one `polaris_*_owner` role (a policy without `TO`,
 *   or `TO` a runtime, would let the runtime set the scope itself), every policy that reads the same setting is `TO` that
 *   same role (a scope belongs to one owner: another owner's function would find it left in the transaction), and it reads
 *   no setting of the runtime (any other `app.*`);
 * - a policy that names an owner role (alone, or with a runtime) reads no setting of the runtime (`app.user_id`,
 *   `app.organization_id` or any other `app.*` outside `app.owner_scope.*`), with no exception since 0097, and neither does a
 *   policy TO PUBLIC on a table some owner role holds a privilege on (PUBLIC includes the owners).
 * - no policy, of any role, reads a custom setting outside `app.` (a name with a dot under another prefix): the runtime
 *   settings all live under `app.`, and a policy that read `foo.bar` would be a runtime setting these rules do not see.
 * The settings come from the text of the expressions (`current_setting('…')`), in lower case (a custom setting is not case
 * sensitive: `APP.user_id` is `app.user_id`); one read inside a function the policy calls is not seen.
 */
export async function findOwnerScopeViolations(
  client: Client
): Promise<string[]> {
  const { rows } = await client.query<PolicySettingsRow>(
    `SELECT pol.schemaname || '.' || pol.tablename || '.' || pol.policyname AS policy,
            pol.roles::text[] AS roles,
            coalesce((SELECT array_agg(DISTINCT lower(m[1]) ORDER BY lower(m[1]))
                        FROM regexp_matches(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
                                            'current_setting\\(''([^'']+)''', 'g') AS m), '{}'::text[]) AS settings,
            NOT EXISTS (SELECT 1 FROM unnest(pol.roles) AS r(name) WHERE r.name NOT LIKE '${OWNER_ROLE_LIKE}') AS "allOwnerRoles",
            EXISTS (SELECT 1 FROM unnest(pol.roles) AS r(name) WHERE r.name LIKE '${OWNER_ROLE_LIKE}') AS "anyOwnerRole",
            EXISTS (SELECT 1 FROM pg_roles o
                     WHERE o.rolname LIKE '${OWNER_ROLE_LIKE}'
                       AND (has_table_privilege(o.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE')
                         OR has_any_column_privilege(o.oid, c.oid, 'SELECT,INSERT,UPDATE'))) AS "ownerOnTable"
       FROM pg_policies pol
       JOIN pg_namespace n ON n.nspname = pol.schemaname
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pol.tablename
      ORDER BY 1`
  );
  // the roles of the policies that read each owner_scope setting: more than one means two owners share a scope
  const scopeRoles = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const name of row.settings) {
      if (name.startsWith(OWNER_SCOPE_PREFIX)) {
        scopeRoles.set(
          name,
          new Set([...(scopeRoles.get(name) ?? []), ...row.roles])
        );
      }
    }
  }
  const findings: string[] = [];
  for (const row of rows) {
    const scoped = row.settings.filter((name) =>
      name.startsWith(OWNER_SCOPE_PREFIX)
    );
    const runtime = row.settings.filter(isRuntimeSetting);
    const label = `${row.policy} ({${row.roles.join(",")}})`;
    if (scoped.length > 0 && !(row.roles.length === 1 && row.allOwnerRoles)) {
      findings.push(
        `${label}: reads ${scoped.join(", ")} and is not TO one polaris_*_owner role`
      );
    }
    const shared = scoped.filter(
      (name) => (scopeRoles.get(name)?.size ?? 0) > 1
    );
    if (shared.length > 0) {
      findings.push(
        `${label}: reads ${shared.join(", ")}, which a policy of another role reads too`
      );
    }
    findings.push(...customSettingFindings(label, row.settings));
    const runtimeFinding =
      scoped.length > 0 && runtime.length > 0
        ? `reads ${scoped.join(", ")} and the runtime setting ${runtime.join(", ")}`
        : runtimeSettingFinding(row);
    if (runtimeFinding) {
      findings.push(`${label}: ${runtimeFinding}`);
    }
  }
  return findings;
}

/**
 * Every table of `public` that a `polaris_*` role (a runtime group, an owner, a login of the app; through PUBLIC or a group
 * too) holds any privilege on, of the table or of a column, has row security enabled and forced: a table without it gives
 * the role every row, whatever the policies say. There is no exception since 0098 (the last ones were Better Auth's tables
 * and the auth audit), and on purpose no list or parameter to make one: an exception would be a change of this code, seen
 * in review, not one more line in a list. `public.table`.
 */
export async function findTablesWithoutRowSecurity(
  client: Client
): Promise<string[]> {
  const { rows } = await client.query<{ finding: string }>(
    `SELECT 'public.' || c.relname AS finding
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        AND EXISTS (
          SELECT 1 FROM pg_roles r
           WHERE r.rolname LIKE 'polaris\\_%' AND NOT r.rolsuper
             AND (has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
        )
      ORDER BY 1`
  );
  return rows.map((row) => row.finding);
}

/**
 * With FORCE, the owner of a table is bound by its policies too, unless it is a superuser or has BYPASSRLS. The owner of
 * the tables is the migrator: without the bypass, a data migration (a backfill, an UPDATE of every row) would see zero rows
 * and change nothing, with no error. So every table with row security enabled and forced (any schema but the system ones)
 * belongs to a superuser or to a role with BYPASSRLS (the attribute of the role itself: attributes are not inherited).
 * A migration that does DML after SET ROLE to an owner is bound by that owner's policies, as wanted; a backfill is the
 * migrator's. `schema.table (owner)`.
 */
export async function findForcedTableOwnerWithoutBypass(
  client: Client
): Promise<string[]> {
  const { rows } = await client.query<{ finding: string }>(
    `SELECT n.nspname || '.' || c.relname || ' (' || o.rolname || ')' AS finding
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles o ON o.oid = c.relowner
      WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
        AND NOT o.rolsuper AND NOT o.rolbypassrls
      ORDER BY 1`
  );
  return rows.map((row) => row.finding);
}

/**
 * Under forced row security a role with no policy for a command sees no row (or writes none): a grant without a policy is
 * a defect waiting to happen (a purge that reads nothing and deletes everyone, a revocation that ends nothing). So, for
 * every table with row security enabled and forced (any schema but the system ones), every privilege of the ACL (of the
 * table or of a column) that row security governs (SELECT, INSERT, UPDATE, DELETE) and every role that has it (the grantee
 * and every role that inherits it, the way PostgreSQL applies a policy `TO` a group), there is a permissive policy of that
 * command or `ALL` that is `TO` a role it inherits (itself included) or `TO PUBLIC`. A privilege of PUBLIC needs a policy TO
 * PUBLIC. Left out: the owner of the table and whoever inherits it, a superuser and a role with BYPASSRLS (row security does
 * not apply to them), the predefined `pg_*` roles, whose rights are not in the ACL (a member of `pg_read_all_data` without
 * bypass sees no row: it fails closed), and the roles of the Neon platform (NEON_PLATFORM_ROLES). `schema.table role COMMAND`.
 */
export async function findRowSecurityWithoutPolicy(
  client: Client
): Promise<string[]> {
  const { rows } = await client.query<{ finding: string }>(
    `WITH forced AS (
       SELECT c.oid, c.relowner, c.relacl, n.nspname || '.' || c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
     ),
     granted AS (
       SELECT f.oid, f.relowner, f.name, a.grantee, a.privilege_type
         FROM forced f, aclexplode(f.relacl) a
       UNION
       SELECT f.oid, f.relowner, f.name, a.grantee, a.privilege_type
         FROM forced f
         JOIN pg_attribute att ON att.attrelid = f.oid AND att.attnum > 0 AND NOT att.attisdropped,
              aclexplode(att.attacl) a
     ),
     affected AS (
       SELECT DISTINCT g.oid, g.name, g.privilege_type, r.oid AS role_oid, r.rolname::text AS role_name
         FROM granted g
         JOIN pg_roles r ON g.grantee <> 0 AND pg_has_role(r.oid, g.grantee, 'USAGE')
        WHERE g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.rolname <> ALL ($1::text[])
          AND NOT pg_has_role(r.oid, g.relowner, 'USAGE')
       UNION
       SELECT DISTINCT g.oid, g.name, g.privilege_type, 0::oid, 'PUBLIC'
         FROM granted g
        WHERE g.grantee = 0 AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
     )
     SELECT a.name || ' ' || a.role_name || ' ' || a.privilege_type AS finding
       FROM affected a
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policy p
         WHERE p.polrelid = a.oid AND p.polpermissive
           AND p.polcmd IN ('*', CASE a.privilege_type WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)
           AND (0::oid = ANY (p.polroles)
             OR (a.role_oid <> 0 AND EXISTS (
               SELECT 1 FROM unnest(p.polroles) AS pr(oid) WHERE pg_has_role(a.role_oid, pr.oid, 'USAGE'))))
      )
      ORDER BY 1`,
    [NEON_PLATFORM_ROLES]
  );
  return rows.map((row) => row.finding);
}

/**
 * A scope nobody writes is a policy that is always false: the function of the owner reads nothing and fails silently (a
 * revocation that ends no session). So every policy that reads an `app.owner_scope.<name>` setting needs, for each role it
 * is `TO`, some function owned by that role whose body calls `set_config('app.owner_scope.<name>', …, true)`, local to
 * the transaction (with `false` the scope would stay on the pooled connection), in the text of the body without `--`
 * comments and blanks, in lower case; a call through another function or with a computed name is not seen, and is reported.
 * `schema.table.policy (role): setting`.
 */
export async function findScopeWithoutWriter(
  client: Client
): Promise<string[]> {
  const { rows } = await client.query<{ finding: string }>(
    `WITH scoped AS (
       SELECT DISTINCT pol.schemaname || '.' || pol.tablename || '.' || pol.policyname AS policy,
              role.name::text AS role_name, lower(m[1]) AS setting
         FROM pg_policies pol,
              unnest(pol.roles) AS role(name),
              regexp_matches(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
                             'current_setting\\(''([^'']+)''', 'g') AS m
        WHERE starts_with(lower(m[1]), $1)
     ),
     -- the bodies that mention a scope at all, once each, without comments and blanks
     writers AS (
       SELECT p.proowner, lower(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS body
         FROM pg_proc p
        WHERE p.prosrc ILIKE '%owner\\_scope%'
     )
     SELECT scoped.policy || ' (' || scoped.role_name || '): ' || scoped.setting AS finding
       FROM scoped
      WHERE NOT EXISTS (
        SELECT 1 FROM writers w JOIN pg_roles o ON o.oid = w.proowner
         WHERE o.rolname = scoped.role_name
           AND w.body ~ ('set_config\\(''' || regexp_replace(scoped.setting, '([.^$*+?()\\[\\]{}|\\\\])', '\\\\\\1', 'g')
                         || ''',[^;]*,true\\)')
      )
      ORDER BY 1`,
    [OWNER_SCOPE_PREFIX]
  );
  return rows.map((row) => row.finding);
}

export function assertClean(findings: Findings) {
  assert.deepEqual(
    findings.foreignOwner,
    [],
    "SECURITY DEFINER functions that do not belong to a polaris_*_owner role (signature (owner))"
  );
  assert.deepEqual(
    findings.ownerScope,
    [],
    "policies that read app.owner_scope.* without being TO one polaris_*_owner role or together with a runtime setting, or policies of owner roles that read a runtime setting (no exception)"
  );
  assert.deepEqual(
    findings.tableWithoutRowSecurity,
    [],
    "tables of public a polaris_* role holds a privilege on, without row security enabled and forced (no exception)"
  );
  assert.deepEqual(
    findings.forcedTableOwnerWithoutBypass,
    [],
    "tables with forced row security whose owner is neither a superuser nor BYPASSRLS: a data migration would see zero rows (schema.table (owner))"
  );
  assert.deepEqual(
    findings.rowSecurityWithoutPolicy,
    [],
    "roles with a privilege on a table with forced row security and no permissive policy for that command (schema.table role COMMAND)"
  );
  assert.deepEqual(
    findings.scopeWithoutWriter,
    [],
    "policies on app.owner_scope.* that no function of their role writes with set_config (schema.table.policy (role): setting)"
  );
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
    "runtime roles that reach (SET, INHERIT or ADMIN OPTION) the database owner, neon_superuser, a *_owner role, a predefined pg_* role or a role with SUPERUSER, BYPASSRLS or CREATEROLE"
  );
  assert.deepEqual(
    findings.publicExecute,
    [],
    "SECURITY DEFINER functions executable by PUBLIC"
  );
}
