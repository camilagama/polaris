import { rmSync } from "node:fs";
import { createRunDatabase } from "./run-database";
import {
  assertLoopbackBaseUrl,
  ensureRunEnvironment,
  ownerDatabaseUrl,
} from "./run-environment";
import { commandSeed } from "./seed";

/**
 * Runs after the previews answer `/health` and before the first test (the local Hyperdrive connects on demand, so
 * the logins exist before the first request that needs them). Captures T0 once, from the real clock: every
 * process of the run (and a retry) reads the same `E2E_T0`.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.BASE_URL) {
    assertLoopbackBaseUrl(process.env.BASE_URL);
  }
  const run = ensureRunEnvironment();
  const owner = ownerDatabaseUrl();
  rmSync(new URL("../.e2e-state", import.meta.url), {
    force: true,
    recursive: true,
  });
  const { createdRuntimeRole } = await createRunDatabase(owner, run);
  // the teardown runs in this same process: it drops the role only if this run made it
  process.env.E2E_CREATED_RUNTIME_ROLE = createdRuntimeRole ? "1" : "0";
  // always the instant of this run, never one left in the shell by an earlier run
  process.env.E2E_T0 = String(Date.now());
  // one seed for the whole run (the workers inherit it), and a bad E2E_SEED stops here, not inside a journey
  commandSeed();
}
