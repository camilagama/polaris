import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  EntitlementDeniedError,
  EntitlementLimitReachedError,
} from "@polaris/domain/billing/entitlements";
import { GoalLimitReachedError } from "@polaris/domain/goals/goal";
import { createDatabase } from "../src/client";
import { registerDevice } from "../src/device-repository";
import { cancelGoal, createGoal } from "../src/goal-repository";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
} from "../src/media-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { runSyncCommand } from "../src/sync-command-repository";
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
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Plan limits applied where the data is written (plan PR74 and PR75) on a real
 * PostgreSQL 18: variants and images per organization and per product, active
 * goals, and offline writes, for Free and Pro, with grants that raise a limit,
 * deletion that frees it, concurrent additions that cannot overshoot it, and a
 * downgrade that restricts new work without touching what exists.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

type ErrorClass = abstract new (...args: never[]) => Error;

async function expectLimit(
  operation: () => Promise<unknown>,
  key: string,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(
        error instanceof EntitlementLimitReachedError,
        `${label}: got ${String(error)}`
      );
      assert.equal(error.key, key, `${label}: the limit that was reached`);
      return true;
    },
    label
  );
}

async function expectRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof expected, `${label}: got ${String(error)}`);
      return true;
    },
    label
  );
}

/** Runs the steps one after the other (a transaction cannot interleave them). */
function inSequence(count: number, step: (index: number) => Promise<unknown>) {
  return Array.from({ length: count }).reduce<Promise<unknown>>(
    (previous, _, index) => previous.then(() => step(index)),
    Promise.resolve()
  );
}

function dateFrom(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function mediaInput(
  organizationId: string,
  productId: string
): CreateProductMediaAssetInput {
  const uploadCommandId = randomUUID();
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  return {
    byteSize: 2048,
    height: 480,
    inputFingerprint: fingerprint,
    productId,
    requestId: randomUUID(),
    // The v2 key the database requires: the asset's own organization, command and fingerprint.
    storageKey: `media/v2/${organizationId}/${productId}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
    uploadCommandId,
    variantIds: [],
    width: 640,
  };
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

    loginRole = `polaris_entitlements_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeDatabase = createDatabase(
      temporaryRuntimeUrl(adminUrl, loginRole, loginPassword),
      { maxConnections: 10 }
    );
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const grant = (
      tenant: TenantFixture,
      key: string,
      value: number | boolean
    ) =>
      admin.pool.query(
        `INSERT INTO public.entitlement_grants (organization_id, key, ${typeof value === "number" ? "limit_value" : "flag_value"}, reason, expires_at)
         VALUES ($1, $2, $3, 'gate', now() + interval '1 day')`,
        [tenant.organizationId, key, value]
      );
    const newProduct = (tenant: TenantFixture) =>
      as(tenant, "product:create", (tx, identity) =>
        createProduct(tx, identity, { name: `P ${randomUUID()}` })
      );

    // ------------------------------------------- 1. variants, Free (50)
    const free = await createTenantFixture(
      admin.pool,
      "entitlements free",
      "America/Sao_Paulo",
      "free"
    );
    const created: { id: string; version: number }[] = [];
    await as(free, "product:create", (tx, identity) =>
      inSequence(50, async () => {
        created.push(
          await createProduct(tx, identity, { name: `P ${randomUUID()}` })
        );
      })
    );
    assert.equal(created.length, 50);
    await expectLimit(
      () => newProduct(free),
      "variants.active.max",
      "the 51st variant of a Free organization"
    );
    const variantCount = async (tenant: TenantFixture) =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.product_variants WHERE organization_id = $1",
            [tenant.organizationId]
          )
        ).rows[0]?.count
      );
    assert.equal(await variantCount(free), 50, "the refused one left nothing");
    tests.push(
      "a Free organization can hold 50 variants and the 51st product (its default variant) is refused with the limit that was reached"
    );

    // ------------------------------------------------ 2. images, Free (1 and 50)
    const [first] = created;
    assert.ok(first);
    await as(free, "product:update", (tx, identity) =>
      inSequence(50, (index) =>
        createProductMediaAsset(
          tx,
          identity,
          mediaInput(free.organizationId, created[index]?.id as string)
        )
      )
    );
    await expectLimit(
      () =>
        as(free, "product:update", (tx, identity) =>
          createProductMediaAsset(
            tx,
            identity,
            mediaInput(free.organizationId, first.id)
          )
        ),
      "images.per_product.max",
      "a second image on a Free product"
    );
    await grant(free, "images.per_product.max", 3);
    await expectLimit(
      () =>
        as(free, "product:update", (tx, identity) =>
          createProductMediaAsset(
            tx,
            identity,
            mediaInput(free.organizationId, first.id)
          )
        ),
      "images.active.max",
      "the 51st image of a Free organization, per-product limit raised"
    );
    await grant(free, "images.active.max", 51);
    const extra = await as(free, "product:update", (tx, identity) =>
      createProductMediaAsset(
        tx,
        identity,
        mediaInput(free.organizationId, first.id)
      )
    );
    assert.equal(extra.replayed, false);
    await expectLimit(
      () =>
        as(free, "product:update", (tx, identity) =>
          createProductMediaAsset(
            tx,
            identity,
            mediaInput(free.organizationId, first.id)
          )
        ),
      "images.active.max",
      "the image past the raised total"
    );
    tests.push(
      "a Free organization gets 1 image per product and 50 in all, each refused with its own limit; temporary grants raise them and nothing else"
    );

    // ---------------------- 3. a grant raises variants; deleting a product frees them
    await grant(free, "variants.active.max", 51);
    const withGrant = await newProduct(free);
    await expectLimit(
      () => newProduct(free),
      "variants.active.max",
      "past the raised variant limit"
    );
    await as(free, "product:update", (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: withGrant.version,
        id: withGrant.id,
        requestId: randomUUID(),
      })
    );
    const afterDelete = await newProduct(free);
    assert.ok(afterDelete.id);
    tests.push(
      "a grant raises the variant limit, a deleted product stops counting against it, and a refused addition changes nothing"
    );

    // ---------------------- 4. configuring variants counts the net addition
    const configuring = await createTenantFixture(
      admin.pool,
      "entitlements configure",
      "America/Sao_Paulo",
      "free"
    );
    const configurable: { id: string; version: number }[] = [];
    await as(configuring, "product:create", (tx, identity) =>
      inSequence(48, async () => {
        configurable.push(
          await createProduct(tx, identity, { name: `C ${randomUUID()}` })
        );
      })
    );
    const target = await newProduct(configuring);
    const colors = (names: string[]) => ({
      options: [{ name: "color" as const, values: names }],
      variants: names.map((name) => ({ values: { color: name } })),
    });
    await expectLimit(
      () =>
        as(configuring, "product:update", (tx, identity) =>
          configureProductVariants(tx, identity, {
            ...colors(["Azul", "Preto", "Verde", "Rosa"]),
            expectedVersion: target.version,
            id: target.id,
            requestId: randomUUID(),
          })
        ),
      "variants.active.max",
      "49 variants plus 3 net additions"
    );
    const configured = await as(configuring, "product:update", (tx, identity) =>
      configureProductVariants(tx, identity, {
        ...colors(["Azul", "Preto"]),
        expectedVersion: target.version,
        id: target.id,
        requestId: randomUUID(),
      })
    );
    assert.equal(configured.configuration.configured, true);
    assert.equal(await variantCount(configuring), 50);
    tests.push(
      "configuring variants counts the net addition (the default variant is replaced), refusing 49 + 3 and accepting 49 + 1"
    );

    // ------------------------------------------- 5. Pro raises them, concurrently safe
    const pro = await createTenantFixture(admin.pool, "entitlements pro");
    const proProducts: { id: string; version: number }[] = [];
    await as(pro, "product:create", (tx, identity) =>
      inSequence(51, async () => {
        proProducts.push(
          await createProduct(tx, identity, { name: `P ${randomUUID()}` })
        );
      })
    );
    assert.equal(await variantCount(pro), 51, "Pro holds more than Free");
    // a downgrade keeps everything and refuses only what would add to it
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL WHERE organization_id = $1",
      [pro.organizationId]
    );
    await expectLimit(
      () => newProduct(pro),
      "variants.active.max",
      "an organization above the Free limit after a downgrade"
    );
    assert.equal(await variantCount(pro), 51, "nothing was removed");
    // archiving does not free a place (deleting does)
    const [archivable] = proProducts;
    assert.ok(archivable);
    await as(pro, "product:update", (tx, identity) =>
      archiveProduct(tx, identity, {
        expectedVersion: archivable.version,
        id: archivable.id,
        requestId: randomUUID(),
      })
    );
    await expectLimit(
      () => newProduct(pro),
      "variants.active.max",
      "archiving a product does not free its place"
    );
    const racing = await createTenantFixture(
      admin.pool,
      "entitlements race",
      "America/Sao_Paulo",
      "free"
    );
    await as(racing, "product:create", (tx, identity) =>
      inSequence(46, () =>
        createProduct(tx, identity, { name: `R ${randomUUID()}` })
      )
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => newProduct(racing))
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      4,
      "exactly the room that was left"
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof EntitlementLimitReachedError);
      }
    }
    assert.equal(await variantCount(racing), 50, "never past the limit");
    tests.push(
      "Pro holds more variants than Free, a downgrade keeps all of them and refuses only the next one (archiving frees nothing), and eight concurrent additions into the last four places of a Free organization commit exactly four"
    );

    // ------------------------------------------------------------- 6. goals
    const goalsFree = await createTenantFixture(
      admin.pool,
      "entitlements goals free",
      "America/Sao_Paulo",
      "free"
    );
    const today = (
      await admin.pool.query<{ today: string }>(
        "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS today"
      )
    ).rows[0]?.today as string;
    const newGoal = (tenant: TenantFixture) =>
      as(tenant, "goal:manage", (tx, identity) =>
        createGoal(tx, identity, {
          endsOn: dateFrom(today, 6),
          kind: "sale_count",
          name: null,
          requestId: randomUUID(),
          startsOn: today,
          target: "10",
        })
      );
    const onlyGoal = await newGoal(goalsFree);
    await expectLimit(
      () => newGoal(goalsFree),
      "goals.active.max",
      "a second active goal on Free"
    );
    await as(goalsFree, "goal:manage", (tx, identity) =>
      cancelGoal(tx, identity, {
        expectedVersion: onlyGoal.version,
        id: onlyGoal.id,
        requestId: randomUUID(),
      })
    );
    await newGoal(goalsFree);
    const goalsPro = await createTenantFixture(
      admin.pool,
      "entitlements goals pro"
    );
    await inSequence(3, () => newGoal(goalsPro));
    await expectLimit(
      () => newGoal(goalsPro),
      "goals.active.max",
      "a fourth active goal on Pro"
    );
    await grant(goalsPro, "goals.active.max", 25);
    await inSequence(17, () => newGoal(goalsPro));
    await expectRejects(
      () => newGoal(goalsPro),
      GoalLimitReachedError,
      "the technical ceiling of 20 still holds past a grant"
    );
    tests.push(
      "Free has 1 active goal (cancelling frees it), Pro has 3, a grant raises it, and the technical ceiling of 20 still holds"
    );

    // ------------------------------------------------------- 7. offline writes
    const offlineFree = await createTenantFixture(
      admin.pool,
      "entitlements offline free",
      "America/Sao_Paulo",
      "free"
    );
    const freeDevice = await registerDevice(db, offlineFree.userId, {
      label: "Free",
    });
    await expectRejects(
      () =>
        as(offlineFree, "offline:manage", (tx, identity) =>
          issueOfflineLeaseGrant(tx, identity, { deviceId: freeDevice.id })
        ),
      EntitlementDeniedError,
      "a Free organization gets no offline lease"
    );
    const granted = await createTenantFixture(
      admin.pool,
      "entitlements offline grant",
      "America/Sao_Paulo",
      "free"
    );
    await grant(granted, "offline.write", true);
    const grantedDevice = await registerDevice(db, granted.userId, {
      label: "Concedido",
    });
    const grantedLease = await as(granted, "offline:manage", (tx, identity) =>
      issueOfflineLeaseGrant(tx, identity, { deviceId: grantedDevice.id })
    );
    assert.ok(grantedLease.claims.jti);
    tests.push(
      "a Free organization gets no offline lease; a temporary grant of offline writes does"
    );

    const offlinePro = await createTenantFixture(
      admin.pool,
      "entitlements offline pro"
    );
    // access that ends in an hour: the lease does not outlive it
    await admin.pool.query(
      "UPDATE public.organization_billing SET access_ends_at = now() + interval '1 hour' WHERE organization_id = $1",
      [offlinePro.organizationId]
    );
    const proDevice = await registerDevice(db, offlinePro.userId, {
      label: "Caixa",
    });
    const accessEnd = (
      await admin.pool.query<{ ends: Date }>(
        "SELECT access_ends_at AS ends FROM public.organization_billing WHERE organization_id = $1",
        [offlinePro.organizationId]
      )
    ).rows[0]?.ends as Date;
    const proLease = await as(offlinePro, "offline:manage", (tx, identity) =>
      issueOfflineLeaseGrant(tx, identity, { deviceId: proDevice.id })
    );
    const leaseSeconds =
      (proLease.grant.expiresAt.getTime() - proLease.grant.issuedAt.getTime()) /
      1000;
    // the lease is cut at the end of the access (to the second), far short of 72 hours
    assert.ok(
      proLease.grant.expiresAt.getTime() <= accessEnd.getTime() + 1000 &&
        leaseSeconds > 0 &&
        leaseSeconds <= 3700,
      `the lease ends with the access (${leaseSeconds}s)`
    );
    await admin.pool.query(
      "UPDATE public.organization_billing SET access_ends_at = now() + interval '30 days' WHERE organization_id = $1",
      [offlinePro.organizationId]
    );
    const longLease = await as(offlinePro, "offline:manage", (tx, identity) =>
      issueOfflineLeaseGrant(tx, identity, { deviceId: proDevice.id })
    );
    assert.equal(
      Math.round(
        (longLease.grant.expiresAt.getTime() -
          longLease.grant.issuedAt.getTime()) /
          3_600_000
      ),
      72,
      "with a long access the lease is the usual 72 hours"
    );
    tests.push(
      "a Pro lease never outlives the access that pays for it, and is the usual 72 hours when the access is long"
    );

    let executions = 0;
    const push = (commandId: string, fail?: () => Error) =>
      as(offlinePro, "category:create", (tx, identity) =>
        runSyncCommand(
          tx,
          identity,
          {
            commandId,
            commandType: "category.create",
            createdAt: new Date(Date.now() - 60_000),
            deviceId: proDevice.id,
            leaseClaims: longLease.claims,
            payloadHash: "a".repeat(64),
          },
          () => {
            executions += 1;
            if (fail) {
              throw fail();
            }
            return Promise.resolve({});
          },
          () => null
        )
      );
    assert.equal((await push(randomUUID())).status, "accepted");
    // downgrade: the record says Free now
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL WHERE organization_id = $1",
      [offlinePro.organizationId]
    );
    const before = executions;
    const retryId = randomUUID();
    const refused = await push(retryId);
    assert.equal(refused.status, "rejected");
    assert.equal(refused.code, "entitlement_changed");
    assert.equal(executions, before, "the command did not run");
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() + interval '30 days' WHERE organization_id = $1",
      [offlinePro.organizationId]
    );
    // the plan allows it again: the very same command (same ID) now goes through
    const retried = await push(retryId);
    assert.equal(retried.status, "accepted");
    assert.equal(retried.replayed, false);
    assert.equal(executions, before + 1);
    const limitId = randomUUID();
    const limitHit = await push(
      limitId,
      () =>
        new EntitlementLimitReachedError("variants.active.max", 2000) as Error
    );
    assert.equal(limitHit.status, "rejected");
    assert.equal(limitHit.code, "entitlement_changed");
    assert.equal(
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.sync_commands WHERE command_id = $1",
            [limitId]
          )
        ).rows[0]?.count
      ),
      0,
      "a plan limit reached while the command ran is not stored either"
    );
    tests.push(
      "a command pushed after a downgrade is rejected without running and without being stored, the same command succeeds once the plan allows it again, and a plan limit reached while it runs is the same retryable refusal"
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
    `Entitlements PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
