import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isLocalGateHost } from "./gate-hosts";
import { connectToGateTarget, validateGateTarget } from "./gate-target";

/**
 * Runs the PostgreSQL gates one after another against ONE disposable database.
 *
 * Gates inject failures through triggers on shared tables, so two gates must
 * never run at the same time on the same database; this runner is the single
 * sequential entry point (`bun run gates:all`, or `bun scripts/run-gates.ts
 * <names...>`).
 *
 * Environment (read here, never printed):
 *   POLARIS_GATE_DATABASE_URL  direct (non-pooled) owner URL of the disposable database
 *   POLARIS_GATE_BRANCH        branch name, `prNN-...-gate`
 *   POLARIS_GATE_DATABASE      database name (default `neondb`)
 * The target must be on the list of hosts in gate-hosts.ts: a Neon disposable
 * endpoint, or a local Postgres when the process runs in CI (`CI=true`); any
 * other host is refused before a connection opens. Each gate script keeps its own checks; this
 * runner only maps the unified variables onto the per-gate ones and creates the
 * temporary login roles some gates need.
 */

const lineBreak = /\r?\n/;
const urlPattern = /postgres(?:ql)?:\/\/\S+/gi;

interface Context {
  branch: string;
  database: string;
  host: string;
  runtimeLogin: string;
  runtimeUrl: string;
  url: string;
}

interface Gate {
  env: (context: Context) => Record<string, string>;
  /** Proves nothing without the job's own Postgres: never selected against Neon. */
  localOnly?: boolean;
  name: string;
  /** Reads the synthetic `rls_poc_operations` rows the Neon bootstrap seeds. */
  needsPocFixture?: boolean;
  script: string;
}

const salesEnv = (context: Context) => ({
  POLARIS_SALES_GATE_BRANCH: context.branch,
  POLARIS_SALES_GATE_DATABASE: context.database,
  POLARIS_SALES_GATE_DATABASE_URL: context.url,
});

const gates: Gate[] = [
  ["sales-aggregate", "verify-sales-aggregate-gate.ts"],
  ["sale-transaction", "verify-sale-transaction-gate.ts"],
  ["sale-customer-link", "verify-sale-customer-link-gate.ts"],
  ["sale-cancellation", "verify-sale-cancellation-gate.ts"],
  ["sale-return", "verify-sale-return-gate.ts"],
  ["sale-dates", "verify-sale-dates-gate.ts"],
  ["gate4", "verify-gate4-sales-core.ts"],
  ["review-hardening", "verify-review-hardening-gate.ts"],
  ["read-models", "verify-read-models-gate.ts"],
  ["expenses", "verify-expenses-gate.ts"],
  ["expense-recurrence", "verify-expense-recurrence-gate.ts"],
  ["economics", "verify-economics-gate.ts"],
  ["goals", "verify-goals-gate.ts"],
  ["billing-catalog", "verify-billing-catalog-gate.ts"],
  ["entitlements", "verify-entitlements-gate.ts"],
  ["billing-lifecycle", "verify-billing-lifecycle-gate.ts"],
  ["billing-trial-claims", "verify-billing-trial-claims-gate.ts"],
  ["operational-selection", "verify-operational-selection-gate.ts"],
  ["entitlement-grants", "verify-entitlement-grants-gate.ts"],
  ["public-catalog", "verify-public-catalog-gate.ts"],
  ["platform-principals", "verify-platform-principals-gate.ts"],
  ["admin-diagnostics", "verify-admin-diagnostics-gate.ts"],
  ["admin-support", "verify-admin-support-gate.ts"],
  ["admin-suspension", "verify-admin-suspension-gate.ts"],
  ["privacy-cases", "verify-privacy-cases-gate.ts"],
  ["data-export", "verify-data-export-gate.ts"],
  ["organization-closure", "verify-organization-closure-gate.ts"],
  ["customer-anonymization", "verify-customer-anonymization-gate.ts"],
  ["deletion-ledger", "verify-deletion-ledger-gate.ts"],
  // lives in apps/web: it runs the real purge job against the database, with an in-memory bucket
  [
    "organization-purge",
    "../../../apps/web/scripts/verify-organization-purge-gate.ts",
  ],
  // the audit of the tenant survives the purge, is immutable and leaves only by period (ADR 0081, amended)
  ["audit-retention", "verify-audit-retention-gate.ts"],
  // the live purge functions against the domain; mandatory before a PR that recreates one of them
  ["purge-functions", "verify-purge-functions-gate.ts"],
  ["event-outbox", "verify-event-outbox-gate.ts"],
  ["outbox-dispatcher", "verify-outbox-dispatcher-gate.ts"],
  ["dead-letter", "verify-dead-letter-gate.ts"],
  ["scheduled-jobs", "verify-scheduled-jobs-gate.ts"],
  ["access-log", "verify-access-log-gate.ts"],
  // the lock of the sign-in by password (ADR 0100): the 5th failure, the release, the reservation, the expiry
  ["login-lock", "verify-login-lock-gate.ts"],
  // the record of acceptance of the terms and the privacy policy (ADR 0100): append-only, per user, the minimum version, no IP
  ["legal-acceptance", "verify-legal-acceptance-gate.ts"],
  ["definer-hardening", "verify-definer-hardening-gate.ts"],
  // lives in apps/web: it runs the real Better Auth against the database with the log function's EXECUTE revoked
  [
    "access-log-login",
    "../../../apps/web/scripts/verify-access-log-login-gate.ts",
  ],
  ["media-commands", "verify-media-commands-gate.ts"],
  ["offline-devices", "verify-offline-devices-gate.ts"],
  ["device-sessions", "verify-device-sessions-gate.ts"],
  ["offline-lease", "verify-offline-lease-gate.ts"],
  ["sync-log", "verify-sync-log-gate.ts"],
  ["bootstrap", "verify-bootstrap-gate.ts"],
  ["sync-push", "verify-sync-push-gate.ts"],
  ["offline-product", "verify-offline-product-gate.ts"],
  ["offline-customer", "verify-offline-customer-gate.ts"],
  ["offline-stock", "verify-offline-stock-gate.ts"],
  ["offline-sale", "verify-offline-sale-gate.ts"],
  // lives in apps/web: it needs the real offline client and the real server handlers
  ["offline-e2e", "../../../apps/web/scripts/verify-offline-e2e-gate.ts"],
].map(([name, script]) => ({
  env: salesEnv,
  name: name as string,
  script: script as string,
}));

gates.push(
  {
    env: (context) => ({
      POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE: "gate2-runtime-proof",
      POLARIS_GATE2_TEST_DATABASE_URL: context.url,
      POLARIS_GATE2_TEST_EXPECTED_HOSTNAME: context.host,
    }),
    name: "gate2-runtime",
    script: "verify-gate2-runtime.ts",
  },
  {
    env: (context) => ({
      POLARIS_INVENTORY_GATE_CONFIRM_DISPOSABLE: "polaris-pr31-inventory-gate",
      POLARIS_INVENTORY_GATE_DATABASE_URL: context.url,
      POLARIS_INVENTORY_GATE_EXPECTED_HOSTNAME: context.host,
    }),
    name: "inventory",
    script: "verify-inventory-gate.ts",
  },
  {
    env: (context) => ({
      POLARIS_CUSTOMER_GATE_BRANCH: context.branch,
      POLARIS_CUSTOMER_GATE_DATABASE_URL: context.url,
    }),
    name: "customers",
    script: "verify-customers-gate.ts",
  },

  {
    env: (context) => ({
      POLARIS_MEDIA_UPLOAD_GATE_CONFIRM_DISPOSABLE: context.branch,
      POLARIS_MEDIA_UPLOAD_GATE_DATABASE_URL: context.url,
      POLARIS_MEDIA_UPLOAD_GATE_EXPECTED_HOSTNAME: context.host,
      POLARIS_MEDIA_UPLOAD_GATE_RUNTIME_DATABASE_URL: context.runtimeUrl,
    }),
    name: "media-upload",
    script: "verify-media-upload-gate.ts",
  },
  {
    env: (context) => ({
      POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE:
        "polaris-pr22-tenant-context-disposable",
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: context.url,
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: context.host,
    }),
    name: "tenant-context",
    needsPocFixture: true,
    script: "verify-tenant-context-gate.ts",
  },
  // lives in apps/web: serves the PR11 route from a local server and runs the RLS gate against it.
  // Local Postgres only: on Neon the proof goes through the Worker and Hyperdrive (`poc:rls:verify`).
  {
    env: (context) => ({
      POLARIS_RLS_ADMIN_DATABASE_URL: context.url,
      POLARIS_RLS_CONFIRM_DISPOSABLE: "polaris-pr11-rls-gate",
      POLARIS_RLS_EXPECTED_HOSTNAME: context.host,
      POLARIS_RLS_RUNTIME_DATABASE_URL: context.runtimeUrl,
    }),
    localOnly: true,
    name: "rls",
    needsPocFixture: true,
    script: "../../../apps/web/scripts/verify-rls-ci-gate.ts",
  }
);

/**
 * Named suites. `gate3` proves catalog, stock and private media (plan Gate 3);
 * `gate4` proves the sales core (plan Gate 4). `all` is every gate.
 */
const suites: Record<string, string[]> = {
  // What the CI job runs against its own Postgres 18 service: the gates that do
  // not depend on Neon-specific roles or hostnames.
  ci: [
    "sales-aggregate",
    "sale-transaction",
    "sale-customer-link",
    "sale-cancellation",
    "sale-return",
    "sale-dates",
    "gate4",
    "review-hardening",
    "read-models",
    "expenses",
    "expense-recurrence",
    "economics",
    "goals",
    "billing-catalog",
    "entitlements",
    "billing-lifecycle",
    "billing-trial-claims",
    "operational-selection",
    "entitlement-grants",
    "public-catalog",
    "platform-principals",
    "admin-diagnostics",
    "admin-support",
    "admin-suspension",
    "privacy-cases",
    "data-export",
    "organization-closure",
    "customer-anonymization",
    "deletion-ledger",
    "organization-purge",
    "audit-retention",
    "purge-functions",
    "event-outbox",
    "outbox-dispatcher",
    "dead-letter",
    "scheduled-jobs",
    "access-log",
    "login-lock",
    "legal-acceptance",
    "definer-hardening",
    "access-log-login",
    "media-commands",
    "offline-devices",
    "device-sessions",
    "offline-lease",
    "sync-log",
    "bootstrap",
    "sync-push",
    "offline-product",
    "offline-customer",
    "offline-stock",
    "offline-sale",
    "offline-e2e",
    "inventory",
    "customers",
    "media-upload",
    "tenant-context",
    "rls",
  ],
  gate3: [
    "gate2-runtime",
    "inventory",
    "media-upload",
    "media-commands",
    "review-hardening",
  ],
  gate4: [
    "sales-aggregate",
    "sale-transaction",
    "sale-customer-link",
    "sale-cancellation",
    "sale-return",
    "sale-dates",
    "gate4",
    "customers",
    "read-models",
  ],
  // Phase 5 (offline): grows with every offline gate.
  gate5: [
    "offline-devices",
    "device-sessions",
    "offline-lease",
    "sync-log",
    "bootstrap",
    "sync-push",
    "offline-product",
    "offline-customer",
    "offline-stock",
    "offline-sale",
    "offline-e2e",
  ],
  // Phase 6 (expenses and analytics): grows with every gate of the phase.
  gate6: ["expenses", "expense-recurrence", "economics", "goals"],
  // Phase 7 (billing and entitlements): grows with every gate of the phase.
  gate7: [
    "billing-catalog",
    "entitlements",
    "billing-lifecycle",
    "billing-trial-claims",
    "operational-selection",
    "entitlement-grants",
  ],
  // Phase 8 (public catalog): grows with every gate of the phase.
  gate8: ["public-catalog"],
  // Phase 9 (admin): grows with every gate of the phase.
  gate9: [
    "platform-principals",
    "admin-diagnostics",
    "admin-support",
    "admin-suspension",
  ],
  // Phase 10 (privacy): grows with every gate of the phase.
  gate10: [
    "organization-closure",
    "customer-anonymization",
    "deletion-ledger",
    "privacy-cases",
    "data-export",
    "organization-purge",
    "audit-retention",
    "purge-functions",
  ],
  // Phase 11 (async infrastructure): grows with every gate of the phase.
  gate11: [
    "event-outbox",
    "outbox-dispatcher",
    "dead-letter",
    "scheduled-jobs",
  ],
};

function withVerifyFull(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

function redact(line: string): string {
  return line.replace(urlPattern, "[redacted]");
}

function runGate(
  gate: Gate,
  context: Context
): Promise<{
  code: number;
  seconds: number;
  tail: string[];
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const lines: string[] = [];
    const child = spawn(process.execPath, [`scripts/${gate.script}`], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ...gate.env(context),
        POLARIS_GATE_BRANCH: context.branch,
        POLARIS_GATE_DATABASE: context.database,
        POLARIS_GATE_RUNTIME_LOGIN: context.runtimeLogin,
      },
    });
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split(lineBreak)) {
        if (line.trim()) {
          lines.push(redact(line));
          if (lines.length > 400) {
            lines.shift();
          }
        }
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        seconds: Math.round((Date.now() - started) / 1000),
        tail: lines.slice(-14),
      });
    });
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear script of validation, setup, sequential runs and teardown
async function main() {
  const url = process.env.POLARIS_GATE_DATABASE_URL;
  const branch = process.env.POLARIS_GATE_BRANCH ?? "";
  const database = process.env.POLARIS_GATE_DATABASE ?? "neondb";
  if (!url) {
    throw new Error("POLARIS_GATE_DATABASE_URL is required.");
  }
  const parsed = validateGateTarget({ branch, database, url });
  const isLocalCi = isLocalGateHost(parsed.hostname);

  const wanted = process.argv
    .slice(2)
    .flatMap((argument) => suites[argument] ?? [argument]);
  const named = new Set(process.argv.slice(2));
  const eligible = gates.filter(
    (gate) => !gate.localOnly || isLocalCi || named.has(gate.name)
  );
  const selected = wanted.length
    ? eligible.filter((gate) => wanted.includes(gate.name))
    : eligible;
  if (selected.length === 0) {
    throw new Error(
      `No gate matches. Known: ${gates.map((gate) => gate.name).join(", ")}`
    );
  }
  if (!isLocalCi && selected.some((gate) => gate.localOnly)) {
    throw new Error(
      "A gate named here runs only against the CI Postgres; against Neon use its own command (poc:rls:verify)."
    );
  }

  const { admin } = await connectToGateTarget({ branch, database, url });
  const login = `polaris_gate_runner_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const results: Array<{ gate: string; seconds: number; status: string }> = [];
  try {
    await admin.query(
      `CREATE ROLE "${login}" WITH LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.query(`GRANT polaris_pr11_runtime TO "${login}"`);
    if (isLocalCi && selected.some((gate) => gate.needsPocFixture)) {
      // what the Neon bootstrap seeds by hand; the migrations create only the table
      await admin.query(
        `INSERT INTO public.rls_poc_operations (organization_id, token, value)
         VALUES ('org_a', 'seed-a', 'synthetic data for org_a'),
                ('org_b', 'seed-b', 'synthetic data for org_b')
         ON CONFLICT (organization_id, token) DO NOTHING`
      );
    }
    const runtime = new URL(url);
    runtime.username = login;
    runtime.password = password;
    const context: Context = {
      branch,
      database,
      host: parsed.hostname,
      runtimeLogin: login,
      runtimeUrl: isLocalCi
        ? runtime.toString()
        : withVerifyFull(runtime.toString()),
      url: isLocalCi ? url : withVerifyFull(url),
    };

    for (const gate of selected) {
      console.log(`=== ${gate.name}`);
      // biome-ignore lint/performance/noAwaitInLoops: gates must run strictly one at a time on one database
      const result = await runGate(gate, context);
      const status = result.code === 0 ? "passed" : "failed";
      results.push({ gate: gate.name, seconds: result.seconds, status });
      console.log(`    ${status} in ${result.seconds}s`);
      if (result.code !== 0) {
        for (const line of result.tail) {
          console.log(`    | ${line.slice(0, 220)}`);
        }
      }
    }
  } finally {
    try {
      await admin.query(`REVOKE polaris_pr11_runtime FROM "${login}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    } finally {
      await admin.end();
    }
  }
  console.log(JSON.stringify({ branch, database, results }, null, 2));
  if (results.some((entry) => entry.status !== "passed")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Gate runner failed: ${redact(String(error))}`);
  process.exitCode = 1;
});
