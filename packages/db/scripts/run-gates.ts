import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

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
 * The target must be a Neon disposable endpoint, or a local Postgres when the
 * process runs in CI (`CI=true`). Each gate script keeps its own checks; this
 * runner only maps the unified variables onto the per-gate ones and creates the
 * temporary login roles some gates need.
 */

const neonHost = /^ep-[a-z0-9-]+\.[a-z0-9-]+\.sa-east-1\.aws\.neon\.tech$/;
const localHost = /^(localhost|127\.0\.0\.1|postgres)$/;
const branchPattern = /^pr\d+-[a-z0-9-]+-gate$/;
const lineBreak = /\r?\n/;
const urlPattern = /postgres(?:ql)?:\/\/\S+/gi;
const poolerPattern = /pooler/i;

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
  name: string;
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
  ["offline-devices", "verify-offline-devices-gate.ts"],
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
    "offline-devices",
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
  gate3: ["gate2-runtime", "inventory", "media-upload", "review-hardening"],
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
  // Phase 6 (expenses and analytics): grows with every gate of the phase.
  gate6: ["expenses", "expense-recurrence"],
  // Phase 5 (offline): grows with every offline gate.
  gate5: [
    "offline-devices",
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
  if (!branchPattern.test(branch)) {
    throw new Error("POLARIS_GATE_BRANCH must look like prNN-name-gate.");
  }
  const parsed = new URL(url);
  const isLocalCi =
    process.env.CI === "true" && localHost.test(parsed.hostname);
  if (
    !(neonHost.test(parsed.hostname) || isLocalCi) ||
    poolerPattern.test(parsed.hostname)
  ) {
    throw new Error(
      "The gate target must be a direct disposable Neon endpoint (or local Postgres in CI)."
    );
  }
  if (decodeURIComponent(parsed.pathname.slice(1)) !== database) {
    throw new Error("The URL database does not match POLARIS_GATE_DATABASE.");
  }

  const wanted = process.argv
    .slice(2)
    .flatMap((argument) => suites[argument] ?? [argument]);
  const selected = wanted.length
    ? gates.filter((gate) => wanted.includes(gate.name))
    : gates;
  if (selected.length === 0) {
    throw new Error(
      `No gate matches. Known: ${gates.map((gate) => gate.name).join(", ")}`
    );
  }

  const admin = new Client({ connectionString: url });
  await admin.connect();
  const login = `polaris_gate_runner_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const results: Array<{ gate: string; seconds: number; status: string }> = [];
  try {
    await admin.query(
      `CREATE ROLE "${login}" WITH LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.query(`GRANT polaris_pr11_runtime TO "${login}"`);
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
