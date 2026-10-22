import { Client } from "pg";
import {
  ENVIRONMENT_MARKER_SQL,
  type EnvironmentReadings,
  readsAsEnvironment,
} from "./environment-marker";
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
  query: (sql: string) => Promise<{ rows: EnvironmentReadings[] }>;
}

/**
 * Refuses a database marked as production, staging or restore-drill. Every reading counts (the database
 * comment, what `ALTER DATABASE … SET` stored, and what the session sees), read as in `environment-marker.ts`:
 * the session could hide the stored marker, never add to a refusal.
 */
export async function assertDisposableEnvironment(
  client: MarkerClient
): Promise<void> {
  const { rows } = await client.query(ENVIRONMENT_MARKER_SQL);
  const [row] = rows;
  if (
    row &&
    readsAsEnvironment(
      {
        comment: row.comment ?? null,
        current: row.current,
        stored: row.stored,
      },
      refusedEnvironments
    )
  ) {
    throw new Error(
      "The gate target is marked as a protected environment (polaris.environment): refusing to run a gate in it."
    );
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
