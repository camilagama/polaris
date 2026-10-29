import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  ACTIVATION_FUNNEL_MAX_WEEKS,
  readActivationFunnel,
} from "../src/admin-diagnostics-repository";
import { classifyOrganization } from "../src/admin-support-repository";
import { createDatabase } from "../src/client";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The activation funnel of the stores on a real PostgreSQL 18 (corte 2.4, PR A; ADR 0071 amended):
 *   1. who reaches what: only the Admin role runs `admin_read_activation_funnel` (the audited wrapper) and
 *      `admin_classify_organization`, and it cannot run the STABLE `admin_activation_funnel` itself; the tenant,
 *      billing and catalog roles run none of them nor read or write `platform_internal_organizations`; the Admin
 *      role still reads no table; the funnel takes only the number of weeks (1 to 26), is STABLE (it cannot write)
 *      and the owner reads no e-mail, name, amount or date of the business;
 *   2. the marker: marking and unmarking are audited in the same transaction, a call that changes nothing writes
 *      nothing, an unknown store and an inactive operator are refused, and the marker leaves with the organization;
 *   2b. the audited read: every call of the wrapper writes one `activation_funnel.read` event with the operator and
 *      nothing else (no store, no case, no detail, no number; the entity is a fixed name), a refused call writes none;
 *   3. a fixture written by hand (the expected figures are in this file): the bands of the time to the first sale by
 *      `confirmed_at` (a sale dated two years back and a cancelled one count), the week of Brasília at the border of
 *      Sunday and Monday, the product deleted, internal stores out, cohorts of 1, 4, 5 and 6 stores, the
 *      complementary suppression; marking a store moves the figures at the next read, and unmarking brings them back;
 *   4. the whole answer (every cohort of the 26 weeks, every store of every gate before this one) is the same as a
 *      direct count of the rows, computed apart in this file, and its format is closed;
 *   5. the suppression on cohorts drawn at random: no value under 5, no complement under 5, no difference of two
 *      nested counts under 5, the bands all or none; the same for the stores active in a calendar week, whose
 *      complement is the stores that existed and did not sell (a case built so that only the complement is small),
 *      and whose difference with the retention cells it contains (of the cohorts 1, 2 and 4 weeks older) is under
 *      5 in no answer;
 *   6. the cost with 1,000 stores and 50,000 sales (a rolled-back transaction): the time of the call and the plan of
 *      the query inside (auto_explain), printed as gate notes.
 * The fixtures write sale headers without items (`session_replication_role = replica`) and load auto_explain, so the
 * owner must be a superuser: the gate runs on the job's PostgreSQL only (`localOnly`).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const K = 5;
const ZONE = "America/Sao_Paulo";
const DAY = 86_400_000;
const issuer = "https://polaris-funnel-gate.cloudflareaccess.com";

type Cell =
  | { state: "shown"; value: number }
  | { state: "suppressed" }
  | { reason: string; state: "unavailable" };

interface Cohort {
  activatedIn7Days: Cell;
  inProgress: boolean;
  retention: { week2: Cell; week3: Cell; week5: Cell };
  stores: Cell;
  timeToFirstSale: {
    after7Days: Cell;
    upTo10Minutes: Cell;
    upTo1Day: Cell;
    upTo1Hour: Cell;
    upTo7Days: Cell;
  };
  week: string;
  weekStart: string;
  withFirstProduct: Cell;
  withFirstSale: Cell;
  withoutSale: Cell;
}

interface Signup {
  accounts: Cell;
  inProgress: boolean;
  week: string;
  weekStart: string;
  withStore: Cell;
}

interface ActiveWeek {
  inProgress: boolean;
  stores: Cell;
  week: string;
  weekStart: string;
}

interface Funnel {
  activeStores: ActiveWeek[];
  cohorts: Cohort[];
  generatedAt: string;
  internalStoresExcluded: number;
  k: number;
  signups: Signup[];
  timezone: string;
  weeks: number;
}

const EXECUTION_TIME = /duration: ([\d.]+) ms/;
/** The band of the time to the first sale: up to 10 minutes, 1 hour, 1 day, 7 days, later. */
const BAND_LIMITS = [600, 3600, 86_400, 604_800];
const bandOf = (seconds: number): 0 | 1 | 2 | 3 | 4 => {
  const band = BAND_LIMITS.findIndex((limit) => seconds <= limit);
  return (band === -1 ? 4 : band) as 0 | 1 | 2 | 3 | 4;
};

const shown = (value: number): Cell => ({ state: "shown", value });
const SUPPRESSED: Cell = { state: "suppressed" };
const unavailable = (reason: string): Cell => ({
  reason,
  state: "unavailable",
});

/** The cells of one cohort, counted apart from the function. */
interface Tally {
  b: number;
  c: [number, number, number, number, number];
  n: number;
  p0: number;
  p1: number;
  r2: number;
  r3: number;
  r5: number;
}

/**
 * The rule of the amendment, written again here from the corte and its conditions (not read from the
 * migration): the finest cut of the cohort whose cells all hold k stores or more.
 */
function tierOf(t: Tally, windowClosed: boolean): number {
  const a7 = t.c[0] + t.c[1] + t.c[2] + t.c[3];
  const all = (...cells: number[]) => cells.every((cell) => cell >= K);
  if (windowClosed && all(t.p0, t.p1, ...t.c)) {
    return 1;
  }
  if (windowClosed && all(t.p0, t.p1, a7, t.c[4])) {
    return 2;
  }
  if (all(t.p0, t.p1, t.b)) {
    return 3;
  }
  if (windowClosed && all(t.p0 + t.p1, a7, t.c[4])) {
    return 4;
  }
  if (all(t.p0 + t.p1, t.b)) {
    return 5;
  }
  if (all(t.p0, t.p1 + t.b)) {
    return 6;
  }
  return 7;
}

function expectedCohort(
  week: { label: string; start: string },
  t: Tally,
  clock: { currentWeek: string; localNow: number }
): Cohort {
  const start = Date.parse(`${week.start}T00:00:00Z`);
  const current = Date.parse(`${clock.currentWeek}T00:00:00Z`);
  const windowClosed = start + 14 * DAY <= clock.localNow;
  const tier = tierOf(t, windowClosed);
  const a7 = t.c[0] + t.c[1] + t.c[2] + t.c[3];
  const window = (cell: Cell) =>
    windowClosed ? cell : unavailable("activation_window_open");
  const band = (value: number) =>
    window(tier === 1 ? shown(value) : SUPPRESSED);
  const retention = (weekNumber: number, value: number) => {
    if (start + weekNumber * 7 * DAY > current) {
      return unavailable("week_not_closed");
    }
    return value >= K && t.b - value >= K ? shown(value) : SUPPRESSED;
  };
  return {
    activatedIn7Days: window([1, 2, 4].includes(tier) ? shown(a7) : SUPPRESSED),
    inProgress: week.start === clock.currentWeek,
    retention: {
      week2: retention(2, t.r2),
      week3: retention(3, t.r3),
      week5: retention(5, t.r5),
    },
    stores: t.n >= K ? shown(t.n) : SUPPRESSED,
    timeToFirstSale: {
      after7Days: band(t.c[4]),
      upTo1Day: band(t.c[2]),
      upTo1Hour: band(t.c[1]),
      upTo7Days: band(t.c[3]),
      upTo10Minutes: band(t.c[0]),
    },
    week: week.label,
    weekStart: week.start,
    withFirstProduct: [1, 2, 3, 6].includes(tier)
      ? shown(t.n - t.p0)
      : SUPPRESSED,
    withFirstSale: tier <= 5 ? shown(t.b) : SUPPRESSED,
    withoutSale: tier <= 5 ? shown(t.p0 + t.p1) : SUPPRESSED,
  };
}

const shownValue = (cell: Cell): number | null =>
  cell.state === "shown" ? cell.value : null;

/** What no answer may ever show, whatever the rows (conditions 1 to 3). */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one list of independent checks per cohort
function suppressionProblems(funnel: Funnel): string[] {
  const problems: string[] = [];
  for (const cohort of funnel.cohorts) {
    const bands = Object.values(cohort.timeToFirstSale);
    const cells = [
      cohort.stores,
      cohort.withFirstProduct,
      cohort.withFirstSale,
      cohort.withoutSale,
      cohort.activatedIn7Days,
      ...bands,
      ...Object.values(cohort.retention),
    ];
    for (const cell of cells) {
      const value = shownValue(cell);
      if (value !== null && value < K) {
        problems.push(`${cohort.week}: a value under k (${value})`);
      }
    }
    const n = shownValue(cohort.stores);
    const a = shownValue(cohort.withFirstProduct);
    const b = shownValue(cohort.withFirstSale);
    const a7 = shownValue(cohort.activatedIn7Days);
    // nested counts: each difference is a set of stores too
    const nested: [string, number | null, number | null][] = [
      ["stores - withFirstProduct", n, a],
      ["stores - withFirstSale", n, b],
      ["stores - activatedIn7Days", n, a7],
      ["withFirstProduct - withFirstSale", a, b],
      ["withFirstProduct - activatedIn7Days", a, a7],
      ["withFirstSale - activatedIn7Days", b, a7],
      ...Object.entries(cohort.retention).map(
        ([week, cell]) =>
          [`withFirstSale - ${week}`, b, shownValue(cell)] as [
            string,
            number | null,
            number | null,
          ]
      ),
    ];
    for (const [label, outer, inner] of nested) {
      if (outer !== null && inner !== null && outer - inner < K) {
        problems.push(`${cohort.week}: ${label} = ${outer - inner}`);
      }
    }
    const shownBands = bands.filter((cell) => cell.state === "shown").length;
    if (shownBands !== 0 && shownBands !== bands.length) {
      problems.push(`${cohort.week}: some bands shown and some not`);
    }
    if (
      shownBands === bands.length &&
      bands.reduce((sum, cell) => sum + (shownValue(cell) ?? 0), 0) !== b
    ) {
      problems.push(`${cohort.week}: the bands do not add up to the sales`);
    }
  }
  for (const week of funnel.activeStores) {
    const value = shownValue(week.stores);
    if (value !== null && value < K) {
      problems.push(
        `${week.week}: a count of active stores under k (${value})`
      );
    }
    if (week.inProgress && week.stores.state !== "unavailable") {
      problems.push(`${week.week}: the current week shows a count`);
    }
    // the retention cells shown for the cohorts 1, 2 and 4 weeks older are inside this week: no difference under k
    if (value !== null) {
      const start = Date.parse(`${week.weekStart}T00:00:00Z`);
      for (const [lag, key] of [
        [1, "week2"],
        [2, "week3"],
        [4, "week5"],
      ] as const) {
        const older = funnel.cohorts.find(
          (row) =>
            Date.parse(`${row.weekStart}T00:00:00Z`) === start - lag * 7 * DAY
        );
        const inside = older ? shownValue(older.retention[key]) : null;
        if (inside !== null && value - inside < K) {
          problems.push(
            `${week.week}: active stores - ${key} of the older cohort = ${value - inside}`
          );
        }
      }
    }
  }
  for (const signup of funnel.signups) {
    const u = shownValue(signup.accounts);
    const s = shownValue(signup.withStore);
    if ((u !== null && u < K) || (s !== null && s < K)) {
      problems.push(`${signup.week}: a sign-up count under k`);
    }
    if (u !== null && s !== null && u - s < K) {
      problems.push(`${signup.week}: accounts - withStore = ${u - s}`);
    }
  }
  return problems;
}

/** A small deterministic generator (Park-Miller), so a failing draw can be replayed from its seed. */
function generator(seed: number) {
  let state = (seed % 2_147_483_646) + 1;
  return (below: number) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % below;
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gate is one linear list of independent scenarios
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
  const notes: string[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
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

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_funnel_admin"
    );
    const others = [
      ["tenant", await login(runtimeRole, "polaris_funnel_tenant")],
      [
        "billing",
        await login("polaris_billing_runtime", "polaris_funnel_billing"),
      ],
      [
        "catalog",
        await login("polaris_catalog_runtime", "polaris_funnel_catalog"),
      ],
    ] as const;
    const connect = async <T>(
      url: string,
      operation: (client: Client) => Promise<T>
    ) => {
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
    const asAdmin = <T>(operation: (client: Client) => Promise<T>) =>
      connect(adminLoginUrl, operation);
    const principals = await owner.pool.query<{ id: string }>(
      `INSERT INTO public.platform_principals (issuer, subject, role, status)
       VALUES ($1, $2, 'platform_owner', 'active'), ($1, $3, 'platform_owner', 'disabled')
       RETURNING id`,
      [issuer, `funnel-${randomUUID()}`, `funnel-${randomUUID()}`]
    );
    const [operator, disabled] = principals.rows.map((row) => row.id) as [
      string,
      string,
    ];
    /** The answer and the database's clock of the same transaction (the same now()). */
    const read = (weeks = ACTIVATION_FUNNEL_MAX_WEEKS) =>
      asAdmin(async (client) => {
        await client.query("BEGIN");
        try {
          const clock = await client.query<{
            current_week: string;
            local_now: string;
          }>(
            `SELECT to_char(date_trunc('week', now() AT TIME ZONE '${ZONE}'), 'YYYY-MM-DD') AS current_week,
                    to_char(now() AT TIME ZONE '${ZONE}', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS local_now`
          );
          const funnel = (await readActivationFunnel(
            client,
            operator,
            weeks
          )) as Funnel;
          return {
            clock: {
              currentWeek: clock.rows[0]?.current_week as string,
              localNow: Date.parse(`${clock.rows[0]?.local_now}Z`),
            },
            funnel,
          };
        } finally {
          await client.query("COMMIT");
        }
      });

    // the fixtures write sale headers without their items (session_replication_role), which needs a superuser:
    // the job's own PostgreSQL (the runner never sends this gate to Neon)
    const superuser = await owner.pool.query<{ allowed: boolean }>(
      "SELECT rolsuper AS allowed FROM pg_roles WHERE rolname = current_user"
    );
    assert.equal(superuser.rows[0]?.allowed, true, "the owner is a superuser");

    // ------------------------------------------------- 1. who reaches what
    for (const [label, url] of others) {
      for (const statement of [
        "SELECT public.admin_activation_funnel(4)",
        "SELECT public.admin_read_activation_funnel(gen_random_uuid(), 4)",
        "SELECT public.admin_classify_organization(gen_random_uuid(), 'x', true)",
        "SELECT 1 FROM public.platform_internal_organizations",
        "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ('x')",
        "DELETE FROM public.platform_internal_organizations",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
        await expectSqlState(
          () => connect(url, (client) => client.query(statement)),
          "42501",
          `the ${label} role is refused: ${statement}`
        );
      }
    }
    await expectSqlState(
      () =>
        asAdmin((client) =>
          client.query("SELECT public.admin_activation_funnel(4)")
        ),
      "42501",
      "the Admin role cannot run the aggregate function itself, only the audited wrapper"
    );
    for (const statement of [
      "SELECT 1 FROM public.platform_internal_organizations",
      "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ('x')",
      'SELECT created_at FROM public."user"',
      "SELECT confirmed_at FROM public.sales",
      "SELECT created_at FROM public.organizations",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () => asAdmin((client) => client.query(statement)),
        "42501",
        `the Admin role still reads and writes no table: ${statement}`
      );
    }
    const marker = await owner.pool.query<{
      forced: boolean;
      reach: string[];
      rls: boolean;
    }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              ARRAY(SELECT r.rolname::text FROM pg_roles AS r
                     WHERE r.rolname LIKE 'polaris%'
                       AND (has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                            OR has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
                     ORDER BY 1) AS reach
         FROM pg_class AS c WHERE c.oid = 'public.platform_internal_organizations'::regclass`
    );
    assert.deepEqual(marker.rows, [
      { forced: true, reach: ["polaris_admin_owner"], rls: true },
    ]);
    const publicReach = await owner.pool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('public', 'public.platform_internal_organizations', 'SELECT,INSERT,UPDATE,DELETE') AS allowed"
    );
    assert.deepEqual(publicReach.rows, [{ allowed: false }]);
    const functions = await owner.pool.query<{
      arguments: string;
      config: string;
      name: string;
      owner: string;
      public_execute: boolean;
      definer: boolean;
      volatility: string;
    }>(
      `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.provolatile::text AS volatility,
              array_to_string(p.proconfig, ',') AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc AS p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('admin_activation_funnel', 'admin_classify_organization', 'admin_read_activation_funnel')
        ORDER BY 1`
    );
    assert.deepEqual(functions.rows, [
      {
        arguments: "p_weeks integer",
        config: "search_path=pg_catalog, public, pg_temp",
        definer: true,
        name: "admin_activation_funnel",
        owner: "polaris_admin_owner",
        public_execute: false,
        volatility: "s",
      },
      {
        arguments: "p_principal uuid, p_organization text, p_internal boolean",
        config: "search_path=pg_catalog, public, pg_temp",
        definer: true,
        name: "admin_classify_organization",
        owner: "polaris_admin_owner",
        public_execute: false,
        volatility: "v",
      },
      {
        arguments: "p_principal uuid, p_weeks integer",
        config: "search_path=pg_catalog, public, pg_temp",
        definer: true,
        name: "admin_read_activation_funnel",
        owner: "polaris_admin_owner",
        public_execute: false,
        volatility: "v",
      },
    ]);
    // the owner reads the date and link columns the funnel needs, and none of the others of these tables
    const ownerColumns = await owner.pool.query<{ grant: string }>(
      `SELECT table_name || '.' || column_name AS grant
         FROM information_schema.column_privileges
        WHERE grantee = 'polaris_admin_owner' AND privilege_type = 'SELECT'
          AND table_schema = 'public' AND table_name IN ('user', 'sales')
        ORDER BY 1`
    );
    assert.deepEqual(
      ownerColumns.rows.map((row) => row.grant),
      [
        "sales.confirmed_at",
        "sales.organization_id",
        "user.created_at",
        "user.email_verified",
        "user.id",
      ]
    );
    for (const weeks of [0, -1, ACTIVATION_FUNNEL_MAX_WEEKS + 1]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query("SELECT public.admin_read_activation_funnel($1, $2)", [
              operator,
              weeks,
            ])
          ),
        "22023",
        `${weeks} weeks is refused`
      );
    }
    await expectSqlState(
      () =>
        asAdmin((client) =>
          client.query("SELECT public.admin_read_activation_funnel($1, NULL)", [
            operator,
          ])
        ),
      "22023",
      "no number of weeks is refused"
    );
    await expectSqlState(
      () => owner.pool.query("SELECT public.admin_activation_funnel(27)"),
      "22023",
      "the aggregate function refuses it too"
    );
    // nothing is kept: the migration made one table, the marker, and the function cannot write (STABLE)
    const migration = readFileSync(
      new URL("../drizzle/0105_funil_de_ativacao.sql", import.meta.url),
      "utf8"
    );
    assert.deepEqual(migration.match(/CREATE TABLE "[a-z_]+"/g), [
      'CREATE TABLE "platform_internal_organizations"',
    ]);
    const one = await read(1);
    assert.equal(one.funnel.cohorts.length, 1);
    assert.equal(one.funnel.signups.length, 1);
    tests.push(
      "only the Admin role runs the audited read of the funnel and the marker command (tenant, billing, catalog and PUBLIC cannot, and not even the Admin role runs the aggregate function itself), nobody but the Admin owner reaches the marker table (forced row security), the Admin role still reads no table, the three functions are SECURITY DEFINER of polaris_admin_owner with search_path ending in pg_temp, the funnel takes only the number of weeks (1 to 26, anything else 22023), is STABLE and keeps nothing (the wrapper is VOLATILE), and the owner reads only sales.confirmed_at, sales.organization_id, user.created_at, user.email_verified and user.id there"
    );

    // ------------------------------------------------- 2. the marker command
    const bare = randomUUID();
    await owner.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Gate funil marcador', 'America/Sao_Paulo')",
      [bare]
    );
    const classify = (
      principal: string,
      organization: string,
      internal: boolean
    ) =>
      asAdmin((client) =>
        classifyOrganization(client, principal, organization, internal)
      );
    const audit = async () =>
      (
        await owner.pool.query<{
          detail: string | null;
          entity_id: string;
          entity_type: string;
          event_type: string;
          principal_id: string;
          support_case_id: string | null;
        }>(
          "SELECT event_type, principal_id, support_case_id, entity_type, entity_id, detail FROM public.platform_audit_events WHERE organization_id = $1 ORDER BY id",
          [bare]
        )
      ).rows;
    const markedRow = async () =>
      (
        await owner.pool.query<{ marked_by: string | null }>(
          "SELECT marked_by FROM public.platform_internal_organizations WHERE organization_id = $1",
          [bare]
        )
      ).rows;
    assert.deepEqual(await classify(operator, bare, true), {
      changed: true,
      internal: true,
    });
    assert.deepEqual(await markedRow(), [{ marked_by: operator }]);
    assert.deepEqual(await classify(operator, bare, true), {
      changed: false,
      internal: true,
    });
    assert.deepEqual(await classify(operator, bare, false), {
      changed: true,
      internal: false,
    });
    assert.deepEqual(await markedRow(), []);
    assert.deepEqual(await classify(operator, bare, false), {
      changed: false,
      internal: false,
    });
    const event = (type: string) => ({
      detail: null,
      entity_id: bare,
      entity_type: "organization",
      event_type: type,
      principal_id: operator,
      support_case_id: null,
    });
    assert.deepEqual(await audit(), [
      event("organization.marked_internal"),
      event("organization.unmarked_internal"),
    ]);
    for (const [principal, organization, code] of [
      [disabled, bare, "42501"],
      [randomUUID(), bare, "42501"],
      [operator, `nope-${randomUUID()}`, "22023"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              "SELECT public.admin_classify_organization($1, $2, true)",
              [principal, organization]
            )
          ),
        code,
        `classify refused (${code})`
      );
    }
    await expectSqlState(
      () =>
        asAdmin((client) =>
          client.query(
            "SELECT public.admin_classify_organization($1, $2, NULL)",
            [operator, bare]
          )
        ),
      "22023",
      "a classification that is neither true nor false"
    );
    assert.equal((await audit()).length, 2, "a refusal writes no audit");
    await classify(operator, bare, true);
    await owner.pool.query("DELETE FROM public.organizations WHERE id = $1", [
      bare,
    ]);
    assert.deepEqual(await markedRow(), [], "the marker left with the store");
    // the platform audit allows exactly the list of 0100 plus the two of the marker and the read of the funnel
    const constraint = await owner.pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'platform_audit_events_type_allowed'"
    );
    const typesOf = (text: string) =>
      [...text.matchAll(/'([a-z_]+\.[a-z_]+)'/g)]
        .map((match) => match[1] as string)
        .sort();
    const line0100 =
      readFileSync(
        new URL(
          "../drizzle/0100_autosservico_de_cobranca.sql",
          import.meta.url
        ),
        "utf8"
      )
        .split("\n")
        .find((line) =>
          line.includes('ADD CONSTRAINT "platform_audit_events_type_allowed"')
        ) ?? "";
    assert.deepEqual(
      typesOf(constraint.rows[0]?.definition ?? ""),
      [
        ...typesOf(line0100),
        "organization.marked_internal",
        "organization.unmarked_internal",
        "activation_funnel.read",
      ].sort()
    );
    tests.push(
      "an active operator marks and unmarks a store, each change audited in the same transaction (operator, store, no case, no detail) and a repeated call changes and writes nothing; an inactive or unknown operator (42501), an unknown store and a null choice (22023) are refused with no audit; the marker leaves with the organization (cascade); the audit check is the list of 0100 plus the two types of the marker and the read of the funnel"
    );

    // ------------------------------------------------- 2b. the audited read
    const readEvents = async () =>
      (
        await owner.pool.query<Record<string, unknown>>(
          `SELECT actor, detail, entity_id, entity_type, event_type, organization_id, principal_id, support_case_id
             FROM public.platform_audit_events WHERE event_type = 'activation_funnel.read' ORDER BY id`
        )
      ).rows;
    const eventsBefore = (await readEvents()).length;
    for (const [index, weeks] of [
      1,
      4,
      ACTIVATION_FUNNEL_MAX_WEEKS,
    ].entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: Calls, in order.
      await read(weeks);
      assert.equal(
        (await readEvents()).length,
        eventsBefore + index + 1,
        "each read writes exactly one event"
      );
    }
    assert.deepEqual(
      (await readEvents()).slice(eventsBefore),
      Array.from({ length: 3 }, () => ({
        actor: "principal",
        detail: null,
        entity_id: null,
        entity_type: "activation_funnel",
        event_type: "activation_funnel.read",
        organization_id: null,
        principal_id: operator,
        support_case_id: null,
      })),
      "the event holds the operator and the kind, with no store, no case, no detail and no number, and the fixed name of the entity"
    );
    for (const [principal, weeks, code] of [
      [disabled, 4, "42501"],
      [randomUUID(), 4, "42501"],
      [operator, 0, "22023"],
      [operator, ACTIVATION_FUNNEL_MAX_WEEKS + 1, "22023"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query("SELECT public.admin_read_activation_funnel($1, $2)", [
              principal,
              weeks,
            ])
          ),
        code,
        `the read is refused (${code})`
      );
    }
    assert.equal(
      (await readEvents()).length,
      eventsBefore + 3,
      "a refused read writes no event"
    );
    tests.push(
      "every call of the audited read writes exactly one activation_funnel.read event, in the same transaction as the read, holding only the operator and the kind (no store, case, detail or number, not even the weeks); an inactive or unknown operator (42501) and weeks out of 1 to 26 (22023) are refused and write none"
    );

    // ------------------------------------------------- 3. the fixture written by hand
    // weeks far enough back for every week of retention to be closed, where no other gate creates stores or users
    // and the cuts 2, 3, 4 and 6 and the borders of the bands each in a week of its own; one cohort in the last week,
    // whose 7 days are not over yet
    const WEEKS = {
      a: 16,
      b: 15,
      borders: 12,
      c: 14,
      cut2: 11,
      cut3: 10,
      cut4: 9,
      cut6: 8,
      d: 13,
      e: 17,
      f: 18,
      open: 1,
    } as const;
    const fixtureRange = await owner.pool.query<{
      stores: string[];
      users: number;
    }>(
      `WITH bounds AS (
         SELECT (date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '18 weeks') AT TIME ZONE '${ZONE}' AS since,
                (date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '7 weeks') AT TIME ZONE '${ZONE}' AS users_until,
                date_trunc('week', now() AT TIME ZONE '${ZONE}') AT TIME ZONE '${ZONE}' AS stores_until
       )
       SELECT ARRAY(SELECT o.id FROM public.organizations AS o, bounds
                     WHERE o.created_at >= bounds.since AND o.created_at < bounds.stores_until) AS stores,
              (SELECT count(*)::int FROM public."user" AS u, bounds
                WHERE u.created_at >= bounds.since AND u.created_at < bounds.users_until) AS users`
    );
    // a store of another gate in these weeks is kept out the way the funnel allows: marked as internal
    const strangers = fixtureRange.rows[0]?.stores ?? [];
    await owner.pool.query(
      "INSERT INTO public.platform_internal_organizations (organization_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
      [strangers]
    );
    assert.equal(
      fixtureRange.rows[0]?.users,
      0,
      "no other gate created a user in the weeks of the fixture"
    );
    if (strangers.length > 0) {
      notes.push(
        `${strangers.length} stores of other gates in the weeks of the fixture, marked as internal`
      );
    }

    interface StoreSpec {
      /** The first sale is cancelled afterwards (it still counts). */
      cancelled?: boolean;
      /** When the store (and its owner) were created, from the Monday 00:00 of the cohort. */
      created: string;
      internal?: boolean;
      /** The first sale is dated two years back (`occurred_at`): the funnel reads `confirmed_at`. */
      oldBusinessDate?: boolean;
      product?: "deleted" | "live" | "none";
      /** Offsets from the Monday 00:00 (Brasília) of the cohort, for each confirmed sale. */
      sales?: string[];
    }
    const weekStart = (weeksAgo: number) =>
      `(date_trunc('week', now() AT TIME ZONE '${ZONE}') - ${weeksAgo} * interval '7 days')`;
    const fixtureStores: Record<string, string[]> = {};
    const createStore = async (weeksAgo: number, spec: StoreSpec) => {
      const organizationId = randomUUID();
      const userId = randomUUID();
      const at = `(${weekStart(weeksAgo)} + $3::interval) AT TIME ZONE '${ZONE}'`;
      await owner.pool.query(
        `INSERT INTO public."user" (id, name, email, email_verified, created_at) VALUES ($1, 'Gate funil', $2, true, ${at})`,
        [userId, `funnel-${userId}@example.invalid`, spec.created]
      );
      await owner.pool.query(
        `INSERT INTO public.organizations (id, name, timezone, created_at) VALUES ($1, $2, '${ZONE}', ${at})`,
        [organizationId, "Gate funil", spec.created]
      );
      await owner.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [organizationId, userId]
      );
      if (spec.product && spec.product !== "none") {
        await owner.pool.query(
          `WITH created AS (
             INSERT INTO public.products (organization_id, name, deleted_at) VALUES ($1, 'Produto do funil', $2)
             RETURNING id, organization_id
           )
           INSERT INTO public.product_variants (organization_id, product_id, is_default)
           SELECT organization_id, id, true FROM created`,
          [organizationId, spec.product === "deleted" ? new Date() : null]
        );
      }
      if (spec.sales?.length) {
        // only the headers: the funnel reads `sales` alone, and the triggers that check a confirmed sale against its
        // items, payments and stock are skipped for this insert (a superuser of the job's database only)
        const client = await owner.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL session_replication_role = replica");
          const sales = await client.query<{ id: string }>(
            `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, confirmed_at)
             SELECT $1, gen_random_uuid(), x.occurred, (x.occurred AT TIME ZONE '${ZONE}')::date, 1, 0, x.confirmed
               FROM (
                 SELECT (${weekStart(weeksAgo)} + o.offset_text::interval) AT TIME ZONE '${ZONE}' AS confirmed,
                        CASE WHEN $3 AND o.position = 1
                          THEN (${weekStart(weeksAgo)} + o.offset_text::interval - interval '2 years') AT TIME ZONE '${ZONE}'
                          ELSE (${weekStart(weeksAgo)} + o.offset_text::interval) AT TIME ZONE '${ZONE}' END AS occurred,
                        o.position
                   FROM unnest($2::text[]) WITH ORDINALITY AS o(offset_text, position)
               ) AS x
             ORDER BY x.position
             RETURNING id`,
            [organizationId, spec.sales, spec.oldBusinessDate === true]
          );
          if (spec.cancelled) {
            await client.query(
              "INSERT INTO public.sale_cancellations (organization_id, sale_id, command_id, cancelled_by) VALUES ($1, $2, gen_random_uuid(), $3)",
              [organizationId, sales.rows[0]?.id, userId]
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      if (spec.internal) {
        await owner.pool.query(
          "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ($1)",
          [organizationId]
        );
      }
      const key = String(weeksAgo);
      fixtureStores[key] = [...(fixtureStores[key] ?? []), organizationId];
      return organizationId;
    };
    const times = <T>(count: number, make: (index: number) => T) =>
      Array.from({ length: count }, (_, index) => make(index));
    // every store of cohort A is created on Wednesday 10:00 (Brasília); the week is Monday to Sunday
    const WEDNESDAY = "2 days 10 hours";
    const at = (offset: string) => offset;
    // cohort A, 35 stores counted and 2 internal ones: 5 in each of the seven cells
    const a: Promise<string>[] = [
      // no product and no sale
      ...times(5, () => createStore(WEEKS.a, { created: WEDNESDAY })),
      // a product (one deleted: it still counts) and no sale
      ...times(5, (index) =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          product: index === 0 ? "deleted" : "live",
        })
      ),
      // up to 10 minutes: one dated two years back, one cancelled; all sell again in week 3
      ...times(5, (index) =>
        createStore(WEEKS.a, {
          cancelled: index === 1,
          created: WEDNESDAY,
          oldBusinessDate: index === 0,
          product: "live",
          sales: [at("2 days 10 hours 5 minutes"), at("15 days 12 hours")],
        })
      ),
      // up to 1 hour; 3 of them sell again in week 5 (3 is under k: retention of week 5 is suppressed)
      ...times(5, (index) =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          product: "live",
          sales:
            index < 3
              ? [at("2 days 10 hours 30 minutes"), at("30 days 12 hours")]
              : [at("2 days 10 hours 30 minutes")],
        })
      ),
      // up to 1 day; each sells again on Sunday 22:00 of Brasília (Monday 01:00 UTC): still week 1
      ...times(5, () =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          product: "live",
          sales: [at("2 days 15 hours"), at("6 days 22 hours")],
        })
      ),
      // up to 7 days: first on Sunday 23:30 (Brasília), then on Monday 09:00: week 2
      ...times(5, () =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          product: "live",
          sales: [at("6 days 23 hours 30 minutes"), at("7 days 9 hours")],
        })
      ),
      // later than 7 days, in week 2
      ...times(5, () =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          product: "live",
          sales: [at("12 days 10 hours")],
        })
      ),
      // internal: never counted, whatever they do
      ...times(2, () =>
        createStore(WEEKS.a, {
          created: WEDNESDAY,
          internal: true,
          product: "live",
          sales: [at("2 days 10 hours 1 minute"), at("8 days")],
        })
      ),
    ];
    const cohortA = await Promise.all(a);
    // cohort A's week also has 5 verified accounts with no store, and 3 not verified (never counted)
    for (const [index, verified] of [
      ...times(5, () => true),
      ...times(3, () => false),
    ].entries()) {
      const userId = randomUUID();
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await owner.pool.query(
        `INSERT INTO public."user" (id, name, email, email_verified, created_at)
         VALUES ($1, 'Gate funil', $2, $3, (${weekStart(WEEKS.a)} + interval '1 day' + $4 * interval '1 minute') AT TIME ZONE '${ZONE}')`,
        [userId, `funnel-${userId}@example.invalid`, verified, index]
      );
    }
    // cohort B, 4 stores, all sold in 5 minutes: nothing shows, not even how many
    for (const _ of times(4, () => 0)) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await createStore(WEEKS.b, {
        created: "1 day",
        product: "live",
        sales: ["1 day 5 minutes"],
      });
    }
    // cohort C, 6 stores, all sold: the count shows, and nothing else (every cell is 0 or the whole cohort)
    for (const _ of times(6, () => 0)) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await createStore(WEEKS.c, {
        created: "1 day",
        product: "live",
        sales: ["1 day 5 minutes"],
      });
    }
    // cohort D, 12 stores: 5 with nothing, 2 with a product only, 5 sold in 5 minutes
    for (const spec of [
      ...times(5, () => ({ created: "3 days" })),
      ...times(2, () => ({ created: "3 days", product: "live" as const })),
      ...times(5, () => ({
        created: "3 days",
        product: "live" as const,
        sales: ["3 days 5 minutes"],
      })),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await createStore(WEEKS.d, spec);
    }
    // cohort E, 5 stores with nothing; cohort F, 1 store that sold
    for (const _ of times(5, () => 0)) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await createStore(WEEKS.e, { created: "4 days" });
    }
    await createStore(WEEKS.f, {
      created: "5 days",
      product: "live",
      sales: ["5 days 1 minute"],
    });

    // one cohort for each cut the hand fixtures above do not reach (cells: no product, product and no sale, bands)
    const cohortOf = async (
      weeksAgo: number,
      cells: { p0: number; p1: number; bands: number[] }
    ) => {
      const minutes = [5, 30, 300, 4320, 14_400];
      for (const _ of times(cells.p0, () => 0)) {
        // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
        await createStore(weeksAgo, { created: "10 hours" });
      }
      for (const _ of times(cells.p1, () => 0)) {
        // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
        await createStore(weeksAgo, { created: "10 hours", product: "live" });
      }
      for (const [band, count] of cells.bands.entries()) {
        for (const _ of times(count, () => 0)) {
          // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
          await createStore(weeksAgo, {
            created: "10 hours",
            product: "live",
            sales: [`${600 + (minutes[band] as number)} minutes`],
          });
        }
      }
    };
    // cut 2: a band of 2 and one of 3 hide the bands, and 5 activated and 5 later still show
    await cohortOf(WEEKS.cut2, { bands: [2, 3, 0, 0, 5], p0: 5, p1: 5 });
    // cut 3: no store sold later than 7 days, so the activation (all who sold) hides with the bands
    await cohortOf(WEEKS.cut3, { bands: [5, 0, 0, 0, 0], p0: 5, p1: 5 });
    // cut 4: 3 with nothing and 2 with a product only hide the product, and the rest shows
    await cohortOf(WEEKS.cut4, { bands: [5, 0, 0, 0, 5], p0: 3, p1: 2 });
    // cut 6: 3 with a product only and 2 that sold hide the sale; only the product shows
    await cohortOf(WEEKS.cut6, { bands: [2, 0, 0, 0, 0], p0: 5, p1: 3 });
    // the borders of the bands are inclusive: exactly 10 minutes, 1 hour, 1 day and 7 days, and 7 days and 1 second
    for (const seconds of [600, 3600, 86_400, 604_800, 604_801]) {
      for (const _ of times(5, () => 0)) {
        // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
        await createStore(WEEKS.borders, {
          created: "36000 seconds",
          product: "live",
          sales: [`${36_000 + seconds} seconds`],
        });
      }
    }
    await cohortOf(WEEKS.borders, { bands: [], p0: 5, p1: 5 });
    // the last week: 5 with nothing, 5 with a product only, 5 sold; the 7 days of its stores are not over
    await cohortOf(WEEKS.open, { bands: [5, 0, 0, 0, 0], p0: 5, p1: 5 });

    const byWeek = (
      source: Funnel,
      weeksAgo: number,
      clock: { currentWeek: string }
    ) => {
      const start = new Date(
        Date.parse(`${clock.currentWeek}T00:00:00Z`) - weeksAgo * 7 * DAY
      )
        .toISOString()
        .slice(0, 10);
      const cohort = source.cohorts.find((row) => row.weekStart === start);
      const signup = source.signups.find((row) => row.weekStart === start);
      const active = source.activeStores.find((row) => row.weekStart === start);
      assert.ok(
        cohort && signup && active,
        `the week ${start} is in the answer`
      );
      return { active, cohort, signup };
    };
    const fixture = await read();
    const A = byWeek(fixture.funnel, WEEKS.a, fixture.clock);
    const five = shown(5);
    assert.deepEqual(
      { ...A.cohort, week: "", weekStart: "" },
      {
        activatedIn7Days: shown(20),
        inProgress: false,
        retention: { week2: shown(10), week3: shown(5), week5: SUPPRESSED },
        stores: shown(35),
        timeToFirstSale: {
          after7Days: five,
          upTo1Day: five,
          upTo1Hour: five,
          upTo7Days: five,
          upTo10Minutes: five,
        },
        week: "",
        weekStart: "",
        withFirstProduct: shown(30),
        withFirstSale: shown(25),
        withoutSale: shown(10),
      },
      "cohort A, counted by hand"
    );
    // 37 owners (2 of internal stores: sign-ups have no marker) and 5 accounts with no store; 3 not verified are out
    assert.deepEqual(
      { accounts: A.signup.accounts, withStore: A.signup.withStore },
      { accounts: shown(42), withStore: shown(37) }
    );
    const nothing = {
      activatedIn7Days: SUPPRESSED,
      retention: { week2: SUPPRESSED, week3: SUPPRESSED, week5: SUPPRESSED },
      timeToFirstSale: {
        after7Days: SUPPRESSED,
        upTo1Day: SUPPRESSED,
        upTo1Hour: SUPPRESSED,
        upTo7Days: SUPPRESSED,
        upTo10Minutes: SUPPRESSED,
      },
      withFirstProduct: SUPPRESSED,
      withFirstSale: SUPPRESSED,
      withoutSale: SUPPRESSED,
    };
    const activity = (cohort: Cohort) => ({
      activatedIn7Days: cohort.activatedIn7Days,
      retention: cohort.retention,
      timeToFirstSale: cohort.timeToFirstSale,
      withFirstProduct: cohort.withFirstProduct,
      withFirstSale: cohort.withFirstSale,
      withoutSale: cohort.withoutSale,
    });
    for (const [weeksAgo, stores] of [
      [WEEKS.f, SUPPRESSED],
      [WEEKS.b, SUPPRESSED],
      [WEEKS.e, five],
      [WEEKS.c, shown(6)],
    ] as const) {
      const { cohort, signup } = byWeek(
        fixture.funnel,
        weeksAgo,
        fixture.clock
      );
      assert.deepEqual(cohort.stores, stores, `${weeksAgo} weeks ago: stores`);
      assert.deepEqual(activity(cohort), nothing, `${weeksAgo} weeks ago`);
      assert.deepEqual(signup.withStore, SUPPRESSED);
    }
    // cohort D: product without sale is 2, so the product is hidden and the sale shows (complementary suppression)
    const D = byWeek(fixture.funnel, WEEKS.d, fixture.clock).cohort;
    assert.deepEqual(
      { stores: D.stores, ...activity(D) },
      {
        ...nothing,
        stores: shown(12),
        withFirstSale: five,
        withoutSale: shown(7),
      }
    );
    const bandsOf = (cell: Cell) => ({
      after7Days: cell,
      upTo1Day: cell,
      upTo1Hour: cell,
      upTo7Days: cell,
      upTo10Minutes: cell,
    });
    const cohortAt = (weeksAgo: number) => {
      const { cohort } = byWeek(fixture.funnel, weeksAgo, fixture.clock);
      return { stores: cohort.stores, ...activity(cohort) };
    };
    const closedRetention = (week2: Cell) => ({
      week2,
      week3: SUPPRESSED,
      week5: SUPPRESSED,
    });
    assert.deepEqual(
      cohortAt(WEEKS.cut2),
      {
        activatedIn7Days: five,
        retention: closedRetention(five),
        stores: shown(20),
        timeToFirstSale: bandsOf(SUPPRESSED),
        withFirstProduct: shown(15),
        withFirstSale: shown(10),
        withoutSale: shown(10),
      },
      "cut 2"
    );
    assert.deepEqual(
      cohortAt(WEEKS.cut3),
      {
        activatedIn7Days: SUPPRESSED,
        retention: closedRetention(SUPPRESSED),
        stores: shown(15),
        timeToFirstSale: bandsOf(SUPPRESSED),
        withFirstProduct: shown(10),
        withFirstSale: five,
        withoutSale: shown(10),
      },
      "cut 3"
    );
    assert.deepEqual(
      cohortAt(WEEKS.cut4),
      {
        activatedIn7Days: five,
        retention: closedRetention(five),
        stores: shown(15),
        timeToFirstSale: bandsOf(SUPPRESSED),
        withFirstProduct: SUPPRESSED,
        withFirstSale: shown(10),
        withoutSale: five,
      },
      "cut 4"
    );
    assert.deepEqual(
      cohortAt(WEEKS.cut6),
      { ...nothing, stores: shown(10), withFirstProduct: five },
      "cut 6"
    );
    assert.deepEqual(
      cohortAt(WEEKS.borders),
      {
        activatedIn7Days: shown(20),
        retention: closedRetention(shown(10)),
        stores: shown(35),
        timeToFirstSale: bandsOf(five),
        withFirstProduct: shown(30),
        withFirstSale: shown(25),
        withoutSale: shown(10),
      },
      "the borders of the bands are inclusive (7 days exactly is up to 7 days, and a sale at the creation hour 7 days later is week 2)"
    );
    const notClosed = unavailable("week_not_closed");
    assert.deepEqual(
      cohortAt(WEEKS.open),
      {
        activatedIn7Days: unavailable("activation_window_open"),
        retention: { week2: notClosed, week3: notClosed, week5: notClosed },
        stores: shown(15),
        timeToFirstSale: bandsOf(unavailable("activation_window_open")),
        withFirstProduct: shown(10),
        withFirstSale: five,
        withoutSale: shown(10),
      },
      "a cohort whose 7 days are not over"
    );
    tests.push(
      "each cut the hand fixtures pick, with exact figures: every band (cut 1), activated and later without the bands (2), product and sale without the activation (3), the sale without the product (4 and 5), the product only (6), nothing (7); the borders of the bands are inclusive (exactly 10 minutes, 1 hour, 1 day and 7 days; 7 days and 1 second is later); in the last week the bands, the activation and the retention are unavailable with their reason, never 0"
    );
    tests.push(
      "a fixture counted by hand: cohort A (35 stores, 2 internal ones out) shows each band (5 each, by confirmed_at: a sale dated two years back and a cancelled one count), 30 with a product (a deleted one counts), 25 sold, 10 not yet, 20 activated in 7 days, 10 sold in week 2 (Sunday 23:30 and 22:00 of Brasília are still week 1, Monday 09:00 is week 2), 5 in week 3 and week 5 suppressed (3); its week has 42 verified sign-ups, 37 with a store; cohorts of 1 and 4 stores show nothing, of 5 and 6 only the count (every cell is 0 or all); in a cohort of 12 with 2 stores having a product and no sale, the product is hidden and the sale shows"
    );

    // the stores active by calendar week (M6), counted by hand from the sales of the fixture (every store of another
    // gate in these weeks is internal). The weeks cross the cohorts: cohort A sells again in weeks 2, 3 and 5 of its
    // own, the late band of a cut sells in the next week, and the borders at 7 days sell in the next week too.
    //  16 (A's week): the four first bands of A sell on Wednesday to Sunday: 5 + 5 + 5 + 5 = 20
    //  15 (B's week): B's 4, A's up-to-7-days (Monday 09:00) 5 and A's later (day 12) 5 = 14; hidden (see below)
    //  14 (C's week): C's 6 and the 5 of A's first band that sell again on day 15 = 11
    //  13 (D's week): D's 5 that sold in 5 minutes = 5, the smallest a week shows
    //  12 (borders): 15 at 10 minutes, 1 hour and 1 day, and 3 of A's second band that sell again on day 30 = 18
    //  11 (cut 2): 5 of the cut itself and 10 of the borders at 7 days and 7 days and 1 second = 15
    //  10 (cut 3): 5 of the cut itself and the 5 of cut 2 that sold later than 7 days = 10
    //   9 (cut 4): 5 of the cut itself, the 5 later ones sell in the next week = 5
    //   8 (cut 6): 2 of the cut itself and cut 4's 5 later ones = 7; hidden (see below)
    //  18 (F's week): 1 store sold: hidden; 17 (E's week): nobody sold: hidden, never 0
    const activeOf = (weeksAgo: number) =>
      byWeek(fixture.funnel, weeksAgo, fixture.clock).active.stores;
    for (const [weeksAgo, value] of [
      [WEEKS.a, 20],
      [WEEKS.c, 11],
      [WEEKS.d, 5],
      [WEEKS.borders, 18],
      [WEEKS.cut2, 15],
      [WEEKS.cut3, 10],
      [WEEKS.cut4, 5],
    ] as const) {
      assert.deepEqual(
        activeOf(weeksAgo),
        shown(value),
        `${weeksAgo} weeks ago: stores active, counted by hand`
      );
    }
    // 15 and 8 are counted above (14 and 7) but hidden: 10 of the 14 of week 15 are the stores of cohort A that sold in
    // their week 2, a cell the answer shows, so the 4 left would be a small cell by difference; and 5 of the 7 of week
    // 8 are the stores of cut 4 that sold in their week 2 (shown), which leaves 2
    assert.deepEqual(activeOf(WEEKS.b), SUPPRESSED);
    assert.deepEqual(activeOf(WEEKS.cut6), SUPPRESSED);
    assert.deepEqual(activeOf(WEEKS.f), SUPPRESSED);
    assert.deepEqual(activeOf(WEEKS.e), SUPPRESSED);
    // last week (the cohort whose 7 days are not over) is closed for the sales of the week: its 5 that sold show
    assert.deepEqual(activeOf(WEEKS.open), shown(5));
    assert.deepEqual(
      fixture.funnel.activeStores.at(-1),
      {
        inProgress: true,
        stores: unavailable("week_not_closed"),
        week: fixture.funnel.cohorts.at(-1)?.week,
        weekStart: fixture.funnel.cohorts.at(-1)?.weekStart,
      },
      "the current week is unavailable, never a count"
    );
    // the answer of a week does not depend on the window asked: week 15 is hidden by the retention cell of cohort A (16
    // weeks ago), and it still is when A is the first cohort outside a window of 16 weeks (or only 2, 5 or 20), so two
    // reads with different windows cannot be subtracted to isolate the small cell; the cohorts do not change either
    const windows = await Promise.all(
      [2, 5, 16, 20].map((weeks) => read(weeks))
    );
    const sixteen = windows[2]?.funnel.activeStores[0];
    assert.equal(
      sixteen?.weekStart,
      byWeek(fixture.funnel, WEEKS.b, fixture.clock).active.weekStart
    );
    assert.deepEqual(sixteen?.stores, SUPPRESSED);
    for (const { funnel: shorter } of windows) {
      for (const row of shorter.activeStores) {
        assert.deepEqual(
          row,
          fixture.funnel.activeStores.find(
            (week) => week.weekStart === row.weekStart
          ),
          `${row.week}: the same in a shorter window`
        );
      }
      for (const row of shorter.cohorts) {
        assert.deepEqual(
          row,
          fixture.funnel.cohorts.find(
            (cohort) => cohort.weekStart === row.weekStart
          ),
          `${row.week}: the cohort is the same in a shorter window`
        );
      }
    }
    // the complementary suppression: 5 stores sold in week 10, and of the stores that existed and did not sell only
    // 3, 4 or 5 are left (everything else is marked internal inside a transaction that is rolled back): at 3 and 4 the
    // 5 active stores are hidden, because the complement would give the small cell away, and at 5 both show
    const cutThree = fixtureStores[String(WEEKS.cut3)] as string[];
    const sellers = cutThree.slice(10, 15);
    for (const [idle, expectedCell] of [
      [3, SUPPRESSED],
      [4, SUPPRESSED],
      [5, shown(5)],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Scenarios, in order.
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO public.platform_internal_organizations (organization_id)
           SELECT id FROM public.organizations WHERE id <> ALL($1::text[]) ON CONFLICT DO NOTHING`,
          [[...sellers, ...cutThree.slice(0, idle)]]
        );
        const only = await client.query<{ result: Funnel }>(
          "SELECT public.admin_activation_funnel(26) AS result"
        );
        const week = only.rows[0]?.result.activeStores.find(
          (row) =>
            row.weekStart ===
            byWeek(fixture.funnel, WEEKS.cut3, fixture.clock).active.weekStart
        );
        assert.deepEqual(
          week?.stores,
          expectedCell,
          `5 active stores and ${idle} that existed without selling`
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    tests.push(
      "the stores active in a calendar week (M6), counted by hand: 20, 11, 5 (the smallest shown), 18, 15, 10 and 5 in the weeks of the fixture (sales of the cohorts cross into the next weeks); the weeks that count 14 and 7 are hidden because the retention cells they contain (10 and 5, shown for cohorts A and cut 4) leave 4 and 2 by difference; last week's 5 show, the same weeks and cohorts come out in a window of 2, 5, 16 and 20 weeks as in 26, a week with 1 or 0 active stores is hidden, never 0, and the current week is unavailable (week_not_closed); with 5 active stores and only 3 or 4 that existed and did not sell, the 5 are hidden (the complement would give the small cell away), with 5 and 5 both show"
    );

    // marking one store of cohort A (a band of up to 10 minutes) moves the figures at the next read; unmarking brings them back
    const moved = cohortA[10] as string;
    await asAdmin((client) =>
      classifyOrganization(client, operator, moved, true)
    );
    const afterMark = await read();
    const markedA = byWeek(afterMark.funnel, WEEKS.a, afterMark.clock).cohort;
    assert.deepEqual(
      [
        byWeek(afterMark.funnel, WEEKS.a, afterMark.clock).active.stores,
        byWeek(afterMark.funnel, WEEKS.c, afterMark.clock).active.stores,
      ],
      [shown(19), shown(10)],
      "the marked store leaves the stores active of week 1 and of week 3 of its cohort"
    );
    assert.deepEqual(
      {
        activatedIn7Days: markedA.activatedIn7Days,
        bands: markedA.timeToFirstSale,
        stores: markedA.stores,
        withFirstSale: markedA.withFirstSale,
      },
      {
        activatedIn7Days: shown(19),
        bands: nothing.timeToFirstSale,
        stores: shown(34),
        withFirstSale: shown(24),
      },
      "a band of 4 hides every band; the coarser figures still show"
    );
    assert.equal(
      afterMark.funnel.internalStoresExcluded,
      fixture.funnel.internalStoresExcluded + 1
    );
    await asAdmin((client) =>
      classifyOrganization(client, operator, moved, false)
    );
    const afterUnmark = await read();
    assert.deepEqual(
      byWeek(afterUnmark.funnel, WEEKS.a, afterUnmark.clock).cohort,
      A.cohort
    );
    tests.push(
      "marking a counted store as internal takes it out at the next read (35 to 34 stores, a band of 4 hides all five bands, 19 activated, one less active store in each of the two weeks it sold) and counts it among the internal ones; unmarking brings cohort A back as it was"
    );

    // ------------------------------------------------- 5 (drawn first, so 4 covers it too). random cohorts
    const seed = Number(
      process.env.POLARIS_FUNNEL_SEED ?? Date.now() % 1_000_000
    );
    notes.push(`activation-funnel seed ${seed}`);
    const draw = generator(seed);
    const randomWeeks = [25, 24, 23, 22, 21, 20, 19];
    for (const weeksAgo of randomWeeks) {
      const sizes = times(7, () => draw(10));
      // the time to the first sale, in minutes, in each band (up to 10 minutes, 1 hour, 1 day, 7 days, later)
      const bandMinutes = [5, 30, 300, 4320, 14_400];
      for (const [cell, size] of sizes.entries()) {
        for (const _ of times(size, () => 0)) {
          const createdMinutes = draw(5) * 1440 + draw(20) * 60;
          const sold = cell >= 2;
          // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
          await createStore(weeksAgo, {
            created: `${createdMinutes} minutes`,
            product: cell === 0 ? "none" : "live",
            sales: sold
              ? [
                  `${createdMinutes + (bandMinutes[cell - 2] as number)} minutes`,
                  ...(draw(2) === 0 ? ["8 days 12 hours"] : []),
                  ...(draw(2) === 0 ? ["15 days 12 hours"] : []),
                  ...(draw(3) === 0 ? ["29 days 12 hours"] : []),
                ]
              : [],
          });
        }
      }
    }

    // k stores created at the start of this week whose only sale is dated 10 days before they existed: they were not
    // there in the week of the sale, so no week may count them as active, whatever gate ran before this one
    for (const _ of times(K, () => 0)) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture rows, in order.
      await createStore(0, { created: "0 minutes", sales: ["-10 days"] });
    }

    // ------------------------------------------------- 4. the whole answer against a direct count
    const final = await read();
    const { funnel } = final;
    assert.deepEqual(Object.keys(funnel).sort(), [
      "activeStores",
      "cohorts",
      "generatedAt",
      "internalStoresExcluded",
      "k",
      "signups",
      "timezone",
      "weeks",
    ]);
    assert.equal(funnel.k, K);
    assert.equal(funnel.weeks, ACTIVATION_FUNNEL_MAX_WEEKS);
    assert.equal(funnel.timezone, ZONE);
    const direct = await owner.pool.query<{
      cohort: string;
      first_sale_seconds: number | null;
      has_product: boolean;
      sale_weeks: number[];
    }>(
      `WITH horizon AS (
         SELECT date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '29 weeks' AS first_week
       )
       SELECT to_char(date_trunc('week', o.created_at AT TIME ZONE '${ZONE}'), 'YYYY-MM-DD') AS cohort,
              (SELECT extract(epoch FROM s.confirmed_at - o.created_at)::float8
                 FROM public.sales AS s WHERE s.organization_id = o.id ORDER BY s.confirmed_at LIMIT 1) AS first_sale_seconds,
              (SELECT count(*) FROM public.products AS p WHERE p.organization_id = o.id) > 0 AS has_product,
              ARRAY(SELECT DISTINCT (extract(epoch FROM date_trunc('week', s.confirmed_at AT TIME ZONE '${ZONE}')
                                                - date_trunc('week', o.created_at AT TIME ZONE '${ZONE}')) / 604800)::int + 1
                      FROM public.sales AS s WHERE s.organization_id = o.id) AS sale_weeks
         FROM public.organizations AS o, horizon
        WHERE date_trunc('week', o.created_at AT TIME ZONE '${ZONE}') >= horizon.first_week
          AND o.status <> 'purged'
          AND o.id NOT IN (SELECT i.organization_id FROM public.platform_internal_organizations AS i)`
    );
    const internalCount = await owner.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM public.organizations AS o JOIN public.platform_internal_organizations AS i ON i.organization_id = o.id
        WHERE date_trunc('week', o.created_at AT TIME ZONE '${ZONE}') >= date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '25 weeks'
          AND o.status <> 'purged'`
    );
    const directSignups = await owner.pool.query<{
      s: number;
      u: number;
      week: string;
    }>(
      `SELECT to_char(date_trunc('week', u.created_at AT TIME ZONE '${ZONE}'), 'YYYY-MM-DD') AS week,
              count(*)::int AS u,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.memberships AS m WHERE m.user_id = u.id))::int AS s
         FROM public."user" AS u
        WHERE u.email_verified
          AND date_trunc('week', u.created_at AT TIME ZONE '${ZONE}') >= date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '25 weeks'
        GROUP BY 1`
    );
    // the stores active in each week, counted another way: the sales grouped by the week of `confirmed_at` (the
    // function asks, store by store, whether one falls in the week), and the stores that existed by the week of creation.
    // A store counts as active only in the weeks it already existed in: another gate backdates the sales of the stores it
    // creates just now into earlier weeks, and those sales are not activity of a store that did not exist yet
    const directActive = await owner.pool.query<{
      active: number;
      existing: number;
      start: string;
    }>(
      `WITH counted AS (
         SELECT o.id, o.created_at FROM public.organizations AS o
          WHERE o.status <> 'purged'
            AND o.id NOT IN (SELECT i.organization_id FROM public.platform_internal_organizations AS i)
       )
       SELECT to_char(w, 'YYYY-MM-DD') AS start,
              (SELECT count(DISTINCT s.organization_id)::int FROM public.sales AS s JOIN counted AS c ON c.id = s.organization_id
                WHERE date_trunc('week', s.confirmed_at AT TIME ZONE '${ZONE}') = w
                  AND date_trunc('week', c.created_at AT TIME ZONE '${ZONE}') <= w) AS active,
              (SELECT count(*)::int FROM counted AS c
                WHERE date_trunc('week', c.created_at AT TIME ZONE '${ZONE}') <= w) AS existing
         FROM generate_series(date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '25 weeks',
                              date_trunc('week', now() AT TIME ZONE '${ZONE}'), interval '7 days') AS w
        ORDER BY w`
    );
    // the cohorts are counted 4 weeks before the window (the function computes them there too, for the retention cells
    // that fall inside the first weeks of the series) and compared only from the window on
    const labels = await owner.pool.query<{ label: string; start: string }>(
      `SELECT to_char(w, 'YYYY-MM-DD') AS start, to_char(w, 'IYYY-"W"IW') AS label
         FROM generate_series(date_trunc('week', now() AT TIME ZONE '${ZONE}') - interval '29 weeks',
                              date_trunc('week', now() AT TIME ZONE '${ZONE}'), interval '7 days') AS w
        ORDER BY w`
    );
    const windowLabels = labels.rows.slice(4);
    assert.equal(windowLabels.length, ACTIVATION_FUNNEL_MAX_WEEKS);
    const tallies = new Map<string, Tally>();
    for (const week of labels.rows) {
      tallies.set(week.start, {
        b: 0,
        c: [0, 0, 0, 0, 0],
        n: 0,
        p0: 0,
        p1: 0,
        r2: 0,
        r3: 0,
        r5: 0,
      });
    }
    for (const store of direct.rows) {
      const tally = tallies.get(store.cohort);
      assert.ok(tally, `the cohort ${store.cohort} is in the window`);
      tally.n += 1;
      const seconds = store.first_sale_seconds;
      if (seconds === null) {
        if (store.has_product) {
          tally.p1 += 1;
        } else {
          tally.p0 += 1;
        }
      } else {
        tally.b += 1;
        tally.c[bandOf(seconds)] += 1;
      }
      tally.r2 += store.sale_weeks.includes(2) ? 1 : 0;
      tally.r3 += store.sale_weeks.includes(3) ? 1 : 0;
      tally.r5 += store.sale_weeks.includes(5) ? 1 : 0;
    }
    const cutsSeen = new Set(
      windowLabels.map((week) => {
        const start = Date.parse(`${week.start}T00:00:00Z`);
        return tierOf(
          tallies.get(week.start) as Tally,
          start + 14 * DAY <= final.clock.localNow
        );
      })
    );
    assert.deepEqual(
      [...cutsSeen].sort(),
      [1, 2, 3, 4, 5, 6, 7],
      "every cut of the suppression is exercised by the rows"
    );
    const signupOf = new Map(directSignups.rows.map((row) => [row.week, row]));
    const activeByWeek = new Map(
      directActive.rows.map((row) => [row.start, row])
    );
    const expected = {
      activeStores: windowLabels.map((week) => {
        const row = activeByWeek.get(week.start) ?? { active: 0, existing: 0 };
        // the retention cells the answer shows that fall in this week (the cohort 1, 2 or 4 weeks older, in its week
        // 2, 3 or 5), taken out of both sides: the stores that sold and the ones that did not
        let overlapActive = 0;
        let overlapIdle = 0;
        for (const [lag, key] of [
          [1, "r2"],
          [2, "r3"],
          [4, "r5"],
        ] as const) {
          const older = new Date(
            Date.parse(`${week.start}T00:00:00Z`) - lag * 7 * DAY
          )
            .toISOString()
            .slice(0, 10);
          const tally = tallies.get(older);
          const weekNumber = lag === 4 ? 5 : lag + 1;
          if (
            tally &&
            Date.parse(`${older}T00:00:00Z`) + weekNumber * 7 * DAY <=
              Date.parse(`${final.clock.currentWeek}T00:00:00Z`) &&
            tally[key] >= K &&
            tally.b - tally[key] >= K
          ) {
            overlapActive += tally[key];
            overlapIdle += tally.n - tally[key];
          }
        }
        let stores: Cell = SUPPRESSED;
        if (week.start === final.clock.currentWeek) {
          stores = unavailable("week_not_closed");
        } else if (
          row.active - overlapActive >= K &&
          row.existing - row.active - overlapIdle >= K
        ) {
          stores = shown(row.active);
        }
        return {
          inProgress: week.start === final.clock.currentWeek,
          stores,
          week: week.label,
          weekStart: week.start,
        };
      }),
      cohorts: windowLabels.map((week) =>
        expectedCohort(week, tallies.get(week.start) as Tally, final.clock)
      ),
      internalStoresExcluded: internalCount.rows[0]?.count,
      k: K,
      signups: windowLabels.map((week) => {
        const row = signupOf.get(week.start) ?? { s: 0, u: 0 };
        return {
          accounts: row.u >= K ? shown(row.u) : SUPPRESSED,
          inProgress: week.start === final.clock.currentWeek,
          week: week.label,
          weekStart: week.start,
          withStore:
            row.s >= K && row.u - row.s >= K ? shown(row.s) : SUPPRESSED,
        };
      }),
      timezone: ZONE,
      weeks: ACTIVATION_FUNNEL_MAX_WEEKS,
    };
    const { generatedAt, ...answer } = funnel;
    assert.ok(Math.abs(Date.parse(generatedAt) - Date.now()) < 3_600_000);
    assert.deepEqual(answer, expected, "the function equals the direct count");
    const leaked = JSON.stringify(funnel);
    for (const id of [...cohortA, operator]) {
      assert.ok(!leaked.includes(id), "no identifier in the answer");
    }
    assert.ok(!leaked.includes("@example.invalid"), "no e-mail in the answer");
    assert.equal(funnel.activeStores.length, ACTIVATION_FUNNEL_MAX_WEEKS);
    const cohortKeys = new Set(
      funnel.cohorts.map((row) => Object.keys(row).sort().join())
    );
    assert.equal(cohortKeys.size, 1, "every cohort has the same closed keys");
    tests.push(
      `the whole answer of 26 weeks (${direct.rows.length} counted stores, from every gate before this one and the fixtures) equals a direct count of the rows computed apart (first sale by ORDER BY, weeks of sale by date_trunc, the cut chosen again in this file, the stores active in each calendar week by the sales grouped by week, counting a store only from the week it was created, and the complement by the week of creation; five stores created this week with a sale dated before they existed show that no week counts them), with the same reasons of "unavailable"; the format is closed and holds no identifier or e-mail`
    );

    const problems = suppressionProblems(funnel);
    assert.deepEqual(problems, [], "the suppression holds on every cohort");
    const shownCells =
      JSON.stringify(funnel.cohorts).match(/"state":"shown"/g)?.length ?? 0;
    assert.ok(shownCells > 0, "the check looked at shown cells");
    const shownActive = funnel.activeStores.filter(
      (week) => week.stores.state === "shown"
    ).length;
    assert.ok(
      shownActive > 0,
      "the check looked at shown cells of the stores active in a week"
    );
    tests.push(
      `on cohorts drawn at random (seed ${seed}, 7 weeks of 0 to 9 stores per cell) and on every other cohort: no value under 5 (the stores active in a week included: ${shownActive} weeks shown), no complement and no difference of two nested counts under 5 (the active stores minus a retention cell they contain included), bands all or none and adding up to the sales (${shownCells} shown cells checked)`
    );

    // ------------------------------------------------- 6. the cost with 1,000 stores and 50,000 sales
    {
      const client = await owner.pool.connect();
      const plans: string[] = [];
      client.on("notice", (message) => {
        if (message.message?.includes("Query Text")) {
          plans.push(message.message);
        }
      });
      try {
        await client.query("BEGIN");
        await client.query(
          `CREATE TEMP TABLE funnel_measure ON COMMIT DROP AS
             SELECT gen_random_uuid()::text AS organization_id, gen_random_uuid()::text AS user_id,
                    now() - (random() * 180) * interval '1 day' AS created_at, g AS position
               FROM generate_series(1, 1000) AS g`
        );
        await client.query(
          `INSERT INTO public."user" (id, name, email, email_verified, created_at)
           SELECT user_id, 'Medida do funil', 'measure-' || user_id || '@example.invalid', true, created_at FROM funnel_measure`
        );
        await client.query(
          `INSERT INTO public.organizations (id, name, timezone, created_at)
           SELECT organization_id, 'Medida do funil', '${ZONE}', created_at FROM funnel_measure`
        );
        await client.query(
          `INSERT INTO public.memberships (organization_id, user_id, role, status)
           SELECT organization_id, user_id, 'owner', 'active' FROM funnel_measure`
        );
        await client.query(
          `WITH created AS (
             INSERT INTO public.products (organization_id, name)
             SELECT organization_id, 'Produto ' || p FROM funnel_measure, generate_series(1, 3) AS p WHERE position % 5 <> 0
             RETURNING id, organization_id
           )
           INSERT INTO public.product_variants (organization_id, product_id, is_default)
           SELECT organization_id, id, true FROM created`
        );
        // 50,000 sales over 800 stores (62 or 63 each), after the store was created and not after now; headers only
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, confirmed_at)
           SELECT m.organization_id, gen_random_uuid(), x.at, (x.at AT TIME ZONE '${ZONE}')::date, 1, 0, x.at
             FROM generate_series(0, 49999) AS g
             JOIN funnel_measure AS m ON m.position = (g % 800) + 1
             CROSS JOIN LATERAL (SELECT m.created_at + random() * (now() - m.created_at) AS at) AS x`
        );
        await client.query("SET LOCAL session_replication_role = origin");
        await client.query(
          'ANALYZE public."user", public.organizations, public.memberships, public.products, public.sales, public.platform_internal_organizations'
        );
        const volume = await client.query<{ sales: number; stores: number }>(
          "SELECT (SELECT count(*)::int FROM public.organizations) AS stores, (SELECT count(*)::int FROM public.sales) AS sales"
        );
        const durations: number[] = [];
        for (const _ of times(3, () => 0)) {
          const started = performance.now();
          // biome-ignore lint/performance/noAwaitInLoops: Timed one after another.
          await client.query("SELECT public.admin_activation_funnel(26)");
          durations.push(performance.now() - started);
        }
        await client.query("LOAD 'auto_explain'");
        await client.query("SET LOCAL auto_explain.log_min_duration = 0");
        await client.query("SET LOCAL auto_explain.log_analyze = on");
        await client.query("SET LOCAL auto_explain.log_buffers = on");
        await client.query("SET LOCAL auto_explain.log_nested_statements = on");
        await client.query("SET LOCAL client_min_messages = log");
        await client.query("SELECT public.admin_activation_funnel(26)");
        await client.query("SET LOCAL client_min_messages = notice");
        const median = [...durations].sort((x, y) => x - y)[1] as number;
        const plan = plans.find((text) => text.includes("WITH weeks AS")) ?? "";
        assert.ok(
          plan.length > 0,
          "auto_explain gave the plan of the query inside"
        );
        const execution = EXECUTION_TIME.exec(plan)?.[1];
        notes.push(
          `activation-funnel measure: ${volume.rows[0]?.stores} stores, ${volume.rows[0]?.sales} sales in the database; call ${durations.map((ms) => ms.toFixed(1)).join(" / ")} ms (median ${median.toFixed(1)} ms); query inside ${execution ?? "?"} ms`
        );
        for (const line of plan.split("\n")) {
          if (!line.startsWith("Query Text") && line.trim().length > 0) {
            notes.push(`activation-funnel plan | ${line}`);
          }
        }
        assert.ok(
          median < 5000,
          `the funnel answers in under 5 s with 1,000 stores and 50,000 sales (${median.toFixed(1)} ms)`
        );
        tests.push(
          `with 1,000 stores more and 50,000 sales (rolled back), the call takes ${median.toFixed(1)} ms (median of 3) and auto_explain gives the plan of the query inside (gate notes)`
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    for (const note of notes) {
      console.log(`gate-note: ${note}`);
    }
    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const [role, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Activation funnel PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
