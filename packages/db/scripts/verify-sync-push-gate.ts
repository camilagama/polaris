import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createCategory } from "../src/category-repository";
import { createDatabase } from "../src/client";
import { registerDevice } from "../src/device-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import {
  runSyncCommand,
  type SyncCommandOutcome,
  type SyncJson,
} from "../src/sync-command-repository";
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
 * The `sync.push` frame around a domain command (plan PR53): idempotency by
 * command ID, lease revalidation against live state, savepoint isolation of the
 * domain work and a recorded outcome that replays unchanged.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR = 3_600_000;
const crashPattern = /infrastructure failure/;
const hash = (n: number) => n.toString(16).padStart(64, "0");

class SyntheticRefusal extends Error {
  constructor() {
    super("synthetic_refusal");
    this.name = "SyntheticRefusal";
  }
}

const classify = (error: unknown): string | null =>
  error instanceof SyntheticRefusal ? "synthetic_refusal" : null;

type Tenant = Awaited<ReturnType<typeof createTenantFixture>>;

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

    const tenantA = await createTenantFixture(admin.pool, "push A");
    const tenantB = await createTenantFixture(admin.pool, "push B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_push_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;

    const device = await registerDevice(db, tenantA.userId, { label: "Caixa" });
    const issued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: device.id,
        })
    );
    const { claims } = issued;
    const createdNow = () => new Date(Date.now() - 60_000);

    let executions = 0;
    const categoryCount = async (tenant: Tenant) =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.categories WHERE organization_id = $1",
            [tenant.organizationId]
          )
        ).rows[0]?.count
      );
    const makeCategory =
      (outcome: "ok" | "refuse" | "crash") =>
      async (
        transaction: Parameters<Parameters<typeof withTenantAs>[3]>[0]
      ): Promise<SyncJson> => {
        executions += 1;
        const created = await createCategory(
          transaction,
          {
            capability: "category:create",
            organizationId: tenantA.organizationId,
            role: "owner",
            userId: tenantA.userId,
          },
          { name: `Cat ${randomUUID()}` }
        );
        if (outcome === "refuse") {
          throw new SyntheticRefusal();
        }
        if (outcome === "crash") {
          throw new Error("infrastructure failure");
        }
        return { categoryId: created.id };
      };

    const push = (
      overrides: Partial<Parameters<typeof runSyncCommand>[2]> & {
        commandId: string;
      },
      execute = makeCategory("ok"),
      tenant: Tenant = tenantA
    ): Promise<SyncCommandOutcome> =>
      withTenantAs(db, tenant, "category:create", (transaction, identity) =>
        runSyncCommand(
          transaction,
          identity,
          {
            commandType: "category.create",
            createdAt: createdNow(),
            deviceId: device.id,
            leaseClaims: claims,
            payloadHash: hash(1),
            ...overrides,
          },
          execute,
          classify
        )
      );

    // ---------------------------------------------- 1. the table and its guards
    const privileges = await admin.pool.query<{
      forced: boolean;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT c.relforcerowsecurity AS forced,
              has_table_privilege($1, c.oid, 'SELECT') AS can_select,
              has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
              has_any_column_privilege($1, c.oid, 'UPDATE') AS can_update,
              has_table_privilege($1, c.oid, 'DELETE') AS can_delete
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'sync_commands'`,
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows, [
      {
        can_delete: false,
        can_insert: true,
        can_select: true,
        can_update: false,
        forced: true,
      },
    ]);
    tests.push(
      "sync_commands has forced row security and the runtime can only read and insert"
    );

    // ----------------------------------------- 2. accepted once, replayed after
    const firstId = randomUUID();
    const before = await categoryCount(tenantA);
    const first = await push({ commandId: firstId });
    assert.equal(first.status, "accepted");
    assert.equal(first.replayed, false);
    assert.equal(first.code, null);
    const { categoryId } = first.result as { categoryId: string };
    assert.ok(categoryId);
    assert.equal(await categoryCount(tenantA), before + 1);

    const replay = await push({ commandId: firstId });
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(await categoryCount(tenantA), before + 1, "no second effect");
    assert.equal(executions, 1);
    tests.push(
      "an accepted command runs once and its stored outcome replays unchanged, without a second effect"
    );

    // ------------------------------------ 3. the same ID with different content
    const reused = await push({ commandId: firstId, payloadHash: hash(2) });
    assert.equal(reused.code, "command_id_reused");
    assert.equal(reused.status, "rejected");
    const reusedType = await push({
      commandId: firstId,
      commandType: "category.rename",
    });
    assert.equal(reusedType.code, "command_id_reused");
    assert.deepEqual(await push({ commandId: firstId }), {
      ...first,
      replayed: true,
    });
    const rows = await admin.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.sync_commands WHERE organization_id = $1 AND command_id = $2",
      [tenantA.organizationId, firstId]
    );
    assert.equal(
      rows.rows[0]?.n,
      "1",
      "the first outcome stands, nothing was added"
    );
    tests.push(
      "the same command ID with another payload or type is refused with command_id_reused, stores nothing and leaves the first outcome standing"
    );

    // ------------------------------------------ 4. refusals leave no trace
    const refusedId = randomUUID();
    const beforeRefusal = await categoryCount(tenantA);
    const refused = await push(
      { commandId: refusedId },
      makeCategory("refuse")
    );
    assert.deepEqual(refused, {
      code: "synthetic_refusal",
      replayed: false,
      result: null,
      status: "rejected",
    });
    assert.equal(
      await categoryCount(tenantA),
      beforeRefusal,
      "the refused command's writes vanished with its savepoint"
    );
    const refusedAgain = await push({ commandId: refusedId });
    assert.deepEqual(refusedAgain, { ...refused, replayed: true });
    tests.push(
      "a domain refusal rolls back the command's own writes, stores the rejection and replays it unchanged"
    );

    // --------------------------- 5. an unexpected failure is retried, not stored
    const crashId = randomUUID();
    await assert.rejects(
      () => push({ commandId: crashId }, makeCategory("crash")),
      crashPattern
    );
    const stored = await admin.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.sync_commands WHERE command_id = $1",
      [crashId]
    );
    assert.equal(stored.rows[0]?.n, "0", "nothing was recorded for a crash");
    const retried = await push({ commandId: crashId });
    assert.equal(
      retried.status,
      "accepted",
      "the device can retry the same command"
    );
    tests.push(
      "an unexpected failure rolls everything back, records nothing and lets the device retry the same command ID"
    );

    // ------------------------------------------------- 6. lease revalidation
    const beforeLease = executions;
    const wrongDevice = await push({
      commandId: randomUUID(),
      deviceId: randomUUID(),
    });
    assert.equal(wrongDevice.code, "wrong_device");
    const otherPrincipal = await push({
      commandId: randomUUID(),
      leaseClaims: { ...claims, sub: "someone-else" },
    });
    assert.equal(otherPrincipal.code, "authorization_revoked");
    const noCapability = await push({
      commandId: randomUUID(),
      leaseClaims: { ...claims, caps: [...claims.caps, "admin:everything"] },
    });
    assert.equal(noCapability.code, "authorization_revoked");
    assert.equal(executions, beforeLease, "none of them executed");
    const unknownGrant = await push({
      commandId: randomUUID(),
      leaseClaims: { ...claims, jti: randomUUID() },
    });
    assert.equal(unknownGrant.code, "authorization_revoked");
    tests.push(
      "a command from another device, another principal, an unknown grant or with capabilities the role no longer has is refused with a stored authorization code and never runs"
    );

    // creation time against the lease window
    for (const [label, createdAt] of [
      ["before the lease was issued", new Date(claims.iat * 1000 - HOUR)],
      ["after the lease expired", new Date(claims.exp * 1000 + HOUR)],
      ["in the future of the server clock", new Date(Date.now() + HOUR)],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      const outcome = await push({ commandId: randomUUID(), createdAt });
      assert.equal(outcome.code, "invalid_creation_time", label);
    }
    tests.push(
      "the command's creation time must sit inside the lease window and not in the future"
    );

    // an expired lease still covers a command made while it was valid
    const expiredIssuedAt = new Date(Date.now() - 80 * HOUR);
    const expiredAt = new Date(Date.now() - 10 * HOUR);
    const expiredGrant = await admin.pool.query<{ id: string }>(
      "INSERT INTO public.offline_grants (organization_id, user_id, device_id, authorization_epoch, issued_at, expires_at) VALUES ($1, $2, $3, 0, $4, $5) RETURNING id",
      [
        tenantA.organizationId,
        tenantA.userId,
        device.id,
        expiredIssuedAt,
        expiredAt,
      ]
    );
    const expiredClaims = {
      ...claims,
      exp: Math.floor(expiredAt.getTime() / 1000),
      iat: Math.floor(expiredIssuedAt.getTime() / 1000),
      jti: expiredGrant.rows[0]?.id ?? "",
    };
    const lateSync = await push({
      commandId: randomUUID(),
      createdAt: new Date(Date.now() - 20 * HOUR),
      leaseClaims: expiredClaims,
    });
    assert.equal(
      lateSync.status,
      "accepted",
      "made while valid, synced after expiry"
    );
    const tooLate = await push({
      commandId: randomUUID(),
      createdAt: new Date(Date.now() - 5 * HOUR),
      leaseClaims: expiredClaims,
    });
    assert.equal(
      tooLate.code,
      "invalid_creation_time",
      "made after the lease ended"
    );
    tests.push(
      "a lease that expired still covers a command created while it was valid, but not one created after it ended"
    );

    // revocation
    const revokeDevice = await registerDevice(db, tenantA.userId, {
      label: "Perdido",
    });
    const revokeIssued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: revokeDevice.id,
        })
    );
    const revokedPush = (commandId: string) =>
      push({
        commandId,
        deviceId: revokeDevice.id,
        leaseClaims: revokeIssued.claims,
      });
    assert.equal((await revokedPush(randomUUID())).status, "accepted");
    await admin.pool.query(
      "UPDATE public.offline_grants SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1",
      [revokeIssued.grant.id]
    );
    assert.equal(
      (await revokedPush(randomUUID())).code,
      "authorization_revoked"
    );
    const epochDevice = await registerDevice(db, tenantA.userId, {
      label: "Epoca",
    });
    const epochIssued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, {
          deviceId: epochDevice.id,
        })
    );
    await admin.pool.query(
      "UPDATE public.memberships SET authorization_epoch = authorization_epoch + 1 WHERE organization_id = $1 AND user_id = $2",
      [tenantA.organizationId, tenantA.userId]
    );
    const staleEpoch = await push({
      commandId: randomUUID(),
      deviceId: epochDevice.id,
      leaseClaims: epochIssued.claims,
    });
    assert.equal(staleEpoch.code, "authorization_revoked");
    await admin.pool.query(
      "UPDATE public.memberships SET authorization_epoch = authorization_epoch - 1 WHERE organization_id = $1 AND user_id = $2",
      [tenantA.organizationId, tenantA.userId]
    );
    tests.push(
      "a revoked grant or a changed authorization epoch refuses the command with a stored authorization code"
    );

    // --------------------------------------- 7. prechecks and entitlement
    let ran = false;
    const prechecked = await push(
      {
        commandId: randomUUID(),
        leaseClaims: null,
        precheckFailure: "lease_invalid",
      },
      (_transaction) => {
        ran = true;
        return Promise.resolve(null);
      }
    );
    assert.equal(prechecked.code, "lease_invalid");
    assert.equal(ran, false);
    const unentitled = await push({
      commandId: randomUUID(),
      isEntitled: () => Promise.resolve(false),
    });
    assert.equal(unentitled.code, "entitlement_changed");
    const entitled = await push({
      commandId: randomUUID(),
      isEntitled: () => Promise.resolve(true),
    });
    assert.equal(entitled.status, "accepted");
    tests.push(
      "a precheck failure (bad lease, bad payload) and a lost entitlement are refused with stored codes before the domain command runs"
    );

    // ------------------------------------------------------- 8. concurrency
    const racingId = randomUUID();
    const executionsBefore = executions;
    const racers = await Promise.all(
      Array.from({ length: 8 }, () => push({ commandId: racingId }))
    );
    assert.equal(
      executions - executionsBefore,
      1,
      "eight concurrent pushes of one command execute it once"
    );
    assert.equal(racers.filter((outcome) => outcome.replayed).length, 7);
    assert.equal(
      new Set(racers.map((outcome) => JSON.stringify(outcome.result))).size,
      1
    );
    tests.push(
      "eight concurrent pushes of the same command execute it exactly once and all return the same result"
    );

    // ------------------------------------------------------- 9. isolation
    const seenByB = await withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM public.sync_commands WHERE command_id = $1",
        [firstId]
      )
    );
    assert.equal(
      seenByB.rows[0]?.n,
      0,
      "another organization cannot read the outcomes"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantB, (client) =>
          client.query(
            "INSERT INTO public.sync_commands (command_id, command_type, organization_id, user_id, outcome_status, payload_hash) VALUES (gen_random_uuid(), 'a.b', $1, $2, 'accepted', $3)",
            [tenantA.organizationId, tenantB.userId, hash(3)]
          )
        ),
      "42501",
      "a user cannot record an outcome in another organization"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.sync_commands SET outcome_status = 'rejected' WHERE command_id = $1",
            [firstId]
          )
        ),
      "42501",
      "the runtime cannot edit an outcome"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.sync_commands SET payload_hash = $2 WHERE command_id = $1",
          [firstId, hash(9)]
        ),
      "23514",
      "not even the owner can edit an outcome",
      "sync_commands_immutable"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.sync_commands (command_id, command_type, organization_id, user_id, outcome_status, outcome_code, payload_hash) VALUES (gen_random_uuid(), 'a.b', $1, $2, 'accepted', 'oops', $3)",
          [tenantA.organizationId, tenantA.userId, hash(4)]
        ),
      "23514",
      "an accepted outcome carries no rejection code",
      "sync_commands_outcome_coherent"
    );
    const foreignLease = await push(
      { commandId: firstId },
      makeCategory("ok"),
      tenantB
    );
    assert.equal(foreignLease.status, "rejected");
    assert.equal(
      foreignLease.code,
      "authorization_revoked",
      "another organization's lease claims authorize nothing here"
    );
    tests.push(
      "outcomes are invisible and unforgeable across organizations, immutable even for the owner, and an accepted outcome never carries a rejection code"
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
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(`Sync push PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
