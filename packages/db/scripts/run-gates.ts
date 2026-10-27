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

const DEFAULT_CONCURRENCY_REPEAT = "3";
const lineBreak = /\r?\n/;
// a gate line starting with this prefix goes into the final JSON of the runner, passed or not (the seed of a property gate)
const notePrefix = "gate-note: ";
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
  // generated sequences of stock and sale commands against an in-memory model (POLARIS_PROPERTY_RUNS)
  ["stock-property", "verify-stock-property-gate.ts"],
  ["review-hardening", "verify-review-hardening-gate.ts"],
  ["read-models", "verify-read-models-gate.ts"],
  ["expenses", "verify-expenses-gate.ts"],
  ["expense-recurrence", "verify-expense-recurrence-gate.ts"],
  ["economics", "verify-economics-gate.ts"],
  // the daily sales series of the Início's map, aggregated in SQL, equals the engine's daily series
  ["daily-sales", "verify-daily-sales-gate.ts"],
  ["goals", "verify-goals-gate.ts"],
  // opening the Início writes nothing but the settling of an ended goal (AC-23), measured by pg_stat_user_tables
  ["home-writes", "verify-home-writes-gate.ts"],
  ["billing-catalog", "verify-billing-catalog-gate.ts"],
  ["entitlements", "verify-entitlements-gate.ts"],
  ["billing-lifecycle", "verify-billing-lifecycle-gate.ts"],
  ["billing-trial-claims", "verify-billing-trial-claims-gate.ts"],
  // the owner's billing self-service (ADR 0104, 0100): the new columns, the first charge, the limit, the safety net,
  // the reason of a cancellation, the audit of the requests and its cap, the operator's read of the window
  ["billing-self-service", "verify-billing-self-service-gate.ts"],
  // the owner's read of the plan (ADR 0104, PR C): the usage as the writes count it, the grant, each state
  ["billing-read-plan", "verify-billing-read-plan-gate.ts"],
  // the owner's commands (ADR 0104, PR D), with the real store and inbox: the refund by state, the anchor, the
  // database's clock, the lock that never waits and the limit; lives in apps/web, where the commands are
  [
    "billing-owner-commands",
    "../../../apps/web/scripts/verify-billing-owner-commands-gate.ts",
  ],
  // the consumer of billing.notice (ADR 0104, PR G), with the real store, the real recipient and the Worker's wiring:
  // the notice in the fact's transaction, the sweep once, the order of the arguments, the purge, cases 3 and 4 of item 5
  [
    "billing-notice-consumer",
    "../../../apps/web/scripts/verify-billing-notice-consumer-gate.ts",
  ],
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
  // closing the organization cancels the renewal (ADR 0074, L4): the request in the closure, the retry by state
  ["renewal-cancellation", "verify-renewal-cancellation-gate.ts"],
  // the closed organization, read-only until the purge (ADR 0081): its state, its copy, the reader and the two barriers
  [
    "closed-organization-readonly",
    "verify-closed-organization-readonly-gate.ts",
  ],
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
  // the purge of the user who never verified the e-mail (ADR 0100, Q-D2): every condition together, the limit, the audit
  ["unverified-user-purge", "verify-unverified-user-purge-gate.ts"],
  // the record of acceptance of the terms and the privacy policy (ADR 0100): append-only, per user, the minimum version, no IP
  ["legal-acceptance", "verify-legal-acceptance-gate.ts"],
  ["definer-hardening", "verify-definer-hardening-gate.ts"],
  // the owners of the sync triggers, the epoch bump and the onboarding (0095): matrix, scope, fail-closed, planted defects
  ["definer-owners", "verify-definer-owners-gate.ts"],
  // lives in apps/web: it runs the real Better Auth against the database with the log function's EXECUTE revoked
  [
    "access-log-login",
    "../../../apps/web/scripts/verify-access-log-login-gate.ts",
  ],
  ["media-commands", "verify-media-commands-gate.ts"],
  ["offline-devices", "verify-offline-devices-gate.ts"],
  ["device-sessions", "verify-device-sessions-gate.ts"],
  // row security with FORCE on Better Auth's tables and the auth audit (0098): catalog, real logins, planted defects
  ["auth-tables-row-security", "verify-auth-tables-row-security-gate.ts"],
  // one account per (provider_id, account_id) (0106): Better Auth 1.7 refuses a key held by two rows
  ["account-key", "verify-account-key-gate.ts"],
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
  // lives in apps/web: the use case of a product with its price and opening stock, on the real schema (AC-24)
  [
    "product-opening-stock",
    "../../../apps/web/scripts/verify-product-opening-stock-gate.ts",
  ],
  // lives in apps/web: the import of a spreadsheet, a row per transaction with the lock of the name (corte 2.5)
  ["product-import", "../../../apps/web/scripts/verify-product-import-gate.ts"],
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
  // the environment marker as a database comment (ADR 0097): a throwaway database and a non-superuser owner, which the runner
  // (a superuser) creates; on Neon the owner is not one, so the gate has nothing to prove there
  {
    env: salesEnv,
    localOnly: true,
    name: "environment-marker",
    script: "verify-environment-marker-gate.ts",
  },
  // the activation funnel (corte 2.4, ADR 0071 amended): its fixtures write sale headers without items and its measure
  // loads auto_explain, both only for a superuser, so the job's Postgres only
  {
    env: salesEnv,
    localOnly: true,
    name: "activation-funnel",
    script: "verify-activation-funnel-gate.ts",
  },
  // lives in apps/admin: the Admin Worker through its real fetch in workerd (Access simulated), against the job's Postgres.
  // Local Postgres only: the harness refuses any other host (the Neon proof of the Worker is the staging smoke).
  {
    env: salesEnv,
    localOnly: true,
    name: "admin-worker",
    script: "verify-admin-worker-gate.ts",
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
  },
  // every migration replayed by an owner who is not a superuser, as on Neon. It parks the polaris_* roles of the gate
  // database for the replay and gives them back, leaving nothing else behind (see the header of the script)
  {
    env: salesEnv,
    localOnly: true,
    name: "migrations-without-superuser",
    script: "verify-migrations-without-superuser-gate.ts",
  },
  // lives in apps/web and apps/catalog: the Web and Catalog Workers through their own handlers in workerd, against the job's Postgres.
  // Local Postgres only, like admin-worker. They are the last gates of the list, which is the order they run in (not the order of a
  // suite): the scheduled jobs of the Web Worker run for real against what the gates before left.
  {
    env: salesEnv,
    localOnly: true,
    name: "web-worker",
    script: "verify-web-worker-gate.ts",
  },
  {
    env: salesEnv,
    localOnly: true,
    name: "catalog-worker",
    script: "verify-catalog-worker-gate.ts",
  },
  // the notices of the billing cycle and the welcome (ADR 0104, 0101): last, because its sweep of the welcome reads
  // every store of the last 24 hours and records the welcome of the ones the other gates left
  {
    env: salesEnv,
    name: "billing-notices",
    script: "verify-billing-notices-gate.ts",
  }
);

/**
 * Named suites. `gate3` proves catalog, stock and private media (plan Gate 3);
 * `gate4` proves the sales core (plan Gate 4). `all` is every gate. `concurrency`
 * is the races of the system (docs/architecture/concurrency-matrix.md): the gates
 * whose races hold the contended lock, start together and fail if they never
 * competed (concurrency-support.ts). Every one of them is also in `ci`, so the
 * suite adds no job and no gate; it only runs the races alone and repeated.
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
    "stock-property",
    "review-hardening",
    "read-models",
    "expenses",
    "expense-recurrence",
    "economics",
    "daily-sales",
    "goals",
    "home-writes",
    "billing-catalog",
    "entitlements",
    "billing-lifecycle",
    "billing-trial-claims",
    "billing-self-service",
    "billing-read-plan",
    "billing-owner-commands",
    "billing-notices",
    "billing-notice-consumer",
    "operational-selection",
    "entitlement-grants",
    "public-catalog",
    "platform-principals",
    "admin-diagnostics",
    "admin-support",
    "admin-suspension",
    "activation-funnel",
    "admin-worker",
    "privacy-cases",
    "data-export",
    "organization-closure",
    "renewal-cancellation",
    "closed-organization-readonly",
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
    "unverified-user-purge",
    "legal-acceptance",
    "definer-hardening",
    "definer-owners",
    "environment-marker",
    "access-log-login",
    "media-commands",
    "offline-devices",
    "device-sessions",
    "auth-tables-row-security",
    "account-key",
    "offline-lease",
    "sync-log",
    "bootstrap",
    "sync-push",
    "offline-product",
    "offline-customer",
    "offline-stock",
    "offline-sale",
    "offline-e2e",
    // the creation of a product with its opening stock, and the import that runs it a row at a time
    "product-opening-stock",
    "product-import",
    "inventory",
    "customers",
    "media-upload",
    "tenant-context",
    "rls",
    "migrations-without-superuser",
    "web-worker",
    "catalog-worker",
  ],
  // Run it on a fresh database (the gates are not rerunnable on one that already ran them).
  // POLARIS_CONCURRENCY_REPEAT sets the rounds of each race (default 3 here, 1 in `ci`).
  concurrency: [
    "sale-transaction",
    "sale-customer-link",
    "sale-cancellation",
    "sale-return",
    "inventory",
    "offline-stock",
    "offline-sale",
    "sync-push",
    "billing-lifecycle",
    "billing-trial-claims",
    "entitlements",
    "admin-suspension",
    "organization-closure",
    "device-sessions",
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
    "stock-property",
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
  gate6: [
    "expenses",
    "expense-recurrence",
    "economics",
    "daily-sales",
    "goals",
  ],
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
  gate8: ["public-catalog", "catalog-worker"],
  // Phase 9 (admin): grows with every gate of the phase.
  gate9: [
    "platform-principals",
    "admin-diagnostics",
    "admin-support",
    "admin-suspension",
    "activation-funnel",
    "admin-worker",
  ],
  // Phase 10 (privacy): grows with every gate of the phase.
  gate10: [
    "organization-closure",
    "renewal-cancellation",
    "closed-organization-readonly",
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
    "web-worker",
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
  notes: string[];
  seconds: number;
  tail: string[];
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const lines: string[] = [];
    const notes: string[] = [];
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
          if (line.startsWith(notePrefix)) {
            notes.push(redact(line.slice(notePrefix.length)));
          }
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
        notes,
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

  if (named.has("concurrency") && !process.env.POLARIS_CONCURRENCY_REPEAT) {
    process.env.POLARIS_CONCURRENCY_REPEAT = DEFAULT_CONCURRENCY_REPEAT;
  }

  const { admin } = await connectToGateTarget({ branch, database, url });
  const login = `polaris_gate_runner_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const results: Array<{
    gate: string;
    notes?: string[];
    seconds: number;
    status: string;
  }> = [];
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
      results.push({
        gate: gate.name,
        ...(result.notes.length > 0 ? { notes: result.notes } : {}),
        seconds: result.seconds,
        status,
      });
      console.log(`    ${status} in ${result.seconds}s`);
      for (const note of result.notes) {
        console.log(`    note: ${note}`);
      }
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
