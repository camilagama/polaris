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
 * The candidates of the activation series on a real PostgreSQL 18 (ADR 0106, D2 to D6; migration 0126):
 *   1. who reaches what: `activation_notice_candidates` is SECURITY DEFINER of the owner of the series, with a fixed
 *      search_path ending in pg_temp and no dynamic SQL, and only the billing role executes it (function by function,
 *      every `polaris_*` group and PUBLIC); a tenant login is refused; the limit is 1 to 50; the state of the series is
 *      written by the billing role only and read by the owner of the series only;
 *   2. what the owner of the series sees: a store of 15 days is invisible to it, and so are its products, sales, billing
 *      record, internal marker, owner's `"user"` row, support cases and requests about personal data, where the same
 *      rows of a store of 13 days are visible; it never reads `"user".email` nor `session`;
 *   3. the stop rules, one table of cases in one transaction: each store is eligible but for one rule and gets no row
 *      (sold, opted out, trial used, trialing, Pro, in grace, suspended, closing, closed, in purge, open request about
 *      personal data, internal, e-mail not verified, second store of the person, a co-owner who is not the founder),
 *      next to the eligible controls (a store whose request was only a support case, the founder of the shared store);
 *   4. the triggers and the window with a fixed clock: a1 at 23:59 no, at 24:00 yes; a2 3 days after the oldest live
 *      product (not a minute before) or on the 5th day still without one; a3 on the 10th day only after the a2 went out;
 *      nothing at 07:59 or 12:00 of São Paulo, everything at 08:00 and 11:59; a store of exactly 14 days is out, and no
 *      person gets a 4th e-mail;
 *   5. the switch and the validity: nothing while the state is null or later than the clock; what fell due before the
 *      switch went on comes back `series_off`, a step 3 days past its trigger comes back `expired`, a minute less `due`;
 *   6. the daily cap of 60 (with 58 recorded today, 5 skipped that do not count): 2 `due` and `truncated`, the skipped
 *      kinds still answered; the billing role records them, and the next day the rest comes back in order;
 *   7. the table itself: a notice whose ID carries "@" is refused, the same person and step in two stores is refused;
 *      and the effect accepted in the ADR: the membership of the first store deleted (and its notice with it), the
 *      next store of the person becomes a candidate.
 * Every case runs in a transaction that is rolled back, with the stores the other gates left suspended inside it, so
 * the answers are about this gate's stores only. Local Postgres only: the fixtures write sale headers whose items the
 * deferred checks never see.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const BILLING_RUNTIME = "polaris_billing_runtime";
const NOTICE_OWNER = "polaris_activation_notice_owner";
const FUNCTION = "public.activation_notice_candidates(timestamptz, integer)";
const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DYNAMIC_SQL = /\bEXECUTE\b|\bformat\s*\(/i;
const issuer =
  "https://polaris-activation-candidates-gate.cloudflareaccess.com";

interface Candidate {
  due_at: Date;
  organization_id: string;
  outcome: "due" | "expired" | "series_off";
  step: "a1" | "a2" | "a3";
  truncated: boolean;
  user_id: string;
}

interface StoreSpec {
  billing?: { state: string; trial: boolean };
  createdAt: Date;
  internal?: boolean;
  optOut?: boolean;
  /** The person, when it already owns another store; else a new verified one. */
  owner?: string;
  ownerSince?: Date;
  privacy?: "open" | "support_only";
  product?: { at: Date; deleted?: boolean };
  sale?: boolean;
  status?: string;
  verified?: boolean;
}

interface Store {
  organizationId: string;
  userId: string;
}

const at = (base: Date, offset: number) => new Date(base.getTime() + offset);

/** The 63 notices of the cap's case: 58 that count (owed and sent in turn), then 5 skipped that do not. */
const seededOutcome = (index: number): "owed" | "sent" | "skipped" => {
  if (index >= 58) {
    return "skipped";
  }
  return index % 2 === 0 ? "owed" : "sent";
};

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

    // the clock of every case: 10:00 of São Paulo on the day the database is in, so the stores of up to 13 days back
    // stay inside the 14 days the owner of the series sees, whatever the hour the gate runs
    const clock = await owner.pool.query<{ now: Date; ten: Date }>(
      `SELECT now() AS now, (pg_catalog.date_trunc('day', now() AT TIME ZONE '${ZONE}') + interval '10 hours') AT TIME ZONE '${ZONE}' AS ten`
    );
    const ten = clock.rows[0]?.ten;
    const databaseNow = clock.rows[0]?.now;
    assert.ok(ten instanceof Date && databaseNow instanceof Date);
    const principal = String(
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
          [issuer, `candidates-${randomUUID()}`]
        )
      ).rows[0]?.id
    );

    // 1. who reaches what
    const definition = await owner.pool.query<{
      config: string[];
      definer: boolean;
      owner: string;
      source: string;
      volatility: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner, p.prosrc AS source,
              p.provolatile::text AS volatility
         FROM pg_catalog.pg_proc AS p WHERE p.oid = $1::regprocedure`,
      [FUNCTION]
    );
    const [fn] = definition.rows;
    assert.ok(fn);
    assert.equal(fn.definer, true, "SECURITY DEFINER");
    assert.equal(fn.owner, NOTICE_OWNER, "owned by the owner of the series");
    assert.deepEqual(fn.config, ["search_path=pg_catalog, public, pg_temp"]);
    assert.doesNotMatch(fn.source, DYNAMIC_SQL, "no dynamic SQL");
    assert.equal(fn.volatility, "v", "volatile: it takes the lock of the cap");
    const executors = await owner.pool.query<{ role: string }>(
      `SELECT r.role FROM (
         SELECT 'public' AS role
         UNION ALL SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'polaris\\_%' AND NOT rolcanlogin
       ) AS r
        WHERE pg_catalog.has_function_privilege(r.role, $1, 'EXECUTE')
        ORDER BY r.role COLLATE "C"`,
      [FUNCTION]
    );
    assert.deepEqual(
      executors.rows.map((row) => row.role),
      [NOTICE_OWNER, BILLING_RUNTIME],
      "only the billing role executes it (and its owner)"
    );
    const stateReach = await owner.pool.query<{ role: string }>(
      `SELECT r.role FROM (
         SELECT 'public' AS role
         UNION ALL SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'polaris\\_%' AND NOT rolcanlogin
       ) AS r
        WHERE pg_catalog.has_any_column_privilege(r.role, 'public.activation_series_state', 'SELECT, INSERT, UPDATE, REFERENCES')
           OR pg_catalog.has_table_privilege(r.role, 'public.activation_series_state', 'DELETE, TRUNCATE, TRIGGER')
        ORDER BY r.role COLLATE "C"`
    );
    assert.deepEqual(
      stateReach.rows.map((row) => row.role),
      [NOTICE_OWNER, BILLING_RUNTIME],
      "only the billing role and the owner of the series reach the state"
    );
    const ownerReads = await owner.pool.query<{
      email: boolean;
      session: boolean;
      writes: boolean;
    }>(
      `SELECT pg_catalog.has_column_privilege($1, 'public."user"', 'email', 'SELECT') AS email,
              pg_catalog.has_any_column_privilege($1, 'public.session', 'SELECT') AS session,
              pg_catalog.has_any_column_privilege($1, 'public.activation_series_state', 'INSERT, UPDATE')
                OR pg_catalog.has_any_column_privilege($1, 'public.activation_notices', 'INSERT, UPDATE') AS writes`,
      [NOTICE_OWNER]
    );
    assert.deepEqual(ownerReads.rows[0], {
      email: false,
      session: false,
      writes: false,
    });
    const billingUrl = await login(
      BILLING_RUNTIME,
      "polaris_candidates_billing"
    );
    const tenantUrl = await login(runtimeRole, "polaris_candidates_tenant");
    await as(tenantUrl, async (client) => {
      await setLoginRole(client, runtimeRole, "session");
      await expectSqlState(
        () =>
          client.query(
            "SELECT * FROM public.activation_notice_candidates(now(), 50)"
          ),
        "42501",
        "the tenant does not execute the candidates"
      );
      await expectSqlState(
        () => client.query("SELECT * FROM public.activation_series_state"),
        "42501",
        "the tenant does not read the state of the series"
      );
    });
    await as(billingUrl, async (client) => {
      await setLoginRole(client, BILLING_RUNTIME, "session");
      for (const limit of [0, 51, null]) {
        await expectSqlState(
          () =>
            client.query(
              "SELECT * FROM public.activation_notice_candidates(now(), $1)",
              [limit]
            ),
          "22023",
          `the limit ${limit} is refused`
        );
      }
      await expectSqlState(
        () =>
          client.query(
            "SELECT * FROM public.activation_notice_candidates(NULL, 50)"
          ),
        "22023",
        "a null clock is refused"
      );
      await client.query("BEGIN");
      try {
        await client.query(
          "INSERT INTO public.activation_series_state (enabled_since) VALUES (now()) ON CONFLICT (id) DO UPDATE SET enabled_since = EXCLUDED.enabled_since, updated_at = now()"
        );
        await client.query(
          "UPDATE public.activation_series_state SET enabled_since = NULL, updated_at = now()"
        );
        const read = await client.query(
          "SELECT enabled_since FROM public.activation_series_state"
        );
        assert.equal(read.rows.length, 1);
        await expectSqlState(
          () =>
            client.query(
              "INSERT INTO public.activation_series_state (id, enabled_since) VALUES (false, now())"
            ),
          "42501",
          "the billing role writes only the instant"
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });
    tests.push(
      'activation_notice_candidates is SECURITY DEFINER of polaris_activation_notice_owner, volatile, with search_path pg_catalog, public, pg_temp and no dynamic SQL; of PUBLIC and every polaris_* group only the billing role executes it (and its owner), a tenant login is refused (42501), a limit of 0, 51 or null and a null clock are refused (22023); the state of the series is reached only by the billing role (which writes only the instant) and the owner of the series; that owner reads neither "user".email nor session and writes nothing'
    );

    const scenario = async <T>(
      work: (client: Client) => Promise<T>
    ): Promise<T> =>
      as(adminUrl, async (client) => {
        await client.query("BEGIN");
        try {
          // the stores and notices other gates left are out of this transaction's answers
          await client.query(
            "UPDATE public.organizations SET status = 'suspended' WHERE status = 'active'"
          );
          await client.query("DELETE FROM public.activation_notices");
          await client.query(
            "INSERT INTO public.activation_series_state (enabled_since) VALUES ($1) ON CONFLICT (id) DO UPDATE SET enabled_since = EXCLUDED.enabled_since",
            [at(ten, -30 * DAY)]
          );
          return await work(client);
        } finally {
          await client.query("ROLLBACK");
        }
      });
    const newPerson = async (client: Client, verified = true) => {
      const userId = randomUUID();
      await client.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)',
        [
          userId,
          "Pessoa do gate de candidatos",
          `candidates-${userId}@example.invalid`,
          verified,
        ]
      );
      return userId;
    };
    const newStore = async (
      client: Client,
      spec: StoreSpec
    ): Promise<Store> => {
      const organizationId = randomUUID();
      const userId = spec.owner ?? (await newPerson(client, spec.verified));
      await client.query(
        "INSERT INTO public.organizations (id, name, timezone, status, created_at) VALUES ($1, 'Loja do gate de candidatos', $2, $3, $4)",
        [organizationId, ZONE, spec.status ?? "active", spec.createdAt]
      );
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [organizationId, userId, spec.ownerSince ?? spec.createdAt]
      );
      if (spec.product) {
        await client.query(
          `WITH created AS (
             INSERT INTO public.products (organization_id, name, created_at, deleted_at)
             VALUES ($1, 'Produto do gate de candidatos', $2, $3)
             RETURNING id, organization_id
           )
           INSERT INTO public.product_variants (organization_id, product_id, is_default)
           SELECT organization_id, id, true FROM created`,
          [
            organizationId,
            spec.product.at,
            spec.product.deleted ? at(spec.product.at, MINUTE) : null,
          ]
        );
      }
      if (spec.sale) {
        // only the header: the checks of its items are deferred to a commit this transaction never reaches
        await client.query(
          `INSERT INTO public.sales (organization_id, command_id, occurred_at, occurred_on, item_count, adjustment_count, confirmed_at)
           VALUES ($1, gen_random_uuid(), $2, ($2::timestamptz AT TIME ZONE '${ZONE}')::date, 1, 0, $2)`,
          [organizationId, at(spec.createdAt, HOUR)]
        );
      }
      await addStoreFacts(client, organizationId, userId, spec);
      return { organizationId, userId };
    };
    const addStoreFacts = async (
      client: Client,
      organizationId: string,
      userId: string,
      spec: StoreSpec
    ) => {
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
            at(spec.createdAt, HOUR),
          ]
        );
      }
      if (spec.internal) {
        await client.query(
          "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ($1)",
          [organizationId]
        );
      }
      if (spec.privacy) {
        const supportCase = String(
          (
            await client.query<{ id: string }>(
              "INSERT INTO public.support_cases (kind, opened_by, organization_id, reason) VALUES ($1, $2, $3, 'Gate dos candidatos') RETURNING id",
              [
                spec.privacy === "open" ? "privacy" : "support",
                principal,
                organizationId,
              ]
            )
          ).rows[0]?.id
        );
        if (spec.privacy === "open") {
          await client.query(
            `INSERT INTO public.privacy_cases (support_case_id, channel, requester_kind, request_type, received_at, due_at)
             VALUES ($1, 'email', 'data_subject', 'access', now(), now() + interval '15 days')`,
            [supportCase]
          );
        }
      }
      if (spec.optOut) {
        await client.query(
          "INSERT INTO public.email_opt_outs (user_id) VALUES ($1)",
          [userId]
        );
      }
    };
    const candidates = (client: Client, now: Date, limit = 50) =>
      withGateRole(client, BILLING_RUNTIME, async () => {
        const result = await client.query<Candidate>(
          "SELECT organization_id, user_id, step, due_at, outcome, truncated FROM public.activation_notice_candidates($1, $2)",
          [now, limit]
        );
        return result.rows;
      });
    const stepsOf = (rows: Candidate[], store: Store) =>
      rows
        .filter((row) => row.organization_id === store.organizationId)
        .map((row) => `${row.step}:${row.outcome}`)
        .sort();
    const seedNotice = (
      client: Client,
      store: Store,
      step: string,
      outcome: "owed" | "sent" | "skipped",
      recordedAt: Date
    ) =>
      client.query(
        `INSERT INTO public.activation_notices (organization_id, user_id, step, due_at, recorded_at, sent_at, skipped_reason)
         VALUES ($1, $2, $3, $4, $4, CASE WHEN $5 = 'sent' THEN $4::timestamptz END, CASE WHEN $5 = 'skipped' THEN 'expired' END)`,
        [store.organizationId, store.userId, step, recordedAt, outcome]
      );

    // 2. what the owner of the series sees: a store of 15 days (of the database's clock) is out of its sight
    await scenario(async (client) => {
      const specOf = (createdAt: Date): StoreSpec => ({
        billing: { state: "free", trial: false },
        createdAt,
        internal: true,
        privacy: "open",
        product: { at: at(createdAt, HOUR) },
        sale: true,
      });
      const old = await newStore(client, specOf(at(databaseNow, -15 * DAY)));
      const recent = await newStore(client, specOf(at(databaseNow, -13 * DAY)));
      const seen = await withGateRole(client, NOTICE_OWNER, async () => {
        const count = async (sql: string, organizationId: string) =>
          Number(
            (await client.query<{ n: string }>(sql, [organizationId])).rows[0]
              ?.n
          );
        const reads: Record<string, string> = {
          billing:
            "SELECT count(*) AS n FROM public.organization_billing WHERE organization_id = $1",
          internal:
            "SELECT count(*) AS n FROM public.platform_internal_organizations WHERE organization_id = $1",
          organizations:
            "SELECT count(*) AS n FROM public.organizations WHERE id = $1",
          privacy:
            "SELECT count(*) AS n FROM public.privacy_cases AS p JOIN public.support_cases AS s ON s.id = p.support_case_id WHERE s.organization_id = $1",
          products:
            "SELECT count(*) AS n FROM public.products WHERE organization_id = $1",
          sales:
            "SELECT count(*) AS n FROM public.sales WHERE organization_id = $1",
          support:
            "SELECT count(*) AS n FROM public.support_cases WHERE organization_id = $1",
          user: 'SELECT count(*) AS n FROM public."user" AS u JOIN public.memberships AS m ON m.user_id = u.id WHERE m.organization_id = $1',
        };
        const out: Record<string, [number, number]> = {};
        for (const [name, sql] of Object.entries(reads)) {
          out[name] = [
            await count(sql, old.organizationId),
            await count(sql, recent.organizationId),
          ];
        }
        return out;
      });
      for (const [name, [oldCount, recentCount]] of Object.entries(seen)) {
        assert.equal(oldCount, 0, `${name}: the store of 15 days is invisible`);
        assert.equal(recentCount, 1, `${name}: the store of 13 days is seen`);
      }
    });
    tests.push(
      'the owner of the series does not see a store of 15 days, nor its products, sales, billing record, internal marker, owner\'s "user" row, support case or request about personal data, and sees each of them for a store of 13 days'
    );

    // 3. the stop rules: each store eligible but for one rule
    await scenario(async (client) => {
      const created = at(ten, -25 * HOUR);
      const base: StoreSpec = { createdAt: created };
      const control = await newStore(client, base);
      const supportOnly = await newStore(client, {
        ...base,
        privacy: "support_only",
      });
      const firstStorePerson = await newPerson(client);
      const first = await newStore(client, {
        createdAt: at(created, -HOUR),
        owner: firstStorePerson,
      });
      const shared = await newStore(client, base);
      const coOwner = await newPerson(client);
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [shared.organizationId, coOwner, at(created, MINUTE)]
      );
      const stopped: [string, StoreSpec][] = [
        ["sold", { ...base, product: { at: at(created, HOUR) }, sale: true }],
        ["sold while still without a product", { ...base, sale: true }],
        ["opted out", { ...base, optOut: true }],
        ["trial used", { ...base, billing: { state: "free", trial: true } }],
        ["trialing", { ...base, billing: { state: "trialing", trial: true } }],
        ["Pro", { ...base, billing: { state: "active", trial: false } }],
        ["in grace", { ...base, billing: { state: "grace", trial: false } }],
        [
          "trial being set up",
          { ...base, billing: { state: "trial_setup", trial: false } },
        ],
        [
          "free over the limit",
          { ...base, billing: { state: "free_over_limit", trial: false } },
        ],
        ["suspended", { ...base, status: "suspended" }],
        ["closing by its owner", { ...base, status: "closing" }],
        ["closed", { ...base, status: "closed" }],
        ["in purge", { ...base, status: "purge_pending" }],
        ["open request about personal data", { ...base, privacy: "open" }],
        ["internal", { ...base, internal: true }],
        ["e-mail not verified", { ...base, verified: false }],
        ["second store of the person", { ...base, owner: firstStorePerson }],
      ];
      const stores: [string, Store][] = [];
      for (const [label, spec] of stopped) {
        stores.push([label, await newStore(client, spec)]);
      }
      const rows = await candidates(client, ten);
      for (const [label, store] of stores) {
        assert.deepEqual(stepsOf(rows, store), [], `${label}: no notice`);
      }
      for (const [label, store] of [
        ["the eligible control", control],
        ["a store whose case is only a support case", supportOnly],
        ["the first store of a person with two", first],
      ] as const) {
        assert.deepEqual(stepsOf(rows, store), ["a1:due"], label);
      }
      const ofShared = rows.filter(
        (row) => row.organization_id === shared.organizationId
      );
      assert.deepEqual(
        ofShared.map((row) => row.user_id),
        [shared.userId],
        "only the founder of a store with two owners"
      );
      assert.ok(!rows.some((row) => row.user_id === coOwner));
    });
    tests.push(
      "each stop rule the database can tell stops the notice of a store that is eligible but for it: sold (with or without a product), opted out, trial used, trialing, Pro, in grace, trial being set up, free over the limit, suspended, closing, closed, in purge, open request about personal data (privacy_cases through support_cases), internal, e-mail not verified, second store of the person, a co-owner who is not the founder; an eligible control, a store whose case is only a support case and the first store of a person with two get their a1 (the suppressed address is the Worker's, D3)"
    );

    // 4. the triggers and the window, with the clock fixed at 10:00 of São Paulo
    await scenario(async (client) => {
      const a1Before = await newStore(client, {
        createdAt: at(ten, -(24 * HOUR - MINUTE)),
      });
      const a1At = await newStore(client, { createdAt: at(ten, -24 * HOUR) });
      const a2Before = await newStore(client, {
        createdAt: at(ten, -5 * DAY),
        product: { at: at(ten, -(3 * DAY - MINUTE)) },
      });
      const a2At = await newStore(client, {
        createdAt: at(ten, -5 * DAY),
        product: { at: at(ten, -3 * DAY) },
      });
      const a2DeletedProduct = await newStore(client, {
        createdAt: at(ten, -5 * DAY),
        product: { at: at(ten, -4 * DAY), deleted: true },
      });
      const s0Before = await newStore(client, {
        createdAt: at(ten, -(4 * DAY - MINUTE)),
      });
      const s0At = await newStore(client, { createdAt: at(ten, -4 * DAY) });
      const a3WithA2 = await newStore(client, {
        createdAt: at(ten, -10 * DAY),
        product: { at: at(ten, -9 * DAY) },
      });
      await seedNotice(client, a3WithA2, "a2", "sent", at(ten, -6 * DAY));
      const a3WithoutA2 = await newStore(client, {
        createdAt: at(ten, -10 * DAY),
        product: { at: at(ten, -9 * DAY) },
      });
      await seedNotice(client, a3WithoutA2, "a2", "skipped", at(ten, -6 * DAY));
      const a3Owed = await newStore(client, {
        createdAt: at(ten, -10 * DAY),
        product: { at: at(ten, -9 * DAY) },
      });
      await seedNotice(client, a3Owed, "a2", "owed", at(ten, -6 * DAY));
      const fourteen = await newStore(client, {
        createdAt: at(ten, -14 * DAY),
        product: { at: at(ten, -13 * DAY) },
      });
      await seedNotice(client, fourteen, "a2", "sent", at(ten, -10 * DAY));
      const allSent = await newStore(client, {
        createdAt: at(ten, -11 * DAY),
        product: { at: at(ten, -10 * DAY) },
      });
      for (const step of ["a1", "a2", "a3"]) {
        await seedNotice(client, allSent, step, "sent", at(ten, -2 * DAY));
      }
      const rows = await candidates(client, ten);
      const expected: [string, Store, string[]][] = [
        ["a1 at 23:59", a1Before, []],
        ["a1 at 24:00", a1At, ["a1:due"]],
        ["a2 a minute before 3 days of the product", a2Before, []],
        ["a2 at 3 days of the product", a2At, ["a2:due"]],
        [
          "a deleted product leaves the store without one (S0, 5th day)",
          a2DeletedProduct,
          ["a1:expired", "a2:due"],
        ],
        ["S0 a minute before the 5th day", s0Before, ["a1:due"]],
        ["S0 on the 5th day", s0At, ["a1:expired", "a2:due"]],
        ["a3 on the 10th day after the a2 went out", a3WithA2, ["a3:due"]],
        ["no a3 when the a2 was skipped", a3WithoutA2, []],
        ["no a3 while the a2 is still owed", a3Owed, []],
        ["nothing for a store of exactly 14 days", fourteen, []],
        ["never a 4th e-mail", allSent, []],
      ];
      for (const [label, store, steps] of expected) {
        assert.deepEqual(stepsOf(rows, store), steps, label);
      }
      const dueOfA1 = rows.find(
        (row) => row.organization_id === a1At.organizationId
      );
      assert.equal(dueOfA1?.due_at.getTime(), ten.getTime(), "a1 due at 24 h");
      for (const [label, offset, open] of [
        ["07:59", -(2 * HOUR + MINUTE), false],
        ["08:00", -2 * HOUR, true],
        ["11:59", 2 * HOUR - MINUTE, true],
        ["12:00", 2 * HOUR, false],
      ] as const) {
        const within = await candidates(client, at(ten, offset));
        assert.equal(
          within.length > 0,
          open,
          `${label} of São Paulo is ${open ? "inside" : "outside"} the window`
        );
      }
    });
    tests.push(
      "the triggers on a clock fixed at 10:00 of São Paulo: a1 at 24:00 of the store and not at 23:59; a2 3 days after the oldest live product and not a minute before, on the 5th day (4 days) for a store still without one (a deleted product counts as none) and not a minute before; a3 on the 10th day only once the a2 went out (not skipped, not still owed); nothing for a store of exactly 14 days, never a 4th e-mail; the window answers at 08:00 and 11:59 and nothing at 07:59 and 12:00"
    );

    // 5. the switch and the validity
    await scenario(async (client) => {
      const owedSince = (hours: number) =>
        newStore(client, { createdAt: at(ten, -(24 + hours) * HOUR) });
      const beforeSwitch = await owedSince(3);
      const afterSwitch = await owedSince(1);
      const almostExpired = await newStore(client, {
        createdAt: at(ten, -(4 * DAY - MINUTE)),
      });
      const expired = await newStore(client, {
        createdAt: at(ten, -4 * DAY),
      });
      await client.query(
        "UPDATE public.activation_series_state SET enabled_since = NULL"
      );
      assert.deepEqual(await candidates(client, ten), [], "nothing while off");
      await client.query(
        "UPDATE public.activation_series_state SET enabled_since = $1",
        [at(ten, MINUTE)]
      );
      assert.deepEqual(
        await candidates(client, ten),
        [],
        "nothing before the instant it went on"
      );
      await client.query(
        "UPDATE public.activation_series_state SET enabled_since = $1",
        [at(ten, -2 * HOUR)]
      );
      const rows = await candidates(client, ten);
      assert.deepEqual(stepsOf(rows, beforeSwitch), ["a1:series_off"]);
      assert.deepEqual(stepsOf(rows, afterSwitch), ["a1:due"]);
      await client.query(
        "UPDATE public.activation_series_state SET enabled_since = $1",
        [at(ten, -30 * DAY)]
      );
      const later = await candidates(client, ten);
      assert.deepEqual(stepsOf(later, almostExpired), ["a1:due"]);
      assert.deepEqual(stepsOf(later, expired), ["a1:expired", "a2:due"]);
    });
    tests.push(
      "the switch: nothing while the state is null or later than the clock; a step that fell due before the instant comes back series_off, one after it due; the validity: an a1 3 days past its trigger comes back expired, a minute less due"
    );

    // 6. the daily cap
    await scenario(async (client) => {
      const busy = await newStore(client, {
        billing: { state: "active", trial: false },
        createdAt: at(ten, -2 * DAY),
      });
      for (let index = 0; index < 63; index += 1) {
        const person = await newPerson(client);
        await client.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
          [busy.organizationId, person, at(ten, -DAY)]
        );
        await seedNotice(
          client,
          { organizationId: busy.organizationId, userId: person },
          "a1",
          seededOutcome(index),
          at(ten, -HOUR)
        );
      }
      const oldest = await newStore(client, { createdAt: at(ten, -27 * HOUR) });
      const middle = await newStore(client, { createdAt: at(ten, -26 * HOUR) });
      const newest = await newStore(client, { createdAt: at(ten, -25 * HOUR) });
      const lapsed = await newStore(client, { createdAt: at(ten, -5 * DAY) });
      const rows = await candidates(client, ten);
      assert.deepEqual(
        rows.map((row) => [row.organization_id, row.step, row.outcome]),
        [
          [lapsed.organizationId, "a1", "expired"],
          [lapsed.organizationId, "a2", "due"],
          [oldest.organizationId, "a1", "due"],
        ],
        "with 58 counted, 2 due by trigger order; the expired one does not count"
      );
      assert.ok(rows.every((row) => row.truncated));
      await withGateRole(client, BILLING_RUNTIME, async () => {
        for (const row of rows) {
          const recorded = await client.query<{ id: string }>(
            "INSERT INTO public.activation_notices (organization_id, user_id, step, due_at) VALUES ($1, $2, $3, $4) RETURNING id",
            [row.organization_id, row.user_id, row.step, row.due_at]
          );
          if (row.outcome !== "due") {
            await client.query(
              "UPDATE public.activation_notices SET skipped_reason = $2 WHERE id = $1",
              [recorded.rows[0]?.id, row.outcome]
            );
          }
        }
      });
      const capped = await candidates(client, at(ten, HOUR));
      assert.deepEqual(capped, [], "the cap holds for the rest of the day");
      const tomorrow = await candidates(client, at(ten, DAY));
      assert.deepEqual(
        tomorrow.map((row) => [row.organization_id, row.step, row.outcome]),
        [
          [middle.organizationId, "a1", "due"],
          [newest.organizationId, "a1", "due"],
        ],
        "the next day the rest comes back, in order"
      );
      assert.ok(tomorrow.every((row) => !row.truncated));
      const limited = await candidates(client, at(ten, DAY), 1);
      assert.deepEqual(
        limited.map((row) => [row.organization_id, row.truncated]),
        [[middle.organizationId, true]],
        "the batch: one, and more wait"
      );
    });
    tests.push(
      "the daily cap of 60: with 58 owed or sent recorded on the day of São Paulo and 5 skipped (not counted), the answer has 2 due in the order of their triggers, keeps the expired step outside the count, and says truncated; the billing role records them (owed, and the expired one skipped), the cap holds an hour later, the next day the other two come back in order, and a batch of 1 says that more wait"
    );

    // 7. the table: "@" refused, one notice per person and step, and the cascade accepted in the ADR
    await scenario(async (client) => {
      const firstStore = await newStore(client, {
        createdAt: at(ten, -3 * DAY),
      });
      const secondStore = await newStore(client, {
        createdAt: at(ten, -25 * HOUR),
        owner: firstStore.userId,
      });
      await withGateRole(client, BILLING_RUNTIME, async () => {
        await client.query("SAVEPOINT probe");
        await expectSqlState(
          () =>
            client.query(
              "INSERT INTO public.activation_notices (organization_id, user_id, step, due_at) VALUES ($1, $2, 'a1', now())",
              [firstStore.organizationId, "pessoa@example.invalid"]
            ),
          "23514",
          "an ID with @ is refused"
        );
        await client.query("ROLLBACK TO SAVEPOINT probe");
        await client.query(
          "INSERT INTO public.activation_notices (organization_id, user_id, step, due_at) VALUES ($1, $2, 'a1', now())",
          [firstStore.organizationId, firstStore.userId]
        );
        await client.query("SAVEPOINT probe");
        await expectSqlState(
          () =>
            client.query(
              "INSERT INTO public.activation_notices (organization_id, user_id, step, due_at) VALUES ($1, $2, 'a1', now())",
              [secondStore.organizationId, secondStore.userId]
            ),
          "23505",
          "the same person and step in a second store is refused"
        );
        await client.query("ROLLBACK TO SAVEPOINT probe");
        await client.query("SAVEPOINT probe");
        await expectSqlState(
          () =>
            client.query(
              "UPDATE public.activation_notices SET skipped_reason = 'a@b' WHERE user_id = $1",
              [firstStore.userId]
            ),
          "23514",
          "a reason with @ is refused"
        );
        await client.query("ROLLBACK TO SAVEPOINT probe");
      });
      assert.deepEqual(
        stepsOf(await candidates(client, ten), secondStore),
        [],
        "the second store of the person gets nothing"
      );
      await client.query(
        "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
        [firstStore.organizationId, firstStore.userId]
      );
      const left = await client.query(
        "SELECT 1 FROM public.activation_notices WHERE user_id = $1",
        [firstStore.userId]
      );
      assert.equal(left.rows.length, 0, "the notice went with the membership");
      assert.deepEqual(
        stepsOf(await candidates(client, ten), secondStore),
        ["a1:due"],
        "with the first membership gone, the next store is the first"
      );
    });
    tests.push(
      "activation_notices refuses an ID or a reason with @ (23514) and the same person and step in a second store (23505) from the billing role; the second store of a person gets nothing; the membership of the first store deleted takes its notice (cascade) and the next store becomes the person's first, the effect the ADR accepts"
    );

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
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Activation candidates PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
