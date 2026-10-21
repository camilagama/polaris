// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
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
  sqlState,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The purge of the users who never verified the e-mail on a real PostgreSQL 18 (ADR 0100, P10, Q-D2):
 * `purge_unverified_users`, the function of a role of its own that deletes a user only when EVERY condition holds
 * together: e-mail not verified, no account but `credential`, no session, no membership, created more than 24 hours
 * ago. It proves: that the user who meets all of them is deleted (with the account it carries, and one audit row
 * with no e-mail); that each condition alone, missing, keeps the user; the limit per run (oldest first) and its
 * range; that a second run changes nothing; that a row another transaction holds is skipped and the session it
 * adds protects the user afterwards; that two runs at the same time delete each user once; that the tenant, Admin
 * and privacy runtimes neither delete users nor execute the function, and that its owner holds the least; and that
 * the gate itself fails when a condition is taken out of the function (each probe runs again, in a transaction that
 * is rolled back, against a function without the condition).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const OWNER_ROLE = "polaris_unverified_user_owner";
const FUNCTION = "public.purge_unverified_users(integer)";
const RUNTIME_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_admin_owner",
  "polaris_privacy_runtime",
  "polaris_privacy_owner",
  "polaris_outbox_runtime",
  "polaris_outbox_owner",
  "polaris_purge_owner",
  "polaris_media_cleanup_runtime",
  "polaris_media_cleanup_owner",
  "polaris_onboarding_runtime",
  "polaris_login_lock_owner",
  "polaris_notice_recipient_owner",
  "polaris_device_session_owner",
  "polaris_retention_owner",
  "polaris_closed_export_reader",
];
const BIG_LIMIT = 1000;
const AUDIT_SUBJECT_LEAK = /example\.invalid|Nome de teste|@/;
const RUN_ID = /^unverified-user-purge:[0-9a-f-]{36}$/;

interface Spec {
  /** Accounts of the user (a `credential` one by default). */
  accounts?: string[];
  emailVerified?: boolean;
  /** How old the user is, in hours (25 by default). */
  hours?: number;
  /** In how many minutes the last e-mail link stops working (negative: it already did); none by default. */
  linkExpiresInMinutes?: number;
  membership?: boolean;
  session?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, section by section
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
  const closers: (() => Promise<unknown>)[] = [];
  const cleanupFailures: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const emails = new Map<string, string>();
  let primaryFailure = false;

  /** A user made by the owner (the gate's fixture), as Better Auth would have left it. */
  const makeUser = async (label: string, spec: Spec = {}) => {
    const id = `gate-unv-${label}-${suffix}`;
    const email = `${id}@example.invalid`;
    await owner.pool.query(
      `INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at, verification_link_expires_at)
       VALUES ($1, 'Nome de teste', $2, $3, clock_timestamp() - make_interval(hours => $4::int), clock_timestamp() - make_interval(hours => $4::int),
               CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(mins => $5::int) END)`,
      [
        id,
        email,
        spec.emailVerified ?? false,
        spec.hours ?? 25,
        spec.linkExpiresInMinutes ?? null,
      ]
    );
    userIds.push(id);
    emails.set(id, email);
    for (const provider of spec.accounts ?? ["credential"]) {
      await owner.pool.query(
        "INSERT INTO public.account (id, account_id, provider_id, user_id) VALUES ($1, $2, $3, $4)",
        [`${id}-${provider}`, `${id}-${provider}`, provider, id]
      );
    }
    if (spec.session) {
      await owner.pool.query(
        `INSERT INTO public.session (id, token, user_id, expires_at)
         VALUES ($1, $2, $3, clock_timestamp() - interval '1 day')`,
        [`${id}-session`, randomBytes(16).toString("hex"), id]
      );
    }
    if (spec.membership) {
      const organization = `gate-unv-org-${label}-${suffix}`;
      await owner.pool.query(
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Loja de teste', 'America/Sao_Paulo')",
        [organization]
      );
      organizationIds.push(organization);
      await owner.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [organization, id]
      );
    }
    return id;
  };
  const exists = async (id: string) =>
    (await owner.pool.query('SELECT 1 FROM public."user" WHERE id = $1', [id]))
      .rows.length === 1;
  const auditOf = async (ids: string[]) =>
    (
      await owner.pool.query<{
        actor_id: string | null;
        event_type: string;
        outcome: string;
        request_id: string;
        row_text: string;
        subject_id: string;
      }>(
        `SELECT actor_id, event_type::text, outcome::text, request_id, subject_id, a::text AS row_text
           FROM public.auth_security_audit_event AS a
          WHERE event_type = 'unverified_user_deleted' AND subject_id = ANY ($1)
          ORDER BY subject_id`,
        [ids]
      )
    ).rows;
  /** The users that meet every condition right now, in the order the function takes them (the same text, in the owner's hands). */
  const eligibleNow = async () =>
    (
      await owner.pool.query<{ id: string }>(
        `SELECT u.id FROM public."user" AS u
          WHERE NOT u.email_verified AND u.created_at < clock_timestamp() - interval '24 hours'
            AND (u.verification_link_expires_at IS NULL OR u.verification_link_expires_at < clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM public.account AS a WHERE a.user_id = u.id AND a.provider_id <> 'credential')
            AND NOT EXISTS (SELECT 1 FROM public.session AS s WHERE s.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM public.memberships AS m WHERE m.user_id = u.id)
          ORDER BY u.created_at, u.id`
      )
    ).rows.map((row) => row.id);
  const definitionOf = async (client: Client) =>
    String(
      (
        await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef($1::regprocedure) AS definition",
          [FUNCTION]
        )
      ).rows[0]?.definition
    );

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
      const url = temporaryRuntimeUrl(adminUrl, role, password);
      return async () => {
        const client = new Client({
          connectionString: url,
          connectionTimeoutMillis: 5000,
        });
        await client.connect();
        closers.push(() => client.end());
        return client;
      };
    };
    const authClient = await (
      await login("polaris_auth_runtime", "polaris_unv_auth")
    )();
    const authClient2 = await (
      await login("polaris_auth_runtime", "polaris_unv_auth2")
    )();
    const purge = async (client: Client, limit = BIG_LIMIT) =>
      Number(
        (
          await client.query<{ removed: number }>(
            "SELECT public.purge_unverified_users($1::integer) AS removed",
            [limit]
          )
        ).rows[0]?.removed
      );

    // ---- the shape: the role, the function, who executes it, what the owner holds
    const ownerAttributes = await owner.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = '${OWNER_ROLE}'`
    );
    assert.deepEqual(ownerAttributes.rows[0], {
      rolbypassrls: false,
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
    });
    const info = await owner.pool.query<{
      config: string[] | null;
      definer: boolean;
      owner: string;
      public_execute: boolean;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, r.rolname AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = '${FUNCTION}'::regprocedure`
    );
    const [fn] = info.rows;
    assert.ok(fn);
    assert.equal(fn.definer, true, "SECURITY DEFINER");
    assert.deepEqual(fn.config, ["search_path=pg_catalog, public, pg_temp"]);
    assert.equal(fn.owner, OWNER_ROLE);
    assert.equal(fn.public_execute, false, "not open to PUBLIC");
    for (const role of [...RUNTIME_ROLES, "polaris_auth_runtime"]) {
      const can = await owner.pool.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
        [role, FUNCTION]
      );
      assert.equal(can.rows[0]?.ok, role === "polaris_auth_runtime", role);
    }
    const columnGrants = await owner.pool.query<{
      column_name: string;
      privilege_type: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = '${OWNER_ROLE}' AND table_schema = 'public'
        ORDER BY table_name, privilege_type, column_name`
    );
    assert.deepEqual(
      columnGrants.rows.map(
        (row) => `${row.table_name}.${row.column_name}:${row.privilege_type}`
      ),
      [
        "account.provider_id:SELECT",
        "account.user_id:SELECT",
        "auth_security_audit_event.event_type:INSERT",
        "auth_security_audit_event.outcome:INSERT",
        "auth_security_audit_event.request_id:INSERT",
        "auth_security_audit_event.subject_id:INSERT",
        "legal_acceptance_contract_end.reason:INSERT",
        "legal_acceptance_contract_end.user_id:INSERT",
        "memberships.user_id:SELECT",
        "session.user_id:SELECT",
        "user.created_at:SELECT",
        "user.email_verified:SELECT",
        "user.id:SELECT",
        "user.verification_link_expires_at:SELECT",
        "user.updated_at:UPDATE",
      ],
      "the owner reads no e-mail, name, password or token, and writes only the lock column, the audit and the end of the contract"
    );
    const tableGrants = await owner.pool.query<{
      privilege_type: string;
      table_name: string;
    }>(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = '${OWNER_ROLE}' AND table_schema = 'public'`
    );
    assert.deepEqual(
      tableGrants.rows.map((row) => `${row.table_name}:${row.privilege_type}`),
      ["user:DELETE"],
      "the only privilege on a whole table is the delete of the user"
    );
    tests.push(
      "the function is SECURITY DEFINER with a fixed search_path, owned by a role that is never a login and holds the least (three columns of the user, the lock column, the keys of account, session and membership, the audit insert, and the delete); only the authentication runtime executes it; no other runtime role does"
    );

    // ---- every condition holds: the user goes, with its account, and leaves one audit row with no e-mail
    const everything = await makeUser("everything", { hours: 25 });
    const olderStill = await makeUser("older", { hours: 24 * 400 });
    const noAccount = await makeUser("no-account", { accounts: [] });
    // the last e-mail link stopped working a minute ago: nothing holds the user any more
    const linkPast = await makeUser("link-past", { linkExpiresInMinutes: -1 });
    const owedFixtures = [everything, olderStill, noAccount, linkPast];
    const before = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.auth_security_audit_event WHERE event_type = 'unverified_user_deleted'"
    );

    // ---- each condition alone, missing, keeps the user
    const verified = await makeUser("verified", { emailVerified: true });
    const google = await makeUser("google", {
      accounts: ["credential", "google"],
    });
    const googleOnly = await makeUser("google-only", { accounts: ["google"] });
    const withSession = await makeUser("session", { session: true });
    const withMembership = await makeUser("membership", { membership: true });
    const young = await makeUser("young", { hours: 23 });
    const brandNew = await makeUser("new", { hours: 0 });
    // a link sent 10 minutes ago is valid for 23 h 50 min more, and one that ends in a minute still is: both keep the user
    const linkLate = await makeUser("link-late", {
      linkExpiresInMinutes: 23 * 60 + 50,
    });
    const linkLastMinute = await makeUser("link-last-minute", {
      linkExpiresInMinutes: 1,
    });
    const kept = [
      verified,
      google,
      googleOnly,
      withSession,
      withMembership,
      young,
      brandNew,
      linkLate,
      linkLastMinute,
    ];
    // the acceptance given at the sign-up of one user the purge deletes and of one it keeps
    for (const id of [everything, google]) {
      const recorded = await authClient.query<{ result: string }>(
        "SELECT public.record_legal_acceptance($1, 'terms', 1, $2, 'signup', 'gate-unv-request') AS result",
        [id, "a".repeat(64)]
      );
      assert.equal(recorded.rows[0]?.result, "recorded");
    }
    const eligibleBefore = await eligibleNow();
    for (const id of kept) {
      assert.ok(!eligibleBefore.includes(id), "the fixture is not eligible");
    }
    for (const id of owedFixtures) {
      assert.ok(eligibleBefore.includes(id), "the fixture is eligible");
    }
    const removed = await purge(authClient);
    assert.equal(removed, eligibleBefore.length, "it deleted what was owed");
    for (const id of owedFixtures) {
      assert.equal(await exists(id), false, `${id} is deleted`);
    }
    for (const id of kept) {
      assert.equal(await exists(id), true, `${id} is kept`);
    }
    assert.equal(
      (
        await owner.pool.query(
          "SELECT 1 FROM public.account WHERE user_id = ANY ($1)",
          [owedFixtures]
        )
      ).rows.length,
      0,
      "the account the user carried went with it"
    );
    assert.equal(
      (
        await owner.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.account WHERE user_id = $1",
          [google]
        )
      ).rows[0]?.count,
      "2",
      "the accounts of a kept user stay"
    );
    assert.equal(
      (
        await owner.pool.query(
          "SELECT 1 FROM public.session WHERE user_id = $1",
          [withSession]
        )
      ).rows.length,
      1,
      "the session of a kept user stays"
    );
    tests.push(
      "the user who meets every condition (unverified, credential only, no session, no membership, 25 hours; also one 400 days old and one with no account at all) is deleted with the account it carried, and everything else is kept"
    );
    tests.push(
      "each condition alone keeps the user: a verified e-mail, a Google account next to the credential one, a Google account alone, a session (even an expired one), a membership, 23 hours, a user created now"
    );
    tests.push(
      "the last e-mail link holds the user while it is valid: one that ends in 23 h 50 min (sent 10 minutes ago) and one that ends in a minute keep a 25-hour-old user, and one that ended a minute ago does not (the user goes)"
    );

    // ---- the audit: one row per user deleted, no e-mail, no name, none for the kept
    const deletedIds = owedFixtures;
    const audit = await auditOf([...deletedIds, ...kept]);
    assert.deepEqual(
      audit.map((row) => row.subject_id).sort(),
      [...deletedIds].sort(),
      "one row for each user deleted and none for the others"
    );
    const runs = new Set(audit.map((row) => row.request_id));
    assert.equal(runs.size, 1, "the rows of one run share its ID");
    for (const row of audit) {
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.actor_id, null, "a system act has no actor");
      assert.match(row.request_id, RUN_ID);
      assert.doesNotMatch(row.row_text, AUDIT_SUBJECT_LEAK);
    }
    const after = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.auth_security_audit_event WHERE event_type = 'unverified_user_deleted'"
    );
    assert.equal(
      Number(after.rows[0]?.count) - Number(before.rows[0]?.count),
      removed
    );
    tests.push(
      "each deletion leaves one `unverified_user_deleted` row in the auth audit (succeeded, no actor, the user ID and the ID of the run), never the e-mail or the name, and nothing is audited for a user kept"
    );

    // ---- the end of the contract: one row for each user deleted, from which the 6 months and 30 days of the acceptance count
    const ended = await owner.pool.query<{
      ended_in_window: boolean;
      reason: string;
      user_id: string;
    }>(
      `SELECT user_id, reason, ended_at BETWEEN now() - interval '5 minutes' AND clock_timestamp() AS ended_in_window
         FROM public.legal_acceptance_contract_end WHERE user_id = ANY ($1) ORDER BY user_id`,
      [[...deletedIds, ...kept]]
    );
    assert.deepEqual(
      ended.rows.map((row) => row.user_id),
      [...deletedIds].sort(),
      "one row for each user deleted and none for the kept"
    );
    for (const row of ended.rows) {
      assert.equal(row.reason, "unverified_user_deleted");
      assert.equal(row.ended_in_window, true, "the date is the deletion's");
    }
    const acceptance = await owner.pool.query<{
      deadline_after_acceptance: boolean;
      user_id: string;
    }>(
      `SELECT a.user_id, (e.ended_at + interval '6 months 30 days') > a.accepted_at AS deadline_after_acceptance
         FROM public.legal_acceptance AS a
         LEFT JOIN public.legal_acceptance_contract_end AS e ON e.user_id = a.user_id
        WHERE a.user_id = ANY ($1) ORDER BY a.user_id`,
      [[everything, google]]
    );
    assert.equal(acceptance.rows.length, 2, "the acceptance survives the user");
    const byUser = new Map(
      acceptance.rows.map((row) => [row.user_id, row.deadline_after_acceptance])
    );
    assert.equal(
      byUser.get(everything),
      true,
      "the deleted user has the date its 6 months and 30 days count from"
    );
    assert.equal(
      byUser.get(google),
      null,
      "the kept user has no end of contract, so nothing of its acceptance can expire"
    );
    const endTable = "public.legal_acceptance_contract_end";
    for (const statement of [
      `UPDATE ${endTable} SET reason = reason`,
      `DELETE FROM ${endTable}`,
      `TRUNCATE ${endTable}`,
    ]) {
      await expectSqlState(
        () => owner.pool.query(statement),
        "23514",
        `append-only: ${statement}`
      );
    }
    await expectSqlState(
      () =>
        owner.pool.query(
          `INSERT INTO ${endTable} (user_id, reason) VALUES ('gate-unv-bad-reason', 'other')`
        ),
      "23514",
      "a reason outside the list"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          `INSERT INTO ${endTable} (user_id, reason) VALUES ('not valid', 'unverified_user_deleted')`
        ),
      "23514",
      "a user ID outside the shape"
    );
    tests.push(
      "each deletion records, in the same statement, one row in `legal_acceptance_contract_end` (the user ID and the instant of the deletion, reason `unverified_user_deleted`), none for a user kept; the acceptance of the deleted user stays and its 6 months and 30 days count from that date; the table refuses UPDATE, DELETE and TRUNCATE (23514, triggers) and an invalid reason or user ID"
    );

    // ---- idempotent
    const usersBefore = await owner.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public."user"'
    );
    assert.equal(await purge(authClient), 0, "a second run finds nothing");
    assert.equal(await purge(authClient), 0, "nor a third");
    const usersAfter = await owner.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public."user"'
    );
    assert.equal(usersAfter.rows[0]?.count, usersBefore.rows[0]?.count);
    assert.equal(
      (await auditOf(deletedIds)).length,
      deletedIds.length,
      "the repeated runs added no audit"
    );
    assert.equal(
      (
        await owner.pool.query(
          "SELECT 1 FROM public.legal_acceptance_contract_end WHERE user_id = ANY ($1)",
          [deletedIds]
        )
      ).rows.length,
      deletedIds.length,
      "nor a row of the end of the contract"
    );
    tests.push(
      "running the job again changes nothing: no user is deleted and no audit row is added"
    );

    // ---- the limit: oldest first, and its range
    const batch: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      batch.push(await makeUser(`batch-${index}`, { hours: 30 + index }));
    }
    const owed = await eligibleNow();
    assert.ok(owed.length >= 5);
    const firstTwo = owed.slice(0, 2);
    assert.equal(await purge(authClient, 2), 2, "the limit holds");
    for (const id of firstTwo) {
      assert.equal(await exists(id), false, "the oldest went first");
    }
    assert.deepEqual(
      await eligibleNow(),
      owed.slice(2),
      "the rest waits for the next run, in order"
    );
    for (const limit of [0, -1, BIG_LIMIT + 1]) {
      await expectSqlState(
        () => purge(authClient, limit),
        "22023",
        `limit ${limit}`
      );
    }
    await expectSqlState(
      () =>
        authClient.query("SELECT public.purge_unverified_users(NULL::integer)"),
      "22023",
      "no limit"
    );
    assert.equal(await purge(authClient), owed.length - 2);
    assert.deepEqual(await eligibleNow(), []);
    tests.push(
      "the limit per run is kept, oldest first, and a limit that is null, below 1 or above 1000 raises 22023 before anything is deleted"
    );

    // ---- a row another transaction holds is skipped, and the session it adds protects the user afterwards
    const contested = await makeUser("contested");
    const holder = await owner.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO public.session (id, token, user_id, expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + interval '1 day')`,
        [`${contested}-session`, randomBytes(16).toString("hex"), contested]
      );
      assert.equal(
        await purge(authClient),
        0,
        "the user with a session being written is skipped, not deleted"
      );
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }
    assert.equal(
      await purge(authClient),
      0,
      "and kept once the session is there"
    );
    assert.equal(await exists(contested), true);
    tests.push(
      "a user whose row another transaction holds (a session being written) is skipped by the lock, and kept by the session once it commits"
    );

    // ---- two runs at the same time delete each user once
    const parallel: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      parallel.push(await makeUser(`parallel-${index}`));
    }
    const owedNow = await eligibleNow();
    const [first, second] = await Promise.all([
      purge(authClient),
      purge(authClient2),
    ]);
    assert.equal(first + second, owedNow.length, "each user is deleted once");
    for (const id of parallel) {
      assert.equal(await exists(id), false);
    }
    assert.equal(
      (await auditOf(parallel)).length,
      parallel.length,
      "one audit row for each, however the two runs split them"
    );
    tests.push(
      "two runs at the same time delete each user exactly once, with no error and one audit row each"
    );

    // ---- the runtimes that must not delete users
    const tenantClient = await (
      await login(runtimeRole, "polaris_unv_tenant")
    )();
    const adminClient = await (
      await login("polaris_admin_runtime", "polaris_unv_admin")
    )();
    const privacyClient = await (
      await login("polaris_privacy_runtime", "polaris_unv_privacy")
    )();
    const protectedUser = await makeUser("protected");
    for (const [label, client] of [
      ["tenant", tenantClient],
      ["admin", adminClient],
      ["privacy", privacyClient],
    ] as const) {
      for (const statement of [
        `DELETE FROM public."user" WHERE id = '${protectedUser}'`,
        'TRUNCATE public."user"',
        "SELECT public.purge_unverified_users(10)",
      ]) {
        await expectSqlState(
          () => client.query(statement),
          "42501",
          `${label}: ${statement}`
        );
      }
    }
    for (const role of RUNTIME_ROLES.filter(
      (candidate) => candidate !== OWNER_ROLE
    )) {
      const can = await owner.pool.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, 'public."user"', 'DELETE') AS ok`,
        [role]
      );
      assert.equal(can.rows[0]?.ok, false, `${role} cannot delete a user`);
    }
    assert.equal(await exists(protectedUser), true);
    for (const role of [
      ...RUNTIME_ROLES,
      "polaris_auth_runtime",
      "polaris_legal_acceptance_owner",
    ]) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        // a grant on one column alone counts too
        const can = await owner.pool.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, 'public.legal_acceptance_contract_end', $2)
               OR (CASE WHEN $2 IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege($1, 'public.legal_acceptance_contract_end', $2) ELSE false END) AS ok`,
          [role, privilege]
        );
        assert.equal(
          can.rows[0]?.ok,
          false,
          `${role} has no ${privilege} on the end of the contract`
        );
      }
    }
    await expectSqlState(
      () =>
        authClient.query("SELECT 1 FROM public.legal_acceptance_contract_end"),
      "42501",
      "the authentication runtime reads the end of the contract"
    );
    tests.push(
      "the tenant, Admin and privacy runtimes are refused (42501) on a direct DELETE of a user, on TRUNCATE and on the function, and no other runtime or owner role holds DELETE on the table of users (the authentication runtime already writes it for Better Auth, and is the only one that executes the function)"
    );

    // ---- the gate fails on a function without a condition
    const everythingEligible = async (label: string) => {
      const ids = {
        control: await makeUser(`${label}-control`),
        google: await makeUser(`${label}-google`, {
          accounts: ["credential", "google"],
        }),
        link: await makeUser(`${label}-link`, {
          linkExpiresInMinutes: 23 * 60 + 50,
        }),
        membership: await makeUser(`${label}-membership`, { membership: true }),
        session: await makeUser(`${label}-session`, { session: true }),
        verified: await makeUser(`${label}-verified`, { emailVerified: true }),
        young: await makeUser(`${label}-young`, { hours: 23 }),
      };
      return ids;
    };
    // `reader` sees the rows the probe wrote: the same connection in a mutant's transaction, the owner for the real function
    const probe = async (
      client: Client,
      label: string,
      reader: { query: Client["query"] } = client
    ) => {
      const ids = await everythingEligible(label);
      await client.query("SELECT public.purge_unverified_users(1000)");
      assert.equal(await existsIn(client, ids.control), false, "control goes");
      assert.equal(
        (
          await reader.query(
            "SELECT 1 FROM public.legal_acceptance_contract_end WHERE user_id = $1",
            [ids.control]
          )
        ).rows.length,
        1,
        "the end of the contract of the control is recorded"
      );
      for (const [name, id] of Object.entries(ids)) {
        if (name !== "control") {
          assert.equal(await existsIn(client, id), true, `${name} is kept`);
        }
      }
    };
    const existsIn = async (client: Client, id: string) =>
      (await client.query('SELECT 1 FROM public."user" WHERE id = $1', [id]))
        .rows.length === 1;
    // the first text is the one of the candidate query; the same with `doomed` is the check of the delete, taken out too
    const mutants: [string, string, string, boolean][] = [
      ["e-mail verified", "NOT candidate.email_verified", "true", false],
      [
        "Google account",
        "NOT EXISTS (SELECT 1 FROM public.account AS other WHERE other.user_id = candidate.id AND other.provider_id <> 'credential')",
        "true",
        false,
      ],
      [
        "session",
        "NOT EXISTS (SELECT 1 FROM public.session AS live WHERE live.user_id = candidate.id)",
        "true",
        false,
      ],
      ["24 hours", "interval '24 hours'", "interval '1 second'", false],
      [
        "last link",
        "(candidate.verification_link_expires_at IS NULL OR candidate.verification_link_expires_at < pg_catalog.clock_timestamp())",
        "true",
        false,
      ],
      [
        "end of the contract",
        "SELECT deleted.id, 'unverified_user_deleted' FROM deleted\n    ON CONFLICT DO NOTHING",
        "SELECT deleted.id, 'unverified_user_deleted' FROM deleted WHERE false\n    ON CONFLICT DO NOTHING",
        false,
      ],
      // the foreign key (restrict, 23001) refuses the delete of a user with a membership, so the call fails as a whole
      [
        "membership",
        "NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.user_id = candidate.id)",
        "true",
        true,
      ],
    ];
    const mutationClient = await owner.pool.connect();
    try {
      const original = await definitionOf(mutationClient);
      for (const [label, from, to, anyError] of mutants) {
        assert.ok(original.includes(from), `${label}: the text exists`);
        const mutated = original
          .replaceAll(from, to)
          .replaceAll(from.replaceAll("candidate.", "doomed."), to);
        assert.notEqual(mutated, original, `${label}: it changes the function`);
        await mutationClient.query("BEGIN");
        try {
          await mutationClient.query(mutated);
          await assert.rejects(
            () => probe(mutationClient, `mutant-${label.replaceAll(" ", "")}`),
            (error: unknown) =>
              anyError
                ? sqlState(error) === "23001"
                : error instanceof assert.AssertionError,
            `the probe catches the function without the condition: ${label}`
          );
        } finally {
          await mutationClient.query("ROLLBACK");
        }
        assert.equal(
          await definitionOf(mutationClient),
          original,
          `${label}: the function is back to what the migration made`
        );
      }
    } finally {
      mutationClient.release();
    }
    // and the real function passes the same probe
    await probe(authClient, "real", owner.pool);
    tests.push(
      "the gate fails on a function without a condition: with the e-mail check, the Google check, the session check, the 24 hours, the check of the last link or the record of the end of the contract taken out (and with the membership check taken out, where the foreign key refuses), the probe fails inside a transaction that is rolled back; the real function passes the same probe afterwards, unchanged"
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
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    const cleanup = async (
      label: string,
      text: string,
      values: unknown[] = []
    ) => {
      try {
        await owner.pool.query(text, values);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    await cleanup(
      "memberships",
      "DELETE FROM public.memberships WHERE organization_id = ANY ($1)",
      [organizationIds]
    );
    await cleanup(
      "organizations",
      "DELETE FROM public.organizations WHERE id = ANY ($1)",
      [organizationIds]
    );
    await cleanup("user", 'DELETE FROM public."user" WHERE id LIKE $1', [
      `gate-unv-%-${suffix}`,
    ]);
    for (const [role, group] of logins) {
      await cleanup("revoke", `REVOKE "${group}" FROM "${role}"`);
      await cleanup("role", `DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Unverified user purge gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Unverified user purge PostgreSQL gate failed (${redactedFailure(error)}, ${sqlState(error) ?? "no sqlstate"})`
  );
  process.exitCode = 1;
});
