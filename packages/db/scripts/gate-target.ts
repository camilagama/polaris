import { Client } from "pg";
import { assertAllowedGateUrl, isCiEnvironment } from "./gate-hosts";

const branchPattern = /^pr\d+-[a-z0-9-]+-gate$/;

export interface GateTargetInput {
  branch: string;
  ci?: boolean;
  database: string;
  url: string | undefined;
}

/**
 * Checks the gate target and returns it parsed. Pure: it never opens a
 * connection, so a refusal happens before anything is sent to the host.
 */
export function validateGateTarget(input: GateTargetInput): URL {
  if (!input.url) {
    throw new Error("POLARIS_GATE_DATABASE_URL is required.");
  }
  if (!branchPattern.test(input.branch)) {
    throw new Error("POLARIS_GATE_BRANCH must look like prNN-name-gate.");
  }
  const parsed = assertAllowedGateUrl(input.url, input.ci ?? isCiEnvironment());
  if (decodeURIComponent(parsed.pathname.slice(1)) !== input.database) {
    throw new Error("The URL database does not match POLARIS_GATE_DATABASE.");
  }
  return parsed;
}

// Environments a gate never runs in: it installs triggers and changes owners.
// An empty or missing marker is the disposable branch (no marker is set there).
const refusedEnvironments: readonly string[] = [
  "production",
  "staging",
  "restore-drill",
];

/** The slice of `pg.Client` the marker check uses (a fake in the tests). */
export interface MarkerClient {
  query: (sql: string) => Promise<{
    rows: Array<{ current: string | null; stored: string | null }>;
  }>;
}

// Same marker as verify-staging-database.ts (`ALTER DATABASE … SET
// polaris.environment`). Both reads count: the stored one is what ALTER DATABASE
// wrote, and the current one is what this session sees (a connection option or
// a role setting could hide the stored one, never add to a refusal).
const environmentMarkerSql = `SELECT current_setting('polaris.environment', true) AS current,
       (SELECT substring(c FROM '^polaris\\.environment=(.*)$')
          FROM pg_db_role_setting s
          JOIN pg_database d ON d.oid = s.setdatabase,
               unnest(s.setconfig) AS c
         WHERE d.datname = current_database() AND s.setrole = 0
           AND c LIKE 'polaris.environment=%'
         LIMIT 1) AS stored`;

/** Refuses a database marked as production, staging or restore-drill. */
export async function assertDisposableEnvironment(
  client: MarkerClient
): Promise<void> {
  const { rows } = await client.query(environmentMarkerSql);
  for (const value of [rows[0]?.current, rows[0]?.stored]) {
    if (refusedEnvironments.includes((value ?? "").trim().toLowerCase())) {
      throw new Error(
        "The gate target is marked as a protected environment (polaris.environment): refusing to run a gate in it."
      );
    }
  }
}

/**
 * Validates, then (and only then) opens the owner connection of the run, and
 * closes it again when the database is marked as a protected environment.
 */
export async function connectToGateTarget(
  input: GateTargetInput & { url: string },
  createClient: (connectionString: string) => Client = (connectionString) =>
    new Client({ connectionString, connectionTimeoutMillis: 10_000 })
): Promise<{ admin: Client; parsed: URL }> {
  const parsed = validateGateTarget(input);
  const admin = createClient(input.url);
  await admin.connect();
  try {
    await assertDisposableEnvironment(admin);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }
  return { admin, parsed };
}
