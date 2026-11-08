// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { setLoginRole, withGateRole } from "./gate-roles";
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
 * The M3 "came back to the app" on a real PostgreSQL 18 (ADR 0106, D9; migration 0127):
 *   1. who reaches what (AC-4.1): `polaris_activation_owner` is NOLOGIN NOINHERIT NOBYPASSRLS and holds, of `session`,
 *      only `user_id`, `created_at` and `updated_at` (not `id`, `token`, `ip_address`, `user_agent` nor `expires_at`,
 *      not the table, no write), the exact columns of its other tables, nothing of `products`, `"user"`,
 *      `auth_access_log` nor `devices`; its policy on `session` is its only one there and the tenant, billing, catalog
 *      and Admin roles have none; `activation_return_freeze` is SECURITY DEFINER of it, with the fixed search_path and
 *      no dynamic SQL, executed only by the billing role (a tenant login is refused); no other role reaches the table;
 *      the owner sees the stores of 41 days and not those of 43;
 *   2. the count (AC-4.2), one seeded cohort: came back on day 2, on day 14, at 00:00 of the next day, by a new
 *      sign-in inside the window with a touch after it, by the session of day 0 touched after the window (it crosses
 *      it), and a store that sold only on day 15; never came back: the same day only (also at 23:59), never, a sign-in
 *      on day 15 (it starts after the window), an expired session already deleted, a sign-out; out of the
 *      measure but in the difference with the funnel: a trial, a waived trial, Pro, grace and a second store of a person;
 *      out of everything: an internal store and one that sold within 14 days. The week reads 7 and 7;
 *   3. the windows: a week of 14 days ago is not due yet, one of 28 days ago is frozen (here below k, both null) until its start plus 31 days and not after, one of 35 days
 *      ago is no longer frozen (a session that proved a return may be gone);
 *   4. the suppression with the complement (AC-4.4): 4 who came back, 4 who did not, or 4 left out of the measure
 *      freeze the week with both cells null;
 *   5. the frozen week does not follow the sessions (AC-4.3): with every session of the cohort deleted, the next sweep
 *      writes nothing and the row reads the same;
 *   6. append-only and without identity (AC-4.4): UPDATE, DELETE and TRUNCATE refused even to the owner of the table,
 *      the triggers ALWAYS, the columns are the week, the instant and the two cells, a cell under k, a lone cell or a
 *      week that is not a Monday refused;
 *   7. a sweep that fails writes nothing (AC-4.5): the week stays without a row, which the reader shows unavailable,
 *      and the next sweep freezes it.
 * Every case runs in a transaction that is rolled back, with the stores the other gates left marked internal inside
 * it, so the counts are about this gate's stores only. Local Postgres only: the fixtures write sale headers whose items
 * the deferred checks never see.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const BILLING_RUNTIME = "polaris_billing_runtime";
const ACTIVATION_OWNER = "polaris_activation_owner";
const FUNCTION = "public.activation_return_freeze()";
const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DYNAMIC_SQL = /\bEXECUTE\b|\bformat\s*\(/i;

interface Frozen {
  never_returned_stores: number | null;
  returned_stores: number | null;
  week_start: string;
}

interface SessionSpec {
  created: number;
  deleted?: boolean;
  touched: number;
}

interface StoreSpec {
  billing?: { state: string; trial: boolean };
  /** A second owner who joins a minute later, with these sessions. */
  coOwnerSessions?: SessionSpec[];
  /** Offset from the start of the cohort week; the stores are created on its Tuesday at noon by default. */
  createdOffset?: number;
  internal?: boolean;
  /** The person, when it already owns another store. */
  owner?: string;
  /** A sale this long after the creation. */
  saleAfter?: number;
  /** A store with no owner's membership (gone, or purged with it). */
  ownerless?: boolean;
  /** The sessions of the owner, as offsets from the creation of the store. */
  sessions?: SessionSpec[];
  status?: string;
}

const at = (base: Date, offset: number) => new Date(base.getTime() + offset);
const TUESDAY_NOON = DAY + 12 * HOUR;

/** Midnight of the next day of São Paulo, from noon of the store's day. */
const NEXT_MIDNIGHT = 12 * HOUR;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const as = async <T>(
      url: string,
      operation: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      return url.toString();
    };

    // 1. who reaches what (AC-4.1)
    const role = await owner.pool.query(
      `SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(role.rows, [
      {
        rolbypassrls: false,
        rolcanlogin: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false,
      },
    ]);
    const sessionColumns = await owner.pool.query<{
      column_name: string;
      readable: boolean;
    }>(
      `SELECT a.attname AS column_name, pg_catalog.has_column_privilege($1, 'public.session', a.attname, 'SELECT') AS readable
         FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = 'public.session'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attname COLLATE "C"`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(
      sessionColumns.rows
        .filter((row) => row.readable)
        .map((row) => row.column_name),
      ["created_at", "updated_at", "user_id"],
      "of session, only the three columns"
    );
    for (const forbidden of [
      "id",
      "token",
      "ip_address",
      "user_agent",
      "expires_at",
    ]) {
      assert.ok(
        sessionColumns.rows.some(
          (row) => row.column_name === forbidden && !row.readable
        ),
        `session.${forbidden} is not readable`
      );
    }
    const sessionTable = await owner.pool.query(
      `SELECT pg_catalog.has_table_privilege($1, 'public.session', 'SELECT') AS whole,
              pg_catalog.has_table_privilege($1, 'public.session', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS write,
              pg_catalog.has_any_column_privilege($1, 'public.session', 'INSERT, UPDATE, REFERENCES') AS column_write,
              pg_catalog.has_any_column_privilege($1, 'public.products', 'SELECT') AS products,
              pg_catalog.has_any_column_privilege($1, 'public."user"', 'SELECT') AS person,
              pg_catalog.has_any_column_privilege($1, 'public.auth_access_log', 'SELECT') AS access_log,
              pg_catalog.has_any_column_privilege($1, 'public.devices', 'SELECT') AS devices,
              pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS creates`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(sessionTable.rows[0], {
      access_log: false,
      column_write: false,
      creates: false,
      devices: false,
      person: false,
      products: false,
      whole: false,
      write: false,
    });
    const held = await owner.pool.query<{ entry: string }>(
      `SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
         FROM information_schema.column_privileges AS c
        WHERE c.grantee = $1
        ORDER BY (c.table_name || '.' || c.column_name || ':' || c.privilege_type) COLLATE "C"`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(
      held.rows.map((row) => row.entry),
      [
        "activation_return_weeks.cohort_week:INSERT",
        "activation_return_weeks.cohort_week:SELECT",
        "activation_return_weeks.never_returned:INSERT",
        "activation_return_weeks.never_returned:SELECT",
        "activation_return_weeks.returned:INSERT",
        "activation_return_weeks.returned:SELECT",
        "memberships.created_at:SELECT",
        "memberships.organization_id:SELECT",
        "memberships.role:SELECT",
        "memberships.status:SELECT",
        "memberships.user_id:SELECT",
        "organization_billing.organization_id:SELECT",
        "organization_billing.state:SELECT",
        "organization_billing.trial_started_at:SELECT",
        "organizations.created_at:SELECT",
        "organizations.id:SELECT",
        "organizations.status:SELECT",
        "platform_internal_organizations.organization_id:SELECT",
        "sales.confirmed_at:SELECT",
        "sales.organization_id:SELECT",
        "session.created_at:SELECT",
        "session.updated_at:SELECT",
        "session.user_id:SELECT",
      ],
      "the owner of the measure holds exactly these columns"
    );
    const tablePrivileges = await owner.pool.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE grantee = $1",
      [ACTIVATION_OWNER]
    );
    assert.equal(tablePrivileges.rows.length, 0, "no table privilege");
    const sessionPolicies = await owner.pool.query<{
      cmd: string;
      policyname: string;
      qual: string | null;
      roles: string[];
    }>(
      `SELECT policyname, cmd, roles::text[] AS roles, qual FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = 'session' ORDER BY policyname COLLATE "C"`
    );
    const activationOnSession = sessionPolicies.rows.filter((row) =>
      row.roles.includes(ACTIVATION_OWNER)
    );
    assert.deepEqual(activationOnSession, [
      {
        cmd: "SELECT",
        policyname: "session_activation_owner_select",
        qual: "true",
        roles: [ACTIVATION_OWNER],
      },
    ]);
    const policyRoles = sessionPolicies.rows.flatMap((row) => row.roles);
    for (const absent of [
      runtimeRole,
      BILLING_RUNTIME,
      "polaris_catalog_runtime",
      "polaris_catalog_owner",
      "polaris_admin_runtime",
      "polaris_admin_owner",
      "polaris_activation_notice_owner",
      "public",
    ]) {
      assert.ok(
        !policyRoles.includes(absent),
        `${absent} has no policy on session`
      );
    }
    const ownerPolicies = await owner.pool.query<{ policy: string }>(
      `SELECT tablename || '.' || policyname AS policy FROM pg_catalog.pg_policies
        WHERE $1 = ANY (roles) ORDER BY (tablename || '.' || policyname) COLLATE "C"`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(
      ownerPolicies.rows.map((row) => row.policy),
      [
        "activation_return_weeks.activation_return_weeks_owner_insert",
        "activation_return_weeks.activation_return_weeks_owner_select",
        "memberships.memberships_activation_owner_select_owner",
        "organization_billing.organization_billing_activation_owner_select_recent",
        "organizations.organizations_activation_owner_select_recent",
        "platform_internal_organizations.platform_internal_organizations_activation_owner_select_recent",
        "sales.sales_activation_owner_select_recent",
        "session.session_activation_owner_select",
      ]
    );
    // every relation of the schema, so a grant to PUBLIC or through another role shows up too
    const reachable = await owner.pool.query<{ relation: string }>(
      `SELECT c.relname::text AS relation FROM pg_catalog.pg_class AS c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
               OR pg_catalog.has_table_privilege($1, c.oid, 'DELETE, TRUNCATE, TRIGGER'))
        ORDER BY c.relname COLLATE "C"`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(
      reachable.rows.map((row) => row.relation),
      [
        "activation_return_weeks",
        "memberships",
        "organization_billing",
        "organizations",
        "platform_internal_organizations",
        "sales",
        "session",
      ],
      "of every relation of public, the owner reaches only these seven"
    );
    const members = await owner.pool.query(
      `SELECT m.member::regrole::text AS member FROM pg_catalog.pg_auth_members AS m
        WHERE m.roleid = $1::regrole AND (m.set_option OR m.inherit_option)`,
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(members.rows, [], "no role can become or inherit it");
    const definition = await owner.pool.query<{
      config: string[];
      definer: boolean;
      owner: string;
      source: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner, p.prosrc AS source
         FROM pg_catalog.pg_proc AS p WHERE p.oid = $1::regprocedure`,
      [FUNCTION]
    );
    const [fn] = definition.rows;
    assert.ok(fn);
    assert.equal(fn.definer, true, "SECURITY DEFINER");
    assert.equal(fn.owner, ACTIVATION_OWNER);
    assert.deepEqual(fn.config, ["search_path=pg_catalog, public, pg_temp"]);
    assert.doesNotMatch(fn.source, DYNAMIC_SQL, "no dynamic SQL");
    // the edges of the window, read from the body: the gate proves only one side of the upper edge on a given weekday
    for (const edge of [
      "week.start + interval '21 days' <= local_now",
      "week.start + interval '31 days' > local_now",
    ]) {
      assert.ok(fn.source.includes(edge), `the window keeps ${edge}`);
    }
    const owned = await owner.pool.query<{ fn: string }>(
      "SELECT p.oid::regprocedure::text AS fn FROM pg_catalog.pg_proc AS p WHERE p.proowner = $1::regrole",
      [ACTIVATION_OWNER]
    );
    assert.deepEqual(
      owned.rows.map((row) => row.fn),
      ["activation_return_freeze()"],
      "it owns only the function of the measure"
    );
    const reach = (privilege: string) =>
      owner.pool.query<{ role: string }>(
        `SELECT r.role FROM (
           SELECT 'public' AS role
           UNION ALL SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'polaris\\_%' AND NOT rolcanlogin
         ) AS r
          WHERE ${privilege}
          ORDER BY r.role COLLATE "C"`
      );
    assert.deepEqual(
      (
        await reach(
          `pg_catalog.has_function_privilege(r.role, '${FUNCTION}', 'EXECUTE')`
        )
      ).rows.map((row) => row.role),
      [ACTIVATION_OWNER, BILLING_RUNTIME],
      "only the billing role executes it (and its owner)"
    );
    assert.deepEqual(
      (
        await reach(
          `pg_catalog.has_any_column_privilege(r.role, 'public.activation_return_weeks', 'SELECT, INSERT, UPDATE, REFERENCES')
            OR pg_catalog.has_table_privilege(r.role, 'public.activation_return_weeks', 'DELETE, TRUNCATE, TRIGGER')`
        )
      ).rows.map((row) => row.role),
      [ACTIVATION_OWNER],
      "only the owner of the measure reaches the frozen counts"
    );
    const billingUrl = await login(BILLING_RUNTIME, "polaris_returns_billing");
    const tenantUrl = await login(runtimeRole, "polaris_returns_tenant");
    await as(tenantUrl, async (client) => {
      await setLoginRole(client, runtimeRole, "session");
      await expectSqlState(
        () => client.query(`SELECT * FROM ${FUNCTION}`),
        "42501",
        "the tenant does not execute the freezing"
      );
      await expectSqlState(
        () => client.query("SELECT * FROM public.activation_return_weeks"),
        "42501",
        "the tenant does not read the frozen counts"
      );
    });
    await as(billingUrl, async (client) => {
      await setLoginRole(client, BILLING_RUNTIME, "session");
      await client.query("BEGIN");
      try {
        await client.query(`SELECT * FROM ${FUNCTION}`);
        await expectSqlState(
          () => client.query("SELECT * FROM public.activation_return_weeks"),
          "42501",
          "the billing role does not read the frozen counts"
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });
    tests.push(
      "polaris_activation_owner is NOLOGIN NOINHERIT NOBYPASSRLS; of session it reads only user_id, created_at and updated_at (id, token, ip_address, user_agent and expires_at not readable, no table privilege, no write), it holds exactly its 23 column privileges and nothing of products, user, auth_access_log or devices, and no CREATE; its policy on session (SELECT, true) is its only one there and the tenant, billing, catalog, Admin and series roles have none; it has exactly its 8 policies and owns only activation_return_freeze, SECURITY DEFINER with search_path pg_catalog, public, pg_temp and no dynamic SQL; only the billing role executes it (a tenant login is refused, 42501), and only the owner reaches the frozen counts (the tenant and the billing role cannot read them, 42501)"
    );

    const scenario = async <T>(
      work: (client: Client, week: Date) => Promise<T>
    ): Promise<T> =>
      as(adminUrl, async (client) => {
        await client.query("BEGIN");
        try {
          // the function must not lean on the session's zone: a database in São Paulo would hide a day of UTC
          await client.query("SET LOCAL TimeZone = 'UTC'");
          // the trigger stamps a new session with now(): the cases need sessions signed in on past days
          await client.query(
            "ALTER TABLE public.session DISABLE TRIGGER session_absolute_expiration"
          );
          // the stores other gates left are out of this transaction's counts
          await client.query(
            `INSERT INTO public.platform_internal_organizations (organization_id)
             SELECT o.id FROM public.organizations AS o
              WHERE NOT EXISTS (SELECT 1 FROM public.platform_internal_organizations AS i WHERE i.organization_id = o.id)`
          );
          // the Monday of this week in São Paulo, from the transaction's clock, the one the function reads
          const week = await client.query<{ start: Date }>(
            `SELECT pg_catalog.date_trunc('week', now() AT TIME ZONE '${ZONE}') AT TIME ZONE '${ZONE}' AS start`
          );
          const start = week.rows[0]?.start;
          assert.ok(start instanceof Date);
          return await work(client, start);
        } finally {
          await client.query("ROLLBACK");
        }
      });
    const newPerson = async (client: Client) => {
      const userId = randomUUID();
      await client.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [userId, "Pessoa do gate do M3", `returns-${userId}@example.invalid`]
      );
      return userId;
    };
    const addSessions = async (
      client: Client,
      userId: string,
      createdAt: Date,
      sessions: SessionSpec[]
    ) => {
      for (const session of sessions) {
        const id = randomUUID();
        await client.query(
          "INSERT INTO public.session (id, token, user_id, created_at, updated_at, expires_at) VALUES ($1, $1, $2, $3, $4, $5)",
          [
            id,
            userId,
            at(createdAt, session.created),
            at(createdAt, session.touched),
            at(createdAt, session.touched + 7 * DAY),
          ]
        );
        if (session.deleted) {
          await client.query("DELETE FROM public.session WHERE id = $1", [id]);
        }
      }
    };
    const newStore = async (
      client: Client,
      cohort: Date,
      spec: StoreSpec = {}
    ) => {
      const organizationId = randomUUID();
      const createdAt = at(cohort, spec.createdOffset ?? TUESDAY_NOON);
      const userId = spec.owner ?? (await newPerson(client));
      await client.query(
        "INSERT INTO public.organizations (id, name, timezone, status, created_at) VALUES ($1, 'Loja do gate do M3', $2, $3, $4)",
        [organizationId, ZONE, spec.status ?? "active", createdAt]
      );
      if (!spec.ownerless) {
        await client.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
          [organizationId, userId, createdAt]
        );
      }
      if (spec.coOwnerSessions) {
        const coOwner = await newPerson(client);
        await client.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
          [organizationId, coOwner, at(createdAt, MINUTE)]
        );
        await addSessions(client, coOwner, createdAt, spec.coOwnerSessions);
      }
      if (spec.saleAfter !== undefined) {
        // only the header: the checks of its items are deferred to a commit this transaction never reaches
        await client.query(
          `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, confirmed_at)
           VALUES ($1, gen_random_uuid(), $2, ($2::timestamptz AT TIME ZONE '${ZONE}')::date, 1, 0, $2)`,
          [organizationId, at(createdAt, spec.saleAfter)]
        );
      }
      if (spec.billing) {
        await client.query(
          `INSERT INTO public.organization_billing (organization_id, state, access_ends_at, cycle_months, trial_started_at)
           VALUES ($1, $2::text,
                   CASE WHEN $2::text IN ('trialing', 'active', 'grace') THEN now() + interval '7 days' END,
                   CASE WHEN $2::text IN ('active', 'grace') THEN 1 END,
                   CASE WHEN $3 THEN $4::timestamptz END)`,
          [
            organizationId,
            spec.billing.state,
            spec.billing.trial,
            at(createdAt, HOUR),
          ]
        );
      }
      if (spec.internal) {
        await client.query(
          "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ($1)",
          [organizationId]
        );
      }
      if (!spec.ownerless) {
        await addSessions(client, userId, createdAt, spec.sessions ?? []);
      }
      return { organizationId, userId };
    };
    const freeze = (client: Client) =>
      withGateRole(client, BILLING_RUNTIME, async () => {
        const result = await client.query<Frozen>(
          `SELECT week_start::text AS week_start, returned_stores, never_returned_stores FROM ${FUNCTION}`
        );
        return result.rows;
      });
    const frozenRows = async (client: Client) =>
      (
        await client.query<{
          cohort_week: string;
          never_returned: number | null;
          returned: number | null;
        }>(
          "SELECT cohort_week::text AS cohort_week, returned, never_returned FROM public.activation_return_weeks ORDER BY cohort_week"
        )
      ).rows;
    const dayOf = (instant: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(instant);
    // the week of 28 days ago is also due from Monday to Wednesday (its start plus 31 days is Thursday 00:00): the
    // cases about one week read only that week
    const freezeWeek = async (client: Client, week: Date) =>
      (await freeze(client)).filter((row) => row.week_start === dayOf(week));
    const frozenWeek = async (client: Client, week: Date) =>
      (await frozenRows(client)).filter(
        (row) => row.cohort_week === dayOf(week)
      );
    const once = (offset: number): SessionSpec[] => [
      { created: -HOUR, touched: offset },
    ];
    const hidden = (week: Date): Frozen[] => [
      {
        never_returned_stores: null,
        returned_stores: null,
        week_start: dayOf(week),
      },
    ];

    /** How many to take away from each group of the seeded cohort. */
    interface Drop {
      back?: number;
      idle?: number;
      leftOut?: number;
    }
    /** The cohort of the count: 7 came back, 7 did not, 5 left out of the measure; `drop` takes some of a group away. */
    const seedCohort = async (
      client: Client,
      cohort: Date,
      drop: Drop = {}
    ) => {
      const back: StoreSpec[] = [
        { sessions: once(DAY) },
        { sessions: once(14 * DAY) },
        { sessions: once(NEXT_MIDNIGHT) },
        // a new sign-in on day 5, its last touch on day 20: the sign-in is the return
        { sessions: [{ created: 5 * DAY, touched: 20 * DAY }] },
        // the session of day 0 kept alive and last touched on day 20: it crosses the window, so it came back
        { sessions: [{ created: -HOUR, touched: 20 * DAY }] },
        // signed in at 23:59 of São Paulo on day 14 (02:59 of day 15 in UTC) and touched on day 20: inside the window
        {
          sessions: [
            { created: 14 * DAY + NEXT_MIDNIGHT - MINUTE, touched: 20 * DAY },
          ],
        },
        // a sale only on day 15 keeps the store among those that did not activate
        { saleAfter: 15 * DAY, sessions: once(2 * DAY) },
      ];
      const idle: StoreSpec[] = [
        { sessions: once(HOUR) },
        { sessions: once(NEXT_MIDNIGHT - MINUTE) },
        {},
        // signed in on day 15 and touched on day 20: it starts after the window, so it does not cross it
        { sessions: [{ created: 15 * DAY, touched: 20 * DAY }] },
        // signed in at 00:00 of São Paulo on day 15 and touched on day 20: one minute past the window
        {
          sessions: [{ created: 14 * DAY + NEXT_MIDNIGHT, touched: 20 * DAY }],
        },
        // expired and already deleted, and ended by a sign-out: the trace is gone (the floor of D9)
        { sessions: [{ created: -HOUR, deleted: true, touched: 3 * DAY }] },
        { sessions: [{ created: 2 * DAY, deleted: true, touched: 2 * DAY }] },
      ];
      const leftOut: StoreSpec[] = [
        { billing: { state: "trialing", trial: true }, sessions: once(DAY) },
        { billing: { state: "free", trial: true }, sessions: once(DAY) },
        { billing: { state: "active", trial: false }, sessions: once(DAY) },
        { billing: { state: "grace", trial: false } },
      ];
      const kept = [
        ...back.slice(drop.back ?? 0),
        ...idle.slice(drop.idle ?? 0),
        ...leftOut.slice(drop.leftOut ?? 0),
      ];
      for (const spec of kept) {
        await newStore(client, cohort, spec);
      }
      // the second store of a person whose first store is older (in the week before): left out, though it came back
      const first = await newStore(client, at(cohort, -7 * DAY));
      await newStore(client, cohort, {
        owner: first.userId,
        sessions: once(DAY),
      });
      // out of everything: an internal store and a store that sold on day 14, both of which came back
      await newStore(client, cohort, { internal: true, sessions: once(DAY) });
      await newStore(client, cohort, {
        saleAfter: 14 * DAY,
        sessions: once(DAY),
      });
    };

    // 2. and 3. the count and the windows
    await scenario(async (client, current) => {
      const due = at(current, -21 * DAY);
      const older = at(current, -28 * DAY);
      const early = at(current, -14 * DAY);
      const late = at(current, -35 * DAY);
      await seedCohort(client, due);
      await newStore(client, older, { sessions: once(DAY) });
      await newStore(client, early, { sessions: once(DAY) });
      await newStore(client, late, { sessions: once(DAY) });
      // the week of 28 days ago is due only until its start plus 31 days, Thursday 00:00 of this week in São Paulo:
      // the case reads that edge from the transaction's clock, so it holds on every day of the week (one side of the
      // edge per day; the literal is checked in the body above)
      const edge = await client.query<{ open: boolean }>(
        "SELECT now() < $1::timestamptz + interval '31 days' AS open",
        [older]
      );
      const written = await freeze(client);
      assert.deepEqual(written, [
        ...(edge.rows[0]?.open ? hidden(older) : []),
        {
          never_returned_stores: 7,
          returned_stores: 7,
          week_start: dayOf(due),
        },
      ]);
      assert.deepEqual(
        await frozenRows(client),
        written.map((row) => ({
          cohort_week: row.week_start,
          never_returned: row.never_returned_stores,
          returned: row.returned_stores,
        }))
      );
      // the owner sees the stores of 41 days and not those of 43 (the oldest week it freezes started 31 days back)
      const clock = await client.query<{ now: Date }>("SELECT now() AS now");
      const now = clock.rows[0]?.now;
      assert.ok(now instanceof Date);
      const recent = await newStore(client, now, { createdOffset: -41 * DAY });
      const stale = await newStore(client, now, { createdOffset: -43 * DAY });
      const seen = await withGateRole(client, ACTIVATION_OWNER, async () => {
        const result = await client.query<{ id: string }>(
          "SELECT id FROM public.organizations WHERE id = ANY ($1)",
          [[recent.organizationId, stale.organizationId]]
        );
        await client.query("SAVEPOINT session_id");
        await expectSqlState(
          () => client.query("SELECT id FROM public.session LIMIT 1"),
          "42501",
          "the owner does not read the ID of a session"
        );
        await client.query("ROLLBACK TO SAVEPOINT session_id");
        return result.rows.map((row) => row.id);
      });
      assert.deepEqual(seen, [recent.organizationId]);
    });
    tests.push(
      "the count of a seeded cohort of 21 days ago (session in UTC): came back on day 2, on day 14, at 00:00 of the next day of São Paulo, by a sign-in on day 5 touched last on day 20, by the session of day 0 touched last on day 20 (it crosses the window), a sign-in at 23:59 of day 14 touched on day 20, and a store that sold only on day 15 (7); did not: the same day only, at 23:59 of that day, never, a sign-in on day 15 touched on day 20 (it starts after the window), one at 00:00 of São Paulo on day 15, an expired session already deleted, a sign-out (6); out of the measure: trialing, waived trial, Pro, grace and a second store of a person (5); out of everything: an internal store and one that sold on day 14. The week reads 7 and 7, the week of 28 days ago is frozen below k (both null) before its start plus 31 days (Thursday 00:00) and not after, the weeks of 14 and 35 days ago are not frozen; the owner sees a store of 41 days and not one of 43, and cannot read the ID of a session (42501)"
    );

    // the controls of the filters and of the midnights of São Paulo, on a cohort cut to 7 who came back, 4 who did not
    // and 4 left out
    await scenario(async (client, current) => {
      const due = at(current, -21 * DAY);
      await seedCohort(client, due, { idle: 3, leftOut: 1 });
      // a session of the founder from before the store, last touched before it: no touch after the day of the store
      await newStore(client, due, {
        sessions: [{ created: -3 * DAY, touched: -DAY }],
      });
      // the founder never came back and a co-owner who joined a minute later did: the founder is the one counted
      await newStore(client, due, { coOwnerSessions: once(DAY) });
      // no active owner: left out of the measure, in the difference with the funnel
      await newStore(client, due, { ownerless: true });
      // purged: out of everything (the funnel leaves it out too)
      await newStore(client, due, { ownerless: true, status: "purged" });
      // created at 22:30 of São Paulo (01:30 of the next day in UTC), back at 00:30: a return on the next local day
      await newStore(client, due, {
        createdOffset: DAY + 22 * HOUR + 30 * MINUTE,
        sessions: once(2 * HOUR),
      });
      // created at 00:00 of the Monday of the week, back the next day: of this week
      await newStore(client, due, { createdOffset: 0, sessions: once(DAY) });
      // created at 23:30 of the Sunday before (02:30 of the Monday in UTC): of the week before, not of this one
      await newStore(client, due, {
        createdOffset: -30 * MINUTE,
        sessions: once(DAY),
      });
      assert.deepEqual(await freezeWeek(client, due), [
        {
          never_returned_stores: 6,
          returned_stores: 9,
          week_start: dayOf(due),
        },
      ]);
    });
    tests.push(
      "controls, on a cohort cut to 7 who came back, 4 who did not and 4 left out: a founder who never came back with a co-owner who did counts as not back, a session from before the store touched only before it counts as not back, a store with no active owner joins the difference with the funnel (5) and a purged one counts nowhere; a store created at 22:30 of São Paulo and back at 00:30 counts as back, one created at 00:00 of the Monday is of that week, one created at 23:30 of the Sunday before is not: the week reads 9 and 6"
    );

    // 4. the suppression with the complement, and k itself
    for (const [drop, extra, expected, label] of [
      [{ back: 3 }, false, null, "4 who came back (7 who did not)"],
      [{ idle: 3 }, false, null, "4 who did not (7 who came back)"],
      [{ back: 2, idle: 2 }, false, [5, 5], "exactly 5 and 5 shows"],
      [
        { leftOut: 1 },
        true,
        null,
        "4 left out of the measure (and a purged store, which is not one of them)",
      ],
    ] as const) {
      await scenario(async (client, current) => {
        const due = at(current, -21 * DAY);
        await seedCohort(client, due, drop);
        if (extra) {
          await newStore(client, due, { ownerless: true, status: "purged" });
        }
        assert.deepEqual(
          await freezeWeek(client, due),
          expected
            ? [
                {
                  never_returned_stores: expected[1],
                  returned_stores: expected[0],
                  week_start: dayOf(due),
                },
              ]
            : hidden(due),
          label
        );
      });
    }
    tests.push(
      "suppression with the complement, k = 5: 4 who came back (7 who did not), 4 who did not (7 who came back), or 4 left out of the measure (the difference with the funnel, a purged store not counted in it) each freeze the week with both cells null; exactly 5 and 5 (with 5 left out) shows"
    );

    // 5. the frozen week does not follow the sessions; 7. a sweep that fails writes nothing
    await scenario(async (client, current) => {
      const due = at(current, -21 * DAY);
      await seedCohort(client, due);
      await client.query("SAVEPOINT failing_sweep");
      await freeze(client);
      await expectSqlState(
        () => client.query("SELECT 1 / 0"),
        "22012",
        "the sweep fails after the freezing"
      );
      await client.query("ROLLBACK TO SAVEPOINT failing_sweep");
      assert.deepEqual(
        await frozenWeek(client, due),
        [],
        "a failed sweep leaves the week without a row (unavailable, never 0)"
      );
      assert.deepEqual(await freezeWeek(client, due), [
        {
          never_returned_stores: 7,
          returned_stores: 7,
          week_start: dayOf(due),
        },
      ]);
      await client.query(
        `DELETE FROM public.session WHERE user_id IN (
           SELECT m.user_id FROM public.memberships AS m
             JOIN public.organizations AS o ON o.id = m.organization_id
            WHERE o.created_at >= $1 AND o.created_at < $2)`,
        [due, at(due, 7 * DAY)]
      );
      assert.deepEqual(await freeze(client), [], "nothing more to freeze");
      assert.deepEqual(await frozenWeek(client, due), [
        { cohort_week: dayOf(due), never_returned: 7, returned: 7 },
      ]);
    });
    tests.push(
      "a sweep whose transaction fails after the freezing leaves the week without a row (the reader shows it unavailable, never 0), and the next sweep freezes it; with every session of the cohort deleted afterwards, the next sweep writes nothing and the week still reads 7 and 7"
    );

    // 6. append-only and without identity
    const columns = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'activation_return_weeks' ORDER BY column_name COLLATE "C"`
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["cohort_week", "frozen_at", "never_returned", "returned"]
    );
    const triggers = await owner.pool.query<{
      enabled: string;
      name: string;
    }>(
      `SELECT tgname AS name, tgenabled::text AS enabled FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.activation_return_weeks'::regclass AND NOT tgisinternal ORDER BY tgname`
    );
    assert.deepEqual(triggers.rows, [
      { enabled: "A", name: "activation_return_weeks_no_change" },
      { enabled: "A", name: "activation_return_weeks_no_truncate" },
    ]);
    await scenario(async (client, current) => {
      const due = dayOf(at(current, -21 * DAY));
      const tuesday = dayOf(at(current, -20 * DAY));
      await client.query(
        "INSERT INTO public.activation_return_weeks (cohort_week, returned, never_returned) VALUES ($1, 5, 6)",
        [due]
      );
      for (const [statement, label] of [
        ["UPDATE public.activation_return_weeks SET returned = 7", "UPDATE"],
        ["DELETE FROM public.activation_return_weeks", "DELETE"],
        ["TRUNCATE public.activation_return_weeks", "TRUNCATE"],
      ] as const) {
        await client.query("SAVEPOINT append_only");
        await expectSqlState(
          () => client.query(statement),
          "23514",
          `${label} is refused to the owner of the table`
        );
        await client.query("ROLLBACK TO SAVEPOINT append_only");
      }
      for (const [values, label] of [
        [[tuesday, null, null], "a week that is not a Monday"],
        [[dayOf(at(current, -28 * DAY)), 4, 6], "a cell under k"],
        [[dayOf(at(current, -28 * DAY)), 5, null], "a lone cell"],
      ] as const) {
        await client.query("SAVEPOINT refused_row");
        await expectSqlState(
          () =>
            client.query(
              "INSERT INTO public.activation_return_weeks (cohort_week, returned, never_returned) VALUES ($1, $2, $3)",
              [...values]
            ),
          "23514",
          `${label} is refused`
        );
        await client.query("ROLLBACK TO SAVEPOINT refused_row");
      }
    });
    tests.push(
      "activation_return_weeks has only cohort_week, frozen_at, returned and never_returned (no store, person or ID); UPDATE, DELETE and TRUNCATE are refused to the owner of the table (23514) by triggers that fire ALWAYS; a week that is not a Monday, a cell under 5 and a lone cell are refused (23514)"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const [loginRole, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${loginRole}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Activation returns PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
