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
 *   5. the switch and the validity: nothing while the state is null or later than the clock; every step of a store
 *      created before the switch went on comes back `series_off` (even one falling due after it), a store created at
 *      that very instant keeps its series, a step 3 days past its trigger comes back `expired`, a minute less `due`;
 *   6. the daily cap of 60 (with 58 recorded today, 5 skipped that do not count): 2 `due` and `truncated`, the skipped
 *      kinds still answered; another session cannot take its lock while the sweep's transaction is open; the billing
 *      role records them, and the next day the rest comes back in order; the day is São Paulo's from its midnight
 *      (the session in UTC), and a failed notice counts;
 *   7. the table itself: a notice whose ID carries "@" is refused, the same person and step in two stores is refused;
 *      and the effect accepted in the ADR: the membership of the first store deleted (and its notice with it), the
 *      next store of the person becomes a candidate.
 *   8. the recipient (migration 0128, AC-7a.1 to AC-7a.5): only its own role reads `"user".email` (not the series'
 *      nor the measure's); it reads neither session, sales, products nor privacy_cases, and holds exactly its columns;
 *      only the authentication runtime executes `activation_notice_recipient`; it answers the address of an owed notice
 *      of the verified oldest active owner of the store and null for every other case (sent, skipped, failed, not
 *      verified, co-owner, former owner, member who is not an owner, another store); its row security alone shows one
 *      notice, its store's owners and one person; and the policies on `"user"` are exactly the expected ones.
 *   9. the opt-out (migration 0129, AC-8a.4, AC-8a.5 and AC-8a.9): `activation_record_opt_out` is SECURITY DEFINER of the
 *      owner of the series, returns void and only inserts; only the billing runtime executes it (function by function,
 *      every `polaris_*` group and PUBLIC); no runtime nor PUBLIC holds any privilege on `email_opt_outs`, by table or
 *      by column; two calls are one row, an unknown or null person leaves no row and the same answer; and once recorded,
 *      the candidates answer nothing for the person in either of two stores, with the switch on and off.
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
const AUTH_RUNTIME = "polaris_auth_runtime";
const RECIPIENT_OWNER = "polaris_activation_recipient_owner";
const MEASURE_OWNER = "polaris_activation_owner";
const RECIPIENT_FUNCTION = "public.activation_notice_recipient(text, uuid)";
const OPT_OUT_FUNCTION = "public.activation_record_opt_out(text)";
const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DYNAMIC_SQL = /\bEXECUTE\b|\bformat\s*\(/i;
const OPT_OUT_INSERT =
  /INSERT INTO public\.email_opt_outs \(user_id\) VALUES \(p_user\)/;
const OPT_OUT_NO_UPDATE = /ON CONFLICT \(user_id\) DO NOTHING/;
const OPT_OUT_NARROW_CATCH = /EXCEPTION\s+WHEN\s+foreign_key_violation\s+THEN/;
const OTHERS = /\bOTHERS\b/i;
const READ_OR_CHANGE = /\bSELECT\b|\bUPDATE\b|\bDELETE\b|\bRETURNING\b/i;
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
          // the function must not lean on the session's zone: a database in São Paulo would hide a day of UTC
          await client.query("SET LOCAL TimeZone = 'UTC'");
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
      outcome: "owed" | "sent" | "skipped" | "failed",
      recordedAt: Date
    ) =>
      client.query(
        `INSERT INTO public.activation_notices (organization_id, user_id, step, due_at, recorded_at, sent_at, skipped_reason, failed_at, failure_code)
         VALUES ($1, $2, $3, $4, $4, CASE WHEN $5 = 'sent' THEN $4::timestamptz END, CASE WHEN $5 = 'skipped' THEN 'expired' END,
                 CASE WHEN $5 = 'failed' THEN $4::timestamptz END, CASE WHEN $5 = 'failed' THEN 'provider_refused' END)`,
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
      const windowStore = await newStore(client, {
        createdAt: at(ten, -30 * HOUR),
      });
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
      // on tomorrow's clock both stays visible to the role (14 days of the database's clock), so only the function decides
      const tomorrow = at(ten, DAY);
      const fourteen = await newStore(client, {
        createdAt: at(tomorrow, -14 * DAY),
        product: { at: at(tomorrow, -13 * DAY) },
      });
      await seedNotice(client, fourteen, "a2", "sent", at(ten, -9 * DAY));
      const almostFourteen = await newStore(client, {
        createdAt: at(tomorrow, -14 * DAY + MINUTE),
        product: { at: at(tomorrow, -13 * DAY) },
      });
      await seedNotice(client, almostFourteen, "a2", "sent", at(ten, -9 * DAY));
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
        ["never a 4th e-mail", allSent, []],
      ];
      for (const [label, store, steps] of expected) {
        assert.deepEqual(stepsOf(rows, store), steps, label);
      }
      const nextDay = await candidates(client, tomorrow);
      assert.deepEqual(
        stepsOf(nextDay, fourteen),
        [],
        "nothing for a store of exactly 14 days"
      );
      assert.deepEqual(
        stepsOf(nextDay, almostFourteen),
        ["a3:expired"],
        "a minute less than 14 days is still in"
      );
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
        assert.deepEqual(
          stepsOf(within, windowStore),
          open ? ["a1:due"] : [],
          `${label} of São Paulo is ${open ? "inside" : "outside"} the window`
        );
      }
    });
    tests.push(
      "the triggers on a clock fixed at 10:00 of São Paulo: a1 at 24:00 of the store and not at 23:59; a2 3 days after the oldest live product and not a minute before, on the 5th day (4 days) for a store still without one (a deleted product counts as none) and not a minute before; a3 on the 10th day only once the a2 went out (not skipped, not still owed); nothing for a store of exactly 14 days and an a3 for one a minute younger (on a clock one day ahead, where both are visible to the role), never a 4th e-mail; the window answers at 08:00 and 11:59 and nothing at 07:59 and 12:00"
    );

    // 5. the switch and the validity
    await scenario(async (client) => {
      const createdBefore = (hours: number) =>
        newStore(client, { createdAt: at(ten, -(24 + hours) * HOUR) });
      const beforeSwitch = await createdBefore(3);
      const afterSwitch = await createdBefore(1);
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
        [at(ten, -(24 + 2) * HOUR)]
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
      "the switch: nothing while the state is null or later than the clock; a step of a store created before the instant comes back series_off, one of a store created after it due; the validity: an a1 3 days past its trigger comes back expired, a minute less due"
    );

    await scenario(async (client) => {
      const madeWhileOff = await newStore(client, {
        createdAt: at(ten, -6 * DAY),
      });
      const madeWhileOffWithA2 = await newStore(client, {
        createdAt: at(ten, -11 * DAY),
        product: { at: at(ten, -10 * DAY) },
      });
      await seedNotice(
        client,
        madeWhileOffWithA2,
        "a2",
        "sent",
        at(ten, -7 * DAY)
      );
      const madeWhileOn = await newStore(client, {
        createdAt: at(ten, -(24 + 1) * HOUR),
      });
      const madeAtTheInstant = await newStore(client, {
        createdAt: at(ten, -3 * DAY),
      });
      await client.query(
        "UPDATE public.activation_series_state SET enabled_since = $1",
        [at(ten, -3 * DAY)]
      );
      const rows = await candidates(client, ten);
      assert.deepEqual(
        stepsOf(rows, madeWhileOff),
        ["a1:series_off", "a2:series_off"],
        "the a1 and the a2 of a store created before the switch went on, the a2 falling due after it, are series_off"
      );
      assert.deepEqual(
        stepsOf(rows, madeWhileOffWithA2),
        ["a3:series_off"],
        "the a3 falling due after the instant, of a store created before it, is series_off"
      );
      assert.deepEqual(
        stepsOf(rows, madeWhileOn),
        ["a1:due"],
        "a store created after the instant keeps its series"
      );
      assert.deepEqual(
        stepsOf(rows, madeAtTheInstant),
        ["a1:due"],
        "a store created at the very instant keeps its series"
      );
    });
    tests.push(
      "the switch is read from the creation of the store: a store created before the instant, with the a2 (or the a3 after a sent a2) falling due after it, comes back series_off at every step and never joins the series; a store created at or after the instant is due"
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
      const lockFree = await as(billingUrl, async (other) => {
        const probe = await other.query<{ free: boolean }>(
          "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('activation_notice_candidates', 0)) AS free"
        );
        return probe.rows[0]?.free;
      });
      assert.equal(
        lockFree,
        false,
        "the lock of the cap is held until the end of the sweep's transaction"
      );
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
      "the daily cap of 60: with 58 owed or sent recorded on the day of São Paulo and 5 skipped (not counted), the answer has 2 due in the order of their triggers, keeps the expired step outside the count, and says truncated; another session cannot take the lock of the cap while the sweep's transaction is open; the billing role records them (owed, and the expired one skipped), the cap holds an hour later, the next day the other two come back in order, and a batch of 1 says that more wait"
    );

    // 6b. the day of the cap is São Paulo's, from its midnight, and a failed notice counts
    await scenario(async (client) => {
      const dayStart = (
        await client.query<{ start: Date }>(
          `SELECT pg_catalog.date_trunc('day', $1::timestamptz AT TIME ZONE '${ZONE}') AT TIME ZONE '${ZONE}' AS start`,
          [ten]
        )
      ).rows[0]?.start;
      assert.ok(dayStart instanceof Date);
      const busy = await newStore(client, {
        billing: { state: "active", trial: false },
        createdAt: at(ten, -2 * DAY),
      });
      for (let index = 0; index < 60; index += 1) {
        const person = await newPerson(client);
        await client.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
          [busy.organizationId, person, at(ten, -DAY)]
        );
        const seeded = { organizationId: busy.organizationId, userId: person };
        await seedNotice(
          client,
          seeded,
          "a1",
          index < 20 ? "failed" : "sent",
          at(dayStart, -1000)
        );
      }
      const waiting = await newStore(client, {
        createdAt: at(ten, -25 * HOUR),
      });
      assert.deepEqual(
        stepsOf(await candidates(client, ten), waiting),
        ["a1:due"],
        "60 recorded a second before the midnight of São Paulo (the same day in UTC) do not count"
      );
      await client.query(
        "UPDATE public.activation_notices SET recorded_at = $1 WHERE organization_id = $2",
        [dayStart, busy.organizationId]
      );
      assert.deepEqual(
        await candidates(client, ten),
        [],
        "60 recorded from the midnight of São Paulo, 20 of them failed, reach the cap"
      );
    });
    tests.push(
      "the day of the cap is the one of São Paulo: 60 notices recorded a second before its midnight (the same day in UTC) leave the due a1 out of the count, and the same 60 from its midnight, 20 of them failed, reach the cap"
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

    // 8. the recipient of the series (0128, ADR 0106, D2): only its role reads the address, and only of one notice owed
    const recipientFunction = await owner.pool.query<{
      config: string[];
      definer: boolean;
      owner: string;
      source: string;
      volatility: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner, p.prosrc AS source,
              p.provolatile::text AS volatility
         FROM pg_catalog.pg_proc AS p WHERE p.oid = $1::regprocedure`,
      [RECIPIENT_FUNCTION]
    );
    const [recipientFn] = recipientFunction.rows;
    assert.ok(recipientFn);
    assert.equal(recipientFn.definer, true, "the recipient: SECURITY DEFINER");
    assert.equal(
      recipientFn.owner,
      RECIPIENT_OWNER,
      "the recipient is owned by its own role, never by the owner of the candidates"
    );
    assert.deepEqual(recipientFn.config, [
      "search_path=pg_catalog, public, pg_temp",
    ]);
    assert.doesNotMatch(recipientFn.source, DYNAMIC_SQL, "no dynamic SQL");
    assert.equal(recipientFn.volatility, "v", "volatile: no cache answers it");
    const addressReaders = await owner.pool.query<{
      role: string;
      email: boolean;
    }>(
      `SELECT r.role, pg_catalog.has_column_privilege(r.role, 'public."user"', 'email', 'SELECT') AS email
         FROM unnest($1::text[]) AS r (role)
        ORDER BY r.role COLLATE "C"`,
      [[RECIPIENT_OWNER, NOTICE_OWNER, MEASURE_OWNER]]
    );
    assert.deepEqual(
      addressReaders.rows,
      [
        { email: false, role: NOTICE_OWNER },
        { email: false, role: MEASURE_OWNER },
        { email: true, role: RECIPIENT_OWNER },
      ],
      'of the three roles of the series only the recipient\'s reads "user".email'
    );
    tests.push(
      'AC-7a.1: has_column_privilege on "user".email is true for polaris_activation_recipient_owner and false for polaris_activation_notice_owner (the series) and polaris_activation_owner (the measure)'
    );

    const forbidden = await owner.pool.query<{ reach: string }>(
      `SELECT t.name || ':' || CASE
                WHEN pg_catalog.has_table_privilege($1, 'public.' || t.name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN 'table'
                WHEN pg_catalog.has_any_column_privilege($1, 'public.' || t.name, 'SELECT, INSERT, UPDATE, REFERENCES') THEN 'column'
                ELSE 'none' END AS reach
         FROM unnest(ARRAY['session', 'sales', 'products', 'privacy_cases']) AS t (name)
        ORDER BY t.name COLLATE "C"`,
      [RECIPIENT_OWNER]
    );
    assert.deepEqual(
      forbidden.rows.map((row) => row.reach),
      ["privacy_cases:none", "products:none", "sales:none", "session:none"],
      "the recipient's owner reads neither session, sales, products nor privacy_cases, not even one column"
    );
    const recipientColumns = await owner.pool.query<{ entry: string }>(
      `SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
         FROM information_schema.column_privileges AS c
        WHERE c.grantee = $1
        ORDER BY c.table_name || '.' || c.column_name || ':' || c.privilege_type COLLATE "C"`,
      [RECIPIENT_OWNER]
    );
    assert.deepEqual(
      recipientColumns.rows.map((row) => row.entry),
      [
        "activation_notices.failed_at:SELECT",
        "activation_notices.id:SELECT",
        "activation_notices.organization_id:SELECT",
        "activation_notices.sent_at:SELECT",
        "activation_notices.skipped_reason:SELECT",
        "activation_notices.user_id:SELECT",
        "memberships.created_at:SELECT",
        "memberships.organization_id:SELECT",
        "memberships.role:SELECT",
        "memberships.status:SELECT",
        "memberships.user_id:SELECT",
        "user.email:SELECT",
        "user.email_verified:SELECT",
        "user.id:SELECT",
      ],
      "the recipient's owner holds exactly its columns"
    );
    const recipientTables = await owner.pool.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE grantee = $1",
      [RECIPIENT_OWNER]
    );
    assert.equal(
      recipientTables.rows.length,
      0,
      "the recipient's owner holds no table privilege"
    );
    tests.push(
      'AC-7a.2: polaris_activation_recipient_owner has no table nor column privilege on session, sales, products or privacy_cases, no table privilege at all, and exactly 14 SELECT columns of activation_notices, memberships and "user" (id, email, email_verified)'
    );

    const recipientExecutors = await owner.pool.query<{ role: string }>(
      `SELECT r.role FROM (
         SELECT 'public' AS role
         UNION ALL SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'polaris\\_%' AND NOT rolcanlogin
       ) AS r
        WHERE pg_catalog.has_function_privilege(r.role, $1, 'EXECUTE')
        ORDER BY r.role COLLATE "C"`,
      [RECIPIENT_FUNCTION]
    );
    assert.deepEqual(
      recipientExecutors.rows.map((row) => row.role),
      [RECIPIENT_OWNER, AUTH_RUNTIME],
      "only the authentication runtime executes the recipient (and its owner)"
    );
    const recipientAcl = await owner.pool.query<{ grantee: string }>(
      `SELECT DISTINCT a.grantee::regrole::text AS grantee
         FROM pg_catalog.pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
        WHERE p.oid = $1::regprocedure
        ORDER BY 1`,
      [RECIPIENT_FUNCTION]
    );
    assert.deepEqual(
      recipientAcl.rows.map((row) => row.grantee),
      [RECIPIENT_OWNER, AUTH_RUNTIME],
      "the ACL of the recipient names only its owner and the authentication runtime (no login role, no default privilege)"
    );
    const authUrl = await login(AUTH_RUNTIME, "polaris_candidates_auth");
    for (const [url, role] of [
      [tenantUrl, runtimeRole],
      [billingUrl, BILLING_RUNTIME],
    ] as const) {
      await as(url, async (client) => {
        await setLoginRole(client, role, "session");
        await expectSqlState(
          () =>
            client.query(
              "SELECT public.activation_notice_recipient('x', gen_random_uuid())"
            ),
          "42501",
          `${role} does not execute the recipient`
        );
      });
    }
    await as(authUrl, async (client) => {
      await setLoginRole(client, AUTH_RUNTIME, "session");
      const answer = await client.query<{ address: string | null }>(
        "SELECT public.activation_notice_recipient('x', gen_random_uuid()) AS address"
      );
      assert.equal(answer.rows[0]?.address, null, "an unknown notice is null");
    });
    tests.push(
      "AC-7a.3: activation_notice_recipient is SECURITY DEFINER of polaris_activation_recipient_owner (not the owner of the candidates), volatile, with search_path pg_catalog, public, pg_temp and no dynamic SQL; of PUBLIC and every polaris_* group only the authentication runtime executes it (and its owner), and its ACL names no one else; a tenant login and a billing login are refused (42501), an authentication login gets null for an unknown notice"
    );

    await scenario(async (client) => {
      const created = at(ten, -25 * HOUR);
      const store = (spec: Partial<StoreSpec> = {}) =>
        newStore(client, { createdAt: created, ...spec });
      const owed = await store();
      const attempted = await store();
      const sent = await store();
      const skipped = await store();
      const failed = await store();
      const unverified = await store({ verified: false });
      const shared = await store();
      const coOwner = await newPerson(client);
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [shared.organizationId, coOwner, at(created, MINUTE)]
      );
      const sharedCoOwner: Store = {
        organizationId: shared.organizationId,
        userId: coOwner,
      };
      const departed = await store();
      const nowSeller = await store();
      const leftFounder = await store();
      const successor = await newPerson(client);
      await client.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [leftFounder.organizationId, successor, at(created, MINUTE)]
      );
      const leftSuccessor: Store = {
        organizationId: leftFounder.organizationId,
        userId: successor,
      };
      const removed = await store();
      const outcomes: [Store, "owed" | "sent" | "skipped" | "failed"][] = [
        [owed, "owed"],
        [attempted, "owed"],
        [sent, "sent"],
        [skipped, "skipped"],
        [failed, "failed"],
        [unverified, "owed"],
        [shared, "owed"],
        [sharedCoOwner, "owed"],
        [departed, "owed"],
        [nowSeller, "owed"],
        [leftFounder, "owed"],
        [leftSuccessor, "owed"],
        [removed, "owed"],
      ];
      const noticeOf = new Map<Store, string>();
      for (const [notified, outcome] of outcomes) {
        await seedNotice(client, notified, "a1", outcome, at(ten, -HOUR));
        const id = await client.query<{ id: string }>(
          "SELECT id FROM public.activation_notices WHERE organization_id = $1 AND user_id = $2",
          [notified.organizationId, notified.userId]
        );
        noticeOf.set(notified, String(id.rows[0]?.id));
      }
      await client.query(
        "UPDATE public.activation_notices SET first_attempted_at = $2, last_attempted_at = $2 WHERE id = $1",
        [noticeOf.get(attempted), at(ten, -30 * MINUTE)]
      );
      // the memberships hold only active owners today; the function and the policies still read role and status, so the
      // two checks are lifted in this transaction (rolled back) to prove a former owner and a member who is not one
      await client.query(
        "ALTER TABLE public.memberships DROP CONSTRAINT memberships_role_check, DROP CONSTRAINT memberships_status_check"
      );
      await client.query(
        "UPDATE public.memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2",
        [departed.organizationId, departed.userId]
      );
      await client.query(
        "UPDATE public.memberships SET role = 'seller' WHERE organization_id = $1 AND user_id = $2",
        [nowSeller.organizationId, nowSeller.userId]
      );
      await client.query(
        "UPDATE public.memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2",
        [leftFounder.organizationId, leftFounder.userId]
      );
      const removedNotice = noticeOf.get(removed);
      await client.query(
        "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
        [removed.organizationId, removed.userId]
      );
      const addressOf = async (
        organizationId: string | null,
        notice: string | null | undefined
      ) =>
        withGateRole(client, AUTH_RUNTIME, async () => {
          const answer = await client.query<{ address: string | null }>(
            "SELECT public.activation_notice_recipient($1, $2) AS address",
            [organizationId, notice ?? null]
          );
          const scope = await client.query<{ scope: string | null }>(
            "SELECT pg_catalog.current_setting('app.owner_scope.activation_notice_recipient_notice_id', true) AS scope"
          );
          assert.ok(
            !scope.rows[0]?.scope,
            "the function leaves no scope in the caller's transaction"
          );
          return answer.rows[0]?.address ?? null;
        });
      const emailOf = (person: string) =>
        `candidates-${person}@example.invalid`;
      const cases: [string, Store, string | null][] = [
        ["an owed notice of the verified founder", owed, emailOf(owed.userId)],
        [
          "an owed notice already tried once",
          attempted,
          emailOf(attempted.userId),
        ],
        ["a sent notice", sent, null],
        ["a skipped notice", skipped, null],
        ["a failed notice", failed, null],
        ["a person whose e-mail is not verified", unverified, null],
        ["the founder of a shared store", shared, emailOf(shared.userId)],
        ["a co-owner who is not the oldest owner", sharedCoOwner, null],
        ["an owner who is no longer active", departed, null],
        ["a member who is not an owner", nowSeller, null],
        ["a founder who left the store", leftFounder, null],
        [
          "the oldest owner still active after the founder left",
          leftSuccessor,
          emailOf(successor),
        ],
      ];
      for (const [name, notified, expected] of cases) {
        assert.equal(
          await addressOf(notified.organizationId, noticeOf.get(notified)),
          expected,
          name
        );
      }
      assert.equal(
        await addressOf(removed.organizationId, removedNotice),
        null,
        "an owner whose membership was deleted (the notice went with it)"
      );
      assert.equal(
        await addressOf(sent.organizationId, noticeOf.get(owed)),
        null,
        "a notice asked with another store"
      );
      assert.equal(
        await addressOf(owed.organizationId, randomUUID()),
        null,
        "a notice that does not exist"
      );
      assert.equal(await addressOf(null, null), null, "null arguments");
      tests.push(
        "AC-7a.4: called by the authentication runtime, activation_notice_recipient answers the address of an owed notice of the verified founder (also after an attempt, and of the oldest active owner once the founder left), and null for a sent, skipped or failed notice, an unverified e-mail, a co-owner who is not the oldest, an owner no longer active, a member who is not an owner, a founder who left, a deleted membership, another store, an unknown notice and null arguments; it leaves no scope in the caller's transaction"
      );

      // the row security alone, without the function: what the owner sees with no scope, the scope of an owed notice
      // of a shared store, of a sent one and of an unverified person
      const sees = (scope: string | undefined) =>
        withGateRole(client, RECIPIENT_OWNER, async () => {
          await client.query(
            "SELECT pg_catalog.set_config('app.owner_scope.activation_notice_recipient_notice_id', $1, true)",
            [scope ?? ""]
          );
          const rows = await client.query<{
            members: string;
            notices: string;
            users: string[];
          }>(
            `SELECT (SELECT count(*) FROM public.activation_notices)::text AS notices,
                    (SELECT count(*) FROM public.memberships)::text AS members,
                    ARRAY(SELECT u.id FROM public."user" AS u ORDER BY u.id) AS users`
          );
          await client.query(
            "SELECT pg_catalog.set_config('app.owner_scope.activation_notice_recipient_notice_id', '', true)"
          );
          return rows.rows[0];
        });
      assert.deepEqual(
        await sees(undefined),
        { members: "0", notices: "0", users: [] },
        "no scope, nothing"
      );
      assert.deepEqual(
        await sees(noticeOf.get(shared)),
        { members: "2", notices: "1", users: [shared.userId] },
        "the scope of an owed notice: that notice, the two owners of its store and only its person"
      );
      assert.deepEqual(
        await sees(noticeOf.get(sharedCoOwner)),
        { members: "2", notices: "1", users: [] },
        "the scope of a co-owner's notice: not the co-owner's row"
      );
      assert.deepEqual(
        await sees(noticeOf.get(sent)),
        { members: "0", notices: "0", users: [] },
        "the scope of a sent notice: nothing"
      );
      for (const [name, notified] of [
        ["failed", failed],
        ["skipped", skipped],
      ] as const) {
        assert.deepEqual(
          await sees(noticeOf.get(notified)),
          { members: "0", notices: "0", users: [] },
          `the scope of a ${name} notice: nothing`
        );
      }
      for (const [name, notified] of [
        ["an owner no longer active", departed],
        ["a member who is not an owner", nowSeller],
      ] as const) {
        assert.deepEqual(
          await sees(noticeOf.get(notified)),
          { members: "0", notices: "1", users: [] },
          `the scope of the notice of ${name}: neither that membership nor that person`
        );
      }
      assert.deepEqual(
        await sees(noticeOf.get(unverified)),
        { members: "1", notices: "1", users: [] },
        "the scope of an unverified person: not that person's row"
      );
      await withGateRole(client, RECIPIENT_OWNER, async () => {
        await client.query("SAVEPOINT probe");
        await expectSqlState(
          () => client.query("SELECT count(*) FROM public.session"),
          "42501",
          "the recipient's owner does not read the sessions"
        );
        await client.query("ROLLBACK TO SAVEPOINT probe");
      });
    });
    tests.push(
      "the row security of the recipient's owner on its own: with no scope it sees no notice, owner nor \"user\" row; with the scope of an owed notice, that notice, the active owners of its store and only its person (none for a co-owner's notice or an unverified person; no membership nor person for an owner no longer active or a member who is not an owner; nothing for a sent, failed or skipped notice); it does not read session (42501)"
    );

    const userPolicies = await owner.pool.query<{ entry: string }>(
      `SELECT r.role || ':' || COALESCE((
                SELECT pg_catalog.string_agg(p.policyname, ',' ORDER BY p.policyname COLLATE "C")
                  FROM pg_catalog.pg_policies AS p
                 WHERE p.schemaname = 'public' AND p.tablename = 'user' AND r.role = ANY (p.roles)
              ), '-') AS entry
         FROM unnest($1::text[]) AS r (role)
        ORDER BY r.role COLLATE "C"`,
      [
        [
          RECIPIENT_OWNER,
          NOTICE_OWNER,
          MEASURE_OWNER,
          runtimeRole,
          BILLING_RUNTIME,
          "polaris_catalog_runtime",
          "polaris_admin_runtime",
          "public",
        ],
      ]
    );
    assert.deepEqual(
      userPolicies.rows.map((row) => row.entry),
      [
        "polaris_activation_notice_owner:user_activation_notice_owner_select_recent_owner",
        "polaris_activation_owner:-",
        "polaris_activation_recipient_owner:user_activation_recipient_owner_select",
        "polaris_admin_runtime:-",
        "polaris_billing_runtime:-",
        "polaris_catalog_runtime:-",
        "polaris_pr11_runtime:-",
        "public:-",
      ],
      'the policies on "user": one of the recipient\'s owner, the one of 0124 of the series, none of the measure, the tenant, billing, catalog, Admin runtime nor PUBLIC'
    );
    const recipientPolicies = await owner.pool.query<{ entry: string }>(
      `SELECT p.tablename || '.' || p.policyname || ':' || p.cmd AS entry
         FROM pg_catalog.pg_policies AS p
        WHERE $1 = ANY (p.roles)
        ORDER BY p.tablename || '.' || p.policyname COLLATE "C"`,
      [RECIPIENT_OWNER]
    );
    assert.deepEqual(
      recipientPolicies.rows.map((row) => row.entry),
      [
        "activation_notices.activation_notices_recipient_owner_select_owed:SELECT",
        "memberships.memberships_activation_recipient_owner_select_owner:SELECT",
        "user.user_activation_recipient_owner_select:SELECT",
      ],
      "the recipient's owner has exactly its three policies, all SELECT"
    );
    tests.push(
      "AC-7a.5: on \"user\" the recipient's owner has exactly one policy (user_activation_recipient_owner_select); the owner of the series keeps only its policy of 0124 (and no grant on email); the measure, the tenant, billing, catalog and Admin runtimes and PUBLIC have none; the recipient's owner has exactly three policies, all SELECT"
    );

    // 9. the opt-out (migration 0129, AC-8a.4, AC-8a.5 and AC-8a.9): one function writes it, no runtime touches the table
    const optOutDefinition = await owner.pool.query<{
      config: string[];
      definer: boolean;
      owner: string;
      returns: string;
      source: string;
      volatility: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner, p.prosrc AS source,
              p.provolatile::text AS volatility, p.prorettype::regtype::text AS returns
         FROM pg_catalog.pg_proc AS p WHERE p.oid = $1::regprocedure`,
      [OPT_OUT_FUNCTION]
    );
    const [optOutFn] = optOutDefinition.rows;
    assert.ok(optOutFn);
    assert.equal(optOutFn.definer, true, "SECURITY DEFINER");
    assert.equal(
      optOutFn.owner,
      NOTICE_OWNER,
      "owned by the owner of the series"
    );
    assert.deepEqual(optOutFn.config, [
      "search_path=pg_catalog, public, pg_temp",
    ]);
    assert.doesNotMatch(optOutFn.source, DYNAMIC_SQL, "no dynamic SQL");
    assert.equal(optOutFn.volatility, "v", "volatile: it writes");
    assert.equal(optOutFn.returns, "void", "it answers nothing");
    assert.match(optOutFn.source, OPT_OUT_INSERT, "it inserts the person");
    assert.match(optOutFn.source, OPT_OUT_NO_UPDATE, "a repeat does nothing");
    assert.match(
      optOutFn.source,
      OPT_OUT_NARROW_CATCH,
      "it swallows the refusal of the foreign key"
    );
    assert.doesNotMatch(
      optOutFn.source,
      OTHERS,
      "and no other error: a malformed person or a missing grant still fails"
    );
    assert.doesNotMatch(
      optOutFn.source,
      READ_OR_CHANGE,
      "it reads nothing, changes no row and returns no row"
    );
    const optOutReach = await owner.pool.query<{
      entry: string;
    }>(
      `SELECT r.role || ':' || CASE WHEN pg_catalog.has_function_privilege(r.role, $1, 'EXECUTE') THEN 'execute' ELSE '-' END AS entry
         FROM (
           SELECT 'public' AS role
           UNION ALL SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname LIKE 'polaris\\_%' AND NOT rolcanlogin
         ) AS r
        WHERE pg_catalog.has_function_privilege(r.role, $1, 'EXECUTE')`,
      [OPT_OUT_FUNCTION]
    );
    assert.deepEqual(
      optOutReach.rows.map((row) => row.entry).sort(),
      [`${NOTICE_OWNER}:execute`, `${BILLING_RUNTIME}:execute`],
      "of PUBLIC and every polaris_* group only the billing runtime executes it (and its owner)"
    );
    const optOutAcl = await owner.pool.query<{ role: string }>(
      `SELECT DISTINCT a.grantee::regrole::text AS role
         FROM pg_catalog.pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
        WHERE p.oid = $1::regprocedure`,
      [OPT_OUT_FUNCTION]
    );
    assert.deepEqual(
      optOutAcl.rows.map((row) => row.role).sort(),
      [NOTICE_OWNER, BILLING_RUNTIME],
      "the ACL of the opt-out names only its owner and the billing runtime (no login role, no default privilege)"
    );
    const runtimes = await owner.pool.query<{ role: string }>(
      `SELECT rolname::text AS role FROM pg_catalog.pg_roles
        WHERE rolname LIKE 'polaris\\_%\\_runtime' AND NOT rolcanlogin
        ORDER BY rolname COLLATE "C"`
    );
    const runtimeRoles = runtimes.rows.map((row) => row.role);
    for (const expected of [
      BILLING_RUNTIME,
      AUTH_RUNTIME,
      runtimeRole,
      "polaris_admin_runtime",
      "polaris_catalog_runtime",
      "polaris_outbox_runtime",
      "polaris_privacy_runtime",
    ]) {
      assert.ok(runtimeRoles.includes(expected), `${expected} is checked`);
    }
    const optOutTableReach = await owner.pool.query<{ entry: string }>(
      `SELECT r.role || ':' || k.privilege || ':' || CASE WHEN k.column_name IS NULL
                THEN pg_catalog.has_table_privilege(r.role, 'public.email_opt_outs', k.privilege)::text
                ELSE pg_catalog.has_column_privilege(r.role, 'public.email_opt_outs', k.column_name, k.privilege)::text END
              || COALESCE(':' || k.column_name, '') AS entry
         FROM unnest($1::text[]) AS r (role)
        CROSS JOIN (
          SELECT p.privilege, NULL::text AS column_name
            FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p (privilege)
          UNION ALL
          SELECT p.privilege, c.column_name
            FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p (privilege)
           CROSS JOIN unnest(ARRAY['user_id', 'opted_out_at']) AS c (column_name)
        ) AS k`,
      [["public", ...runtimeRoles]]
    );
    const granted = optOutTableReach.rows
      .map((row) => row.entry)
      .filter((entry) => entry.includes(":true"));
    assert.equal(
      optOutTableReach.rows.length,
      (runtimeRoles.length + 1) * 15,
      "every runtime and PUBLIC, every privilege, by table and by column"
    );
    assert.deepEqual(
      granted,
      [],
      "no runtime nor PUBLIC reads or writes email_opt_outs directly, not even one column"
    );
    const others = await owner.pool.query<{ role: string }>(
      `SELECT r.rolname::text AS role FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\\_%' AND NOT r.rolcanlogin AND r.rolname <> $1
          AND (pg_catalog.has_table_privilege(r.oid, 'public.email_opt_outs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid, 'public.email_opt_outs', 'SELECT, INSERT, UPDATE, REFERENCES'))`,
      [NOTICE_OWNER]
    );
    assert.deepEqual(
      others.rows.map((row) => row.role).sort(),
      [],
      "of the polaris_* groups only the owner of the series reaches email_opt_outs"
    );
    const optOutOwnerColumns = await owner.pool.query<{ entry: string }>(
      `SELECT c.column_name || ':' || c.privilege_type AS entry
         FROM information_schema.column_privileges AS c
        WHERE c.grantee = $1 AND c.table_name = 'email_opt_outs'`,
      [NOTICE_OWNER]
    );
    assert.deepEqual(
      optOutOwnerColumns.rows.map((row) => row.entry).sort(),
      ["user_id:INSERT", "user_id:SELECT"],
      "the owner of the series inserts and reads only the person, and never updates nor deletes"
    );
    const optOutAclRoles = await owner.pool.query<{ role: string }>(
      `SELECT DISTINCT a.grantee::regrole::text AS role
         FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
        WHERE c.oid = 'public.email_opt_outs'::regclass AND a.grantee <> c.relowner
        UNION
       SELECT DISTINCT a.grantee::regrole::text
         FROM pg_catalog.pg_attribute AS t, pg_catalog.aclexplode(t.attacl) AS a
        WHERE t.attrelid = 'public.email_opt_outs'::regclass AND t.attacl IS NOT NULL`
    );
    assert.deepEqual(
      optOutAclRoles.rows.map((row) => row.role).sort(),
      [NOTICE_OWNER],
      "the ACL of email_opt_outs, by table and by column, names no one but the owner of the series (no login role, no PUBLIC)"
    );
    const ownerMembership = await owner.pool.query<{
      attributes: boolean;
      members: string;
      memberOf: string;
    }>(
      `SELECT (SELECT count(*) FROM pg_catalog.pg_auth_members AS m
                WHERE m.roleid = $1::regrole AND (m.set_option OR m.inherit_option))::text AS members,
              (SELECT count(*) FROM pg_catalog.pg_auth_members AS m WHERE m.member = $1::regrole)::text AS "memberOf",
              (SELECT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit
                 FROM pg_catalog.pg_roles WHERE oid = $1::regrole) AS attributes`,
      [NOTICE_OWNER]
    );
    assert.deepEqual(
      ownerMembership.rows[0],
      { attributes: false, memberOf: "0", members: "0" },
      "no role can SET or INHERIT the owner of the series (it would write email_opt_outs past the function), it is a member of no role, and it has no LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION nor INHERIT"
    );
    const optOutPolicies = await owner.pool.query<{ entry: string }>(
      `SELECT p.policyname || ':' || p.cmd || ':' || pg_catalog.array_to_string(p.roles, ',') AS entry
         FROM pg_catalog.pg_policies AS p
        WHERE p.schemaname = 'public' AND p.tablename = 'email_opt_outs'`
    );
    assert.deepEqual(
      optOutPolicies.rows.map((row) => row.entry).sort(),
      [
        `email_opt_outs_billing_runtime_select:SELECT:${BILLING_RUNTIME}`,
        `email_opt_outs_owner_insert:INSERT:${NOTICE_OWNER}`,
        `email_opt_outs_owner_select:SELECT:${NOTICE_OWNER}`,
      ],
      "the policies of email_opt_outs: the owner's insert of 0129 and the two reads of 0124 (the billing one with no grant behind it)"
    );
    await as(billingUrl, async (client) => {
      await setLoginRole(client, BILLING_RUNTIME, "session");
      for (const [statement, label] of [
        ["SELECT count(*) FROM public.email_opt_outs", "SELECT"],
        ["INSERT INTO public.email_opt_outs (user_id) VALUES ('x')", "INSERT"],
        [
          "UPDATE public.email_opt_outs SET opted_out_at = now() WHERE false",
          "UPDATE",
        ],
        ["DELETE FROM public.email_opt_outs WHERE false", "DELETE"],
      ] as const) {
        await expectSqlState(
          () => client.query(statement),
          "42501",
          `a billing login is refused a direct ${label} on email_opt_outs`
        );
      }
      const unknown = await client.query(
        "SELECT public.activation_record_opt_out($1)",
        [`gate-unknown-${randomUUID()}`]
      );
      assert.deepEqual(
        unknown.rows,
        [{ activation_record_opt_out: "" }],
        "a billing login records a person that does not exist with no error and no answer"
      );
      await expectSqlState(
        () =>
          client.query("SELECT public.activation_record_opt_out($1)", [
            "pessoa@malformada",
          ]),
        "23514",
        "a malformed person is refused by the table's check, whoever exists: only the foreign key is swallowed"
      );
    });
    for (const [url, role] of [
      [tenantUrl, runtimeRole],
      [authUrl, AUTH_RUNTIME],
    ] as const) {
      await as(url, async (client) => {
        await setLoginRole(client, role, "session");
        await expectSqlState(
          () =>
            client.query("SELECT public.activation_record_opt_out($1)", [
              randomUUID(),
            ]),
          "42501",
          `${role} does not execute the opt-out`
        );
        await expectSqlState(
          () => client.query("SELECT count(*) FROM public.email_opt_outs"),
          "42501",
          `${role} does not read email_opt_outs`
        );
      });
    }
    tests.push(
      "AC-8a.5 and AC-8a.9: activation_record_opt_out is SECURITY DEFINER of polaris_activation_notice_owner, volatile, with search_path pg_catalog, public, pg_temp, no dynamic SQL, returns void and only inserts (ON CONFLICT DO NOTHING, no SELECT, UPDATE, DELETE nor RETURNING in its body); has_function_privilege role by role: of PUBLIC and every polaris_* group only the billing runtime executes it (and its owner), and its ACL names no one else; has_table_privilege and has_column_privilege (user_id, opted_out_at) are false for SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER for PUBLIC and every polaris_*_runtime; of the polaris_* groups only the owner of the series reaches the table, with INSERT and SELECT of user_id only; the ACL of the table names only the owner of the series; no role can SET or INHERIT that owner, which has no login nor bypass; a billing login is refused a direct SELECT, INSERT, UPDATE and DELETE (42501), calls the function for an unknown person with no error and no answer, and gets 23514 for a malformed person (only the foreign key is swallowed); a tenant and an authentication login are refused the function and the table (42501)"
    );

    await scenario(async (client) => {
      const optOutsOf = async (userId: string) =>
        (
          await client.query<{ opted_out_at: Date }>(
            "SELECT opted_out_at FROM public.email_opt_outs WHERE user_id = $1",
            [userId]
          )
        ).rows;
      const record = (userId: string | null) =>
        withGateRole(client, BILLING_RUNTIME, async () => {
          const answer = await client.query(
            "SELECT public.activation_record_opt_out($1)",
            [userId]
          );
          return {
            fields: answer.fields.map((f) => f.name),
            rows: answer.rows,
          };
        });
      const person = await newPerson(client);
      const first = await record(person);
      const again = await record(person);
      assert.deepEqual(
        (await optOutsOf(person)).length,
        1,
        "two calls, one row"
      );
      const earlier = await newPerson(client);
      const earlierAt = at(databaseNow, -DAY);
      await client.query(
        "INSERT INTO public.email_opt_outs (user_id, opted_out_at) VALUES ($1, $2)",
        [earlier, earlierAt]
      );
      const repeated = await record(earlier);
      assert.deepEqual(
        (await optOutsOf(earlier)).map((row) => row.opted_out_at.getTime()),
        [earlierAt.getTime()],
        "a repeat keeps the first instant"
      );
      const missing = `gate-missing-${randomUUID()}`;
      const unknown = await record(missing);
      assert.deepEqual(
        await optOutsOf(missing),
        [],
        "no row for a person that does not exist"
      );
      const empty = await record(null);
      const expected = {
        fields: ["activation_record_opt_out"],
        rows: [{ activation_record_opt_out: "" }],
      };
      for (const [label, answer] of [
        ["a new person", first],
        ["the same person again", again],
        ["a person already recorded earlier", repeated],
        ["a person that does not exist", unknown],
        ["a null person", empty],
      ] as const) {
        assert.deepEqual(answer, expected, `the same answer for ${label}`);
      }
      const after = await client.query<{ ok: number }>("SELECT 1 AS ok");
      assert.equal(
        after.rows[0]?.ok,
        1,
        "the caller's transaction is still usable after an unknown person"
      );
    });
    tests.push(
      "activation_record_opt_out called by the billing runtime: two calls are one row; a repeat keeps the first instant; a person that does not exist and a null person leave no row, raise nothing and leave the caller's transaction usable; the answer (columns and value) is the same for a new person, a repeat, an earlier opt-out, an unknown person and null"
    );

    // AC-8a.4: once recorded, no notice of the person is born, in any of their stores, with the switch on or off;
    // a control person with the same two stores shows what the opted-out one would have got
    const switchModes = [
      ["on", at(ten, -30 * DAY), at(ten, -30 * DAY)],
      ["off when recorded, then on", null, at(ten, -30 * DAY)],
      ["turned on after the stores were created", at(ten, -25 * HOUR), null],
    ] as const;
    for (const [mode, whenRecorded, afterwards] of switchModes) {
      await scenario(async (client) => {
        const setSwitch = (since: Date | null) =>
          client.query(
            "UPDATE public.activation_series_state SET enabled_since = $1",
            [since]
          );
        await setSwitch(whenRecorded);
        const pairOf = async () => {
          const first = await newStore(client, {
            createdAt: at(ten, -30 * HOUR),
          });
          const second = await newStore(client, {
            createdAt: at(ten, -28 * HOUR),
            owner: first.userId,
          });
          return { first, second };
        };
        const control = await pairOf();
        const opted = await pairOf();
        const expectOwed = (steps: string[], label: string) => {
          if (afterwards === null) {
            assert.ok(
              steps.length > 0 &&
                steps.every((step) => step.endsWith(":series_off")),
              `${label}: every step series_off (${steps.join(", ")})`
            );
          } else {
            assert.deepEqual(steps, ["a1:due"], label);
          }
        };
        const before = await candidates(client, ten);
        if (whenRecorded === null) {
          assert.deepEqual(
            before,
            [],
            "nothing at all while the switch is off"
          );
        } else {
          expectOwed(
            stepsOf(before, opted.first),
            `${mode}: before the opt-out the person's first store is a candidate`
          );
        }
        await withGateRole(client, BILLING_RUNTIME, () =>
          client.query("SELECT public.activation_record_opt_out($1)", [
            opted.first.userId,
          ])
        );
        if (afterwards !== null) {
          await setSwitch(afterwards);
        }
        const after = await candidates(client, ten);
        expectOwed(
          stepsOf(after, control.first),
          `${mode}: the control person's first store`
        );
        assert.deepEqual(
          stepsOf(after, opted.first),
          [],
          `${mode}: nothing for the first store of the person who opted out`
        );
        assert.deepEqual(
          stepsOf(after, opted.second),
          [],
          `${mode}: nothing for their second store`
        );
        for (const person of [control, opted]) {
          await client.query(
            "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
            [person.first.organizationId, person.first.userId]
          );
        }
        const withoutFirst = await candidates(client, ten);
        expectOwed(
          stepsOf(withoutFirst, control.second),
          `${mode}: the control person's second store, now their first`
        );
        assert.deepEqual(
          stepsOf(withoutFirst, opted.second),
          [],
          `${mode}: the second store of the person who opted out, now their first, still gets nothing`
        );
        assert.ok(
          !withoutFirst.some((row) => row.user_id === opted.first.userId),
          `${mode}: no row of the person who opted out at all`
        );
      });
    }
    tests.push(
      "AC-8a.4 (the database's part): after the billing runtime records the opt-out of a person with two stores, activation_notice_candidates answers no step of that person in either store, also once the first store's membership is gone and the second becomes their first, while a control person with the same two stores gets the a1 in the first and then in the second; with the switch on, off when the opt-out is recorded and turned on afterwards, and turned on after the stores were created (the control's steps come back series_off, the person's not at all). Turning an already owed notice into skipped: opted_out at send time is the consumer's (7c)"
    );

    // 9. the outbox of the billing role for the series (0130): an `activation.notice` of a notice of the same store, and
    // nothing else; `billing.notice` still asks for a `billing_notices` row and `activation.notice` does not pass by it
    await scenario(async (client) => {
      const store = await newStore(client, { createdAt: at(ten, -3 * DAY) });
      const other = await newStore(client, { createdAt: at(ten, -3 * DAY) });
      await seedNotice(client, store, "a1", "owed", ten);
      await seedNotice(client, other, "a1", "owed", ten);
      const noticeOf = async (of: Store) =>
        String(
          (
            await client.query<{ id: string }>(
              "SELECT id FROM public.activation_notices WHERE organization_id = $1 AND user_id = $2",
              [of.organizationId, of.userId]
            )
          ).rows[0]?.id
        );
      const noticeId = await noticeOf(store);
      const otherNoticeId = await noticeOf(other);
      const billingNoticeId = String(
        (
          await client.query<{ id: string }>(
            `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at)
             VALUES ($1, 'trial_started', $2, now()) RETURNING id`,
            [store.organizationId, `ref-${randomUUID()}`]
          )
        ).rows[0]?.id
      );
      const insertEvent = (
        organizationId: string,
        type: string,
        event: unknown,
        key: string,
        extra = ""
      ) =>
        client.query(
          `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id${extra ? `, ${extra.split("=")[0]}` : ""})
           VALUES ($1, $2, $3::jsonb, $4, $5${extra ? `, ${extra.split("=")[1]}` : ""})`,
          [organizationId, type, JSON.stringify(event), key, randomUUID()]
        );
      const refused: [string, () => Promise<unknown>][] = [
        [
          "a notice that does not exist",
          () => {
            const missing = randomUUID();
            return insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId: missing },
              `activation.notice:${missing}`
            );
          },
        ],
        [
          "the notice of another store",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId: otherNoticeId },
              `activation.notice:${otherNoticeId}`
            ),
        ],
        [
          "a body with a key beside the notice",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId, step: "a1" },
              `activation.notice:${noticeId}`
            ),
        ],
        [
          "a body without the notice",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              {},
              `activation.notice:${noticeId}`
            ),
        ],
        [
          "an ID that is not a uuid",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId: "not-a-uuid" },
              "activation.notice:not-a-uuid"
            ),
        ],
        [
          "the ID in capitals",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId: noticeId.toUpperCase() },
              `activation.notice:${noticeId.toUpperCase()}`
            ),
        ],
        [
          "another key than the one of the body",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId },
              `activation.notice:${otherNoticeId}`
            ),
        ],
        [
          "the key of the billing type for the series' notice",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId },
              `billing.notice:${noticeId}`
            ),
        ],
        [
          "a status other than pending",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId },
              `activation.notice:${noticeId}`,
              "status='dispatched'"
            ),
        ],
        [
          "attempts other than zero",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId },
              `activation.notice:${noticeId}`,
              "attempts=3"
            ),
        ],
        [
          "a billing notice recorded as an activation notice",
          () =>
            insertEvent(
              store.organizationId,
              "activation.notice",
              { noticeId: billingNoticeId },
              `activation.notice:${billingNoticeId}`
            ),
        ],
        [
          "an activation notice recorded as a billing notice",
          () =>
            insertEvent(
              store.organizationId,
              "billing.notice",
              { noticeId },
              `billing.notice:${noticeId}`
            ),
        ],
      ];
      await withGateRole(client, BILLING_RUNTIME, async () => {
        for (const [label, attempt] of refused) {
          await client.query("SAVEPOINT probe");
          await expectSqlState(attempt, "42501", `${label}: refused`);
          await client.query("ROLLBACK TO SAVEPOINT probe");
        }
        await insertEvent(
          store.organizationId,
          "activation.notice",
          { noticeId },
          `activation.notice:${noticeId}`
        );
        await insertEvent(
          store.organizationId,
          "billing.notice",
          { noticeId: billingNoticeId },
          `billing.notice:${billingNoticeId}`
        );
        await client.query("SAVEPOINT probe");
        await expectSqlState(
          () => client.query("SELECT id FROM public.event_outbox LIMIT 1"),
          "42501",
          "the billing role still reads no event"
        );
        await client.query("ROLLBACK TO SAVEPOINT probe");
      });
      const written = await client.query<{
        attempts: number;
        event: unknown;
        idempotency_key: string;
        status: string;
        type: string;
      }>(
        "SELECT type, event, idempotency_key, status, attempts FROM public.event_outbox WHERE organization_id = $1 AND type IN ('activation.notice', 'billing.notice') ORDER BY type",
        [store.organizationId]
      );
      assert.deepEqual(written.rows, [
        {
          attempts: 0,
          event: { noticeId },
          idempotency_key: `activation.notice:${noticeId}`,
          status: "pending",
          type: "activation.notice",
        },
        {
          attempts: 0,
          event: { noticeId: billingNoticeId },
          idempotency_key: `billing.notice:${billingNoticeId}`,
          status: "pending",
          type: "billing.notice",
        },
      ]);
    });
    tests.push(
      "the billing runtime writes the outbox event activation.notice (pending, no attempt, the body with the notice's ID alone, the key from it) for an activation_notices row of the same store, and refuses with 42501: a notice that does not exist, one of another store, a body with a key beside the notice or without it, an ID that is not a uuid or in capitals, another key, the billing type's key, a status other than pending, attempts other than zero, a billing_notices ID as an activation notice and an activation_notices ID as billing.notice (which still asks for its billing_notices row, and records with it); it still reads no event"
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
