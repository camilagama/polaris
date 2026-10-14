import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CAPABILITIES } from "@polaris/domain/authorization/capabilities";
import { OfflineLeaseNotAvailableError } from "@polaris/domain/offline/offline-lease";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import { registerDevice, revokeDevice } from "../src/device-repository";
import {
  issueOfflineLeaseGrant,
  OfflineLeaseRejectedError,
  validateOfflineLeaseClaims,
} from "../src/offline-lease-repository";
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
  withTenantAs,
} from "./sales-gate-support";

/**
 * Offline authorization leases (plan PR49): the server records a grant whose
 * epoch and capabilities come from the membership, caps it at 72 hours (or the
 * end of the entitlement), revalidates a lease against the live state, and a
 * password reset (the auth runtime's narrow SECURITY DEFINER function)
 * invalidates every lease of the user without touching anyone else.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR = 3_600_000;
const authRole = "polaris_auth_runtime";
const invalidUserIdPattern = /invalid user id/;

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof OfflineLeaseRejectedError,
      `expected a lease rejection, got ${String(error)}`
    );
    return error.reason;
  }
  throw new Error("expected the lease to be rejected");
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
  const loginRoles: string[] = [];
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

    const tenantA = await createTenantFixture(admin.pool, "lease A");
    const tenantB = await createTenantFixture(admin.pool, "lease B");
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

    const createLogin = async (membership: string) => {
      const name = `polaris_lease_gate_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await admin.pool.query(
        `CREATE ROLE "${name}" WITH LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
      );
      loginRoles.push(name);
      await admin.pool.query(`GRANT "${membership}" TO "${name}"`);
      return temporaryRuntimeUrl(adminUrl, name, password);
    };
    const tenantUrl = await createLogin(runtimeRole);
    const authUrl = await createLogin(authRole);
    const runtimeDatabase = createDatabase(tenantUrl, { maxConnections: 8 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const bump = async (userId: string): Promise<number> => {
      const client = new Client({ connectionString: authUrl });
      await client.connect();
      try {
        const result = await client.query<{ revoked: number }>(
          "SELECT public.bump_user_authorization_epoch($1) AS revoked",
          [userId]
        );
        return Number(result.rows[0]?.revoked);
      } finally {
        await client.end();
      }
    };
    const epochOf = async (tenant: typeof tenantA) =>
      Number(
        (
          await admin.pool.query<{ authorization_epoch: number }>(
            "SELECT authorization_epoch FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
            [tenant.organizationId, tenant.userId]
          )
        ).rows[0]?.authorization_epoch
      );

    // ------------------------------------------ 1. privileges and the function
    assert.equal(await epochOf(tenantA), 0, "epochs start at zero");
    const privileges = await admin.pool.query<{
      runtime_update: boolean;
      runtime_select: boolean;
      auth_exec: boolean;
      runtime_exec: boolean;
      public_exec: boolean;
      definer: boolean;
      pinned: boolean;
    }>(
      `SELECT has_any_column_privilege($1, 'public.memberships', 'UPDATE') AS runtime_update,
              has_column_privilege($1, 'public.memberships', 'authorization_epoch', 'SELECT') AS runtime_select,
              has_function_privilege($2, 'public.bump_user_authorization_epoch(text)', 'EXECUTE') AS auth_exec,
              has_function_privilege($1, 'public.bump_user_authorization_epoch(text)', 'EXECUTE') AS runtime_exec,
              has_function_privilege('public', 'public.bump_user_authorization_epoch(text)', 'EXECUTE') AS public_exec,
              p.prosecdef AS definer,
              coalesce(p.proconfig::text LIKE '%search_path=pg_catalog, public%', false) AS pinned
         FROM pg_proc p WHERE p.oid = 'public.bump_user_authorization_epoch(text)'::regprocedure`,
      [runtimeRole, authRole]
    );
    assert.deepEqual(privileges.rows, [
      {
        auth_exec: true,
        definer: true,
        pinned: true,
        public_exec: false,
        runtime_exec: false,
        runtime_select: true,
        runtime_update: false,
      },
    ]);
    await expectSqlState(
      async () => {
        const client = new Client({ connectionString: tenantUrl });
        await client.connect();
        try {
          await client.query(
            "SELECT public.bump_user_authorization_epoch($1)",
            [tenantA.userId]
          );
        } finally {
          await client.end();
        }
      },
      "42501",
      "the tenant runtime cannot bump an epoch"
    );
    await expectSqlState(
      async () => {
        const client = new Client({ connectionString: tenantUrl });
        await client.connect();
        try {
          await client.query(
            "UPDATE public.memberships SET authorization_epoch = 9 WHERE user_id = $1",
            [tenantA.userId]
          );
        } finally {
          await client.end();
        }
      },
      "42501",
      "the tenant runtime cannot write an epoch directly"
    );
    tests.push(
      "the tenant runtime can read but never write the authorization epoch; only the auth runtime can run the pinned SECURITY DEFINER bump function"
    );

    // ------------------------------------------------------ 2. issuing a lease
    const device = await registerDevice(db, tenantA.userId, {
      label: "Tablet",
    });
    const now = new Date();
    const issued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: device.id,
          now,
        })
    );
    assert.equal(issued.claims.epoch, 0);
    assert.equal(issued.claims.sub, tenantA.userId);
    assert.equal(issued.claims.org, tenantA.organizationId);
    assert.equal(issued.claims.dev, device.id);
    assert.equal(issued.claims.jti, issued.grant.id);
    assert.deepEqual(issued.claims.caps, [...CAPABILITIES].sort());
    assert.equal(
      (issued.claims.exp - issued.claims.iat) * 1000,
      72 * HOUR,
      "a lease lasts 72 hours"
    );
    assert.equal(issued.grant.authorizationEpoch, 0);
    assert.equal(issued.grant.expiresAt.getTime(), issued.claims.exp * 1000);
    tests.push(
      "issuing a lease records a grant whose claims carry the membership's epoch, the role's capability snapshot and exactly 72 hours"
    );

    // trial cap and ended entitlement
    const trialEnd = new Date(now.getTime() + 5 * HOUR);
    const capped = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: device.id,
          entitlementEndsAt: trialEnd,
          now,
        })
    );
    assert.equal(
      capped.claims.exp,
      Math.floor(trialEnd.getTime() / 1000),
      "the lease ends with the trial"
    );
    const before = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.offline_grants WHERE device_id = $1",
      [device.id]
    );
    await assert.rejects(
      () =>
        withTenantAs(db, tenantA, "offline:manage", (transaction, identity) =>
          issueOfflineLeaseGrant(transaction, identity, {
            deviceId: device.id,
            entitlementEndsAt: now,
            now,
          })
        ),
      OfflineLeaseNotAvailableError
    );
    const after = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.offline_grants WHERE device_id = $1",
      [device.id]
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    tests.push(
      "the lease window is min(now + 72h, end of the entitlement); an ended entitlement issues nothing"
    );

    // --------------------------------------------- 3. validating a lease
    const validate = (
      tenant: typeof tenantA,
      claims: typeof issued.claims,
      at: Date = now
    ) =>
      withTenantAs(db, tenant, "sale:create", (transaction, identity) =>
        validateOfflineLeaseClaims(transaction, identity, claims, at)
      );
    const live = await validate(tenantA, issued.claims);
    assert.equal(live.id, issued.grant.id);

    assert.equal(
      await reason(
        validate(tenantA, { ...issued.claims, sub: "someone-else" })
      ),
      "wrong_principal"
    );
    assert.equal(
      await reason(
        validate(tenantA, { ...issued.claims, org: tenantB.organizationId })
      ),
      "wrong_principal"
    );
    assert.equal(
      await reason(validate(tenantA, { ...issued.claims, jti: randomUUID() })),
      "grant_not_found"
    );
    assert.equal(
      await reason(validate(tenantA, { ...issued.claims, dev: randomUUID() })),
      "grant_not_found"
    );
    assert.equal(
      await reason(
        validate(tenantA, {
          ...issued.claims,
          caps: [...issued.claims.caps, "admin:everything"],
        })
      ),
      "capability_revoked"
    );
    assert.equal(
      await reason(
        validate(
          tenantA,
          issued.claims,
          new Date(issued.grant.expiresAt.getTime() + 1000)
        )
      ),
      "grant_expired"
    );
    // Another organization of the same user does not honor this lease.
    assert.equal(
      await reason(validate(tenantA2, issued.claims)),
      "wrong_principal"
    );

    // device revoked behind the cascade's back (an organization that was not scoped)
    const orphan = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: device.id,
          now,
        })
    );
    await admin.pool.query(
      "UPDATE public.devices SET revoked_at = now() WHERE id = $1",
      [device.id]
    );
    assert.equal(
      await reason(validate(tenantA, orphan.claims)),
      "device_revoked"
    );

    // epoch changed without revoking grants
    const device2 = await registerDevice(db, tenantA.userId, {
      label: "Caixa",
    });
    const epochLease = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: device2.id,
          now,
        })
    );
    await validate(tenantA, epochLease.claims);
    await admin.pool.query(
      "UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1 WHERE organization_id = $1 AND user_id = $2",
      [tenantA.organizationId, tenantA.userId]
    );
    assert.equal(
      await reason(validate(tenantA, epochLease.claims)),
      "epoch_mismatch"
    );
    await admin.pool.query(
      "UPDATE public.memberships SET authorization_epoch = authorization_epoch - 1 WHERE organization_id = $1 AND user_id = $2",
      [tenantA.organizationId, tenantA.userId]
    );

    // revoked grant
    const revoked = await revokeDevice(db, tenantA.userId, device2.id);
    assert.ok(revoked.revokedGrantIds.includes(epochLease.grant.id));
    assert.equal(
      await reason(validate(tenantA, epochLease.claims)),
      "grant_revoked"
    );
    tests.push(
      "the server revalidates a lease against live state: principal, organization, grant, expiry, capability snapshot, device and epoch, each with its own rejection; a revoked grant is refused"
    );

    // ----------------------------------------- 4. a password reset invalidates
    const resetDevice = await registerDevice(db, tenantA.userId, {
      label: "Reset",
    });
    const strangerDevice = await registerDevice(db, tenantB.userId, {
      label: "Outro",
    });
    const grantIn = (tenant: typeof tenantA, deviceId: string) =>
      withTenantAs(db, tenant, "offline:manage", (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, { deviceId, now })
      );
    const mineOne = await grantIn(tenantA, resetDevice.id);
    const mineTwo = await grantIn(tenantA2, resetDevice.id);
    const stranger = await grantIn(tenantB, strangerDevice.id);

    const epochsBefore: [number, number] = [
      await epochOf(tenantA),
      await epochOf(tenantA2),
    ];
    const liveBefore = Number(
      (
        await admin.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.offline_grants WHERE user_id = $1 AND revoked_at IS NULL",
          [tenantA.userId]
        )
      ).rows[0]?.count
    );
    assert.ok(liveBefore >= 2);
    const revokedCount = await bump(tenantA.userId);
    assert.equal(
      revokedCount,
      liveBefore,
      "every live grant of the user is revoked, in every organization"
    );
    assert.deepEqual(
      [await epochOf(tenantA), await epochOf(tenantA2)],
      [epochsBefore[0] + 1, epochsBefore[1] + 1],
      "every membership of the user moves to a new epoch"
    );
    assert.equal(await epochOf(tenantB), 0, "other users are untouched");
    const reasons = await admin.pool.query<{
      id: string;
      revoked_reason: string;
    }>(
      "SELECT id, revoked_reason FROM public.offline_grants WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[mineOne.grant.id, mineTwo.grant.id]]
    );
    assert.ok(
      reasons.rows.every((row) => row.revoked_reason === "security_event")
    );
    const audit = await admin.pool.query<{
      organization_id: string;
      actor_user_id: string;
    }>(
      "SELECT organization_id, actor_user_id FROM public.tenant_audit_event WHERE event_type = 'offline_grant.revoked' AND entity_id = ANY($1::text[]) ORDER BY organization_id",
      [[mineOne.grant.id, mineTwo.grant.id]]
    );
    assert.deepEqual(
      audit.rows.map((row) => row.organization_id).sort(),
      [tenantA.organizationId, tenantA2.organizationId].sort(),
      "one audit event per revoked grant, in its own organization"
    );
    assert.ok(audit.rows.every((row) => row.actor_user_id === tenantA.userId));
    assert.equal(
      await reason(validate(tenantA, mineOne.claims)),
      "grant_revoked"
    );
    const strangerStill = await withTenantAs(
      db,
      tenantB,
      "sale:create",
      (transaction, identity) =>
        validateOfflineLeaseClaims(transaction, identity, stranger.claims, now)
    );
    assert.equal(strangerStill.id, stranger.grant.id);
    assert.equal(
      await bump(tenantA.userId),
      0,
      "a second reset revokes nothing more"
    );
    assert.equal(await epochOf(tenantA), epochsBefore[0] + 2);

    // a lease issued after the reset carries the new epoch and is valid
    const fresh = await grantIn(tenantA, resetDevice.id);
    assert.equal(fresh.claims.epoch, await epochOf(tenantA));
    await validate(tenantA, fresh.claims);
    await assert.rejects(() => bump("  padded"), invalidUserIdPattern);
    await assert.rejects(() => bump(""), invalidUserIdPattern);
    tests.push(
      "a password reset bumps the epoch of every membership of the user, revokes every live grant with reason security_event and one audit event per grant, leaves other users alone, is repeatable, and the next lease carries the new epoch"
    );

    // --------------------------- 5. a lease never survives a concurrent reset
    let stale = 0;
    for (let round = 0; round < 8; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round needs the previous one to finish
      const racer = await registerDevice(db, tenantA.userId, {
        label: `corrida ${round}`,
      });
      await Promise.allSettled([
        grantIn(tenantA, racer.id),
        bump(tenantA.userId),
      ]);
      const result = await admin.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public.offline_grants g
           JOIN public.memberships m
             ON m.organization_id = g.organization_id AND m.user_id = g.user_id
          WHERE g.device_id = $1 AND g.revoked_at IS NULL
            AND g.authorization_epoch <> m.authorization_epoch`,
        [racer.id]
      );
      stale += Number(result.rows[0]?.count);
    }
    assert.equal(
      stale,
      0,
      "no live grant carries an epoch older than its membership's"
    );
    tests.push(
      "issuing a lease racing a password reset never leaves a live grant with a stale epoch"
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
    for (const role of loginRoles) {
      // biome-ignore lint/performance/noAwaitInLoops: two temporary roles
      await admin.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Offline lease PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
