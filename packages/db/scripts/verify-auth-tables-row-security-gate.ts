// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { account, user, verification } from "../src/schema/auth";
import { assertClean, findViolations } from "./definer-hardening-checks";
import {
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * Row security with FORCE on `"user"`, `account`, `verification` and `auth_security_audit_event` (migration 0098, design
 * t221) on a real PostgreSQL 18. Every role enters through a login of its own (LOGIN, member of its group with INHERIT
 * and without SET), never through SET ROLE of the admin, who only builds the fixtures and the planted defects:
 *   1. the catalog: the five tables (session too) with row security enabled and forced, the exact policies (name,
 *      command, role, expressions, none TO PUBLIC), the exact grants of before, and the read-only checks of the
 *      definer-hardening gate clean; every value of `auth_security_audit_event_type` is classified, in exactly one of
 *      the two lists below (a new value with no class fails the gate);
 *   2. Better Auth's runtime does what its adapter does (insert, find by e-mail and by id, verify, the link's deadline,
 *      the password, the values of `verification`, the Google account found by provider and account id, linked and its
 *      tokens updated) and its DELETE of a user still cascades to account, session, devices, device links, closure
 *      notices and trial claims; it reads no audit row;
 *   3. the audit, by behavior: each type is accepted from exactly one side (the auth runtime, or the owners); an owner
 *      writes only its own type, the device owner only with the actor of its scope;
 *   4. the purge owner sees only users never verified and their accounts and sessions, its UPDATE changes no row (the
 *      lock only) and its DELETE of a verified user deletes nothing; the purge deletes the one never verified and keeps
 *      the verified one, the one with a session and the one with a Google account;
 *   5. the onboarding owner sees only the user of its scope; the real function creates the organization, and without
 *      its set_config it finds no user;
 *   6. the notice owner sees only the user of the notice of its scope while it is owed; the address answers through
 *      the auth runtime, a notice sent answers null, and without the set_config the function answers null; the check of
 *      an unverified owner answers row by row in one statement, two notices of two owners of the same cycle;
 *   7. a body of end_device_sessions that writes another user as the actor fails with 42501 and undoes the revocation;
 *   8. other runtimes are refused (42501) on the four tables, and the gate fails on planted defects of the catalog: the
 *      policy of the auth runtime dropped (sign-up and /get-session break), a policy TO PUBLIC, a grant with no policy
 *      and a table without FORCE.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const AUTH_RUNTIME = "polaris_auth_runtime";
const UNVERIFIED_OWNER = "polaris_unverified_user_owner";
const ONBOARDING_OWNER = "polaris_onboarding_owner";
const NOTICE_OWNER = "polaris_notice_recipient_owner";
const DEVICE_OWNER = "polaris_device_session_owner";
const ADMIN_OWNER = "polaris_admin_owner";
const TABLES = [
  "account",
  "auth_security_audit_event",
  "session",
  "user",
  "verification",
] as const;

/** The types Better Auth's runtime writes (auth.ts and the login lock). */
const AUTH_RUNTIME_TYPES = [
  "google_callback_failed",
  "google_callback_succeeded",
  "google_login_started",
  "login_locked",
  "login_unlocked",
  "logout_failed",
  "logout_succeeded",
  "password_changed",
  "password_reset_completed",
  "password_set",
];
/** The types only an owner writes, each from its own function: never the auth runtime. */
const OWNER_ONLY_TYPES = ["device_revoked", "unverified_user_deleted"];

const DEVICE_SCOPE = "app.owner_scope.device_session_user_id";
const ONBOARDING_SCOPE = "app.owner_scope.onboarding_user_id";
const NOTICE_SCOPE = "app.owner_scope.notice_recipient_notice_id";
const BILLING_NOTICE_SCOPE =
  "app.owner_scope.billing_notice_recipient_notice_id";
const ofUnverified = (table: string) =>
  `(EXISTS ( SELECT 1\n   FROM "user" u\n  WHERE ((u.id = ${table}.user_id) AND (NOT u.email_verified))))`;
const deviceScope = `NULLIF(current_setting('${DEVICE_SCOPE}'::text, true), ''::text)`;
const onboardingScope = `(id = NULLIF(current_setting('${ONBOARDING_SCOPE}'::text, true), ''::text))`;

interface PolicyRow {
  cmd: string;
  permissive: string;
  policy: string;
  qual: string | null;
  roles: string[];
  with_check: string | null;
}

const policy = (
  name: string,
  cmd: string,
  role: string,
  qual: string | null,
  withCheck: string | null = null
): PolicyRow => ({
  cmd,
  permissive: "PERMISSIVE",
  policy: name,
  qual,
  roles: [role],
  with_check: withCheck,
});

/** Every policy of the five tables, as PostgreSQL deparses it, in the order of `table.policy`. */
const EXPECTED_POLICIES: PolicyRow[] = [
  policy(
    "account.account_auth_runtime_all",
    "ALL",
    AUTH_RUNTIME,
    "true",
    "true"
  ),
  policy(
    "account.account_unverified_user_owner_select",
    "SELECT",
    UNVERIFIED_OWNER,
    ofUnverified("account")
  ),
  policy(
    "auth_security_audit_event.auth_security_audit_event_auth_runtime_insert",
    "INSERT",
    AUTH_RUNTIME,
    null,
    "(event_type <> ALL (ARRAY['device_revoked'::auth_security_audit_event_type, 'unverified_user_deleted'::auth_security_audit_event_type]))"
  ),
  policy(
    "auth_security_audit_event.auth_security_audit_event_device_session_owner_insert",
    "INSERT",
    DEVICE_OWNER,
    null,
    `((event_type = 'device_revoked'::auth_security_audit_event_type) AND (actor_id = ${deviceScope}))`
  ),
  policy(
    "auth_security_audit_event.auth_security_audit_event_unverified_user_owner_insert",
    "INSERT",
    UNVERIFIED_OWNER,
    null,
    "((event_type = 'unverified_user_deleted'::auth_security_audit_event_type) AND (outcome = 'succeeded'::auth_security_audit_outcome) AND (actor_id IS NULL))"
  ),
  policy(
    "session.session_auth_runtime_all",
    "ALL",
    AUTH_RUNTIME,
    "true",
    "true"
  ),
  policy(
    "session.session_device_session_owner_delete",
    "DELETE",
    DEVICE_OWNER,
    `(user_id = ${deviceScope})`
  ),
  policy(
    "session.session_device_session_owner_select",
    "SELECT",
    DEVICE_OWNER,
    `(user_id = ${deviceScope})`
  ),
  policy(
    "session.session_unverified_user_owner_select",
    "SELECT",
    UNVERIFIED_OWNER,
    ofUnverified("session")
  ),
  // the sign-ups of the activation funnel (0105, ADR 0071 amended): three columns, counted by week, never a row out
  policy("user.user_admin_owner_select", "SELECT", ADMIN_OWNER, "true"),
  policy("user.user_auth_runtime_all", "ALL", AUTH_RUNTIME, "true", "true"),
  policy(
    "user.user_notice_recipient_owner_select",
    "SELECT",
    NOTICE_OWNER,
    `(EXISTS ( SELECT 1\n   FROM closure_notices n\n  WHERE (((n.id)::text = NULLIF(current_setting('${NOTICE_SCOPE}'::text, true), ''::text)) AND (n.user_id = "user".id))))`
  ),
  // the billing notice of the call (0101): the welcome's person, or an active owner of the store of a notice of the cycle
  policy(
    "user.user_notice_recipient_owner_select_billing",
    "SELECT",
    NOTICE_OWNER,
    `(EXISTS ( SELECT 1\n   FROM billing_notices n\n  WHERE ((n.id =\n        CASE\n            WHEN (current_setting('${BILLING_NOTICE_SCOPE}'::text, true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) THEN (current_setting('${BILLING_NOTICE_SCOPE}'::text, true))::uuid\n            ELSE NULL::uuid\n        END) AND ((n.user_id = "user".id) OR ((n.user_id IS NULL) AND (EXISTS ( SELECT 1\n           FROM memberships m\n          WHERE ((m.organization_id = n.organization_id) AND (m.user_id = "user".id) AND (m.role = 'owner'::text) AND (m.status = 'active'::text)))))))))`
  ),
  policy(
    "user.user_onboarding_owner_lock",
    "UPDATE",
    ONBOARDING_OWNER,
    onboardingScope,
    "false"
  ),
  policy(
    "user.user_onboarding_owner_select",
    "SELECT",
    ONBOARDING_OWNER,
    onboardingScope
  ),
  policy(
    "user.user_unverified_user_owner_delete",
    "DELETE",
    UNVERIFIED_OWNER,
    "(NOT email_verified)"
  ),
  policy(
    "user.user_unverified_user_owner_lock",
    "UPDATE",
    UNVERIFIED_OWNER,
    "(NOT email_verified)",
    "false"
  ),
  policy(
    "user.user_unverified_user_owner_select",
    "SELECT",
    UNVERIFIED_OWNER,
    "(NOT email_verified)"
  ),
  policy(
    "verification.verification_auth_runtime_all",
    "ALL",
    AUTH_RUNTIME,
    "true",
    "true"
  ),
];

/**
 * The grants of the four tables to `polaris_*` roles and PUBLIC, the ones of before 0098 plus the three columns of
 * `"user"` the activation funnel counts (0105) (`table grantee PRIVILEGE (column)`).
 */
const EXPECTED_GRANTS = [
  "account polaris_auth_runtime DELETE",
  "account polaris_auth_runtime INSERT",
  "account polaris_auth_runtime SELECT",
  "account polaris_auth_runtime UPDATE",
  "account polaris_unverified_user_owner SELECT (provider_id)",
  "account polaris_unverified_user_owner SELECT (user_id)",
  "auth_security_audit_event polaris_auth_runtime INSERT",
  "auth_security_audit_event polaris_device_session_owner INSERT",
  "auth_security_audit_event polaris_unverified_user_owner INSERT (event_type)",
  "auth_security_audit_event polaris_unverified_user_owner INSERT (outcome)",
  "auth_security_audit_event polaris_unverified_user_owner INSERT (request_id)",
  "auth_security_audit_event polaris_unverified_user_owner INSERT (subject_id)",
  "user polaris_admin_owner SELECT (created_at)",
  "user polaris_admin_owner SELECT (email_verified)",
  "user polaris_admin_owner SELECT (id)",
  "user polaris_auth_runtime DELETE",
  "user polaris_auth_runtime INSERT",
  "user polaris_auth_runtime SELECT",
  "user polaris_auth_runtime UPDATE",
  "user polaris_notice_recipient_owner SELECT (email)",
  "user polaris_notice_recipient_owner SELECT (email_verified)",
  "user polaris_notice_recipient_owner SELECT (id)",
  "user polaris_onboarding_owner SELECT (email_verified)",
  "user polaris_onboarding_owner SELECT (id)",
  "user polaris_onboarding_owner UPDATE (updated_at)",
  "user polaris_unverified_user_owner DELETE",
  "user polaris_unverified_user_owner SELECT (created_at)",
  "user polaris_unverified_user_owner SELECT (email_verified)",
  "user polaris_unverified_user_owner SELECT (id)",
  "user polaris_unverified_user_owner SELECT (verification_link_expires_at)",
  "user polaris_unverified_user_owner UPDATE (updated_at)",
  "verification polaris_auth_runtime DELETE",
  "verification polaris_auth_runtime INSERT",
  "verification polaris_auth_runtime SELECT",
  "verification polaris_auth_runtime UPDATE",
];

// the line each function writes its scope with, taken out by the planted defects
const ONBOARDING_SCOPE_LINE = `PERFORM pg_catalog.set_config('${ONBOARDING_SCOPE}', p_user_id, true);`;
const NOTICE_SCOPE_LINE = `PERFORM pg_catalog.set_config('${NOTICE_SCOPE}', COALESCE(p_notice::text, ''), true);`;
const DEVICE_AUDIT_ACTOR = "'device_revoked', 'succeeded', v_user,";
const USER_NOT_FOUND = "user_not_found";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, scenario by scenario
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const tests: string[] = [];
  const logins: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  const cleanupFailures: string[] = [];
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  let authPolicyDropped = false;
  let primaryFailure = false;
  const tag = randomUUID().slice(0, 8);

  /** A login of its own, member of the group with INHERIT and without SET: the way a Worker's login is. */
  const login = async (group: string) => {
    const role = `polaris_authrls_gate_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    logins.push(role);
    await admin.query(
      `GRANT "${group}" TO "${role}" WITH INHERIT TRUE, SET FALSE`
    );
    const client = new Client({
      connectionString: temporaryRuntimeUrl(adminUrl, role, password),
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    closers.push(() => client.end());
    return { client, password, role };
  };
  const makeUser = async (
    label: string,
    spec: { hours?: number; verified?: boolean } = {}
  ) => {
    const id = `gate-authrls-${label}-${tag}`;
    await admin.query(
      `INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Pessoa de teste', $2, $3, now() - make_interval(hours => $4), now() - make_interval(hours => $4))`,
      [id, `${id}@example.invalid`, spec.verified ?? true, spec.hours ?? 0]
    );
    userIds.push(id);
    return id;
  };
  const makeOrganization = async (label: string, owners: string[]) => {
    const id = randomUUID();
    await admin.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
      [id, `Loja ${label}`]
    );
    organizationIds.push(id);
    for (const owner of owners) {
      await admin.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [id, owner]
      );
    }
    return id;
  };
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const visible = async (client: Client, sql: string, values: unknown[]) =>
    ids((await client.query<{ id: string }>(sql, values)).rows);
  const exists = async (table: string, column: string, value: string) =>
    (
      await admin.query(
        `SELECT 1 FROM public.${table} WHERE ${column} = $1 LIMIT 1`,
        [value]
      )
    ).rows.length === 1;
  const definitionOf = async (signature: string) =>
    String(
      (
        await admin.query<{ definition: string }>(
          "SELECT pg_get_functiondef($1::regprocedure) AS definition",
          [signature]
        )
      ).rows[0]?.definition
    );
  /** The policies of the five tables that differ from EXPECTED_POLICIES (`+` found, `-` missing). */
  const policyDrift = async () => {
    const found = (
      await admin.query<PolicyRow>(
        `SELECT tablename || '.' || policyname AS policy, permissive, cmd, roles::text[] AS roles, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY ($1::text[])
          ORDER BY 1`,
        [TABLES]
      )
    ).rows;
    const key = (row: PolicyRow) =>
      JSON.stringify([
        row.policy,
        row.cmd,
        row.permissive,
        row.roles,
        row.qual,
        row.with_check,
      ]);
    const expected = new Set(EXPECTED_POLICIES.map(key));
    const actual = new Set(found.map(key));
    return [
      ...found
        .filter((row) => !expected.has(key(row)))
        .map((row) => `+ ${row.policy}`),
      ...EXPECTED_POLICIES.filter((row) => !actual.has(key(row))).map(
        (row) => `- ${row.policy}`
      ),
    ];
  };
  /** Runs `body` in a transaction of the admin that is always rolled back (the planted defects). */
  const rolledBack = async (body: () => Promise<void>) => {
    await admin.query("BEGIN");
    try {
      await body();
    } finally {
      await admin.query("ROLLBACK");
    }
  };

  try {
    const server = await admin.query<{
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
    const migrations = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // ------------------------------------------------------------------ 1. the catalog
    const forced = await admin.query<{ forced: boolean; relname: string }>(
      `SELECT relname, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1::text[]) ORDER BY relname`,
      [TABLES]
    );
    assert.deepEqual(
      forced.rows,
      TABLES.map((relname) => ({ forced: true, relname }))
    );
    assert.deepEqual(await policyDrift(), [], "the exact policies");
    const grants = await admin.query<{ grant: string }>(
      `WITH entries AS (
         SELECT c.relname, a.grantee, a.privilege_type, NULL::text AS column_name
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])
         UNION
         SELECT c.relname, a.grantee, a.privilege_type, att.attname::text
           FROM pg_class c
           JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped,
                aclexplode(att.attacl) a
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])
       )
       SELECT (relname || ' ' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END || ' ' || privilege_type
                || COALESCE(' (' || column_name || ')', '')) COLLATE "C" AS grant
         FROM entries
        WHERE grantee = 0 OR pg_get_userbyid(grantee) LIKE 'polaris\\_%'
        ORDER BY 1`,
      [["user", "account", "verification", "auth_security_audit_event"]]
    );
    assert.deepEqual(
      grants.rows.map((row) => row.grant),
      EXPECTED_GRANTS,
      "the grants of the four tables are the ones of before 0098, plus the funnel's three columns of 0105"
    );
    assertClean(await findViolations(admin));
    const types = (
      await admin.query<{ value: string }>(
        "SELECT unnest(enum_range(NULL::public.auth_security_audit_event_type))::text AS value ORDER BY 1"
      )
    ).rows.map((row) => row.value);
    assert.deepEqual(
      [...types].sort(),
      [...AUTH_RUNTIME_TYPES, ...OWNER_ONLY_TYPES].sort(),
      "every type of the auth audit is classified in exactly one list of this gate (auth runtime or owner only)"
    );
    assert.equal(
      AUTH_RUNTIME_TYPES.filter((type) => OWNER_ONLY_TYPES.includes(type))
        .length,
      0
    );
    tests.push(
      '"user", account, verification, auth_security_audit_event and session have row security enabled and forced, with exactly the designed policies (each TO one role, none TO PUBLIC, the owners on their predicate or scope, the UPDATE of the owners with a false check) and exactly the grants of before; the read-only checks of definer-hardening are clean (tableWithoutRowSecurity with no exception, forcedTableOwnerWithoutBypass, rowSecurityWithoutPolicy, scopeWithoutWriter, ownerScope); every value of auth_security_audit_event_type is in exactly one of the two lists of the gate'
    );

    // ------------------------------------------------------------------ logins
    const auth = await login(AUTH_RUNTIME);
    const unverifiedOwner = await login(UNVERIFIED_OWNER);
    const onboardingOwner = await login(ONBOARDING_OWNER);
    const onboardingRuntime = await login("polaris_onboarding_runtime");
    const noticeOwner = await login(NOTICE_OWNER);
    const deviceOwner = await login(DEVICE_OWNER);
    const others: ({ group: string } & Awaited<ReturnType<typeof login>>)[] =
      [];
    for (const group of [
      "polaris_pr11_runtime",
      "polaris_privacy_runtime",
      "polaris_admin_runtime",
    ]) {
      others.push({ group, ...(await login(group)) });
    }

    // ------------------------------------------------------------------ 2. Better Auth's runtime, as its adapter does
    const authDatabase = createDatabase(
      temporaryRuntimeUrl(adminUrl, auth.role, auth.password),
      { maxConnections: 1 }
    );
    closers.push(() => authDatabase.pool.end());
    const { db } = authDatabase;
    const signUpId = `gate-authrls-signup-${tag}`;
    const signUpEmail = `${signUpId}@example.invalid`;
    userIds.push(signUpId);
    await db.insert(user).values({
      email: signUpEmail,
      emailVerified: false,
      id: signUpId,
      name: "Pessoa de teste",
    });
    await db.insert(account).values({
      accountId: signUpId,
      id: `${signUpId}-credential`,
      password: "hash-1",
      providerId: "credential",
      userId: signUpId,
    });
    const byEmail = await db
      .select()
      .from(user)
      .where(eq(user.email, signUpEmail));
    assert.equal(byEmail[0]?.id, signUpId, "find by e-mail");
    const linkExpires = new Date(Date.now() + 3_600_000);
    await db
      .update(user)
      .set({ verificationLinkExpiresAt: linkExpires })
      .where(eq(user.id, signUpId));
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, signUpId));
    const byId = await db.select().from(user).where(eq(user.id, signUpId));
    assert.equal(
      byId[0]?.emailVerified,
      true,
      "verified, found by id (/get-session)"
    );
    await db
      .update(account)
      .set({ password: "hash-2" })
      .where(
        and(eq(account.userId, signUpId), eq(account.providerId, "credential"))
      );
    const credential = await db
      .select()
      .from(account)
      .where(eq(account.userId, signUpId));
    assert.equal(credential[0]?.password, "hash-2", "the password changed");
    const verificationId = `gate-authrls-verification-${tag}`;
    await db.insert(verification).values({
      expiresAt: new Date(Date.now() + 3_600_000),
      id: verificationId,
      identifier: `reset-password:${verificationId}`,
      value: signUpId,
    });
    const value = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `reset-password:${verificationId}`));
    assert.equal(
      value[0]?.value,
      signUpId,
      "the value of the reset is read back"
    );
    await db.delete(verification).where(eq(verification.id, verificationId));
    assert.equal(await exists("verification", "id", verificationId), false);
    // Google: the account found by provider and account id, linked, and its tokens updated
    const googleAccountId = `google-${tag}`;
    const noGoogle = await db
      .select()
      .from(account)
      .where(
        and(
          eq(account.providerId, "google"),
          eq(account.accountId, googleAccountId)
        )
      );
    assert.equal(noGoogle.length, 0);
    await db.insert(account).values({
      accessToken: "access-1",
      accountId: googleAccountId,
      id: `${signUpId}-google`,
      providerId: "google",
      userId: signUpId,
    });
    await db
      .update(account)
      .set({ accessToken: "access-2" })
      .where(eq(account.id, `${signUpId}-google`));
    const google = await db
      .select()
      .from(account)
      .where(
        and(
          eq(account.providerId, "google"),
          eq(account.accountId, googleAccountId)
        )
      );
    assert.equal(
      google[0]?.accessToken,
      "access-2",
      "the Google account, linked and updated"
    );
    // a new user through Google (created verified), found by e-mail afterwards
    const googleUserId = `gate-authrls-google-${tag}`;
    userIds.push(googleUserId);
    await db.insert(user).values({
      email: `${googleUserId}@example.invalid`,
      emailVerified: true,
      id: googleUserId,
      name: "Pessoa do Google",
    });
    assert.equal(
      (
        await db
          .select()
          .from(user)
          .where(eq(user.email, `${googleUserId}@example.invalid`))
      )[0]?.id,
      googleUserId
    );
    // the audit: the auth runtime writes and reads nothing back
    await expectSqlState(
      () =>
        auth.client.query(
          "SELECT 1 FROM public.auth_security_audit_event LIMIT 1"
        ),
      "42501",
      "the auth runtime reads no audit row"
    );
    // its DELETE of a user cascades through every child, whatever their row security
    const doomed = await makeUser("cascade");
    const doomedOrganization = await makeOrganization("cascade", []);
    await admin.query(
      "INSERT INTO public.account (id, account_id, provider_id, user_id) VALUES ($1, $1, 'credential', $2)",
      [`${doomed}-account`, doomed]
    );
    await admin.query(
      "INSERT INTO public.session (id, token, user_id, expires_at) VALUES ($1, $1, $2, now() + interval '1 day')",
      [`${doomed}-session`, doomed]
    );
    const device = await admin.query<{ id: string }>(
      "INSERT INTO public.devices (user_id) VALUES ($1) RETURNING id",
      [doomed]
    );
    const deviceId = device.rows[0]?.id;
    assert.ok(deviceId);
    await admin.query(
      "INSERT INTO public.device_sessions (device_id, session_id, user_id, origin) VALUES ($1, $2, $3, 'register')",
      [deviceId, `${doomed}-session`, doomed]
    );
    await admin.query(
      `INSERT INTO public.closure_notices (organization_id, closure_requested_at, milestone, due_at, user_id)
       VALUES ($1, now() - interval '1 day', 'closure', now(), $2)`,
      [doomedOrganization, doomed]
    );
    await admin.query(
      "INSERT INTO public.billing_trial_claims (organization_id, user_id, reserved_at) VALUES ($1, $2, now())",
      [doomedOrganization, doomed]
    );
    const deleted = await auth.client.query(
      'DELETE FROM public."user" WHERE id = $1',
      [doomed]
    );
    assert.equal(deleted.rowCount, 1);
    for (const [table, column] of [
      ["account", "user_id"],
      ["session", "user_id"],
      ["devices", "user_id"],
      ["device_sessions", "user_id"],
      ["closure_notices", "user_id"],
      ["billing_trial_claims", "user_id"],
    ] as const) {
      assert.equal(
        await exists(table, column, doomed),
        false,
        `${table} cascaded`
      );
    }
    tests.push(
      "Better Auth's runtime, through a real login and the queries of its adapter (Drizzle on the auth schema): inserts a user and its credential account, finds it by e-mail and by id, writes the deadline of the link and the verification, changes the password, writes, reads and deletes a value of verification, finds a Google account by provider and account id, links it and updates its tokens, creates a Google user; reads no audit row (42501); its DELETE of a user cascades to account, session, devices, device_sessions, closure_notices and billing_trial_claims"
    );

    // ------------------------------------------------------------------ 3. the audit, type by type
    const userA = await makeUser("a");
    const userB = await makeUser("b");
    const accepted = async (client: Client, sql: string, values: unknown[]) => {
      await client.query("BEGIN");
      try {
        await client.query(sql, values);
        return true;
      } catch (error) {
        assert.equal(
          (error as { code?: string }).code,
          "42501",
          `refused by row security, not by ${redactedFailure(error)}`
        );
        return false;
      } finally {
        await client.query("ROLLBACK");
      }
    };
    const byAuth: string[] = [];
    const byOwners: string[] = [];
    for (const type of types) {
      if (
        await accepted(
          auth.client,
          "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, actor_id) VALUES ($1, 'succeeded', 'gate', $2)",
          [type, userA]
        )
      ) {
        byAuth.push(type);
      }
      const byDevice = await accepted(
        deviceOwner.client,
        `SELECT pg_catalog.set_config('${DEVICE_SCOPE}', $2, true);
         INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, actor_id) VALUES ('${type}', 'succeeded', 'gate', '${userA}')`.replace(
          "$2",
          `'${userA}'`
        ),
        []
      );
      const byPurge = await accepted(
        unverifiedOwner.client,
        "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, subject_id) VALUES ($1, 'succeeded', 'gate', $2)",
        [type, userA]
      );
      if (byDevice || byPurge) {
        byOwners.push(type);
      }
    }
    assert.deepEqual(
      byAuth.sort(),
      [...AUTH_RUNTIME_TYPES].sort(),
      "the auth runtime writes its types only"
    );
    assert.deepEqual(
      byOwners.sort(),
      [...OWNER_ONLY_TYPES].sort(),
      "the owners write their types only"
    );
    // the device owner: only with the actor of its scope; the purge owner: only succeeded, with no actor (no grant on it)
    assert.equal(
      await accepted(
        deviceOwner.client,
        `SELECT pg_catalog.set_config('${DEVICE_SCOPE}', '${userA}', true);
         INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, actor_id) VALUES ('device_revoked', 'succeeded', 'gate', '${userB}')`,
        []
      ),
      false,
      "the device owner, with the scope of A, writes no row with B as the actor"
    );
    assert.equal(
      await accepted(
        deviceOwner.client,
        "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, actor_id) VALUES ('device_revoked', 'succeeded', 'gate', $1)",
        [userA]
      ),
      false,
      "the device owner, with no scope, writes nothing"
    );
    assert.equal(
      await accepted(
        unverifiedOwner.client,
        "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, subject_id) VALUES ('unverified_user_deleted', 'failed', 'gate', $1)",
        [userA]
      ),
      false,
      "the purge owner writes only a deletion that succeeded"
    );
    tests.push(
      "the auth audit, inserting each value of the type through each real login: the auth runtime is accepted exactly on its ten types and refused (42501) on device_revoked and unverified_user_deleted; the owners are accepted exactly on those two (the device owner only with the actor of its scope, not with another user nor without the scope; the purge owner only as succeeded); no type is accepted from both sides"
    );

    // ------------------------------------------------------------------ 4. the purge owner
    const neverVerified = await makeUser("never-verified", {
      hours: 30,
      verified: false,
    });
    const verifiedOld = await makeUser("verified-old", { hours: 30 });
    const withSession = await makeUser("with-session", {
      hours: 30,
      verified: false,
    });
    const withGoogle = await makeUser("with-google", {
      hours: 30,
      verified: false,
    });
    await admin.query(
      "INSERT INTO public.session (id, token, user_id, expires_at) VALUES ($1, $1, $2, now() + interval '1 day'), ($3, $3, $4, now() + interval '1 day')",
      [`${withSession}-s`, withSession, `${verifiedOld}-s`, verifiedOld]
    );
    await admin.query(
      "INSERT INTO public.account (id, account_id, provider_id, user_id) VALUES ($1, $1, 'google', $2), ($3, $3, 'google', $4), ($5, $5, 'credential', $6)",
      [
        `${withGoogle}-g`,
        withGoogle,
        `${verifiedOld}-g`,
        verifiedOld,
        `${neverVerified}-c`,
        neverVerified,
      ]
    );
    const purgeUsers = [neverVerified, verifiedOld, withSession, withGoogle];
    assert.deepEqual(
      await visible(
        unverifiedOwner.client,
        'SELECT id FROM public."user" WHERE id = ANY ($1)',
        [purgeUsers]
      ),
      [neverVerified, withGoogle, withSession].sort(),
      "the purge owner sees only the users never verified"
    );
    assert.deepEqual(
      (
        await unverifiedOwner.client.query<{ user_id: string }>(
          "SELECT user_id FROM public.account WHERE user_id = ANY ($1) ORDER BY 1",
          [purgeUsers]
        )
      ).rows.map((row) => row.user_id),
      [neverVerified, withGoogle].sort(),
      "and only their accounts"
    );
    assert.deepEqual(
      (
        await unverifiedOwner.client.query<{ user_id: string }>(
          "SELECT user_id FROM public.session WHERE user_id = ANY ($1) ORDER BY 1",
          [purgeUsers]
        )
      ).rows.map((row) => row.user_id),
      [withSession],
      "and only their sessions"
    );
    await expectSqlState(
      () =>
        unverifiedOwner.client.query(
          'UPDATE public."user" SET updated_at = now() WHERE id = $1',
          [neverVerified]
        ),
      "42501",
      "the purge owner changes no user (its UPDATE is for the lock only)"
    );
    await unverifiedOwner.client.query("BEGIN");
    try {
      assert.deepEqual(
        await visible(
          unverifiedOwner.client,
          'SELECT id FROM public."user" WHERE id = $1 FOR UPDATE SKIP LOCKED',
          [neverVerified]
        ),
        [neverVerified],
        "the lock of the candidates still works"
      );
    } finally {
      await unverifiedOwner.client.query("ROLLBACK");
    }
    const deleteVerified = await unverifiedOwner.client.query(
      'DELETE FROM public."user" WHERE id = $1',
      [verifiedOld]
    );
    assert.equal(
      deleteVerified.rowCount,
      0,
      "a DELETE of a verified user deletes nothing"
    );
    await auth.client.query("SELECT public.purge_unverified_users(1000)");
    assert.equal(
      await exists("user", "id", neverVerified),
      false,
      "the one never verified goes"
    );
    for (const kept of [verifiedOld, withSession, withGoogle]) {
      assert.equal(await exists("user", "id", kept), true, `${kept} is kept`);
    }
    tests.push(
      "the purge owner, through a real login: sees only the users never verified, and only their accounts and sessions; its UPDATE of a user is refused (42501) while FOR UPDATE SKIP LOCKED still locks a candidate; its DELETE of a verified user deletes nothing; the purge (through the auth runtime) deletes the user never verified and keeps the verified one (with a session and a Google account), the one never verified with a session and the one never verified with a Google account"
    );

    // ------------------------------------------------------------------ 5. the onboarding owner
    const founder = await makeUser("founder");
    await onboardingOwner.client.query("BEGIN");
    try {
      assert.deepEqual(
        await visible(
          onboardingOwner.client,
          'SELECT id FROM public."user"',
          []
        ),
        [],
        "with no scope the onboarding owner sees no user"
      );
      await onboardingOwner.client.query(
        "SELECT pg_catalog.set_config($1, $2, true)",
        [ONBOARDING_SCOPE, founder]
      );
      assert.deepEqual(
        await visible(
          onboardingOwner.client,
          'SELECT id FROM public."user"',
          []
        ),
        [founder],
        "with the scope of one user, a SELECT with no WHERE sees that user alone"
      );
      await expectSqlState(
        () =>
          onboardingOwner.client.query(
            'UPDATE public."user" SET updated_at = now() WHERE id = $1',
            [founder]
          ),
        "42501",
        "the onboarding owner changes no user (its UPDATE is for FOR SHARE only)"
      );
    } finally {
      await onboardingOwner.client.query("ROLLBACK");
    }
    const created = await onboardingRuntime.client.query<{
      created: boolean;
      id: string;
    }>(
      "SELECT created, id FROM public.create_initial_organization($1, $2, 'Loja do gate', 'America/Sao_Paulo', $3)",
      [founder, randomUUID(), randomUUID()]
    );
    assert.equal(
      created.rows[0]?.created,
      true,
      "the real function creates the organization"
    );
    const onboardingSignature =
      "public.create_initial_organization(text,text,text,text,uuid)";
    const onboardingBody = await definitionOf(onboardingSignature);
    assert.ok(onboardingBody.includes(ONBOARDING_SCOPE_LINE));
    const newcomer = await makeUser("newcomer");
    await rolledBack(async () => {
      await admin.query(onboardingBody.replace(ONBOARDING_SCOPE_LINE, ""));
      await assert.rejects(
        () =>
          admin.query(
            "SELECT created FROM public.create_initial_organization($1, $2, 'Loja do gate', 'America/Sao_Paulo', $3)",
            [newcomer, randomUUID(), randomUUID()]
          ),
        (error: unknown) =>
          (error as { detail?: string }).detail === USER_NOT_FOUND,
        "without its set_config the function finds no user"
      );
    });
    assert.equal(await definitionOf(onboardingSignature), onboardingBody);
    tests.push(
      "the onboarding owner, through a real login: sees no user without its scope and, with the scope of one user, only that one with a SELECT with no WHERE; its UPDATE is refused (42501); the real function (through the onboarding runtime) creates the organization, and the same body without its set_config fails with user_not_found (rolled back)"
    );

    // ------------------------------------------------------------------ 6. the notice owner
    const ownerA = await makeUser("notice-a");
    const ownerB = await makeUser("notice-b");
    const noticeOrganization = await makeOrganization("notices", [
      ownerA,
      ownerB,
    ]);
    const notice = async (owner: string, reissue: number) =>
      String(
        (
          await admin.query<{ id: string }>(
            `INSERT INTO public.closure_notices (organization_id, closure_requested_at, milestone, due_at, user_id, reissue)
             VALUES ($1, date_trunc('day', now()) - interval '10 days', 'd7', now(), $2, $3) RETURNING id`,
            [noticeOrganization, owner, reissue]
          )
        ).rows[0]?.id
      );
    const noticeA = await notice(ownerA, 0);
    const noticeB = await notice(ownerB, 1);
    const recipient = async (client: Client, id: string) =>
      (
        await client.query<{
          value: { email?: string; verified: boolean } | null;
        }>("SELECT public.closure_notice_recipient($1::uuid, $2) AS value", [
          id,
          noticeOrganization,
        ])
      ).rows[0]?.value;
    assert.deepEqual(await recipient(auth.client, noticeA), {
      email: `${ownerA}@example.invalid`,
      verified: true,
    });
    const asNoticeOwner = async (scope: string | null) => {
      await noticeOwner.client.query("BEGIN");
      try {
        if (scope !== null) {
          await noticeOwner.client.query(
            "SELECT pg_catalog.set_config($1, $2, true)",
            [NOTICE_SCOPE, scope]
          );
        }
        return await visible(
          noticeOwner.client,
          'SELECT id FROM public."user"',
          []
        );
      } finally {
        await noticeOwner.client.query("ROLLBACK");
      }
    };
    assert.deepEqual(await asNoticeOwner(null), [], "no scope, no user");
    assert.deepEqual(
      await asNoticeOwner(noticeA),
      [ownerA],
      "the scope of A's notice: A alone, never B"
    );
    assert.deepEqual(
      await asNoticeOwner("not-a-uuid"),
      [],
      "a malformed scope is false, never an error"
    );
    // a notice no longer owed opens no user, and the address answers null
    const sentNotice = await notice(ownerA, 2);
    await admin.query(
      "UPDATE public.closure_notices SET sent_at = now() WHERE id = $1",
      [sentNotice]
    );
    assert.deepEqual(
      await asNoticeOwner(sentNotice),
      [],
      "a notice sent opens no user"
    );
    assert.equal(await recipient(auth.client, sentNotice), null);
    // without the set_config the address answers null (the gate catches it)
    const recipientSignature = "public.closure_notice_recipient(uuid,text)";
    const recipientBody = await definitionOf(recipientSignature);
    assert.ok(recipientBody.includes(NOTICE_SCOPE_LINE));
    await rolledBack(async () => {
      await admin.query(recipientBody.replace(NOTICE_SCOPE_LINE, ""));
      assert.equal(
        await recipient(admin, noticeA),
        null,
        "without its set_config: null"
      );
    });
    assert.equal(await definitionOf(recipientSignature), recipientBody);
    // the check of an unverified owner, row by row: two notices of two owners of the same cycle in one statement
    await admin.query(
      'UPDATE public."user" SET email_verified = false WHERE id = $1',
      [ownerB]
    );
    await admin.query(
      "UPDATE public.closure_notices SET unverified_at = now() WHERE id = ANY ($1::uuid[])",
      [[noticeA, noticeB]]
    );
    // volatile, so it is never folded or inlined: each call writes its own scope
    assert.equal(
      (
        await admin.query<{ volatility: string }>(
          "SELECT provolatile AS volatility FROM pg_proc WHERE oid = 'public.closure_notice_owner_unverified(uuid,text)'::regprocedure"
        )
      ).rows[0]?.volatility,
      "v"
    );
    for (const order of ["ASC", "DESC"]) {
      const answers = await admin.query<{ id: string; unverified: boolean }>(
        `SELECT notice.id, public.closure_notice_owner_unverified(notice.id, notice.organization_id) AS unverified
           FROM public.closure_notices AS notice WHERE notice.id = ANY ($1::uuid[]) ORDER BY notice.reissue ${order}`,
        [[noticeA, noticeB]]
      );
      assert.deepEqual(
        Object.fromEntries(answers.rows.map((row) => [row.id, row.unverified])),
        { [noticeA]: false, [noticeB]: true },
        `each notice answered with its own scope (${order})`
      );
    }
    const unverifiedSignature =
      "public.closure_notice_owner_unverified(uuid,text)";
    const unverifiedBody = await definitionOf(unverifiedSignature);
    assert.ok(unverifiedBody.includes(NOTICE_SCOPE_LINE));
    await rolledBack(async () => {
      await admin.query(unverifiedBody.replace(NOTICE_SCOPE_LINE, ""));
      const answer = await admin.query<{ value: boolean }>(
        "SELECT public.closure_notice_owner_unverified($1::uuid, $2) AS value",
        [noticeB, noticeOrganization]
      );
      assert.equal(
        answer.rows[0]?.value,
        false,
        "without its set_config the owner of B is not seen"
      );
    });
    assert.equal(await definitionOf(unverifiedSignature), unverifiedBody);
    tests.push(
      "the notice owner, through a real login: sees no user without its scope or with a malformed one, only the user of the notice of its scope (never the other owner of the same organization) and none for a notice no longer owed; closure_notice_recipient (through the auth runtime) answers the address of the owed notice and null for one sent, and without its set_config answers null (rolled back); closure_notice_owner_unverified, in one statement over two notices of two owners of the same cycle, answers each with its own scope in both orders, and without its set_config does not see the unverified owner (rolled back)"
    );

    // ------------------------------------------------------------------ 7. end_device_sessions with the wrong actor
    const revoker = await makeUser("revoker");
    const revokedDevice = String(
      (
        await admin.query<{ id: string }>(
          "INSERT INTO public.devices (user_id, revoked_at) VALUES ($1, now()) RETURNING id",
          [revoker]
        )
      ).rows[0]?.id
    );
    await admin.query(
      "INSERT INTO public.session (id, token, user_id, expires_at) VALUES ($1, $1, $2, now() + interval '1 day')",
      [`${revoker}-s`, revoker]
    );
    await admin.query(
      "INSERT INTO public.device_sessions (device_id, session_id, user_id, origin) VALUES ($1, $2, $3, 'register')",
      [revokedDevice, `${revoker}-s`, revoker]
    );
    const deviceSignature =
      "public.end_device_sessions(uuid,text,boolean,boolean,text)";
    const deviceBody = await definitionOf(deviceSignature);
    assert.ok(deviceBody.includes(DEVICE_AUDIT_ACTOR));
    const endSessions = () =>
      admin.query(
        "SELECT * FROM public.end_device_sessions($1::uuid, NULL, false, true, 'gate-authrls')",
        [revokedDevice]
      );
    await rolledBack(async () => {
      await admin.query(
        "SELECT pg_catalog.set_config('app.user_id', $1, true)",
        [revoker]
      );
      await admin.query(
        deviceBody.replace(
          DEVICE_AUDIT_ACTOR,
          `'device_revoked', 'succeeded', '${userB}',`
        )
      );
      await admin.query("SAVEPOINT revocation");
      await expectSqlState(
        endSessions,
        "42501",
        "the audit row with another actor is refused"
      );
      await admin.query("ROLLBACK TO SAVEPOINT revocation");
      assert.equal(
        await exists("session", "id", `${revoker}-s`),
        true,
        "and the revocation is undone"
      );
    });
    assert.equal(await definitionOf(deviceSignature), deviceBody);
    await rolledBack(async () => {
      await admin.query(
        "SELECT pg_catalog.set_config('app.user_id', $1, true)",
        [revoker]
      );
      const ended = await endSessions();
      assert.equal(
        ended.rows[0]?.ended_session_count,
        1,
        "the real body ends the session"
      );
      const audit = await admin.query<{ actor_id: string }>(
        "SELECT actor_id FROM public.auth_security_audit_event WHERE event_type = 'device_revoked' AND subject_id = $1",
        [revokedDevice]
      );
      assert.deepEqual(
        audit.rows,
        [{ actor_id: revoker }],
        "and writes its row with its own actor"
      );
    });
    tests.push(
      "end_device_sessions with a body that writes another user as the actor of device_revoked fails with 42501 and the revocation is undone (the session stays); the real body ends the session and writes its row with the user of its scope (both rolled back)"
    );

    // ------------------------------------------------------------------ 8. other runtimes and planted defects
    for (const other of others) {
      for (const sql of [
        'SELECT 1 FROM public."user" LIMIT 1',
        "SELECT 1 FROM public.account LIMIT 1",
        "SELECT 1 FROM public.verification LIMIT 1",
        "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id) VALUES ('logout_succeeded', 'succeeded', 'gate')",
      ]) {
        await expectSqlState(
          () => other.client.query(sql),
          "42501",
          `${other.group}: ${sql}`
        );
      }
    }
    // the policy of the auth runtime dropped: sign-up and /get-session break, and the gate sees it
    await admin.query('DROP POLICY user_auth_runtime_all ON public."user"');
    authPolicyDropped = true;
    assert.deepEqual(await policyDrift(), ["- user.user_auth_runtime_all"]);
    await expectSqlState(
      () =>
        auth.client.query(
          `INSERT INTO public."user" (id, name, email) VALUES ($1, 'x', $2)`,
          [
            `gate-authrls-broken-${tag}`,
            `gate-authrls-broken-${tag}@example.invalid`,
          ]
        ),
      "42501",
      "sign-up without the policy"
    );
    assert.equal(
      (
        await auth.client.query('SELECT 1 FROM public."user" WHERE id = $1', [
          signUpId,
        ])
      ).rows.length,
      0,
      "/get-session without the policy finds no user"
    );
    await admin.query(
      'CREATE POLICY "user_auth_runtime_all" ON "user" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true)'
    );
    authPolicyDropped = false;
    assert.deepEqual(await policyDrift(), []);
    assert.equal(
      (
        await auth.client.query('SELECT 1 FROM public."user" WHERE id = $1', [
          signUpId,
        ])
      ).rows.length,
      1
    );
    await rolledBack(async () => {
      await admin.query(
        "CREATE POLICY gate_public ON public.account AS PERMISSIVE FOR SELECT USING (true)"
      );
      assert.deepEqual(
        await policyDrift(),
        ["+ account.gate_public"],
        "a policy TO PUBLIC"
      );
      await admin.query(
        "GRANT SELECT ON public.verification TO polaris_privacy_runtime"
      );
      assert.ok(
        (await findViolations(admin)).rowSecurityWithoutPolicy.includes(
          "public.verification polaris_privacy_runtime SELECT"
        ),
        "a grant with no policy"
      );
      await admin.query(
        "ALTER TABLE public.account NO FORCE ROW LEVEL SECURITY"
      );
      assert.deepEqual((await findViolations(admin)).tableWithoutRowSecurity, [
        "public.account",
      ]);
    });
    assertClean(await findViolations(admin));
    tests.push(
      'the tenant, privacy and Admin runtimes, through real logins, are refused (42501) on "user", account and verification and on the auth audit; with the policy of the auth runtime on "user" dropped, the sign-up is refused, /get-session finds no user and the exact policies of the gate differ (restored after); a policy TO PUBLIC, a grant with no policy and a table without FORCE are reported (rolled back)'
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
        await admin.query(text, values);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    if (authPolicyDropped) {
      await cleanup(
        "policy",
        'CREATE POLICY "user_auth_runtime_all" ON "user" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true)'
      );
    }
    for (const role of logins) {
      await cleanup("login", `DROP ROLE IF EXISTS "${role}"`);
    }
    // the fixtures: the organization made by the onboarding keeps its audit (immutable), so it stays, as in the other gates
    await cleanup(
      "notices",
      "DELETE FROM public.closure_notices WHERE organization_id = ANY ($1)",
      [organizationIds]
    );
    await cleanup(
      "memberships",
      "DELETE FROM public.memberships WHERE organization_id = ANY ($1)",
      [organizationIds]
    );
    await cleanup(
      "users",
      'DELETE FROM public."user" WHERE id = ANY ($1) AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = "user".id)',
      [userIds]
    );
    await cleanup(
      "organizations",
      "DELETE FROM public.organizations WHERE id = ANY ($1)",
      [organizationIds]
    );
    await admin.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Auth tables row security gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Auth tables row security PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
