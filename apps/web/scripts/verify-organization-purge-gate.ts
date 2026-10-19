import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cancelOrganizationPurge,
  closeSupportCase,
  grantTenantAccess,
  listOrganizationLegalHolds,
  openPrivacyCase,
  openSupportCase,
  placeOrganizationLegalHold,
  recordPrivacyAction,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  releaseOrganizationLegalHold,
  resolvePrivacyCase,
  revokeTenantAccess,
  scheduleOrganizationPurge,
} from "@polaris/db/admin-support-repository";
import { createDatabase } from "@polaris/db/client";
import { createCustomer } from "@polaris/db/customer-repository";
import { requestDataExport } from "@polaris/db/data-export-repository";
import { requestOrganizationClosure } from "@polaris/db/organization-closure-repository";
import { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import {
  PURGE_BILLING_FACT_KEYS,
  PURGE_CASCADED_TABLES,
  PURGE_DELETE_ORDER,
  PURGE_REMOVED_TEXT,
  PURGE_SURVIVING_TABLES,
  PURGE_TABLES_WITHOUT_TENANT_DATA,
} from "@polaris/db/purge-datasets";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { PRIVACY_DATA_CATEGORIES } from "@polaris/domain/admin/privacy-case";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import { mediaDerivativeKey } from "@polaris/domain/catalog/media";
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
 * changes nothing; and an export cannot leave a copy of an organization that is no longer active. The
 * decisions of 18/10/2026: the purge refuses a closure younger than 90 days and a legal hold, with nothing
 * removed; the billing events stay pseudonymized (the payer's data out of the fact, the provider's references
 * kept); the cases and the entitlement grants stay without their free text.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const REMOVED_NAME = "Organização removida";

/** What a payer's data looks like in a fact a provider adapter could have let through. */
const PAYER_FACT = Object.freeze({
  address: "Rua das Flores, 10, Recife",
  cpfCnpj: "123.456.789-09",
  customerId: "cus_000000gate",
  customerName: "Maria Pagadora",
  email: "maria.pagadora@example.invalid",
  phone: "+55 81 99999-0000",
});

/**
 * The contacts typed in the free texts below, whole, hyphen included. The search for what survived uses them
 * whole: a short run of digits ("98888") also shows up by chance inside a UUID or a timestamp.
 */
const CASE_PHONE = "98888-7777";
const GRANT_PHONE = "97777-6666";

/** The same contacts with only the digits (988887777), the form a copy or a search index may keep. */
const digitsOnly = (value: string) => value.replace(/\D/g, "");

/** Free text an operator could have typed in a case, with someone's contact in it. */
const CASE_TEXT = `Dono ligou de 81 ${CASE_PHONE} (Joana)`;

/** The reason an operator typed when giving an entitlement grant: free text, with someone's contact in it. */
const GRANT_REASON = `Compensação combinada com Rita (81 ${GRANT_PHONE})`;

/** The call is refused with this code (SQLSTATE 55000), and nothing else. */
async function expectBlocked(
  operation: () => Promise<unknown>,
  code: string,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof Error &&
      error.message === code &&
      (error as { code?: string }).code === "55000",
    label
  );
}

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

interface BillingRow {
  fact: Record<string, unknown>;
  fact_type: string;
  occurred_at: string;
  provider_event_id: string;
  provider_ref: string | null;
}

/**
 * Every billing event stays, with its columns, and its fact keeps only what the lifecycle wrote. The provider's
 * references stay too: they are why this is pseudonymization, not anonymization.
 */
function expectBillingPseudonymized(before: BillingRow[], after: BillingRow[]) {
  assert.equal(after.length, before.length);
  assert.ok(after.length >= 2);
  for (const [index, row] of after.entries()) {
    const earlier = before[index];
    assert.ok(earlier);
    assert.equal(row.provider_event_id, earlier.provider_event_id);
    assert.equal(row.provider_ref, earlier.provider_ref);
    assert.equal(row.fact_type, earlier.fact_type);
    assert.equal(row.occurred_at, earlier.occurred_at);
    const kept = Object.fromEntries(
      Object.entries(earlier.fact).filter(
        ([key, value]) =>
          (PURGE_BILLING_FACT_KEYS as readonly string[]).includes(key) &&
          ["boolean", "number", "string"].includes(typeof value)
      )
    );
    assert.deepEqual(row.fact, kept, "the fact keeps what the lifecycle wrote");
  }
}

/**
 * A grant written while a purge still holds the organization waits for it and loses its text: the trigger must
 * not decide from the state the organization had when the statement began.
 */
async function expectGrantWrittenDuringPurgeLosesText(
  pool: Parameters<typeof queryAs>[0] &
    Parameters<typeof createTenantFixture>[0],
  suffix: string
) {
  const racing = await createTenantFixture(pool, `race ${suffix}`);
  await pool.query(
    "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1",
    [racing.organizationId]
  );
  const purging = await pool.connect();
  try {
    await purging.query("BEGIN");
    await purging.query(
      "SELECT 1 FROM public.organizations WHERE id = $1 FOR UPDATE",
      [racing.organizationId]
    );
    const racingGrant = queryAs(
      pool,
      "polaris_billing_runtime",
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at)
       VALUES ($1, 'goals.active.max', 70, $2, 'admin:gate', now(), now() + interval '1 day') RETURNING reason`,
      [racing.organizationId, GRANT_REASON]
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await purging.query(
      "UPDATE public.organizations SET status = 'purged' WHERE id = $1",
      [racing.organizationId]
    );
    await purging.query("COMMIT");
    assert.equal(
      (await racingGrant).rows[0]?.reason,
      PURGE_REMOVED_TEXT,
      "a grant written during the purge ends up with the fixed text"
    );
  } finally {
    await purging.query("ROLLBACK").catch(() => undefined);
    purging.release();
  }
}

/** The review date of a legal hold: required and bounded, renewed only forward and never by a release in between. */
async function expectReviewDateRules(context: {
  admin: Parameters<typeof placeOrganizationLegalHold>[0];
  caseId: string;
  pool: Parameters<typeof createTenantFixture>[0];
  principal: string;
  target: string;
  witness: string;
}) {
  const { admin, caseId, pool, principal, target, witness } = context;
  const reviewIn = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();
  // the review date is required, in the future and at most 366 days away: nothing is written otherwise
  await Promise.all(
    [reviewIn(-1), new Date().toISOString(), reviewIn(367)].map((reviewAt) =>
      assert.rejects(
        () =>
          placeOrganizationLegalHold(
            admin,
            principal,
            caseId,
            target,
            reviewAt
          ),
        (error: unknown) =>
          error instanceof InvalidSupportRequestError &&
          error.code === "invalid_review_at",
        `a review date of ${reviewAt} is refused`
      )
    )
  );
  await expectSqlState(
    () =>
      pool.query(
        "INSERT INTO public.organization_legal_holds (organization_id, support_case_id, placed_by, review_at) VALUES ($1, $2, $3, now() - interval '1 day')",
        [witness, caseId, principal]
      ),
    "23514",
    "the table itself refuses a review date before the hold was placed"
  );
  await expectSqlState(
    () =>
      pool.query(
        "INSERT INTO public.organization_legal_holds (organization_id, support_case_id, placed_by) VALUES ($1, $2, $3)",
        [witness, caseId, principal]
      ),
    "23502",
    "a hold has no row without its review date"
  );
  assert.equal(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.organization_legal_holds WHERE organization_id = $1",
        [witness]
      )
    ).rows[0]?.count,
    "0",
    "no hold was written for the witness"
  );
  // placing again with an earlier or equal date changes nothing; with a later one it renews the hold, in one step
  const reviewOf = async () =>
    (
      await pool.query<{ id: string; review_at: string }>(
        "SELECT id, review_at::text FROM public.organization_legal_holds WHERE organization_id = $1 AND released_at IS NULL",
        [target]
      )
    ).rows;
  const heldBefore = await reviewOf();
  assert.equal(heldBefore.length, 1);
  assert.deepEqual(
    await placeOrganizationLegalHold(
      admin,
      principal,
      caseId,
      target,
      reviewIn(5)
    ),
    { changed: false, held: true, renewed: false, storageTouched: false }
  );
  assert.deepEqual(
    await reviewOf(),
    heldBefore,
    "an earlier date keeps the review date"
  );
  assert.deepEqual(
    await placeOrganizationLegalHold(
      admin,
      principal,
      caseId,
      target,
      reviewIn(300)
    ),
    { changed: true, held: true, renewed: true, storageTouched: false }
  );
  const renewedHold = await reviewOf();
  assert.equal(renewedHold.length, 1);
  assert.equal(renewedHold[0]?.id, heldBefore[0]?.id, "the same hold, renewed");
  assert.ok(
    Date.parse(renewedHold[0]?.review_at ?? "") >
      Date.parse(heldBefore[0]?.review_at ?? ""),
    "a later date renews the hold"
  );
  // nobody moves the review date back, not even the table's owner, and the hold is never released by a renewal
  await expectSqlState(
    () =>
      pool.query(
        "UPDATE public.organization_legal_holds SET review_at = review_at - interval '1 day' WHERE organization_id = $1 AND released_at IS NULL",
        [target]
      ),
    "23514",
    "a review date only moves forward"
  );
}

/** Runs one statement as a role, in a transaction that is always undone, and returns its result. */
async function queryAs(
  pool: {
    connect: () => Promise<{
      query: (
        statement: string,
        values?: unknown[]
      ) => Promise<{ rows: { reason?: string }[] }>;
      release: () => void;
    }>;
  },
  role: string,
  statement: string,
  values: unknown[]
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(statement, values);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * Moves the hold in force into the past (placed 40 days ago, review date yesterday): the trigger that keeps a hold
 * as it was is off for this one statement, which only the table's owner can do.
 */
async function makeHoldOverdue(
  pool: { query: (statement: string, values?: unknown[]) => Promise<unknown> },
  organizationId: string
) {
  await pool.query(
    "ALTER TABLE public.organization_legal_holds DISABLE TRIGGER organization_legal_holds_release_is_final"
  );
  try {
    await pool.query(
      "UPDATE public.organization_legal_holds SET placed_at = now() - interval '40 days', review_at = now() - interval '1 day' WHERE organization_id = $1 AND released_at IS NULL",
      [organizationId]
    );
  } finally {
    await pool.query(
      "ALTER TABLE public.organization_legal_holds ENABLE TRIGGER organization_legal_holds_release_is_final"
    );
  }
}

/**
 * The history of cancellations is append-only: the owner of the Admin functions has no grant to change or
 * delete a row, and a trigger refuses it for everyone else, the table's owner included.
 */
async function expectCancellationsAppendOnly(pool: {
  connect: () => Promise<{
    query: (statement: string) => Promise<unknown>;
    release: () => void;
  }>;
  query: (statement: string) => Promise<unknown>;
}) {
  for (const statement of [
    "UPDATE public.organization_purge_cancellations SET reason = 'outro'",
    "DELETE FROM public.organization_purge_cancellations",
    "TRUNCATE public.organization_purge_cancellations",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: three probes, in order.
    await expectSqlState(
      () => pool.query(statement),
      "23514",
      `the trigger keeps the history append-only for the table's owner: ${statement}`
    );
  }
  for (const statement of [
    "UPDATE public.organization_purge_cancellations SET reason = 'outro'",
    "DELETE FROM public.organization_purge_cancellations",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: two probes, in order.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE polaris_admin_owner");
      await expectSqlState(
        () => client.query(statement),
        "42501",
        `the history is append-only: ${statement}`
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
}

/**
 * A run marks the storage as touched in a transaction that is still open while a cancellation, started after
 * the lease ended, waits for the purge row the mark holds. Returns how the cancellation ended once the mark
 * committed; it has not ended before.
 */
async function raceCancellationAgainstMark(
  pool: {
    connect: () => Promise<{
      query: (statement: string, values?: unknown[]) => Promise<unknown>;
      release: () => void;
    }>;
  },
  organizationId: string,
  cancel: () => Promise<unknown>
): Promise<unknown> {
  const marker = await pool.connect();
  let settled = false;
  let outcome: Promise<unknown>;
  try {
    await marker.query("BEGIN");
    await marker.query(
      "SELECT public.mark_organization_purge_storage_touched($1)",
      [organizationId]
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    outcome = cancel().then(
      () => {
        settled = true;
        return "cancelled";
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      settled,
      false,
      "the cancellation waits for the row the mark holds"
    );
    await marker.query("COMMIT");
  } catch (error) {
    await marker.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    marker.release();
  }
  return await outcome;
}

/** The audit rows of the organization to purge cover both classes, so the purge is proved to keep each. */
function hasBothAuditClasses(rows: { event_class: string }[]) {
  const classes = new Set(rows.map((row) => row.event_class));
  return classes.has("security") && classes.has("operational");
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
    // the tables of the queues and the scheduler that have no organization: they exist, and still have none
    const withoutOrganization = await owner.pool.query<{
      has_organization: boolean;
      table_name: string;
    }>(
      `SELECT t AS table_name,
              EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
                       WHERE a.attrelid = ('public.' || t)::regclass AND a.attname = 'organization_id'
                         AND NOT a.attisdropped) AS has_organization
         FROM unnest($1::text[]) AS t ORDER BY 1`,
      [Object.keys(PURGE_TABLES_WITHOUT_TENANT_DATA)]
    );
    assert.deepEqual(withoutOrganization.rows, [
      { has_organization: false, table_name: "auth_access_log" },
      { has_organization: false, table_name: "device_sessions" },
      { has_organization: false, table_name: "operational_incidents" },
      { has_organization: false, table_name: "scheduled_job_state" },
    ]);
    tests.push(
      "every table with an organization is either removed by the purge (the dead-letter items too) or kept with a written reason, and the access log, device session, incident and scheduler tables have no organization"
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
    // in what survives, the purge owner reaches only the columns of the decisions of 18/10/2026: the billing fact,
    // the free text of the cases and of the cancellations, whether a legal hold is in force, the purge tombstones
    const survivorColumns = await owner.pool.query<{ grant: string }>(
      `SELECT table_name || '.' || column_name || ':' || privilege_type AS grant
         FROM information_schema.column_privileges
        WHERE grantee = 'polaris_purge_owner' AND table_schema = 'public'
          AND table_name = ANY ($1::text[])
        ORDER BY 1`,
      [
        [
          "billing_events",
          "deletion_ledger",
          "entitlement_grants",
          "organization_legal_holds",
          "organization_purge_cancellations",
          "privacy_cases",
          "support_cases",
        ],
      ]
    );
    assert.deepEqual(
      survivorColumns.rows.map((row) => row.grant),
      [
        "billing_events.fact:SELECT",
        "billing_events.fact:UPDATE",
        "billing_events.id:SELECT",
        "billing_events.organization_id:SELECT",
        "deletion_ledger.entity_id:INSERT",
        "deletion_ledger.entity_id:SELECT",
        "deletion_ledger.entity_type:INSERT",
        "deletion_ledger.entity_type:SELECT",
        "deletion_ledger.operation:INSERT",
        "deletion_ledger.operation:SELECT",
        "deletion_ledger.organization_id:INSERT",
        "deletion_ledger.organization_id:SELECT",
        "deletion_ledger.privacy_case_id:INSERT",
        "entitlement_grants.id:SELECT",
        "entitlement_grants.organization_id:SELECT",
        "entitlement_grants.reason:SELECT",
        "entitlement_grants.reason:UPDATE",
        "organization_legal_holds.organization_id:SELECT",
        "organization_legal_holds.released_at:SELECT",
        "organization_purge_cancellations.organization_id:SELECT",
        "organization_purge_cancellations.reason:SELECT",
        "organization_purge_cancellations.reason:UPDATE",
        "privacy_cases.decision_note:SELECT",
        "privacy_cases.decision_note:UPDATE",
        "privacy_cases.note:SELECT",
        "privacy_cases.note:UPDATE",
        "privacy_cases.support_case_id:SELECT",
        "support_cases.context:SELECT",
        "support_cases.context:UPDATE",
        "support_cases.id:SELECT",
        "support_cases.organization_id:SELECT",
        "support_cases.reason:SELECT",
        "support_cases.reason:UPDATE",
        "support_cases.resolution:SELECT",
        "support_cases.resolution:UPDATE",
      ],
      "the purge owner reaches only these columns of what survives"
    );
    // the history of cancellations is the Admin owner's alone: it reads and appends, and nobody else touches it
    const historyAccess = await owner.pool.query<{
      grantee: string;
      privilege: string;
    }>(
      `SELECT r.rolname AS grantee, p.privilege
         FROM unnest($1::text[]) AS r(rolname)
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
        WHERE has_table_privilege(r.rolname, 'public.organization_purge_cancellations', p.privilege)
        ORDER BY 1, 2`,
      [
        [
          "polaris_admin_owner",
          "polaris_admin_runtime",
          "polaris_billing_runtime",
          "polaris_catalog_runtime",
          "polaris_pr11_runtime",
          "polaris_privacy_owner",
          "polaris_privacy_runtime",
          "polaris_purge_owner",
        ],
      ]
    );
    assert.deepEqual(historyAccess.rows, [
      { grantee: "polaris_admin_owner", privilege: "INSERT" },
      { grantee: "polaris_admin_owner", privilege: "SELECT" },
    ]);
    const executors = await owner.pool.query<{
      fn: string;
      grantee: string;
    }>(
      `SELECT p.proname AS fn, r.rolname AS grantee
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
         JOIN pg_catalog.pg_roles AS r ON r.oid = acl.grantee
        WHERE p.proname IN ('claim_organization_purge', 'list_organization_purge_media', 'purge_organization_data',
                            'record_organization_purge_failure', 'complete_organization_purge_sweep', 'admin_schedule_organization_purge',
                            'admin_cancel_organization_purge', 'mark_organization_purge_storage_touched',
                            'admin_place_organization_legal_hold', 'admin_release_organization_legal_hold',
                            'admin_list_organization_legal_holds',
                            'organization_purge_blocker')
          AND acl.privilege_type = 'EXECUTE' AND r.rolname NOT IN ('polaris_purge_owner', 'polaris_admin_owner')
        ORDER BY 1, 2`
    );
    for (const row of executors.rows) {
      assert.notEqual(
        row.fn,
        "organization_purge_blocker",
        "the blocker is internal to the purge functions"
      );
      assert.equal(
        row.grantee,
        row.fn.startsWith("admin_")
          ? "polaris_admin_runtime"
          : "polaris_privacy_runtime",
        `${row.fn} is executed only by its runtime`
      );
    }
    tests.push(
      "the purge owner deletes only the purged tables; of what survives it reaches only the billing fact, the free text of the cases and cancellations, whether a hold is in force and the purge tombstones; only the privacy runtime runs the purge and only the Admin runtime places a legal hold"
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
      // the queue consumer's record of an event it processed: opaque IDs, the purge takes it with the rest
      await owner.pool.query(
        "INSERT INTO public.queue_processing (organization_id, idempotency_key, event_id, attempt, state) VALUES ($1, $2, $3, 1, 'done')",
        [tenant.organizationId, `gate:${randomUUID()}`, randomUUID()]
      );
      // a dead event of the organization (ADR 0085): the cascade never fires, so the purge deletes it itself
      const incident = await owner.pool.query<{ id: string }>(
        `INSERT INTO public.operational_incidents (kind, cause, subject) VALUES ('queue_dead_letter', 'retries_exhausted', $1)
         ON CONFLICT (kind, cause, subject) DO UPDATE SET occurrence_count = operational_incidents.occurrence_count + 1
         RETURNING id`,
        [`gate.purge_${suffix}`]
      );
      await owner.pool.query(
        "INSERT INTO public.queue_dead_letters (event_id, event_type, incident_id, organization_id) VALUES ($1, 'gate.purge_probe', $2, $3)",
        [randomUUID(), incident.rows[0]?.id, tenant.organizationId]
      );
      // a charge whose fact carries the payer (a provider adapter that let it through), and a command without
      const billingFact = {
        ...PAYER_FACT,
        cycleMonths: 1,
        occurredAt: "2026-09-01T12:00:00.000Z",
        periodEndsAt: "2026-10-01T12:00:00.000Z",
        // a kept key whose value is not a plain value goes too (a nested payer)
        transition: { payer: PAYER_FACT.customerName },
        type: "charge_succeeded",
      };
      await owner.pool.query(
        `INSERT INTO public.billing_events (provider, provider_event_id, provider_ref, organization_id, fact, fact_type, occurred_at, status, processed_at)
         VALUES ('gate', $1, $2, $3, $4::jsonb, 'charge_succeeded', '2026-09-01T12:00:00Z', 'applied', now()),
                ('gate', $5, NULL, $3, '{"type":"start_trial"}'::jsonb, 'command', '2026-08-01T12:00:00Z', 'applied', now())`,
        [
          `gate-charge-${randomUUID()}`,
          `sub_${suffix}`,
          tenant.organizationId,
          JSON.stringify(billingFact),
          `gate-command-${randomUUID()}`,
        ]
      );
      // a temporary grant with the reason the operator typed (the grant stays, its reason does not)
      await owner.pool.query(
        `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at)
         VALUES ($1, 'variants.active.max', 3000, $2, 'admin:gate', now() - interval '1 day', now() + interval '2 days')`,
        [tenant.organizationId, `${GRANT_REASON} ${suffix}`]
      );
      return { assetId, storageKey };
    };
    const targetMedia = await populate(target, `alvo-${suffix}`);
    const witnessMedia = await populate(witness, `testemunha-${suffix}`);
    tests.push(
      "both organizations hold products, stock movements, a sale, a customer, an image of a removed product, the queue consumer's record of an event, a dead event and billing events (one fact with the payer's data)"
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

    // every case this gate opens is a support case of the organization (a privacy case is one too): they all
    // survive the purge, and the count at the end is the number opened, not a number written by hand
    let casesOpened = 0;
    // a privacy case asks for it; a support case is opened too (both must survive)
    const privacyCase = await openPrivacyCase(admin, principal, {
      channel: "email",
      dueDays: 15,
      note: CASE_TEXT,
      organizationId: target.organizationId,
      reason: "Pedido de exclusão da organização",
      receivedAt: null,
      requesterKind: "organization_owner",
      requestType: "deletion",
    });
    assert.ok(privacyCase);
    casesOpened += 1;
    const supportCase = await openSupportCase(admin, principal, {
      context: CASE_TEXT,
      kind: "support",
      organizationId: target.organizationId,
      reason: "Acompanhar o purge",
    });
    assert.ok(supportCase);
    casesOpened += 1;
    // a case closed with a resolution: closed is final for everyone but the purge taking its text out
    const closedCase = await openSupportCase(admin, principal, {
      context: CASE_TEXT,
      kind: "support",
      organizationId: target.organizationId,
      reason: `Atendimento de ${CASE_TEXT}`,
    });
    assert.ok(closedCase);
    casesOpened += 1;
    await closeSupportCase(admin, principal, closedCase.id, CASE_TEXT);
    // the witness's case keeps its text
    const witnessCase = await openSupportCase(admin, principal, {
      context: CASE_TEXT,
      kind: "support",
      organizationId: witness.organizationId,
      reason: `Atendimento de ${CASE_TEXT}`,
    });
    assert.ok(witnessCase);
    await closeSupportCase(admin, principal, witnessCase.id, CASE_TEXT);

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
      casesOpened += 1;
      return opened.id;
    };
    const driveCase = async (
      caseId: string,
      steps: {
        categories?: string[];
        decision?: "accept" | "partially_accept" | "reject";
        identity?: "failed" | "verified";
        note?: string;
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
          note: steps.note ?? null,
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
    await driveCase(privacyCase.id, { decision: "accept", note: CASE_TEXT });

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
      "UPDATE public.organization_closures SET requested_at = now() - interval '91 days', recover_until = now() - interval '1 day' WHERE organization_id = $1",
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
      "UPDATE public.organization_closures SET requested_at = now() - interval '89 days', recover_until = now() + interval '1 day' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "recovery_window_open",
      "the recovery window must be over"
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '91 days', recover_until = now() - interval '1 day' WHERE organization_id = $1",
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
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() - interval '1 day', provider_ref = $2 WHERE organization_id = $1",
      [target.organizationId, `sub_org_${randomUUID()}`]
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
    // the closure period (decision of 19/10/2026, 90 days): a window that ended early does not shorten it, and the
    // old period of 30 days is no longer enough; the day before the 90th is still refused
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '31 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "closure_period_not_elapsed",
      "an organization closed 31 days ago"
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '89 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectRefusal(
      privacyCase.id,
      "closure_period_not_elapsed",
      "an organization closed 89 days ago"
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '91 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    // a legal hold: placed under a case of the organization named, audited, and while in force no schedule
    const reviewIn = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();
    const firstReview = reviewIn(30);
    const legalHold = (action: "place" | "release", organizationId: string) =>
      action === "place"
        ? placeOrganizationLegalHold(
            admin,
            principal,
            supportCase.id,
            organizationId,
            firstReview
          )
        : releaseOrganizationLegalHold(
            admin,
            principal,
            supportCase.id,
            organizationId
          );
    await assert.rejects(
      () => legalHold("place", witness.organizationId),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "organization_mismatch",
      "a hold names the case's organization"
    );
    assert.deepEqual(await legalHold("place", target.organizationId), {
      changed: true,
      held: true,
      renewed: false,
      storageTouched: false,
    });
    assert.deepEqual(await legalHold("place", target.organizationId), {
      changed: false,
      held: true,
      renewed: false,
      storageTouched: false,
    });
    await expectReviewDateRules({
      admin,
      caseId: supportCase.id,
      pool: owner.pool,
      principal,
      target: target.organizationId,
      witness: witness.organizationId,
    });
    // the list of the holds in force (read only): this one, not yet due for review
    const listedHolds = await listOrganizationLegalHolds(admin, {
      after: null,
      limit: 50,
    });
    const listedTarget = listedHolds.holds.find(
      (hold) => hold.organizationId === target.organizationId
    );
    assert.ok(listedTarget, "the hold in force is listed");
    assert.equal(listedTarget.reviewDue, false);
    assert.equal(listedTarget.supportCaseId, supportCase.id);
    assert.equal(listedTarget.placedBy, principal);
    assert.equal(
      listedHolds.holds.some(
        (hold) => hold.organizationId === witness.organizationId
      ),
      false
    );
    const dueBefore = listedHolds.dueForReview;
    // past its review date the hold is due for review, still in force: nothing releases it, the purge still waits
    await makeHoldOverdue(owner.pool, target.organizationId);
    const overdue = await listOrganizationLegalHolds(admin, {
      after: null,
      limit: 50,
    });
    assert.equal(
      overdue.holds.find(
        (hold) => hold.organizationId === target.organizationId
      )?.reviewDue,
      true,
      "a hold past its review date is listed as due for review"
    );
    assert.equal(overdue.dueForReview, dueBefore + 1);
    assert.equal(
      (
        await owner.pool.query<{ held: boolean }>(
          "SELECT (released_at IS NULL) AS held FROM public.organization_legal_holds WHERE organization_id = $1 AND placed_at < now() - interval '39 days'",
          [target.organizationId]
        )
      ).rows[0]?.held,
      true,
      "a hold past its review date is still in force"
    );
    await expectRefusal(
      privacyCase.id,
      "legal_hold_active",
      "an organization whose legal hold is past its review date"
    );
    await expectSqlState(
      () =>
        admin.query(
          "SELECT public.admin_list_organization_legal_holds(0, NULL)"
        ),
      "22023",
      "the list refuses an empty page"
    );
    // the page: one at a time, newest first, and the cursor reaches the rest
    const firstPage = await listOrganizationLegalHolds(admin, {
      after: null,
      limit: 1,
    });
    assert.equal(firstPage.holds.length, 1);
    assert.equal(firstPage.dueForReview, overdue.dueForReview);
    await expectRefusal(
      privacyCase.id,
      "legal_hold_active",
      "an organization under a legal hold"
    );
    assert.deepEqual(await legalHold("release", target.organizationId), {
      changed: true,
      held: false,
    });
    assert.deepEqual(await legalHold("release", target.organizationId), {
      changed: false,
      held: false,
    });
    const holdAudit = await owner.pool.query<{
      detail: string | null;
      entity_type: string;
      event_type: string;
    }>(
      "SELECT event_type, entity_type, detail FROM public.platform_audit_events WHERE organization_id = $1 AND event_type LIKE 'organization.legal_hold_%' ORDER BY id",
      [target.organizationId]
    );
    assert.deepEqual(holdAudit.rows, [
      {
        detail: null,
        entity_type: "organization_legal_hold",
        event_type: "organization.legal_hold_placed",
      },
      {
        detail: null,
        entity_type: "organization_legal_hold",
        event_type: "organization.legal_hold_reviewed",
      },
      {
        detail: null,
        entity_type: "organization_legal_hold",
        event_type: "organization.legal_hold_released",
      },
    ]);
    // a released hold is final, and no hold is deleted, not even by the table's owner
    for (const statement of [
      "UPDATE public.organization_legal_holds SET released_at = NULL, released_by = NULL WHERE organization_id = $1",
      "DELETE FROM public.organization_legal_holds WHERE organization_id = $1",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: two probes, in order.
      await expectSqlState(
        () => owner.pool.query(statement, [target.organizationId]),
        "23514",
        `a legal hold stays on record: ${statement}`
      );
    }
    tests.push(
      "the schedule refuses an active or closing organization, an open window, a closure younger than 90 days, a legal hold in force, paid access running, a live temporary access and an unknown case; a hold is placed and released under a case, audited without text, and stays on record"
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
      // an accepted deletion whose scope leaves one tenant category out
      // biome-ignore lint/performance/noAwaitInLoops: each case is opened and refused in turn.
      const narrow = await openDeletion();
      await driveCase(narrow, {
        categories: ORGANIZATION_PURGE_REQUIRED_SCOPE.filter(
          (category) => category !== missing
        ),
        decision: "accept",
      });
      await expectRefusal(
        narrow,
        "privacy_scope_incomplete",
        `an accepted deletion without ${missing} in its scope`
      );
    }
    // the scope is exactly what the purge removes: a case that also claims data the purge keeps would record
    // a decision the purge does not carry out, so it is refused with its own reason (never scheduled)
    const keptCategories = PRIVACY_DATA_CATEGORIES.filter(
      (category) =>
        !(ORGANIZATION_PURGE_REQUIRED_SCOPE as readonly string[]).includes(
          category
        )
    );
    assert.deepEqual([...keptCategories].sort(), [
      "account",
      "audit_logs",
      "authentication",
      "billing",
    ]);
    for (const kept of [
      ...keptCategories.map((category) => [category]),
      [...keptCategories],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case is opened and refused in turn.
      const wide = await openDeletion();
      await driveCase(wide, {
        categories: [...ORGANIZATION_PURGE_REQUIRED_SCOPE, ...kept],
        decision: "accept",
      });
      await expectRefusal(
        wide,
        "privacy_scope_covers_kept_data",
        `an accepted deletion whose scope also claims ${kept.join(" and ")}, which the purge keeps`
      );
    }
    // missing one category is the first thing said, even when the scope also claims data the purge keeps
    const both = await openDeletion();
    await driveCase(both, {
      categories: [...ORGANIZATION_PURGE_REQUIRED_SCOPE.slice(1), "billing"],
      decision: "accept",
    });
    await expectRefusal(
      both,
      "privacy_scope_incomplete",
      "a scope that misses a tenant category and claims billing"
    );
    assert.equal(
      (
        await owner.pool.query(
          "SELECT 1 FROM public.organization_purges WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rowCount,
      0,
      "no refused case left a purge behind"
    );
    tests.push(
      "the schedule refuses a plain support case, a privacy case that is not a deletion or not the owner's, a deletion that is undecided, refused or accepted only in part, one whose scope misses any single tenant category, and one whose scope also claims account, authentication or billing, which the purge keeps"
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
    await expectSqlState(
      () =>
        maintenance.markOrganizationPurgeStorageTouched(target.organizationId),
      "55000",
      "the storage is not marked as touched by a run that holds nothing"
    );
    await expectSqlState(
      () =>
        maintenance.markOrganizationPurgeStorageTouched(witness.organizationId),
      "55000",
      "nor for an active organization"
    );
    // A call that refuses (a `cancel`, a hold, a mark) raises inside a function that may hold the row of the purge; the
    // error can reach the client a moment before the abort releases that lock, and `claim_organization_purge` skips
    // a locked row (SKIP LOCKED), so a claim would answer `null` for a reason that is not the one under test. Taking
    // the lock here waits for the release, so the next claim does not depend on that timing.
    const purgeRowSettled = () =>
      owner.pool.query(
        "SELECT 1 FROM public.organization_purges WHERE organization_id = $1 FOR UPDATE",
        [target.organizationId]
      );
    await purgeRowSettled();
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
    await purgeRowSettled();
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

    // the run refuses too (decisions of 18/10/2026): a legal hold placed after the schedule, or a closure younger
    // than 90 days, keeps the claim away; a run that already holds the purge touches neither storage nor rows
    const holdLease = () =>
      owner.pool.query(
        "UPDATE public.organization_purges SET locked_until = now() + interval '15 minutes' WHERE organization_id = $1",
        [target.organizationId]
      );
    const dropLease = () =>
      owner.pool.query(
        "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
        [target.organizationId]
      );
    const salesLeft = async () =>
      (
        await owner.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.sales WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rows[0]?.count;
    const salesBeforeRefusals = await salesLeft();
    assert.ok(Number(salesBeforeRefusals) > 0);
    await placeOrganizationLegalHold(
      admin,
      principal,
      supportCase.id,
      target.organizationId,
      new Date(Date.now() + 30 * 86_400_000).toISOString()
    );
    await purgeRowSettled();
    assert.equal(
      await maintenance.claimOrganizationPurge(900),
      null,
      "a purge under a legal hold is not taken"
    );
    await holdLease();
    await expectBlocked(
      () =>
        maintenance.markOrganizationPurgeStorageTouched(target.organizationId),
      "legal_hold_active",
      "a run under a legal hold does not touch the storage"
    );
    await expectBlocked(
      () => maintenance.purgeOrganizationData(target.organizationId),
      "legal_hold_active",
      "nor the rows"
    );
    await dropLease();
    await releaseOrganizationLegalHold(
      admin,
      principal,
      supportCase.id,
      target.organizationId
    );
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '89 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    await purgeRowSettled();
    assert.equal(
      await maintenance.claimOrganizationPurge(900),
      null,
      "a purge of a closure younger than 90 days is not taken"
    );
    await holdLease();
    await expectBlocked(
      () =>
        maintenance.markOrganizationPurgeStorageTouched(target.organizationId),
      "closure_period_not_elapsed",
      "a run before the 90 days does not touch the storage"
    );
    await expectBlocked(
      () => maintenance.purgeOrganizationData(target.organizationId),
      "closure_period_not_elapsed",
      "nor the rows"
    );
    await dropLease();
    await owner.pool.query(
      "UPDATE public.organization_closures SET requested_at = now() - interval '91 days' WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.equal(await salesLeft(), salesBeforeRefusals, "nothing was removed");
    const untouched = await owner.pool.query<{
      attempts: number;
      touched: boolean;
    }>(
      "SELECT attempts, storage_touched_at IS NOT NULL AS touched FROM public.organization_purges WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.deepEqual(untouched.rows[0], { attempts: 0, touched: false });
    tests.push(
      "a scheduled purge under a legal hold, or whose closure is younger than 90 days, is not claimed, and a run holding it is refused with the code before touching the storage or the rows: nothing is removed"
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
    // the audit of the tenant is not in the purge (ADR 0081, amended 19/10/2026): its rows are read by ID, before and after
    const auditRows = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{ event_class: string; id: string }>(
          "SELECT id, event_class FROM public.tenant_audit_event WHERE organization_id = $1 ORDER BY id",
          [tenant.organizationId]
        )
      ).rows;
    const witnessBefore = await counts(witness);
    const targetBefore = await counts(target);
    const witnessAuditBefore = await auditRows(witness);
    const targetAuditBefore = await auditRows(target);
    assert.ok(
      targetAuditBefore.length > 0,
      "the organization to purge has audit rows"
    );
    assert.ok(hasBothAuditClasses(targetAuditBefore), "of both classes");
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
      "data_exports",
      "event_outbox",
      "queue_processing",
      "queue_dead_letters",
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
          attempts: number;
          status: string;
          storage_touched: boolean;
        }>(
          `SELECT o.status, p.attempts, p.storage_touched_at IS NOT NULL AS storage_touched
             FROM public.organizations AS o JOIN public.organization_purges AS p ON p.organization_id = o.id
            WHERE o.id = $1`,
          [target.organizationId]
        )
      ).rows[0];
    // the history of cancellations: it keeps every reason, and a purge scheduled again does not touch it
    const cancellations = async () =>
      (
        await owner.pool.query<{
          cancelled_by: string;
          reason: string;
          support_case_id: string;
        }>(
          "SELECT reason, support_case_id, cancelled_by FROM public.organization_purge_cancellations WHERE organization_id = $1 ORDER BY cancelled_at, id",
          [target.organizationId]
        )
      ).rows;
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
    await purgeRowSettled();
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
      attempts: 1,
      status: "purge_pending",
      storage_touched: false,
    });
    assert.equal(await auditCount("organization.purge_cancelled"), "0");
    assert.deepEqual(await cancellations(), []);
    // the lease ends (the run died) before it reached the storage: the attempt alone does not stop the
    // cancellation, and any open case of the organization can cancel, a plain support case too
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
      attempts: 1,
      status: "closed",
      storage_touched: false,
    });
    assert.deepEqual(await cancellations(), [
      {
        cancelled_by: principal,
        reason: "Pedido retirado pelo dono",
        support_case_id: supportCase.id,
      },
    ]);
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
    await purgeRowSettled();
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
    // scheduled again under the deletion case: the purge record starts from nothing, the reason of the
    // cancellation stays in the history, and the audit shows both
    assert.deepEqual(
      { changed: (await schedule(privacyCase.id))?.changed },
      { changed: true }
    );
    assert.deepEqual(await purgeState(), {
      attempts: 0,
      status: "purge_pending",
      storage_touched: false,
    });
    assert.equal(await auditCount("organization.purge_scheduled"), "2");
    assert.equal(await auditCount("organization.purge_cancelled"), "1");
    assert.equal(
      (await cancellations())[0]?.reason,
      "Pedido retirado pelo dono",
      "scheduling again does not erase the reason"
    );
    // cancelled and scheduled once more: the history grows, in order, and the first reason is still there
    assert.deepEqual(await cancel(privacyCase.id, "Dono pediu mais um prazo"), {
      changed: true,
      status: "closed",
    });
    assert.deepEqual(
      (await cancellations()).map((row) => row.reason),
      ["Pedido retirado pelo dono", "Dono pediu mais um prazo"]
    );
    assert.deepEqual(
      { changed: (await schedule(privacyCase.id))?.changed },
      { changed: true }
    );
    assert.deepEqual(
      (await cancellations()).map((row) => row.reason),
      ["Pedido retirado pelo dono", "Dono pediu mais um prazo"]
    );
    assert.equal(await auditCount("organization.purge_scheduled"), "3");
    assert.equal(await auditCount("organization.purge_cancelled"), "2");
    // nobody rewrites the history: the owner of the Admin functions only reads and appends
    await expectCancellationsAppendOnly(owner.pool);
    // a run reaches the storage: written down before the first object goes, and from then on no cancellation
    await purgeRowSettled();
    const reached = await maintenance.claimOrganizationPurge(900);
    assert.equal(reached?.organizationId, target.organizationId);
    assert.deepEqual(await purgeState(), {
      attempts: 1,
      status: "purge_pending",
      storage_touched: false,
    });
    // the race: the run marks the storage while a cancellation, started after the lease ended, waits for the
    // purge row. The mark wins the row, so the cancellation reads it again and is refused
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '2 seconds' WHERE organization_id = $1",
      [target.organizationId]
    );
    const racedOutcome = await raceCancellationAgainstMark(
      owner.pool,
      target.organizationId,
      () => cancel(privacyCase.id, "Corrida com a marca")
    );
    assert.ok(
      racedOutcome instanceof OrganizationPurgeRefusedError &&
        racedOutcome.code === "purge_storage_touched",
      "the cancellation that waited for the mark is refused"
    );
    assert.equal((await purgeState())?.storage_touched, true);
    const touchedAt = async () =>
      (
        await owner.pool.query<{ touched: string }>(
          "SELECT storage_touched_at::text AS touched FROM public.organization_purges WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rows[0]?.touched;
    const firstTouch = await touchedAt();
    assert.ok(firstTouch);
    // the lease is held again: a second mark changes nothing
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '15 minutes' WHERE organization_id = $1",
      [target.organizationId]
    );
    await maintenance.markOrganizationPurgeStorageTouched(
      target.organizationId
    );
    assert.equal(
      await touchedAt(),
      firstTouch,
      "the first touch is the one that counts"
    );
    // the lease ends (the run died after touching the storage)
    await owner.pool.query(
      "UPDATE public.organization_purges SET locked_until = now() - interval '1 second' WHERE organization_id = $1",
      [target.organizationId]
    );
    await expectSqlState(
      () =>
        maintenance.markOrganizationPurgeStorageTouched(target.organizationId),
      "55000",
      "a run whose lease ended cannot touch the storage of the purge"
    );
    await assert.rejects(
      () => cancel(privacyCase.id, "Tarde demais para este"),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "purge_storage_touched",
      "a purge that reached the storage cannot be cancelled, even with no run holding it"
    );
    assert.deepEqual(await purgeState(), {
      attempts: 1,
      status: "purge_pending",
      storage_touched: true,
    });
    assert.equal(await auditCount("organization.purge_cancelled"), "2");
    assert.equal((await cancellations()).length, 2);
    tests.push(
      "a scheduled purge is cancelled only with a reason, while no run holds it and before the first object left the storage (an attempt that never reached it does not stop it): the organization goes back to closed, the audit records it without the reason, the reason goes to an append-only history that scheduling again does not erase, nothing is deleted, and it can be scheduled again"
    );

    // the purge owner deletes tenant data: it is never a login, bypasses nothing and has no member that could become it
    const purgeOwnerRole = await owner.pool.query<{
      members: string;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolsuper: boolean;
    }>(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::text FROM pg_auth_members AS m WHERE m.roleid = r.oid AND (m.set_option OR m.inherit_option)) AS members
         FROM pg_roles AS r WHERE r.rolname = 'polaris_purge_owner'`
    );
    assert.deepEqual(purgeOwnerRole.rows[0], {
      members: "0",
      rolbypassrls: false,
      rolcanlogin: false,
      rolsuper: false,
    });

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

    // the exception in the closed-case guard is for taking the text out, never for writing another one
    const asPurgeOwnerWrite = async (statement: string, values: unknown[]) => {
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE polaris_purge_owner");
        await client.query(statement, values);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.support_cases SET reason = 'Outro texto' WHERE id = $1",
          [closedCase.id]
        ),
      "23514",
      "the purge owner cannot write another text in a closed case"
    );
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.privacy_cases SET note = 'Outra nota' WHERE support_case_id = $1",
          [privacyCase.id]
        ),
      "23514",
      "nor another note in a privacy case"
    );
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.organization_purge_cancellations SET reason = 'Outro motivo' WHERE organization_id = $1",
          [target.organizationId]
        ),
      "23514",
      "nor another reason in the history of cancellations"
    );
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.billing_events SET provider_ref = NULL WHERE organization_id = $1",
          [target.organizationId]
        ),
      "42501",
      "and changes nothing of a billing event but its fact"
    );
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.entitlement_grants SET reason = 'Outro motivo' WHERE organization_id = $1",
          [target.organizationId]
        ),
      "23514",
      "nor another reason in an entitlement grant"
    );
    await expectSqlState(
      () =>
        asPurgeOwnerWrite(
          "UPDATE public.entitlement_grants SET limit_value = 1 WHERE organization_id = $1",
          [target.organizationId]
        ),
      "42501",
      "nor any other column of it"
    );
    assert.equal(
      (
        await asPurgeOwner(
          "UPDATE public.entitlement_grants SET reason = 'Texto removido pelo purge da organização.' WHERE organization_id = $1",
          [witness.organizationId]
        )
      ).rowCount,
      0,
      "and not a grant of an organization that is not being purged"
    );
    tests.push(
      "the purge owner cannot write another text in a closed case, a privacy case, the history of cancellations or an entitlement grant, nor change anything of a billing event but its fact"
    );

    const billingBefore = await owner.pool.query<BillingRow>(
      "SELECT provider_event_id, provider_ref, fact_type, occurred_at::text, fact FROM public.billing_events WHERE organization_id = $1 ORDER BY provider_event_id",
      [target.organizationId]
    );
    const witnessBillingBefore = await owner.pool.query(
      "SELECT provider_event_id, fact FROM public.billing_events WHERE organization_id = $1 ORDER BY provider_event_id",
      [witness.organizationId]
    );
    const grantColumns =
      "id, key, limit_value, flag_value, granted_by, starts_at::text, expires_at::text, revoked_at, revoked_by, created_at::text";
    const grantsBefore = await owner.pool.query(
      `SELECT ${grantColumns} FROM public.entitlement_grants WHERE organization_id = $1 ORDER BY id`,
      [target.organizationId]
    );
    assert.equal(grantsBefore.rows.length, 1);
    const witnessGrantsBefore = await owner.pool.query(
      "SELECT id, reason FROM public.entitlement_grants WHERE organization_id = $1 ORDER BY id",
      [witness.organizationId]
    );
    assert.equal(witnessGrantsBefore.rows.length, 1);
    const subscriptionBefore = await owner.pool.query(
      "SELECT provider_ref, state FROM public.organization_billing WHERE organization_id = $1",
      [target.organizationId]
    );
    const casesBefore = await owner.pool.query(
      "SELECT id, kind, status, opened_at, opened_by, closed_at, closed_by FROM public.support_cases WHERE organization_id = $1 ORDER BY id",
      [target.organizationId]
    );
    const privacyBefore = await owner.pool.query(
      "SELECT support_case_id, stage, request_type, decision, decision_reason, scope_categories FROM public.privacy_cases WHERE support_case_id = $1",
      [privacyCase.id]
    );

    await purgeRowSettled();
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
    assert.deepEqual(
      await auditRows(target),
      targetAuditBefore,
      "every audit row of the purged organization is still there"
    );
    assert.deepEqual(await auditRows(witness), witnessAuditBefore);
    tests.push(
      "every row of the tenant is gone, from sales and stock movements to the memberships, but not its audit (every row of both classes stays, immutable); the witness is untouched"
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
      cancellations: string;
      cases: string;
      privacy: string;
    }>(
      `SELECT (SELECT count(*)::text FROM public.organization_purge_cancellations WHERE organization_id = $1) AS cancellations,
              (SELECT count(*)::text FROM public.support_cases WHERE organization_id = $1) AS cases,
              (SELECT count(*)::text FROM public.privacy_cases WHERE support_case_id = $2) AS privacy,
              (SELECT count(*)::text FROM public.platform_audit_events WHERE organization_id = $1) AS audit,
              (SELECT count(*)::text FROM public.organization_billing WHERE organization_id = $1) AS billing`,
      [target.organizationId, privacyCase.id]
    );
    const [survivor] = survivors.rows;
    assert.equal(survivor?.cases, String(casesOpened));
    assert.equal(survivor?.privacy, "1");
    assert.ok(Number(survivor?.audit) >= 4);
    assert.equal(survivor?.billing, "1");
    assert.equal(survivor?.cancellations, "2");
    tests.push(
      "the support and privacy cases, the Admin audit, the billing record and the history of cancellations survive the organization"
    );

    // the billing events stay, each one, pseudonymized: values, dates, types and opaque references in the fact, the
    // provider's references in their columns (they still find the payer at the provider, so this is not anonymous)
    const billingAfter = await owner.pool.query<BillingRow>(
      "SELECT provider_event_id, provider_ref, fact_type, occurred_at::text, fact FROM public.billing_events WHERE organization_id = $1 ORDER BY provider_event_id",
      [target.organizationId]
    );
    expectBillingPseudonymized(billingBefore.rows, billingAfter.rows);
    const charge = billingAfter.rows.find(
      (row) => row.fact_type === "charge_succeeded"
    );
    assert.deepEqual(charge?.fact, {
      cycleMonths: 1,
      occurredAt: "2026-09-01T12:00:00.000Z",
      periodEndsAt: "2026-10-01T12:00:00.000Z",
      type: "charge_succeeded",
    });
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT provider_event_id, fact FROM public.billing_events WHERE organization_id = $1 ORDER BY provider_event_id",
          [witness.organizationId]
        )
      ).rows,
      witnessBillingBefore.rows,
      "the witness's billing events are untouched, payer and all"
    );
    // the subscription's reference at the provider stays too, in its column
    assert.ok(subscriptionBefore.rows[0]?.provider_ref);
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT provider_ref, state FROM public.organization_billing WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rows,
      subscriptionBefore.rows,
      "organization_billing.provider_ref stays"
    );
    tests.push(
      "the billing events of the purged organization stay, every one, pseudonymized: values, dates, types and opaque references in the fact, without the payer's name, document, e-mail, phone, address or ID there, and with provider_ref and provider_event_id still in their columns; another organization's are untouched"
    );

    // the entitlement grants stay (key, value, dates, who gave it) and lose the reason the operator typed
    assert.deepEqual(
      (
        await owner.pool.query(
          `SELECT ${grantColumns} FROM public.entitlement_grants WHERE organization_id = $1 ORDER BY id`,
          [target.organizationId]
        )
      ).rows,
      grantsBefore.rows,
      "a grant keeps every column but its reason"
    );
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT DISTINCT reason FROM public.entitlement_grants WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rows,
      [{ reason: PURGE_REMOVED_TEXT }]
    );
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT id, reason FROM public.entitlement_grants WHERE organization_id = $1 ORDER BY id",
          [witness.organizationId]
        )
      ).rows,
      witnessGrantsBefore.rows,
      "another organization's grant keeps its reason"
    );
    // a grant written after the purge (the organization row is a tombstone) keeps no text either, whoever writes it
    const lateGrant = await owner.pool.query<{ reason: string }>(
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at)
       VALUES ($1, 'goals.active.max', 50, $2, 'admin:gate', now(), now() + interval '1 day') RETURNING reason`,
      [target.organizationId, GRANT_REASON]
    );
    assert.equal(lateGrant.rows[0]?.reason, PURGE_REMOVED_TEXT);
    // the runtime that writes grants is the one the trigger runs for: it must see the tombstone too
    const written = await queryAs(
      owner.pool,
      "polaris_billing_runtime",
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at)
       VALUES ($1, 'goals.active.max', 60, $2, 'admin:gate', now(), now() + interval '1 day') RETURNING reason`,
      [target.organizationId, GRANT_REASON]
    );
    assert.equal(written.rows[0]?.reason, PURGE_REMOVED_TEXT);
    await expectGrantWrittenDuringPurgeLosesText(owner.pool, suffix);
    tests.push(
      "the entitlement grants of the purged organization stay with every column but the reason, which becomes the fixed text (also when written after the purge); another organization's grant keeps its reason; the purge owner can write nothing else in a grant"
    );

    // the cases stay as the record of the case, without the free text
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT id, kind, status, opened_at, opened_by, closed_at, closed_by FROM public.support_cases WHERE organization_id = $1 ORDER BY id",
          [target.organizationId]
        )
      ).rows,
      casesBefore.rows,
      "dates, kind, status and opaque IDs of every case stay"
    );
    const caseTexts = await owner.pool.query<{
      context: string | null;
      reason: string;
      resolution: string | null;
    }>(
      "SELECT DISTINCT reason, context, resolution FROM public.support_cases WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.deepEqual(caseTexts.rows, [
      { context: null, reason: PURGE_REMOVED_TEXT, resolution: null },
    ]);
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT support_case_id, stage, request_type, decision, decision_reason, scope_categories FROM public.privacy_cases WHERE support_case_id = $1",
          [privacyCase.id]
        )
      ).rows,
      privacyBefore.rows,
      "the privacy case keeps its stage, type and decision"
    );
    const privacyTexts = await owner.pool.query<{ notes: string }>(
      `SELECT count(*)::text AS notes FROM public.privacy_cases AS privacy
         JOIN public.support_cases AS support_case ON support_case.id = privacy.support_case_id
        WHERE support_case.organization_id = $1 AND (privacy.note IS NOT NULL OR privacy.decision_note IS NOT NULL)`,
      [target.organizationId]
    );
    assert.equal(privacyTexts.rows[0]?.notes, "0");
    assert.deepEqual(
      (
        await owner.pool.query(
          "SELECT DISTINCT reason FROM public.organization_purge_cancellations WHERE organization_id = $1",
          [target.organizationId]
        )
      ).rows,
      [{ reason: PURGE_REMOVED_TEXT }]
    );
    // nothing a person typed, nor the payer, is left in what survives of the organization
    const leftovers = await owner.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT to_jsonb(row_data)::text AS body FROM public.support_cases AS row_data WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(privacy)::text FROM public.privacy_cases AS privacy
           JOIN public.support_cases AS support_case ON support_case.id = privacy.support_case_id WHERE support_case.organization_id = $1
         UNION ALL SELECT to_jsonb(cancellation)::text FROM public.organization_purge_cancellations AS cancellation WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(billing)::text FROM public.billing_events AS billing WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(grant_row)::text FROM public.entitlement_grants AS grant_row WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(audit)::text FROM public.platform_audit_events AS audit WHERE organization_id = $1
       ) AS survived
       WHERE body LIKE ANY ($2::text[])`,
      [
        target.organizationId,
        [
          "%Joana%",
          `%${CASE_PHONE}%`,
          `%${digitsOnly(CASE_PHONE)}%`,
          "%retirado pelo dono%",
          "%Rita%",
          `%${GRANT_PHONE}%`,
          `%${digitsOnly(GRANT_PHONE)}%`,
          `%${digitsOnly(PAYER_FACT.phone)}%`,
          ...Object.values(PAYER_FACT).map((value) => `%${value}%`),
        ],
      ]
    );
    assert.equal(leftovers.rows[0]?.count, "0");
    const witnessCaseAfter = await owner.pool.query<{
      context: string | null;
      resolution: string | null;
    }>("SELECT context, resolution FROM public.support_cases WHERE id = $1", [
      witnessCase.id,
    ]);
    assert.deepEqual(witnessCaseAfter.rows[0], {
      context: CASE_TEXT,
      resolution: CASE_TEXT,
    });
    tests.push(
      "the support and privacy cases of the purged organization keep dates, kind, status, decision and opaque IDs, and lose every free text (reason, context, resolution, notes), as does the history of cancellations; nothing typed nor the payer is left in what survives; another organization's cases keep their text"
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
    // and the policy ties the event to the purge's own record: another principal or case is refused
    const otherPrincipal = (
      await owner.pool.query<{ id: string }>(
        "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active') RETURNING id",
        ["https://purge-gate.example", `purge-other-${randomUUID()}`]
      )
    ).rows[0]?.id;
    assert.ok(otherPrincipal);
    await expectSqlState(
      () =>
        asPurgeOwner(
          `INSERT INTO public.platform_audit_events (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id)
           VALUES ($1, 'organization.purge_completed', $2, $3, 'organization', $2)`,
          [otherPrincipal, target.organizationId, privacyCase.id]
        ),
      "42501",
      "the completion names the operator who scheduled the purge, not another"
    );
    await expectSqlState(
      () =>
        asPurgeOwner(
          `INSERT INTO public.platform_audit_events (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id)
           VALUES ($1, 'organization.purge_completed', $2, $3, 'organization', $2)`,
          [principal, target.organizationId, supportCase.id]
        ),
      "42501",
      "nor another case"
    );
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
    await purgeRowSettled();
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
      {
        alreadyPurged: true,
        deletedRows: 0,
        pseudonymizedBillingEvents: 0,
        scrubbedTexts: 0,
      }
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
        `INSERT INTO public.organization_purges (organization_id, scheduled_by, support_case_id, privacy_case_id, not_before, storage_touched_at)
       VALUES ($1, $2, $3, $3, now(), now())
       ON CONFLICT (organization_id) DO UPDATE
          SET not_before = now(), attempts = 0, locked_until = NULL,
              last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = now()`,
        [target.organizationId, principal, privacyCase.id]
      );
      await restoreClient.query("COMMIT");
    } catch (error) {
      await restoreClient.query("ROLLBACK");
      throw error;
    } finally {
      restoreClient.release();
    }
    // the storage went with the purge that left the tombstone: the reapplied one cannot be cancelled either
    await assert.rejects(
      () => cancel(privacyCase.id, "Depois do restore"),
      (error: unknown) =>
        error instanceof OrganizationPurgeRefusedError &&
        error.code === "purge_storage_touched",
      "a purge reapplied after a restore cannot be cancelled"
    );
    await purgeRowSettled();
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
      "after a restore brings the organization back, the runbook's check shows it and its reapplication purges it again, with one tombstone (the closure went with the first purge: the tombstone proves the 90 days were over)"
    );

    // after the purge, what the Admin writes in a case of the organization keeps no free text either: the
    // deletion case is carried out and resolved with a resolution, and a new case is opened and closed
    await recordPrivacyAction(admin, principal, privacyCase.id, {
      action: "purge_scheduled",
      entityId: null,
    });
    await resolvePrivacyCase(admin, principal, privacyCase.id, CASE_TEXT);
    const lateCase = await openSupportCase(admin, principal, {
      context: CASE_TEXT,
      kind: "support",
      organizationId: target.organizationId,
      reason: `Retorno de ${CASE_TEXT}`,
    });
    assert.ok(lateCase);
    await closeSupportCase(admin, principal, lateCase.id, CASE_TEXT);
    const lateTexts = await owner.pool.query<{
      context: string | null;
      reason: string;
      resolution: string | null;
    }>(
      "SELECT DISTINCT reason, context, resolution FROM public.support_cases WHERE organization_id = $1",
      [target.organizationId]
    );
    assert.deepEqual(lateTexts.rows, [
      { context: null, reason: PURGE_REMOVED_TEXT, resolution: null },
    ]);
    const latePrivacy = await owner.pool.query<{
      decision_note: string | null;
      note: string | null;
      stage: string;
    }>(
      "SELECT stage, note, decision_note FROM public.privacy_cases WHERE support_case_id = $1",
      [privacyCase.id]
    );
    assert.deepEqual(latePrivacy.rows[0], {
      decision_note: null,
      note: null,
      stage: "resolved",
    });
    tests.push(
      "after the purge, a case of the organization that is resolved, opened or closed keeps no free text: the reason is the fixed text, the context, the resolution and the notes are empty"
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
    await expectSqlState(
      () =>
        owner.pool.query(
          "UPDATE public.support_cases SET reason = $2, context = NULL, resolution = NULL WHERE id = $1",
          [witnessCase.id, PURGE_REMOVED_TEXT]
        ),
      "23514",
      "a closed support case stays final outside the purge, even for the fixed text"
    );
    tests.push(
      "outside the purge, stock movements stay append-only, the links of a removed product stay frozen and a closed case stays final"
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
