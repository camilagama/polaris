import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ClosureConfirmationError,
  ClosureNotRecoverableError,
} from "@polaris/domain/organization/closure";
import { Client } from "pg";
import {
  openSupportCase,
  reactivateOrganization,
  suspendOrganization,
} from "../src/admin-support-repository";
import { createDatabase } from "../src/client";
import {
  listOrganizationsInClosure,
  recoverOrganizationClosure,
  requestOrganizationClosure,
} from "../src/organization-closure-repository";
import { createPrivacyMaintenanceClient } from "../src/privacy-maintenance";
import { TenantAuthorizationError } from "../src/tenant-transaction";
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
  type TenantFixture,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Closing an organization on a real PostgreSQL 18 (plan PR101, ADR 0074): the owner's
 * request changes the status, the authorization epoch and the offline leases in one
 * transaction (under the key lease issuance takes) and leaves billing and every other
 * organization as they were; the owner undoes it only while the window is open; the
 * sweep marks an expired window as closed and nothing else; and no role reaches the
 * closure record or the functions it should not.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-closure-gate.cloudflareaccess.com";
const WINDOW_SECONDS = 30 * 86_400;
const SERVICE_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
];

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
  let runtime: ReturnType<typeof createDatabase> | undefined;

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
    const tenantUrl = await login(runtimeRole, "polaris_clos_tenant");
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_clos_priv"
    );
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_clos_admin"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const runtimeDb = runtime.db;
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

    const suffix = randomUUID().slice(0, 8);
    const fixture = (label: string) =>
      createTenantFixture(
        owner.pool,
        `clos ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
    const nameOf = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{ name: string }>(
          "SELECT name FROM public.organizations WHERE id = $1",
          [tenant.organizationId]
        )
      ).rows[0]?.name as string;
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
    const twoLeases = async (tenant: TenantFixture) => {
      const device = await deviceOf(tenant.userId);
      await leaseFor(device, tenant.organizationId, tenant.userId);
      await leaseFor(device, tenant.organizationId, tenant.userId);
      return device;
    };
    const state = async (organizationId: string) =>
      (
        await owner.pool.query(
          `SELECT o.status,
                  (SELECT max(m.authorization_epoch) FROM public.memberships m WHERE m.organization_id = o.id)::int AS epoch,
                  (SELECT count(*) FROM public.offline_grants g WHERE g.organization_id = o.id AND g.revoked_at IS NULL)::int AS live_leases,
                  (SELECT count(*) FROM public.offline_grants g WHERE g.organization_id = o.id AND g.revoked_reason = 'organization_closed')::int AS closed_leases,
                  (SELECT to_jsonb(b) - 'updated_at' FROM public.organization_billing b WHERE b.organization_id = o.id) AS billing,
                  (SELECT count(*) FROM public.entitlement_grants x WHERE x.organization_id = o.id)::int AS grants,
                  (SELECT count(*) FROM public.billing_events x WHERE x.organization_id = o.id)::int AS events
             FROM public.organizations o WHERE o.id = $1`,
          [organizationId]
        )
      ).rows[0];
    const closureOf = async (organizationId: string) =>
      (
        await owner.pool.query(
          `SELECT requested_by_user_id,
                  extract(epoch FROM (recover_until - requested_at))::int AS window_seconds,
                  closed_at IS NOT NULL AS is_closed,
                  recovered_at IS NOT NULL AS is_recovered
             FROM public.organization_closures WHERE organization_id = $1`,
          [organizationId]
        )
      ).rows[0];
    const auditCount = async (organizationId: string, eventType: string) =>
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = $2",
            [organizationId, eventType]
          )
        ).rows[0]?.count
      );
    const tenantSees = (tenant: TenantFixture) =>
      withRuntimeSqlContext(tenantUrl, tenant, (client) =>
        client.query(
          "SELECT 1 FROM public.organizations WHERE id = current_setting('app.organization_id')"
        )
      ).then((result) => result.rowCount === 1);
    const close = (tenant: TenantFixture, confirmation: string) =>
      withTenantAs(
        runtimeDb,
        tenant,
        "organization:close",
        (transaction, identity) =>
          requestOrganizationClosure(transaction, identity, { confirmation })
      );

    const orgA = await fixture("A");
    const orgB = await fixture("B");
    const nameA = await nameOf(orgA);
    const deviceA = await twoLeases(orgA);
    await twoLeases(orgB);

    // ------------------------------------------------- 1. the request
    const beforeA = await state(orgA.organizationId);
    const beforeB = await state(orgB.organizationId);
    assert.equal(beforeA.live_leases, 2);
    assert.equal(await tenantSees(orgA), true);
    await assert.rejects(
      () => close(orgA, `${nameA} outra`),
      ClosureConfirmationError,
      "a name that is not the organization's is refused"
    );
    await assert.rejects(
      () =>
        withTenantAs(runtimeDb, orgA, "catalog:read", (transaction, identity) =>
          requestOrganizationClosure(transaction, identity, {
            confirmation: nameA,
          })
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied",
      "closing needs its own capability"
    );
    assert.deepEqual(
      await state(orgA.organizationId),
      beforeA,
      "refused requests change nothing"
    );
    assert.equal(await closureOf(orgA.organizationId), undefined);
    const requested = await close(orgA, `  ${nameA.toUpperCase()}  `);
    assert.equal(requested.revokedLeases, 2);
    const afterA = await state(orgA.organizationId);
    assert.equal(afterA.status, "closing");
    assert.equal(
      afterA.epoch,
      beforeA.epoch + 1,
      "the authorization epoch moves on"
    );
    assert.equal(afterA.live_leases, 0, "every live offline lease is revoked");
    assert.equal(afterA.closed_leases, 2, "with the reason it was revoked for");
    assert.deepEqual(
      afterA.billing,
      beforeA.billing,
      "billing is exactly as it was"
    );
    assert.equal(afterA.grants, beforeA.grants);
    assert.equal(afterA.events, beforeA.events);
    assert.deepEqual(
      await state(orgB.organizationId),
      beforeB,
      "another organization is untouched"
    );
    const closure = await closureOf(orgA.organizationId);
    assert.equal(closure.requested_by_user_id, orgA.userId);
    assert.equal(
      closure.window_seconds,
      WINDOW_SECONDS,
      "the window is thirty days"
    );
    assert.equal(closure.is_closed, false);
    assert.equal(closure.is_recovered, false);
    assert.equal(
      requested.recoverUntil.getTime() >
        Date.now() + (WINDOW_SECONDS - 60) * 1000,
      true
    );
    assert.equal(
      await auditCount(orgA.organizationId, "organization.closure_requested"),
      1
    );
    assert.equal(
      await tenantSees(orgA),
      false,
      "it no longer opens for its own users"
    );
    await assert.rejects(
      () =>
        withTenantAs(runtimeDb, orgA, "catalog:read", () => Promise.resolve(1)),
      (error: unknown) => error instanceof TenantAuthorizationError,
      "and no tenant operation starts"
    );
    await assert.rejects(
      () => close(orgA, nameA),
      (error: unknown) => error instanceof TenantAuthorizationError,
      "a second request cannot even start"
    );
    tests.push(
      "an owner's closure needs the organization's typed name (case and spacing aside) and its own capability; it moves the status to closing, the authorization epoch and every live offline lease (with its reason) in one transaction, writes the record with a thirty-day window and the audit event, and leaves billing, grants, the ledger and every other organization exactly as they were; the organization stops opening"
    );

    // ------------------------------------------------- 2. what the function itself refuses
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, orgB, (client) =>
          client.query("SELECT public.request_organization_closure(0)")
        ),
      "22023",
      "a window outside 1 to 90 days is refused"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(
          tenantUrl,
          { organizationId: orgB.organizationId, userId: orgA.userId },
          (client) =>
            client.query("SELECT public.request_organization_closure(30)")
        ),
      "42501",
      "a user who is not a member of the organization is refused"
    );
    const bare = new Client({
      connectionString: tenantUrl,
      connectionTimeoutMillis: 5000,
    });
    await bare.connect();
    try {
      await expectSqlState(
        () => bare.query("SELECT public.request_organization_closure(30)"),
        "42501",
        "without the transaction's identity nothing runs"
      );
      await expectSqlState(
        () => bare.query("SELECT public.recover_organization_closure('x')"),
        "42501",
        "recovery needs the identity too"
      );
    } finally {
      await bare.end();
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, orgA, (client) =>
          client.query("SELECT public.request_organization_closure(30)")
        ),
      "55000",
      "an organization that is not active cannot be closed again"
    );
    assert.equal((await state(orgB.organizationId)).status, "active");
    tests.push(
      "the closure function refuses a window outside 1 to 90 days, a user who is not a member, a call without the transaction's identity and an organization that is not active, and changes nothing"
    );

    // a lease cannot be issued after the closure: the organization is no longer active for the tenant runtime
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, orgA, (client) =>
          leaseFor(deviceA, orgA.organizationId, orgA.userId, client)
        ),
      "42501",
      "no offline lease is issued to a closing organization"
    );
    assert.equal((await state(orgA.organizationId)).live_leases, 0);
    // two requests at once: one closes it, the other finds it no longer active
    const orgG = await fixture("G");
    const both = await Promise.allSettled([
      withRuntimeSqlContext(tenantUrl, orgG, (client) =>
        client.query("SELECT public.request_organization_closure(30)")
      ),
      withRuntimeSqlContext(tenantUrl, orgG, (client) =>
        client.query("SELECT public.request_organization_closure(30)")
      ),
    ]);
    assert.deepEqual(
      both.map((outcome) => outcome.status).sort(),
      ["fulfilled", "rejected"],
      "exactly one of two simultaneous requests closes the organization"
    );
    const lost = both.find((outcome) => outcome.status === "rejected");
    assert.equal(
      (lost as PromiseRejectedResult).reason?.code,
      "55000",
      "and the other is told it is not active"
    );
    assert.equal((await state(orgG.organizationId)).status, "closing");
    assert.equal(
      await auditCount(orgG.organizationId, "organization.closure_requested"),
      1
    );
    tests.push(
      "after a closure no offline lease can be issued to the organization, and of two simultaneous requests exactly one closes it (the other is refused as not active) with a single audit event"
    );

    // ------------------------------------------------- 3. a user in two organizations, and the race with a lease being issued
    const orgD = await fixture("D");
    const orgE = await fixture("E");
    await owner.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [orgE.organizationId, orgD.userId]
    );
    const shared = await deviceOf(orgD.userId);
    await leaseFor(shared, orgD.organizationId, orgD.userId);
    await leaseFor(shared, orgE.organizationId, orgD.userId);
    const epochOf = async (organizationId: string, userId: string) =>
      (
        await owner.pool.query<{ epoch: number }>(
          "SELECT authorization_epoch AS epoch FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
          [organizationId, userId]
        )
      ).rows[0]?.epoch as number;
    const epochE = await epochOf(orgE.organizationId, orgD.userId);
    const issuing = await owner.pool.connect();
    let closedD: Awaited<ReturnType<typeof close>> | undefined;
    try {
      await issuing.query("BEGIN");
      await issuing.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('authorization-epoch:' || $1::text, 0))",
        [orgD.userId]
      );
      await leaseFor(shared, orgD.organizationId, orgD.userId, issuing);
      const waiting = close(orgD, await nameOf(orgD));
      const outcome = await Promise.race([
        waiting.then(() => "finished"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 1500)),
      ]);
      assert.equal(
        outcome,
        "waiting",
        "the closure waits for the lease being issued"
      );
      await issuing.query("COMMIT");
      closedD = await waiting;
    } catch (error) {
      await issuing.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      issuing.release();
    }
    assert.equal(
      closedD?.revokedLeases,
      2,
      "the lease issued just before is revoked by the closure"
    );
    assert.equal((await state(orgD.organizationId)).live_leases, 0);
    assert.equal(
      (await state(orgE.organizationId)).live_leases,
      1,
      "the same user's lease in another organization is untouched"
    );
    assert.equal(await epochOf(orgE.organizationId, orgD.userId), epochE);
    assert.equal((await state(orgE.organizationId)).status, "active");
    tests.push(
      "a closure waits for a lease that is being issued (the per-user key issuance takes) and then revokes it; the same user's lease, epoch and organization elsewhere are untouched"
    );

    // ------------------------------------------------- 4. seeing and undoing a closure
    const mine = await listOrganizationsInClosure(runtimeDb, orgA.userId);
    assert.deepEqual(
      mine.map((entry) => entry.id),
      [orgA.organizationId]
    );
    assert.equal(mine[0]?.name, nameA);
    assert.equal(
      (await listOrganizationsInClosure(runtimeDb, orgB.userId)).length,
      0,
      "an organization that is open is not listed"
    );
    assert.deepEqual(
      (await listOrganizationsInClosure(runtimeDb, orgD.userId)).map(
        (entry) => entry.id
      ),
      [orgD.organizationId],
      "a user in two organizations sees only the one in closure"
    );
    await assert.rejects(
      () =>
        recoverOrganizationClosure(runtimeDb, orgB.userId, orgA.organizationId),
      TenantAuthorizationError,
      "someone else cannot undo it"
    );
    assert.equal((await state(orgA.organizationId)).status, "closing");
    const epochBefore = (await state(orgA.organizationId)).epoch;
    await recoverOrganizationClosure(
      runtimeDb,
      orgA.userId,
      orgA.organizationId
    );
    const recovered = await state(orgA.organizationId);
    assert.equal(recovered.status, "active");
    assert.equal(recovered.epoch, epochBefore, "the epoch is not moved back");
    assert.equal(
      recovered.live_leases,
      0,
      "the leases revoked at the request stay revoked"
    );
    assert.deepEqual(recovered.billing, beforeA.billing);
    assert.equal((await closureOf(orgA.organizationId)).is_recovered, true);
    assert.equal(
      await auditCount(orgA.organizationId, "organization.closure_recovered"),
      1
    );
    assert.equal(await tenantSees(orgA), true, "the organization opens again");
    assert.equal(
      await withTenantAs(runtimeDb, orgA, "catalog:read", () =>
        Promise.resolve("open")
      ),
      "open"
    );
    await assert.rejects(
      () =>
        recoverOrganizationClosure(runtimeDb, orgA.userId, orgA.organizationId),
      ClosureNotRecoverableError,
      "an organization that is open has nothing to undo"
    );
    const again = await close(orgA, nameA);
    assert.equal(again.revokedLeases, 0);
    const reclosed = await closureOf(orgA.organizationId);
    assert.equal(
      reclosed.is_recovered,
      false,
      "a new closure rewrites the record"
    );
    assert.equal(
      await auditCount(orgA.organizationId, "organization.closure_requested"),
      2
    );
    tests.push(
      "the owner lists their own organizations in closure (only those) and undoes a closure while the window is open: the organization opens again, billing is as it was, the epoch is not moved back and the revoked leases stay revoked; someone else cannot; closing again after a recovery rewrites the record and the audit keeps both requests"
    );

    // ------------------------------------------------- 5. the window ends
    const orgF = await fixture("F");
    await close(orgF, await nameOf(orgF));
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '31 days', recover_until = now() - interval '1 day' WHERE organization_id = $1",
      [orgA.organizationId]
    );
    await assert.rejects(
      () =>
        recoverOrganizationClosure(runtimeDb, orgA.userId, orgA.organizationId),
      ClosureNotRecoverableError,
      "after the window the owner cannot undo it"
    );
    assert.equal(
      (await listOrganizationsInClosure(runtimeDb, orgA.userId)).length,
      0,
      "and it is no longer offered"
    );
    const privacy = createPrivacyMaintenanceClient(privacyUrl);
    try {
      await assert.rejects(() => privacy.finalizeExpiredClosures(0));
      await assert.rejects(() => privacy.finalizeExpiredClosures(1001));
      assert.equal(
        await privacy.finalizeExpiredClosures(100),
        1,
        "exactly the expired one"
      );
      assert.equal(
        await privacy.finalizeExpiredClosures(100),
        0,
        "doing it again changes nothing"
      );
    } finally {
      await privacy.close();
    }
    assert.equal((await state(orgA.organizationId)).status, "closed");
    assert.equal((await closureOf(orgA.organizationId)).is_closed, true);
    assert.equal(
      (await state(orgF.organizationId)).status,
      "closing",
      "a window still open is left alone"
    );
    assert.equal((await state(orgB.organizationId)).status, "active");
    assert.equal((await state(orgD.organizationId)).status, "closing");
    await assert.rejects(
      () =>
        recoverOrganizationClosure(runtimeDb, orgA.userId, orgA.organizationId),
      ClosureNotRecoverableError,
      "a closed organization is not recovered by its owner"
    );
    // the platform's reactivation undoes a suspension only
    const principal = (
      await owner.pool.query<{ id: string }>(
        "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
        [issuer, `sub-${randomUUID()}`]
      )
    ).rows[0]?.id as string;
    const caseA = await asAdmin((client) =>
      openSupportCase(client, principal, {
        context: null,
        kind: "support",
        organizationId: orgA.organizationId,
        reason: "Conta encerrada",
      })
    );
    assert.ok(caseA);
    assert.deepEqual(
      await asAdmin((client) =>
        reactivateOrganization(client, principal, caseA.id)
      ),
      { changed: false, status: "closed" },
      "reactivating does not reopen a closed organization"
    );
    assert.deepEqual(
      await asAdmin((client) =>
        suspendOrganization(client, principal, caseA.id)
      ),
      { changed: false, status: "closed" },
      "nor does a suspension change a closed organization"
    );
    tests.push(
      "when the window ends the owner can no longer undo the closure and it is no longer offered; the sweep marks exactly the expired ones as closed (a window still open and every other status are left alone), is bounded (a limit outside 1 to 1000 is refused) and is idempotent; the platform's reactivate and suspend leave a closed organization as it is"
    );

    // ------------------------------------------------- 6. who may do what
    const permission = async (sql: string, values: unknown[]) =>
      (await owner.pool.query<{ allowed: boolean }>(sql, values)).rows[0]
        ?.allowed;
    await Promise.all(
      SERVICE_ROLES.map(async (role) =>
        assert.equal(
          await permission(
            "SELECT has_any_column_privilege($1, 'public.organization_closures', 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege($1, 'public.organization_closures', 'DELETE, TRUNCATE') AS allowed",
            [role]
          ),
          false,
          `${role} reaches no part of the closure record`
        )
      )
    );
    const executes = async (role: string, signature: string) =>
      permission(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
        [role, signature]
      );
    const tenantFunctions = [
      "public.request_organization_closure(integer)",
      "public.recover_organization_closure(text)",
      "public.list_organizations_in_closure()",
    ];
    await Promise.all(
      SERVICE_ROLES.flatMap((role) => [
        ...tenantFunctions.map(async (signature) =>
          assert.equal(
            await executes(role, signature),
            role === "polaris_pr11_runtime",
            `${role} on ${signature}`
          )
        ),
        (async () =>
          assert.equal(
            await executes(role, "public.finalize_expired_closures(integer)"),
            role === "polaris_privacy_runtime",
            `${role} on the sweep`
          ))(),
      ])
    );
    await Promise.all(
      [...tenantFunctions, "public.finalize_expired_closures(integer)"].map(
        async (signature) =>
          assert.equal(
            await permission(
              "SELECT coalesce(bool_or(acl.grantee = 0), false) AS allowed FROM pg_proc p, LATERAL aclexplode(p.proacl) acl WHERE p.oid = $1::regprocedure",
              [signature]
            ),
            false,
            `PUBLIC does not execute ${signature}`
          )
      )
    );
    const owned = await owner.pool.query<{ proname: string; owner: string }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
        WHERE p.proname IN ('request_organization_closure', 'recover_organization_closure', 'list_organizations_in_closure', 'finalize_expired_closures')
        ORDER BY p.proname`
    );
    assert.deepEqual(
      owned.rows.map((row) => `${row.proname}:${row.owner}`),
      [
        "finalize_expired_closures:polaris_privacy_owner",
        "list_organizations_in_closure:polaris_privacy_owner",
        "recover_organization_closure:polaris_privacy_owner",
        "request_organization_closure:polaris_privacy_owner",
      ]
    );
    const privileges = async (table: string) =>
      (
        await owner.pool.query<{ privilege: string }>(
          `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
            WHERE grantee = 'polaris_privacy_owner' AND table_schema = 'public' AND table_name = $1
            ORDER BY privilege_type`,
          [table]
        )
      ).rows.map((row) => row.privilege);
    assert.deepEqual(await privileges("organization_closures"), [
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    assert.deepEqual(await privileges("tenant_audit_event"), ["INSERT"]);
    for (const table of ["organizations", "memberships", "offline_grants"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      const held = await privileges(table);
      assert.equal(
        held.includes("DELETE") ||
          held.includes("INSERT") ||
          held.includes("TRUNCATE"),
        false,
        `the privacy owner cannot insert into or delete from ${table}`
      );
    }
    const columns = async (table: string, privilege: string) =>
      (
        await owner.pool.query<{ column_name: string }>(
          `SELECT DISTINCT column_name FROM information_schema.column_privileges
            WHERE grantee = 'polaris_privacy_owner' AND table_schema = 'public' AND table_name = $1 AND privilege_type = $2
            ORDER BY column_name`,
          [table, privilege]
        )
      ).rows.map((row) => row.column_name);
    assert.deepEqual(await columns("organizations", "UPDATE"), [
      "status",
      "updated_at",
    ]);
    assert.deepEqual(await columns("memberships", "UPDATE"), [
      "authorization_epoch",
      "updated_at",
    ]);
    assert.deepEqual(await columns("offline_grants", "UPDATE"), [
      "revoked_at",
      "revoked_reason",
    ]);
    assert.deepEqual(await columns("organizations", "SELECT"), [
      "id",
      "name",
      "status",
    ]);
    assert.deepEqual(await columns("memberships", "SELECT"), [
      "authorization_epoch",
      "organization_id",
      "role",
      "status",
      "user_id",
    ]);
    assert.deepEqual(await columns("offline_grants", "SELECT"), [
      "organization_id",
      "revoked_at",
    ]);
    await Promise.all(
      ["organizations", "memberships", "offline_grants"].map(async (table) =>
        assert.deepEqual(
          await columns(table, "INSERT"),
          [],
          `the privacy owner inserts nothing into ${table}`
        )
      )
    );
    const policies = await owner.pool.query<{ policyname: string }>(
      "SELECT policyname FROM pg_policies WHERE 'polaris_privacy_owner' = ANY (roles) ORDER BY policyname"
    );
    assert.deepEqual(
      policies.rows.map((row) => row.policyname),
      [
        "memberships_privacy_owner_select",
        "memberships_privacy_owner_update",
        "offline_grants_privacy_owner_select",
        "offline_grants_privacy_owner_update",
        "organization_closures_privacy_owner_insert",
        "organization_closures_privacy_owner_select",
        "organization_closures_privacy_owner_update",
        "organizations_privacy_owner_select",
        "organizations_privacy_owner_update",
        "tenant_audit_event_privacy_owner_insert",
      ]
    );
    const forced = await owner.pool.query<{ relforcerowsecurity: boolean }>(
      "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.organization_closures'::regclass"
    );
    assert.equal(forced.rows[0]?.relforcerowsecurity, true);
    const status = await owner.pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'organizations_status_check'"
    );
    for (const value of [
      "active",
      "suspended",
      "closing",
      "closed",
      "purge_pending",
      "purged",
    ]) {
      assert.match(status.rows[0]?.definition ?? "", new RegExp(`'${value}'`));
    }
    tests.push(
      "no service role reaches any part of the closure record; only the tenant runtime executes the request, recovery and listing functions and only the privacy runtime executes the sweep (not PUBLIC, not another service); the functions belong to the privacy owner, whose table privileges, updatable columns and policies are exactly the ones the closure needs; the record is row-level secured and forced; the status check names the whole life"
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
    await runtime?.pool.end().catch(() => undefined);
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
    `Organization closure PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
