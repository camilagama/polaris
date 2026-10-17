import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InvalidSupportRequestError,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { Client } from "pg";
import {
  auditBillingCommand,
  closeSupportCase,
  openSupportCase,
  reactivateOrganization,
  readSupportCase,
  suspendOrganization,
} from "../src/admin-support-repository";
import { createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
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
  type TenantFixture,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Suspending an organization and the audit that brackets a billing command, on a
 * real PostgreSQL 18 (plan PR99 and PR100, ADR 0073): a suspension needs an open
 * case, changes the organization's status, the authorization epoch of its
 * memberships and its live offline leases, leaves billing exactly as it was, and
 * is audited; a billing command is written down before and after the billing role
 * carries it out, and the billing store refuses to end a grant of another
 * organization through a case.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-suspension-gate.cloudflareaccess.com";

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];

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
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
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
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_susp_admin"
    );
    const tenantUrl = await login(runtimeRole, "polaris_susp_tenant");
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_susp_billing"
    );
    const runtimeDb = createDatabase(tenantUrl, { maxConnections: 2 }).db;
    const asAdmin = async <T>(operation: (client: Client) => Promise<T>) => {
      const client = new Client({
        connectionString: adminLoginUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };

    const principal = async (status = "active") =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
    const p1 = await principal();
    const disabled = await principal("disabled");
    const suffix = randomUUID().slice(0, 8);
    const orgA = await createTenantFixture(
      owner.pool,
      `susp A ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const orgB = await createTenantFixture(
      owner.pool,
      `susp B ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const lease = async (tenant: TenantFixture) => {
      const device = await owner.pool.query<{ id: string }>(
        "INSERT INTO public.devices (user_id, label) VALUES ($1, 'aparelho') RETURNING id",
        [tenant.userId]
      );
      await owner.pool.query(
        "INSERT INTO public.offline_grants (device_id, organization_id, user_id, authorization_epoch, expires_at) VALUES ($1, $2, $3, 0, now() + interval '12 hours'), ($1, $2, $3, 0, now() + interval '24 hours')",
        [device.rows[0]?.id, tenant.organizationId, tenant.userId]
      );
    };
    await lease(orgA);
    await lease(orgB);
    const openCase = (organizationId: string, who = p1) =>
      asAdmin((client) =>
        openSupportCase(client, who, {
          context: null,
          kind: "support",
          organizationId,
          reason: "Conta comprometida",
        })
      );
    const state = async (organizationId: string) => {
      const row = await owner.pool.query(
        `SELECT o.status,
                (SELECT max(m.authorization_epoch) FROM public.memberships m WHERE m.organization_id = o.id)::int AS epoch,
                (SELECT count(*) FROM public.offline_grants g WHERE g.organization_id = o.id AND g.revoked_at IS NULL)::int AS live_leases,
                (SELECT count(*) FROM public.offline_grants g WHERE g.organization_id = o.id AND g.revoked_reason = 'organization_suspended')::int AS suspended_leases,
                (SELECT to_jsonb(b) - 'updated_at' FROM public.organization_billing b WHERE b.organization_id = o.id) AS billing,
                (SELECT count(*) FROM public.entitlement_grants x WHERE x.organization_id = o.id)::int AS grants,
                (SELECT count(*) FROM public.billing_events x WHERE x.organization_id = o.id)::int AS events
           FROM public.organizations o WHERE o.id = $1`,
        [organizationId]
      );
      return row.rows[0];
    };
    const tenantSees = (tenant: TenantFixture) =>
      withRuntimeSqlContext(tenantUrl, tenant, (client) =>
        client.query(
          "SELECT 1 FROM public.organizations WHERE id = current_setting('app.organization_id')"
        )
      ).then((result) => result.rowCount === 1);

    // ------------------------------------------------- 1. what a suspension needs
    const caseA = await openCase(orgA.organizationId);
    assert.ok(caseA);
    await assert.rejects(
      () =>
        asAdmin((client) => suspendOrganization(client, disabled, caseA.id)),
      TenantAccessDeniedError
    );
    await assert.rejects(
      () => asAdmin((client) => suspendOrganization(client, p1, randomUUID())),
      (error: unknown) =>
        error instanceof InvalidSupportRequestError &&
        error.code === "case_not_open"
    );
    const closedCase = await openCase(orgA.organizationId);
    assert.ok(closedCase);
    await asAdmin((client) =>
      closeSupportCase(client, p1, closedCase.id, null)
    );
    await assert.rejects(
      () => asAdmin((client) => suspendOrganization(client, p1, closedCase.id)),
      (error: unknown) =>
        error instanceof InvalidSupportRequestError &&
        error.code === "case_not_open"
    );
    assert.equal(
      (await state(orgA.organizationId)).status,
      "active",
      "nothing happened"
    );
    tests.push(
      "suspending needs an active operator and an open case (a disabled operator, an unknown case and a closed case are refused and change nothing)"
    );

    // ------------------------------------------------- 2. what a suspension does
    const before = await state(orgA.organizationId);
    const beforeB = await state(orgB.organizationId);
    assert.equal(before.live_leases, 2);
    assert.equal(await tenantSees(orgA), true);
    const suspended = await asAdmin((client) =>
      suspendOrganization(client, p1, caseA.id)
    );
    assert.deepEqual(suspended, {
      changed: true,
      revokedLeases: 2,
      status: "suspended",
    });
    const after = await state(orgA.organizationId);
    assert.equal(after.status, "suspended");
    assert.equal(
      after.epoch,
      before.epoch + 1,
      "the authorization epoch moves on"
    );
    assert.equal(after.live_leases, 0, "every live offline lease is revoked");
    assert.equal(
      after.suspended_leases,
      2,
      "with the reason it was revoked for"
    );
    assert.deepEqual(
      after.billing,
      before.billing,
      "billing is exactly as it was"
    );
    assert.equal(after.grants, before.grants, "and so are its grants");
    assert.equal(after.events, before.events, "and its ledger");
    assert.equal(
      await tenantSees(orgA),
      false,
      "the organization no longer opens for its own users"
    );
    assert.deepEqual(
      await state(orgB.organizationId),
      beforeB,
      "another organization is untouched"
    );
    const again = await asAdmin((client) =>
      suspendOrganization(client, p1, caseA.id)
    );
    assert.deepEqual(again, { changed: false, status: "suspended" });
    assert.equal(
      (await state(orgA.organizationId)).epoch,
      after.epoch,
      "suspending twice is one"
    );
    const trail = await asAdmin((client) => readSupportCase(client, caseA.id));
    const events =
      trail?.audit.filter(
        (entry) => entry.eventType === "organization.suspended"
      ) ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.detail, "leases=2");
    assert.equal(events[0]?.entityId, orgA.organizationId);
    tests.push(
      "a suspension changes the status, moves every membership's authorization epoch, revokes every live offline lease with its reason and leaves billing and every other organization exactly as they were; the organization stops opening for its own users; doing it twice is once, and the audit has one record with the number of leases"
    );

    // ------------------------------------------------- 2b. a user in two organizations, and the race with a lease being issued
    const orgD = await createTenantFixture(
      owner.pool,
      `susp D ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const orgE = await createTenantFixture(
      owner.pool,
      `susp E ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    await owner.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [orgE.organizationId, orgD.userId]
    );
    const deviceOf = async (userId: string) =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.devices (user_id, label) VALUES ($1, 'aparelho') RETURNING id",
          [userId]
        )
      ).rows[0]?.id as string;
    const leaseFor = (
      deviceId: string,
      organizationId: string,
      userId: string,
      runner: {
        query: (text: string, values: unknown[]) => Promise<unknown>;
      } = owner.pool
    ) =>
      runner.query(
        "INSERT INTO public.offline_grants (device_id, organization_id, user_id, authorization_epoch, expires_at) VALUES ($1, $2, $3, 0, now() + interval '12 hours')",
        [deviceId, organizationId, userId]
      );
    const sharedDevice = await deviceOf(orgD.userId);
    await leaseFor(sharedDevice, orgD.organizationId, orgD.userId);
    await leaseFor(sharedDevice, orgE.organizationId, orgD.userId);
    const epochOf = async (organizationId: string, userId: string) =>
      (
        await owner.pool.query<{ epoch: number }>(
          "SELECT authorization_epoch AS epoch FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
          [organizationId, userId]
        )
      ).rows[0]?.epoch as number;
    const epochE = await epochOf(orgE.organizationId, orgD.userId);
    const caseD = await openCase(orgD.organizationId);
    assert.ok(caseD);
    // a lease being issued holds the user's key while the suspension asks for it
    const issuing = await owner.pool.connect();
    let suspendedD: Awaited<ReturnType<typeof suspendOrganization>> | undefined;
    try {
      await issuing.query("BEGIN");
      await issuing.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('authorization-epoch:' || $1::text, 0))",
        [orgD.userId]
      );
      await leaseFor(sharedDevice, orgD.organizationId, orgD.userId, issuing);
      const waiting = asAdmin((client) =>
        suspendOrganization(client, p1, caseD.id)
      );
      const outcome = await Promise.race([
        waiting.then(() => "finished"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 1500)),
      ]);
      assert.equal(
        outcome,
        "waiting",
        "the suspension waits for the lease being issued"
      );
      await issuing.query("COMMIT");
      suspendedD = await waiting;
    } catch (error) {
      await issuing.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      issuing.release();
    }
    assert.deepEqual(
      suspendedD,
      { changed: true, revokedLeases: 2, status: "suspended" },
      "the lease issued just before is revoked by the suspension (it is not left alive)"
    );
    assert.equal((await state(orgD.organizationId)).live_leases, 0);
    assert.equal(
      (await state(orgE.organizationId)).live_leases,
      1,
      "the same user's lease in another organization is untouched"
    );
    assert.equal(
      await epochOf(orgE.organizationId, orgD.userId),
      epochE,
      "and so is that membership's epoch"
    );
    assert.equal((await state(orgE.organizationId)).status, "active");
    // after the suspension nothing new is issued or done in that organization
    await assert.rejects(
      () =>
        withTenantAs(runtimeDb, orgD, "catalog:read", () => Promise.resolve(1)),
      (error: unknown) => error instanceof Error
    );
    tests.push(
      "a suspension waits for a lease that is being issued and then revokes it (the same per-user key the issuance takes), leaves the same user's lease and epoch in another organization alone, and afterwards the organization's own user cannot start a tenant operation"
    );

    // ------------------------------------------------- 3. undoing it
    await assert.rejects(
      () =>
        asAdmin((client) => reactivateOrganization(client, disabled, caseA.id)),
      TenantAccessDeniedError
    );
    const reactivated = await asAdmin((client) =>
      reactivateOrganization(client, p1, caseA.id)
    );
    assert.deepEqual(reactivated, { changed: true, status: "active" });
    assert.equal(await tenantSees(orgA), true);
    const stillRevoked = await state(orgA.organizationId);
    assert.equal(
      stillRevoked.live_leases,
      0,
      "the leases stay revoked: a device must ask again"
    );
    assert.equal(stillRevoked.epoch, after.epoch, "the epoch does not go back");
    assert.deepEqual(
      await asAdmin((client) => reactivateOrganization(client, p1, caseA.id)),
      { changed: false, status: "active" }
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'closed' WHERE id = $1",
      [orgA.organizationId]
    );
    assert.deepEqual(
      await asAdmin((client) => reactivateOrganization(client, p1, caseA.id)),
      { changed: false, status: "closed" },
      "a closed organization stays closed"
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'active' WHERE id = $1",
      [orgA.organizationId]
    );
    const trail2 = await asAdmin((client) => readSupportCase(client, caseA.id));
    assert.equal(
      trail2?.audit.filter(
        (entry) => entry.eventType === "organization.reactivated"
      ).length,
      1
    );
    tests.push(
      "reactivating needs an active operator and an open case, opens the organization again but never brings back a revoked lease or an old epoch, is once, leaves a closed organization closed and is audited"
    );

    // ------------------------------------------------- 4. the audit around a billing command
    const billingCase = await openCase(orgA.organizationId);
    assert.ok(billingCase);
    const audit = (
      caseId: string,
      event: string,
      entity: string | null = randomUUID(),
      detail: string | null = "key=variants.active.max",
      who = p1
    ) =>
      asAdmin((client) =>
        auditBillingCommand(client, who, caseId, event as never, entity, detail)
      );
    assert.equal(
      await audit(billingCase.id, "billing.entitlement_grant_requested"),
      orgA.organizationId
    );
    assert.equal(
      await audit(billingCase.id, "billing.entitlement_granted"),
      orgA.organizationId
    );
    assert.equal(
      await audit(
        billingCase.id,
        "billing.entitlement_revoke_requested",
        null,
        null
      ),
      orgA.organizationId
    );
    for (const bad of [
      "pii.revealed",
      "organization.suspended",
      "billing.refund",
      "",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await assert.rejects(
        () => audit(billingCase.id, bad),
        InvalidSupportRequestError,
        `${bad} is not a billing step`
      );
    }
    await assert.rejects(
      () =>
        audit(
          billingCase.id,
          "billing.entitlement_granted",
          randomUUID(),
          "x".repeat(201)
        ),
      InvalidSupportRequestError
    );
    await assert.rejects(
      () =>
        audit(
          billingCase.id,
          "billing.entitlement_granted",
          randomUUID(),
          null,
          disabled
        ),
      TenantAccessDeniedError
    );
    await assert.rejects(
      () => audit(closedCase.id, "billing.entitlement_granted"),
      InvalidSupportRequestError
    );
    await assert.rejects(
      () => audit(randomUUID(), "billing.entitlement_granted"),
      InvalidSupportRequestError
    );
    const billingTrail = await asAdmin((client) =>
      readSupportCase(client, billingCase.id)
    );
    assert.deepEqual(
      billingTrail?.audit.map((entry) => entry.eventType).sort(),
      [
        "billing.entitlement_grant_requested",
        "billing.entitlement_granted",
        "billing.entitlement_revoke_requested",
        "support_case.opened",
      ]
    );
    tests.push(
      "a step of a billing command is written down only for an active operator on an open case, only as one of the four billing steps, with a short note; the organization it names is the case's"
    );

    // ------------------------------------------------- 5. the billing role ends only a grant of its organization
    const store = createBillingStore(billingUrl);
    try {
      const actor = "admin:gate";
      const first = await store.grantEntitlement({
        actor,
        expiresAt: new Date(Date.now() + 48 * 3_600_000),
        key: "variants.active.max",
        organizationId: orgA.organizationId,
        reason: "Compensação",
        value: 300,
      });
      // a command that names its own ID reads the grant first, so a repeat a moment later is the same grant
      const found = await store.findEntitlementGrant(first.id);
      assert.equal(found?.organizationId, orgA.organizationId);
      assert.equal(found?.key, "variants.active.max");
      assert.equal(found?.limitValue, 300);
      assert.equal(found?.flagValue, null);
      assert.equal(found?.grantedBy, actor);
      assert.equal(found?.reason, "Compensação");
      assert.ok(found?.expiresAt instanceof Date);
      assert.equal(
        await store.findEntitlementGrant(randomUUID()),
        null,
        "an unknown ID finds nothing"
      );
      await assert.rejects(() => store.findEntitlementGrant("not-a-uuid"));
      assert.deepEqual(
        await store.revokeEntitlementGrant({
          actor,
          id: first.id,
          organizationId: orgB.organizationId,
        }),
        { revoked: false },
        "through another organization's case the grant is left alone"
      );
      assert.deepEqual(
        await store.revokeEntitlementGrant({
          actor,
          id: first.id,
          organizationId: orgA.organizationId,
        }),
        { revoked: true }
      );
      const second = await store.grantEntitlement({
        actor,
        expiresAt: new Date(Date.now() + 48 * 3_600_000),
        key: "images.active.max",
        organizationId: orgA.organizationId,
        reason: "Compensação",
        value: 300,
      });
      assert.deepEqual(
        await store.revokeEntitlementGrant({ actor, id: second.id }),
        { revoked: true },
        "without a named organization it works as before"
      );
    } finally {
      await store.close();
    }
    tests.push(
      "the billing store ends a grant through a case only when it belongs to the case's organization (another organization's grant is left as it is), behaves as before when no organization is named, and finds a grant by its ID (nothing for an unknown one) so a repeated command can be recognized"
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
    for (const [role, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Admin suspension PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
