// biome-ignore-all lint/performance/noAwaitInLoops: Probes and pages, in order.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  DataExportUnavailableError,
  InvalidExportRequestError,
} from "@polaris/domain/privacy/data-export";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import {
  getDataExportDownload,
  listDataExports,
  requestDataExport,
} from "../src/data-export-repository";
import {
  EXPORT_DATASETS,
  EXPORT_EXCLUDED_TABLES,
} from "../src/export-datasets";
import {
  describeDataset,
  listOrganizationTables,
  readDatasetPage,
} from "../src/export-reader";
import { createPrivacyMaintenanceClient } from "../src/privacy-maintenance";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  createProductFixture,
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
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The data export on a real PostgreSQL 18 (plan PR104, ADR 0078): the owner asks, one at a time and at most
 * three a day; only the privacy role's functions move a request along (claim, record, finish, fail, expire),
 * a run that dies is taken again and a finished export is not downloadable once it has expired; the tables
 * the export reads are exactly the organization's own (every table with an organization_id is either
 * exported or left out on purpose), read under row-level security, so one organization's export holds
 * nothing of another's; and no role reaches the requests or the functions it should not.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SERVICE_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
  "polaris_outbox_runtime",
];
const EXPORT_FUNCTIONS = [
  "public.claim_data_export(integer)",
  "public.record_data_export_file(uuid,integer,text,text,bigint)",
  "public.complete_data_export(uuid,integer)",
  "public.fail_data_export(uuid,text,boolean)",
  "public.expire_data_exports(integer,integer)",
  "public.list_data_exports_to_delete(integer)",
  "public.mark_data_export_files_deleted(uuid)",
  "public.claim_data_export_by_id(uuid,text,integer)",
  "public.rearm_data_export_events(integer,integer)",
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
  let privacy: ReturnType<typeof createPrivacyMaintenanceClient> | undefined;

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

    // a claim takes the oldest waiting request of the whole database: a rerun on the same database must not meet the last run's
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE status IN ('requested', 'running')"
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
    const tenantUrl = await login(runtimeRole, "polaris_exp_tenant");
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_exp_priv"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const runtimeDb = runtime.db;
    privacy = createPrivacyMaintenanceClient(privacyUrl);
    const maintenance = privacy;

    const suffix = randomUUID().slice(0, 8);
    const fixture = (label: string) =>
      createTenantFixture(
        owner.pool,
        `exp ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
    const asExporter = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3],
      capability = "organization:export"
    ) => withTenantAs(runtimeDb, tenant, capability, operation);
    const ask = (tenant: TenantFixture, formats: unknown = ["json"]) =>
      asExporter(tenant, (transaction, identity) =>
        requestDataExport(transaction, identity, {
          formats,
          requestId: randomUUID(),
        })
      );
    const row = async (id: string) =>
      (
        await owner.pool.query(
          "SELECT status, attempts, error_code, locked_until IS NOT NULL AS locked, expires_at, total_bytes, files_deleted_at IS NOT NULL AS files_deleted FROM public.data_exports WHERE id = $1",
          [id]
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
    // a claim picks the oldest waiting request of the whole database: the gate keeps one in flight at a time
    const claimThis = async (id: string) => {
      const claimed = await maintenance.claimDataExport(600);
      assert.ok(claimed, "something was waiting");
      assert.equal(claimed.id, id);
      return claimed;
    };
    const finish = async (id: string, tenant: TenantFixture, size = 10) => {
      await maintenance.recordDataExportFile({
        exportId: id,
        key: `exports/v1/${tenant.organizationId}/${id}/polaris-dados-2026-10-17.zip`,
        name: "polaris-dados-2026-10-17.zip",
        ordinal: 1,
        sizeBytes: size,
      });
      return maintenance.completeDataExport(id, 24);
    };

    const orgA = await fixture("A");
    const orgB = await fixture("B");

    // ------------------------------------------------- 1. asking
    await assert.rejects(
      () => ask(orgA, []),
      InvalidExportRequestError,
      "no format is refused"
    );
    await assert.rejects(
      () => ask(orgA, ["json", "pdf"]),
      InvalidExportRequestError,
      "an unknown format is refused"
    );
    await ask(orgA, ["json"]);
    const [first] = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.data_exports WHERE organization_id = $1",
        [orgA.organizationId]
      )
    ).rows;
    assert.ok(first, "the owner's request was recorded");
    const requested = await row(first.id);
    assert.equal(requested.status, "requested");
    assert.equal(requested.attempts, 0);
    assert.equal(
      await auditCount(orgA.organizationId, "data_export.requested"),
      1
    );
    const recordedBy = await owner.pool.query<{
      requested_by_user_id: string;
      formats: string[];
    }>(
      "SELECT requested_by_user_id, formats FROM public.data_exports WHERE id = $1",
      [first.id]
    );
    assert.equal(recordedBy.rows[0]?.requested_by_user_id, orgA.userId);
    assert.deepEqual(recordedBy.rows[0]?.formats, ["json"]);
    await assert.rejects(
      () =>
        asExporter(
          orgA,
          (transaction, identity) =>
            requestDataExport(transaction, identity, { formats: ["json"] }),
          "catalog:read"
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied",
      "asking needs its own capability"
    );
    await assert.rejects(
      () => ask(orgA, ["csv"]),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "export_already_running",
      "one export at a time"
    );
    const forB = await ask(orgB, ["json", "csv", "images"]);
    assert.ok(forB.id, "another organization is not held up by it");
    tests.push(
      "the owner asks with the export capability only, one request at a time per organization (another organization is independent), the request records who asked and the formats, and is audited"
    );

    // ------------------------------------------------- 2. the tenant role's reach
    const nowRow = async (sql: string, params: unknown[] = []) =>
      withRuntimeSqlContext(tenantUrl, orgA, (client) =>
        client.query(sql, params)
      );
    await expectSqlState(
      () =>
        nowRow(
          "UPDATE public.data_exports SET status = 'ready' WHERE id = $1",
          [first.id]
        ),
      "42501",
      "the tenant cannot move a request along"
    );
    await expectSqlState(
      () => nowRow("DELETE FROM public.data_exports WHERE id = $1", [first.id]),
      "42501",
      "the tenant cannot delete a request"
    );
    await expectSqlState(
      () =>
        nowRow(
          "INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats, status) VALUES ($1, $2, ARRAY['json'], 'ready')",
          [orgA.organizationId, orgA.userId]
        ),
      "42501",
      "the tenant cannot insert a request in another state"
    );
    await expectSqlState(
      () =>
        nowRow(
          "INSERT INTO public.data_export_files (export_id, organization_id, ordinal, name, storage_key, size_bytes) VALUES ($1, $2, 9, 'polaris-dados-2026-10-17.zip', $3, 1)",
          [
            first.id,
            orgA.organizationId,
            `exports/v1/${orgA.organizationId}/${first.id}/x.zip`,
          ]
        ),
      "42501",
      "the tenant cannot write files"
    );
    await expectSqlState(
      () =>
        nowRow(
          "INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats) VALUES ($1, 'someone-else', ARRAY['json'])",
          [orgA.organizationId]
        ),
      "42501",
      "a request is recorded as the one who asks, never as another"
    );
    await expectSqlState(
      () =>
        nowRow(
          "INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats) VALUES ($1, $2, ARRAY['json'])",
          [orgB.organizationId, orgA.userId]
        ),
      "42501",
      "a request for another organization is refused"
    );
    const seenByA = await nowRow("SELECT id FROM public.data_exports");
    assert.deepEqual(
      seenByA.rows.map((r) => r.id),
      [first.id],
      "an organization sees only its own requests"
    );
    tests.push(
      "the tenant role can only read its own requests and insert one as itself (no update, no delete, no other state, no other organization, no files)"
    );

    // ------------------------------------------------- 3. the lifecycle, by the privacy role's functions
    // orgB's request is the older one? No: orgA's is. The claim takes the oldest waiting request.
    const claimedA = await claimThis(first.id);
    assert.equal(claimedA.organizationId, orgA.organizationId);
    assert.equal(claimedA.requestedBy, orgA.userId);
    assert.deepEqual(claimedA.formats, ["json"]);
    assert.equal(claimedA.attempt, 1);
    const running = await row(first.id);
    assert.equal(running.status, "running");
    assert.equal(running.attempts, 1);
    assert.equal(running.locked, true);
    const claimedB = await claimThis(forB.id);
    assert.equal(claimedB.organizationId, orgB.organizationId);
    assert.equal(
      await maintenance.claimDataExport(600),
      null,
      "a run that holds a request is not taken by another"
    );
    await expectSqlState(
      () => maintenance.claimDataExport(5),
      "22023",
      "a lease outside the allowed range is refused"
    );
    // a run that stopped: its lease passes and the request is taken again
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() - interval '1 minute' WHERE id = $1",
      [forB.id]
    );
    await maintenance.recordDataExportFile({
      exportId: forB.id,
      key: `exports/v1/${orgB.organizationId}/${forB.id}/polaris-dados-2026-10-16.zip`,
      name: "polaris-dados-2026-10-16.zip",
      ordinal: 1,
      sizeBytes: 5,
    });
    const retakenB = await claimThis(forB.id);
    assert.equal(retakenB.attempt, 2);
    assert.equal(
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.data_export_files WHERE export_id = $1",
            [forB.id]
          )
        ).rows[0]?.count
      ),
      0,
      "what the run before left is not kept"
    );
    // a failure that can be tried again goes back to waiting, with its reason
    assert.equal(
      await maintenance.failDataExport(forB.id, "export_failed", false),
      false
    );
    const waiting = await row(forB.id);
    assert.equal(waiting.status, "requested");
    assert.equal(waiting.attempts, 2);
    assert.equal(waiting.error_code, "export_failed");
    // it waits before it is tried again (an hour after the second failure, ADR 0084): no claim takes it
    // meanwhile, so a burst of runs cannot use its attempts in seconds
    assert.equal(waiting.locked, true);
    const delay = await owner.pool.query<{ minutes: number }>(
      "SELECT round(extract(epoch FROM locked_until - now()) / 60)::integer AS minutes FROM public.data_exports WHERE id = $1",
      [forB.id]
    );
    assert.equal(delay.rows[0]?.minutes, 60);
    assert.equal(
      await maintenance.claimDataExport(600),
      null,
      "a failed run is not taken again before its delay"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() - interval '1 second' WHERE id = $1",
      [forB.id]
    );
    // a final failure, or one with no attempts left, ends it
    await claimThis(forB.id);
    assert.equal(
      await maintenance.failDataExport(forB.id, "export_failed", false),
      true,
      "the third attempt is the last"
    );
    assert.equal((await row(forB.id)).status, "failed");
    assert.equal(
      await auditCount(orgB.organizationId, "data_export.failed"),
      1
    );
    await expectSqlState(
      () => maintenance.failDataExport(forB.id, "export_failed", true),
      "22023",
      "a request that is not running cannot fail again"
    );
    await expectSqlState(
      () => maintenance.failDataExport(first.id, "Not Valid!", true),
      "22023",
      "the reason is a code, not text"
    );
    await expectSqlState(
      () => maintenance.completeDataExport(first.id, 24),
      "22023",
      "an export with no file cannot be finished"
    );
    await expectSqlState(
      () => maintenance.completeDataExport(first.id, 0),
      "22023",
      "the validity is bounded"
    );
    await expectSqlState(
      () =>
        maintenance.recordDataExportFile({
          exportId: first.id,
          key: "elsewhere/polaris.zip",
          name: "polaris-dados-2026-10-17.zip",
          ordinal: 1,
          sizeBytes: 5,
        }),
      "23514",
      "a file key outside the export's own place is refused"
    );
    const done = await finish(first.id, orgA, 123);
    assert.equal(done.totalBytes, 123);
    const readyRow = await row(first.id);
    assert.equal(readyRow.status, "ready");
    assert.equal(readyRow.locked, false);
    const hours = (done.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 23.5 && hours <= 24.01, "ready for a day");
    assert.equal(await auditCount(orgA.organizationId, "data_export.ready"), 1);
    await expectSqlState(
      () => maintenance.completeDataExport(first.id, 24),
      "22023",
      "a finished export is not finished twice"
    );
    tests.push(
      "claim takes the oldest waiting request and holds it (not taken by another run until the lease passes, and the files an earlier run left are cleared), a failure goes back to waiting until the third attempt ends it, finishing needs a file and is audited, and the functions refuse a request in the wrong state, a bad code, a bad validity and a key outside the export's own place"
    );

    // ------------------------------------------------- 4. the daily limit
    await ask(orgA, ["csv"]);
    const secondId = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.data_exports WHERE organization_id = $1 AND status = 'requested'",
        [orgA.organizationId]
      )
    ).rows[0]?.id;
    assert.ok(secondId, "the second request was accepted");
    await claimThis(secondId);
    await maintenance.failDataExport(secondId, "export_too_large", true);
    const thirdId = (await ask(orgA, ["images"])).id;
    await claimThis(thirdId);
    await maintenance.failDataExport(thirdId, "export_too_large", true);
    await assert.rejects(
      () => ask(orgA, ["json"]),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "export_limit_reached",
      "at most three a day"
    );
    await expectSqlState(
      () =>
        nowRow(
          "INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats) VALUES ($1, $2, ARRAY['json'])",
          [orgA.organizationId, orgA.userId]
        ),
      "23514",
      "the limit is the database's, not only the repository's",
      "data_exports_daily_limit"
    );
    // a day later the count starts again
    await owner.pool.query(
      "UPDATE public.data_exports SET requested_at = now() - interval '25 hours' WHERE organization_id = $1 AND id = $2",
      [orgA.organizationId, secondId]
    );
    assert.ok((await ask(orgA, ["json"])).id, "the window moves with time");
    tests.push(
      "a fourth request in 24 hours is refused with its own reason, by the database too, and a request older than a day no longer counts"
    );

    // ------------------------------------------------- 5. downloading
    const download = (
      tenant: TenantFixture,
      exportId: string,
      ordinal = 1,
      capability = "organization:export"
    ) =>
      asExporter(
        tenant,
        (transaction, identity) =>
          getDataExportDownload(transaction, identity, {
            exportId,
            ordinal,
            requestId: randomUUID(),
          }),
        capability
      );
    const got = await download(orgA, first.id);
    assert.equal(got.name, "polaris-dados-2026-10-17.zip");
    assert.equal(got.sizeBytes, 123);
    assert.equal(
      got.storageKey,
      `exports/v1/${orgA.organizationId}/${first.id}/polaris-dados-2026-10-17.zip`
    );
    assert.equal(
      await auditCount(orgA.organizationId, "data_export.downloaded"),
      1
    );
    await assert.rejects(
      () => download(orgB, first.id),
      DataExportUnavailableError,
      "another organization cannot download it"
    );
    await assert.rejects(
      () => download(orgA, first.id, 2),
      DataExportUnavailableError,
      "a file that does not exist"
    );
    await assert.rejects(
      () => download(orgA, secondId),
      DataExportUnavailableError,
      "a request that failed has nothing to download"
    );
    await assert.rejects(
      () => download(orgA, first.id, 1, "catalog:read"),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied",
      "downloading needs its own capability"
    );
    assert.equal(
      await auditCount(orgA.organizationId, "data_export.downloaded"),
      1,
      "only a download that was handed over is audited"
    );
    const listed = await asExporter(orgA, (transaction, identity) =>
      listDataExports(transaction, identity)
    );
    const listedFirst = listed.find((item) => item.id === first.id);
    assert.equal(listedFirst?.status, "ready");
    assert.deepEqual(listedFirst?.files, [
      { name: "polaris-dados-2026-10-17.zip", ordinal: 1, sizeBytes: 123 },
    ]);
    assert.ok(
      listed.every((item) => !JSON.stringify(item).includes("exports/v1")),
      "the list never shows where a file is kept"
    );
    // time passes: it is not downloadable even before the sweep marks it
    await owner.pool.query(
      "UPDATE public.data_exports SET ready_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE id = $1",
      [first.id]
    );
    await assert.rejects(
      () => download(orgA, first.id),
      DataExportUnavailableError,
      "an expired export is not downloadable"
    );
    const afterExpiry = (
      await asExporter(orgA, (transaction, identity) =>
        listDataExports(transaction, identity)
      )
    ).find((item) => item.id === first.id);
    assert.equal(afterExpiry?.status, "expired");
    assert.deepEqual(afterExpiry?.files, []);
    tests.push(
      "a ready export downloads only for its own organization and with the capability, the download is audited, the list shows no storage keys, and an export past its time is neither downloadable nor listed as ready, even before the sweep"
    );

    // ------------------------------------------------- 6. time
    const expired = await maintenance.expireDataExports(24, 100);
    assert.ok(expired >= 1);
    assert.equal((await row(first.id)).status, "expired");
    assert.deepEqual(
      (await maintenance.listDataExportsToDelete(100)).filter(
        (item) => item.id === first.id
      ),
      [{ id: first.id, organizationId: orgA.organizationId }]
    );
    assert.equal(await maintenance.markDataExportFilesDeleted(first.id), true);
    assert.equal((await row(first.id)).files_deleted, true);
    assert.equal(
      await maintenance.markDataExportFilesDeleted(first.id),
      false,
      "marked once"
    );
    assert.equal(
      (await maintenance.listDataExportsToDelete(100)).some(
        (item) => item.id === first.id
      ),
      false
    );
    assert.equal(
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.data_export_files WHERE export_id = $1",
            [first.id]
          )
        ).rows[0]?.count
      ),
      0,
      "the file records go with the files"
    );
    // a run abandoned with every attempt used becomes a failure
    const lastId = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.data_exports WHERE organization_id = $1 AND status = 'requested'",
        [orgA.organizationId]
      )
    ).rows[0]?.id;
    assert.ok(lastId);
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'running', attempts = 3, started_at = now() - interval '2 hours', locked_until = now() - interval '1 hour' WHERE id = $1",
      [lastId]
    );
    await maintenance.expireDataExports(24, 100);
    const abandoned = await row(lastId);
    assert.equal(abandoned.status, "failed");
    assert.equal(abandoned.error_code, "export_abandoned");
    // a failed export is dropped after its keeping time
    await owner.pool.query(
      "UPDATE public.data_exports SET requested_at = now() - interval '26 hours' WHERE id = $1",
      [lastId]
    );
    await maintenance.expireDataExports(24, 100);
    assert.equal((await row(lastId)).status, "expired");
    await expectSqlState(
      () => maintenance.expireDataExports(0, 100),
      "22023",
      "the keeping time is bounded"
    );
    tests.push(
      "the sweep expires finished exports at their time, fails an abandoned run, drops a failed export after its keeping time, lists the ones whose files must go and marks them once, and removes the file records"
    );

    // ------------------------------------------------- 7. what the export reads
    const productA = await createProductFixture(runtimeDb, orgA, "A");
    const productB = await createProductFixture(runtimeDb, orgB, "B");
    await asExporter(
      orgA,
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: `cliente-${suffix}@example.invalid`,
          name: "Cliente do export",
          requestId: randomUUID(),
        }),
      "customer:update"
    );
    const tables = await asExporter(orgA, (transaction) =>
      listOrganizationTables(transaction)
    );
    const exported = new Set(EXPORT_DATASETS.map((dataset) => dataset.table));
    const excluded = new Set(Object.keys(EXPORT_EXCLUDED_TABLES));
    const unaccounted = tables.filter(
      (table) => !(exported.has(table) || excluded.has(table))
    );
    assert.deepEqual(
      unaccounted,
      [],
      "every table with an organization_id is exported or left out on purpose"
    );
    assert.deepEqual(
      [...excluded].filter((table) => !tables.includes(table)),
      [],
      "every left-out table exists and has an organization_id (a stale entry is a table that was renamed or dropped)"
    );
    assert.deepEqual(
      [...excluded].filter((table) => exported.has(table)),
      [],
      "no table is both exported and left out"
    );
    assert.deepEqual(
      [...exported].filter(
        (table) => !(tables.includes(table) || table === "organizations")
      ),
      [],
      "every exported table exists and has an organization_id"
    );
    const readAll = async (tenant: TenantFixture, organizationId: string) =>
      asExporter(tenant, async (transaction) => {
        const out = new Map<string, Record<string, unknown>[]>();
        for (const dataset of EXPORT_DATASETS) {
          const shape = await describeDataset(transaction, dataset);
          for (const omitted of dataset.omit ?? []) {
            assert.equal(
              shape.columns.includes(omitted),
              false,
              `${dataset.table}.${omitted} is left out`
            );
          }
          const rows: Record<string, unknown>[] = [];
          let after: unknown[] | null = null;
          do {
            // pages of two, so the keyset is exercised on every table with more than two rows
            const page: Awaited<ReturnType<typeof readDatasetPage>> =
              await readDatasetPage(
                transaction,
                organizationId,
                dataset,
                shape,
                after,
                2
              );
            rows.push(...page.rows);
            after = page.next;
          } while (after !== null);
          out.set(dataset.table, rows);
        }
        return out;
      });
    const dataA = await readAll(orgA, orgA.organizationId);
    const productsOfA = dataA.get("products") ?? [];
    assert.deepEqual(
      productsOfA.map((product) => product.id),
      [productA.productId],
      "the export holds the organization's own product"
    );
    assert.equal(dataA.get("organizations")?.length, 1);
    assert.match(
      String(dataA.get("organizations")?.[0]?.created_at),
      ISO_INSTANT,
      "an instant is written as ISO 8601 in UTC, whatever the session's time zone"
    );
    assert.equal(dataA.get("organizations")?.[0]?.id, orgA.organizationId);
    assert.equal(dataA.get("customers")?.length, 1);
    assert.equal(
      JSON.stringify([...dataA.values()]).includes(productB.productId),
      false,
      "nothing of another organization is in it"
    );
    // pages cover a table without gaps or repeats
    const variantsA = dataA.get("product_variants") ?? [];
    assert.equal(
      new Set(variantsA.map((variant) => variant.id)).size,
      variantsA.length
    );
    // an export asked for another organization's ID, inside this one's transaction, reads nothing
    const crossRead = await readAll(orgA, orgB.organizationId);
    for (const [table, rows] of crossRead) {
      assert.equal(
        rows.length,
        0,
        `reading ${table} with another organization's ID returns nothing under row-level security`
      );
    }
    tests.push(
      "every table with an organization_id is either exported or left out with a reason (a table added later fails here), the readable columns come from the catalog and the left-out columns are absent, the pages cover every table without gaps, the export holds the organization's own rows and nothing of another's, and another organization's ID read inside one's transaction returns nothing"
    );

    // ------------------------------------------------- 8. who can reach what
    const permission = async (text: string, values: unknown[]) =>
      Boolean(
        (await owner.pool.query<{ allowed: boolean }>(text, values)).rows[0]
          ?.allowed
      );
    await Promise.all(
      SERVICE_ROLES.flatMap((role) =>
        EXPORT_FUNCTIONS.map(async (signature) =>
          assert.equal(
            await permission(
              "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
              [role, signature]
            ),
            role === "polaris_privacy_runtime",
            `${role} on ${signature}`
          )
        )
      )
    );
    await Promise.all(
      [...EXPORT_FUNCTIONS, "public.data_exports_daily_limit()"].map(
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
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('claim_data_export', 'record_data_export_file', 'complete_data_export', 'fail_data_export', 'expire_data_exports', 'list_data_exports_to_delete', 'mark_data_export_files_deleted')
        ORDER BY p.proname`
    );
    assert.deepEqual(
      owned.rows.map((r) => `${r.proname}:${r.owner}`),
      [
        "claim_data_export:polaris_privacy_owner",
        "complete_data_export:polaris_privacy_owner",
        "expire_data_exports:polaris_privacy_owner",
        "fail_data_export:polaris_privacy_owner",
        "list_data_exports_to_delete:polaris_privacy_owner",
        "mark_data_export_files_deleted:polaris_privacy_owner",
        "record_data_export_file:polaris_privacy_owner",
      ]
    );
    const privileges = async (grantee: string, table: string) =>
      (
        await owner.pool.query<{ privilege: string }>(
          `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
            WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2
            ORDER BY privilege_type`,
          [grantee, table]
        )
      ).rows.map((r) => r.privilege);
    const columns = async (grantee: string, table: string, privilege: string) =>
      (
        await owner.pool.query<{ column_name: string }>(
          `SELECT DISTINCT column_name FROM information_schema.column_privileges
            WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2 AND privilege_type = $3
            ORDER BY column_name`,
          [grantee, table, privilege]
        )
      ).rows.map((r) => r.column_name);
    assert.deepEqual(
      await privileges("polaris_pr11_runtime", "data_exports"),
      ["SELECT"],
      "the tenant role reads the table; it inserts only the named columns"
    );
    assert.deepEqual(
      await columns("polaris_pr11_runtime", "data_exports", "INSERT"),
      ["formats", "organization_id", "requested_by_user_id"].sort()
    );
    assert.deepEqual(
      await privileges("polaris_pr11_runtime", "data_export_files"),
      ["SELECT"]
    );
    for (const role of SERVICE_ROLES.filter(
      (r) => r !== "polaris_pr11_runtime"
    )) {
      for (const table of ["data_exports", "data_export_files"]) {
        assert.equal(
          await permission(
            "SELECT has_any_column_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",
            [role, `public.${table}`]
          ),
          false,
          `${role} reaches ${table}`
        );
      }
    }
    assert.deepEqual(
      await privileges("polaris_privacy_owner", "data_exports"),
      ["SELECT"]
    );
    assert.deepEqual(
      await columns("polaris_privacy_owner", "data_exports", "UPDATE"),
      [
        "attempts",
        "error_code",
        "expires_at",
        "files_deleted_at",
        "locked_until",
        "ready_at",
        "started_at",
        "status",
        "total_bytes",
      ]
    );
    assert.deepEqual(
      await privileges("polaris_privacy_owner", "data_export_files"),
      ["DELETE", "INSERT", "SELECT"]
    );
    const policies = await owner.pool.query<{
      policyname: string;
      tablename: string;
    }>(
      "SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('data_exports', 'data_export_files') ORDER BY tablename, policyname"
    );
    assert.deepEqual(
      policies.rows.map((r) => `${r.tablename}:${r.policyname}`),
      [
        "data_export_files:data_export_files_current_tenant_select",
        "data_export_files:data_export_files_privacy_owner_delete",
        "data_export_files:data_export_files_privacy_owner_insert",
        "data_export_files:data_export_files_privacy_owner_select",
        // the purge deletes the exports of an organization whose purge was scheduled (ADR 0081)
        "data_export_files:data_export_files_purge_owner_delete",
        "data_export_files:data_export_files_purge_owner_select",
        "data_exports:data_exports_current_owner_insert",
        "data_exports:data_exports_current_tenant_select",
        "data_exports:data_exports_privacy_owner_select",
        "data_exports:data_exports_privacy_owner_update",
        "data_exports:data_exports_purge_owner_delete",
        "data_exports:data_exports_purge_owner_select",
      ]
    );
    const forced = await owner.pool.query<{
      relforcerowsecurity: boolean;
      relname: string;
    }>(
      "SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN ('public.data_exports'::regclass, 'public.data_export_files'::regclass)"
    );
    assert.equal(forced.rows.length, 2);
    assert.ok(forced.rows.every((r) => r.relforcerowsecurity));
    tests.push(
      "only the privacy runtime executes the export functions (not PUBLIC, not another service); they belong to the privacy owner, whose privileges, updatable columns and policies are exactly the ones the export needs; the tenant role holds only SELECT and the three-column INSERT; no other service role reaches either table; both are row-level secured and forced"
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
    await privacy?.close().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Data export PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
