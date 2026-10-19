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

/** Validates, then (and only then) opens the owner connection of the run. */
export async function connectToGateTarget(
  input: GateTargetInput & { url: string }
): Promise<{ admin: Client; parsed: URL }> {
  const parsed = validateGateTarget(input);
  const admin = new Client({
    connectionString: input.url,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  return { admin, parsed };
}
