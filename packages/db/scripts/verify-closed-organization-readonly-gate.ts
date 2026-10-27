// biome-ignore-all lint/performance/noAwaitInLoops: Probes and pages, in order.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CAPABILITIES } from "@polaris/domain/authorization/capabilities";
import {
  closureDeadlines,
  closurePhaseAt,
} from "@polaris/domain/organization/closure-deadlines";
import {
  DataExportUnavailableError,
  InvalidExportRequestError,
} from "@polaris/domain/privacy/data-export";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  CLOSED_EXPORT_READER_ROLE,
  withClosedExportTransaction,
} from "../src/closed-export-reader";
import {
  getClosedDataExportDownload,
  getClosedOrganizationStatus,
  listClosedDataExports,
  listClosedOrganizations,
  requestClosedDataExport,
} from "../src/closed-organization-repository";
import { createCustomer } from "../src/customer-repository";
import { requestDataExport } from "../src/data-export-repository";
import { EXPORT_DATASETS } from "../src/export-datasets";
import { describeDataset, readDatasetPage } from "../src/export-reader";
import {
  type ClaimedDataExport,
  createPrivacyMaintenanceClient,
} from "../src/privacy-maintenance";
import {
  TenantAuthorizationError,
  type TenantRequestTransaction,
} from "../src/tenant-transaction";
import { runClock, storeDay } from "./gate-clock";
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
 * The closed organization, read-only until the purge, on a real PostgreSQL 18 (ADR 0081 and 0078, amended; design of
 * 19/10/2026 and its consolidation): the dates the database computes are the domain's, to the second and across a
 * change of daylight saving time; the owner (and only the owner) reads the state of a closed organization, the same
 * with or without a legal hold, a scheduled purge or any billing state, and asks for a copy until D; the tenant still
 * opens for no capability (a member is told `organization_closed`); the copy is read by a role that holds SELECT on
 * exactly the columns of the export, scoped by one InitPlan to the export its run holds, inside a READ ONLY
 * transaction; a write is refused by two barriers, each proven on its own by removing the other; the file of a copy is
 * recorded only by the run that holds it; the download is the owner's, audited, and refuses the same way whatever the
 * reason.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const issuer = "https://polaris-closed-readonly-gate.cloudflareaccess.com";
const READ_ONLY = "25006";
const NO_PRIVILEGE = "42501";
const DATASET_TABLES = EXPORT_DATASETS.map((dataset) => dataset.table);
/** Tables that must stay out of the reader's reach entirely (authentication, billing, membership, devices, sync). */
const FORBIDDEN_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "memberships",
  "organization_billing",
  "billing_events",
  "entitlement_grants",
  "offline_grants",
  "devices",
  "device_sessions",
  "sync_commands",
  "sync_changes",
  "data_exports",
  "data_export_files",
  "organization_closures",
  "organization_purges",
  "organization_legal_holds",
  "tenant_audit_event",
  "event_outbox",
];
const PRIVACY_OWNER_FUNCTIONS = [
  "closed_export_organization()",
  "list_my_closed_organizations()",
  "closed_organization_status(text)",
  "request_closed_data_export(text,text[],uuid)",
  "list_closed_data_exports(text)",
  "closed_export_download(uuid,integer,uuid)",
  "list_closed_export_media(uuid,uuid,uuid,integer)",
];

const LEASE_TOKEN = /^[0-9a-f-]{36}$/;
const INIT_PLAN = /InitPlan/;
const SUB_PLAN = /SubPlan/;
const SCOPE_SUBQUERY =
  /\(\s*SELECT closed_export_organization\(\) AS closed_export_organization\)/;

type Row = Record<string, unknown>;

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : (candidate.rows ?? []);
}

/** Every exported table of an organization, in pages, through whatever transaction the caller opened. */
async function readAllDatasets(
  transaction: TenantRequestTransaction,
  organizationId: string
): Promise<Map<string, { columns: string[]; rows: Row[] }>> {
  const out = new Map<string, { columns: string[]; rows: Row[] }>();
  for (const dataset of EXPORT_DATASETS) {
    const shape = await describeDataset(transaction, dataset);
    const rows: Row[] = [];
    let after: unknown[] | null = null;
    do {
      const page: Awaited<ReturnType<typeof readDatasetPage>> =
        await readDatasetPage(
          transaction,
          organizationId,
          dataset,
          shape,
          after,
          2
        );
      rows.push(
        ...page.rows.map((row) =>
          Object.fromEntries(
            shape.columns.map((column) => [column, row[column]])
          )
        )
      );
      after = page.next;
    } while (after !== null);
    out.set(dataset.table, { columns: shape.columns, rows });
  }
  return out;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate, section by section
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  // the organizations stay in the disposable database (their audit is immutable); only what another gate's run could
  // pick up is put back: the purge row and the organization it belongs to
  const created: string[] = [];
  const tests: string[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let privacyDb: ReturnType<typeof createDatabase> | undefined;
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
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
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
    const tenantUrl = await login(runtimeRole, "polaris_cro_tenant");
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_cro_priv"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    privacyDb = createDatabase(privacyUrl, { maxConnections: 2 });
    privacy = createPrivacyMaintenanceClient(privacyUrl);
    const runtimeDb = runtime.db;
    const readerDb = privacyDb.db;
    const privacyClient = privacy;

    const ownerQuery = async <T extends Row>(
      text: string,
      values: unknown[] = []
    ) => (await owner.pool.query<T>(text, values)).rows;
    const suffix = randomUUID().slice(0, 8);
    const fixture = async (
      label: string,
      billing: "free" | "active" | "grace" | "free_over_limit" = "active",
      timezone = "America/Sao_Paulo"
    ) => {
      const tenant = await createTenantFixture(
        owner.pool,
        `cro ${label} ${suffix}`,
        timezone,
        billing === "active" ? "pro" : "free"
      );
      created.push(tenant.organizationId);
      if (billing === "grace") {
        await owner.pool.query(
          "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'grace', now() + interval '3 days')",
          [tenant.organizationId]
        );
      }
      if (billing === "free_over_limit") {
        await owner.pool.query(
          "INSERT INTO public.organization_billing (organization_id, state, over_limit_since) VALUES ($1, 'free_over_limit', now() - interval '1 day')",
          [tenant.organizationId]
        );
      }
      return tenant;
    };
    const addOwner = (tenant: TenantFixture, userId: string) =>
      owner.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
        [tenant.organizationId, userId]
      );
    const newUser = async () => {
      const userId = randomUUID();
      await owner.pool.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [userId, `cro user ${suffix}`, `cro-${userId}@example.invalid`]
      );
      return userId;
    };
    const close = (tenant: TenantFixture) =>
      withRuntimeSqlContext(tenantUrl, tenant, (client) =>
        client.query("SELECT public.request_organization_closure(30)")
      );
    /** Moves a closure back in time: requested `days` ago, the window ended unless still inside it. */
    const age = async (tenant: TenantFixture, requestedAt: Date) => {
      const recoverUntil = new Date(requestedAt.getTime() + 30 * 86_400_000);
      await owner.pool.query(
        "UPDATE public.organization_closures SET requested_at = $2, recover_until = $3 WHERE organization_id = $1",
        [tenant.organizationId, requestedAt, recoverUntil]
      );
      if (recoverUntil.getTime() <= Date.now()) {
        await owner.pool.query(
          "UPDATE public.organizations SET status = 'closed' WHERE id = $1 AND status = 'closing'",
          [tenant.organizationId]
        );
      }
    };
    const statusAs = (userId: string, organizationId: string) =>
      getClosedOrganizationStatus(runtimeDb, userId, organizationId);
    const rawStatus = (userId: string, organizationId: string) =>
      withRuntimeSqlContext(
        tenantUrl,
        { organizationId: "", userId },
        async (client) =>
          (
            await client.query(
              "SELECT to_jsonb(s) AS row FROM public.closed_organization_status($1) AS s",
              [organizationId]
            )
          ).rows.map((row) => row.row)
      );

    // ------------------------------------------------- 1. D and the phases: the database is the domain
    const cases: [string, string][] = [
      ["2026-10-19T15:00:00.000Z", "America/Sao_Paulo"],
      ["2026-10-20T02:59:59.000Z", "America/Sao_Paulo"],
      ["2026-10-20T03:00:00.000Z", "America/Sao_Paulo"],
      ["2026-10-20T03:30:00.000Z", "America/Manaus"],
      ["2026-10-19T23:30:00.000Z", "Europe/Lisbon"],
      ["2026-12-14T17:00:00.000Z", "America/New_York"],
      ["2018-08-06T15:00:00.000Z", "America/Sao_Paulo"],
      ["2012-08-06T16:00:00.000Z", "America/Havana"],
      ["2026-03-01T00:00:00.000Z", "Asia/Tokyo"],
      ["2026-07-15T12:00:00.000Z", "Australia/Sydney"],
    ];
    for (const [instant, zone] of cases) {
      const requestedAt = new Date(instant);
      const expected = closureDeadlines(requestedAt, zone);
      const [sqlDeadline] = await ownerQuery<{
        d30_at: Date;
        d7_at: Date;
        deletable_from: Date;
        deletion_date: string;
      }>(
        "SELECT deletion_date::text AS deletion_date, d30_at, d7_at, deletable_from FROM public.closure_deadlines($1::timestamptz, $2)",
        [requestedAt, zone]
      );
      assert.ok(sqlDeadline);
      assert.equal(
        sqlDeadline.deletion_date,
        expected.deletionDate,
        `${instant} ${zone}: D`
      );
      assert.equal(
        sqlDeadline.deletable_from.toISOString(),
        expected.deletableFrom.toISOString(),
        `${instant} ${zone}: the first instant of D`
      );
      assert.equal(
        sqlDeadline.d30_at.toISOString(),
        expected.d30At.toISOString(),
        `${instant} ${zone}: D-30`
      );
      assert.equal(
        sqlDeadline.d7_at.toISOString(),
        expected.d7At.toISOString(),
        `${instant} ${zone}: D-7`
      );
      const recoverUntil = new Date(requestedAt.getTime() + 30 * 86_400_000);
      // at each edge, one millisecond before and at it
      for (const edge of [
        recoverUntil,
        expected.d7At,
        expected.deletableFrom,
      ]) {
        for (const at of [new Date(edge.getTime() - 1), edge]) {
          const [phase] = await ownerQuery<{ phase: string }>(
            "SELECT public.closure_phase_at($1::timestamptz, $2::timestamptz, $3, $4::timestamptz) AS phase",
            [requestedAt, recoverUntil, zone, at]
          );
          assert.equal(
            phase?.phase,
            closurePhaseAt(
              { purgedAt: null, recoverUntil, requestedAt, timeZone: zone },
              at
            ),
            `${instant} ${zone}: the phase at ${at.toISOString()}`
          );
        }
      }
    }
    tests.push(
      "D (the local date of the request plus 90 days, from the first instant of that day in the organization's time zone), D-30 and D-7 computed by the database equal the domain's for requests at the last and first second of a local day, in São Paulo, Manaus, Lisbon, New York, Tokyo and Sydney, across a midnight that did not exist (São Paulo 2018) and one that happened twice (Havana 2012); the phase of the database equals the domain's one millisecond before and at the end of the window, D-7 and D"
    );

    // ------------------------------------------------- 2. who reads the state, and what it says
    const orgA = await fixture("A");
    const orgB = await fixture("B", "free");
    const orgC = await fixture("C", "grace");
    const orgD = await fixture("D", "free_over_limit");
    // the owner of A owns B, C and D too (four billing states); another user has an active organization of their own
    for (const other of [orgB, orgC, orgD]) {
      await owner.pool.query(
        "DELETE FROM public.memberships WHERE organization_id = $1",
        [other.organizationId]
      );
      await addOwner(other, orgA.userId);
    }
    const ownerOfA = orgA.userId;
    const asOwnerOf = (tenant: TenantFixture): TenantFixture => ({
      organizationId: tenant.organizationId,
      userId: ownerOfA,
    });
    const orgOther = await fixture("other");
    const stranger = await newUser();
    for (const tenant of [orgA, orgB, orgC, orgD]) {
      await close(asOwnerOf(tenant));
    }
    const requested = new Date(Date.now() - 40 * 86_400_000);
    for (const tenant of [orgB, orgC, orgD]) {
      await age(tenant, requested);
    }
    const listed = await listClosedOrganizations(runtimeDb, ownerOfA);
    assert.deepEqual(
      listed.map((item) => item.id).sort(),
      [orgA, orgB, orgC, orgD].map((tenant) => tenant.organizationId).sort(),
      "the owner lists their closed organizations"
    );
    assert.deepEqual(
      await listClosedOrganizations(runtimeDb, orgOther.userId),
      []
    );
    assert.deepEqual(await listClosedOrganizations(runtimeDb, stranger), []);
    const strip = (row: Record<string, unknown>) => {
      const { id: _id, name: _name, ...rest } = row;
      return rest;
    };
    const [rowB] = await rawStatus(ownerOfA, orgB.organizationId);
    const [rowC] = await rawStatus(ownerOfA, orgC.organizationId);
    const [rowD] = await rawStatus(ownerOfA, orgD.organizationId);
    assert.ok(rowB && rowC && rowD);
    assert.deepEqual(
      strip(rowC),
      strip(rowB),
      "the same dates, whatever the billing (grace)"
    );
    assert.deepEqual(
      strip(rowD),
      strip(rowB),
      "the same dates, whatever the billing (over the limit)"
    );
    const statusA = await statusAs(ownerOfA, orgA.organizationId);
    assert.ok(statusA);
    assert.equal(statusA.phase, "closing");
    assert.equal(statusA.canRecover, true);
    const expectedA = closureDeadlines(
      statusA.requestedAt,
      "America/Sao_Paulo"
    );
    assert.equal(statusA.deletionDate, expectedA.deletionDate);
    assert.equal(
      statusA.exportOpenUntil.toISOString(),
      expectedA.deletableFrom.toISOString()
    );
    assert.equal(
      statusA.milestones.closure.toISOString(),
      statusA.requestedAt.toISOString()
    );
    const statusB = await statusAs(ownerOfA, orgB.organizationId);
    assert.equal(statusB?.phase, "closed");
    assert.equal(statusB?.canRecover, false);
    for (const [userId, organizationId, label] of [
      [
        orgOther.userId,
        orgA.organizationId,
        "someone else's closed organization",
      ],
      [stranger, orgA.organizationId, "a user with no organization"],
      [ownerOfA, randomUUID(), "an organization that does not exist"],
      [orgOther.userId, orgOther.organizationId, "an active organization"],
    ] as const) {
      assert.equal(await statusAs(userId, organizationId), null, label);
      assert.deepEqual(
        await rawStatus(userId, organizationId),
        [],
        `${label}: the same empty answer`
      );
    }
    // a legal hold and a scheduled purge change nothing the owner reads
    const principal = (
      await ownerQuery<{ id: string }>(
        "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
        [issuer, `sub-${randomUUID()}`]
      )
    )[0]?.id as string;
    const supportCase = async (organizationId: string) =>
      (
        await ownerQuery<{ id: string }>(
          "INSERT INTO public.support_cases (kind, opened_by, organization_id, reason) VALUES ('support', $1, $2, 'Gate do modo leitura') RETURNING id",
          [principal, organizationId]
        )
      )[0]?.id as string;
    const caseB = await supportCase(orgB.organizationId);
    await owner.pool.query(
      "INSERT INTO public.organization_legal_holds (organization_id, placed_by, review_at, support_case_id) VALUES ($1, $2, now() + interval '30 days', $3)",
      [orgB.organizationId, principal, caseB]
    );
    assert.deepEqual(
      await rawStatus(ownerOfA, orgB.organizationId),
      [rowB],
      "byte for byte the same with a legal hold"
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1",
      [orgB.organizationId]
    );
    assert.deepEqual(
      await rawStatus(ownerOfA, orgB.organizationId),
      [rowB],
      "and the same once a purge is scheduled (purge_pending reads as closed on the same dates)"
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'closed' WHERE id = $1",
      [orgB.organizationId]
    );
    // every phase, by dates only
    for (const [daysAgo, phase] of [
      [10, "closing"],
      [40, "closed"],
      [85, "deletion_scheduled"],
      [95, "deletable"],
    ] as const) {
      await age(orgD, new Date(Date.now() - daysAgo * 86_400_000));
      if (daysAgo === 10) {
        await owner.pool.query(
          "UPDATE public.organizations SET status = 'closing' WHERE id = $1",
          [orgD.organizationId]
        );
      }
      const status = await statusAs(ownerOfA, orgD.organizationId);
      assert.equal(status?.phase, phase, `${daysAgo} days after the request`);
      assert.equal(
        status?.phase,
        closurePhaseAt(
          {
            purgedAt: null,
            recoverUntil: status?.recoverUntil as Date,
            requestedAt: status?.requestedAt as Date,
            timeZone: "America/Sao_Paulo",
          },
          new Date()
        )
      );
    }
    await age(orgD, requested);
    tests.push(
      "only the owner reads a closed organization (closing, closed or purge_pending): another user, a user without an organization, an organization that does not exist and an active one all get the same empty answer; the answer is byte for byte the same with a legal hold, with the purge scheduled and in four billing states (Free, Pro, grace, over the limit); the phase moves only with the dates (closing, closed, deletion_scheduled from D-7, deletable from D) and equals the domain's"
    );

    // ------------------------------------------------- 3. the tenant still opens for nothing
    for (const capability of CAPABILITIES) {
      await assert.rejects(
        () =>
          withTenantAs(runtimeDb, asOwnerOf(orgA), capability, () =>
            Promise.resolve(1)
          ),
        (error: unknown) =>
          error instanceof TenantAuthorizationError &&
          error.code === "organization_closed",
        `${capability} is refused to the owner of a closed organization, who is told so`
      );
    }
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDb,
          { organizationId: orgA.organizationId, userId: orgOther.userId },
          "catalog:read",
          () => Promise.resolve(1)
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied",
      "someone who is not a member learns nothing"
    );
    const orgSuspended = await fixture("suspended");
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'suspended' WHERE id = $1",
      [orgSuspended.organizationId]
    );
    await assert.rejects(
      () =>
        withTenantAs(runtimeDb, orgSuspended, "catalog:read", () =>
          Promise.resolve(1)
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied",
      "a suspension is not a closure"
    );
    tests.push(
      `every one of the ${CAPABILITIES.length} capabilities of the map is refused to the owner of a closed organization with organization_closed (none runs); someone who is not a member, and the owner of a suspended organization, still get tenant_access_denied`
    );

    // ------------------------------------------------- 4. asking for a copy
    // data of E while it is active, read as the owner through the tenant: what a copy of E must hold
    const orgE = await fixture("E");
    await createProductFixture(runtimeDb, orgE, "E1");
    await createProductFixture(runtimeDb, orgE, "E2");
    await createProductFixture(runtimeDb, orgOther, "outro");
    for (const name of ["Cliente um", "Cliente dois", "Cliente três"]) {
      await withTenantAs(
        runtimeDb,
        orgE,
        "customer:update",
        (transaction, identity) =>
          createCustomer(transaction, identity, {
            email: `cro-${randomUUID()}@example.invalid`,
            name,
            requestId: randomUUID(),
          })
      );
    }
    const activeCopy = await withTenantAs(
      runtimeDb,
      orgE,
      "organization:export",
      (transaction) => readAllDatasets(transaction, orgE.organizationId)
    );
    // an export asked for before the closure is still in flight when the organization closes
    const leftover = await withTenantAs(
      runtimeDb,
      orgE,
      "organization:export",
      (transaction, identity) =>
        requestDataExport(transaction, identity, { formats: ["json"] })
    );
    await close(orgE);
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgE.userId, {
          formats: ["json"],
          organizationId: orgE.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "export_already_running",
      "one at a time: the export asked for before the closure counts"
    );
    // the queue claims the leftover: an active export read as the person who asked fails at the tenant
    const claimedLeftover = await privacyClient.claimDataExportById(
      leftover.id,
      orgE.organizationId,
      60
    );
    assert.equal(claimedLeftover?.mode, "active");
    await privacyClient.failDataExport(
      leftover.id,
      "export_not_authorized",
      true
    );
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgOther.userId, {
          formats: ["json"],
          organizationId: orgE.organizationId,
        }),
      TenantAuthorizationError,
      "someone else cannot ask"
    );
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgE.userId, {
          formats: ["json"],
          organizationId: randomUUID(),
        }),
      TenantAuthorizationError,
      "nor for an organization that does not exist (the same refusal)"
    );
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgOther.userId, {
          formats: ["json"],
          organizationId: orgOther.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "closed_export_unavailable",
      "an active organization asks through the tenant, not here"
    );
    const requestIdE = randomUUID();
    const askedE = await requestClosedDataExport(runtimeDb, orgE.userId, {
      formats: ["csv", "json", "images"],
      organizationId: orgE.organizationId,
      requestId: requestIdE,
    });
    const [recordE] = await ownerQuery<{
      formats: string[];
      mode: string;
      requested_by_user_id: string;
      status: string;
    }>(
      "SELECT mode, status, formats, requested_by_user_id FROM public.data_exports WHERE id = $1",
      [askedE.id]
    );
    assert.deepEqual(recordE, {
      formats: ["json", "csv", "images"],
      mode: "closed",
      requested_by_user_id: orgE.userId,
      status: "requested",
    });
    const outbox = await ownerQuery<{
      correlation_id: string;
      event: Row;
      idempotency_key: string;
      type: string;
    }>(
      "SELECT type, event, idempotency_key, correlation_id FROM public.event_outbox WHERE organization_id = $1 AND event ->> 'exportId' = $2",
      [orgE.organizationId, askedE.id]
    );
    assert.deepEqual(outbox, [
      {
        correlation_id: requestIdE,
        event: { exportId: askedE.id },
        idempotency_key: `data_export.requested:${askedE.id}`,
        type: "data_export.requested",
      },
    ]);
    const auditOf = (exportId: string) =>
      ownerQuery<{
        actor_user_id: string;
        entity_type: string;
        event_type: string;
        request_id: string | null;
      }>(
        "SELECT event_type, actor_user_id, entity_type, request_id FROM public.tenant_audit_event WHERE entity_id = $1 ORDER BY created_at, id",
        [exportId]
      );
    assert.deepEqual(await auditOf(askedE.id), [
      {
        actor_user_id: orgE.userId,
        entity_type: "data_export",
        event_type: "data_export.requested",
        request_id: requestIdE,
      },
    ]);
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgE.userId, {
          formats: ["json"],
          organizationId: orgE.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "export_already_running"
    );
    // three a day: two more after the first, then a refusal
    const orgF = await fixture("F");
    await close(orgF);
    for (let index = 0; index < 3; index += 1) {
      const asked = await requestClosedDataExport(runtimeDb, orgF.userId, {
        formats: ["json"],
        organizationId: orgF.organizationId,
      });
      await owner.pool.query(
        "UPDATE public.data_exports SET status = 'failed', error_code = 'gate' WHERE id = $1",
        [asked.id]
      );
    }
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgF.userId, {
          formats: ["json"],
          organizationId: orgF.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "export_limit_reached",
      "at most three a day"
    );
    // until D, and never once a purge was claimed
    const orgG = await fixture("G");
    await close(orgG);
    await age(orgG, new Date(Date.now() - 91 * 86_400_000));
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgG.userId, {
          formats: ["json"],
          organizationId: orgG.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "closed_export_unavailable",
      "not from D on"
    );
    const deadlineG = closureDeadlines(
      new Date(Date.now() - 89 * 86_400_000),
      "America/Sao_Paulo"
    );
    await age(orgG, new Date(Date.now() - 89 * 86_400_000));
    assert.ok(deadlineG.deletableFrom.getTime() > Date.now());
    const caseG = await supportCase(orgG.organizationId);
    await owner.pool.query(
      "INSERT INTO public.organization_purges (organization_id, not_before, privacy_case_id, scheduled_by, support_case_id, locked_until) VALUES ($1, now(), $2, $3, $2, now() + interval '10 minutes')",
      [orgG.organizationId, caseG, principal]
    );
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1",
      [orgG.organizationId]
    );
    await assert.rejects(
      () =>
        requestClosedDataExport(runtimeDb, orgG.userId, {
          formats: ["json"],
          organizationId: orgG.organizationId,
        }),
      (error: unknown) =>
        error instanceof InvalidExportRequestError &&
        error.code === "closed_export_unavailable",
      "not once a run holds the purge"
    );
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
      [orgG.organizationId]
    );
    const askedG = await requestClosedDataExport(runtimeDb, orgG.userId, {
      formats: ["json"],
      organizationId: orgG.organizationId,
    });
    tests.push(
      "the owner of a closed organization asks for a copy outside the tenant: the request (mode closed, the formats in canonical order), its audit (only IDs and the request ID) and its outbox event (keyed by the export) are written together; someone else and an organization that does not exist get the same refusal, an active organization asks through the tenant; one at a time (an export asked for before the closure counts), three a day, until D, and not while a run holds the purge (it can again while the purge is only scheduled, before D)"
    );

    // the limit to the second: D is a local midnight, so the real clock never lands one second from it. The function is
    // the live definition (read from the catalog, nothing retyped) with its clock fixed at the instant under test, in a
    // transaction that is rolled back: nothing it writes stays. The gate's owner connection is a superuser, so the
    // replacement keeps the function's owner (the privacy owner) and the call runs as it does in production.
    const requestFunctionName = "public.request_closed_data_export";
    const requestFunction = `${requestFunctionName}(text,text[],uuid)`;
    const askWithClockAt = async (tenant: TenantFixture, clock: Date) => {
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        const [live] = (
          await client.query<{ definition: string }>(
            "SELECT pg_get_functiondef($1::regprocedure) AS definition",
            [requestFunction]
          )
        ).rows;
        assert.ok(live);
        const fixed = live.definition.replaceAll(
          "pg_catalog.now()",
          `'${clock.toISOString()}'::timestamptz`
        );
        assert.notEqual(fixed, live.definition, "the clock of the function");
        assert.ok(!fixed.includes("pg_catalog.now()"));
        await client.query(fixed);
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          tenant.userId,
        ]);
        await client.query(
          `SELECT ${requestFunctionName}($1, ARRAY['json']::text[], NULL)`,
          [tenant.organizationId]
        );
        return "accepted";
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    };
    for (const [label, timezone, purgeAfterD] of [
      ["no purge", "America/Sao_Paulo", null],
      ["a purge rescheduled after D", "America/Manaus", 5],
    ] as const) {
      const orgLimit = await fixture(`limit ${label}`, "active", timezone);
      await close(orgLimit);
      const requestedAt = new Date(Date.now() - 80 * 86_400_000);
      await age(orgLimit, requestedAt);
      const { deletableFrom } = closureDeadlines(requestedAt, timezone);
      assert.ok(deletableFrom.getTime() > Date.now());
      const [sqlDeadline] = await ownerQuery<{ deletable_from: Date }>(
        "SELECT deletable_from FROM public.closure_deadlines($1::timestamptz, $2)",
        [requestedAt, timezone]
      );
      assert.equal(
        sqlDeadline?.deletable_from.toISOString(),
        deletableFrom.toISOString()
      );
      if (purgeAfterD !== null) {
        // scheduled at D, then held and put back to a later day: the purge only waits, nothing was claimed
        await owner.pool.query(
          "INSERT INTO public.organization_purges (organization_id, not_before, trigger) VALUES ($1, $2, 'closure_period')",
          [
            orgLimit.organizationId,
            new Date(deletableFrom.getTime() + purgeAfterD * 86_400_000),
          ]
        );
        await owner.pool.query(
          "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1",
          [orgLimit.organizationId]
        );
      }
      const at = (offsetMs: number) =>
        askWithClockAt(orgLimit, new Date(deletableFrom.getTime() + offsetMs));
      assert.equal(await at(-1000), "accepted", `${label}: a second before D`);
      assert.equal(
        await at(1000),
        "closed_export_unavailable",
        `${label}: a second after D`
      );
      assert.equal(
        await at(0),
        "closed_export_unavailable",
        `${label}: at D itself`
      );
    }
    tests.push(
      "the copy is asked for until the first instant of D, to the second (the live function with its clock fixed): accepted one second before D, refused at D and one second after, with or without a purge rescheduled to a later day"
    );

    // ------------------------------------------------- 5. the claim and the reader
    const claimedE = await privacyClient.claimDataExportById(
      askedE.id,
      orgE.organizationId,
      600
    );
    assert.ok(claimedE);
    assert.equal(claimedE.mode, "closed");
    assert.match(claimedE.leaseToken ?? "", LEASE_TOKEN);
    const closedCopy = await withClosedExportTransaction(
      readerDb,
      claimedE,
      (transaction) => readAllDatasets(transaction, orgE.organizationId)
    );
    assert.deepEqual(
      [...closedCopy.keys()],
      [...activeCopy.keys()],
      "the same datasets"
    );
    // the organization's own row is the one thing the closure changed (its status and when it changed)
    const sameRow = (row: Row) => {
      const { status: _status, updated_at: _updatedAt, ...rest } = row;
      return rest;
    };
    for (const [table, read] of activeCopy) {
      assert.deepEqual(
        closedCopy.get(table)?.columns,
        read.columns,
        `${table}: the same columns`
      );
      assert.deepEqual(
        closedCopy
          .get(table)
          ?.rows.map(table === "organizations" ? sameRow : (row) => row),
        read.rows.map(table === "organizations" ? sameRow : (row) => row),
        `${table}: the same rows`
      );
    }
    assert.equal(closedCopy.get("organizations")?.rows[0]?.status, "closing");
    assert.equal(closedCopy.get("customers")?.rows.length, 3);
    assert.equal(closedCopy.get("products")?.rows.length, 2);
    const images = await privacyClient.listClosedExportMedia(
      askedE.id,
      claimedE.leaseToken as string,
      null,
      100
    );
    assert.deepEqual(images, []);
    await assert.rejects(
      () =>
        privacyClient.listClosedExportMedia(askedE.id, randomUUID(), null, 100),
      "the images are listed only for the run that holds the export"
    );
    // isolation: another organization's ID reads nothing, and a table read whole holds only this organization
    const crossRead = await withClosedExportTransaction(
      readerDb,
      claimedE,
      (transaction) => readAllDatasets(transaction, orgOther.organizationId)
    );
    for (const [table, read] of crossRead) {
      assert.equal(
        read.rows.length,
        0,
        `${table}: nothing of another organization`
      );
    }
    const whole = await withClosedExportTransaction(
      readerDb,
      claimedE,
      async (transaction) =>
        rowsOf<{ organization_id: string }>(
          await transaction.execute(
            sql`SELECT DISTINCT organization_id FROM public.products`
          )
        )
    );
    assert.deepEqual(
      whole.map((row) => row.organization_id),
      [orgE.organizationId]
    );
    tests.push(
      "the claim of a closed export answers its mode and a lease token; read by the closed organization's reader (READ ONLY, REPEATABLE READ, the export and the token named) the copy has the same datasets, columns and rows as the owner read through the tenant while the organization was active; another organization's ID reads nothing and a table read without a filter holds only the export's organization; the images are listed only with the run's own token"
    );

    // what the scope refuses: each condition on its own
    const readerSession = async <T>(
      settings: {
        exportId?: string;
        lease?: string;
        readOnly: boolean;
        role?: boolean;
      },
      operation: (client: Client) => Promise<T>,
      url = privacyUrl
    ) => {
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        await client.query(settings.readOnly ? "BEGIN READ ONLY" : "BEGIN");
        await client.query(
          "SELECT set_config('app.closed_export_id', $1, true), set_config('app.closed_export_lease', $2, true)",
          [settings.exportId ?? "", settings.lease ?? ""]
        );
        if (settings.role !== false) {
          await client.query(`SET LOCAL ROLE ${CLOSED_EXPORT_READER_ROLE}`);
        }
        return await operation(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    };
    const visible = (settings: Parameters<typeof readerSession>[0]) =>
      readerSession(settings, async (client) =>
        Number(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM public.customers"
            )
          ).rows[0]?.n
        )
      );
    const good = {
      exportId: askedE.id,
      lease: claimedE.leaseToken as string,
      readOnly: true,
    };
    assert.equal(await visible(good), 3);
    assert.equal(
      await visible({ ...good, lease: randomUUID() }),
      0,
      "another lease token reads nothing"
    );
    assert.equal(
      await visible({ ...good, exportId: askedG.id }),
      0,
      "another export reads nothing"
    );
    assert.equal(
      await visible({ ...good, exportId: "not-a-uuid" }),
      0,
      "a malformed setting reads nothing, without an error"
    );
    assert.equal(
      await visible({ readOnly: true }),
      0,
      "no export named reads nothing"
    );
    assert.equal(
      await visible({ ...good, readOnly: false }),
      0,
      "outside a READ ONLY transaction the scope is empty"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() - interval '1 second' WHERE id = $1",
      [askedE.id]
    );
    assert.equal(await visible(good), 0, "a lease that ran out reads nothing");
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() + interval '10 minutes' WHERE id = $1",
      [askedE.id]
    );
    assert.equal(await visible(good), 3);
    await expectSqlState(
      () =>
        readerSession({ ...good, role: false }, (client) =>
          client.query("SELECT count(*) FROM public.customers")
        ),
      NO_PRIVILEGE,
      "the privacy runtime itself reads no table"
    );
    await expectSqlState(
      () => readerSession(good, () => Promise.resolve(), tenantUrl),
      NO_PRIVILEGE,
      "the tenant runtime cannot become the reader"
    );
    // one InitPlan per query, never a SubPlan per row
    for (const table of DATASET_TABLES) {
      const key = table === "organizations" ? "id" : "organization_id";
      const plan = await readerSession(good, async (client) =>
        (await client.query(`EXPLAIN SELECT ${key} FROM public.${table}`)).rows
          .map((row) => String(row["QUERY PLAN"]))
          .join("\n")
      );
      assert.match(plan, INIT_PLAN, `${table}: the scope is an InitPlan`);
      assert.doesNotMatch(plan, SUB_PLAN, `${table}: no SubPlan per row`);
    }
    tests.push(
      "the scope answers nothing with another lease token, another export, a malformed setting, no export named, outside a READ ONLY transaction or after the lease ran out; the privacy runtime itself reads no table and the tenant runtime cannot become the reader; on every exported table the plan has the scope as an InitPlan and no SubPlan"
    );

    // ------------------------------------------------- 6. the two barriers, each on its own (Diego V3, (a) to (g))
    const countAll = async () => {
      const counts: Record<string, number> = {};
      for (const table of DATASET_TABLES) {
        const column = table === "organizations" ? "id" : "organization_id";
        const [row] = await ownerQuery<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.${table} WHERE ${column} = $1`,
          [orgE.organizationId]
        );
        counts[table] = row?.n ?? -1;
      }
      return counts;
    };
    const before = await countAll();
    const writes = (table: string) => {
      const column = table === "organizations" ? "id" : "organization_id";
      return [
        ["INSERT", `INSERT INTO public.${table} DEFAULT VALUES`],
        [
          "UPDATE",
          `UPDATE public.${table} SET ${column} = ${column} WHERE ${column} = '${orgE.organizationId}'`,
        ],
        [
          "DELETE",
          `DELETE FROM public.${table} WHERE ${column} = '${orgE.organizationId}'`,
        ],
        ["TRUNCATE", `TRUNCATE public.${table}`],
      ] as const;
    };
    for (const table of DATASET_TABLES) {
      for (const [verb, statement] of writes(table)) {
        // (a) to (d): inside the reader's transaction every write fails at the read-only barrier
        await expectSqlState(
          () => readerSession(good, (client) => client.query(statement)),
          READ_ONLY,
          `(a-d) ${verb} on ${table} inside the reader's READ ONLY transaction`
        );
        // (e) the read-only barrier removed: the missing privilege still refuses it
        await expectSqlState(
          () =>
            readerSession({ ...good, readOnly: false }, (client) =>
              client.query(statement)
            ),
          NO_PRIVILEGE,
          `(e) ${verb} on ${table} with READ ONLY removed`
        );
      }
    }
    // (f) the privilege barrier removed (a write grant and a policy that lets everything through, only inside the
    // probe's own transaction): READ ONLY still refuses; and with both barriers removed the write would go through,
    // so neither proof above is vacuous
    const withoutPrivilegeBarrier = async (
      table: string,
      readOnly: boolean
    ) => {
      const client = new Client({
        connectionString: adminUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `GRANT INSERT, UPDATE, DELETE ON public.${table} TO ${CLOSED_EXPORT_READER_ROLE}`
        );
        await client.query(
          `CREATE POLICY gate_probe_write ON public.${table} AS PERMISSIVE FOR ALL TO ${CLOSED_EXPORT_READER_ROLE} USING (true) WITH CHECK (true)`
        );
        if (readOnly) {
          await client.query("SET LOCAL transaction_read_only = on");
        }
        await client.query(`SET LOCAL ROLE ${CLOSED_EXPORT_READER_ROLE}`);
        const [, update, remove] = writes(table);
        await client.query(update[1]);
        await client.query(`${remove[1]} AND false`);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    };
    for (const table of DATASET_TABLES) {
      await expectSqlState(
        () => withoutPrivilegeBarrier(table, true),
        READ_ONLY,
        `(f) a write on ${table} with the privilege granted is refused by READ ONLY`
      );
      await withoutPrivilegeBarrier(table, false);
    }
    // (g) nothing moved
    assert.deepEqual(
      await countAll(),
      before,
      "(g) every exported table holds the same rows as before"
    );
    const probes = await ownerQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'gate_probe_write'"
    );
    assert.equal(probes[0]?.n, 0, "the probes left nothing behind");
    tests.push(
      `the two barriers against a write, each proven with the other removed, on each of the ${DATASET_TABLES.length} exported tables: (a) INSERT, (b) UPDATE, (c) DELETE and (d) TRUNCATE inside the reader's transaction fail at READ ONLY (25006); (e) with READ ONLY removed each fails for the missing privilege (42501); (f) with the privilege granted and a policy that lets everything through, READ ONLY still refuses, and with both removed the write goes through (the proofs are not vacuous); (g) every table holds the same rows afterwards and the probes leave nothing behind`
    );

    // ------------------------------------------------- 7. the reader's privileges are the datasets, column by column
    const columns = await ownerQuery<{
      column_name: string;
      insert: boolean;
      references: boolean;
      select: boolean;
      table_name: string;
      update: boolean;
    }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              has_column_privilege($1, c.oid, a.attnum, 'SELECT') AS select,
              has_column_privilege($1, c.oid, a.attnum, 'INSERT') AS insert,
              has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AS update,
              has_column_privilege($1, c.oid, a.attnum, 'REFERENCES') AS references
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2`,
      [CLOSED_EXPORT_READER_ROLE]
    );
    const expectedReadable = new Set(
      EXPORT_DATASETS.flatMap((dataset) =>
        columns
          .filter(
            (column) =>
              column.table_name === dataset.table &&
              !(dataset.omit ?? []).includes(column.column_name)
          )
          .map((column) => `${column.table_name}.${column.column_name}`)
      )
    );
    const readable = columns
      .filter((column) => column.select)
      .map((column) => `${column.table_name}.${column.column_name}`);
    assert.deepEqual(
      readable,
      [...expectedReadable].sort(),
      "SELECT on exactly EXPORT_DATASETS minus omit"
    );
    assert.deepEqual(
      columns
        .filter((column) => column.insert || column.update || column.references)
        .map((column) => column.table_name),
      [],
      "no INSERT, UPDATE or REFERENCES on any column"
    );
    for (const dataset of EXPORT_DATASETS) {
      for (const omitted of dataset.omit ?? []) {
        assert.equal(
          readable.includes(`${dataset.table}.${omitted}`),
          false,
          `${dataset.table}.${omitted} is not read`
        );
      }
    }
    const tablePrivileges = await ownerQuery<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND (has_table_privilege($1, c.oid, 'DELETE') OR has_table_privilege($1, c.oid, 'TRUNCATE')
            OR has_table_privilege($1, c.oid, 'TRIGGER') OR has_table_privilege($1, c.oid, 'INSERT')
            OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'MAINTAIN')
            OR (c.relkind = 'S' AND has_sequence_privilege($1, c.oid, 'USAGE')))`,
      [CLOSED_EXPORT_READER_ROLE]
    );
    assert.deepEqual(
      tablePrivileges,
      [],
      "no table-wide privilege and no sequence anywhere"
    );
    for (const table of FORBIDDEN_TABLES) {
      assert.equal(
        columns.some((column) => column.table_name === table && column.select),
        false,
        `${table} is out of the reader's reach`
      );
    }
    const [tokenReach] = await ownerQuery<{ allowed: boolean }>(
      "SELECT has_column_privilege($1, 'public.data_exports', 'lease_token', 'SELECT') AS allowed",
      [runtimeRole]
    );
    assert.equal(
      tokenReach?.allowed,
      false,
      "the tenant runtime does not read the lease token of a run"
    );
    const executable = await ownerQuery<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege($1, p.oid, 'EXECUTE')
        ORDER BY 1`,
      [CLOSED_EXPORT_READER_ROLE]
    );
    assert.deepEqual(
      executable.map((row) => row.signature),
      ["closed_export_organization()"],
      "EXECUTE on the scope only"
    );
    const [attributes] = await ownerQuery<Row>(
      `SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary,
              has_database_privilege($1, current_database(), 'CREATE') AS create_schema,
              has_schema_privilege($1, 'public', 'CREATE') AS create_in_public
         FROM pg_roles WHERE rolname = $1`,
      [CLOSED_EXPORT_READER_ROLE]
    );
    assert.deepEqual(attributes, {
      create_in_public: false,
      create_schema: false,
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
      temporary: false,
    });
    const memberships = await ownerQuery<Row>(
      `SELECT member.rolname AS member, granted.rolname AS granted, m.inherit_option, m.set_option, m.admin_option
         FROM pg_auth_members m
         JOIN pg_roles member ON member.oid = m.member
         JOIN pg_roles granted ON granted.oid = m.roleid
        WHERE (granted.rolname = $1 OR member.rolname = $1)
        ORDER BY 1, 2`,
      [CLOSED_EXPORT_READER_ROLE]
    );
    assert.deepEqual(
      memberships,
      [
        {
          admin_option: false,
          granted: CLOSED_EXPORT_READER_ROLE,
          inherit_option: false,
          member: "polaris_privacy_runtime",
          set_option: true,
        },
      ],
      "only the privacy runtime may become the reader (SET, never INHERIT), and the reader is a member of nothing"
    );
    const policies = await ownerQuery<{ qual: string; tablename: string }>(
      "SELECT tablename, qual, cmd FROM pg_policies WHERE $1 = ANY (roles) ORDER BY tablename",
      [CLOSED_EXPORT_READER_ROLE]
    );
    assert.deepEqual(
      policies.map((policy) => policy.tablename),
      [...DATASET_TABLES].sort(),
      "one policy per exported table, and only there"
    );
    for (const policy of policies) {
      assert.match(
        policy.qual,
        SCOPE_SUBQUERY,
        `${policy.tablename}: by the scope`
      );
      assert.equal((policy as unknown as { cmd: string }).cmd, "SELECT");
    }
    tests.push(
      "the reader holds SELECT on exactly the columns of EXPORT_DATASETS minus omit (has_column_privilege on every column of every table), no INSERT, UPDATE, REFERENCES, DELETE, TRUNCATE, TRIGGER or MAINTAIN and no sequence anywhere; authentication, billing, memberships, sessions, offline grants, devices, sync, the exports themselves, the closure, the purge and the audits are out of reach; it executes only its scope; it is NOLOGIN, NOINHERIT, NOBYPASSRLS, without TEMPORARY or CREATE; only the privacy runtime may become it (SET, not INHERIT) and it is a member of nothing; its policies are one SELECT per exported table, each by the scope as a subquery"
    );

    // ------------------------------------------------- 8. who records the file of a copy (the trigger, both sides)
    const fileFor = (
      exportId: string,
      organizationId: string,
      name: string
    ) => ({
      exportId,
      key: `exports/v1/${organizationId}/${exportId}/${name}`,
      name,
      ordinal: 1,
      sizeBytes: 10,
    });
    const today = storeDay(runClock);
    await privacyClient.recordDataExportFile(
      fileFor(askedE.id, orgE.organizationId, `polaris-dados-${today}.zip`)
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() - interval '1 second' WHERE id = $1",
      [askedE.id]
    );
    await expectSqlState(
      () =>
        privacyClient?.recordDataExportFile({
          ...fileFor(
            askedE.id,
            orgE.organizationId,
            `polaris-dados-${today}-parte-002.zip`
          ),
          ordinal: 2,
        }) as Promise<void>,
      "55000",
      "a closed export whose lease ran out records nothing"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() + interval '10 minutes' WHERE id = $1",
      [askedE.id]
    );
    // an active export claimed after its organization closed records nothing
    const orgH = await fixture("H");
    const activeH = await withTenantAs(
      runtimeDb,
      orgH,
      "organization:export",
      (transaction, identity) =>
        requestDataExport(transaction, identity, { formats: ["json"] })
    );
    await close(orgH);
    const claimedH = await privacyClient.claimDataExportById(
      activeH.id,
      orgH.organizationId,
      60
    );
    assert.equal(claimedH?.mode, "active");
    await expectSqlState(
      () =>
        privacyClient?.recordDataExportFile(
          fileFor(activeH.id, orgH.organizationId, `polaris-dados-${today}.zip`)
        ) as Promise<void>,
      "55000",
      "an active export of an organization no longer active records nothing"
    );
    // a closed export of an organization that was recovered records nothing (and the claim fails it for good)
    const orgI = await fixture("I");
    await close(orgI);
    const askedI = await requestClosedDataExport(runtimeDb, orgI.userId, {
      formats: ["json"],
      organizationId: orgI.organizationId,
    });
    const claimedI = await privacyClient.claimDataExportById(
      askedI.id,
      orgI.organizationId,
      60
    );
    assert.ok(claimedI);
    await withRuntimeSqlContext(tenantUrl, orgI, (client) =>
      client.query("SELECT public.recover_organization_closure($1)", [
        orgI.organizationId,
      ])
    );
    await expectSqlState(
      () =>
        privacyClient?.recordDataExportFile(
          fileFor(askedI.id, orgI.organizationId, `polaris-dados-${today}.zip`)
        ) as Promise<void>,
      "55000",
      "a closed export of a recovered organization records nothing"
    );
    assert.equal(
      await withClosedExportTransaction(
        readerDb,
        claimedI as ClaimedDataExport,
        async (transaction) =>
          rowsOf(
            await transaction.execute(sql`SELECT 1 FROM public.organizations`)
          ).length
      ),
      0,
      "and its reader reads nothing"
    );
    await privacyClient.failDataExport(askedI.id, "export_failed", false);
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = NULL WHERE id = $1",
      [askedI.id]
    );
    assert.equal(
      await privacyClient.claimDataExportById(
        askedI.id,
        orgI.organizationId,
        60
      ),
      null
    );
    const [failedI] = await ownerQuery<{ error_code: string; status: string }>(
      "SELECT status, error_code FROM public.data_exports WHERE id = $1",
      [askedI.id]
    );
    assert.deepEqual(
      failedI,
      { error_code: "export_not_authorized", status: "failed" },
      "the claim fails it for good, so it never blocks the recovered organization"
    );
    // a closed export whose purge was claimed is not started either
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '10 minutes' WHERE organization_id = $1",
      [orgG.organizationId]
    );
    assert.equal(
      await privacyClient.claimDataExportById(
        askedG.id,
        orgG.organizationId,
        60
      ),
      null,
      "not while a run holds the purge"
    );
    tests.push(
      "the file of a copy is recorded by the run that holds a closed export of an organization in closure, and refused (55000) once its lease ran out, for an active export claimed after its organization closed, and for a closed export of an organization that was recovered (whose reader then reads nothing, and whose next claim fails it for good with export_not_authorized); a closed export is not started while a run holds the purge"
    );

    // ------------------------------------------------- 9. the download
    await privacyClient.completeDataExport(askedE.id, 24);
    const listedE = await listClosedDataExports(
      runtimeDb,
      orgE.userId,
      orgE.organizationId
    );
    const readyE = listedE.find((item) => item.id === askedE.id);
    assert.equal(readyE?.status, "ready");
    assert.equal(readyE?.mode, "closed");
    assert.deepEqual(
      readyE?.files.map((entry) => entry.ordinal),
      [1]
    );
    const leftoverListed = listedE.find((item) => item.id === leftover.id);
    assert.equal(leftoverListed?.mode, "active");
    assert.deepEqual(leftoverListed?.files, []);
    assert.deepEqual(
      await listClosedDataExports(
        runtimeDb,
        orgOther.userId,
        orgE.organizationId
      ),
      [],
      "someone else lists nothing"
    );
    const downloadRequest = randomUUID();
    const file = await getClosedDataExportDownload(runtimeDb, orgE.userId, {
      exportId: askedE.id,
      ordinal: 1,
      requestId: downloadRequest,
    });
    assert.equal(
      file.storageKey,
      `exports/v1/${orgE.organizationId}/${askedE.id}/polaris-dados-${today}.zip`
    );
    for (const [userId, exportId, label] of [
      [orgOther.userId, askedE.id, "someone else"],
      [stranger, askedE.id, "a user without an organization"],
      [orgE.userId, randomUUID(), "an export that does not exist"],
    ] as const) {
      await assert.rejects(
        () =>
          getClosedDataExportDownload(runtimeDb, userId, {
            exportId,
            ordinal: 1,
          }),
        (error: unknown) =>
          error instanceof TenantAuthorizationError &&
          error.code === "tenant_access_denied",
        `${label}: the same refusal`
      );
    }
    await assert.rejects(
      () =>
        getClosedDataExportDownload(runtimeDb, orgE.userId, {
          exportId: askedE.id,
          ordinal: 2,
        }),
      DataExportUnavailableError,
      "a file that does not exist"
    );
    await assert.rejects(
      () =>
        getClosedDataExportDownload(runtimeDb, orgE.userId, {
          exportId: leftover.id,
          ordinal: 1,
        }),
      DataExportUnavailableError,
      "an export that is not a closed one"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET expires_at = now() - interval '1 second' WHERE id = $1",
      [askedE.id]
    );
    await assert.rejects(
      () =>
        getClosedDataExportDownload(runtimeDb, orgE.userId, {
          exportId: askedE.id,
          ordinal: 1,
        }),
      DataExportUnavailableError,
      "an expired one"
    );
    assert.deepEqual(
      (await auditOf(askedE.id)).map((row) => [
        row.event_type,
        row.actor_user_id,
        row.request_id,
      ]),
      [
        ["data_export.requested", orgE.userId, requestIdE],
        ["data_export.ready", orgE.userId, null],
        ["data_export.downloaded", orgE.userId, downloadRequest],
      ],
      "asked, ready and downloaded once each, with IDs only"
    );
    tests.push(
      "the owner lists the copies of a closed organization (files only for a closed one that is ready) and downloads its file, audited once with IDs only; someone else, a user without an organization and an export that does not exist get the same refusal (tenant_access_denied), and inside the organization a missing file, an export asked before the closure and an expired copy get the same one (not available)"
    );

    // ------------------------------------------------- 10. the privacy owner's new functions
    const owned = await ownerQuery<{
      config: string[];
      definer: boolean;
      owner: string;
      signature: string;
      volatility: string;
    }>(
      `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS signature, pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS definer, p.proconfig AS config, p.provolatile AS volatility
         FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`,
      [PRIVACY_OWNER_FUNCTIONS.map((signature) => `public.${signature}`)]
    );
    assert.equal(owned.length, PRIVACY_OWNER_FUNCTIONS.length);
    for (const row of owned) {
      assert.equal(
        row.owner,
        "polaris_privacy_owner",
        `${row.signature} belongs to the privacy owner`
      );
      assert.equal(row.definer, true, `${row.signature} is SECURITY DEFINER`);
      assert.deepEqual(
        row.config,
        ["search_path=pg_catalog, public, pg_temp"],
        `${row.signature} pins its search_path`
      );
    }
    const grantees = await ownerQuery<{ grantee: string; signature: string }>(
      `SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS signature,
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee
         FROM pg_proc p, LATERAL aclexplode(p.proacl) acl
        WHERE p.oid = ANY ($1::regprocedure[]) AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner
        ORDER BY 1, 2`,
      [
        [
          ...PRIVACY_OWNER_FUNCTIONS,
          "start_data_export_run(data_exports,integer)",
          "closure_deadlines(timestamp with time zone,text)",
          "closure_local_day_start(date,text)",
          "closure_phase_at(timestamp with time zone,timestamp with time zone,text,timestamp with time zone)",
        ].map((signature) => `public.${signature}`),
      ]
    );
    assert.deepEqual(
      grantees.map((row) => `${row.signature}:${row.grantee}`),
      [
        "closed_export_download(uuid,integer,uuid):polaris_pr11_runtime",
        "closed_export_organization():polaris_closed_export_reader",
        "closed_organization_status(text):polaris_pr11_runtime",
        "closure_deadlines(timestamp with time zone,text):polaris_privacy_owner",
        // the automatic schedule of the purge reads D the same way (ADR 0102)
        "closure_deadlines(timestamp with time zone,text):polaris_purge_owner",
        "closure_local_day_start(date,text):polaris_privacy_owner",
        "closure_local_day_start(date,text):polaris_purge_owner",
        "closure_phase_at(timestamp with time zone,timestamp with time zone,text,timestamp with time zone):polaris_privacy_owner",
        "list_closed_data_exports(text):polaris_pr11_runtime",
        "list_closed_export_media(uuid,uuid,uuid,integer):polaris_privacy_runtime",
        "list_my_closed_organizations():polaris_pr11_runtime",
        "request_closed_data_export(text,text[],uuid):polaris_pr11_runtime",
      ],
      "each function is executed by its one caller, and never by PUBLIC"
    );
    tests.push(
      "the seven new SECURITY DEFINER functions belong to the privacy owner, pin search_path to pg_catalog, public, pg_temp and are executed only by their caller (the reader its scope, the request runtime the state, the request, the list and the download, the privacy runtime the images of its run); the date functions and the start of a run are executed by the privacy owner only; none by PUBLIC"
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
    await privacyDb?.pool.end().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    await owner.pool
      .query(
        "DELETE FROM public.organization_purges WHERE organization_id = ANY ($1)",
        [created]
      )
      .catch(() => undefined);
    await owner.pool
      .query(
        "UPDATE public.organizations SET status = 'closed' WHERE id = ANY ($1) AND status = 'purge_pending'",
        [created]
      )
      .catch(() => undefined);
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Closed organization read-only PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
