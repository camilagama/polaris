import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InvalidDeviceLabelError,
  InvalidOfflineGrantRevokeReasonError,
  InvalidOfflineGrantWindowError,
  MAX_ACTIVE_DEVICES_PER_USER,
  OFFLINE_GRANT_MAX_LIFETIME_MS,
} from "@polaris/domain/offline/offline-grant";
import { createDatabase } from "../src/client";
import {
  DeviceLimitError,
  DeviceNotFoundError,
  DeviceRevokedError,
  listDevices,
  listOfflineGrants,
  OfflineGrantNotFoundError,
  recordOfflineGrant,
  registerDevice,
  revokeDevice,
  revokeOfflineGrant,
  touchDevice,
} from "../src/device-repository";
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
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Devices and offline grants (plan PR48): the tables are scoped by row-level
 * security, a revoked device or grant stays revoked, grants live at most 72
 * hours and only on live devices, and revoking a device revokes its grants in
 * every organization of the user.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR = 3_600_000;
const tenantDeniedPattern = /tenant_access_denied/;

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
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "device A");
    const tenantB = await createTenantFixture(admin.pool, "device B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_devices_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 8 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;

    // The same user also belongs to a second organization.
    const secondOrganizationId = randomUUID();
    await admin.pool.query(
      "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, 'Segunda loja', 'America/Sao_Paulo')",
      [secondOrganizationId]
    );
    await admin.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [secondOrganizationId, tenantA.userId]
    );
    const tenantA2 = {
      organizationId: secondOrganizationId,
      userId: tenantA.userId,
    };

    // ------------------------------ 1. privileges, row security, constraints
    const privileges = await admin.pool.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      table_update: boolean;
      table_delete: boolean;
      table_truncate: boolean;
      any_update: boolean;
      public_select: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              has_table_privilege($1, c.oid, 'UPDATE') AS table_update,
              has_table_privilege($1, c.oid, 'DELETE') AS table_delete,
              has_table_privilege($1, c.oid, 'TRUNCATE') AS table_truncate,
              has_any_column_privilege($1, c.oid, 'UPDATE') AS any_update,
              has_table_privilege('public', c.oid, 'SELECT') AS public_select
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('devices', 'offline_grants')
        ORDER BY c.relname`,
      [runtimeRole]
    );
    assert.deepEqual(
      privileges.rows.map((row) => row.table_name),
      ["devices", "offline_grants"]
    );
    for (const row of privileges.rows) {
      assert.equal(row.rls, true, `${row.table_name} has RLS`);
      assert.equal(row.forced, true, `${row.table_name} forces RLS`);
      assert.equal(row.table_update, false, "no table-wide UPDATE");
      assert.equal(row.any_update, true, "column UPDATE only");
      assert.equal(row.table_delete, false, "no DELETE");
      assert.equal(row.table_truncate, false, "no TRUNCATE");
      assert.equal(row.public_select, false, "PUBLIC has no access");
    }
    const updatable = await admin.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = $1 AND table_schema = 'public'
          AND table_name IN ('devices', 'offline_grants') AND privilege_type = 'UPDATE'
        ORDER BY table_name, column_name`,
      [runtimeRole]
    );
    assert.deepEqual(
      updatable.rows.map((row) => `${row.table_name}.${row.column_name}`),
      [
        "devices.label",
        "devices.last_seen_at",
        "devices.revoked_at",
        "offline_grants.revoked_at",
        "offline_grants.revoked_reason",
      ]
    );
    tests.push(
      "devices and offline_grants have forced row-level security, no DELETE or TRUNCATE, no access for PUBLIC and UPDATE only on the label, last-seen and revocation columns"
    );

    // ---------------------------------------------------- 2. device register
    const first = await registerDevice(db, tenantA.userId, {
      label: "  Balcão  ",
    });
    assert.equal(first.label, "Balcão");
    assert.equal(first.revokedAt, null);
    assert.equal(first.userId, tenantA.userId);
    assert.ok(first.createdAt instanceof Date);
    assert.ok(Math.abs(first.createdAt.getTime() - Date.now()) < 5 * 60_000);
    const unlabeled = await registerDevice(db, tenantA.userId);
    assert.equal(unlabeled.label, null);
    await assert.rejects(
      () => registerDevice(db, tenantA.userId, { label: "a\nb" }),
      InvalidDeviceLabelError
    );
    await assert.rejects(
      () => registerDevice(db, "  padded"),
      tenantDeniedPattern
    );
    tests.push(
      "registerDevice stores a server-generated id with a trimmed optional label, rejects control characters and never accepts a padded user id"
    );

    // ----------------------------------------- 3. the per-user device limit
    const limitUser = await createTenantFixture(admin.pool, "device limit");
    for (let index = 0; index < MAX_ACTIVE_DEVICES_PER_USER - 3; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: registrations are created one after another
      await registerDevice(db, limitUser.userId);
    }
    const racing = await Promise.allSettled(
      Array.from({ length: 8 }, () => registerDevice(db, limitUser.userId))
    );
    assert.equal(
      racing.filter((result) => result.status === "fulfilled").length,
      3,
      "concurrent registrations never exceed the cap"
    );
    assert.ok(
      racing
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason instanceof DeviceLimitError)
    );
    const limitDevices = await listDevices(db, limitUser.userId);
    assert.equal(limitDevices.length, MAX_ACTIVE_DEVICES_PER_USER);
    await assert.rejects(
      () => registerDevice(db, limitUser.userId),
      DeviceLimitError
    );
    const [oneToFree] = limitDevices;
    assert.ok(oneToFree);
    await revokeDevice(db, limitUser.userId, oneToFree.id);
    await registerDevice(db, limitUser.userId);
    tests.push(
      "a user keeps at most 20 live devices even under concurrent registrations; revoking one frees a slot"
    );

    // ------------------------------------------------------ 4. isolation
    assert.deepEqual(await listDevices(db, tenantB.userId), []);
    await assert.rejects(
      () => touchDevice(db, tenantB.userId, first.id),
      DeviceNotFoundError
    );
    await assert.rejects(
      () => revokeDevice(db, tenantB.userId, first.id),
      DeviceNotFoundError
    );
    assert.equal((await listDevices(db, tenantA.userId)).length, 2);
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.devices (user_id, label) VALUES ($1, 'forged')",
            [tenantA.userId]
          )
        ),
      "42501",
      "a user cannot insert a device for another user"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("UPDATE public.devices SET user_id = $1 WHERE id = $2", [
            tenantB.userId,
            first.id,
          ])
        ),
      "42501",
      "the owner of a device cannot be changed (no column privilege)"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("DELETE FROM public.devices WHERE id = $1", [first.id])
        ),
      "42501",
      "a device cannot be deleted by the runtime"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("UPDATE public.devices SET label = $1 WHERE id = $2", [
            "line\nbreak",
            first.id,
          ])
        ),
      "23514",
      "a label with a line break is refused by the database",
      "devices_label_format"
    );
    tests.push(
      "devices are invisible and immutable to other users (list, touch, revoke, forged insert), their owner never changes and they cannot be deleted; the label format is also a CHECK constraint"
    );

    // --------------------------------------------- 5. touching and revoking
    const seenAt = new Date(Date.now() + 1000);
    const touched = await touchDevice(db, tenantA.userId, first.id, seenAt);
    assert.equal(touched.lastSeenAt.getTime(), seenAt.getTime());
    const standalone = await registerDevice(db, tenantA.userId, {
      label: "Caixa 2",
    });
    const revokedAt = new Date();
    const revocation = await revokeDevice(db, tenantA.userId, standalone.id, {
      now: revokedAt,
    });
    assert.equal(revocation.device.revokedAt?.getTime(), revokedAt.getTime());
    assert.deepEqual(revocation.revokedGrantIds, []);
    const again = await revokeDevice(db, tenantA.userId, standalone.id, {
      now: new Date(revokedAt.getTime() + 60_000),
    });
    assert.equal(
      again.device.revokedAt?.getTime(),
      revokedAt.getTime(),
      "revoking twice keeps the first revocation instant"
    );
    await assert.rejects(
      () => touchDevice(db, tenantA.userId, standalone.id),
      DeviceRevokedError
    );
    assert.ok(
      !(await listDevices(db, tenantA.userId)).some(
        (device) => device.id === standalone.id
      ),
      "revoked devices are hidden by default"
    );
    assert.ok(
      (await listDevices(db, tenantA.userId, { includeRevoked: true })).some(
        (device) => device.id === standalone.id
      )
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.devices SET revoked_at = NULL WHERE id = $1",
            [standalone.id]
          )
        ),
      "23514",
      "a revoked device cannot be revived",
      "devices_revocation_terminal"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.devices SET last_seen_at = now() WHERE id = $1",
            [standalone.id]
          )
        ),
      "23514",
      "a revoked device cannot be touched even with raw SQL",
      "devices_revocation_terminal"
    );
    tests.push(
      "touch records the instant, revoke is idempotent and terminal (no revive, no touch, hidden from the default list) and is enforced by a trigger, not only by the repository"
    );

    // ---------------------------------------------------- 6. offline grants
    const grantDevice = await registerDevice(db, tenantA.userId, {
      label: "Tablet",
    });
    const issuedAt = new Date();
    const lease = new Date(issuedAt.getTime() + 72 * HOUR);
    const grant = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        recordOfflineGrant(transaction, identity, {
          authorizationEpoch: 3,
          deviceId: grantDevice.id,
          expiresAt: lease,
          issuedAt,
        })
    );
    assert.equal(grant.organizationId, tenantA.organizationId);
    assert.equal(grant.userId, tenantA.userId);
    assert.equal(grant.authorizationEpoch, 3);
    assert.equal(grant.expiresAt.getTime(), lease.getTime());
    assert.equal(grant.revokedAt, null);
    const listed = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        listOfflineGrants(transaction, identity, { onlyActive: true })
    );
    assert.deepEqual(
      listed.map((row) => row.id),
      [grant.id]
    );
    const issuedAudit = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND entity_id = $2 AND event_type = 'offline_grant.issued'",
      [tenantA.organizationId, grant.id]
    );
    assert.equal(Number(issuedAudit.rows[0]?.count), 1);
    tests.push(
      "a grant is issued for a live device of the session user in the current organization with its epoch and exact 72-hour expiry, is listed as active and is audited"
    );

    // window rules (domain and database)
    for (const lifetime of [OFFLINE_GRANT_MAX_LIFETIME_MS + 1, 0, -HOUR]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await assert.rejects(
        () =>
          withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
            recordOfflineGrant(transaction, identity, {
              authorizationEpoch: 0,
              deviceId: grantDevice.id,
              expiresAt: new Date(issuedAt.getTime() + lifetime),
              issuedAt,
            })
          ),
        InvalidOfflineGrantWindowError
      );
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, issued_at, expires_at) VALUES ($1, $2, $3, 0, now(), now() + interval '73 hours')",
            [tenantA.organizationId, tenantA.userId, grantDevice.id]
          )
        ),
      "23514",
      "the database refuses a grant longer than 72 hours",
      "offline_grants_window"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, issued_at, expires_at, revoked_at) VALUES ($1, $2, $3, 0, now(), now() + interval '1 hour', now())",
            [tenantA.organizationId, tenantA.userId, grantDevice.id]
          )
        ),
      "23514",
      "a revoked grant needs a reason",
      "offline_grants_revocation_consistent"
    );
    tests.push(
      "a grant lives more than zero and at most 72 hours, in the domain and in a CHECK constraint, and a revocation always carries its reason"
    );

    // devices of other users and revoked devices cannot receive grants
    await assert.rejects(
      () =>
        withTenantAs(db, tenantB, "offline:manage", (transaction, identity) =>
          recordOfflineGrant(transaction, identity, {
            authorizationEpoch: 0,
            deviceId: grantDevice.id,
            expiresAt: lease,
            issuedAt,
          })
        ),
      DeviceNotFoundError
    );
    await assert.rejects(
      () =>
        withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
          recordOfflineGrant(transaction, identity, {
            authorizationEpoch: 0,
            deviceId: standalone.id,
            expiresAt: lease,
            issuedAt,
          })
        ),
      DeviceRevokedError
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, issued_at, expires_at) VALUES ($1, $2, $3, 0, now(), now() + interval '1 hour')",
            [tenantA.organizationId, tenantA.userId, standalone.id]
          )
        ),
      "23514",
      "raw SQL cannot grant a revoked device either",
      "offline_grants_live_device_required"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, issued_at, expires_at) VALUES ($1, $2, $3, 0, now(), now() + interval '1 hour')",
            [tenantB.organizationId, tenantA.userId, grantDevice.id]
          )
        ),
      "42501",
      "a grant for an organization other than the current one is refused"
    );
    tests.push(
      "grants only go to the session user's own live devices: another user's device, a revoked device (also through raw SQL) and a foreign organization are refused"
    );

    // tenant isolation of grants
    const otherOrgView = await withTenantAs(
      db,
      tenantA2,
      "offline:manage",
      (transaction, identity) => listOfflineGrants(transaction, identity)
    );
    assert.deepEqual(otherOrgView, [], "grants belong to one organization");
    const strangerView = await withTenantAs(
      db,
      tenantB,
      "offline:manage",
      (transaction, identity) => listOfflineGrants(transaction, identity)
    );
    assert.deepEqual(strangerView, []);
    tests.push(
      "a grant is invisible in another organization of the same user and to other users"
    );

    // ----------------------------------------------- 7. revoking one grant
    await assert.rejects(
      () =>
        withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
          revokeOfflineGrant(transaction, identity, {
            grantId: grant.id,
            // @ts-expect-error probing an invalid reason on purpose
            reason: "because",
          })
        ),
      InvalidOfflineGrantRevokeReasonError
    );
    const revokedGrant = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        revokeOfflineGrant(transaction, identity, {
          grantId: grant.id,
          reason: "user_revoked",
        })
    );
    assert.equal(revokedGrant.revokedReason, "user_revoked");
    assert.ok(revokedGrant.revokedAt instanceof Date);
    const secondRevoke = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        revokeOfflineGrant(transaction, identity, {
          grantId: grant.id,
          reason: "security_event",
        })
    );
    assert.equal(
      secondRevoke.revokedReason,
      "user_revoked",
      "the first reason is kept"
    );
    await assert.rejects(
      () =>
        withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
          revokeOfflineGrant(transaction, identity, {
            grantId: randomUUID(),
            reason: "user_revoked",
          })
        ),
      OfflineGrantNotFoundError
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.offline_grants SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1",
            [grant.id]
          )
        ),
      "23514",
      "a revoked grant cannot be revived",
      "offline_grants_revocation_terminal"
    );
    const activeAfterRevoke = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        listOfflineGrants(transaction, identity, { onlyActive: true })
    );
    assert.deepEqual(activeAfterRevoke, []);
    const revokedAudit = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE entity_id = $1 AND event_type = 'offline_grant.revoked'",
      [grant.id]
    );
    assert.equal(
      Number(revokedAudit.rows[0]?.count),
      1,
      "only the effective revocation is audited"
    );
    tests.push(
      "revoking a grant is terminal and idempotent (the first reason is kept), audited once, enforced by a trigger and refuses unknown ids and invalid reasons"
    );

    // ------------------------ 8. revoking a device revokes its grants everywhere
    const wideDevice = await registerDevice(db, tenantA.userId, {
      label: "Loja inteira",
    });
    const soon = new Date(issuedAt.getTime() + 24 * HOUR);
    const grantIn = async (tenant: typeof tenantA) =>
      await withTenantAs(
        db,
        tenant,
        "offline:manage",
        (transaction, identity) =>
          recordOfflineGrant(transaction, identity, {
            authorizationEpoch: 1,
            deviceId: wideDevice.id,
            expiresAt: soon,
            issuedAt,
          })
      );
    const grantOne = await grantIn(tenantA);
    const grantTwo = await grantIn(tenantA2);
    const wide = await revokeDevice(db, tenantA.userId, wideDevice.id);
    assert.deepEqual(
      wide.revokedGrantIds.sort(),
      [grantOne.id, grantTwo.id].sort()
    );
    for (const tenant of [tenantA, tenantA2]) {
      // biome-ignore lint/performance/noAwaitInLoops: each organization is read in turn
      const rows = await withTenantAs(
        db,
        tenant,
        "offline:manage",
        (transaction, identity) =>
          listOfflineGrants(transaction, identity, {
            deviceId: wideDevice.id,
          })
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.revokedReason, "device_revoked");
      assert.ok(rows[0]?.revokedAt instanceof Date);
    }
    const wideAudit = await admin.pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM public.tenant_audit_event WHERE event_type = 'offline_grant.revoked' AND entity_id = ANY($1::text[]) ORDER BY organization_id",
      [[grantOne.id, grantTwo.id]]
    );
    assert.deepEqual(
      wideAudit.rows.map((row) => row.organization_id).sort(),
      [tenantA.organizationId, tenantA2.organizationId].sort(),
      "each organization gets its own audit event"
    );
    const repeat = await revokeDevice(db, tenantA.userId, wideDevice.id);
    assert.deepEqual(repeat.revokedGrantIds, []);
    tests.push(
      "revoking a device revokes its live grants in every organization of the user with reason device_revoked, one audit event per grant in its own organization, and is idempotent"
    );

    // ------------------------- 9. a grant never outlives a concurrent revocation
    let violations = 0;
    for (let round = 0; round < 8; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round needs the previous one to finish
      const racer = await registerDevice(db, tenantA.userId, {
        label: `corrida ${round}`,
      });
      await Promise.allSettled([
        withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
          recordOfflineGrant(transaction, identity, {
            authorizationEpoch: 1,
            deviceId: racer.id,
            expiresAt: soon,
            issuedAt,
          })
        ),
        revokeDevice(db, tenantA.userId, racer.id),
      ]);
      const live = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.offline_grants WHERE device_id = $1 AND revoked_at IS NULL",
        [racer.id]
      );
      violations += Number(live.rows[0]?.count);
    }
    assert.equal(
      violations,
      0,
      "no live grant is left on a revoked device after racing writers"
    );
    tests.push(
      "racing a grant against the revocation of its device never leaves a live grant on a revoked device"
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
  console.error(
    `Offline devices PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
