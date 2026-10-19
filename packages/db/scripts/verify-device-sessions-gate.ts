// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  DeviceRevokedError,
  DeviceSessionEndedError,
  FreshSessionRequiredError,
  recordOfflineGrant,
  registerDevice,
  revokeDevice,
  touchDevice,
} from "../src/device-repository";
import {
  issueOfflineLeaseGrant,
  OfflineLeaseRejectedError,
  validateOfflineLeaseClaims,
} from "../src/offline-lease-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
  createTenantFixture,
  type Database,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * Revoking a device ends the sessions of the browsers that used it (design t051 with the review fixes):
 *   - a session that uses a live device (register, lease, sync, `device.check`) is linked to it, and revoking the
 *     device deletes the linked sessions in the same transaction; the other sessions of the user stay;
 *   - a session that never used the device is ended by `device.check` linking it, or by the "end the other
 *     sessions" option; revoking another device (or using that option) needs a session signed in recently;
 *   - the link is written only while the device is live: a sync racing the revocation either is seen by it (and its
 *     session ends) or is refused, on two real connections;
 *   - `end_device_sessions()` is a SECURITY DEFINER of a NOLOGIN owner with the least privileges, executable only by
 *     the tenant runtime, and it refuses a live device, another user's device, a missing user and a foreign session;
 *   - the auth audit gets one `device_revoked` row whenever a revocation ends a session, repeated ones included.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const ownerRole = "polaris_device_session_owner";
const sessionIndexColumns = /\(session_id\)/;
const requestIdFormat = /^[A-Za-z0-9_-]{1,64}$/;
const authRuntimeRole = "polaris_auth_runtime";
const fresh = (id: string) => ({ fresh: true, id });
const stale = (id: string) => ({ fresh: false, id });

function withSession<T>(
  database: Database,
  fixture: TenantFixture,
  sessionId: string,
  capability: string,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability,
      requestedOrganizationId: fixture.organizationId,
      sessionId,
    },
    operation
  );
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  let loginRoleCreated = false;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
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
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "device sessions A");
    const tenantB = await createTenantFixture(admin.pool, "device sessions B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_device_sessions_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    runtime = createDatabase(runtimeUrl, { maxConnections: 8 });
    const { db } = runtime;

    /**
     * A Better Auth session row, as a login writes it (the runtime never reads this table). The database stamps
     * `created_at` on insert (trigger `session_absolute_expiration`), so an older session is backdated with that
     * trigger off for the one insert, in a transaction of its own.
     */
    const createSession = async (userId: string, minutesAgo = 0) => {
      const id = `gate-session-${randomUUID()}`;
      const insert = `INSERT INTO public.session (id, token, user_id, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, now() + interval '7 days', now() - make_interval(mins => $4), now())`;
      const values = [id, `gate-token-${randomUUID()}`, userId, minutesAgo];
      if (minutesAgo === 0) {
        await admin.pool.query(insert, values);
        return id;
      }
      const client = await admin.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE public.session DISABLE TRIGGER session_absolute_expiration"
        );
        await client.query(insert, values);
        await client.query(
          "ALTER TABLE public.session ENABLE TRIGGER session_absolute_expiration"
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return id;
    };
    const sessionExists = async (id: string) =>
      (
        await admin.pool.query<{ found: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM public.session WHERE id = $1) AS found",
          [id]
        )
      ).rows[0]?.found === true;
    const linkExists = async (deviceId: string, sessionId: string) =>
      (
        await admin.pool.query<{ found: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM public.device_sessions WHERE device_id = $1 AND session_id = $2) AS found",
          [deviceId, sessionId]
        )
      ).rows[0]?.found === true;
    const auditRows = (deviceId: string) =>
      admin.pool
        .query<{
          acting_device_id: string | null;
          acting_session_id: string | null;
          actor_id: string | null;
          ended_session_count: number | null;
          outcome: string;
          request_id: string;
        }>(
          `SELECT actor_id, outcome, request_id, ended_session_count, acting_session_id, acting_device_id::text
             FROM public.auth_security_audit_event
            WHERE event_type = 'device_revoked' AND subject_id = $1
            ORDER BY created_at, id`,
          [deviceId]
        )
        .then((result) => result.rows);
    const issueLease = (sessionId: string, deviceId: string) =>
      withSession(
        db,
        tenantA,
        sessionId,
        "offline:manage",
        (transaction, identity) =>
          issueOfflineLeaseGrant(transaction, identity, { deviceId })
      );

    // ------------------------------------------- 1. privileges and structure
    const tables = await admin.pool.query<{
      forced: boolean;
      rls: boolean;
    }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'device_sessions'`
    );
    assert.deepEqual(tables.rows, [{ forced: true, rls: true }]);
    const privileges = await admin.pool.query<{
      grantee: string;
      privileges: string[];
    }>(
      `SELECT grantee, array_agg(p ORDER BY p) AS privileges
         FROM unnest(ARRAY[$1, $2, $3, 'public']) AS grantee,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
        WHERE has_table_privilege(grantee, 'public.device_sessions', p)
        GROUP BY grantee ORDER BY grantee`,
      [runtimeRole, authRuntimeRole, ownerRole]
    );
    assert.deepEqual(privileges.rows, [
      { grantee: ownerRole, privileges: ["SELECT"] },
      { grantee: runtimeRole, privileges: ["INSERT", "SELECT"] },
    ]);
    const sessionIndex = await admin.pool.query<{ definition: string }>(
      "SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'device_sessions_session_idx'"
    );
    assert.match(sessionIndex.rows[0]?.definition ?? "", sessionIndexColumns);
    const owner = await admin.pool.query<{
      audit_insert: boolean;
      audit_select: boolean;
      bypass: boolean;
      can_login: boolean;
      devices_select: boolean;
      devices_update: boolean;
      session_delete: boolean;
      session_id_select: boolean;
      session_token_select: boolean;
      session_update: boolean;
      superuser: boolean;
    }>(
      `SELECT r.rolcanlogin AS can_login, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              has_table_privilege($1, 'public.session', 'DELETE') AS session_delete,
              has_any_column_privilege($1, 'public.session', 'UPDATE') AS session_update,
              has_column_privilege($1, 'public.session', 'id', 'SELECT') AS session_id_select,
              has_column_privilege($1, 'public.session', 'token', 'SELECT') AS session_token_select,
              has_table_privilege($1, 'public.devices', 'SELECT') AS devices_select,
              has_any_column_privilege($1, 'public.devices', 'UPDATE') AS devices_update,
              has_table_privilege($1, 'public.auth_security_audit_event', 'INSERT') AS audit_insert,
              has_table_privilege($1, 'public.auth_security_audit_event', 'SELECT') AS audit_select
         FROM pg_roles r WHERE r.rolname = $1`,
      [ownerRole]
    );
    assert.deepEqual(owner.rows, [
      {
        audit_insert: true,
        audit_select: false,
        bypass: false,
        can_login: false,
        devices_select: true,
        devices_update: false,
        session_delete: true,
        session_id_select: true,
        session_token_select: false,
        session_update: false,
        superuser: false,
      },
    ]);
    const fn = await admin.pool.query<{
      auth_runtime: boolean;
      config: string[];
      definer: boolean;
      owner: string;
      public_execute: boolean;
      runtime: boolean;
    }>(
      `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
              has_function_privilege($1, p.oid, 'EXECUTE') AS runtime,
              has_function_privilege($2, p.oid, 'EXECUTE') AS auth_runtime
         FROM pg_proc p WHERE p.oid = 'public.end_device_sessions(uuid, text, boolean, text)'::regprocedure`,
      [runtimeRole, authRuntimeRole]
    );
    assert.deepEqual(fn.rows, [
      {
        auth_runtime: false,
        config: ["search_path=pg_catalog, public, pg_temp"],
        definer: true,
        owner: ownerRole,
        public_execute: false,
        runtime: true,
      },
    ]);
    tests.push(
      "device_sessions forces row security, the tenant runtime may only read and append it and the auth runtime has nothing; end_device_sessions() is a SECURITY DEFINER pinned to pg_temp, owned by a NOLOGIN role that only reads the id and user of a session, deletes it, reads devices and links and appends the auth audit, and only the tenant runtime executes it; the cascade from session has an index"
    );

    // ------------------- 2. revoking a device ends its sessions, and only them
    const s1 = await createSession(tenantA.userId);
    const s2 = await createSession(tenantA.userId);
    const d1 = await registerDevice(db, tenantA.userId, {
      label: "Navegador 1",
      sessionId: s1,
    });
    await issueLease(s1, d1.id);
    const d2 = await registerDevice(db, tenantA.userId, {
      label: "Navegador 2",
      sessionId: s2,
    });
    const d2Lease = await issueLease(s2, d2.id);
    assert.ok(await linkExists(d1.id, s1));
    assert.ok(await linkExists(d2.id, s2));
    const origins = await admin.pool.query<{ origin: string }>(
      "SELECT origin FROM public.device_sessions WHERE device_id = $1 AND session_id = $2",
      [d1.id, s1]
    );
    assert.deepEqual(origins.rows, [{ origin: "register" }]);
    assert.ok(!(await linkExists(d1.id, s2)));

    const revocation = await revokeDevice(db, tenantA.userId, d1.id, {
      actingSession: fresh(s2),
      requestId: null,
    });
    assert.equal(revocation.endedSessionCount, 1);
    assert.equal(revocation.endedCurrentSession, false);
    assert.equal(revocation.revokedGrantIds.length, 1);
    assert.equal(await sessionExists(s1), false, "the session of D1 ended");
    assert.equal(await sessionExists(s2), true, "the other browser stays");
    assert.ok(!(await linkExists(d1.id, s1)), "the link went with its session");
    const d2Grant = await admin.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM public.offline_grants WHERE id = $1",
      [d2Lease.grant.id]
    );
    assert.equal(d2Grant.rows[0]?.revoked_at, null, "the grant of D2 stays");
    const firstAudit = await auditRows(d1.id);
    assert.equal(firstAudit.length, 1);
    assert.equal(firstAudit[0]?.actor_id, tenantA.userId);
    assert.equal(firstAudit[0]?.outcome, "succeeded");
    assert.equal(firstAudit[0]?.ended_session_count, 1);
    assert.equal(firstAudit[0]?.acting_session_id, s2);
    assert.equal(firstAudit[0]?.acting_device_id, d2.id);
    assert.match(
      firstAudit[0]?.request_id ?? "",
      requestIdFormat,
      "a missing request id becomes a fresh one, the revocation does not fail"
    );
    // the ended session can no longer use any device: a new login is needed
    await assert.rejects(
      () => registerDevice(db, tenantA.userId, { sessionId: s1 }),
      DeviceSessionEndedError
    );
    await assert.rejects(() => issueLease(s1, d2.id), DeviceSessionEndedError);
    const repeat = await revokeDevice(db, tenantA.userId, d1.id, {
      actingSession: fresh(s2),
      requestId: randomUUID(),
    });
    assert.equal(repeat.endedSessionCount, 0);
    assert.equal(repeat.revokedGrantIds.length, 0);
    assert.equal(
      (await auditRows(d1.id)).length,
      1,
      "a repetition that ends nothing is not audited"
    );
    tests.push(
      "revoking D1 from another browser ends the session linked to D1 (and its link), keeps the other session, its device and grant, audits device_revoked once with the acting session and device and a generated request id; the ended session can neither register a device nor get a lease; revoking again ends nothing and audits nothing"
    );

    // ------------------------ 3. a session linked to two devices ends with either
    const s3 = await createSession(tenantA.userId);
    const d3 = await registerDevice(db, tenantA.userId, { sessionId: s3 });
    // the browser cleared its storage and registered again with the same session
    const d3Again = await registerDevice(db, tenantA.userId, { sessionId: s3 });
    const many = await revokeDevice(db, tenantA.userId, d3Again.id, {
      actingSession: fresh(s2),
    });
    assert.equal(many.endedSessionCount, 1);
    assert.equal(await sessionExists(s3), false);
    assert.ok(!(await linkExists(d3.id, s3)));
    tests.push(
      "a session that registered two devices (storage cleared) ends when either device is revoked"
    );

    // ---- 4. a session that never used the device: device.check links it, or the option ends it
    const d4 = await registerDevice(db, tenantA.userId, { sessionId: s2 });
    const relogin = await createSession(tenantA.userId);
    // a new login on the same browser, with the lease still cached: no push, but the runtime checks the device
    const checked = await touchDevice(db, tenantA.userId, d4.id, {
      sessionId: relogin,
    });
    assert.equal(checked.id, d4.id);
    assert.ok(await linkExists(d4.id, relogin));
    const checkedOrigin = await admin.pool.query<{ origin: string }>(
      "SELECT origin FROM public.device_sessions WHERE device_id = $1 AND session_id = $2",
      [d4.id, relogin]
    );
    assert.deepEqual(
      checkedOrigin.rows,
      [{ origin: "use" }],
      "using a device never makes it the session's own"
    );
    // the thief's new login, somewhere else, never touched any device
    const thief = await createSession(tenantA.userId);
    const d4Revocation = await revokeDevice(db, tenantA.userId, d4.id, {
      actingSession: stale(s2),
    });
    assert.equal(d4Revocation.endedCurrentSession, true, "S2 used D4 as well");
    assert.equal(
      await sessionExists(relogin),
      false,
      "the checked session ended"
    );
    assert.equal(
      await sessionExists(thief),
      true,
      "without the option, a session with no link survives"
    );
    await assert.rejects(
      () => touchDevice(db, tenantA.userId, d4.id, { sessionId: thief }),
      DeviceRevokedError
    );
    assert.ok(
      !(await linkExists(d4.id, thief)),
      "a revoked device links nothing"
    );

    const owner5 = await createSession(tenantA.userId, 5);
    const d5 = await registerDevice(db, tenantA.userId, { sessionId: owner5 });
    const d6 = await registerDevice(db, tenantA.userId);
    const everything = await revokeDevice(db, tenantA.userId, d6.id, {
      actingSession: fresh(owner5),
      endOtherSessions: true,
    });
    assert.equal(await sessionExists(thief), false, "the option ends it");
    assert.equal(await sessionExists(owner5), true, "never the acting session");
    assert.equal(everything.endedCurrentSession, false);
    assert.ok(everything.endedSessionCount >= 1);
    const optionAudit = await auditRows(d6.id);
    assert.equal(optionAudit.length, 1);
    assert.equal(
      optionAudit[0]?.ended_session_count,
      everything.endedSessionCount
    );
    assert.equal(optionAudit[0]?.acting_device_id, d5.id);
    // the option on a repeated revocation ends the sessions created since, and is audited again (decision D1)
    const later = await createSession(tenantA.userId);
    const again = await revokeDevice(db, tenantA.userId, d6.id, {
      actingSession: fresh(owner5),
      endOtherSessions: true,
    });
    assert.equal(again.endedSessionCount, 1);
    assert.equal(await sessionExists(later), false);
    assert.equal((await auditRows(d6.id)).length, 2);
    tests.push(
      "a re-login that only checks the device (device.check) is linked and ends with the revocation; a session with no link survives a plain revocation and ends with the 'end the other sessions' option, which never ends the acting session and is audited again on a repetition that ends sessions"
    );

    // ---------------------------------------------------- 5. fresh session
    const old = await createSession(tenantA.userId, 16);
    const oldDevice = await registerDevice(db, tenantA.userId, {
      sessionId: old,
    });
    const otherDevice = await registerDevice(db, tenantA.userId, {
      sessionId: owner5,
    });
    await assert.rejects(
      () =>
        revokeDevice(db, tenantA.userId, otherDevice.id, {
          actingSession: stale(old),
        }),
      FreshSessionRequiredError
    );
    await assert.rejects(
      () =>
        revokeDevice(db, tenantA.userId, oldDevice.id, {
          actingSession: stale(old),
          endOtherSessions: true,
        }),
      FreshSessionRequiredError
    );
    // using the other device first (check, lease or sync) does not make it the session's own
    await touchDevice(db, tenantA.userId, otherDevice.id, { sessionId: old });
    assert.ok(await linkExists(otherDevice.id, old));
    await assert.rejects(
      () =>
        revokeDevice(db, tenantA.userId, otherDevice.id, {
          actingSession: stale(old),
        }),
      FreshSessionRequiredError
    );
    const otherState = await admin.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM public.devices WHERE id = $1",
      [otherDevice.id]
    );
    assert.equal(otherState.rows[0]?.revoked_at, null, "nothing was revoked");
    assert.equal(await sessionExists(owner5), true);
    const own = await revokeDevice(db, tenantA.userId, oldDevice.id, {
      actingSession: stale(old),
    });
    assert.equal(
      own.endedCurrentSession,
      true,
      "revoking its own device signs it out"
    );
    assert.equal(await sessionExists(old), false);
    // the acting session ended meanwhile (a logout): the revocation is undone and answered as a lost session
    const gone = await createSession(tenantA.userId);
    const goneDevice = await registerDevice(db, tenantA.userId, {
      sessionId: owner5,
    });
    await admin.pool.query("DELETE FROM public.session WHERE id = $1", [gone]);
    await assert.rejects(
      () =>
        revokeDevice(db, tenantA.userId, goneDevice.id, {
          actingSession: fresh(gone),
        }),
      DeviceSessionEndedError
    );
    const goneState = await admin.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM public.devices WHERE id = $1",
      [goneDevice.id]
    );
    assert.equal(goneState.rows[0]?.revoked_at, null, "nothing was revoked");
    tests.push(
      "a session older than the fresh window cannot revoke another device nor end the other sessions (nothing changes), not even after using that device (check), but can revoke the device it registered, which ends it and says so; an acting session that ended meanwhile undoes the revocation as a lost session"
    );

    // ------------------------------------- 6. what the function refuses
    const live = await registerDevice(db, tenantA.userId, {
      sessionId: owner5,
    });
    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();
    const asRuntime = async (
      userId: string | null,
      statement: string,
      values: unknown[]
    ) => {
      await runtimeClient.query("BEGIN");
      try {
        await runtimeClient.query(
          "SELECT set_config('app.user_id', $1, true)",
          [userId ?? ""]
        );
        return await runtimeClient.query(statement, values);
      } finally {
        await runtimeClient.query("ROLLBACK");
      }
    };
    const end =
      "SELECT * FROM public.end_device_sessions($1::uuid, $2::text, $3::boolean, NULL)";
    try {
      await expectSqlState(
        () => asRuntime(tenantA.userId, end, [live.id, owner5, false]),
        "42501",
        "a live device"
      );
      await expectSqlState(
        () => asRuntime(tenantB.userId, end, [d1.id, null, false]),
        "42501",
        "another user's device"
      );
      await expectSqlState(
        () => asRuntime(null, end, [d1.id, null, false]),
        "42501",
        "no session user"
      );
      const sessionOfB = await createSession(tenantB.userId);
      await expectSqlState(
        () => asRuntime(tenantA.userId, end, [d1.id, sessionOfB, false]),
        "PD001",
        "a session of another user"
      );
      // the option needs a fresh acting session in the database too, not only in the server
      const staleOfA = await createSession(tenantA.userId, 20);
      await expectSqlState(
        () => asRuntime(tenantA.userId, end, [d1.id, staleOfA, true]),
        "PD002",
        "the option with a stale acting session"
      );
      assert.equal(await sessionExists(owner5), true);
      await expectSqlState(
        () => asRuntime(tenantA.userId, end, [d1.id, null, true]),
        "22023",
        "the option without an acting session"
      );
      await expectSqlState(
        () => asRuntime(tenantA.userId, "SELECT id FROM public.session", []),
        "42501",
        "the tenant runtime reads no session"
      );
      await expectSqlState(
        () =>
          asRuntime(
            tenantA.userId,
            "UPDATE public.device_sessions SET linked_at = now()",
            []
          ),
        "42501",
        "no update of a link"
      );
      await expectSqlState(
        () =>
          asRuntime(tenantA.userId, "DELETE FROM public.device_sessions", []),
        "42501",
        "no delete of a link"
      );
      const foreign = await asRuntime(
        tenantB.userId,
        "SELECT count(*)::int AS count FROM public.device_sessions",
        []
      );
      assert.equal(
        foreign.rows[0]?.count,
        0,
        "no link of another user is visible"
      );
      await expectSqlState(
        () =>
          asRuntime(
            tenantB.userId,
            "INSERT INTO public.device_sessions (user_id, device_id, session_id) VALUES ($1, $2, $3)",
            [tenantA.userId, live.id, owner5]
          ),
        "42501",
        "no link forged for another user"
      );
    } finally {
      await runtimeClient.end();
    }
    tests.push(
      "end_device_sessions() refuses a live device, another user's device, an empty app.user_id, an acting session of another user, the option without an acting session and the option with an acting session older than 15 minutes; the tenant runtime reads no session, neither updates nor deletes a link, sees no link of another user and cannot forge one"
    );

    // ------------------- 7. a sync racing the revocation, on two connections
    // two concurrent checks of one device (two tabs starting) both succeed: no deadlock
    const tabs = await registerDevice(db, tenantA.userId, {
      sessionId: owner5,
    });
    const tabSessions = [
      await createSession(tenantA.userId),
      await createSession(tenantA.userId),
    ];
    for (let round = 0; round < 10; round += 1) {
      const checks = await Promise.allSettled(
        tabSessions.map((sessionId) =>
          touchDevice(db, tenantA.userId, tabs.id, { sessionId })
        )
      );
      assert.deepEqual(
        checks.map((check) => check.status),
        ["fulfilled", "fulfilled"],
        "concurrent checks of one device never deadlock"
      );
    }
    for (const sessionId of tabSessions) {
      assert.ok(await linkExists(tabs.id, sessionId));
    }

    // each raced device is set up by a session of its own (it ends with the device); `actor` revokes and is
    // linked to no device, so it outlives the whole section
    const actor = await createSession(tenantA.userId);
    const setUpDevice = async () => {
      const setup = await createSession(tenantA.userId);
      const device = await registerDevice(db, tenantA.userId, {
        sessionId: setup,
      });
      return { device, lease: await issueLease(setup, device.id) };
    };
    const syncSession = await createSession(tenantA.userId);
    const { device: raced, lease: racedLease } = await setUpDevice();
    const waitForLockWait = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await admin.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
          [loginRole]
        );
        if ((waiting.rows[0]?.count ?? 0) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("the second connection never waited for the device lock");
    };

    // (a) the sync locks the device first: the revocation waits, then sees the link and ends the session
    let releaseSync: () => void = () => undefined;
    const syncHeld = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let syncLocked: () => void = () => undefined;
    const syncHasLock = new Promise<void>((resolve) => {
      syncLocked = resolve;
    });
    const sync = withSession(
      db,
      tenantA,
      syncSession,
      "sync:push",
      async (transaction, identity) => {
        await validateOfflineLeaseClaims(
          transaction,
          identity,
          racedLease.claims
        );
        syncLocked();
        await syncHeld;
      }
    );
    await syncHasLock;
    const racingRevocation = revokeDevice(db, tenantA.userId, raced.id, {
      actingSession: fresh(actor),
    });
    try {
      await waitForLockWait();
    } finally {
      // a failed wait still ends the held sync, so the gate reports it instead of timing out
      releaseSync();
      await sync;
    }
    const racedResult = await racingRevocation;
    assert.equal(
      await sessionExists(syncSession),
      false,
      "the sync's session ended"
    );
    assert.equal(
      racedResult.endedSessionCount,
      2,
      "the sync's and the setup's"
    );
    assert.equal(racedResult.endedCurrentSession, false);

    // (b) the revocation updates the device first: the sync waits, then finds no live device and links nothing
    const lateSession = await createSession(tenantA.userId);
    const { device: second, lease: secondLease } = await setUpDevice();
    const revoker = new Client({ connectionString: runtimeUrl });
    await revoker.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query("SELECT set_config('app.user_id', $1, true)", [
        tenantA.userId,
      ]);
      await revoker.query(
        "UPDATE public.devices SET revoked_at = now() WHERE id = $1",
        [second.id]
      );
      const lateSync = withSession(
        db,
        tenantA,
        lateSession,
        "sync:push",
        (transaction, identity) =>
          validateOfflineLeaseClaims(transaction, identity, secondLease.claims)
      );
      const lateOutcome = lateSync.then(
        () => "accepted",
        (error: unknown) =>
          error instanceof OfflineLeaseRejectedError ? error.reason : "error"
      );
      await waitForLockWait();
      await revoker.query(
        "SELECT * FROM public.end_device_sessions($1::uuid, $2::text, false, NULL)",
        [second.id, actor]
      );
      await revoker.query("COMMIT");
      assert.equal(await lateOutcome, "device_revoked");
    } finally {
      await revoker.end();
    }
    assert.ok(!(await linkExists(second.id, lateSession)));
    assert.equal(
      await sessionExists(lateSession),
      true,
      "the refused sync never linked its session"
    );

    // (c) many racing pairs: no session is ever left linked to a revoked device
    for (let round = 0; round < 12; round += 1) {
      const { device: racer, lease: racerLease } = await setUpDevice();
      const racerSession = await createSession(tenantA.userId);
      const [pushed, revokedRacer] = await Promise.allSettled([
        withSession(
          db,
          tenantA,
          racerSession,
          "sync:push",
          (transaction, identity) =>
            validateOfflineLeaseClaims(transaction, identity, racerLease.claims)
        ),
        revokeDevice(db, tenantA.userId, racer.id, {
          actingSession: fresh(actor),
        }),
      ]);
      // the revocation always succeeds; the sync either went first or is refused as revoked, linking nothing (never a
      // deadlock, a lock timeout or any other error)
      assert.equal(revokedRacer.status, "fulfilled", "the revocation succeeds");
      if (pushed.status === "rejected") {
        // device_revoked when it waited for the revocation; grant_revoked when the revocation committed before it began
        assert.ok(
          pushed.reason instanceof OfflineLeaseRejectedError &&
            (pushed.reason.reason === "device_revoked" ||
              pushed.reason.reason === "grant_revoked"),
          `the racing sync is refused as revoked (${redactedFailure(pushed.reason)})`
        );
        assert.ok(!(await linkExists(racer.id, racerSession)));
      } else {
        assert.equal(
          await sessionExists(racerSession),
          false,
          "a sync that went first is ended by the revocation"
        );
      }
    }
    const leftovers = await admin.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM public.device_sessions AS link
         JOIN public.devices AS device ON device.id = link.device_id
        WHERE device.revoked_at IS NOT NULL AND link.user_id = $1`,
      [tenantA.userId]
    );
    assert.equal(
      leftovers.rows[0]?.count,
      0,
      "no session stays linked to a revoked device"
    );
    assert.equal(await sessionExists(actor), true);
    tests.push(
      "concurrent checks of one device never deadlock; a sync that locks the device first makes the revocation wait and then end its session; a revocation that updates the device first makes the sync wait and then refuse it as device_revoked without linking its session; racing pairs never leave a session linked to a revoked device"
    );

    // the grant path also refuses a revoked device without linking
    await assert.rejects(
      () =>
        withSession(
          db,
          tenantA,
          lateSession,
          "offline:manage",
          (tx, identity) =>
            recordOfflineGrant(tx, identity, {
              authorizationEpoch: 0,
              deviceId: second.id,
              expiresAt: new Date(Date.now() + 3_600_000),
              issuedAt: new Date(),
            })
        ),
      DeviceRevokedError
    );
    assert.ok(!(await linkExists(second.id, lateSession)));
    tests.push("a lease on a revoked device is refused and links nothing");

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
    if (runtime) {
      await runtime.pool.end();
    }
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(`Device sessions gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
