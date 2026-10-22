// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
} from "./sales-gate-support";

/**
 * The owners of the last four SECURITY DEFINER functions (migration 0095, ADR 0093 amended) on a real PostgreSQL 18. The
 * functions no longer run as the database owner (BYPASSRLS on Neon) but as three roles without bypass, bound by policies to
 * the user or the organization the function writes in `app.owner_scope.*`:
 *   1. the six tables keep FORCE ROW LEVEL SECURITY; `"user"` has no trigger; `organizations.created_at` defaults to now();
 *   2. owner and EXECUTE of each function: the runtimes that called it still do, the migrator executes the two triggers;
 *   3. the exact matrix of each owner: the listed columns only, no table privilege, no DELETE, TRUNCATE, REFERENCES or
 *      TRIGGER anywhere, no CREATE on any schema, no object owned but its functions, no EXECUTE granted on another function;
 *   4. every policy that reads a setting of these owners (`app.owner_scope.*`) is TO its one owner and reads only that owner's settings, and the owners
 *      have no other policy; a runtime that sets those settings itself sees no row more and writes nothing;
 *   5. each owner without its setting sees nothing and writes nothing (fail-closed); with the setting of one user or
 *      organization it sees and writes only that one, whatever the statement asks;
 *   6. a defect planted in a copy of a body (a WHERE dropped, the membership of another organization, a counter of another
 *      organization) stays inside the scope or fails with 42501;
 *   7. the real calls: the bump of a user in two organizations and of a user with no membership, the onboarding run again
 *      and with the organization of another tenant, a sync transaction with two organizations and a SAVEPOINT rolled back.
 * Everything a probe writes is rolled back; the fixtures of step 7 stay, as in the other gates.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const SYNC_OWNER = "polaris_sync_owner";
const EPOCH_OWNER = "polaris_authorization_epoch_owner";
const ONBOARDING_OWNER = "polaris_onboarding_owner";
const OWNERS = [EPOCH_OWNER, ONBOARDING_OWNER, SYNC_OWNER] as const;
const SYNC_SCOPE = "app.owner_scope.sync_organization_id";
const EPOCH_SCOPE = "app.owner_scope.authorization_epoch_user_id";
const ONBOARDING_USER_SCOPE = "app.owner_scope.onboarding_user_id";
const ONBOARDING_ORGANIZATION_SCOPE =
  "app.owner_scope.onboarding_organization_id";
// the settings of the three owners of 0095 (another owner's scope, such as the one of 0097, has its own gate)
const SCOPES = [
  SYNC_SCOPE,
  EPOCH_SCOPE,
  ONBOARDING_USER_SCOPE,
  ONBOARDING_ORGANIZATION_SCOPE,
];
const TABLES = [
  "memberships",
  "offline_grants",
  "organizations",
  "sync_changes",
  "sync_cursors",
  "tenant_audit_event",
] as const;
const TIMEZONE = "America/Sao_Paulo";

/** what each owner may do, column by column (`table.column:PRIVILEGE`), and nothing else */
const MATRIX: Record<(typeof OWNERS)[number], string[]> = {
  [EPOCH_OWNER]: [
    "memberships.authorization_epoch:SELECT",
    "memberships.authorization_epoch:UPDATE",
    "memberships.updated_at:UPDATE",
    "memberships.user_id:SELECT",
    "offline_grants.id:SELECT",
    "offline_grants.organization_id:SELECT",
    "offline_grants.revoked_at:SELECT",
    "offline_grants.revoked_at:UPDATE",
    "offline_grants.revoked_reason:UPDATE",
    "offline_grants.user_id:SELECT",
    "tenant_audit_event.actor_user_id:INSERT",
    "tenant_audit_event.entity_id:INSERT",
    "tenant_audit_event.entity_type:INSERT",
    "tenant_audit_event.event_type:INSERT",
    "tenant_audit_event.organization_id:INSERT",
  ],
  [ONBOARDING_OWNER]: [
    "memberships.organization_id:INSERT",
    "memberships.organization_id:SELECT",
    "memberships.role:SELECT",
    "memberships.status:SELECT",
    "memberships.user_id:INSERT",
    "memberships.user_id:SELECT",
    "organizations.created_at:SELECT",
    "organizations.currency:SELECT",
    "organizations.id:INSERT",
    "organizations.id:SELECT",
    "organizations.name:INSERT",
    "organizations.name:SELECT",
    "organizations.status:SELECT",
    "organizations.timezone:INSERT",
    "organizations.timezone:SELECT",
    "organizations.updated_at:SELECT",
    "tenant_audit_event.actor_user_id:INSERT",
    "tenant_audit_event.entity_id:INSERT",
    "tenant_audit_event.entity_type:INSERT",
    "tenant_audit_event.event_type:INSERT",
    "tenant_audit_event.organization_id:INSERT",
    "tenant_audit_event.request_id:INSERT",
    "user.email_verified:SELECT",
    "user.id:SELECT",
    "user.updated_at:UPDATE",
  ],
  [SYNC_OWNER]: [
    "sync_changes.entity_id:INSERT",
    "sync_changes.entity_type:INSERT",
    "sync_changes.id:SELECT",
    "sync_changes.organization_id:INSERT",
    "sync_changes.organization_id:SELECT",
    "sync_changes.seq:SELECT",
    "sync_changes.seq:UPDATE",
    "sync_cursors.last_seq:INSERT",
    "sync_cursors.last_seq:SELECT",
    "sync_cursors.last_seq:UPDATE",
    "sync_cursors.organization_id:INSERT",
    "sync_cursors.organization_id:SELECT",
  ],
};

/** the policies of each owner, `table.policy:settings read` */
const POLICIES: Record<(typeof OWNERS)[number], string[]> = {
  [EPOCH_OWNER]: [
    `memberships.memberships_authorization_epoch_owner_select:${EPOCH_SCOPE}`,
    `memberships.memberships_authorization_epoch_owner_update:${EPOCH_SCOPE}`,
    `offline_grants.offline_grants_authorization_epoch_owner_select:${EPOCH_SCOPE}`,
    `offline_grants.offline_grants_authorization_epoch_owner_update:${EPOCH_SCOPE}`,
    `tenant_audit_event.tenant_audit_event_authorization_epoch_owner_insert:${EPOCH_SCOPE}`,
  ],
  [ONBOARDING_OWNER]: [
    `memberships.memberships_onboarding_owner_insert:${ONBOARDING_ORGANIZATION_SCOPE},${ONBOARDING_USER_SCOPE}`,
    `memberships.memberships_onboarding_owner_select:${ONBOARDING_USER_SCOPE}`,
    `organizations.organizations_onboarding_owner_insert:${ONBOARDING_ORGANIZATION_SCOPE}`,
    `organizations.organizations_onboarding_owner_select:${ONBOARDING_ORGANIZATION_SCOPE},${ONBOARDING_USER_SCOPE}`,
    `tenant_audit_event.tenant_audit_event_onboarding_owner_insert:${ONBOARDING_ORGANIZATION_SCOPE},${ONBOARDING_USER_SCOPE}`,
  ],
  [SYNC_OWNER]: [
    `sync_changes.sync_changes_sync_owner_insert:${SYNC_SCOPE}`,
    `sync_changes.sync_changes_sync_owner_select:${SYNC_SCOPE}`,
    `sync_changes.sync_changes_sync_owner_update:${SYNC_SCOPE}`,
    `sync_cursors.sync_cursors_sync_owner_insert:${SYNC_SCOPE}`,
    `sync_cursors.sync_cursors_sync_owner_select:${SYNC_SCOPE}`,
    `sync_cursors.sync_cursors_sync_owner_update:${SYNC_SCOPE}`,
  ],
};

const FUNCTIONS = {
  assign: "public.assign_sync_change_sequence()",
  bump: "public.bump_user_authorization_epoch(text)",
  onboarding: "public.create_initial_organization(text,text,text,text,uuid)",
  record: "public.record_sync_change()",
} as const;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, scenario by scenario
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const tests: string[] = [];
  const suffix = randomUUID().slice(0, 8);

  const scalar = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query<{ value: T }>(sql, params)).rows[0]?.value as T;
  // a transaction that is always rolled back, with the settings given (local to it) and, when asked, the role
  const rolledBack = async <T>(
    settings: Record<string, string>,
    role: string | undefined,
    body: () => Promise<T>
  ): Promise<T> => {
    await client.query("BEGIN");
    try {
      for (const [name, value] of Object.entries(settings)) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
      if (role) {
        await client.query(`SET LOCAL ROLE ${role}`);
      }
      return await body();
    } finally {
      await client.query("ROLLBACK");
    }
  };
  const refused = (
    role: string,
    settings: Record<string, string>,
    sql: string,
    params: unknown[],
    label: string
  ) =>
    rolledBack(settings, role, () =>
      expectSqlState(() => client.query(sql, params), "42501", label)
    );
  const rowCount = async (sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rowCount ?? 0;

  try {
    const server = await client.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    assert.equal(server.rows[0]?.database_name, expectedDatabase);
    assert.ok(Number(server.rows[0]?.server_version_num) >= 180_000);
    assert.equal(
      Number(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM drizzle.__drizzle_migrations"
        )
      ),
      journalMigrationCount()
    );
    const migrator = await scalar<string>(
      "SELECT pg_get_userbyid(datdba) AS value FROM pg_database WHERE datname = current_database()"
    );
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // ------------------------------------------------------------ 1. the tables
    const forced = await client.query<{
      force: boolean;
      relname: string;
      rls: boolean;
    }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`,
      [TABLES]
    );
    assert.deepEqual(
      forced.rows,
      TABLES.map((relname) => ({ force: true, relname, rls: true }))
    );
    assert.equal(
      await scalar<string>(
        `SELECT count(*)::text AS value FROM pg_trigger WHERE tgrelid = 'public."user"'::regclass AND NOT tgisinternal`
      ),
      "0",
      '"user" has no trigger: the UPDATE right the onboarding owner holds for FOR SHARE fires nothing'
    );
    assert.equal(
      await scalar<string>(
        "SELECT pg_get_expr(d.adbin, d.adrelid) AS value FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.organizations'::regclass AND a.attname = 'created_at'"
      ),
      "now()",
      "organizations.created_at defaults to now(), what the membership policy of the onboarding owner compares"
    );
    tests.push(
      `FORCE ROW LEVEL SECURITY stays on ${TABLES.join(", ")}; "user" has no trigger; organizations.created_at defaults to now()`
    );

    // ------------------------------------------- 2. owners and EXECUTE
    const functions = await client.query<{
      executors: string[];
      name: string;
      owner: string;
      secdef: boolean;
    }>(
      `SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
              ARRAY(SELECT pg_get_userbyid(x.grantee)::text FROM aclexplode(p.proacl) x
                     WHERE x.privilege_type = 'EXECUTE' ORDER BY 1) AS executors
         FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
      [Object.values(FUNCTIONS)]
    );
    const byName = (left: { name: string }, right: { name: string }) =>
      left.name < right.name ? -1 : 1;
    assert.deepEqual(
      functions.rows
        .map((row) => ({ ...row, executors: [...row.executors].sort() }))
        .sort(byName),
      [
        {
          executors: [SYNC_OWNER, migrator].sort(),
          name: "assign_sync_change_sequence()",
          owner: SYNC_OWNER,
          secdef: true,
        },
        {
          executors: [EPOCH_OWNER, "polaris_auth_runtime"].sort(),
          name: "bump_user_authorization_epoch(text)",
          owner: EPOCH_OWNER,
          secdef: true,
        },
        {
          executors: [ONBOARDING_OWNER, "polaris_onboarding_runtime"].sort(),
          name: "create_initial_organization(text,text,text,text,uuid)",
          owner: ONBOARDING_OWNER,
          secdef: true,
        },
        {
          executors: [SYNC_OWNER, migrator].sort(),
          name: "record_sync_change()",
          owner: SYNC_OWNER,
          secdef: true,
        },
      ].sort(byName)
    );
    tests.push(
      `the two sync triggers belong to ${SYNC_OWNER} (EXECUTE: it and the migrator, for a future CREATE TRIGGER), the bump to ${EPOCH_OWNER} (EXECUTE: polaris_auth_runtime) and the onboarding to ${ONBOARDING_OWNER} (EXECUTE: polaris_onboarding_runtime); all four stay SECURITY DEFINER`
    );

    // -------------------------------------------------- 3. the exact matrix
    for (const owner of OWNERS) {
      const granted = await client.query<{ privilege: string }>(
        `SELECT c.relname || '.' || a.attname || ':' || x.privilege_type AS privilege
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN LATERAL aclexplode(a.attacl) x
          WHERE x.grantee = $1::regrole
         UNION ALL
         SELECT c.relname || ':' || x.privilege_type
           FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
          WHERE x.grantee = $1::regrole
          ORDER BY 1`,
        [owner]
      );
      assert.deepEqual(
        granted.rows.map((row) => row.privilege).sort(),
        [...MATRIX[owner]].sort(),
        `the columns of ${owner}`
      );
      const wide = await client.query<{ relation: string }>(
        `SELECT c.oid::regclass::text AS relation FROM pg_class c
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
            AND (has_table_privilege($1, c.oid, 'DELETE') OR has_table_privilege($1, c.oid, 'TRUNCATE')
              OR has_table_privilege($1, c.oid, 'REFERENCES') OR has_table_privilege($1, c.oid, 'TRIGGER')
              OR has_any_column_privilege($1, c.oid, 'REFERENCES'))`,
        [owner]
      );
      assert.deepEqual(
        wide.rows,
        [],
        `${owner} has no DELETE, TRUNCATE, REFERENCES or TRIGGER`
      );
      const create = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE has_schema_privilege($1, oid, 'CREATE')",
        [owner]
      );
      assert.deepEqual(create.rows, [], `${owner} has CREATE on no schema`);
      assert.equal(
        await scalar<boolean>(
          "SELECT has_schema_privilege($1, 'public', 'USAGE') AS value",
          [owner]
        ),
        true
      );
      const owned = await client.query<{ object: string }>(
        `SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS object FROM pg_shdepend d
          WHERE d.refobjid = $1::regrole AND d.deptype = 'o'
            AND d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY 1`,
        [owner]
      );
      const ownFunctions = functions.rows
        .filter((row) => row.owner === owner)
        .map((row) => `function ${row.name}`);
      assert.deepEqual(
        owned.rows.map((row) => row.object).sort(),
        ownFunctions.sort(),
        `${owner} owns its functions and nothing else`
      );
      const executes = await client.query<{ name: string }>(
        `SELECT p.oid::regprocedure::text AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
          WHERE x.grantee = $1::regrole AND x.privilege_type = 'EXECUTE' AND p.proowner <> $1::regrole`,
        [owner]
      );
      assert.deepEqual(
        executes.rows,
        [],
        `${owner} was granted EXECUTE on no other function`
      );
    }
    tests.push(
      `${OWNERS.join(", ")}: exactly the columns of the design, no table-wide privilege, no DELETE, TRUNCATE, REFERENCES or TRIGGER on any relation, CREATE on no schema (USAGE on public), no object owned but their functions, EXECUTE granted on no other function`
    );

    // ------------------------------------------------------- 4. the policies
    const policies = await client.query<{
      policy: string;
      roles: string[];
      settings: string[];
    }>(
      `SELECT pol.tablename || '.' || pol.policyname AS policy, pol.roles::text[] AS roles,
              coalesce((SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
                          FROM regexp_matches(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
                                              'current_setting\\(''([^'']+)''', 'g') AS m), '{}'::text[]) AS settings
         FROM pg_policies pol
        WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS scope(name)
                       WHERE coalesce(pol.qual, '') || coalesce(pol.with_check, '') LIKE '%' || scope.name || '%')
           OR pol.roles && $2::name[]
        ORDER BY 1`,
      [SCOPES, OWNERS]
    );
    for (const owner of OWNERS) {
      assert.deepEqual(
        policies.rows
          .filter((row) => row.roles.includes(owner))
          .map((row) => `${row.policy}:${[...row.settings].sort().join(",")}`)
          .sort(),
        [...POLICIES[owner]].sort(),
        `the policies of ${owner}`
      );
    }
    for (const row of policies.rows) {
      assert.equal(
        row.roles.length,
        1,
        `${row.policy} is TO one role (${row.roles.join(",")})`
      );
      assert.ok(
        OWNERS.some((owner) => row.roles[0] === owner),
        `${row.policy} reads a setting of the three owners and is TO ${row.roles.join(",")}`
      );
    }
    // a policy TO PUBLIC would hold for the owners too: there is none on the six tables
    assert.equal(
      await scalar<string>(
        "SELECT count(*)::text AS value FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND 'public' = ANY(roles)",
        [TABLES]
      ),
      "0",
      "no policy TO PUBLIC on the six tables"
    );
    tests.push(
      "every policy that reads a setting of the three owners (app.owner_scope.*) is TO exactly one of the three owners and reads only that owner's settings; the owners have no other policy, and no policy on the six tables is TO PUBLIC"
    );

    // ----------------------------------------------------------- fixtures
    const userA = `gate-owners-a-${suffix}`;
    const userB = `gate-owners-b-${suffix}`;
    const userC = `gate-owners-c-${suffix}`;
    const userV = `gate-owners-v-${suffix}`;
    const userW = `gate-owners-w-${suffix}`;
    const organizationA = randomUUID();
    const organizationB = randomUUID();
    for (const user of [userA, userB, userC, userV, userW]) {
      await client.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $1, $2, true)',
        [user, `${user}@example.invalid`]
      );
    }
    for (const organization of [organizationA, organizationB]) {
      await client.query(
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Gate owners', $2)",
        [organization, TIMEZONE]
      );
    }
    // B is an owner of both organizations, A of the first only: the bump of B crosses organizations, never users
    for (const [organization, user] of [
      [organizationA, userA],
      [organizationA, userB],
      [organizationB, userB],
    ] as const) {
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
        [organization, user]
      );
    }
    const grantOf = async (user: string, organization: string) => {
      const device = await scalar<string>(
        "INSERT INTO public.devices (user_id) VALUES ($1) RETURNING id AS value",
        [user]
      );
      return await scalar<string>(
        `INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, expires_at)
         VALUES ($1, $2, $3, 0, now() + interval '24 hours') RETURNING id::text AS value`,
        [organization, user, device]
      );
    };
    const grantA = await grantOf(userA, organizationA);
    const grantBA = await grantOf(userB, organizationA);
    const grantBB = await grantOf(userB, organizationB);
    // one category per organization: its trigger writes and numbers a change of each (the sync owner, at the commit)
    for (const organization of [organizationA, organizationB]) {
      await client.query(
        "INSERT INTO public.categories (organization_id, name) VALUES ($1, 'Gate owners')",
        [organization]
      );
    }
    const cursorOf = async (organization: string) =>
      Number(
        await scalar<string>(
          "SELECT coalesce((SELECT last_seq::text FROM public.sync_cursors WHERE organization_id = $1), '0') AS value",
          [organization]
        )
      );
    assert.ok((await cursorOf(organizationA)) >= 1);
    assert.ok((await cursorOf(organizationB)) >= 1);

    // ------------------------------------------ 4b. a runtime that sets the scope itself
    const forged = {
      [EPOCH_SCOPE]: userA,
      [ONBOARDING_ORGANIZATION_SCOPE]: organizationA,
      [ONBOARDING_USER_SCOPE]: userA,
      [SYNC_SCOPE]: organizationA,
    };
    const tenantOfB = {
      "app.organization_id": organizationB,
      "app.user_id": userB,
    };
    const runtimes = (
      await client.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname ~ '^polaris_.+_runtime$' ORDER BY 1"
      )
    ).rows.map((row) => row.rolname);
    assert.ok(runtimes.includes(runtimeRole));
    let compared = 0;
    for (const runtime of runtimes) {
      for (const table of TABLES) {
        if (
          !(await scalar<boolean>(
            "SELECT has_any_column_privilege($1, $2::regclass, 'SELECT') AS value",
            [runtime, `public.${table}`]
          ))
        ) {
          continue;
        }
        const count = (settings: Record<string, string>) =>
          rolledBack(settings, runtime, () =>
            scalar<string>(
              `SELECT count(*)::text AS value FROM public.${table}`
            )
          );
        const plain = await count(tenantOfB);
        assert.equal(
          await count({ ...tenantOfB, ...forged }),
          plain,
          `${runtime} sees the same rows of ${table} with app.owner_scope.* set to another tenant`
        );
        assert.equal(
          await count(forged),
          await count({}),
          `${runtime} sees the same rows of ${table} with only app.owner_scope.* set`
        );
        compared += 1;
      }
    }
    assert.ok(compared >= 4, "the tenant runtime reads four of the tables");
    assert.equal(
      await rolledBack({ ...tenantOfB, ...forged }, runtimeRole, () =>
        scalar<string>(
          "SELECT count(*)::text AS value FROM public.memberships WHERE user_id = $1",
          [userA]
        )
      ),
      "0",
      "the forged scope does not show the memberships of A to the tenant runtime of B"
    );
    for (const [sql, params] of [
      [
        "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
        [organizationA, userB],
      ],
      [
        "INSERT INTO public.sync_cursors (organization_id, last_seq) VALUES ($1, 1)",
        [organizationA],
      ],
      [
        "UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1",
        [],
      ],
    ] as const) {
      await refused(
        runtimeRole,
        { ...tenantOfB, ...forged },
        sql,
        [...params],
        `the tenant runtime with a forged scope: ${sql}`
      );
    }
    tests.push(
      `a runtime that sets app.owner_scope.* itself (to another tenant) sees exactly the rows it saw without it, in every table of the six it may read (${compared} runtime-table pairs, ${runtimes.length} runtime groups), and still cannot write a membership, a cursor or an epoch`
    );

    // -------------------------------------------------------- 5. fail-closed
    const visible: Record<(typeof OWNERS)[number], string[]> = {
      [EPOCH_OWNER]: ["memberships", "offline_grants"],
      [ONBOARDING_OWNER]: ["memberships", "organizations"],
      [SYNC_OWNER]: ["sync_changes", "sync_cursors"],
    };
    for (const owner of OWNERS) {
      for (const table of visible[owner]) {
        assert.equal(
          await rolledBack({}, owner, () =>
            scalar<string>(
              `SELECT count(*)::text AS value FROM public.${table}`
            )
          ),
          "0",
          `${owner} without its setting sees no row of ${table}`
        );
      }
    }
    await refused(
      SYNC_OWNER,
      {},
      "INSERT INTO public.sync_changes (organization_id, entity_type, entity_id) VALUES ($1, 'category', $2)",
      [organizationA, randomUUID()],
      "the sync owner without its setting writes no change"
    );
    await refused(
      EPOCH_OWNER,
      {},
      "INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type) VALUES ($1, $2, 'offline_grant', $3, 'offline_grant.revoked')",
      [organizationA, userA, grantA],
      "the epoch owner without its setting writes no audit row"
    );
    await refused(
      ONBOARDING_OWNER,
      {},
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'x', $2)",
      [randomUUID(), TIMEZONE],
      "the onboarding owner without its setting creates no organization"
    );
    assert.equal(
      await rolledBack({}, EPOCH_OWNER, () =>
        rowCount(
          "UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1"
        )
      ),
      0,
      "the epoch owner without its setting updates no membership"
    );
    tests.push(
      "each owner without its app.owner_scope.* setting sees no row of its tables and writes nothing (0 rows or 42501): a body that forgets the setting fails closed"
    );

    // ------------------------------------------------- 5b. scoped to one user or organization
    const epochOfB = { [EPOCH_SCOPE]: userB };
    await rolledBack(epochOfB, EPOCH_OWNER, async () => {
      assert.equal(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM public.memberships WHERE user_id <> $1",
          [userB]
        ),
        "0"
      );
      assert.equal(
        await rowCount(
          "UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1"
        ),
        2,
        "an UPDATE without WHERE reaches the two memberships of B only"
      );
      assert.equal(
        await rowCount(
          "UPDATE public.offline_grants SET revoked_at = now(), revoked_reason = 'security_event' WHERE revoked_at IS NULL"
        ),
        2,
        "an UPDATE without the user reaches the two grants of B only"
      );
    });
    for (const [label, organization, actor, entity, event] of [
      ["a grant of A", organizationA, userB, grantA, "offline_grant.revoked"],
      [
        "another organization than the grant's",
        organizationB,
        userB,
        grantBA,
        "offline_grant.revoked",
      ],
      ["another actor", organizationA, userA, grantBA, "offline_grant.revoked"],
      ["another event", organizationA, userB, grantBA, "organization.created"],
    ] as const) {
      await refused(
        EPOCH_OWNER,
        epochOfB,
        "INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type) VALUES ($1, $2, 'offline_grant', $3, $4)",
        [organization, actor, entity, event],
        `the epoch owner scoped to B cannot audit ${label}`
      );
    }
    await rolledBack(epochOfB, EPOCH_OWNER, () =>
      client.query(
        "INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type) VALUES ($1, $2, 'offline_grant', $3, 'offline_grant.revoked')",
        [organizationA, userB, grantBA]
      )
    );
    const newOrganization = randomUUID();
    const onboardingOfB = {
      [ONBOARDING_ORGANIZATION_SCOPE]: newOrganization,
      [ONBOARDING_USER_SCOPE]: userB,
    };
    await rolledBack(onboardingOfB, ONBOARDING_OWNER, async () => {
      assert.equal(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM public.memberships WHERE user_id <> $1",
          [userB]
        ),
        "0"
      );
      assert.equal(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM public.organizations WHERE id NOT IN ($1, $2)",
          [organizationA, organizationB]
        ),
        "0",
        "the onboarding owner sees only the organizations of B (and the one of the call)"
      );
      await client.query(
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'x', $2)",
        [newOrganization, TIMEZONE]
      );
      assert.equal(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM public.organizations WHERE id = $1",
          [newOrganization]
        ),
        "1",
        "the onboarding owner reads back the organization it created in this transaction, by the scope on its id (no membership yet: only the branch by id admits the row; control of the next probe)"
      );
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
        [newOrganization, userB]
      );
    });
    for (const [label, sql, params] of [
      [
        "an organization with another id",
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'x', $2)",
        [randomUUID(), TIMEZONE],
      ],
      [
        "a membership of another user",
        "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
        [newOrganization, userC],
      ],
      [
        "a membership in organization A",
        "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
        [organizationA, userB],
      ],
      [
        "an audit row of another organization",
        "INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, event_type, entity_type, entity_id) VALUES ($1, $2, 'organization.created', 'organization', $1)",
        [organizationA, userB],
      ],
      [
        "an audit row of another actor",
        "INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, event_type, entity_type, entity_id) VALUES ($1, $2, 'organization.created', 'organization', $1)",
        [newOrganization, userA],
      ],
    ] as const) {
      await refused(
        ONBOARDING_OWNER,
        onboardingOfB,
        sql,
        [...params],
        `the onboarding owner scoped to B and a new organization cannot write ${label}`
      );
    }
    // the membership is only of an organization created in this transaction: with the scope pointed at organization A itself
    await refused(
      ONBOARDING_OWNER,
      {
        [ONBOARDING_ORGANIZATION_SCOPE]: organizationA,
        [ONBOARDING_USER_SCOPE]: userC,
      },
      "INSERT INTO public.memberships (organization_id, user_id) VALUES ($1, $2)",
      [organizationA, userC],
      "the onboarding owner cannot join a user to an organization created before the transaction, even with the scope on it"
    );
    // the branch by id of the SELECT of organizations is only for an organization created in this transaction (0096): with the
    // scope on organization A and on a user who is no member of it, the policy returns nothing, by id or by a scan
    await rolledBack(
      {
        [ONBOARDING_ORGANIZATION_SCOPE]: organizationA,
        [ONBOARDING_USER_SCOPE]: userC,
      },
      ONBOARDING_OWNER,
      async () => {
        assert.equal(
          await scalar<string>(
            "SELECT count(*)::text AS value FROM public.organizations WHERE id = $1",
            [organizationA]
          ),
          "0",
          "the onboarding owner does not read an older organization by the id in the scope"
        );
        assert.equal(
          await scalar<string>(
            "SELECT count(*)::text AS value FROM public.organizations"
          ),
          "0",
          "the onboarding owner scoped to an older organization and to a user without membership sees no organization"
        );
      }
    );
    const syncOfA = { [SYNC_SCOPE]: organizationA };
    await rolledBack(syncOfA, SYNC_OWNER, async () => {
      assert.equal(
        await scalar<string>(
          "SELECT count(*)::text AS value FROM public.sync_changes WHERE organization_id <> $1",
          [organizationA]
        ),
        "0"
      );
      assert.equal(
        await rowCount("UPDATE public.sync_changes SET seq = seq + 1000"),
        0,
        "a change already numbered is not updated again"
      );
      assert.equal(
        await rowCount(
          "UPDATE public.sync_cursors SET last_seq = last_seq + 1000"
        ),
        1,
        "a cursor update without WHERE reaches the cursor of A only"
      );
    });
    for (const [label, sql, params] of [
      [
        "read the entity of a change",
        "SELECT entity_id FROM public.sync_changes",
        [],
      ],
      ["delete a change", "DELETE FROM public.sync_changes", []],
      [
        "create the cursor of B",
        "INSERT INTO public.sync_cursors (organization_id, last_seq) VALUES ($1, 1)",
        [organizationB],
      ],
      [
        "move the cursor of B by upsert",
        "INSERT INTO public.sync_cursors (organization_id, last_seq) VALUES ($1, 1) ON CONFLICT (organization_id) DO UPDATE SET last_seq = 1",
        [organizationB],
      ],
      [
        "write a change of B",
        "INSERT INTO public.sync_changes (organization_id, entity_type, entity_id) VALUES ($1, 'category', $2)",
        [organizationB, randomUUID()],
      ],
    ] as const) {
      await refused(
        SYNC_OWNER,
        syncOfA,
        sql,
        [...params],
        `the sync owner scoped to A cannot ${label}`
      );
    }
    tests.push(
      "scoped to user B the epoch owner sees and updates only B's two memberships and two grants and audits only B's grants in their organization; scoped to B and a new organization the onboarding owner sees only B's organizations and writes only that organization, B's membership in it and its audit row (not an older organization, even with the scope on it, and does not read one back by the id in the scope); scoped to organization A the sync owner sees only A's changes, renumbers none, moves only A's cursor and can neither read an entity, delete a change, nor write B's cursor or change (42501)"
    );

    // ------------------------------------------------------ 6. planted defects
    const planted = async (
      owner: string,
      name: string,
      body: string,
      call: () => Promise<void>
    ) => {
      await rolledBack({}, undefined, async () => {
        await client.query(`GRANT CREATE ON SCHEMA public TO ${owner}`);
        await client.query(
          `GRANT ${owner} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
        );
        await client.query(`SET LOCAL ROLE ${owner}`);
        await client.query(
          `CREATE FUNCTION public.${name}(p_scope text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
             SET search_path = pg_catalog, public, pg_temp AS $body$ ${body} $body$`
        );
        await client.query("RESET ROLE");
        await call();
      });
    };
    const epochs = async () =>
      (
        await client.query<{ epoch: number; user_id: string }>(
          "SELECT user_id, sum(authorization_epoch)::int AS epoch FROM public.memberships WHERE user_id = ANY($1::text[]) GROUP BY 1 ORDER BY 1",
          [[userA, userB]]
        )
      ).rows;
    const before = await epochs();
    await planted(
      EPOCH_OWNER,
      `gate_bad_bump_${suffix.replaceAll("-", "")}`,
      `DECLARE v integer;
       BEGIN
         PERFORM pg_catalog.set_config('${EPOCH_SCOPE}', p_scope, true);
         UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1, updated_at = now();
         UPDATE public.offline_grants SET revoked_at = now(), revoked_reason = 'security_event' WHERE revoked_at IS NULL;
         GET DIAGNOSTICS v = ROW_COUNT;
         RETURN v;
       END;`,
      async () => {
        const revoked = await scalar<number>(
          `SELECT public.gate_bad_bump_${suffix.replaceAll("-", "")}($1) AS value`,
          [userB]
        );
        assert.equal(revoked, 2, "the defective bump revokes B's grants only");
        const after = await epochs();
        assert.deepEqual(
          after.find((row) => row.user_id === userA),
          before.find((row) => row.user_id === userA),
          "the epoch of A does not move"
        );
        assert.equal(
          after.find((row) => row.user_id === userB)?.epoch,
          (before.find((row) => row.user_id === userB)?.epoch ?? 0) + 2
        );
        assert.equal(
          await scalar<string>(
            "SELECT revoked_at IS NULL AS value FROM public.offline_grants WHERE id = $1",
            [grantA]
          ),
          true,
          "the grant of A stays live"
        );
      }
    );
    await planted(
      ONBOARDING_OWNER,
      `gate_bad_onboarding_${suffix.replaceAll("-", "")}`,
      `BEGIN
         PERFORM pg_catalog.set_config('${ONBOARDING_USER_SCOPE}', p_scope, true);
         PERFORM pg_catalog.set_config('${ONBOARDING_ORGANIZATION_SCOPE}', '${newOrganization}', true);
         INSERT INTO public.organizations (id, name, timezone) VALUES ('${newOrganization}', 'x', '${TIMEZONE}');
         INSERT INTO public.memberships (organization_id, user_id) VALUES ('${organizationA}', p_scope);
         RETURN 1;
       END;`,
      () =>
        expectSqlState(
          () =>
            client.query(
              `SELECT public.gate_bad_onboarding_${suffix.replaceAll("-", "")}($1)`,
              [userB]
            ),
          "42501",
          "an onboarding body that joins the user to organization A fails"
        )
    );
    const cursorsBefore = [
      await cursorOf(organizationA),
      await cursorOf(organizationB),
    ];
    await planted(
      SYNC_OWNER,
      `gate_bad_sync_${suffix.replaceAll("-", "")}`,
      `DECLARE v integer;
       BEGIN
         PERFORM pg_catalog.set_config('${SYNC_SCOPE}', p_scope, true);
         UPDATE public.sync_cursors SET last_seq = last_seq + 1000;
         GET DIAGNOSTICS v = ROW_COUNT;
         RETURN v;
       END;`,
      async () => {
        assert.equal(
          await scalar<number>(
            `SELECT public.gate_bad_sync_${suffix.replaceAll("-", "")}($1) AS value`,
            [organizationA]
          ),
          1
        );
        assert.deepEqual(
          [await cursorOf(organizationA), await cursorOf(organizationB)],
          [(cursorsBefore[0] as number) + 1000, cursorsBefore[1] as number],
          "a wrong last_seq moves only the cursor of the organization in scope"
        );
      }
    );
    tests.push(
      "defects planted in copies owned by the same roles stay in scope: a bump without WHERE changes only B's epochs and grants (A's untouched), an onboarding that joins B to organization A fails with 42501, and a cursor update without WHERE moves only the cursor of the organization in scope"
    );

    // ------------------------------------------------------ 7. the real calls
    // each call runs as the runtime that makes it, which first sets every app.owner_scope.* to user A and organization A: the
    // function overwrites the setting before it reads, so nothing of A may change
    const forgeScope = async () => {
      for (const [name, value] of Object.entries(forged)) {
        await client.query("SELECT set_config($1, $2, true)", [name, value]);
      }
    };
    const bump = (user: string) =>
      (async () => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE polaris_auth_runtime");
          await forgeScope();
          const revoked = await scalar<number>(
            "SELECT public.bump_user_authorization_epoch($1) AS value",
            [user]
          );
          await client.query("COMMIT");
          return revoked;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      })();
    const auditRows = async (user: string) =>
      (
        await client.query<{ entry: string }>(
          "SELECT organization_id || ':' || entity_id AS entry FROM public.tenant_audit_event WHERE actor_user_id = $1 AND event_type = 'offline_grant.revoked' ORDER BY 1",
          [user]
        )
      ).rows.map((row) => row.entry);
    const epochsBefore = await epochs();
    assert.equal(await bump(userB), 2);
    const epochsAfter = await epochs();
    assert.deepEqual(
      epochsAfter.find((row) => row.user_id === userA),
      epochsBefore.find((row) => row.user_id === userA)
    );
    assert.equal(
      epochsAfter.find((row) => row.user_id === userB)?.epoch,
      (epochsBefore.find((row) => row.user_id === userB)?.epoch ?? 0) + 2
    );
    assert.deepEqual(
      await auditRows(userB),
      [`${organizationA}:${grantBA}`, `${organizationB}:${grantBB}`].sort()
    );
    assert.equal(
      await scalar<boolean>(
        "SELECT revoked_at IS NULL AS value FROM public.offline_grants WHERE id = $1",
        [grantA]
      ),
      true
    );
    assert.equal(await bump(userB), 0, "a second bump revokes nothing more");
    const totals = async () =>
      await scalar<string>(
        "SELECT (SELECT sum(authorization_epoch) FROM public.memberships)::text || ':' || (SELECT count(*) FROM public.offline_grants WHERE revoked_at IS NULL)::text || ':' || (SELECT count(*) FROM public.tenant_audit_event)::text AS value"
      );
    const totalsBefore = await totals();
    assert.equal(await bump(userC), 0, "the bump of a user with no membership");
    assert.equal(
      await totals(),
      totalsBefore,
      "the bump of a user with no membership changes no epoch, grant or audit row"
    );
    tests.push(
      "the bump of B (owner in two organizations), as polaris_auth_runtime with app.owner_scope.* set to A beforehand, moves both of B's epochs, revokes B's two grants with one audit row each in their organization and leaves A alone; again, it revokes nothing; the bump of a user with no membership answers 0 and changes nothing"
    );

    const onboard = async (
      user: string,
      organization: string
    ): Promise<{ created: boolean; id: string }> => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE polaris_onboarding_runtime");
        await forgeScope();
        const result = await client.query<{ created: boolean; id: string }>(
          "SELECT created, id FROM public.create_initial_organization($1, $2, 'Loja do gate', $3, $4)",
          [user, organization, TIMEZONE, randomUUID()]
        );
        await client.query("COMMIT");
        assert.ok(result.rows[0]);
        return result.rows[0];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    const membersOfA = async () =>
      await scalar<string>(
        "SELECT string_agg(user_id, ',' ORDER BY user_id) AS value FROM public.memberships WHERE organization_id = $1",
        [organizationA]
      );
    const membersOfABefore = await membersOfA();
    const first = randomUUID();
    assert.deepEqual(await onboard(userV, first), { created: true, id: first });
    assert.deepEqual(await onboard(userV, first), {
      created: false,
      id: first,
    });
    assert.deepEqual(await onboard(userV, randomUUID()), {
      created: false,
      id: first,
    });
    assert.equal(
      await scalar<string>(
        "SELECT (SELECT count(*) FROM public.memberships WHERE user_id = $1)::text || ':' || (SELECT count(*) FROM public.tenant_audit_event WHERE actor_user_id = $1 AND event_type = 'organization.created')::text || ':' || (SELECT string_agg(role || '/' || status || '/' || authorization_epoch, ',') FROM public.memberships WHERE user_id = $1) AS value",
        [userV]
      ),
      "1:1:owner/active/0",
      "one organization, one owner membership and one audit row, whatever the reruns"
    );
    assert.equal(
      await membersOfA(),
      membersOfABefore,
      "the onboarding with the scope forged to A leaves the memberships of A alone"
    );
    await expectSqlState(
      () => onboard(userW, organizationA),
      "23505",
      "the onboarding with the organization of another tenant stops on its primary key"
    );
    tests.push(
      "the onboarding, as polaris_onboarding_runtime with app.owner_scope.* set to A beforehand, creates the organization, the owner membership (active, epoch 0) and the audit row; run again with the same or another organization ID it answers the existing one and writes nothing; with the ID of another tenant's organization it stops on the primary key (23505)"
    );

    const cursors = async () => [
      await cursorOf(organizationA),
      await cursorOf(organizationB),
    ];
    const pending = async () =>
      await scalar<string>(
        "SELECT count(*)::text AS value FROM public.sync_changes WHERE seq IS NULL"
      );
    const addCategory = (organization: string) =>
      client.query(
        "INSERT INTO public.categories (organization_id, name) VALUES ($1, $2)",
        [organization, `Gate owners ${randomUUID().slice(0, 8)}`]
      );
    const [beforeA, beforeB] = await cursors();
    await client.query("BEGIN");
    // the writer sets the scope to B first; each trigger writes its own organization before it reads
    await client.query("SELECT set_config($1, $2, true)", [
      SYNC_SCOPE,
      organizationB,
    ]);
    await addCategory(organizationA);
    await addCategory(organizationB);
    await addCategory(organizationA);
    await client.query("COMMIT");
    assert.deepEqual(await cursors(), [
      (beforeA as number) + 2,
      (beforeB as number) + 1,
    ]);
    assert.equal(await pending(), "0");
    await client.query("BEGIN");
    await addCategory(organizationA);
    await client.query("SAVEPOINT gate_owners");
    await addCategory(organizationB);
    await client.query("ROLLBACK TO SAVEPOINT gate_owners");
    await addCategory(organizationA);
    await client.query("COMMIT");
    assert.deepEqual(await cursors(), [
      (beforeA as number) + 4,
      (beforeB as number) + 1,
    ]);
    assert.equal(await pending(), "0");
    const gaps = await scalar<string>(
      `SELECT count(*)::text AS value FROM (
         SELECT organization_id, seq, row_number() OVER (PARTITION BY organization_id ORDER BY seq) AS position
           FROM public.sync_changes WHERE organization_id = ANY($1::text[])
       ) AS numbered WHERE seq <> position`,
      [[organizationA, organizationB]]
    );
    assert.equal(gaps, "0", "the numbers of each organization have no gap");
    tests.push(
      "a transaction that writes in two organizations numbers the changes of each at the commit and moves each cursor by its own count; a SAVEPOINT rolled back takes its change with it (B's cursor stays) and the rest is numbered; no change is left without a number and each organization's numbers have no gap"
    );
  } finally {
    await client.end();
  }

  console.log(
    JSON.stringify({ branch, database: expectedDatabase, tests }, null, 2)
  );
}

run().catch((error: unknown) => {
  console.error(
    `Definer owners PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
