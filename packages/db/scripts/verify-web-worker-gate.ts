import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/client";
import { isLocalGateHost } from "./gate-hosts";
import { assertDisposableEnvironment } from "./gate-target";
import {
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
} from "./sales-gate-support";
import {
  runWorkerdVitest,
  temporaryLogins,
  workerdSuiteFailure,
} from "./workerd-gate-support";

/**
 * The Web Worker through its own `fetch`, `scheduled` and `queue` handlers, inside workerd, against the PostgreSQL of
 * the job (T-121b). This script makes what the Worker needs (one login per Hyperdrive binding, two organizations and the
 * outbox events the test delivers), runs the Vitest project `web-workerd-db` (apps/web/worker/index.workerd-db.test.ts)
 * and then reads the database as the owner: what the scheduler, the dispatcher and the consumers must have written.
 * Local Postgres only (`CI=true`): the harness refuses any other host, and the Hyperdrive of this project is local
 * (the Neon proof of the Worker is the T-123c smoke).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

/**
 * The Hyperdrive binding of the Worker, the group role its login is granted, and a prefix for the login's name. The
 * roles the login ends up in, however far, are the group and what the group itself includes: only the privacy role
 * includes another (the reader of a closed organization's export, ADR 0081), and the test fails on any other.
 */
const BINDINGS = [
  ["AUTH_HYPERDRIVE", "polaris_auth_runtime", "auth", []],
  ["BILLING_HYPERDRIVE", "polaris_billing_runtime", "billing", []],
  ["HYPERDRIVE", runtimeRole, "tenant", []],
  ["MEDIA_CLEANUP_HYPERDRIVE", "polaris_media_cleanup_runtime", "media", []],
  ["ONBOARDING_HYPERDRIVE", "polaris_onboarding_runtime", "onboarding", []],
  ["OUTBOX_HYPERDRIVE", "polaris_outbox_runtime", "outbox", []],
  [
    "PRIVACY_HYPERDRIVE",
    "polaris_privacy_runtime",
    "privacy",
    ["polaris_closed_export_reader"],
  ],
] as const;
/** The tests of apps/web/worker/index.workerd-db.test.ts: one added or removed is changed here too, or the gate fails (an `it.each` counts one test per case). */
const WEB_WORKER_TESTS = 30;
const MAINTENANCE_JOBS = [
  "auth.login_lock_expiry",
  "auth.unverified_user_purge",
  "billing.maintenance",
  "media.maintenance",
  "privacy.maintenance",
];

interface Envelope {
  attempt: number;
  correlationId: string;
  event: Record<string, string | number | boolean>;
  eventId: string;
  idempotencyKey: string;
  organizationId: string;
  type: string;
  version: number;
}

async function run() {
  assert.equal(
    process.env.CI,
    "true",
    "The Web Worker gate runs only against the Postgres of the CI job."
  );
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);
  assert.ok(
    isLocalGateHost(parsedAdminUrl.hostname),
    "The Web Worker gate needs the job's own Postgres."
  );

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins = temporaryLogins(owner, adminUrl);
  const tests: string[] = [];

  try {
    // a database marked as staging, production or restore drill is refused, also when the gate runs outside the runner
    await assertDisposableEnvironment(owner.pool);
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

    // ------------------------------------------------- what the earlier gates left behind must not reach the Worker
    // their events, exports and billing events would be claimed by the dispatcher and the jobs, and a lane that ran already covers its window
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL, dispatched_at = now() WHERE status = 'pending'"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE status IN ('requested', 'running')"
    );
    // the billing gates leave provider events received or failed: the billing job would retry them, and fail on what no longer has its fixtures
    await owner.pool.query(
      "UPDATE public.billing_events SET status = 'ignored', outcome_code = 'not_applicable', processed_at = now() WHERE status IN ('received', 'failed', 'unresolved')"
    );
    await owner.pool.query("DELETE FROM public.scheduled_job_state");

    // ------------------------------------------------- fixtures
    const loginsByBinding: Record<string, { groups: string[]; login: string }> =
      {};
    const urls: Record<string, string> = {};
    for (const [binding, group, prefix, included] of BINDINGS) {
      // biome-ignore lint/performance/noAwaitInLoops: one login at a time, for a clear failure
      const url = await logins.login(group, `polaris_wkw_${prefix}`);
      urls[`POLARIS_WEB_WORKER_${binding}_URL`] = url;
      loginsByBinding[binding] = {
        groups: [...included, group].sort(),
        login: decodeURIComponent(new URL(url).username),
      };
    }

    const suffix = randomUUID().slice(0, 8);
    const orgA = await createTenantFixture(
      owner.pool,
      `web worker A ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const orgB = await createTenantFixture(
      owner.pool,
      `web worker B ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );

    /** An event the outbox holds, written as the owner (past the tenant policy); `settled` keeps the dispatcher away from it and makes it one the dispatcher sent once (the ledger of the consumer asks for that). */
    const outboxEvent = async (
      organization: TenantFixture,
      type: string,
      event: Envelope["event"],
      entity: string,
      settled: boolean
    ): Promise<Envelope> => {
      const idempotencyKey = `${type}:${entity}`;
      const correlationId = randomUUID();
      const inserted = await owner.pool.query<{ id: string }>(
        `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
         VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
        [
          organization.organizationId,
          type,
          JSON.stringify(event),
          idempotencyKey,
          correlationId,
        ]
      );
      const eventId = inserted.rows[0]?.id;
      assert.ok(eventId);
      if (settled) {
        await owner.pool.query(
          "UPDATE public.event_outbox SET status = 'dispatched', attempts = 1, locked_until = NULL, dispatched_at = now() WHERE id = $1",
          [eventId]
        );
      }
      return {
        attempt: 1,
        correlationId,
        event,
        eventId,
        idempotencyKey,
        organizationId: organization.organizationId,
        type,
        version: 1,
      };
    };
    const closureNotice = (
      organization: TenantFixture,
      noticeId: string = randomUUID()
    ) =>
      outboxEvent(
        organization,
        "organization.closure_notice",
        { noticeId },
        noticeId,
        true
      );
    const exportId = randomUUID();
    const requestedAt = Date.now();
    const events = {
      closureNoticeDone: await closureNotice(orgA),
      closureNoticePermanent: await closureNotice(orgA, "not-a-uuid"),
      closureNoticeRetry: await closureNotice(orgB),
      closureNoticeWrongQueue: await closureNotice(orgB),
      dispatchExport: await outboxEvent(
        orgA,
        "data_export.requested",
        { exportId },
        exportId,
        false
      ),
      dispatchRenewal: await outboxEvent(
        orgB,
        "billing.renewal_cancel_requested",
        { requestedAt },
        String(requestedAt),
        false
      ),
    };
    const forgedNotice = randomUUID();
    const forged: Envelope = {
      attempt: 1,
      correlationId: randomUUID(),
      event: { noticeId: forgedNotice },
      eventId: randomUUID(),
      idempotencyKey: `organization.closure_notice:${forgedNotice}`,
      organizationId: orgA.organizationId,
      type: "organization.closure_notice",
      version: 1,
    };

    // the sign-in flows of the Worker (apps/web/worker/index.workerd-db.test.ts): the users each journey makes carry this tag,
    // and the gate made one user, verified and linked to Google, for the person who signs in again
    const authTag = `wkw-${suffix}`;
    const linkedUserId = randomUUID();
    const linkedAccountId = `${authTag}-linked`;
    const linkedEmail = `${authTag}-google-linked@example.invalid`;
    await owner.pool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [linkedUserId, "Linked Google Person", linkedEmail]
    );
    await owner.pool.query(
      "INSERT INTO public.account (id, account_id, provider_id, user_id) VALUES ($1, $2, 'google', $3)",
      [randomUUID(), linkedAccountId, linkedUserId]
    );

    const incidentCount = async (cause: string, subject: string) =>
      Number(
        (
          await owner.pool.query<{ n: string }>(
            "SELECT coalesce(sum(occurrence_count), 0)::text AS n FROM public.operational_incidents WHERE kind = 'queue_dead_letter' AND cause = $1 AND subject = $2",
            [cause, subject]
          )
        ).rows[0]?.n
      );
    const invalidBefore = await incidentCount("invalid_envelope", "unknown");
    const misroutedBefore = await incidentCount(
      "wrong_queue",
      "organization.closure_notice"
    );

    // the maintenance lane writes events of its own (the notices of closures the earlier gates left): only what existed before counts
    const startedAt = (
      await owner.pool.query<{ at: Date }>("SELECT clock_timestamp() AS at")
    ).rows[0]?.at;
    assert.ok(startedAt);

    // ------------------------------------------------- the Worker, through its own handlers
    const result = await runWorkerdVitest(
      "vitest.web-worker.config.ts",
      {
        ...urls,
        POLARIS_WEB_WORKER_FIXTURE: JSON.stringify({
          auth: {
            googleLinked: {
              accountId: linkedAccountId,
              email: linkedEmail,
              userId: linkedUserId,
            },
            tag: authTag,
          },
          events,
          forged,
          logins: loginsByBinding,
          organizations: { a: orgA, b: orgB },
        }),
      },
      { tests: WEB_WORKER_TESTS }
    );
    if (result.code !== 0) {
      throw workerdSuiteFailure("Web Worker", result);
    }
    tests.push(
      "the Worker's own fetch, scheduled and queue handlers run in workerd with the seven Hyperdrive bindings of its wrangler file, each reaching PostgreSQL as its own login"
    );

    // ------------------------------------------------- what the database holds afterwards
    const outbox = await owner.pool.query<{
      dispatched: boolean;
      id: string;
      status: string;
    }>(
      "SELECT id, status, dispatched_at IS NOT NULL AS dispatched FROM public.event_outbox WHERE id = ANY($1)",
      [[events.dispatchExport.eventId, events.dispatchRenewal.eventId]]
    );
    assert.equal(outbox.rowCount, 2);
    for (const row of outbox.rows) {
      assert.equal(row.status, "dispatched", "the dispatcher marked the event");
      assert.ok(row.dispatched);
    }
    assert.equal(
      Number(
        (
          await owner.pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM public.event_outbox WHERE status = 'pending' AND created_at < $1",
            [startedAt]
          )
        ).rows[0]?.n
      ),
      0,
      "nothing that existed before the run is left pending"
    );
    tests.push(
      "the outbox lane dispatched the two pending events and left nothing pending that existed before"
    );

    const jobs = await owner.pool.query<{
      consecutive_failures: number;
      job_id: string;
      last_failure_at: string | null;
      last_success_at: string | null;
      leased: boolean;
    }>(
      "SELECT job_id, consecutive_failures, last_failure_at, last_success_at, lease_until IS NOT NULL AS leased FROM public.scheduled_job_state"
    );
    const job = (id: string) => jobs.rows.find((row) => row.job_id === id);
    for (const id of ["outbox.dispatch", ...MAINTENANCE_JOBS]) {
      const row = job(id);
      assert.ok(row, `${id} has its state`);
      assert.ok(row.last_success_at, `${id} finished`);
      assert.equal(row.leased, false, `${id} gave its lease back`);
      assert.equal(row.consecutive_failures, 0, `${id} ends clean`);
    }
    for (const id of ["outbox.dispatch", ...MAINTENANCE_JOBS]) {
      // only the job whose database was down failed, once; the others never did
      assert.equal(
        job(id)?.last_failure_at !== null,
        id === "auth.login_lock_expiry" || id === "auth.unverified_user_purge",
        `${id} failure history`
      );
    }
    tests.push(
      "every job of the two lanes finished and holds no lease; only the two jobs of authentication, whose database was down, have a failure in their history"
    );

    const processing = await owner.pool.query<{
      event_id: string;
      state: string;
    }>(
      "SELECT event_id, state FROM public.queue_processing WHERE event_id = ANY($1)",
      [
        [
          events.closureNoticeDone,
          events.closureNoticePermanent,
          events.closureNoticeRetry,
          events.closureNoticeWrongQueue,
          forged,
        ].map((event) => event.eventId),
      ]
    );
    assert.deepEqual(
      processing.rows.map((row) => [row.event_id, row.state]).sort(),
      [
        [events.closureNoticeDone.eventId, "done"],
        [events.closureNoticeRetry.eventId, "done"],
      ].sort(),
      "done for the processed and the retried; no record for a forged, a permanent failure or a refused message"
    );
    tests.push(
      "the consumer's record has the processed event and the one that finished after a retry, and none for a forged event, a failure for good or a message refused before the claim"
    );

    // `before + 1` because only one test of the suite delivers to the dead-letter queue with the database up
    assert.equal(
      await incidentCount("invalid_envelope", "unknown"),
      invalidBefore + 1,
      "one incident for the invalid envelope"
    );
    assert.equal(
      await incidentCount("wrong_queue", "organization.closure_notice"),
      misroutedBefore + 1,
      "one incident for the misrouted event"
    );
    const dead = await owner.pool.query<{ state: string }>(
      "SELECT state FROM public.queue_dead_letters WHERE event_id = $1",
      [events.closureNoticeWrongQueue.eventId]
    );
    assert.deepEqual(
      dead.rows.map((row) => row.state),
      ["dead"],
      "the misrouted event is kept as dead for the Admin to send again"
    );
    tests.push(
      "each notice of the dead-letter queue became one incident, and the misrouted event is kept dead; the notice recorded while the database was down changed nothing"
    );

    // ------------------------------------------------- what the sign-in flows left in the authentication tables
    const authUser = async (journey: string) => {
      const found = await owner.pool.query<{
        id: string;
        verified: boolean;
      }>(
        'SELECT id, email_verified AS verified FROM public."user" WHERE email = $1',
        [`${authTag}-${journey}@example.invalid`]
      );
      assert.equal(found.rowCount, 1, `one user for ${journey}`);
      const [row] = found.rows;
      assert.ok(row);
      return row;
    };
    const count = async (text: string, values: unknown[]) =>
      Number((await owner.pool.query<{ n: string }>(text, values)).rows[0]?.n);
    const sessionsOf = (userId: string) =>
      count(
        "SELECT count(*)::text AS n FROM public.session WHERE user_id = $1",
        [userId]
      );
    const auditsOf = (userId: string, eventType: string) =>
      count(
        "SELECT count(*)::text AS n FROM public.auth_security_audit_event WHERE actor_id = $1 AND event_type = $2 AND outcome = 'succeeded'",
        [userId, eventType]
      );
    /** The credential account holds a hash of the password, never the password. */
    const credentialHash = async (userId: string) => {
      const found = await owner.pool.query<{ password: string | null }>(
        "SELECT password FROM public.account WHERE user_id = $1 AND provider_id = 'credential'",
        [userId]
      );
      assert.equal(found.rowCount, 1, "one credential account");
      const hash = found.rows[0]?.password;
      assert.ok(hash && hash.length > 40, "the password is stored as a hash");
      assert.equal(hash.includes("passphrase"), false);
      return hash;
    };

    const signedUp = await authUser("signup");
    assert.equal(signedUp.verified, true, "the link verified the e-mail");
    await credentialHash(signedUp.id);
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.legal_acceptance WHERE user_id = $1 AND origin = 'signup'",
        [signedUp.id]
      ),
      2,
      "the sign-up recorded both acceptances"
    );
    assert.equal(
      await sessionsOf(signedUp.id),
      0,
      "the logout ended the session"
    );
    assert.equal(await auditsOf(signedUp.id, "logout_succeeded"), 1);

    const changed = await authUser("change");
    await credentialHash(changed.id);
    assert.equal(
      await sessionsOf(changed.id),
      2,
      "the change ended the phone and the laptop; left are the new session of the change and the sign-in with the new password"
    );
    assert.equal(await auditsOf(changed.id, "password_changed"), 1);

    const reset = await authUser("reset");
    await credentialHash(reset.id);
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.verification WHERE identifier LIKE 'reset-password:%' AND value = $1",
        [reset.id]
      ),
      0,
      "the reset token was consumed"
    );
    assert.equal(
      await sessionsOf(reset.id),
      1,
      "the reset ended the open session; only the sign-in with the new password is left"
    );
    assert.equal(await auditsOf(reset.id, "password_reset_completed"), 1);

    const googleNew = await authUser("google-new");
    assert.equal(googleNew.verified, true);
    const googleAccount = await owner.pool.query<{
      access_token: string | null;
      id_token: string | null;
      provider_id: string;
    }>(
      "SELECT access_token, id_token, provider_id FROM public.account WHERE user_id = $1 AND account_id = $2",
      [googleNew.id, `${authTag}-new`]
    );
    assert.deepEqual(
      googleAccount.rows.map((row) => row.provider_id),
      ["google"]
    );
    assert.equal(
      googleAccount.rows[0]?.id_token,
      null,
      "the id token is not kept"
    );
    assert.ok(
      googleAccount.rows[0]?.access_token &&
        googleAccount.rows[0].access_token !== "harness-access-token",
      "the access token is kept encrypted"
    );
    assert.equal(await sessionsOf(googleNew.id), 1);
    assert.equal(await auditsOf(googleNew.id, "google_callback_succeeded"), 1);

    assert.equal(
      await count(
        'SELECT count(*)::text AS n FROM public."user" WHERE email = $1',
        [linkedEmail]
      ),
      1,
      "the linked person got no second user"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.account WHERE user_id = $1",
        [linkedUserId]
      ),
      1,
      "and no second account"
    );
    assert.equal(await sessionsOf(linkedUserId), 1);
    assert.equal(await auditsOf(linkedUserId, "google_callback_succeeded"), 1);
    tests.push(
      "the e-mail and password flows (sign-up, verification by the link, sign-in, change and reset of the password, sign-out) and the Google sign-in (a new person and an already linked one) ran through the Worker's fetch with only the authentication role, and left the user, the credential hash, the sessions that remain, the consumed reset token and the audit events the journeys call for"
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
    try {
      await logins.drop();
    } finally {
      await owner.pool.end();
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Web Worker PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
