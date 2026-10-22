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
 * The policies of owner roles that read a setting of the runtime, by `schema.table.policy`, with the one setting each may
 * read; any other policy of an owner is a finding, and so is a third policy of the same owner. `polaris_device_session_owner`
 * (0078) ends the sessions of the device the current user revoked: its two SELECT policies read `app.user_id`, the user the
 * runtime proved from the verified session (the trust of the runtime's own policies), and its function checks that the acting
 * session is a live one of that user. It acts for the caller by design; moving it to `app.owner_scope.*` is a decision of
 * its own. The exception is the fixed set of these two policies, not the pair role + setting: a new policy of that owner that
 * reads `app.user_id` is reported.
 */
const OWNER_POLICIES_READING_RUNTIME_SETTINGS: ReadonlyMap<
  string,
  { owner: string; setting: string }
> = new Map([
  [
    "public.devices.devices_session_owner_select",
    { owner: "polaris_device_session_owner", setting: "app.user_id" },
  ],
  [
    "public.device_sessions.device_sessions_session_owner_select",
    { owner: "polaris_device_session_owner", setting: "app.user_id" },
  ],
]);
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
  /** SECURITY DEFINER functions (`signature (owner)`) whose owner is not a `polaris_*_owner` role */
  foreignOwner: string[];
  ownerMembership: string[];
  /** `schema.table.policy ({roles}): reason` for a policy that breaks the scope of the owners (`app.owner_scope.*`) */
  ownerScope: string[];
  privilegedRuntime: string[];
  publicExecute: string[];
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
    foreignOwner,
    ownerMembership: membership.rows.map(
      (row) => `${row.login}->${row.target}`
    ),
    ownerScope: await findOwnerScopeViolations(client),
    privilegedRuntime: privileged.rows.map(
      (row) => `${row.rolname} (${row.reason})`
    ),
    publicExecute,
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

/** what a policy that names an owner role, or one TO PUBLIC on a table an owner uses, reads of the runtime beyond what its owner may */
function runtimeSettingFinding(row: PolicySettingsRow): string | undefined {
  const runtime = row.settings.filter(isRuntimeSetting);
  if (runtime.length === 0) {
    return;
  }
  if (row.roles.includes("public") && row.ownerOnTable) {
    return `a policy TO PUBLIC, on a table an owner role uses, reads the runtime setting ${runtime.join(", ")}`;
  }
  if (!row.anyOwnerRole) {
    return;
  }
  const allowed = OWNER_POLICIES_READING_RUNTIME_SETTINGS.get(row.policy);
  const extra = runtime.filter(
    (name) =>
      !(
        allowed?.setting === name &&
        row.roles.length === 1 &&
        row.roles[0] === allowed.owner
      )
  );
  return extra.length > 0
    ? `a policy of an owner role reads the runtime setting ${extra.join(", ")}`
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
 * - a policy that names an owner role (alone, or with a runtime) reads no setting of the runtime, but for the one setting of each owner named in
 *   OWNER_POLICIES_READING_RUNTIME_SETTINGS, and neither does a policy TO PUBLIC on a table some owner role holds a privilege on
 *   (PUBLIC includes the owners).
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

export function assertClean(findings: Findings) {
  assert.deepEqual(
    findings.foreignOwner,
    [],
    "SECURITY DEFINER functions that do not belong to a polaris_*_owner role (signature (owner))"
  );
  assert.deepEqual(
    findings.ownerScope,
    [],
    "policies that read app.owner_scope.* without being TO one polaris_*_owner role or together with a runtime setting, or policies of owner roles that read a runtime setting"
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
