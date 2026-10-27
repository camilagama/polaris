import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/client";
import { isLocalGateHost } from "./gate-hosts";
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
  withRuntimeSqlContext,
} from "./sales-gate-support";

/**
 * The Admin Worker through its real `fetch`, inside workerd, against the PostgreSQL of the job (T-127a, plan
 * PR127). This script makes what the Worker needs (the Admin and billing logins, two platform principals, four
 * organizations with customers), runs the Vitest project `admin-workerd-db` (apps/admin/src/worker.workerd-db.test.ts,
 * Cloudflare Access simulated by the harness) and then reads the database as the owner: what the refused requests must
 * not have written, and what the owner's flows must have. Local Postgres only (`CI=true`): the harness refuses any
 * other host, and the Hyperdrive of this project is local (the Neon proof of the Worker is the T-123c smoke).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const TEAM_DOMAIN = "polaris-test.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const VITEST_TIMEOUT_MS = 5 * 60_000;
/** The reads of GET /api/funnel that worker.workerd-db.test.ts answers (its loop over weeks 1, 4 and 26): change both. */
const ACTIVATION_FUNNEL_ANSWERED_READS = 3;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const failureLine =
  /FAIL|Error|expected|Expected|Received|✗|×|Tests |Test Files/;
const lineBreak = /\r?\n/;
const urlPattern = /postgres(?:ql)?:\/\/\S+/gi;

interface RunResult {
  code: number;
  digest: string[];
}

/** Runs the Vitest project and keeps the lines that say what failed (the runner prints only the last lines of a gate). */
function runVitest(environment: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const child = spawn(
      process.execPath,
      ["run", "vitest", "run", "--config", "vitest.admin-worker.config.ts"],
      {
        cwd: repositoryRoot,
        // only what the run needs: not the owner URL of the database, which this process holds
        env: {
          ...Object.fromEntries(
            ["CI", "HOME", "LANG", "PATH", "TMPDIR"].flatMap((name) =>
              process.env[name] === undefined ? [] : [[name, process.env[name]]]
            )
          ),
          ...environment,
        },
        // its own process group, so the timeout takes workerd down with it
        detached: true,
      }
    );
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split(lineBreak)) {
        if (line.trim()) {
          lines.push(line.replace(urlPattern, "[redacted]"));
        }
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    }, VITEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        digest: lines.filter((line) => failureLine.test(line)).slice(-30),
      });
    });
  });
}

async function run() {
  assert.equal(
    process.env.CI,
    "true",
    "The Admin Worker gate runs only against the Postgres of the CI job."
  );
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);
  assert.ok(
    isLocalGateHost(parsedAdminUrl.hostname),
    "The Admin Worker gate needs the job's own Postgres."
  );

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

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      logins.push([role, group]);
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_adw_admin"
    );
    const billingLoginUrl = await login(
      "polaris_billing_runtime",
      "polaris_adw_billing"
    );
    const tenantUrl = await login(runtimeRole, "polaris_adw_tenant");

    // ------------------------------------------------- fixtures
    const suffix = randomUUID().slice(0, 8);
    const principal = async (subject: string, principalStatus: string) =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [ISSUER, subject, principalStatus]
        )
      ).rows[0]?.id as string;
    const ownerSubject = `owner-${randomUUID()}`;
    const disabledSubject = `disabled-${randomUUID()}`;
    const ownerId = await principal(ownerSubject, "active");
    const disabledId = await principal(disabledSubject, "disabled");
    // an active operator with the stranger's subject under ANOTHER issuer: the principal is found by issuer and subject
    const strangerSubject = `stranger-${randomUUID()}`;
    await owner.pool.query(
      "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', 'active')",
      ["https://other-team.cloudflareaccess.com", strangerSubject]
    );

    const organization = (label: string) =>
      createTenantFixture(
        owner.pool,
        `admin worker ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
    const orgA = await organization("A");
    const orgB = await organization("B");
    const orgSuspend = await organization("suspend");
    const orgReactivate = await organization("reactivate");
    const customer = async (
      organizationId: string,
      name: string,
      email: string,
      phone: string,
      where: "a" | "b"
    ) => {
      const id = (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.customers (organization_id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING id",
          [organizationId, name, email, phone]
        )
      ).rows[0]?.id as string;
      return { email, id, name, organization: where, phone };
    };
    const maria = await customer(
      orgA.organizationId,
      "Maria Souza Lima",
      `maria.souza.${suffix}@exemplo.com.br`,
      "+55 (11) 91234-5678",
      "a"
    );
    const carlos = await customer(
      orgB.organizationId,
      "Carlos Pereira",
      `carlos.${suffix}@outra.com`,
      "+55 (21) 98765-4321",
      "b"
    );
    const customers = [maria, carlos];
    const epoch = async (organizationId: string) =>
      Number(
        (
          await owner.pool.query<{ epoch: number }>(
            "SELECT max(authorization_epoch)::int AS epoch FROM public.memberships WHERE organization_id = $1",
            [organizationId]
          )
        ).rows[0]?.epoch
      );
    const status = async (organizationId: string) =>
      (
        await owner.pool.query<{ status: string }>(
          "SELECT status FROM public.organizations WHERE id = $1",
          [organizationId]
        )
      ).rows[0]?.status;
    const epochs = {
      a: await epoch(orgA.organizationId),
      reactivate: await epoch(orgReactivate.organizationId),
      suspend: await epoch(orgSuspend.organizationId),
    };

    // ------------------------------------------------- the Worker, through its real fetch
    const result = await runVitest({
      POLARIS_ADMIN_WORKER_ADMIN_URL: adminLoginUrl,
      POLARIS_ADMIN_WORKER_BILLING_URL: billingLoginUrl,
      POLARIS_ADMIN_WORKER_FIXTURE: JSON.stringify({
        customers,
        organizations: {
          a: orgA.organizationId,
          b: orgB.organizationId,
          reactivate: orgReactivate.organizationId,
          suspend: orgSuspend.organizationId,
        },
        principals: {
          disabled: disabledSubject,
          ownerId,
          ownerSubject,
        },
        strangerSubject,
        teamDomain: TEAM_DOMAIN,
      }),
    });
    if (result.code !== 0) {
      for (const line of result.digest) {
        console.error(line.slice(0, 220));
      }
      throw new Error(
        "The Admin Worker suite failed inside workerd (the lines above)."
      );
    }
    tests.push(
      "the Worker's real fetch, with Access simulated, refuses no token, a malformed, expired, foreign-key, wrong-audience or wrong-team token, a stranger and a disabled operator; serves the owner, the just-in-time access, the billing command and the suspension"
    );

    // ------------------------------------------------- what the database holds afterwards
    const count = async (sql: string, values: unknown[]) =>
      Number((await owner.pool.query<{ n: string }>(sql, values)).rows[0]?.n);

    // refused requests wrote nothing: organization B was the target of every write attempted without a login
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.support_cases WHERE organization_id = $1",
        [orgB.organizationId]
      ),
      0,
      "no case was opened on B"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.platform_audit_events WHERE organization_id = $1",
        [orgB.organizationId]
      ),
      0,
      "nothing of B was audited"
    );
    const touched = [
      orgA.organizationId,
      orgB.organizationId,
      orgSuspend.organizationId,
      orgReactivate.organizationId,
    ];
    // the audit is append-only and shared with the gates that ran before: only what is about these organizations counts
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.platform_audit_events WHERE organization_id = ANY($1) AND principal_id <> $2",
        [touched, ownerId]
      ),
      0,
      "only the owner acted on these organizations"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.platform_audit_events WHERE principal_id = $1",
        [disabledId]
      ),
      0,
      "the disabled operator left nothing"
    );
    // every answered read of the activation funnel left one event of its operator, with nothing in it; a refused one none
    const funnelReads = await owner.pool.query<{
      detail: string | null;
      entity_id: string | null;
      entity_type: string | null;
      organization_id: string | null;
      principal_id: string;
      support_case_id: string | null;
    }>(
      "SELECT principal_id, organization_id, support_case_id, entity_type, entity_id, detail FROM public.platform_audit_events WHERE event_type = 'activation_funnel.read' AND principal_id = ANY($1)",
      [[ownerId, disabledId]]
    );
    assert.equal(
      funnelReads.rows.length,
      ACTIVATION_FUNNEL_ANSWERED_READS,
      "one event per answered read of the funnel"
    );
    for (const row of funnelReads.rows) {
      assert.equal(row.principal_id, ownerId);
      assert.equal(row.organization_id, null);
      assert.equal(row.support_case_id, null);
      assert.equal(row.entity_type, "activation_funnel");
      assert.equal(row.entity_id, null);
      assert.equal(row.detail, null, "the funnel's event holds no content");
    }
    tests.push(
      "each answered read of GET /api/funnel left one activation_funnel.read event of the owner, with no store, case or content; the refused ones (weeks out of range, a disabled operator) left none"
    );
    // the disabled operator's attempt at a suspension left the organization alone
    assert.equal(await status(orgA.organizationId), "active");
    assert.equal(await epoch(orgA.organizationId), epochs.a);
    const lastSeen = await count(
      "SELECT count(*)::text AS n FROM public.platform_principals WHERE id = $1 AND last_seen_at IS NOT NULL",
      [ownerId]
    );
    assert.equal(lastSeen, 1, "the owner's login was recorded");
    tests.push(
      "requests without a valid login wrote nothing, and only the owner appears in the audit"
    );

    // the just-in-time flow: one reveal, of A's customer only, and the grant ended
    const reveals = await owner.pool.query<{ entity_id: string }>(
      "SELECT entity_id FROM public.platform_audit_events WHERE event_type = 'pii.revealed' AND organization_id = $1",
      [orgA.organizationId]
    );
    assert.deepEqual(
      reveals.rows.map((row) => row.entity_id),
      [maria.id]
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.platform_audit_events WHERE entity_id = $1",
        [carlos.id]
      ),
      0,
      "B's customer is in no audit row"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.tenant_access_grants WHERE organization_id = $1 AND revoked_at IS NULL AND expires_at > now()",
        [orgA.organizationId]
      ),
      0,
      "no grant is left open"
    );
    tests.push(
      "the reveal is audited once and only for the organization's own customer; no tenant grant is left open"
    );

    // the billing command: one grant for the one command ID (the repeat was the same), ended, in the ledger
    const grants = await owner.pool.query<{
      granted_by: string;
      revoked: boolean;
    }>(
      "SELECT granted_by, revoked_at IS NOT NULL AS revoked FROM public.entitlement_grants WHERE organization_id = $1",
      [orgA.organizationId]
    );
    assert.deepEqual(grants.rows, [
      { granted_by: `admin:${ownerId}`, revoked: true },
    ]);
    const billingEvents = await owner.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.platform_audit_events WHERE event_type LIKE 'billing.%' AND organization_id = $1 ORDER BY created_at, id",
      [orgA.organizationId]
    );
    assert.deepEqual(
      billingEvents.rows.map((row) => row.event_type),
      // the repeat of the command ID is recorded too (request, then the outcome), though it is the same grant
      [
        "billing.entitlement_grant_requested",
        "billing.entitlement_granted",
        "billing.entitlement_grant_requested",
        "billing.entitlement_granted",
        "billing.entitlement_revoke_requested",
        "billing.entitlement_revoked",
      ]
    );
    tests.push(
      "the billing command is recorded before and after (the repeat too), is one grant per command ID, attributed to the operator, and ended"
    );

    // the suspension: the organization no longer opens for its own users, once; the reactivation does not bring the epoch back
    assert.equal(await status(orgSuspend.organizationId), "suspended");
    assert.equal(
      await epoch(orgSuspend.organizationId),
      epochs.suspend + 1,
      "the authorization epoch moved on once"
    );
    const tenantSees = await withRuntimeSqlContext(
      tenantUrl,
      orgSuspend,
      (client) =>
        client.query(
          "SELECT 1 FROM public.organizations WHERE id = current_setting('app.organization_id')"
        )
    );
    assert.equal(
      tenantSees.rowCount,
      0,
      "the suspended organization does not open for its own users"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.platform_audit_events WHERE event_type = 'organization.suspended' AND organization_id = $1",
        [orgSuspend.organizationId]
      ),
      1
    );
    assert.equal(await status(orgReactivate.organizationId), "active");
    assert.equal(
      await epoch(orgReactivate.organizationId),
      epochs.reactivate + 1
    );
    assert.equal(await status(orgB.organizationId), "active");
    tests.push(
      "a suspension closes the organization to its users once and is audited; a reactivation opens it and the epoch stays; the others are untouched"
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
    try {
      for (const [role, group] of logins) {
        // one role that fails to go must not leave the others, or the pool open
        // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
        await owner.pool
          .query(`REVOKE "${group}" FROM "${role}"`)
          .catch(() => undefined);
        await owner.pool
          .query(`DROP ROLE IF EXISTS "${role}"`)
          .catch(() => undefined);
      }
    } finally {
      await owner.pool.end();
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Admin Worker PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
