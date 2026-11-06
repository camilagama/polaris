import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InvalidSupportRequestError,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { Client } from "pg";
import {
  closeSupportCase,
  grantTenantAccess,
  listSupportCases,
  openPrivacyCase,
  listTenantCustomers,
  openSupportCase,
  readSupportCase,
  revealCustomerField,
  revokeTenantAccess,
  type SupportCasePage,
  type SupportCaseSummary,
} from "../src/admin-support-repository";
import { createDatabase } from "../src/client";
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
} from "./sales-gate-support";

/**
 * Support cases, temporary tenant access, masked reads and PII reveal on a real
 * PostgreSQL 18 (plan PR96 to PR98, ADR 0072). The Admin role reads no table: it
 * runs functions that check an active grant from an open case, mask what they
 * return, reveal one field only on request, and write the append-only audit in
 * the same transaction, without ever holding the value that was revealed.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-support-gate.cloudflareaccess.com";

const ADMIN_FUNCTIONS = [
  "admin_audit_billing_command",
  "admin_cancel_organization_purge",
  "admin_classify_organization",
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
  "admin_read_activation_funnel",
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
];

const AUDIT_INDEX_COLUMNS = /\(principal_id, event_type, created_at\)/;

interface RevealLimitContext {
  asAdmin: <T>(operation: (client: Client) => Promise<T>) => Promise<T>;
  denied: (operation: () => Promise<unknown>) => Promise<void>;
  joao: string;
  maria: string;
  open: (
    principalId: string,
    organizationId?: string
  ) => Promise<{ id: string } | null>;
  orgA: { organizationId: string };
  orgB: { organizationId: string };
  outsider: string;
  owner: ReturnType<typeof createDatabase>;
  principal: () => Promise<string>;
  refused: (operation: () => Promise<unknown>, code: string) => Promise<void>;
  reveal: (
    principalId: string,
    caseId: string,
    customerId: string,
    field?: "email" | "name" | "phone" | "notes"
  ) => Promise<{
    customerId: string;
    field: string;
    value: string | null;
  } | null>;
  tests: string[];
}

async function verifyRevealLimit(context: RevealLimitContext) {
  const {
    asAdmin,
    denied,
    joao,
    maria,
    open,
    orgA,
    orgB,
    outsider,
    owner,
    principal,
    refused,
    reveal,
    tests,
  } = context;
  // ------------------------------------------------- 8. the hourly limit of reveals
  const REVEAL_LIMIT = 30;
  const revealRows = async (principalId: string) =>
    Number(
      (
        await owner.pool.query<{ total: string }>(
          "SELECT count(*) AS total FROM public.platform_audit_events WHERE principal_id = $1 AND event_type = 'pii.revealed'",
          [principalId]
        )
      ).rows[0]?.total
    );
  const limitedCase = async (principalId: string, organizationId: string) => {
    const supportCase = await open(principalId, organizationId);
    assert.ok(supportCase);
    await asAdmin((client) =>
      grantTenantAccess(client, principalId, supportCase.id, 60)
    );
    return supportCase.id;
  };
  const limited =
    (code = "operator_reveal_rate_limited") =>
    (error: unknown) =>
      error instanceof InvalidSupportRequestError && error.code === code;
  const backdatedReveals = (
    principalId: string,
    caseId: string,
    count: number,
    minutesAgo: number
  ) =>
    owner.pool.query(
      `INSERT INTO public.platform_audit_events (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail, created_at)
       SELECT $1, 'pii.revealed', $2, $3, 'customer', $4, 'email', now() - make_interval(mins => $5)
         FROM generate_series(1, $6)`,
      [principalId, orgA.organizationId, caseId, maria, minutesAgo, count]
    );

  // an unknown customer, or one of another store, leaves no row and spends no slot
  const spender = await principal();
  const spenderCase = await limitedCase(spender, orgA.organizationId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
    assert.equal(await reveal(spender, spenderCase, randomUUID()), null);
    assert.equal(await reveal(spender, spenderCase, outsider), null);
  }
  assert.equal(await revealRows(spender), 0);
  // the 30 that exist are accepted, and a repeat of one field counts as much as another field
  for (let index = 0; index < REVEAL_LIMIT; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The limit counts the reveals in order.
    const answer = await reveal(
      spender,
      spenderCase,
      index % 2 === 0 ? maria : joao,
      index % 3 === 0 ? "email" : "phone"
    );
    assert.ok(answer, `reveal ${index + 1} is accepted`);
  }
  assert.equal(await revealRows(spender), REVEAL_LIMIT);
  const auditBefore = Number(
    (
      await owner.pool.query<{ total: string }>(
        "SELECT count(*) AS total FROM public.platform_audit_events"
      )
    ).rows[0]?.total
  );
  await assert.rejects(
    () => reveal(spender, spenderCase, maria, "name"),
    limited(),
    "the 31st reveal of the hour is refused"
  );
  await assert.rejects(
    () => reveal(spender, spenderCase, maria, "email"),
    limited(),
    "a repeat of a field already revealed is refused as well"
  );
  assert.equal(
    Number(
      (
        await owner.pool.query<{ total: string }>(
          "SELECT count(*) AS total FROM public.platform_audit_events"
        )
      ).rows[0]?.total
    ),
    auditBefore,
    "a refused reveal leaves no row in the audit"
  );
  // the order of the checks: the grant and the field come before the count, so their refusals stay what they were
  await refused(
    () => reveal(spender, spenderCase, maria, "secret" as never),
    "invalid_field"
  );
  await denied(() => reveal(spender, randomUUID(), maria));

  // the limit is the operator's own: another operator, on the same store, is not affected
  const other = await principal();
  const otherCase = await limitedCase(other, orgA.organizationId);
  assert.equal(
    (await reveal(other, otherCase, maria, "email"))?.value,
    "maria.souza@exemplo.com.br"
  );

  // two cases and two stores share one quota
  const sharer = await principal();
  const sharerCaseA = await limitedCase(sharer, orgA.organizationId);
  const sharerCaseB = await limitedCase(sharer, orgB.organizationId);
  for (let index = 0; index < REVEAL_LIMIT - 1; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The limit counts the reveals in order.
    await reveal(sharer, sharerCaseA, maria, "email");
  }
  assert.ok(await reveal(sharer, sharerCaseB, outsider, "email"));
  await assert.rejects(
    () => reveal(sharer, sharerCaseA, maria, "email"),
    limited(),
    "the quota is counted by operator, not by case"
  );
  await assert.rejects(
    () => reveal(sharer, sharerCaseB, outsider, "email"),
    limited(),
    "the quota is counted by operator, not by store"
  );

  // the lock is the operator's own and has its own key: the lock of the operator's refunds does not hold a reveal
  const locker = await principal();
  const lockerCase = await limitedCase(locker, orgA.organizationId);
  const holder = await owner.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('admin_operator_refund:' || $1::text, 0))",
      [locker]
    );
    assert.ok(
      await reveal(locker, lockerCase, maria, "email"),
      "the lock of the refunds does not hold a reveal"
    );
    await holder.query("COMMIT");

    // the last slot, asked for by two requests while the operator's lock is held: both wait, and once it is released
    // the first counts 29 and takes the slot, and the second counts 30 and is refused
    const racer = await principal();
    const racerCase = await limitedCase(racer, orgA.organizationId);
    await backdatedReveals(racer, racerCase, REVEAL_LIMIT - 1, 5);
    await holder.query("BEGIN");
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('admin_operator_reveal:' || $1::text, 0))",
      [racer]
    );
    const holderPid = Number(
      (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid
    );
    let settled = 0;
    const raced = [
      reveal(racer, racerCase, maria, "email"),
      reveal(racer, racerCase, maria, "phone"),
    ].map((request) =>
      request.finally(() => {
        settled += 1;
      })
    );
    const outcomes = Promise.allSettled(raced);
    let queued = 0;
    for (let poll = 0; poll < 200 && queued < 2; poll += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Polls the signal that both reveals wait for the lock.
      const blocked = await owner.pool.query<{ total: string }>(
        "SELECT count(*) AS total, pg_sleep(0.05) FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
        [holderPid]
      );
      queued = Number(blocked.rows[0]?.total);
    }
    assert.equal(queued, 2, "both reveals wait for the lock of their operator");
    assert.equal(settled, 0);
    assert.equal(await revealRows(racer), REVEAL_LIMIT - 1);
    await holder.query("COMMIT");
    const results = await outcomes;
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "one of the two takes the last slot"
    );
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(
          limited()(result.reason),
          "the other is refused by the limit"
        );
      }
    }
    assert.equal(await revealRows(racer), REVEAL_LIMIT);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }

  // the hour: 30 reveals 59 minutes ago still count; the same 30, 61 minutes ago, do not
  const recent = await principal();
  const recentCase = await limitedCase(recent, orgA.organizationId);
  await backdatedReveals(recent, recentCase, REVEAL_LIMIT, 59);
  await assert.rejects(
    () => reveal(recent, recentCase, maria, "email"),
    limited(),
    "30 reveals of the last hour block"
  );
  const aged = await principal();
  const agedCase = await limitedCase(aged, orgA.organizationId);
  await backdatedReveals(aged, agedCase, REVEAL_LIMIT, 61);
  assert.ok(
    await reveal(aged, agedCase, maria, "email"),
    "the hour after releases the operator"
  );

  // the new function keeps the permissions, the owner, the pinned search_path and the reads of the previous one
  const revealFunction = await owner.pool.query<{
    args: string;
    config: string[];
    definer: boolean;
    grantees: string[];
    owner: string;
    public_runs: boolean;
    others_run: boolean;
    runtime_runs: boolean;
  }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args,
            p.proconfig AS config,
            p.prosecdef AS definer,
            pg_get_userbyid(p.proowner) AS owner,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_runs,
            has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE') AS runtime_runs,
            (has_function_privilege('polaris_pr11_runtime', p.oid, 'EXECUTE')
             OR has_function_privilege('polaris_billing_runtime', p.oid, 'EXECUTE')
             OR has_function_privilege('polaris_catalog_runtime', p.oid, 'EXECUTE')) AS others_run,
            COALESCE((SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text) FROM aclexplode(p.proacl) WHERE privilege_type = 'EXECUTE'), '{}') AS grantees
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_reveal_customer_field'`
  );
  assert.deepEqual(
    revealFunction.rows,
    [
      {
        args: "p_principal uuid, p_case uuid, p_customer uuid, p_field text",
        config: ["search_path=pg_catalog, public, pg_temp"],
        definer: true,
        grantees: ["polaris_admin_owner", "polaris_admin_runtime"],
        others_run: false,
        owner: "polaris_admin_owner",
        public_runs: false,
        runtime_runs: true,
      },
    ],
    "the reveal function keeps its signature, owner, pinned search_path and EXECUTE only for the Admin role (and its owner)"
  );
  const definition = await owner.pool.query<{ source: string }>(
    "SELECT prosrc AS source FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admin_reveal_customer_field'"
  );
  const source = definition.rows[0]?.source ?? "";
  assert.ok(
    source.indexOf("operator_reveal_rate_limited") > 0 &&
      source.indexOf("operator_reveal_rate_limited") <
        source.indexOf("FROM public.customers"),
    "the count comes before the customer is read"
  );
  assert.deepEqual(
    [...source.matchAll(/customer\.(\w+)/g)].map((match) => match[1]).sort(),
    ["email", "id", "name", "notes", "organization_id", "phone"],
    "the columns of the customer read are the same four fields plus the key"
  );
  const index = await owner.pool.query<{ definition: string }>(
    "SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = 'public.platform_audit_events'::regclass AND indexrelid::regclass::text = 'platform_audit_events_principal_event_idx'"
  );
  assert.match(index.rows[0]?.definition ?? "", AUDIT_INDEX_COLUMNS);
  tests.push(
    `the reveal limit: ${REVEAL_LIMIT} reveals of one operator in an hour are accepted (a repeat of a field counts) and the next is refused with operator_reveal_rate_limited without a new audit row; an unknown customer or one of another store spends no slot; another operator is not affected; two cases and two stores share one quota; the last slot goes to one of two requests that both wait for the operator's own lock (the lock of the operator's refunds does not hold a reveal); 30 reveals 59 minutes ago block and 61 minutes ago do not; invalid field and missing grant keep their own refusals; the function keeps its signature, owner, search_path, EXECUTE only for the Admin role and the same customer columns, and the index by operator, type and time exists`
  );
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
      "polaris_sup_admin"
    );
    const tenantUrl = await login(runtimeRole, "polaris_sup_tenant");
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_sup_billing"
    );
    const catalogUrl = await login(
      "polaris_catalog_runtime",
      "polaris_sup_catalog"
    );
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

    // ------------------------------------------------- fixtures
    const principal = async (status = "active") =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
    const [p1, p2, disabled] = [
      await principal(),
      await principal(),
      await principal("disabled"),
    ] as [string, string, string];
    const suffix = randomUUID().slice(0, 8);
    const orgA = await createTenantFixture(
      owner.pool,
      `support A ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const orgB = await createTenantFixture(
      owner.pool,
      `support B ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const customer = async (
      organizationId: string,
      name: string,
      email: string | null,
      phone: string | null,
      notes: string | null
    ) =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.customers (organization_id, name, email, phone, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [organizationId, name, email, phone, notes]
        )
      ).rows[0]?.id as string;
    const maria = await customer(
      orgA.organizationId,
      "Maria Souza Lima",
      "maria.souza@exemplo.com.br",
      "+55 (11) 91234-5678",
      "Alergia a látex; prefere contato à tarde"
    );
    const joao = await customer(
      orgA.organizationId,
      "João",
      null,
      "11 98888-7766",
      null
    );
    const ana = await customer(
      orgA.organizationId,
      "Ana Paula",
      "ana@exemplo.org",
      null,
      "vip"
    );
    const outsider = await customer(
      orgB.organizationId,
      "Carlos Pereira",
      "carlos@outra.com",
      null,
      null
    );

    // ------------------------------------------------- 1. who can do what
    for (const statement of [
      "SELECT 1 FROM public.support_cases",
      "SELECT 1 FROM public.tenant_access_grants",
      "SELECT 1 FROM public.platform_audit_events",
      "INSERT INTO public.support_cases (organization_id, kind, reason, opened_by) VALUES ('x', 'support', 'x', gen_random_uuid())",
      "SELECT 1 FROM public.customers",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
      await expectSqlState(
        () => asAdmin((client) => client.query(statement)),
        "42501",
        `the Admin role cannot: ${statement}`
      );
    }
    for (const [label, url] of [
      ["tenant", tenantUrl],
      ["billing", billingUrl],
      ["catalog", catalogUrl],
    ] as const) {
      for (const statement of [
        "SELECT public.admin_support_case_detail(gen_random_uuid())",
        "SELECT public.admin_tenant_customers(gen_random_uuid(), gen_random_uuid(), 10, NULL)",
        "SELECT public.admin_reveal_customer_field(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'email')",
        "SELECT public.admin_require_grant(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.admin_record_audit(gen_random_uuid(), 'pii.revealed', NULL, NULL, NULL, NULL, NULL)",
        "SELECT public.admin_mask_email('a@b.co')",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
        await expectSqlState(
          () => connect(url, (client) => client.query(statement)),
          "42501",
          `the ${label} role cannot run: ${statement}`
        );
      }
    }
    for (const statement of [
      "SELECT public.admin_require_grant(gen_random_uuid(), gen_random_uuid())",
      "SELECT public.admin_record_audit(gen_random_uuid(), 'pii.revealed', NULL, NULL, NULL, NULL, NULL)",
      "SELECT public.admin_require_principal(gen_random_uuid())",
      "SELECT public.admin_mask_name('Ana')",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
      await expectSqlState(
        () => asAdmin((client) => client.query(statement)),
        "42501",
        `the helpers are not the Admin role's to run: ${statement}`
      );
    }
    // the owner of the access log is the one other role that runs Admin functions: its own reader and the two audit
    // helpers that reader calls (the access-log gate proves exactly which)
    const closedToOthers = await owner.pool.query<{
      name: string;
      role: string;
    }>(
      `SELECT p.proname AS name, COALESCE(r.rolname, 'PUBLIC') AS role
         FROM pg_proc p
         CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris%' UNION ALL SELECT NULL) AS r
        WHERE p.pronamespace = 'public'::regnamespace
          AND left(p.proname, 6) = 'admin_'
          AND (r.rolname IS NULL OR NOT (pg_has_role(r.rolname, 'polaris_admin_runtime', 'MEMBER') OR r.rolname IN ('polaris_admin_owner', 'polaris_access_log_owner')))
          AND CASE WHEN r.rolname IS NULL THEN has_function_privilege('public', p.oid, 'EXECUTE')
                   ELSE has_function_privilege(r.rolname, p.oid, 'EXECUTE') END`
    );
    assert.deepEqual(
      closedToOthers.rows,
      [],
      "no other role, and not PUBLIC, runs any Admin function or helper"
    );
    const runnable = await owner.pool.query<{ name: string }>(
      "SELECT p.proname AS name FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE') ORDER BY 1"
    );
    assert.deepEqual(
      runnable.rows.map((row) => row.name),
      ADMIN_FUNCTIONS
    );
    const reach = await owner.pool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND c.relname <> 'platform_principals'
          AND (has_table_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR (c.relkind <> 'S' AND has_any_column_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))`
    );
    assert.deepEqual(
      reach.rows,
      [],
      "the Admin role still reaches no table beyond the principals"
    );
    for (const table of [
      "support_cases",
      "tenant_access_grants",
      "platform_audit_events",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three probes, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(tenantUrl, orgA, (client) =>
            client.query(`SELECT 1 FROM public.${table}`)
          ),
        "42501",
        `the tenant role cannot read ${table}`
      );
      const flags = await owner.pool.query<{ forced: boolean; rls: boolean }>(
        "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
        [`public.${table}`]
      );
      assert.deepEqual(
        flags.rows,
        [{ forced: true, rls: true }],
        `${table} forces row security`
      );
    }
    tests.push(
      "the Admin role reaches no table beyond the principals and runs exactly the ten Admin functions (not the helpers, not the masks); no other role runs any of them or reads the new tables, which force row security"
    );

    // ------------------------------------------------- 2. cases
    const denied = async (operation: () => Promise<unknown>) =>
      assert.rejects(operation, TenantAccessDeniedError);
    const refused = async (operation: () => Promise<unknown>, code: string) =>
      assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof InvalidSupportRequestError);
        assert.equal(error.code, code);
        return true;
      });
    const open = (
      principalId: string,
      organizationId = orgA.organizationId,
      kind = "support",
      reason = "Cliente não consegue vender",
      context: string | null = "ticket 123"
    ) =>
      asAdmin((client) =>
        openSupportCase(client, principalId, {
          context,
          kind,
          organizationId,
          reason,
        })
      );
    const grantCase = await open(p1);
    assert.ok(grantCase?.id);
    assert.equal(grantCase.status, "open");
    await denied(() => open(disabled));
    await denied(() => open(randomUUID()));
    await refused(
      () => open(p1, orgA.organizationId, "audit"),
      "invalid_case_kind"
    );
    await refused(
      () => open(p1, orgA.organizationId, "support", "   "),
      "invalid_case_reason"
    );
    await refused(
      () => open(p1, orgA.organizationId, "support", "x".repeat(501)),
      "invalid_case_reason"
    );
    await refused(
      () => open(p1, orgA.organizationId, "support", "x", "y".repeat(2001)),
      "invalid_case_context"
    );
    await refused(
      () => open(p1, "no-such-organization"),
      "unknown_organization"
    );
    // a privacy case is opened through its own workflow (the generic opening refuses it)
    await refused(
      () =>
        open(p2, orgB.organizationId, "privacy", "Pedido de acesso do titular"),
      "privacy_case_workflow_required"
    );
    const privacyCase = await asAdmin((client) =>
      openPrivacyCase(client, p2, {
        channel: "email",
        dueDays: 15,
        note: null,
        organizationId: orgB.organizationId,
        reason: "Pedido de acesso do titular",
        receivedAt: null,
        requesterKind: "data_subject",
        requestType: "access",
      })
    );
    const open2 = await asAdmin((client) =>
      listSupportCases(client, {
        after: null,
        limit: 50,
        organizationId: null,
        status: "open",
      })
    );
    assert.ok(open2.cases.some((entry) => entry.id === grantCase.id));
    const byOrganization = await asAdmin((client) =>
      listSupportCases(client, {
        after: null,
        limit: 50,
        organizationId: orgB.organizationId,
        status: null,
      })
    );
    assert.deepEqual(
      byOrganization.cases.map((entry) => entry.id),
      [privacyCase?.id]
    );
    assert.ok(byOrganization.cases[0]?.organizationName.includes("support B"));
    const firstPage = await asAdmin((client) =>
      listSupportCases(client, {
        after: null,
        limit: 1,
        organizationId: null,
        status: null,
      })
    );
    assert.equal(firstPage.cases.length, 1);
    assert.ok(firstPage.next);
    const secondPage = await asAdmin((client) =>
      listSupportCases(client, {
        after: firstPage.next,
        limit: 1,
        organizationId: null,
        status: null,
      })
    );
    assert.equal(secondPage.cases.length, 1);
    assert.ok(
      (secondPage.cases[0]?.id ?? "") < (firstPage.cases[0]?.id ?? ""),
      "newest first"
    );
    for (const size of [0, 51]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              "SELECT public.admin_list_support_cases(NULL, NULL, $1, NULL, NULL)",
              [size]
            )
          ),
        "22023",
        `a page size of ${size}`
      );
    }
    // every page to the end: a database with more than a page of cases (the gate does not own all of them) still lists whole
    const ofKind = async (
      kind: string | null,
      status: string | null = null
    ): Promise<{ cases: SupportCaseSummary[] }> => {
      const cases: SupportCaseSummary[] = [];
      let after: string | null = null;
      do {
        const cursor: string | null = after;
        // biome-ignore lint/performance/noAwaitInLoops: each page needs the cursor of the previous one.
        const page: SupportCasePage = await asAdmin((client) =>
          listSupportCases(client, {
            after: cursor,
            kind,
            limit: 50,
            organizationId: null,
            status,
          })
        );
        cases.push(...page.cases);
        after = page.next;
      } while (after !== null);
      return { cases };
    };
    const supportOnly = await ofKind("support");
    const privacyOnly = await ofKind("privacy");
    const everyKind = await ofKind(null);
    assert.ok(supportOnly.cases.some((entry) => entry.id === grantCase.id));
    assert.ok(!supportOnly.cases.some((entry) => entry.id === privacyCase?.id));
    assert.ok(supportOnly.cases.every((entry) => entry.kind === "support"));
    assert.ok(privacyOnly.cases.some((entry) => entry.id === privacyCase?.id));
    assert.ok(!privacyOnly.cases.some((entry) => entry.id === grantCase.id));
    assert.ok(privacyOnly.cases.every((entry) => entry.kind === "privacy"));
    assert.deepEqual(
      everyKind.cases.map((entry) => entry.id),
      [...supportOnly.cases, ...privacyOnly.cases]
        .map((entry) => entry.id)
        .sort()
        .reverse(),
      "without a kind, every case is listed"
    );
    const openSupport = await ofKind("support", "open");
    assert.ok(
      openSupport.cases.every(
        (entry) => entry.kind === "support" && entry.status === "open"
      )
    );
    const supportPage = await asAdmin((client) =>
      listSupportCases(client, {
        after: null,
        kind: "support",
        limit: 1,
        organizationId: null,
        status: null,
      })
    );
    assert.equal(supportPage.cases.length, 1);
    assert.equal(
      supportPage.next === null,
      supportOnly.cases.length <= 1,
      "the next page of a kind counts only that kind"
    );
    for (const kind of ["audit", "", "SUPPORT", "support "]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              "SELECT public.admin_list_support_cases(NULL, NULL, 10, NULL, $1)",
              [kind]
            )
          ),
        "22023",
        `the kind ${JSON.stringify(kind)} is not on the list`
      );
    }
    const signatures = await owner.pool.query<{
      args: string;
      config: string[] | null;
      definer: boolean;
      owner: string;
      public_runs: boolean;
      runtime_runs: boolean;
      others_run: boolean;
    }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args,
              p.proconfig AS config,
              p.prosecdef AS definer,
              pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_runs,
              has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE') AS runtime_runs,
              (has_function_privilege('polaris_pr11_runtime', p.oid, 'EXECUTE')
               OR has_function_privilege('polaris_billing_runtime', p.oid, 'EXECUTE')
               OR has_function_privilege('polaris_catalog_runtime', p.oid, 'EXECUTE')) AS others_run
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_list_support_cases'
        ORDER BY 1`
    );
    assert.deepEqual(
      signatures.rows,
      [
        {
          args: "p_status text, p_organization_id text, p_limit integer, p_after uuid, p_kind text",
          config: ["search_path=pg_catalog, public, pg_temp"],
          definer: true,
          others_run: false,
          owner: "polaris_admin_owner",
          public_runs: false,
          runtime_runs: true,
        },
      ],
      "the list function has only the signature with the kind (the four-argument one is gone), as the Admin owner, definer, pinned and run only by the Admin role"
    );
    await expectSqlState(
      () =>
        asAdmin((client) =>
          client.query(
            "SELECT public.admin_list_support_cases(NULL, NULL, 50, NULL)"
          )
        ),
      "42883",
      "the four-argument call no longer exists"
    );
    tests.push(
      "the list of cases narrows to one kind of the closed list (null lists every kind, another value is refused with 22023, the next page counts only that kind) and the only signature of the list function is owned by the Admin owner, with a pinned search_path and EXECUTE only for the Admin role"
    );
    tests.push(
      "a case opens only for a real organization, with a known kind, a reason of 1 to 500 characters and a context of up to 2000, by an active operator (a disabled or unknown principal is refused); cases are listed newest first, by status or organization, a page at a time"
    );

    // ------------------------------------------------- 3. no access without a grant
    const customersOf = (
      principalId: string,
      caseId: string,
      limit = 10,
      after: string | null = null
    ) =>
      asAdmin((client) =>
        listTenantCustomers(client, principalId, caseId, { after, limit })
      );
    const reveal = (
      principalId: string,
      caseId: string,
      customerId: string,
      field: "email" | "name" | "phone" | "notes" = "email"
    ) =>
      asAdmin((client) =>
        revealCustomerField(client, principalId, caseId, customerId, field)
      );
    await denied(() => customersOf(p1, grantCase.id));
    await denied(() => reveal(p1, grantCase.id, maria));

    for (const minutes of [4, 241, 0, -5]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await refused(
        () =>
          asAdmin((client) =>
            grantTenantAccess(client, p1, grantCase.id, minutes)
          ),
        "invalid_duration"
      );
    }
    await refused(
      () =>
        asAdmin((client) => grantTenantAccess(client, p1, randomUUID(), 60)),
      "unknown_case"
    );
    await denied(() =>
      asAdmin((client) => grantTenantAccess(client, disabled, grantCase.id, 60))
    );
    const grant = await asAdmin((client) =>
      grantTenantAccess(client, p1, grantCase.id, 60)
    );
    assert.ok(grant);
    assert.equal(grant.organizationId, orgA.organizationId);
    assert.equal(
      new Date(grant.expiresAt).getTime() - new Date(grant.startsAt).getTime(),
      60 * 60_000,
      "an hour"
    );
    // no duration asked for is an hour
    const unspecified = await asAdmin((client) =>
      client.query<{ result: { expiresAt: string; startsAt: string } }>(
        "SELECT public.admin_grant_tenant_access($1, $2, NULL) AS result",
        [p1, grantCase.id]
      )
    );
    const asked = unspecified.rows[0]?.result;
    assert.ok(asked);
    assert.equal(
      new Date(asked.expiresAt).getTime() - new Date(asked.startsAt).getTime(),
      60 * 60_000
    );
    tests.push(
      "without a grant nothing of the organization can be read or revealed; a grant is 5 to 240 minutes (an hour by default), needs an existing, open case and an active operator"
    );

    // ------------------------------------------------- 4. the masked read
    const page = await customersOf(p1, grantCase.id, 10);
    assert.equal(
      page.customers.length,
      3,
      "only this organization's customers"
    );
    const byId = new Map(page.customers.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.get(maria), {
      archived: false,
      email: "m***@e***.br",
      hasNotes: true,
      id: maria,
      name: "M*** S*** L***",
      phone: "***78",
    });
    assert.deepEqual(byId.get(joao), {
      archived: false,
      email: null,
      hasNotes: false,
      id: joao,
      name: "J***",
      phone: "***66",
    });
    assert.equal(byId.get(ana)?.email, "a***@e***.org");
    assert.equal(byId.get(ana)?.phone, null);
    const text = JSON.stringify(page);
    for (const forbidden of [
      "Maria",
      "Souza",
      "Lima",
      "maria.souza",
      "91234",
      "Alergia",
      "látex",
      "Paula",
      "ana@exemplo",
      "98888",
      "vip",
      outsider,
      "Carlos",
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `the masked page never contains ${forbidden}`
      );
    }
    for (const entry of page.customers) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "archived",
        "email",
        "hasNotes",
        "id",
        "name",
        "phone",
      ]);
    }
    const small = await customersOf(p1, grantCase.id, 2);
    assert.equal(small.customers.length, 2);
    assert.ok(small.next);
    const rest = await customersOf(p1, grantCase.id, 2, small.next);
    assert.equal(rest.customers.length, 1);
    assert.equal(rest.next, null);
    assert.deepEqual(
      [...small.customers, ...rest.customers].map((entry) => entry.id),
      page.customers.map((entry) => entry.id)
    );
    for (const size of [0, 51]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two probes, in order.
      await expectSqlState(
        () =>
          asAdmin((client) =>
            client.query(
              "SELECT public.admin_tenant_customers($1, $2, $3, NULL)",
              [p1, grantCase.id, size]
            )
          ),
        "22023",
        `a page size of ${size}`
      );
    }
    // the grant belongs to one operator and one case
    await denied(() => customersOf(p2, grantCase.id));
    await denied(() => customersOf(p1, privacyCase?.id as string));
    tests.push(
      "with a grant the organization's customers are read masked (a name keeps the first letter of each word, an e-mail its first letters and ending, a phone its last two digits, notes only as a yes or no) and never anyone else's; the page carries a closed set of keys and none of the real values; pages follow the order; the grant belongs to one operator and one case"
    );

    // masks of awkward values: a longer domain, one-letter words, a short phone
    const orgC = await createTenantFixture(
      owner.pool,
      `support C ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const awkward = await customer(
      orgC.organizationId,
      "J o a o",
      "x@mail.empresa.com.br",
      "12",
      null
    );
    const awkward2 = await customer(
      orgC.organizationId,
      "Zé",
      "weird-address",
      "+55 9",
      "a"
    );
    const maskCase = await open(p1, orgC.organizationId);
    assert.ok(maskCase);
    assert.ok(
      await asAdmin((client) => grantTenantAccess(client, p1, maskCase.id, 30))
    );
    const awkwardPage = await customersOf(p1, maskCase.id);
    const awkwardById = new Map(
      awkwardPage.customers.map((entry) => [entry.id, entry])
    );
    assert.equal(
      awkwardById.get(awkward)?.name,
      "*** *** *** ***",
      "a one-letter word is not shown"
    );
    assert.equal(
      awkwardById.get(awkward)?.email,
      "x***@m***.br",
      "only the last label of the domain is left"
    );
    assert.equal(
      awkwardById.get(awkward)?.phone,
      "***",
      "too few digits to show any"
    );
    assert.equal(awkwardById.get(awkward2)?.name, "Z***");
    assert.equal(
      awkwardById.get(awkward2)?.email,
      "***",
      "what is not an address shows nothing"
    );
    assert.equal(awkwardById.get(awkward2)?.phone, "***");

    // ------------------------------------------------- 5. the reveal
    const revealed = await reveal(p1, grantCase.id, maria, "email");
    assert.deepEqual(revealed, {
      customerId: maria,
      field: "email",
      value: "maria.souza@exemplo.com.br",
    });
    assert.equal(
      (await reveal(p1, grantCase.id, maria, "notes"))?.value,
      "Alergia a látex; prefere contato à tarde"
    );
    assert.equal(
      (await reveal(p1, grantCase.id, maria, "name"))?.value,
      "Maria Souza Lima"
    );
    assert.equal(
      (await reveal(p1, grantCase.id, maria, "phone"))?.value,
      "+55 (11) 91234-5678"
    );
    assert.equal(
      (await reveal(p1, grantCase.id, joao, "email"))?.value,
      null,
      "a field that is empty reveals nothing"
    );
    assert.equal(
      await reveal(p1, grantCase.id, outsider, "email"),
      null,
      "another organization's customer is not here"
    );
    assert.equal(await reveal(p1, grantCase.id, randomUUID(), "email"), null);
    for (const field of ["password", "id", "", "organization_id"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await refused(
        () => reveal(p1, grantCase.id, maria, field as never),
        "invalid_field"
      );
    }
    await denied(() => reveal(p2, grantCase.id, maria));
    tests.push(
      "a reveal returns the real field only with an active grant, only for a customer of the case's organization, only for name, e-mail, phone or notes; a customer elsewhere or unknown is nothing; another operator is refused"
    );

    // ------------------------------------------------- 6. the audit
    const detail = await asAdmin((client) =>
      readSupportCase(client, grantCase.id)
    );
    assert.ok(detail);
    const events = detail.audit.map((entry) => [
      entry.eventType,
      entry.entityType,
      entry.detail,
    ]);
    assert.ok(
      events.some(
        ([type, , note]) => type === "support_case.opened" && note === "support"
      )
    );
    assert.ok(
      events.some(
        ([type, , note]) =>
          type === "tenant_access.granted" && note === "minutes=60"
      )
    );
    assert.ok(
      events.some(
        ([type, , note]) =>
          type === "tenant_data.customers_read" && note === "count=3"
      )
    );
    const reveals = detail.audit.filter(
      (entry) => entry.eventType === "pii.revealed"
    );
    assert.deepEqual(
      reveals
        .map((entry) => [entry.entityType, entry.entityId, entry.detail])
        .sort(),
      [
        ["customer", maria, "email"],
        ["customer", maria, "name"],
        ["customer", maria, "notes"],
        ["customer", maria, "phone"],
        ["customer", joao, "email"],
      ].sort()
    );
    assert.ok(reveals.every((entry) => entry.principalId === p1));
    // the audit never holds what was revealed
    const auditText = JSON.stringify(
      (
        await owner.pool.query(
          "SELECT * FROM public.platform_audit_events WHERE support_case_id = $1",
          [grantCase.id]
        )
      ).rows
    );
    for (const secret of [
      "maria.souza",
      "Souza",
      "91234",
      "Alergia",
      "látex",
    ]) {
      assert.ok(!auditText.includes(secret), `the audit never holds ${secret}`);
    }
    // a customer that was not found leaves no reveal behind
    assert.equal(
      detail.audit.filter(
        (entry) =>
          entry.eventType === "pii.revealed" && entry.entityId === outsider
      ).length,
      0
    );
    assert.equal(detail.case.openedBy, p1);
    assert.equal(detail.grants.length >= 1, true);
    assert.equal(
      detail.grants.some((entry) => entry.active),
      true
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "UPDATE public.platform_audit_events SET detail = 'tampered' WHERE support_case_id = $1",
          [grantCase.id]
        ),
      "23514",
      "the audit cannot be changed, even by the database owner"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "DELETE FROM public.platform_audit_events WHERE support_case_id = $1",
          [grantCase.id]
        ),
      "23514",
      "the audit cannot be deleted"
    );
    await expectSqlState(
      () => owner.pool.query("TRUNCATE public.platform_audit_events"),
      "23514",
      "the audit cannot be truncated"
    );
    tests.push(
      "every case opened, grant given, read of customers and reveal is in the audit with who, what and which record (a field name, a count, a duration) and never the value; a reveal that found nothing leaves nothing; the audit cannot be updated, deleted or truncated even by the database owner"
    );

    // ------------------------------------------------- 7. when access ends
    // an operator disabled after being given access loses it at once
    const fifth = await principal();
    const sixth = await open(fifth);
    assert.ok(sixth);
    assert.ok(
      await asAdmin((client) => grantTenantAccess(client, fifth, sixth.id, 30))
    );
    assert.ok(await customersOf(fifth, sixth.id));
    await owner.pool.query(
      "UPDATE public.platform_principals SET status = 'disabled' WHERE id = $1",
      [fifth]
    );
    await denied(() => customersOf(fifth, sixth.id));
    await denied(() => reveal(fifth, sixth.id, maria));
    // an expired grant
    await owner.pool.query(
      "UPDATE public.tenant_access_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE support_case_id = $1",
      [grantCase.id]
    );
    await denied(() => customersOf(p1, grantCase.id));
    await denied(() => reveal(p1, grantCase.id, maria));
    assert.equal(
      (
        await asAdmin((client) => readSupportCase(client, grantCase.id))
      )?.grants.some((entry) => entry.active),
      false
    );
    // a revoked grant
    const second = await asAdmin((client) =>
      grantTenantAccess(client, p1, grantCase.id, 30)
    );
    assert.ok(second);
    assert.ok(await customersOf(p1, grantCase.id));
    assert.equal(
      await asAdmin((client) => revokeTenantAccess(client, p2, second.id)),
      true,
      "any active operator may end a grant"
    );
    await denied(() => customersOf(p1, grantCase.id));
    assert.equal(
      await asAdmin((client) => revokeTenantAccess(client, p1, second.id)),
      false,
      "ending it twice is one"
    );
    await denied(() =>
      asAdmin((client) => revokeTenantAccess(client, disabled, second.id))
    );
    // closing the case ends every grant, once
    const third = await asAdmin((client) =>
      grantTenantAccess(client, p1, grantCase.id, 120)
    );
    const fourth = await asAdmin((client) =>
      grantTenantAccess(client, p1, grantCase.id, 120)
    );
    assert.ok(third && fourth);
    const closed = await asAdmin((client) =>
      closeSupportCase(client, p1, grantCase.id, "Resolvido por telefone")
    );
    assert.deepEqual(closed, {
      changed: true,
      id: grantCase.id,
      revokedGrants: 2,
      status: "closed",
    });
    await denied(() => customersOf(p1, grantCase.id));
    await denied(() => reveal(p1, grantCase.id, maria));
    // a closed case stays closed and a revoked access stays revoked, even by a change around the functions
    await expectSqlState(
      () =>
        owner.pool.query(
          "UPDATE public.support_cases SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = $1",
          [grantCase.id]
        ),
      "23514",
      "a closed case cannot be reopened"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "UPDATE public.tenant_access_grants SET revoked_at = NULL, revoked_by = NULL WHERE id = $1",
          [second.id]
        ),
      "23514",
      "a revoked access cannot be undone"
    );
    await refused(
      () =>
        asAdmin((client) => grantTenantAccess(client, p1, grantCase.id, 60)),
      "case_not_open"
    );
    const again = await asAdmin((client) =>
      closeSupportCase(client, p1, grantCase.id, null)
    );
    assert.deepEqual(again, {
      changed: false,
      id: grantCase.id,
      status: "closed",
    });
    assert.equal(
      await asAdmin((client) =>
        closeSupportCase(client, p1, randomUUID(), null)
      ),
      null
    );
    await refused(
      () =>
        asAdmin((client) =>
          closeSupportCase(
            client,
            p1,
            privacyCase?.id as string,
            "x".repeat(501)
          )
        ),
      "invalid_case_resolution"
    );
    const closedDetail = await asAdmin((client) =>
      readSupportCase(client, grantCase.id)
    );
    assert.equal(closedDetail?.case.status, "closed");
    assert.equal(closedDetail?.case.resolution, "Resolvido por telefone");
    assert.equal(
      closedDetail?.audit.filter(
        (entry) => entry.eventType === "support_case.closed"
      ).length,
      1
    );
    assert.equal(
      closedDetail?.audit.filter(
        (entry) => entry.eventType === "tenant_access.revoked"
      ).length,
      1
    );
    assert.ok(
      closedDetail?.audit.some(
        (entry) =>
          entry.eventType === "support_case.closed" &&
          entry.detail === "revoked=2"
      )
    );
    tests.push(
      "access ends when the grant expires, when it is revoked (once, by any active operator) and when the case is closed (every grant at once, once); a closed case takes no new grant"
    );

    await verifyRevealLimit({
      asAdmin,
      denied,
      joao,
      maria,
      open,
      orgA,
      orgB,
      outsider,
      owner,
      principal,
      refused,
      reveal,
      tests,
    });

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
    `Admin support PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
