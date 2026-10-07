import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const adminConnectionString = process.env.POLARIS_RLS_ADMIN_DATABASE_URL;
const expectedHostname = process.env.POLARIS_RLS_EXPECTED_HOSTNAME;
const workerUrl =
  process.env.POLARIS_RLS_POC_URL ?? "http://127.0.0.1:8787/api/poc/rls/run";

if (!adminConnectionString) {
  throw new Error(
    "Set POLARIS_RLS_ADMIN_DATABASE_URL to the direct owner URL for the PR11 disposable project."
  );
}

if (process.env.POLARIS_RLS_CONFIRM_DISPOSABLE !== "polaris-pr11-rls-gate") {
  throw new Error(
    "Set POLARIS_RLS_CONFIRM_DISPOSABLE=polaris-pr11-rls-gate only for the disposable project."
  );
}

if (!expectedHostname) {
  throw new Error(
    "Set POLARIS_RLS_EXPECTED_HOSTNAME to the endpoint hostname of the disposable project."
  );
}

interface WorkerResult {
  attempts?: number;
  backendPid?: number;
  contexts?: Array<string | null>;
  organizationId?: string | null;
  rejectedByRls?: boolean;
  rolledBack?: boolean;
  rows?: Array<{ organizationId: string; token: string; value?: string }>;
  rowsFound?: number;
  statementFailed?: boolean;
  transactionIds?: string[];
  visibleRows?: Array<{ organizationId: string; token: string }>;
}

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
}

async function callWorker(
  action: string,
  organizationId?: "org_a" | "org_b",
  token?: string,
  delayMs?: number
): Promise<WorkerResult> {
  const response = await fetch(workerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, organizationId, token, delayMs }),
  });
  const result = (await response.json()) as WorkerResult & {
    error?: { code?: string };
  };

  if (!response.ok) {
    throw new Error(
      `The Worker POC returned HTTP ${response.status} (${result.error?.code ?? "unknown"}).`
    );
  }

  return result;
}

const adminUrl = new URL(adminConnectionString);
check(
  !adminUrl.hostname.includes("-pooler") &&
    adminUrl.hostname === expectedHostname &&
    adminUrl.hostname.endsWith(".sa-east-1.aws.neon.tech"),
  "The gate requires the direct São Paulo Neon endpoint."
);
assert.equal(decodeURIComponent(adminUrl.pathname.slice(1)), "neondb");

const adminPool = new Pool({ connectionString: adminConnectionString, max: 2 });

try {
  const identity = await adminPool.query<{
    database: string;
    serverVersion: string;
  }>(
    `SELECT current_database() AS database,
            current_setting('server_version') AS "serverVersion"`
  );
  const serverMajor = Number.parseInt(
    identity.rows[0]?.serverVersion.split(".")[0] ?? "",
    10
  );
  assert.equal(serverMajor, 18, "The remote database must be PostgreSQL 18.");
  assert.equal(identity.rows[0]?.database, "neondb");

  const security = await adminPool.query<{
    bypassRls: boolean;
    forceRls: boolean;
    owner: string;
    runtimeOwnsTable: boolean;
    rlsEnabled: boolean;
    superuser: boolean;
  }>(
    `SELECT role.rolsuper AS "superuser",
            role.rolbypassrls AS "bypassRls",
            relation.relowner = role.oid AS "runtimeOwnsTable",
            owner.rolname AS owner,
            relation.relrowsecurity AS "rlsEnabled",
            relation.relforcerowsecurity AS "forceRls"
       FROM pg_roles AS role
       JOIN pg_class AS relation
         ON relation.oid = 'public.rls_poc_operations'::regclass
       JOIN pg_roles AS owner ON owner.oid = relation.relowner
      WHERE role.rolname = 'polaris_pr11_runtime'`
  );
  const [role] = security.rows;
  check(role, "The dedicated runtime role is missing.");
  assert.equal(role.superuser, false);
  assert.equal(role.bypassRls, false);
  assert.equal(role.runtimeOwnsTable, false);
  assert.equal(role.rlsEnabled, true);
  assert.equal(role.forceRls, true);

  const policies = await adminPool.query<{
    name: string;
    usingExpression: string | null;
    checkExpression: string | null;
  }>(
    `SELECT policyname AS name,
            qual AS "usingExpression",
            with_check AS "checkExpression"
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'rls_poc_operations'`
  );
  assert.equal(policies.rows.length, 1);
  check(
    policies.rows[0]?.usingExpression?.includes("app.organization_id"),
    "The RLS USING policy must read the transaction-local organization context."
  );
  check(
    policies.rows[0]?.checkExpression?.includes("app.organization_id"),
    "The RLS WITH CHECK policy must enforce the same organization context."
  );

  const readA = await callWorker("read", "org_a");
  const readB = await callWorker("read", "org_b");
  assert.equal(readA.organizationId, "org_a");
  assert.equal(readA.rows?.length, 1);
  assert.equal(readA.rows?.[0]?.organizationId, "org_a");
  assert.equal(readA.rows?.[0]?.token, "seed-a");
  assert.equal(readB.organizationId, "org_b");
  assert.equal(readB.rows?.length, 1);
  assert.equal(readB.rows?.[0]?.organizationId, "org_b");
  assert.equal(readB.rows?.[0]?.token, "seed-b");
  assert.equal(readA.transactionIds?.[0], readA.transactionIds?.[1]);
  assert.equal(readB.transactionIds?.[0], readB.transactionIds?.[1]);

  const crossReadA = await callWorker("cross-read", "org_a");
  const crossReadB = await callWorker("cross-read", "org_b");
  assert.equal(crossReadA.rows?.length, 0);
  assert.equal(crossReadB.rows?.length, 0);

  let reusedBackend = false;
  // Requests are sequential here by design to exercise reuse of the idle client.
  for (let attempt = 0; attempt < 20 && !reusedBackend; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential transaction pairs prove context is cleared on a reused backend.
    const contextual = await callWorker("read", "org_a");
    const contextless = await callWorker("contextless");
    assert.equal(contextless.organizationId, null);
    assert.deepEqual(contextless.visibleRows, []);
    reusedBackend = contextual.backendPid === contextless.backendPid;
  }
  check(
    reusedBackend,
    "The gate did not observe a reused backend with cleared transaction context."
  );

  const crossWrite = await callWorker("cross-write", "org_a", randomUUID());
  assert.equal(crossWrite.rejectedByRls, true);

  const rollback = await callWorker("rollback", "org_a", randomUUID());
  assert.equal(rollback.rolledBack, true);

  const statementFailure = await callWorker(
    "statement-failure",
    "org_a",
    randomUUID()
  );
  assert.equal(statementFailure.statementFailed, true);
  assert.equal(statementFailure.rolledBack, true);
  assert.equal(statementFailure.attempts, 1);

  const organizationsByBackend = new Map<number, Set<string>>();
  const concurrentResults = await Promise.all(
    Array.from({ length: 120 }, (_, index) => {
      const organizationId = index % 2 === 0 ? "org_a" : "org_b";
      return callWorker("read", organizationId, undefined, 50);
    })
  );

  for (const [index, result] of concurrentResults.entries()) {
    const organizationId = index % 2 === 0 ? "org_a" : "org_b";
    const token = organizationId === "org_a" ? "seed-a" : "seed-b";
    assert.equal(result.organizationId, organizationId);
    assert.equal(result.rows?.length, 1);
    assert.equal(result.rows?.[0]?.organizationId, organizationId);
    assert.equal(result.rows?.[0]?.token, token);
    assert.equal(result.transactionIds?.[0], result.transactionIds?.[1]);

    if (result.backendPid) {
      const organizations =
        organizationsByBackend.get(result.backendPid) ?? new Set<string>();
      organizations.add(organizationId);
      organizationsByBackend.set(result.backendPid, organizations);
    }
  }

  const concurrentReuseProven = [...organizationsByBackend.values()].some(
    (organizations) => organizations.size === 2
  );
  check(
    concurrentReuseProven,
    "Concurrent tenant requests did not reuse a backend across org_a and org_b."
  );

  const retryToken = randomUUID();
  const applicationName = `polaris_pr11_${retryToken}`;
  const retryRequest = callWorker("retry", "org_a", retryToken).then(
    (result) => ({ result }),
    (error: unknown) => ({
      error: error instanceof Error ? error : new Error(String(error)),
    })
  );
  let targetPid: number | undefined;

  // The runner must poll until the test transaction is observable by the owner.
  for (let attempt = 0; attempt < 200 && !targetPid; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Polling is sequential so the owner terminates the exact active backend.
    const earlyResult = await Promise.race([
      retryRequest,
      delay(50).then(() => undefined),
    ]);
    if (earlyResult) {
      if ("error" in earlyResult) {
        throw earlyResult.error;
      }
      throw new Error(
        "The retry operation ended before the owner could interrupt its backend."
      );
    }

    const activeQuery = await adminPool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE application_name = $1
          AND usename = 'polaris_pr11_runtime'
          AND state = 'active'
          AND query ILIKE '%pg_sleep%'
          AND pid <> pg_backend_pid()
        LIMIT 1`,
      [applicationName]
    );
    targetPid = activeQuery.rows[0]?.pid;
  }

  check(
    targetPid,
    "The owner connection could not observe the Worker transaction to inject a real backend interruption."
  );

  const terminated = await adminPool.query<{ terminated: boolean }>(
    "SELECT pg_terminate_backend($1) AS terminated",
    [targetPid]
  );
  assert.equal(terminated.rows[0]?.terminated, true);

  const retryOutcome = await retryRequest;
  if ("error" in retryOutcome) {
    throw retryOutcome.error;
  }
  const retry = retryOutcome.result;
  assert.equal(retry.attempts, 2);
  assert.deepEqual(retry.contexts, ["org_a", "org_a"]);
  check(
    retry.transactionIds?.[0] !== retry.transactionIds?.[1],
    "A retry must use a new transaction after connection interruption."
  );
  assert.equal(retry.rowsFound, 1);

  const ownerClient = await adminPool.connect();
  try {
    await ownerClient.query("BEGIN");
    await ownerClient.query("SELECT set_config($1, $2, true)", [
      "app.organization_id",
      "org_a",
    ]);
    const operationRows = await ownerClient.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM public.rls_poc_operations
        WHERE organization_id = 'org_a' AND token = $1`,
      [retryToken]
    );
    await ownerClient.query("COMMIT");
    assert.equal(operationRows.rows[0]?.count, 1);
  } catch (error) {
    await ownerClient.query("ROLLBACK");
    throw error;
  } finally {
    ownerClient.release();
  }

  console.log(
    JSON.stringify({
      concurrentTenantIsolation: "passed",
      contextClearedOnReusedBackend: "passed",
      contextlessRead: "passed",
      crossTenantRead: "passed",
      crossTenantWrite: "rejected_by_rls",
      forceRls: role.forceRls,
      hyperdrive: "remote_binding",
      postgresMajor: serverMajor,
      region: "aws-sa-east-1",
      retryAfterTerminatedBackend: "passed",
      retryContextReapplied: "passed",
      runtimeBypassRls: role.bypassRls,
      runtimeOwnsFixture: role.runtimeOwnsTable,
      sqlQueryCaching: "disabled_by_hyperdrive_config",
      statementFailureRollback: "passed",
      transactionContext: "transaction_local",
      transactionRollback: "passed",
      workerConnectionPooling: "reused_backend",
    })
  );
} finally {
  await adminPool.end();
}
