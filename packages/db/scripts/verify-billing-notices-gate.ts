// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { BILLING_NOTICE_KINDS } from "@polaris/domain/billing/notices";
import { Client } from "pg";
import { type BillingStore, createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  sqlState,
  type TenantFixture,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The notices of the billing cycle and the welcome, the database part (ADR 0104, decision 7; PR F of design t268 v2,
 * migration 0101), on a real PostgreSQL 18:
 *   1. `billing_notices`: forced row security, the exact policies and grants per role, nothing to the tenant, and its
 *      checks (the kinds, the welcome's person, the opaque key, one outcome, one notice per store, kind and key, one
 *      welcome per person);
 *   2. the billing role records a notice owed, reads it and writes its outcome once, and nothing else;
 *   3. the outbox of the billing role (decision 11): only `billing.notice`, pending and untouched, the body with the
 *      notice's ID alone, the key built from it, a notice of the same store; every other case fails;
 *   4. `billing_notice_recipient`: only the authentication role executes it; the welcome's person or the oldest active
 *      owner, only for a notice owed, only while an owner, only whether verified, never the name; the owner's policy on
 *      `"user"` sees only the user of the notice of the scope, and a malformed scope is no row, never an error;
 *   5. `welcome_notice_candidates` and the welcome's sweep of the billing store: the stores of the last 24 hours,
 *      active, the oldest owner, the first store only, one welcome per person, each with its outbox event in the same
 *      transaction; the person deleted takes the welcome (cascade).
 * The sweep reads every store of the last 24 hours, so this gate drains what the other gates left before its own
 * fixtures and runs last in the suite (`run-gates.ts`): the welcomes it records for them name no one outside the
 * disposable database. The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const BILLING_RUNTIME = "polaris_billing_runtime";
const AUTH_RUNTIME = "polaris_auth_runtime";
const RECIPIENT_OWNER = "polaris_notice_recipient_owner";
const BILLING_OWNER = "polaris_billing_owner";
const PURGE_OWNER = "polaris_purge_owner";
const SCOPE = "app.owner_scope.billing_notice_recipient_notice_id";
const OTHER_RUNTIMES = [
  runtimeRole,
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
  "polaris_outbox_runtime",
  AUTH_RUNTIME,
];

const INSERT_OUTBOX = `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
  VALUES ($1, $2, $3::jsonb, $4, $5)`;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 4 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  let store: BillingStore | undefined;

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
    const billingUrl = await login(BILLING_RUNTIME, "polaris_notice_billing");
    const authUrl = await login(AUTH_RUNTIME, "polaris_notice_auth");
    const tenantUrl = await login(runtimeRole, "polaris_notice_tenant");
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
    /** Runs as an owner role (the gate user is a superuser in CI), inside a transaction that is rolled back. */
    const asOwnerRole = async <T>(
      role: string,
      operation: (client: Client) => Promise<T>
    ): Promise<T> =>
      as(adminUrl, async (client) => {
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          return await operation(client);
        } finally {
          await client.query("ROLLBACK");
        }
      });

    const suffix = randomUUID().slice(0, 8);
    const newTenant = (label: string) =>
      createTenantFixture(
        owner.pool,
        `notices ${label} ${suffix}`,
        "America/Sao_Paulo",
        "free"
      );
    /** A notice written by the gate user (bypassing the policies), for the probes. */
    const seedNotice = async (
      tenant: TenantFixture,
      kind: string,
      dedupeKey: string,
      userId: string | null = null
    ) =>
      String(
        (
          await owner.pool.query<{ id: string }>(
            `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at, user_id)
             VALUES ($1, $2, $3, now(), $4) RETURNING id`,
            [tenant.organizationId, kind, dedupeKey, userId]
          )
        ).rows[0]?.id
      );
    const addOwner = async (
      tenant: TenantFixture,
      label: string,
      options: { createdAt?: string; verified?: boolean } = {}
    ) => {
      const userId = randomUUID();
      await owner.pool.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)',
        [
          userId,
          `Nome de teste ${label}`,
          `notice-${label}-${userId}@example.invalid`,
          options.verified ?? true,
        ]
      );
      await owner.pool.query(
        `INSERT INTO public.memberships (organization_id, user_id, role, status, created_at)
         VALUES ($1, $2, 'owner', 'active', COALESCE($3::timestamptz, now()))`,
        [tenant.organizationId, userId, options.createdAt ?? null]
      );
      return userId;
    };
    const emailOf = async (userId: string) =>
      String(
        (
          await owner.pool.query<{ email: string }>(
            'SELECT email FROM public."user" WHERE id = $1',
            [userId]
          )
        ).rows[0]?.email
      );

    // ------------------------------------------------------------------ 1. the table, its policies, grants and checks
    const forced = await owner.pool.query<{ forced: boolean }>(
      "SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.billing_notices'::regclass"
    );
    assert.equal(forced.rows[0]?.forced, true, "forced row security");
    const policies = await owner.pool.query<{ policy: string }>(
      `SELECT policyname || ':' || cmd || ':' || array_to_string(roles::text[], ',') AS policy
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'billing_notices' ORDER BY 1`
    );
    assert.deepEqual(
      policies.rows.map((row) => row.policy),
      [
        `billing_notices_billing_owner_select_welcome:SELECT:${BILLING_OWNER}`,
        `billing_notices_billing_runtime_insert:INSERT:${BILLING_RUNTIME}`,
        `billing_notices_billing_runtime_select:SELECT:${BILLING_RUNTIME}`,
        `billing_notices_billing_runtime_update:UPDATE:${BILLING_RUNTIME}`,
        `billing_notices_purge_owner_delete:DELETE:${PURGE_OWNER}`,
        `billing_notices_purge_owner_select:SELECT:${PURGE_OWNER}`,
        `billing_notices_recipient_owner_select_owed:SELECT:${RECIPIENT_OWNER}`,
      ],
      "one policy per role and command, none for the tenant or PUBLIC"
    );
    const grants = await owner.pool.query<{ grant: string }>(
      `SELECT pg_get_userbyid(x.grantee) || ' ' || x.privilege_type AS grant
         FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
        WHERE c.oid = 'public.billing_notices'::regclass AND x.grantee <> c.relowner
       UNION ALL
       SELECT pg_get_userbyid(x.grantee) || ' ' || x.privilege_type || ' (' || a.attname || ')'
         FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE a.attrelid = 'public.billing_notices'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY 1`
    );
    assert.deepEqual(
      grants.rows.map((row) => row.grant),
      [
        `${BILLING_OWNER} SELECT (kind)`,
        `${BILLING_OWNER} SELECT (user_id)`,
        `${BILLING_RUNTIME} INSERT (dedupe_key)`,
        `${BILLING_RUNTIME} INSERT (due_at)`,
        `${BILLING_RUNTIME} INSERT (kind)`,
        `${BILLING_RUNTIME} INSERT (organization_id)`,
        `${BILLING_RUNTIME} INSERT (user_id)`,
        `${BILLING_RUNTIME} SELECT`,
        `${BILLING_RUNTIME} UPDATE (failed_at)`,
        `${BILLING_RUNTIME} UPDATE (failure_code)`,
        `${BILLING_RUNTIME} UPDATE (sent_at)`,
        `${BILLING_RUNTIME} UPDATE (skipped_reason)`,
        `${RECIPIENT_OWNER} SELECT (failed_at)`,
        `${RECIPIENT_OWNER} SELECT (id)`,
        `${RECIPIENT_OWNER} SELECT (kind)`,
        `${RECIPIENT_OWNER} SELECT (organization_id)`,
        `${RECIPIENT_OWNER} SELECT (sent_at)`,
        `${RECIPIENT_OWNER} SELECT (skipped_reason)`,
        `${RECIPIENT_OWNER} SELECT (user_id)`,
        `${PURGE_OWNER} DELETE`,
        `${PURGE_OWNER} SELECT`,
      ],
      "the billing role records, reads and marks; the purge removes; the two owners read their columns; nothing else"
    );
    for (const role of [...OTHER_RUNTIMES, "public"]) {
      const any = await owner.pool.query<{ any: boolean }>(
        `SELECT has_table_privilege($1, 'public.billing_notices', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES')
             OR has_any_column_privilege($1, 'public.billing_notices', 'SELECT, INSERT, UPDATE, REFERENCES') AS any`,
        [role]
      );
      assert.equal(any.rows[0]?.any, false, `${role} holds nothing`);
    }
    const kinds = await owner.pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'billing_notices_kind_allowed'"
    );
    assert.deepEqual(
      [...String(kinds.rows[0]?.definition).matchAll(/'([a-z_]+)'::text/g)].map(
        (match) => match[1]
      ),
      [...BILLING_NOTICE_KINDS],
      "the kinds of the check are the domain's, in its order"
    );

    const store1 = await newTenant("store-1");
    const store2 = await newTenant("store-2");
    const checkRefusals: [string, unknown[], string][] = [
      [
        "a kind the domain does not know",
        [store1.organizationId, "closure", "k", null],
        "billing_notices_kind_allowed",
      ],
      [
        "a welcome with no person",
        [store1.organizationId, "welcome", "k", null],
        "billing_notices_user_only_for_welcome",
      ],
      [
        "a notice of the cycle with a person",
        [store1.organizationId, "charge_receipt", "k", store1.userId],
        "billing_notices_user_only_for_welcome",
      ],
      [
        "a key with a space",
        [store1.organizationId, "charge_receipt", "maria souza", null],
        "billing_notices_dedupe_key_format",
      ],
      [
        "a key with a line break",
        [store1.organizationId, "charge_receipt", "a\nb", null],
        "billing_notices_dedupe_key_format",
      ],
      [
        "an empty key",
        [store1.organizationId, "charge_receipt", "", null],
        "billing_notices_dedupe_key_format",
      ],
      [
        "a key longer than 200",
        [store1.organizationId, "charge_receipt", "a".repeat(201), null],
        "billing_notices_dedupe_key_format",
      ],
    ];
    for (const [label, values, constraint] of checkRefusals) {
      await expectSqlState(
        () =>
          owner.pool.query(
            "INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at, user_id) VALUES ($1, $2, $3, now(), $4)",
            values
          ),
        "23514",
        label,
        constraint
      );
    }
    const outcomeRefusals: [string, string][] = [
      ["sent and skipped", "sent_at = now(), skipped_reason = 'refunded'"],
      [
        "sent and failed",
        "sent_at = now(), failed_at = now(), failure_code = 'bounced'",
      ],
      ["failed with no code", "failed_at = now()"],
      ["a code with no failure", "failure_code = 'bounced'"],
      ["a reason as free text", "skipped_reason = 'Maria pediu'"],
    ];
    const probe = await seedNotice(store1, "charge_receipt", `probe-${suffix}`);
    for (const [label, set] of outcomeRefusals) {
      await expectSqlState(
        () =>
          owner.pool.query(
            `UPDATE public.billing_notices SET ${set} WHERE id = $1`,
            [probe]
          ),
        "23514",
        label
      );
    }
    await expectSqlState(
      () => seedNotice(store1, "charge_receipt", `probe-${suffix}`),
      "23505",
      "one notice per store, kind and key",
      "billing_notices_dedupe_unique"
    );
    // the same key of another kind, or of another store, is another notice
    await seedNotice(store1, "renewal_cancelled", `probe-${suffix}`);
    await seedNotice(store2, "charge_receipt", `probe-${suffix}`);
    const welcomed = await addOwner(store1, "welcomed");
    await seedNotice(store1, "welcome", welcomed, welcomed);
    await expectSqlState(
      () => seedNotice(store2, "welcome", `${welcomed}-2`, welcomed),
      "23505",
      "one welcome per person, whatever the store",
      "billing_notices_welcome_user_unique"
    );
    tests.push(
      "billing_notices has forced row security, one policy per role and command (none for the tenant or PUBLIC) and the exact grants: the billing role records five columns, reads and marks four; the purge reads and deletes; the recipient's owner and the welcome's owner read their columns; no other runtime holds anything; the checks refuse a kind outside the domain's list, a welcome without its person and a notice of the cycle with one, a key with a space, a line break, empty or too long, two outcomes, a failure without its code and a reason as free text; one notice per store, kind and key, and one welcome per person across stores"
    );

    // ------------------------------------------------------------------ 2. what the billing role does with a notice
    await as(billingUrl, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at)
         VALUES ($1, 'charge_receipt', $2, now() + interval '10 minutes') ON CONFLICT DO NOTHING RETURNING id`,
        [store1.organizationId, `receipt-${suffix}`]
      );
      const again = await client.query(
        `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at)
         VALUES ($1, 'charge_receipt', $2, now()) ON CONFLICT DO NOTHING RETURNING id`,
        [store1.organizationId, `receipt-${suffix}`]
      );
      assert.equal(again.rowCount, 0, "the same notice twice records one");
      await expectSqlState(
        () =>
          client.query(
            `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at, sent_at)
             VALUES ($1, 'charge_receipt', $2, now(), now())`,
            [store1.organizationId, `sent-${suffix}`]
          ),
        "42501",
        "a notice is recorded owed: the outcome is not a column it inserts"
      );
      const id = String(inserted.rows[0]?.id);
      const marked = await client.query(
        "UPDATE public.billing_notices SET skipped_reason = 'refunded' WHERE id = $1",
        [id]
      );
      assert.equal(marked.rowCount, 1, "the outcome of a notice owed");
      const remarked = await client.query(
        "UPDATE public.billing_notices SET skipped_reason = NULL, sent_at = now() WHERE id = $1",
        [id]
      );
      assert.equal(remarked.rowCount, 0, "an outcome is written once");
      await expectSqlState(
        () =>
          client.query(
            "UPDATE public.billing_notices SET kind = 'welcome' WHERE id = $1",
            [id]
          ),
        "42501",
        "only the outcome is updated"
      );
      await expectSqlState(
        () =>
          client.query("DELETE FROM public.billing_notices WHERE id = $1", [
            id,
          ]),
        "42501",
        "the billing role deletes nothing"
      );
    });
    await as(tenantUrl, async (client) => {
      await expectSqlState(
        () => client.query("SELECT id FROM public.billing_notices LIMIT 1"),
        "42501",
        "the tenant reads no notice"
      );
    });
    tests.push(
      "the billing role records a notice owed (ON CONFLICT DO NOTHING: the same notice twice is one), never with an outcome, writes the outcome of a notice owed once and nothing else, and deletes nothing; the tenant reads no notice"
    );

    // ------------------------------------------------------------------ 3. the outbox of the billing role
    const notice1 = await seedNotice(store1, "trial_started", `ref-${suffix}`);
    const notice2 = await seedNotice(store2, "trial_started", `ref-${suffix}`);
    const outboxOf = async (organizationId: string) =>
      (
        await owner.pool.query<{
          attempts: number;
          event: Record<string, unknown>;
          idempotency_key: string;
          status: string;
          type: string;
        }>(
          "SELECT type, event, idempotency_key, status, attempts FROM public.event_outbox WHERE organization_id = $1 AND type = 'billing.notice' ORDER BY created_at",
          [organizationId]
        )
      ).rows;
    await as(billingUrl, async (client) => {
      await client.query(INSERT_OUTBOX, [
        store1.organizationId,
        "billing.notice",
        JSON.stringify({ noticeId: notice1 }),
        `billing.notice:${notice1}`,
        randomUUID(),
      ]);
      const refusals: [string, unknown[], string[]][] = [
        [
          "another type, with a valid notice",
          [
            store1.organizationId,
            "organization.closure_notice",
            JSON.stringify({ noticeId: notice1 }),
            `organization.closure_notice:${notice1}`,
          ],
          ["42501"],
        ],
        [
          "the export's type",
          [
            store1.organizationId,
            "data_export.requested",
            JSON.stringify({ exportId: notice1 }),
            `data_export.requested:${notice1}`,
          ],
          ["42501"],
        ],
        [
          "the notice of another store",
          [
            store1.organizationId,
            "billing.notice",
            JSON.stringify({ noticeId: notice2 }),
            `billing.notice:${notice2}`,
          ],
          ["42501"],
        ],
        [
          "a notice that does not exist",
          [
            store1.organizationId,
            "billing.notice",
            JSON.stringify({ noticeId: randomUUID() }),
            `billing.notice:${randomUUID()}`,
          ],
          ["42501"],
        ],
        [
          "a key other than the type and the notice",
          [
            store2.organizationId,
            "billing.notice",
            JSON.stringify({ noticeId: notice2 }),
            `billing.notice:${notice2}:again`,
          ],
          ["42501"],
        ],
        [
          "a body with a key beside the notice",
          [
            store2.organizationId,
            "billing.notice",
            JSON.stringify({ kind: "welcome", noticeId: notice2 }),
            `billing.notice:${notice2}`,
          ],
          ["42501"],
        ],
        [
          "a notice that is not a uuid",
          [
            store2.organizationId,
            "billing.notice",
            JSON.stringify({ noticeId: "not-a-uuid" }),
            "billing.notice:not-a-uuid",
          ],
          ["42501", "22P02"],
        ],
      ];
      for (const [label, values, states] of refusals) {
        let state: string | undefined;
        try {
          await client.query(INSERT_OUTBOX, [...values, randomUUID()]);
        } catch (error: unknown) {
          state = sqlState(error);
        }
        assert.ok(
          state !== undefined && states.includes(state),
          `${label}: refused (${state ?? "accepted"})`
        );
      }
      // the status and the attempts are not columns it inserts: pending and untouched, always
      for (const [column, value] of [
        ["status", "'dispatched'"],
        ["attempts", "3"],
        ["available_at", "now() + interval '1 day'"],
      ] as const) {
        await expectSqlState(
          () =>
            client.query(
              `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id, ${column})
               VALUES ($1, 'billing.notice', $2::jsonb, $3, $4, ${value})`,
              [
                store2.organizationId,
                JSON.stringify({ noticeId: notice2 }),
                `billing.notice:${notice2}`,
                randomUUID(),
              ]
            ),
          "42501",
          `the ${column} is not the billing role's`
        );
      }
      await expectSqlState(
        () => client.query("SELECT id FROM public.event_outbox LIMIT 1"),
        "42501",
        "the billing role reads no event"
      );
    });
    assert.deepEqual(await outboxOf(store1.organizationId), [
      {
        attempts: 0,
        event: { noticeId: notice1 },
        idempotency_key: `billing.notice:${notice1}`,
        status: "pending",
        type: "billing.notice",
      },
    ]);
    assert.deepEqual(await outboxOf(store2.organizationId), []);
    tests.push(
      "the billing role writes the outbox event of a notice of the same store (billing.notice, pending, no attempt, the body with the notice's ID alone, the key from it) and nothing else: another type, the export's type, the notice of another store, a notice that does not exist, another key, a body with a key beside the notice and an ID that is not a uuid fail; the status, the attempts and the time are not its columns; it reads no event"
    );

    // ------------------------------------------------------------------ 4. the recipient
    const fnInfo = async (signature: string) =>
      (
        await owner.pool.query<{
          config: string[] | null;
          executors: string[];
          owner: string;
          secdef: boolean;
          volatility: string;
        }>(
          `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config, p.provolatile AS volatility,
                  ARRAY(SELECT r.rolname::text FROM pg_roles r
                         WHERE r.rolname LIKE 'polaris\\_%' AND NOT r.rolcanlogin AND r.rolname NOT LIKE '%\\_owner'
                           AND has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY 1) AS executors
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [signature]
        )
      ).rows[0];
    const recipientFn = await fnInfo(
      "public.billing_notice_recipient(text, uuid)"
    );
    assert.deepEqual(recipientFn, {
      config: ["search_path=pg_catalog, public, pg_temp"],
      executors: [AUTH_RUNTIME],
      owner: RECIPIENT_OWNER,
      secdef: true,
      volatility: "v",
    });
    const publicRecipient = await owner.pool.query<{ ok: boolean }>(
      "SELECT has_function_privilege('public', 'public.billing_notice_recipient(text, uuid)', 'EXECUTE') AS ok"
    );
    assert.equal(publicRecipient.rows[0]?.ok, false, "not open to PUBLIC");
    const recipient = (organizationId: string, noticeId: string) =>
      as(authUrl, async (client) => {
        const answer = await client.query<{ result: unknown }>(
          "SELECT public.billing_notice_recipient($1, $2::uuid) AS result",
          [organizationId, noticeId]
        );
        return answer.rows[0]?.result ?? null;
      });

    // a store with two owners: the notice of the cycle goes to the oldest, read now
    const store3 = await newTenant("store-3");
    await owner.pool.query(
      "UPDATE public.memberships SET created_at = now() - interval '2 days' WHERE organization_id = $1",
      [store3.organizationId]
    );
    const younger = await addOwner(store3, "younger");
    const cycleNotice = await seedNotice(
      store3,
      "renewal_failed",
      `2026-10-10T15:00:00.000Z:d0-${suffix}`
    );
    assert.deepEqual(
      await recipient(store3.organizationId, cycleNotice),
      { email: await emailOf(store3.userId), verified: true },
      "the oldest active owner, by e-mail only"
    );
    assert.equal(
      await recipient(store1.organizationId, cycleNotice),
      null,
      "the notice by its store: another store answers null"
    );
    // the oldest owner leaves: the younger one is the oldest now
    await owner.pool.query(
      "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
      [store3.organizationId, store3.userId]
    );
    assert.deepEqual(await recipient(store3.organizationId, cycleNotice), {
      email: await emailOf(younger),
      verified: true,
    });
    await owner.pool.query(
      'UPDATE public."user" SET email_verified = false WHERE id = $1',
      [younger]
    );
    assert.deepEqual(
      await recipient(store3.organizationId, cycleNotice),
      { verified: false },
      "an address not verified is not given"
    );
    await owner.pool.query(
      "DELETE FROM public.memberships WHERE organization_id = $1",
      [store3.organizationId]
    );
    assert.equal(
      await recipient(store3.organizationId, cycleNotice),
      null,
      "a store with no owner: nobody to send it to"
    );
    // the welcome goes to its person while an owner of a store, and no longer once it was sent
    const welcomeNoticeId = String(
      (
        await owner.pool.query<{ id: string }>(
          "SELECT id FROM public.billing_notices WHERE kind = 'welcome' AND user_id = $1",
          [welcomed]
        )
      ).rows[0]?.id
    );
    assert.deepEqual(await recipient(store1.organizationId, welcomeNoticeId), {
      email: await emailOf(welcomed),
      verified: true,
    });
    await owner.pool.query(
      "UPDATE public.billing_notices SET sent_at = now() WHERE id = $1",
      [welcomeNoticeId]
    );
    assert.equal(
      await recipient(store1.organizationId, welcomeNoticeId),
      null,
      "a notice sent is not owed"
    );
    const leaver = await addOwner(store2, "leaver");
    const leaverWelcome = await seedNotice(store2, "welcome", leaver, leaver);
    await owner.pool.query(
      "DELETE FROM public.memberships WHERE user_id = $1",
      [leaver]
    );
    assert.equal(
      await recipient(store2.organizationId, leaverWelcome),
      null,
      "a person who is no longer an owner gets nothing"
    );
    const nameless = await recipient(store1.organizationId, notice1);
    assert.ok(
      !JSON.stringify(nameless).includes("Nome de teste"),
      "never the name"
    );
    await as(billingUrl, async (client) => {
      await expectSqlState(
        () =>
          client.query("SELECT public.billing_notice_recipient($1, $2::uuid)", [
            store1.organizationId,
            notice1,
          ]),
        "42501",
        "the billing role does not read addresses"
      );
    });
    // the owner's policy on "user": only the user of the notice of the scope, and a malformed scope is no row
    const visibleUsers = async (scope: string | null) =>
      asOwnerRole(RECIPIENT_OWNER, async (client) => {
        if (scope !== null) {
          await client.query("SELECT set_config($1, $2, true)", [SCOPE, scope]);
        }
        return (
          await client.query<{ id: string }>(
            'SELECT id FROM public."user" ORDER BY id'
          )
        ).rows.map((row) => row.id);
      });
    assert.deepEqual(await visibleUsers(null), [], "no scope, no user");
    assert.deepEqual(await visibleUsers("not-a-uuid"), [], "malformed: no row");
    assert.deepEqual(await visibleUsers(randomUUID()), [], "no such notice");
    // a notice of the cycle: the active owners of its store, nobody else
    assert.deepEqual(
      await visibleUsers(notice1),
      [store1.userId, welcomed].sort()
    );
    tests.push(
      "billing_notice_recipient is SECURITY DEFINER and volatile with a fixed search_path, owned by the recipient's owner and executed only by the authentication role (not PUBLIC, not the billing role); a notice of the cycle goes to the oldest active owner of its store, read at the call, and to the next one when that owner leaves; an address not verified answers {verified: false}; another store, a store with no owner, a notice sent and a welcome whose person is no longer an owner answer null; never the name; the owner's policy on \"user\" shows nothing without the scope or with a malformed one, and only the owner of the notice with it"
    );

    // ------------------------------------------------------------------ 5. the welcome's candidates and sweep
    const candidatesFn = await fnInfo(
      "public.welcome_notice_candidates(integer)"
    );
    assert.deepEqual(candidatesFn, {
      config: ["search_path=pg_catalog, public, pg_temp"],
      executors: [BILLING_RUNTIME],
      owner: BILLING_OWNER,
      secdef: true,
      volatility: "s",
    });
    for (const limit of [0, 501]) {
      await as(billingUrl, async (client) => {
        await expectSqlState(
          () =>
            client.query("SELECT * FROM public.welcome_notice_candidates($1)", [
              limit,
            ]),
          "22023",
          `a limit of ${limit} is refused`
        );
      });
    }
    store = createBillingStore(billingUrl);
    const billing = store;
    // what the other gates left in the last 24 hours, and the stores above, are welcomed first
    let drained = false;
    for (let pass = 0; pass < 100 && !drained; pass += 1) {
      const report = await billing.recordWelcomeNotices(new Date(), 500);
      drained = report.candidates === 0;
    }
    assert.ok(drained, "the stores of the last 24 hours are drained");
    const candidates = async () =>
      as(billingUrl, async (client) =>
        (
          await client.query<{ organization_id: string; user_id: string }>(
            "SELECT organization_id, user_id FROM public.welcome_notice_candidates(500)"
          )
        ).rows.map((row) => `${row.organization_id}/${row.user_id}`)
      );
    assert.deepEqual(await candidates(), [], "nothing left after the drain");

    const fresh = await newTenant("fresh");
    // a second owner joined later: the welcome is the founder's
    await owner.pool.query(
      "UPDATE public.memberships SET created_at = now() - interval '1 hour' WHERE organization_id = $1",
      [fresh.organizationId]
    );
    await addOwner(fresh, "partner");
    const unverifiedStore = await newTenant("unverified");
    await owner.pool.query(
      'UPDATE public."user" SET email_verified = false WHERE id = $1',
      [unverifiedStore.userId]
    );
    const old = await newTenant("old");
    await owner.pool.query(
      "UPDATE public.organizations SET created_at = now() - interval '25 hours' WHERE id = $1",
      [old.organizationId]
    );
    const closing = await newTenant("closing");
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'closing' WHERE id = $1",
      [closing.organizationId]
    );
    // a person who already owns a store opens another: no welcome (AC-26: the first store)
    const second = await newTenant("second");
    await owner.pool.query(
      "UPDATE public.memberships SET created_at = now() - interval '3 days' WHERE organization_id = $1",
      [second.organizationId]
    );
    await owner.pool.query(
      "UPDATE public.organizations SET created_at = now() - interval '3 days' WHERE id = $1",
      [second.organizationId]
    );
    const secondStore = randomUUID();
    await owner.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Loja de teste', 'America/Sao_Paulo')",
      [secondStore]
    );
    await owner.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [secondStore, second.userId]
    );
    // a person whose earlier store was purged (the purge takes its memberships and its notices) opens another: the new
    // store is the first again, and the person is welcomed again (the effect accepted in §8; the organization-purge gate
    // proves it with a real purge)
    const purgedBefore = await newTenant("purged-before");
    await owner.pool.query(
      "UPDATE public.organizations SET created_at = now() - interval '200 days', status = 'purged' WHERE id = $1",
      [purgedBefore.organizationId]
    );
    await owner.pool.query(
      "DELETE FROM public.memberships WHERE organization_id = $1",
      [purgedBefore.organizationId]
    );
    const reopened: TenantFixture = {
      organizationId: randomUUID(),
      userId: purgedBefore.userId,
    };
    await owner.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Loja reaberta', 'America/Sao_Paulo')",
      [reopened.organizationId]
    );
    await owner.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [reopened.organizationId, reopened.userId]
    );
    assert.deepEqual(
      (await candidates()).sort(),
      [
        `${fresh.organizationId}/${fresh.userId}`,
        `${unverifiedStore.organizationId}/${unverifiedStore.userId}`,
        `${reopened.organizationId}/${reopened.userId}`,
      ].sort(),
      "the stores of the last 24 hours, active, with the founder, on the first store (again after a purge)"
    );
    const report = await billing.recordWelcomeNotices();
    assert.deepEqual(report, { candidates: 3, recorded: 3 });
    for (const tenant of [fresh, unverifiedStore, reopened]) {
      const rows = await owner.pool.query<{
        dedupe_key: string;
        id: string;
        kind: string;
        sent_at: Date | null;
        user_id: string;
      }>(
        "SELECT id, kind, dedupe_key, user_id, sent_at FROM public.billing_notices WHERE organization_id = $1",
        [tenant.organizationId]
      );
      assert.equal(rows.rows.length, 1);
      const [row] = rows.rows;
      assert.ok(row);
      assert.deepEqual(
        { ...row, id: undefined },
        {
          dedupe_key: tenant.userId,
          id: undefined,
          kind: "welcome",
          sent_at: null,
          user_id: tenant.userId,
        }
      );
      assert.deepEqual(await outboxOf(tenant.organizationId), [
        {
          attempts: 0,
          event: { noticeId: row.id },
          idempotency_key: `billing.notice:${row.id}`,
          status: "pending",
          type: "billing.notice",
        },
      ]);
    }
    assert.deepEqual(await billing.recordWelcomeNotices(), {
      candidates: 0,
      recorded: 0,
    });
    // the person deleted takes the welcome (the foreign key in cascade)
    await owner.pool.query(
      "DELETE FROM public.memberships WHERE user_id = $1",
      [unverifiedStore.userId]
    );
    await owner.pool.query('DELETE FROM public."user" WHERE id = $1', [
      unverifiedStore.userId,
    ]);
    const left = await owner.pool.query(
      "SELECT 1 FROM public.billing_notices WHERE user_id = $1",
      [unverifiedStore.userId]
    );
    assert.equal(left.rows.length, 0, "the welcome went with the account");
    tests.push(
      "welcome_notice_candidates is SECURITY DEFINER and stable with a fixed search_path, owned by the billing owner and executed only by the billing role, and refuses a limit outside 1 to 500; it answers the stores created in the last 24 hours and still active, with their oldest owner (verified or not), and not a store older than 24 hours, one closing, one whose founder already owns an older store or already has a welcome, and again for a person whose earlier store was purged; the store's sweep records the welcome of each, keyed by the person, with its outbox event in the same transaction, and a second pass records nothing; the person deleted takes the welcome"
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
    await store?.close().catch(() => undefined);
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing notices PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
