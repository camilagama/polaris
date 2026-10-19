import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CustomerNotFoundError,
  CustomerVersionConflictError,
  InvalidCustomerProfileError,
} from "@polaris/domain/customers/customer";
import { createDatabase } from "../src/client";
import { createCustomer, updateCustomer } from "../src/customer-repository";
import { registerDevice } from "../src/device-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import {
  runSyncCommand,
  type SyncCommandOutcome,
} from "../src/sync-command-repository";
import {
  createTenantFixture,
  disposableHostPattern,
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
 * `customer.update` offline: a customer edited without a connection, through the
 * real `sync.push` frame (`runSyncCommand`) and the real `updateCustomer` the
 * online screen uses. The command carries the version the person edited; the
 * server refuses an edit made against an older version (nothing is overwritten)
 * and replays a repeated command ID with the stored outcome.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const hash = (n: number) => n.toString(16).padStart(64, "0");

const classify = (error: unknown): string | null => {
  if (error instanceof CustomerVersionConflictError) {
    return "customer_version_conflict";
  }
  if (error instanceof CustomerNotFoundError) {
    return "customer_not_found";
  }
  if (error instanceof InvalidCustomerProfileError) {
    return "invalid_payload";
  }
  return null;
};

type Tenant = Awaited<ReturnType<typeof createTenantFixture>>;

interface EditPayload {
  customerId: string;
  email?: string | null;
  name: string;
  notes?: string | null;
  phone?: string | null;
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

    const tenantA = await createTenantFixture(admin.pool, "customer A");
    const tenantB = await createTenantFixture(admin.pool, "customer B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_customer_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;

    /** A tenant with its own device and lease, like a person on their own phone. */
    const actorFor = async (tenant: Tenant) => {
      const device = await registerDevice(db, tenant.userId, {
        label: "Caixa",
      });
      const { claims } = await withTenantAs(
        db,
        tenant,
        "offline:manage",
        (transaction, identity) =>
          issueOfflineLeaseGrant(transaction, identity, {
            deviceId: device.id,
          })
      );
      assert.ok(claims.caps.includes("customer:update"));
      return { claims, device, tenant };
    };
    const actorA = await actorFor(tenantA);
    const actorB = await actorFor(tenantB);
    const createdNow = () => new Date(Date.now() - 60_000);

    /** What the web handler does, in the sync frame. */
    const pushEdit = (
      id: string,
      payload: EditPayload,
      baseVersion: number | null,
      actor: {
        claims: typeof actorA.claims;
        device: typeof actorA.device;
        tenant: Tenant;
      } = actorA,
      leaseOf: { claims: typeof actorA.claims } = actor
    ): Promise<SyncCommandOutcome> =>
      withTenantAs(db, actor.tenant, "sync:push", (transaction, identity) =>
        runSyncCommand(
          transaction,
          identity,
          {
            commandId: id,
            commandType: "customer.update",
            createdAt: createdNow(),
            deviceId: actor.device.id,
            leaseClaims: leaseOf.claims,
            payloadHash: hash(1),
          },
          async (savepoint) => {
            if (baseVersion === null) {
              throw new InvalidCustomerProfileError();
            }
            const result = await updateCustomer(savepoint, identity, {
              email: payload.email ?? null,
              expectedVersion: baseVersion,
              id: payload.customerId,
              name: payload.name,
              notes: payload.notes ?? null,
              phone: payload.phone ?? null,
              requestId: id,
            });
            return {
              changed: result.changed,
              customerId: result.customer.id,
              version: result.customer.version,
            };
          },
          classify
        )
      );

    const customerOf = async (id: string) =>
      (
        await admin.pool.query<{
          name: string;
          phone: string | null;
          version: number;
        }>("SELECT name, phone, version FROM public.customers WHERE id = $1", [
          id,
        ])
      ).rows[0];
    const auditCount = async (id: string) =>
      Number(
        (
          await admin.pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM public.tenant_audit_event WHERE entity_id = $1 AND event_type = 'customer.updated'",
            [id]
          )
        ).rows[0]?.n ?? "-1"
      );

    const customerId = randomUUID();
    await withTenantAs(
      db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          id: customerId,
          name: "Ana Souza",
          phone: "11900000001",
        })
    );
    assert.deepEqual(await customerOf(customerId), {
      name: "Ana Souza",
      phone: "11900000001",
      version: 1,
    });

    // ------------------------------- 1. an edit against the current version
    const firstId = randomUUID();
    const first = await pushEdit(
      firstId,
      { customerId, name: "Ana Souza Lima", phone: "11900000001" },
      1
    );
    assert.equal(first.status, "accepted");
    assert.equal(first.replayed, false);
    assert.deepEqual(await customerOf(customerId), {
      name: "Ana Souza Lima",
      phone: "11900000001",
      version: 2,
    });
    assert.equal(await auditCount(customerId), 1);
    const replay = await pushEdit(
      firstId,
      { customerId, name: "Ana Souza Lima", phone: "11900000001" },
      1
    );
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal((await customerOf(customerId))?.version, 2);
    assert.equal(await auditCount(customerId), 1);
    tests.push(
      "an offline edit made against the current version is applied (version +1, one audit event) and sending it again replays the stored outcome without applying it twice"
    );

    // ------------- 2. an edit made against an older version overwrites nothing
    const staleId = randomUUID();
    const stale = await pushEdit(
      staleId,
      { customerId, name: "Nome do aparelho antigo", phone: "11900000001" },
      1
    );
    assert.equal(stale.status, "rejected");
    assert.equal(stale.code, "customer_version_conflict");
    assert.deepEqual(await customerOf(customerId), {
      name: "Ana Souza Lima",
      phone: "11900000001",
      version: 2,
    });
    assert.equal(await auditCount(customerId), 1);
    const staleReplay = await pushEdit(
      staleId,
      { customerId, name: "Nome do aparelho antigo", phone: "11900000001" },
      1
    );
    assert.deepEqual(staleReplay, { ...stale, replayed: true });
    tests.push(
      "an edit made against an older version is refused with its own code and changes nothing (no overwrite, no audit event), and the refusal is stored and replayed"
    );

    // ------------------------- 3. the same edit redone from the current version
    const redone = await pushEdit(
      randomUUID(),
      { customerId, name: "Nome refeito", phone: "11900000001" },
      2
    );
    assert.equal(redone.status, "accepted");
    assert.equal((await customerOf(customerId))?.version, 3);
    tests.push(
      "the refused edit redone as a NEW command from the version the device now has is applied"
    );

    // ---------------------------- 4. unchanged data is accepted, version stays
    const unchanged = await pushEdit(
      randomUUID(),
      { customerId, name: "Nome refeito", phone: "11900000001" },
      3
    );
    assert.equal(unchanged.status, "accepted");
    assert.equal((unchanged.result as { changed?: boolean }).changed, false);
    assert.equal((await customerOf(customerId))?.version, 3);
    tests.push(
      "an edit that changes nothing is accepted and leaves the version and the audit trail alone"
    );

    // ----------------------------------- 5. an unknown customer, and the tenant
    const missing = await pushEdit(
      randomUUID(),
      { customerId: randomUUID(), name: "Ninguém", phone: "1" },
      1
    );
    assert.equal(missing.code, "customer_not_found");
    const foreign = await pushEdit(
      randomUUID(),
      { customerId, name: "Invasor", phone: "1" },
      3,
      actorB
    );
    assert.equal(foreign.code, "customer_not_found");
    // another organization cannot borrow this one lease either
    const borrowed = await pushEdit(
      randomUUID(),
      { customerId, name: "Invasor", phone: "1" },
      3,
      actorB,
      actorA
    );
    assert.equal(borrowed.status, "rejected");
    assert.equal(borrowed.code, "session_changed");
    assert.equal((await customerOf(customerId))?.name, "Nome refeito");
    tests.push(
      "an unknown customer, or another organization's customer, is customer_not_found; another organization's lease is refused; nothing is changed"
    );

    // ------------------------------------- 6. an invalid profile is a refusal
    const invalid = await pushEdit(
      randomUUID(),
      { customerId, name: "   ", phone: "1" },
      3
    );
    assert.equal(invalid.code, "invalid_payload");
    assert.equal((await customerOf(customerId))?.version, 3);
    tests.push(
      "an edit that would leave the customer without a name or contact is refused as an invalid payload"
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
  console.error(
    `Offline customer PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
