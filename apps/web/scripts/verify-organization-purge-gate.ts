import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cancelOrganizationPurge,
  grantTenantAccess,
  openPrivacyCase,
  openSupportCase,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  revokeTenantAccess,
  scheduleOrganizationPurge,
} from "@polaris/db/admin-support-repository";
import { createDatabase } from "@polaris/db/client";
import { createCustomer } from "@polaris/db/customer-repository";
import { requestDataExport } from "@polaris/db/data-export-repository";
import { requestOrganizationClosure } from "@polaris/db/organization-closure-repository";
import { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import {
  PURGE_CASCADED_TABLES,
  PURGE_DELETE_ORDER,
  PURGE_SURVIVING_TABLES,
} from "@polaris/db/purge-datasets";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { mediaDerivativeKey } from "@polaris/domain/catalog/media";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import {
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
  OrganizationPurgeRefusedError,
} from "@polaris/domain/privacy/organization-purge";
import {
  confirmPlainSale,
  createProductFixture,
  createSellableProduct,
  createTenantFixture,
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
  withTenantAs,
} from "../../../packages/db/scripts/sales-gate-support";
import type { MediaBucketBinding } from "../src/server/environment";
import { runDataExports } from "../src/server/privacy/data-export-job";
import { createRequesterReader } from "../src/server/privacy/data-export-reader";
import { runOrganizationPurges } from "../src/server/privacy/organization-purge-job";

/**
 * The full purge of a closed organization on a real PostgreSQL 18 (plan PR107, ADR 0081), with the
 * real job and an in-memory bucket: only an operator schedules it, only for a closed organization whose
 * recovery window is over; the storage goes before the rows and nothing is left under the
 * organization's prefixes; every row of the tenant goes in one transaction that writes the deletion
 * ledger tombstone first; the cases, the audit, the billing and the ledger survive; running it again
 * changes nothing; and an export cannot leave a copy of an organization that is no longer active.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const REMOVED_NAME = "Organização removida";

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket: Pick<MediaBucketBinding, "delete" | "get" | "list" | "put"> = {
    delete: (keys) => {
      for (const key of [keys].flat()) {
        objects.delete(key);
      }
      return Promise.resolve();
    },
    get: () => Promise.resolve(null),
    list: (options) =>
      Promise.resolve({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .sort()
          .slice(0, options.limit)
          .map((key) => ({ key, uploaded: new Date() })),
        truncated: false,
      }),
    put: (key, value) => {
      objects.set(key, value);
      return Promise.resolve({ etag: "gate" });
    },
  };
  return { bucket, objects };
}

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
  let privacy: ReturnType<typeof createPrivacyMaintenanceClient> | undefined;
  let adminDatabase: ReturnType<typeof createDatabase> | undefined;

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    assert.equal(server.rows[0]?.database_name, expectedDatabase);
    assert.ok(Number(server.rows[0]?.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // claims take the oldest waiting row of the whole database: a rerun must not meet the last run's
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE status IN ('requested', 'running')"
    );
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '1 day' WHERE swept_at IS NULL"
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
    const tenantUrl = await login(runtimeRole, "polaris_purge_tenant");
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_purge_priv"
    );
    const adminRuntimeUrl = await login(
      "polaris_admin_runtime",
      "polaris_purge_admin"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const { db } = runtime;
    privacy = createPrivacyMaintenanceClient(privacyUrl);
    const maintenance = privacy;
    adminDatabase = createDatabase(adminRuntimeUrl, { maxConnections: 1 });
    const admin = adminDatabase.pool;
    const gateRuntime = { adminPool: owner.pool, db };

    const principal = (
      await owner.pool.query<{ id: string }>(
        "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
        ["https://purge-gate.example", `purge-${randomUUID()}`]
      )
    ).rows[0]?.id;
    assert.ok(principal);

    // the catalog decides: every table with an organization is either purged or kept, with a reason
    const organizationTables = (
      await owner.pool.query<{ table_name: string }>(
        `SELECT c.relname AS table_name FROM pg_catalog.pg_class AS c
           JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
                         WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
          ORDER BY 1`
      )
    ).rows.map((row) => row.table_name);
    const classified = [
      ...PURGE_DELETE_ORDER,
      ...PURGE_CASCADED_TABLES,
      ...Object.keys(PURGE_SURVIVING_TABLES),
    ];
    assert.equal(new Set(classified).size, classified.length);
    assert.deepEqual([...classified].sort(), organizationTables);
    tests.push(
      "every table with an organization is either removed by the purge or kept with a written reason"
    );

    // the purge owner can delete exactly the purged tables and reach nothing that must survive
    const privileges = await owner.pool.query<{
      del: boolean;
      sel: boolean;
      table_name: string;
      upd: boolean;
    }>(
      `SELECT t AS table_name,
              has_table_privilege('polaris_purge_owner', 'public.' || t, 'SELECT') AS sel,
              has_table_privilege('polaris_purge_owner', 'public.' || t, 'DELETE') AS del,
              has_table_privilege('polaris_purge_owner', 'public.' || t, 'UPDATE') AS upd
         FROM unnest($1::text[]) AS t`,
      [organizationTables.concat(["privacy_cases", "privacy_case_actions"])]
    );
    for (const row of privileges.rows) {
      const deleted = (PURGE_DELETE_ORDER as readonly string[]).includes(
        row.table_name
      );
      const cascaded = (PURGE_CASCADED_TABLES as readonly string[]).includes(
        row.table_name
      );
      if (row.table_name === "organization_purges") {
        assert.deepEqual([row.sel, row.del], [true, false]);
        continue;
      }
      assert.equal(row.del, deleted, `${row.table_name} delete`);
      assert.equal(row.sel, deleted || cascaded, `${row.table_name} select`);
      assert.equal(row.upd, false, `${row.table_name} update`);
    }
    const ledgerRead = await owner.pool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('polaris_purge_owner', 'public.deletion_ledger', 'SELECT') OR has_table_privilege('polaris_purge_owner', 'public.deletion_ledger', 'DELETE') AS allowed"
    );
    assert.equal(ledgerRead.rows[0]?.allowed, false);
    const executors = await owner.pool.query<{
      fn: string;
      grantee: string;
    }>(
      `SELECT p.proname AS fn, r.rolname AS grantee
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
         JOIN pg_catalog.pg_roles AS r ON r.oid = acl.grantee
        WHERE p.proname IN ('claim_organization_purge', 'list_organization_purge_media', 'purge_organization_data',
                            'record_organization_purge_failure', 'complete_organization_purge_sweep', 'admin_schedule_organization_purge')
          AND acl.privilege_type = 'EXECUTE' AND r.rolname NOT IN ('polaris_purge_owner', 'polaris_admin_owner')
        ORDER BY 1, 2`
    );
    for (const row of executors.rows) {
      assert.equal(
        row.grantee,
        row.fn === "admin_schedule_organization_purge"
          ? "polaris_admin_runtime"
          : "polaris_privacy_runtime",
        `${row.fn} is executed only by its runtime`
      );
    }
    tests.push(
      "the purge owner deletes only the purged tables, reads nothing that survives, and only the privacy runtime runs the purge"
    );

    // two organizations: the one to purge, with a bit of everything, and a witness that must not change
    const suffix = randomUUID().slice(0, 8);
    const target = await createTenantFixture(owner.pool, `purge ${suffix}`);
    const witness = await createTenantFixture(owner.pool, `witness ${suffix}`);
    const populate = async (tenant: TenantFixture, label: string) => {
      const sellable = await createSellableProduct(gateRuntime, tenant, label, {
        cost: "5.00",
        quantity: 10,
      });
      await confirmPlainSale(gateRuntime, tenant, [
        { quantity: 2, variantId: sellable.variantId },
      ]);
      await withTenantAs(
        db,
        tenant,
        "customer:update",
        (transaction, identity) =>
          createCustomer(transaction, identity, {
            email: `cliente-${label}@example.invalid`,
            name: `Cliente ${label}`,
            notes: null,
            phone: null,
            requestId: randomUUID(),
          })
      );
      // an image linked to a product without stock that is then removed: the master under the organization's prefix
      const removable = await createProductFixture(
        db,
        tenant,
        `${label}-removido`
      );
      const client = await owner.pool.connect();
      let assetId: string;
      let storageKey: string;
      try {
        await client.query("BEGIN");
        const uploadCommandId = randomUUID();
        storageKey = `media/v2/${tenant.organizationId}/${removable.productId}/${uploadCommandId}/${"b".repeat(64)}/${randomUUID()}.webp`;
        const asset = await client.query<{ id: string }>(
          `INSERT INTO public.media_assets (byte_size, content_type, height, input_fingerprint, organization_id, storage_key, upload_command_id, width)
           VALUES (1, 'image/webp', 1, $1, $2, $3, $4, 1) RETURNING id`,
          ["b".repeat(64), tenant.organizationId, storageKey, uploadCommandId]
        );
        assetId = asset.rows[0]?.id ?? "";
        await client.query(
          "INSERT INTO public.product_media (organization_id, product_id, media_asset_id, position) VALUES ($1, $2, $3, 0)",
          [tenant.organizationId, removable.productId, assetId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      // a removed product keeps its links frozen (tombstone guard), the purge still takes them
      await owner.pool.query(
        "UPDATE public.products SET deleted_at = now(), version = version + 1 WHERE organization_id = $1 AND id = $2",
        [tenant.organizationId, removable.productId]
      );
      return { assetId, storageKey };
    };
    const targetMedia = await populate(target, `alvo-${suffix}`);
    const witnessMedia = await populate(witness, `testemunha-${suffix}`);
    tests.push(
      "both organizations hold products, stock movements, a sale, a customer and an image of a removed product"
    );

    // the storage of both, as the upload, the derivatives and an export would have left it
    const { bucket, objects } = memoryBucket();
    const bytes = new Uint8Array([1]);
    const seed = (tenant: TenantFixture, media: typeof targetMedia) => {
      objects.set(media.storageKey, bytes);
      objects.set(mediaDerivativeKey(media.assetId, 320), bytes);
      objects.set(mediaDerivativeKey(media.assetId, 640), bytes);
      objects.set(
        `media/v2/${tenant.organizationId}/orphan/${randomUUID()}.webp`,
        bytes
      );
      objects.set(
        `exports/v1/${tenant.organizationId}/${randomUUID()}/polaris-dados-2026-10-01.zip`,
        bytes
      );
    };
    seed(target, targetMedia);
    seed(witness, witnessMedia);
    const witnessKeys = [...objects.keys()].filter(
      (key) =>
        key.includes(witness.organizationId) ||
        key.includes(witnessMedia.assetId)
    );

    // a privacy case asks for it; a support case is opened too (both must survive)
    const privacyCase = await openPrivacyCase(admin, principal, {
      channel: "email",
      dueDays: 15,
      note: null,
      organizationId: target.organizationId,
      reason: "Pedido de exclusão da organização",
      receivedAt: null,
      requesterKind: "organization_owner",
      requestType: "deletion",
    });
    assert.ok(privacyCase);
    const supportCase = await openSupportCase(admin, principal, {
      context: null,
      kind: "support",
      organizationId: target.organizationId,
      reason: "Acompanhar o purge",
    });
    assert.ok(supportCase);

    // the deletion cases the schedule is tried with: the owner's request, whole scope, accepted in full
    // (the one that starts the purge), and every way a case can fall short of that
    const openDeletion = async (
      options: {
        requestType?: "access" | "deletion";
        requesterKind?: "data_subject" | "organization_owner";
      } = {}
    ) => {
      const opened = await openPrivacyCase(admin, principal, {
        channel: "email",
        dueDays: 15,
        note: null,
        organizationId: target.organizationId,
        reason: "Pedido sobre a organização",
        receivedAt: null,
        requesterKind: options.requesterKind ?? "organization_owner",
        requestType: options.requestType ?? "deletion",
      });
      assert.ok(opened);
      return opened.id;
    };
    const driveCase = async (
      caseId: string,
      steps: {
        categories?: string[];
        decision?: "accept" | "partially_accept" | "reject";
        identity?: "failed" | "verified";
        role?: "controller" | "processor";
      }
    ) => {
      const identity = steps.identity ?? "verified";
      await recordPrivacyIdentity(admin, principal, caseId, {
        method: identity === "verified" ? "owner_confirmation" : "other",
        status: identity,
      });
      await recordPrivacyRole(
        admin,
        principal,
        caseId,
        steps.role ?? "controller"
      );
      await recordPrivacyScope(admin, principal, caseId, {
        categories: steps.categories ?? [...ORGANIZATION_PURGE_REQUIRED_SCOPE],
        subjectReference: null,
      });
      if (steps.decision === "accept") {
        await recordPrivacyDecision(admin, principal, caseId, {
          decision: "accept",
          note: null,
          reason: null,
        });
      } else if (steps.decision) {
        await recordPrivacyDecision(admin, principal, caseId, {
          decision: steps.decision,
          note: null,
          reason:
            identity === "failed" ? "identity_not_verified" : "legal_retention",
        });
      }
    };
    await driveCase(privacyCase.id, { decision: "accept" });

    // an export requested while the organization was active (POL-79 probe below)
    const pendingExport = await withTenantAs(
      db,
      target,
      "organization:export",
      (transaction, identity) =>
        requestDataExport(transaction, identity, { formats: ["json"] })
    );

    const schedule = (
      caseId: string,
      organizationId: string = target.organizationId
    ) => scheduleOrganizationPurge(admin, principal, caseId, organizationId);
    const expectRefusal = async (
      caseId: string,
      code: string,
      label: string
    ) => {
      await assert.rejects(
        () => schedule(caseId),
        (error: unknown) =>
          error instanceof OrganizationPurgeRefusedError && error.code === code,
        label
      );
    };

    await expectRefusal(
      privacyCase.id,
      "organization_not_closed",
      "an active organization is not purged"
    );

    // the owner closes it; the window is moved to the past and the sweep marks it closed
    await withTenantAs(
      db,
      target,
      "organization:close",
      (transaction, identity) =>
        requestOrganizationClosure(transaction, identity, {
          confirmation: `PR43 sales gate purge ${suffix}`,
        })
    );
    await expectRefusal(
      privacyCase.id,
      "organization_not_closed",
      "an organization still in its recovery window (closing) is not purged"
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '31 days', recover_until = now() - interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    // other gates may leave closures due: only this organization must end up closed
    await maintenance.finalizeExpiredClosures(1000);
    const closed = await owner.pool.query<{ status: string }>(
      "SELECT status FROM public.organizations WHERE id = $1",
      [target.organizationId]
    );
    assert.equal(closed.rows[0]?.status, "closed");

    // POL-79: an export claimed for an organization that is no longer active produces no copy
    const exportBucket = memoryBucket();
    const exportReport = await runDataExports({
      bucket: exportBucket.bucket,
      client: maintenance,
      now: () => new Date(),
      readAsRequester: createRequesterReader(tenantUrl),
    });
    assert.equal(exportReport.ready, 0);
    assert.equal(exportBucket.objects.size, 0);
    const failedExport = await owner.pool.query<{
      error_code: string;
      files: string;
      status: string;
    }>(
      "SELECT status, error_code, (SELECT count(*)::text FROM public.data_export_files WHERE export_id = $1) AS files FROM public.data_exports WHERE id = $1",
      [pendingExport.id]
    );
    assert.deepEqual(failedExport.rows[0], {
      error_code: "export_not_authorized",
      files: "0",
      status: "failed",
    });
    // even a run that already holds the export cannot record a file for it
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'running', error_code = NULL, started_at = now(), locked_until = now() + interval '10 minutes' WHERE id = $1",
      [pendingExport.id]
    );
    await expectSqlState(
      () =>
        maintenance.recordDataExportFile({
          exportId: pendingExport.id,
          key: `exports/v1/${target.organizationId}/${pendingExport.id}/polaris-dados-2026-10-01.zip`,
          name: "polaris-dados-2026-10-01.zip",
          ordinal: 1,
          sizeBytes: 1,
        }),
      "55000",
      "record_data_export_file refuses an organization that is not active"
    );
    await assert.rejects(
      () =>
        createRequesterReader(tenantUrl)(
          {
            attempt: 1,
            formats: ["json"],
            id: pendingExport.id,
            organizationId: target.organizationId,
            requestedBy: target.userId,
          },
          () => Promise.resolve(null)
        ),
      TenantAuthorizationError
    );
    tests.push(
      "an export claimed for an organization that is no longer active reads nothing, writes nothing and records no file"
    );

    // the refusals of the schedule, each a state to change first
    await owner.pool.query(
      "UPDATE public.organization_closures SET recover_until = now() + interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "recovery_window_open",
      "the recovery window must be over"
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET recover_until = now() - interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "paid_access_running",
      "paid access still running"
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET state = 'trialing', trial_started_at = now() - interval '1 day', access_ends_at = now() + interval '6 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "paid_access_running",
      "a trial still running (it could turn into a charge)"
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() - interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    const grant = await grantTenantAccess(admin, principal, supportCase.id, 15);
    assert.ok(grant);
    await expectRefusal(
      privacyCase.id,
      "tenant_access_active",
      "a live temporary access"
    );
    await revokeTenantAccess(admin, principal, grant.id);
    await assert.rejects(
      () => schedule(randomUUID()),
      InvalidSupportRequestError,
      "an unknown case"
    );
    tests.push(
      "the schedule refuses an active or closing organization, an open window, paid access running, a live temporary access and an unknown case"
    );

    // the operator names the organization of the case, or nothing happens
    await assert.rejects(
      () => schedule(privacyCase.id, witness.organizationId),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "organization_mismatch",
      "the organization named by the operator must be the case's"
    );
    // only the deletion case of the organization's owner, accepted in full and covering the whole tenant,
    // starts a purge (ADR 0077 and 0081); a plain support case never does, whatever the organization's state
    await expectRefusal(
      supportCase.id,
      "privacy_case_required",
      "a plain support case"
    );
    await expectRefusal(
      await openDeletion({ requestType: "access" }),
      "privacy_case_not_deletion",
      "a privacy case that is not a deletion"
    );
    await expectRefusal(
      await openDeletion({ requesterKind: "data_subject" }),
      "privacy_requester_not_owner",
      "a deletion not requested by the organization's owner"
    );
    const undecided = await openDeletion();
    await expectRefusal(
      undecided,
      "privacy_case_not_accepted",
      "a deletion case still at the start"
    );
    await driveCase(undecided, {});
    await expectRefusal(
      undecided,
      "privacy_case_not_accepted",
      "a deletion case scoped but not decided"
    );
    const refusedCase = await openDeletion();
    await driveCase(refusedCase, {
      decision: "reject",
      identity: "failed",
      role: "processor",
    });
    await expectRefusal(
      refusedCase,
      "privacy_case_not_accepted",
      "a refused deletion case"
    );
    const partialDecision = await openDeletion();
    await driveCase(partialDecision, { decision: "partially_accept" });
    await expectRefusal(
      partialDecision,
      "privacy_case_not_accepted",
      "a deletion accepted only in part"
    );
    for (const missing of ORGANIZATION_PURGE_REQUIRED_SCOPE) {
      // an accepted deletion whose scope leaves one tenant category out (and adds data the purge keeps)
      // biome-ignore lint/performance/noAwaitInLoops: each case is opened and refused in turn.
      const narrow = await openDeletion();
      await driveCase(narrow, {
        categories: [
          ...ORGANIZATION_PURGE_REQUIRED_SCOPE.filter(
            (category) => category !== missing
          ),
          "account",
          "billing",
        ],
        decision: "accept",
      });
      await expectRefusal(
        narrow,
        "privacy_scope_incomplete",
        `an accepted deletion without ${missing} in its scope`
      );
    }
    tests.push(
      "the schedule refuses a plain support case, a privacy case that is not a deletion or not the owner's, a deletion that is undecided, refused or accepted only in part, and one whose scope misses any single tenant category"
    );

    // a running export holding its lease keeps the purge waiting
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'running', error_code = NULL, started_at = now(), locked_until = now() + interval '10 minutes' WHERE id = $1",
      [pendingExport.id]
    );

    const scheduled = await schedule(privacyCase.id);
    assert.equal(scheduled?.changed, true);
    assert.equal(scheduled?.status, "purge_pending");
    const again = await schedule(privacyCase.id);
    assert.deepEqual(again, { changed: false, status: "purge_pending" });
    const audit = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = 'organization.purge_scheduled'",
      [target.organizationId]
    );
    assert.equal(audit.rows[0]?.count, "1");
    tests.push(
      "an operator schedules it once, under the privacy case, and the Admin audit records it"
    );

    // nothing runs the purge before it is claimed, and the claim waits for the export's lease
    await expectSqlState(
      () => maintenance.purgeOrganizationData(target.organizationId),
      "55000",
      "the rows are not deleted without a claim"
    );
    await expectSqlState(
      () => maintenance.purgeOrganizationData(witness.organizationId),
      "55000",
      "an active organization is never purged"
    );
    await expectSqlState(
      () => maintenance.listOrganizationPurgeMedia(witness.organizationId),
      "55000",
      "nor its images listed"
    );
    const blocked = await maintenance.claimOrganizationPurge(900);
    assert.equal(blocked, null, "an export holding its lease delays the purge");
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE id = $1",
      [pendingExport.id]
    );
    await owner.pool.query(
      "UPDATE public.organization_purges SET not_before = now() + interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.equal(
      await maintenance.claimOrganizationPurge(900),
      null,
      "a purge is not taken before its time"
    );
    await owner.pool.query(
      "UPDATE public.organization_purges SET not_before = now() WHERE organization_id = $1",
      [target.organizationId]
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE id = $1",
      [pendingExport.id]
    );
    tests.push(
      "the rows are never deleted without a claim, and an export holding its lease delays the purge"
    );

    const counts = async (tenant: TenantFixture) => {
      const result: Record<string, number> = {};
      for (const table of [...PURGE_DELETE_ORDER, ...PURGE_CASCADED_TABLES]) {
        // biome-ignore lint/performance/noAwaitInLoops: a handful of counts, one table at a time.
        const row = await owner.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.${table} WHERE organization_id = $1`,
          [tenant.organizationId]
        );
        result[table] = Number(row.rows[0]?.count);
      }
      return result;
    };
    const witnessBefore = await counts(witness);
    const targetBefore = await counts(target);
    for (const table of [
      "sales",
      "sale_items",
      "stock_movements",
      "products",
      "product_variants",
      "product_media",
      "media_assets",
      "customers",
      "memberships",
      "tenant_audit_event",
      "data_exports",
      "event_outbox",
    ]) {
      assert.ok(
        (targetBefore[table] ?? 0) > 0,
        `the organization to purge has ${table}`
      );
    }

    // the way back: only while no run holds the purge, with a reason, audited, and the purge can be scheduled again
    const cancel = (
      caseId: string,
      reason: string,
      organizationId: string = target.organizationId
    ) =>
      cancelOrganizationPurge(admin, principal, caseId, organizationId, reason);
    const purgeState = async () =>
      (
        await owner.pool.query<{
          cancelled: boolean;
          reason: string | null;
          status: string;
        }>(
          `SELECT o.status, p.cancelled_at IS NOT NULL AS cancelled, p.cancel_reason AS reason
             FROM public.organizations AS o JOIN public.organization_purges AS p ON p.organization_id = o.id
            WHERE o.id = $1`,
          [target.organizationId]
        )
      ).rows[0];
    const auditCount = async (eventType: string) =>
      (
        await owner.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = $2",
          [target.organizationId, eventType]
        )
      ).rows[0]?.count;
    await assert.rejects(
      () => cancel(privacyCase.id, "   "),
      InvalidSupportRequestError,
      "a reason is required"
    );
    await assert.rejects(
      () => cancel(privacyCase.id, "linha\nquebrada"),
      InvalidSupportRequestError,
      "a reason without control characters"
    );
    await assert.rejects(
      () => cancel(privacyCase.id, "x".repeat(501)),
      InvalidSupportRequestError,
      "a reason of at most 500 characters"
    );
    await assert.rejects(
      () => cancel(privacyCase.id, "Motivo", witness.organizationId),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "organization_mismatch",
      "the organization named must be the case's"
    );
    await assert.rejects(
      () => cancel(randomUUID(), "Motivo"),
      InvalidSupportRequestError,
      "an unknown case"
    );
    assert.equal((await purgeState())?.status, "purge_pending");
    // a run holds the purge: nothing is undone
    const held = await maintenance.claimOrganizationPurge(900);
    assert.deepEqual(held, {
      attempt: 1,
      organizationId: target.organizationId,
      phase: "purge",
    });
    await assert.rejects(
      () => cancel(privacyCase.id, "Motivo"),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "purge_in_progress",
      "a purge held by a run cannot be cancelled"
    );
    assert.deepEqual(await purgeState(), {
      cancelled: false,
      reason: null,
      status: "purge_pending",
    });
    assert.equal(await auditCount("organization.purge_cancelled"), "0");
    // the lease ends (the run died): any open case of the organization can cancel, a plain support case too
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() - interval '1 second' WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.deepEqual(
      await cancel(supportCase.id, "  Pedido retirado pelo dono  "),
      {
        changed: true,
        status: "closed",
      }
    );
    assert.deepEqual(await purgeState(), {
      cancelled: true,
      reason: "Pedido retirado pelo dono",
      status: "closed",
    });
    const cancelAudit = await owner.pool.query<{
      detail: string | null;
      principal_id: string;
      support_case_id: string;
    }>(
      "SELECT principal_id, support_case_id, detail FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = 'organization.purge_cancelled'",
      [target.organizationId]
    );
    assert.deepEqual(cancelAudit.rows, [
      {
        detail: null,
        principal_id: principal,
        support_case_id: supportCase.id,
      },
    ]);
    const reasonInAudit = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE to_jsonb(platform_audit_events)::text LIKE '%retirado pelo dono%'"
    );
    assert.equal(
      reasonInAudit.rows[0]?.count,
      "0",
      "the reason stays out of the audit"
    );
    // closed again: nothing to claim, nothing to purge, nothing more to cancel
    assert.equal(await maintenance.claimOrganizationPurge(900), null);
    await expectSqlState(
      () => maintenance.purgeOrganizationData(target.organizationId),
      "55000",
      "a cancelled purge deletes nothing"
    );
    await assert.rejects(
      () => cancel(privacyCase.id, "De novo"),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "purge_not_scheduled",
      "a purge that is not scheduled has nothing to cancel"
    );
    const stillThere = await counts(target);
    assert.ok(Number(stillThere.sales) > 0, "cancelling deletes nothing");
    // an organization still active has no purge to cancel either
    await assert.rejects(
      () => cancel(privacyCase.id, "Motivo", witness.organizationId),
      OrganizationPurgeRefusedError
    );
    // scheduled again under the deletion case: the record starts from nothing and the audit shows both
    assert.deepEqual(
      { changed: (await schedule(privacyCase.id))?.changed },
      { changed: true }
    );
    assert.deepEqual(await purgeState(), {
      cancelled: false,
      reason: null,
      status: "purge_pending",
    });
    assert.equal(await auditCount("organization.purge_scheduled"), "2");
    assert.equal(await auditCount("organization.purge_cancelled"), "1");
    tests.push(
      "a scheduled purge is cancelled only with a reason and while no run holds it: the organization goes back to closed, the audit records it without the reason, nothing is deleted, and it can be scheduled again"
    );

    // the purge owner writes one audit event only: the completion, once the organization is purged
    const asPurgeOwner = async (statement: string, values: unknown[] = []) => {
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE polaris_purge_owner");
        return await client.query(statement, values);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };
    const insertAudit = (eventType: string, organizationId: string) =>
      asPurgeOwner(
        `INSERT INTO public.platform_audit_events (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id)
         VALUES ($1, $2, $3, $4, 'organization', $3)`,
        [principal, eventType, organizationId, privacyCase.id]
      );
    await expectSqlState(
      () => insertAudit("organization.purge_completed", target.organizationId),
      "42501",
      "the completion is not written before the organization is purged"
    );
    await expectSqlState(
      () => insertAudit("organization.purge_completed", witness.organizationId),
      "42501",
      "nor for an active organization"
    );
    await expectSqlState(
      () => insertAudit("organization.purge_scheduled", target.organizationId),
      "42501",
      "no other event type"
    );
    for (const statement of [
      "SELECT 1 FROM public.platform_audit_events",
      "DELETE FROM public.platform_audit_events",
      "UPDATE public.platform_audit_events SET detail = 'x'",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: a few probes, in order.
      await expectSqlState(
        () => asPurgeOwner(statement),
        "42501",
        `the purge owner cannot run: ${statement}`
      );
    }
    tests.push(
      "the purge owner can write only the completion event, and only for an organization that is purged; it cannot read, change or delete the audit"
    );

    const purgeReport = await runOrganizationPurges({
      bucket,
      client: maintenance,
      now: () => new Date(),
    });
    assert.deepEqual(purgeReport, { failed: 0, purged: 1, swept: 1 });

    const leftInStorage = [...objects.keys()].filter(
      (key) =>
        key.startsWith(`exports/v1/${target.organizationId}/`) ||
        key.startsWith(`media/v2/${target.organizationId}/`) ||
        key.includes(targetMedia.assetId)
    );
    assert.deepEqual(leftInStorage, []);
    for (const key of witnessKeys) {
      assert.ok(objects.has(key), "the witness keeps its objects");
    }
    tests.push(
      "no object is left under the organization's export and image prefixes, nor any derivative of its images; another organization keeps its objects"
    );

    const targetAfter = await counts(target);
    for (const [table, count] of Object.entries(targetAfter)) {
      assert.equal(count, 0, `${table} is empty for the purged organization`);
    }
    assert.deepEqual(await counts(witness), witnessBefore);
    tests.push(
      "every row of the tenant is gone, from sales and stock movements to the audit and the memberships; the witness is untouched"
    );

    const tombstoneRow = await owner.pool.query<{
      name: string;
      status: string;
    }>("SELECT name, status FROM public.organizations WHERE id = $1", [
      target.organizationId,
    ]);
    assert.deepEqual(tombstoneRow.rows[0], {
      name: REMOVED_NAME,
      status: "purged",
    });
    const ledger = await owner.pool.query<{
      entity_id: string;
      entity_type: string;
      operation: string;
      privacy_case_id: string | null;
    }>(
      "SELECT entity_type, entity_id, operation, privacy_case_id FROM public.deletion_ledger WHERE organization_id = $1 AND entity_type = 'organization'",
      [target.organizationId]
    );
    assert.deepEqual(ledger.rows, [
      {
        entity_id: target.organizationId,
        entity_type: "organization",
        operation: "purge",
        privacy_case_id: privacyCase.id,
      },
    ]);
    tests.push(
      "the organization's row stays as a tombstone without its name, and the deletion ledger holds the purge with the privacy case"
    );

    const survivors = await owner.pool.query<{
      audit: string;
      billing: string;
      cases: string;
      privacy: string;
    }>(
      `SELECT (SELECT count(*)::text FROM public.support_cases WHERE organization_id = $1) AS cases,
              (SELECT count(*)::text FROM public.privacy_cases WHERE support_case_id = $2) AS privacy,
              (SELECT count(*)::text FROM public.platform_audit_events WHERE organization_id = $1) AS audit,
              (SELECT count(*)::text FROM public.organization_billing WHERE organization_id = $1) AS billing`,
      [target.organizationId, privacyCase.id]
    );
    const [survivor] = survivors.rows;
    assert.equal(survivor?.cases, "3");
    assert.equal(survivor?.privacy, "1");
    assert.ok(Number(survivor?.audit) >= 4);
    assert.equal(survivor?.billing, "1");
    tests.push(
      "the support and privacy cases, the Admin audit and the billing record survive the organization"
    );

    // the completion is audited in the same transaction, with the IDs only
    const completionEvents = async () =>
      (
        await owner.pool.query<{
          detail: string | null;
          entity_id: string;
          entity_type: string;
          principal_id: string;
          support_case_id: string;
        }>(
          "SELECT principal_id, support_case_id, entity_type, entity_id, detail FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = 'organization.purge_completed'",
          [target.organizationId]
        )
      ).rows;
    assert.deepEqual(await completionEvents(), [
      {
        detail: null,
        entity_id: target.organizationId,
        entity_type: "organization",
        principal_id: principal,
        support_case_id: privacyCase.id,
      },
    ]);
    // a purge that was carried out cannot be cancelled
    await assert.rejects(
      () => cancel(privacyCase.id, "Tarde demais"),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "purge_already_done",
      "a purged organization has nothing to cancel"
    );
    tests.push(
      "the completion of the purge is audited once, with the organization and the case and no personal data, and a purge already done cannot be cancelled"
    );

    // running it again changes nothing
    const purgeRecord = await owner.pool.query<{
      purged: boolean;
      swept: boolean;
    }>(
      "SELECT purged_at IS NOT NULL AS purged, swept_at IS NOT NULL AS swept FROM public.organization_purges WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.deepEqual(purgeRecord.rows[0], { purged: true, swept: true });
    assert.deepEqual(
      await runOrganizationPurges({
        bucket,
        client: maintenance,
        now: () => new Date(),
      }),
      { failed: 0, purged: 0, swept: 0 }
    );
    assert.deepEqual(
      await maintenance.purgeOrganizationData(target.organizationId),
      { alreadyPurged: true, deletedRows: 0 }
    );
    assert.deepEqual(await schedule(privacyCase.id), {
      changed: false,
      status: "purged",
    });
    assert.equal((await completionEvents()).length, 1);
    tests.push(
      "running the purge again, calling its last step again or scheduling it again changes nothing"
    );

    // a restore brings the organization back: the runbook's check shows it, its reapplication purges it again
    const restoreCheck = `SELECT l.entity_id FROM public.deletion_ledger AS l
       JOIN public.organizations AS o ON o.id = l.entity_id
      WHERE l.entity_type = 'organization' AND l.operation = 'purge'
        AND o.status <> 'purged' AND l.organization_id = $1`;
    assert.deepEqual(
      (await owner.pool.query(restoreCheck, [target.organizationId])).rows,
      []
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'closed' WHERE id = $1",
      [target.organizationId]
    );
    assert.equal(
      (await owner.pool.query(restoreCheck, [target.organizationId])).rowCount,
      1
    );
    const restoreClient = await owner.pool.connect();
    try {
      await restoreClient.query("BEGIN");
      await restoreClient.query(
        "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1 AND status <> 'purged'",
        [target.organizationId]
      );
      await restoreClient.query(
        `INSERT INTO public.organization_purges (organization_id, scheduled_by, support_case_id, privacy_case_id, not_before)
       VALUES ($1, $2, $3, $3, now())
       ON CONFLICT (organization_id) DO UPDATE
          SET not_before = now(), attempts = 0, locked_until = NULL,
              last_error_code = NULL, purged_at = NULL, swept_at = NULL,
              cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL`,
        [target.organizationId, principal, privacyCase.id]
      );
      await restoreClient.query("COMMIT");
    } catch (error) {
      await restoreClient.query("ROLLBACK");
      throw error;
    } finally {
      restoreClient.release();
    }
    assert.deepEqual(
      await runOrganizationPurges({
        bucket,
        client: maintenance,
        now: () => new Date(),
      }),
      { failed: 0, purged: 1, swept: 1 }
    );
    assert.deepEqual(
      (await owner.pool.query(restoreCheck, [target.organizationId])).rows,
      []
    );
    const ledgerAfterRestore = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.deletion_ledger WHERE organization_id = $1 AND entity_type = 'organization'",
      [target.organizationId]
    );
    assert.equal(ledgerAfterRestore.rows[0]?.count, "1");
    assert.equal(
      (await completionEvents()).length,
      2,
      "the reapplied purge is audited again"
    );
    tests.push(
      "after a restore brings the organization back, the runbook's check shows it and its reapplication purges it again, with one tombstone"
    );

    // the append-only rules hold for everyone else
    await expectSqlState(
      () =>
        owner.pool.query(
          "DELETE FROM public.stock_movements WHERE organization_id = $1",
          [witness.organizationId]
        ),
      "23514",
      "stock movements stay append-only outside the purge",
      "stock_movements_append_only"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "DELETE FROM public.product_media WHERE organization_id = $1",
          [witness.organizationId]
        ),
      "23514",
      "the links of a removed product stay frozen outside the purge",
      "media_product_tombstone_guard"
    );
    tests.push(
      "outside the purge, stock movements stay append-only and the links of a removed product stay frozen"
    );

    console.log(JSON.stringify({ gate: "organization-purge", tests }, null, 2));
  } finally {
    await privacy?.close().catch(() => undefined);
    await adminDatabase?.pool.end().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    for (const [role, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: each login is dropped after its sessions end.
      await owner.pool
        .query(`REVOKE "${group}" FROM "${role}"`)
        .catch(() => undefined);
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${role}"`)
        .catch(() => undefined);
    }
    await owner.pool.end().catch(() => undefined);
  }
}

run().catch((error: unknown) => {
  console.error(redactedFailure(error));
  process.exitCode = 1;
});
