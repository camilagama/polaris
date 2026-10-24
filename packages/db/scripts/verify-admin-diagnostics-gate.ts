import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  buildOrganizationDiagnostics,
  type RawDiagnostics,
} from "@polaris/domain/admin/organization-diagnostics";
import { Client } from "pg";
import {
  listOrganizations,
  readOrganizationDiagnostics,
} from "../src/admin-diagnostics-repository";
import { createDatabase } from "../src/client";
import { getEffectiveEntitlements } from "../src/billing-repository";
import {
  createProductMediaAsset,
  removeProductMedia,
} from "../src/media-repository";
import {
  countOrganizationVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
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
 * What the Admin sees of an organization without tenant access, on a real
 * PostgreSQL 18 (plan PR95, ADR 0071): two functions that return counts, dates
 * and states, run by a role that reads no table. The gate proves the figures are
 * right, that nothing a person typed (a product, a customer, an e-mail, a name of
 * an owner) is in the answer, that the plan is the same one the product applies,
 * and that no other role can run the functions.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR = 3_600_000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gate is one linear list of independent scenarios
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
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
      "polaris_diag_admin"
    );
    const tenantUrl = await login(runtimeRole, "polaris_diag_tenant");
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_diag_billing"
    );
    const catalogUrl = await login(
      "polaris_catalog_runtime",
      "polaris_diag_catalog"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 4 });
    const { db } = runtime;

    const connect = async <T>(
      url: string,
      operation: (client: Client) => Promise<T>
    ) => {
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    const asAdmin = <T>(operation: (client: Client) => Promise<T>) =>
      connect(adminLoginUrl, operation);
    const diagnostics = (organizationId: string) =>
      asAdmin((client) => readOrganizationDiagnostics(client, organizationId));

    // ------------------------------------------------- 1. who can run them
    for (const statement of [
      "SELECT public.admin_organizations_overview(NULL, 10, NULL)",
      "SELECT public.admin_organization_diagnostics('x')",
    ]) {
      for (const [label, url] of [
        ["tenant", tenantUrl],
        ["billing", billingUrl],
        ["catalog", catalogUrl],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
        await expectSqlState(
          () => connect(url, (client) => client.query(statement)),
          "42501",
          `the ${label} role cannot run: ${statement}`
        );
      }
    }
    const functions = await owner.pool.query<{
      owner_ok: number;
      public_execute: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))::int AS public_execute,
         count(*) FILTER (WHERE pg_get_userbyid(p.proowner) = 'polaris_admin_owner' AND p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%')::int AS owner_ok
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('admin_organizations_overview', 'admin_organization_diagnostics')`
    );
    assert.deepEqual(functions.rows, [{ owner_ok: 2, public_execute: 0 }]);
    // the Admin role still reads no table beyond the principals, and the owner is never a login
    const reach = await owner.pool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND c.relname <> 'platform_principals'
          AND (has_table_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR (c.relkind <> 'S' AND has_any_column_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))`
    );
    assert.deepEqual(reach.rows, []);
    const ownerRole = await owner.pool.query<{ login: boolean }>(
      "SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = 'polaris_admin_owner'"
    );
    assert.deepEqual(ownerRole.rows, [{ login: false }]);
    // exactly what the owner of the functions can read: these columns and nothing else
    const expectedColumns: Record<string, string[]> = {
      // the reasons of a cancelled renewal, with no store and no person (0100, ADR 0104)
      billing_cancellation_feedback: [
        "cycle_months",
        "id",
        "reason",
        "recorded_on",
        "state",
      ],
      billing_events: ["attempts", "organization_id", "received_at", "status"],
      devices: ["id", "last_seen_at"],
      entitlement_grants: [
        "expires_at",
        "flag_value",
        "key",
        "limit_value",
        "organization_id",
        "revoked_at",
        "starts_at",
      ],
      goals: ["organization_id", "status"],
      memberships: [
        "authorization_epoch",
        "organization_id",
        "status",
        "user_id",
      ],
      offline_grants: [
        "device_id",
        "expires_at",
        "organization_id",
        "revoked_at",
      ],
      organization_billing: [
        "access_ends_at",
        "cancel_at_period_end",
        "cycle_months",
        // the three of the operator's read of the refund window (0100, ADR 0104, decision 8)
        "first_charge_amount",
        "first_charge_at",
        "last_fact_at",
        "organization_id",
        "over_limit_since",
        "pending_cycle_months",
        "provider",
        "refund_requested_at",
        "revoked_reason",
        "revoked_through",
        "state",
        "trial_started_at",
        "version",
      ],
      organizations: [
        "created_at",
        "currency",
        "id",
        "name",
        "status",
        "timezone",
      ],
      plan_entitlements: ["flag_value", "key", "limit_value", "plan_id"],
      product_media: ["organization_id", "product_id"],
      product_variants: ["organization_id", "product_id"],
      products: ["archived_at", "deleted_at", "id", "organization_id"],
      sync_commands: [
        "organization_id",
        "outcome_code",
        "outcome_status",
        "received_at",
      ],
    };
    // the tables the Admin's own functions keep (cases, grants, audit) are the owner's to write, and the
    // customers and principals are read for the support functions (ADR 0072)
    Object.assign(expectedColumns, {
      customers: [
        "archived_at",
        "email",
        "id",
        "name",
        "notes",
        "organization_id",
        "phone",
      ],
      // the closure, read before a purge is scheduled: the recovery window and the 90 days (ADR 0081)
      organization_closures: [
        "closed_at",
        "organization_id",
        "recover_until",
        "requested_at",
      ],
      platform_principals: ["id", "status"],
      // the dead-letter queue the Admin's incident functions read, and only read (ADR 0085)
      operational_incidents: [
        "cause",
        "first_seen_at",
        "id",
        "kind",
        "last_reference",
        "last_seen_at",
        "occurrence_count",
        "subject",
      ],
      queue_dead_letters: [
        "event_id",
        "event_type",
        "first_seen_at",
        "incident_id",
        "last_seen_at",
        "occurrences",
        "organization_id",
        "retried_at",
        "retry_count",
        "state",
      ],
    });
    const platformTables = {
      // the purge record: the schedule writes it, and writes it again after a restore (ADR 0081), an operator's again
      // over a row the closure period wrote (`trigger`, ADR 0102)
      organization_purges: [
        "attempts",
        "last_error_code",
        "locked_until",
        "not_before",
        "privacy_case_id",
        "purged_at",
        "scheduled_at",
        "scheduled_by",
        "storage_touched_at",
        "support_case_id",
        "swept_at",
        "trigger",
      ],
      // the legal holds: placed by the Admin, and afterwards only released or renewed (a later review date, ADR 0081)
      organization_legal_holds: ["released_at", "released_by", "review_at"],
      // every cancellation of a purge with its reason: the cancel function appends, nothing changes a row
      organization_purge_cancellations: [] as string[],
      platform_audit_events: [] as string[],
      privacy_case_actions: [] as string[],
      privacy_cases: [
        "decision",
        "decision_note",
        "decision_reason",
        "identity_method",
        "identity_status",
        "polaris_role",
        "resolved_at",
        "scope_categories",
        "stage",
        "subject_reference",
        "updated_at",
      ],
      support_cases: ["closed_at", "closed_by", "resolution", "status"],
      tenant_access_grants: ["revoked_at", "revoked_by"],
    };
    const platformColumns = await owner.pool.query<{
      column_name: string;
      table_name: string;
    }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [Object.keys(platformTables)]
    );
    // what suspending an organization may change (ADR 0073), and nothing else of the tenant
    const tenantUpdates: Record<string, string[]> = {
      memberships: ["authorization_epoch", "updated_at"],
      offline_grants: ["revoked_at", "revoked_reason"],
      organizations: ["status", "updated_at"],
    };
    const wanted = [
      ...Object.entries(tenantUpdates).flatMap(([table, columns]) =>
        columns.map((column) => `${table}.${column}:UPDATE`)
      ),
      ...Object.entries(expectedColumns).flatMap(([table, columns]) =>
        columns.map((column) => `${table}.${column}:SELECT`)
      ),
      ...platformColumns.rows.flatMap((row) => [
        `${row.table_name}.${row.column_name}:SELECT`,
        `${row.table_name}.${row.column_name}:INSERT`,
        ...((platformTables as Record<string, string[]>)[
          row.table_name
        ]?.includes(row.column_name)
          ? [`${row.table_name}.${row.column_name}:UPDATE`]
          : []),
      ]),
    ].sort();
    const granted = await owner.pool.query<{ grant: string }>(
      `SELECT table_name || '.' || column_name || ':' || privilege_type AS grant
         FROM information_schema.column_privileges
        WHERE grantee = 'polaris_admin_owner' AND table_schema = 'public'
        ORDER BY 1`
    );
    assert.deepEqual(
      granted.rows.map((row) => row.grant),
      wanted,
      "the owner of the functions reads exactly these columns, and can only read"
    );
    const tableLevel = await owner.pool.query<{ privilege: string }>(
      "SELECT table_name || ':' || privilege_type AS privilege FROM information_schema.table_privileges WHERE grantee = 'polaris_admin_owner' AND table_schema = 'public' ORDER BY 1"
    );
    assert.deepEqual(
      tableLevel.rows.map((row) => row.privilege),
      [
        "operational_incidents:SELECT",
        "organization_legal_holds:INSERT",
        "organization_legal_holds:SELECT",
        "organization_purge_cancellations:INSERT",
        "organization_purge_cancellations:SELECT",
        "organization_purges:INSERT",
        "organization_purges:SELECT",
        "platform_audit_events:INSERT",
        "platform_audit_events:SELECT",
        "privacy_case_actions:INSERT",
        "privacy_case_actions:SELECT",
        "privacy_cases:INSERT",
        "privacy_cases:SELECT",
        "queue_dead_letters:SELECT",
        "support_cases:INSERT",
        "support_cases:SELECT",
        "tenant_access_grants:INSERT",
        "tenant_access_grants:SELECT",
      ],
      "table-level privileges only on the Admin's own tables (and read on the dead-letter queue), and never to change or delete"
    );
    const memberships = await owner.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_auth_members WHERE member = 'polaris_admin_owner'::regrole OR (roleid = 'polaris_admin_owner'::regrole AND (set_option OR inherit_option))"
    );
    assert.equal(
      memberships.rows[0]?.count,
      0,
      "the owner is in no role and nobody can act as it (the creator keeps only the right to administer it)"
    );
    const ownerPolicies = await owner.pool.query<{
      cmd: string;
      qual: string | null;
      tablename: string;
      with_check: string | null;
    }>(
      "SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE roles = '{polaris_admin_owner}' ORDER BY tablename, cmd"
    );
    const policyMap: Record<string, string[]> = {};
    for (const row of ownerPolicies.rows) {
      policyMap[row.tablename] = [...(policyMap[row.tablename] ?? []), row.cmd];
      assert.ok(
        (row.cmd === "INSERT" ? row.with_check : row.qual) === "true",
        `the owner's ${row.cmd} policy on ${row.tablename} is for the whole table: the function decides`
      );
    }
    assert.deepEqual(policyMap, {
      ...Object.fromEntries(
        Object.keys(expectedColumns).map((table) => [table, ["SELECT"]])
      ),
      memberships: ["SELECT", "UPDATE"],
      offline_grants: ["SELECT", "UPDATE"],
      organization_legal_holds: ["INSERT", "SELECT", "UPDATE"],
      organization_purge_cancellations: ["INSERT", "SELECT"],
      organization_purges: ["INSERT", "SELECT", "UPDATE"],
      organizations: ["SELECT", "UPDATE"],
      platform_audit_events: ["INSERT", "SELECT"],
      privacy_case_actions: ["INSERT", "SELECT"],
      privacy_cases: ["INSERT", "SELECT", "UPDATE"],
      support_cases: ["INSERT", "SELECT", "UPDATE"],
      tenant_access_grants: ["INSERT", "SELECT", "UPDATE"],
    });
    // the Admin role runs exactly the Admin functions, and no other login role can run them
    const runnable = await owner.pool.query<{ name: string }>(
      "SELECT p.proname AS name FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE') ORDER BY 1"
    );
    assert.deepEqual(
      runnable.rows.map((row) => row.name),
      [
        "admin_audit_billing_command",
        "admin_cancel_organization_purge",
        "admin_close_support_case",
        "admin_dismiss_closure_notice",
        "admin_grant_tenant_access",
        "admin_list_operational_incidents",
        "admin_list_organization_legal_holds",
        "admin_list_privacy_cases",
        "admin_list_support_cases",
        "admin_open_privacy_case",
        "admin_open_support_case",
        "admin_organization_diagnostics",
        "admin_organizations_overview",
        "admin_place_organization_legal_hold",
        "admin_privacy_case_detail",
        "admin_privacy_record_action",
        "admin_privacy_record_decision",
        "admin_privacy_record_identity",
        "admin_privacy_record_role",
        "admin_privacy_record_scope",
        "admin_privacy_resolve",
        "admin_reactivate_organization",
        "admin_read_auth_access_log",
        "admin_read_operational_incident",
        "admin_read_refund_window",
        "admin_reissue_closure_notice",
        "admin_release_organization_legal_hold",
        "admin_retry_dead_letter",
        "admin_reveal_customer_field",
        "admin_revoke_tenant_access",
        "admin_schedule_organization_purge",
        "admin_support_case_detail",
        "admin_suspend_organization",
        "admin_tenant_customers",
      ]
    );
    const others = await owner.pool.query<{ name: string }>(
      `SELECT r.rolname AS name
         FROM pg_roles r
        WHERE r.rolname NOT IN ('polaris_admin_runtime', 'polaris_admin_owner')
          AND NOT pg_has_role(r.rolname, 'polaris_admin_runtime', 'MEMBER')
          AND r.rolname LIKE 'polaris%'
          AND (has_function_privilege(r.rolname, 'public.admin_organization_diagnostics(text)', 'EXECUTE')
               OR has_function_privilege(r.rolname, 'public.admin_organizations_overview(text, integer, text)', 'EXECUTE'))`
    );
    assert.deepEqual(others.rows, [], "no other Polaris role can run them");
    for (const table of [
      "products",
      "customers",
      "sales",
      "user",
      "organization_billing",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) => client.query(`SELECT 1 FROM public."${table}"`)),
        "42501",
        `the Admin role still reads no ${table}`
      );
    }
    tests.push(
      "only the Admin role can run the two functions (the tenant, billing and catalog roles and PUBLIC cannot), they are SECURITY DEFINER with a pinned search_path owned by a role that is not a login, and the Admin role still reaches no table beyond the principals"
    );

    // ------------------------------------------------- 2. an organization with something in it
    const suffix = randomUUID().slice(0, 8);
    const pro = await createTenantFixture(
      owner.pool,
      `diag pro ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const free = await createTenantFixture(
      owner.pool,
      `diag free ${suffix}`,
      "America/Sao_Paulo",
      "free"
    );
    const secretName = `Segredo ${randomUUID()}`;
    const as = <T>(
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, pro, capability, operation);
    const products: { id: string; version: number }[] = [];
    for (const name of [secretName, "Produto B", "Produto C"]) {
      products.push(
        // biome-ignore lint/performance/noAwaitInLoops: Three products, in order.
        await as("product:create", (tx, identity) =>
          createProduct(tx, identity, { name })
        )
      );
    }
    const assets: { assetId: string; productId: string }[] = [];
    for (const productId of [
      products[0]?.id,
      products[0]?.id,
      products[1]?.id,
    ] as string[]) {
      const uploadCommandId = randomUUID();
      const fingerprint = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      // biome-ignore lint/performance/noAwaitInLoops: Three images, in order.
      const created = await as("product:update", (tx, identity) =>
        createProductMediaAsset(tx, identity, {
          byteSize: 2048,
          height: 480,
          inputFingerprint: fingerprint,
          productId,
          requestId: randomUUID(),
          storageKey: `media/v2/${pro.organizationId}/${productId}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
          uploadCommandId,
          variantIds: [],
          width: 640,
        })
      );
      assets.push({ assetId: created.asset.assetId, productId });
    }
    await owner.pool.query(
      "UPDATE public.products SET archived_at = now() WHERE id = $1",
      [products[2]?.id]
    );
    await owner.pool.query(
      "INSERT INTO public.goals (organization_id, kind, target, starts_on, ends_on) VALUES ($1, 'sale_count', 10, current_date, current_date + 30), ($1, 'sale_count', 5, current_date, current_date + 30)",
      [pro.organizationId]
    );
    await owner.pool.query(
      "INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at) VALUES ($1, 'variants.active.max', 3000, 'compensation for the secret outage', 'admin:gate', now() - interval '1 day', now() + interval '2 days')",
      [pro.organizationId]
    );
    const device = await owner.pool.query<{ id: string }>(
      "INSERT INTO public.devices (user_id, label, last_seen_at) VALUES ($1, 'Celular da loja', now() - interval '1 hour') RETURNING id",
      [pro.userId]
    );
    await owner.pool.query(
      "INSERT INTO public.offline_grants (device_id, organization_id, user_id, authorization_epoch, expires_at) VALUES ($1, $2, $3, 0, now() + interval '12 hours'), ($1, $2, $3, 0, now() + interval '24 hours')",
      [device.rows[0]?.id, pro.organizationId, pro.userId]
    );
    for (const [type, status, code] of [
      ["sale.confirm", "accepted", null],
      ["sale.confirm", "accepted", null],
      ["sale.confirm", "rejected", "insufficient_stock"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Three commands, in order.
      await owner.pool.query(
        "INSERT INTO public.sync_commands (command_id, command_type, organization_id, outcome_status, outcome_code, payload_hash, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          randomUUID(),
          type,
          pro.organizationId,
          status,
          code,
          "a".repeat(64),
          pro.userId,
        ]
      );
    }
    for (const [status, hoursAgo, attempts] of [
      ["applied", 5, 1],
      ["failed", 3, 4],
      ["received", 2, 0],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Three events, in order.
      await owner.pool.query(
        `INSERT INTO public.billing_events (organization_id, provider, provider_event_id, fact_type, fact, occurred_at, received_at, status, attempts)
         VALUES ($1, 'asaas', $2, 'charge_succeeded', '{}'::jsonb, now() - $3::int * interval '1 hour', now() - $3::int * interval '1 hour', $4, $5)`,
        [pro.organizationId, `evt-${randomUUID()}`, hoursAgo, status, attempts]
      );
    }
    await owner.pool.query(
      "UPDATE public.organization_billing SET provider = 'asaas', cycle_months = 1 WHERE organization_id = $1",
      [pro.organizationId]
    );

    const raw = (await diagnostics(pro.organizationId)) as RawDiagnostics;
    assert.ok(raw);
    assert.equal(raw.organization.id, pro.organizationId);
    assert.equal(raw.organization.status, "active");
    assert.equal(raw.organization.members, 1);
    assert.equal(raw.billing?.state, "active");
    assert.equal(raw.billing?.provider, "asaas");
    assert.deepEqual(raw.usage, {
      activeGoals: 2,
      archivedProducts: 1,
      maxImagesPerProduct: 2,
      images: 3,
      products: 2,
      variants: 3,
    });
    assert.deepEqual(raw.offline.devices, 1, "one device holds two grants");
    assert.equal(raw.offline.activeGrants, 2);
    assert.ok(raw.offline.lastSeenAt);
    assert.deepEqual(raw.sync.last7Days, { accepted: 2, rejected: 1 });
    assert.deepEqual(raw.sync.rejectedByCode, { insufficient_stock: 1 });
    assert.deepEqual(raw.billingEvents.byStatus, {
      applied: 1,
      failed: 1,
      received: 1,
    });
    assert.equal(raw.billingEvents.maxAttempts, 4);
    assert.ok(raw.billingEvents.oldestUnprocessedAt);
    assert.equal(raw.grants.length, 1);
    assert.equal(raw.grants[0]?.limitValue, 3000);
    assert.equal(raw.planCatalog.length, 12);
    tests.push(
      "the figures are right for an organization with products, images, goals, a grant, a device with two leases, sync commands and billing events (counts of live and archived products, variants, images and the most on one product, active goals, devices and leases, accepted and rejected commands by code, events by status)"
    );

    // ------------------------------------------------- 3. what it never contains
    // the answer has a closed shape: every key is known, and what is a map has only counts
    const shape: Record<string, string[]> = {
      billing: [
        "accessEndsAt",
        "cancelAtPeriodEnd",
        "cycleMonths",
        "lastFactAt",
        "overLimitSince",
        "pendingCycleMonths",
        "provider",
        "revokedReason",
        "revokedThrough",
        "state",
        "trialStartedAt",
        "version",
      ],
      billingEvents: [
        "byStatus",
        "lastReceivedAt",
        "maxAttempts",
        "oldestUnprocessedAt",
      ],
      grant: [
        "expiresAt",
        "flagValue",
        "key",
        "limitValue",
        "revokedAt",
        "startsAt",
      ],
      offline: ["activeGrants", "devices", "lastSeenAt"],
      organization: [
        "authorizationEpoch",
        "createdAt",
        "currency",
        "id",
        "members",
        "name",
        "status",
        "timezone",
      ],
      planEntry: ["flagValue", "key", "limitValue", "planId"],
      sync: ["last7Days", "lastReceivedAt", "rejectedByCode"],
      top: [
        "billing",
        "billingEvents",
        "grants",
        "now",
        "offline",
        "organization",
        "planCatalog",
        "sync",
        "usage",
      ],
      usage: [
        "activeGoals",
        "archivedProducts",
        "images",
        "maxImagesPerProduct",
        "products",
        "variants",
      ],
    };
    const keysOf = (value: unknown) => Object.keys(value as object).sort();
    assert.deepEqual(keysOf(raw), shape.top);
    assert.deepEqual(keysOf(raw.organization), shape.organization);
    assert.deepEqual(keysOf(raw.billing), shape.billing);
    assert.deepEqual(keysOf(raw.usage), shape.usage);
    assert.deepEqual(keysOf(raw.offline), shape.offline);
    assert.deepEqual(keysOf(raw.sync), shape.sync);
    assert.deepEqual(keysOf(raw.billingEvents), shape.billingEvents);
    for (const grant of raw.grants) {
      assert.deepEqual(keysOf(grant), shape.grant);
    }
    for (const entry of raw.planCatalog) {
      assert.deepEqual(keysOf(entry), shape.planEntry);
    }
    for (const counts of [
      raw.sync.last7Days,
      raw.sync.rejectedByCode,
      raw.billingEvents.byStatus,
    ]) {
      assert.ok(
        Object.values(counts).every((count) => Number.isInteger(count))
      );
    }
    const text = JSON.stringify(raw);
    for (const forbidden of [
      secretName,
      "Produto B",
      "@example.invalid",
      "Celular da loja",
      "compensation for the secret outage",
      "admin:gate",
      pro.userId,
      "media/v2",
      "payload",
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `the answer never contains ${forbidden}`
      );
    }
    const listed = await asAdmin((client) =>
      listOrganizations(client, { limit: 50 })
    );
    const listedText = JSON.stringify(listed);
    assert.ok(!listedText.includes(pro.userId));
    assert.ok(!listedText.includes("@example.invalid"));
    for (const entry of listed.organizations) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "accessEndsAt",
        "billingState",
        "createdAt",
        "id",
        "name",
        "planInForce",
        "status",
      ]);
    }
    tests.push(
      "nothing a person typed is in the answer: no product name, customer, e-mail, device label, grant reason or author, user ID, storage path or command payload; the list carries only an organization's ID, name, status, creation, billing state and access end"
    );

    // ------------------------------------------------- 4. the plan is the one the product applies
    const report = buildOrganizationDiagnostics(raw);
    assert.equal(report.entitlements.plan, "pro");
    assert.deepEqual(report.entitlements.raisedByGrant, [
      "variants.active.max",
    ]);
    assert.equal(
      report.quotas.find((line) => line.key === "variants.active.max")?.limit,
      3000
    );
    assert.equal(
      report.quotas.find((line) => line.key === "images.per_product.max")
        ?.limit,
      10
    );
    assert.deepEqual(report.attention.map((item) => item.code).sort(), [
      "billing_events_failed",
      "billing_events_stuck",
      "grant_ending_soon",
      "sync_rejections",
    ]);
    // the same answers the product itself gives for this organization: the plan in force, the
    // limits, whether it is over, and how many variants and pictures it holds against them
    const sameAsProduct = async (label: string) => {
      const shown = buildOrganizationDiagnostics(
        (await diagnostics(pro.organizationId)) as RawDiagnostics
      );
      const effective = await withTenantAs(
        db,
        pro,
        "catalog:read",
        (tx, identity) => getEffectiveEntitlements(tx, identity)
      );
      const variants = await withTenantAs(
        db,
        pro,
        "catalog:read",
        (tx, identity) => countOrganizationVariants(tx, identity.organizationId)
      );
      // the rule the product applies to pictures: linked to a product that is not deleted
      const pictures = await owner.pool.query<{ images: number; most: number }>(
        `SELECT COALESCE(sum(per_product.total), 0)::int AS images, COALESCE(max(per_product.total), 0)::int AS most
           FROM (
             SELECT count(*)::int AS total
               FROM public.product_media link
               JOIN public.products product ON product.organization_id = link.organization_id AND product.id = link.product_id
              WHERE link.organization_id = $1 AND product.deleted_at IS NULL
              GROUP BY link.product_id
           ) per_product`,
        [pro.organizationId]
      );
      assert.equal(shown.entitlements.plan, effective.plan, `${label}: plan`);
      assert.equal(
        shown.entitlements.overLimit,
        effective.overLimit,
        `${label}: over limit`
      );
      for (const line of shown.quotas) {
        assert.equal(
          line.limit,
          effective.values[line.key],
          `${label}: limit ${line.key}`
        );
      }
      const used = Object.fromEntries(
        shown.quotas.map((line) => [line.key, line.used])
      );
      assert.equal(used["variants.active.max"], variants, `${label}: variants`);
      assert.equal(
        shown.usage.images,
        pictures.rows[0]?.images,
        `${label}: pictures`
      );
      assert.equal(
        shown.usage.maxImagesPerProduct,
        pictures.rows[0]?.most,
        `${label}: most pictures on one product`
      );
      return shown;
    };
    let shown = await sameAsProduct("as seeded");
    assert.equal(shown.usage.images, 3);
    // a picture unlinked frees its place at once (the file stays until the cleanup)
    const [firstAsset] = assets;
    assert.ok(firstAsset);
    await as("product:update", (tx, identity) =>
      removeProductMedia(tx, identity, firstAsset)
    );
    shown = await sameAsProduct("one picture removed");
    assert.equal(shown.usage.images, 2);
    assert.equal(shown.usage.maxImagesPerProduct, 1);
    // a deleted product no longer counts its pictures or its variants
    const [, doomed] = products;
    assert.ok(doomed);
    await as("product:update", (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: doomed.version,
        id: doomed.id,
        requestId: randomUUID(),
      })
    );
    shown = await sameAsProduct("a product deleted");
    assert.equal(shown.usage.images, 1);
    // an organization over the Free limit is over for the Admin exactly as it is for the product
    await owner.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL, cycle_months = NULL, provider = NULL, over_limit_since = now() WHERE organization_id = $1",
      [pro.organizationId]
    );
    shown = await sameAsProduct("over the Free limit");
    assert.equal(shown.entitlements.overLimit, true);
    assert.ok(shown.attention.some((item) => item.code === "over_free_limit"));
    await owner.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() + interval '30 days', cycle_months = 1, provider = 'asaas', over_limit_since = NULL WHERE organization_id = $1",
      [pro.organizationId]
    );
    await sameAsProduct("back to Pro");
    // a period that has ended is Free at the database clock even if the record still says active
    await owner.pool.query(
      "UPDATE public.organization_billing SET access_ends_at = now() - interval '1 minute' WHERE organization_id = $1",
      [pro.organizationId]
    );
    const lapsed = buildOrganizationDiagnostics(
      (await diagnostics(pro.organizationId)) as RawDiagnostics
    );
    assert.equal(lapsed.entitlements.plan, "free");
    assert.equal(lapsed.entitlements.overLimit, false);
    // an organization with no billing record is Free, with nothing to look at
    const nothing = buildOrganizationDiagnostics(
      (await diagnostics(free.organizationId)) as RawDiagnostics
    );
    assert.equal(nothing.billing, null);
    assert.equal(nothing.entitlements.plan, "free");
    assert.deepEqual(nothing.attention, []);
    assert.equal(nothing.usage.products, 0);
    tests.push(
      "the report applies the same entitlement engine as the product: Pro while the period runs, raised by the grant in force, Free the moment the period ended at the database clock, Free with no billing record; attention lists the failed and stuck billing events, the grant ending in days and the rejected commands"
    );

    // ------------------------------------------------- 5. finding organizations
    assert.equal(await diagnostics("no-such-organization"), null);
    const byId = await asAdmin((client) =>
      listOrganizations(client, { limit: 10, query: pro.organizationId })
    );
    assert.deepEqual(
      byId.organizations.map((entry) => entry.id),
      [pro.organizationId]
    );
    assert.equal(byId.organizations[0]?.billingState, "active");
    // the record still says active, but its period ended: the list shows the plan in force, not the label
    assert.equal(byId.organizations[0]?.planInForce, "free");
    const byName = await asAdmin((client) =>
      listOrganizations(client, {
        limit: 50,
        query: `PR43 SALES GATE DIAG FREE ${suffix}`.toUpperCase(),
      })
    );
    assert.deepEqual(
      byName.organizations.map((entry) => entry.id),
      [free.organizationId]
    );
    assert.equal(byName.organizations[0]?.billingState, "free");
    assert.equal(byName.organizations[0]?.planInForce, "free");
    const none = await asAdmin((client) =>
      listOrganizations(client, { limit: 10, query: "%" })
    );
    assert.deepEqual(none.organizations, [], "a wildcard is not a pattern");
    // pages follow the order and end
    const everyone = await asAdmin((client) =>
      listOrganizations(client, { limit: 50 })
    );
    assert.ok(everyone.organizations.length >= 2);
    const firstPage = await asAdmin((client) =>
      listOrganizations(client, { limit: 1 })
    );
    assert.equal(firstPage.organizations.length, 1);
    assert.ok(firstPage.next);
    const secondPage = await asAdmin((client) =>
      listOrganizations(client, { after: firstPage.next, limit: 1 })
    );
    assert.ok(
      (secondPage.organizations[0]?.id ?? "") >
        (firstPage.organizations[0]?.id ?? "")
    );
    for (const size of [0, 51, -1]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              "SELECT public.admin_organizations_overview(NULL, $1, NULL)",
              [size]
            )
          ),
        "22023",
        `a page size of ${size}`
      );
    }
    await expectSqlState(
      () =>
        asAdmin((client) =>
          client.query(
            "SELECT public.admin_organizations_overview($1, 10, NULL)",
            ["x".repeat(101)]
          )
        ),
      "22023",
      "a query that is too long"
    );
    // the dates are what the organization's clock says, in UTC
    assert.ok(
      Math.abs(Date.now() - new Date(raw.now).getTime()) < HOUR,
      "the database clock is current"
    );
    tests.push(
      "organizations are found by exact ID or by the start of the name (case-insensitive, a wildcard is not a pattern), listed in order a page at a time (1 to 50), an unknown one is null"
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
    `Admin diagnostics PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
