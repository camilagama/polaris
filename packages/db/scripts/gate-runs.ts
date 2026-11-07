import assert from "node:assert/strict";

/**
 * How a gate runs against the job's Postgres when the owner is not a superuser (as on Neon) and a superuser URL is
 * given for the cases only a superuser can plant.
 *
 * - `only`: the gate needs a superuser by design (it creates what only one may), so it runs as the superuser.
 * - `also`: the gate proves part of its cases only as a superuser, so it runs as the owner and again as the superuser.
 *
 * Without the URL every gate runs once, as the owner.
 */
export type SuperuserNeed = "also" | "only";

export interface GateRun {
  asSuperuser: boolean;
  label: string;
  /** The owner run of an `also` gate: the superuser run that proves the rest comes right after. */
  superuserRunFollows: boolean;
}

export const AS_SUPERUSER = "POLARIS_GATE_AS_SUPERUSER";
export const SUPERUSER_RUN_FOLLOWS = "POLARIS_GATE_SUPERUSER_RUN_FOLLOWS";

export function runsOf(
  name: string,
  need: SuperuserNeed | undefined,
  hasSuperuserUrl: boolean
): GateRun[] {
  if (!(need && hasSuperuserUrl)) {
    return [{ asSuperuser: false, label: name, superuserRunFollows: false }];
  }
  if (need === "only") {
    return [{ asSuperuser: true, label: name, superuserRunFollows: false }];
  }
  return [
    { asSuperuser: false, label: name, superuserRunFollows: true },
    {
      asSuperuser: true,
      label: `${name} (superuser)`,
      superuserRunFollows: false,
    },
  ];
}

/** The markers a run hands its gate, so the gate can tell which run it is in. */
export function runMarkers(run: GateRun): Record<string, string> {
  return {
    ...(run.asSuperuser ? { [AS_SUPERUSER]: "1" } : {}),
    ...(run.superuserRunFollows ? { [SUPERUSER_RUN_FOLLOWS]: "1" } : {}),
  };
}

/**
 * For an `also` gate, at the point where it skips what only a superuser proves: a run meant as the superuser must be
 * one, and in CI a run that is not one must be followed by the superuser run, or the skipped cases are proved nowhere.
 */
export function assertSuperuserCasesProved(
  isSuperuser: boolean,
  gate: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env[AS_SUPERUSER] === "1") {
    assert.equal(
      isSuperuser,
      true,
      `${gate}: the superuser run is not connected as a superuser`
    );
  }
  if (!isSuperuser && env.CI === "true") {
    assert.equal(
      env[SUPERUSER_RUN_FOLLOWS],
      "1",
      `${gate}: in CI the cases only a superuser proves need the owner to be one or a superuser run after this one`
    );
  }
}

export const SUPERUSER_URL = "POLARIS_GATE_SUPERUSER_URL";

export const CI_SUPERUSER_FIX =
  "in CI, set POLARIS_GATE_SUPERUSER_URL in the gates step and create the owner without superuser (see .github/workflows/ci.yml; by hand with CI=true, runbook gate-4, step 1)";

const runOnlyMarkers = [SUPERUSER_URL, AS_SUPERUSER, SUPERUSER_RUN_FOLLOWS];

/**
 * The environment a gate child inherits: the superuser URL and the run markers are the executor's to set per child, so
 * a value exported in the shell never reaches a gate.
 */
export function inheritedEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !runOnlyMarkers.includes(name))
  );
}

/**
 * Fail-closed setup of the job's Postgres: against the local Postgres of the CI the executor needs the superuser URL
 * and an owner that is not a superuser, so a job that loses the URL or gets a superuser owner back stops instead of
 * running the whole suite as a superuser. Outside the CI the owner is whatever the machine has.
 */
export function assertCiOwnerSetup(input: {
  hasSuperuserUrl: boolean;
  isLocalCi: boolean;
  ownerIsSuperuser: boolean;
}): void {
  if (!input.isLocalCi) {
    return;
  }
  if (!input.hasSuperuserUrl) {
    throw new Error(
      `POLARIS_GATE_SUPERUSER_URL is required against the local Postgres of the CI${
        input.ownerIsSuperuser ? ", and the owner is a superuser" : ""
      }: ${CI_SUPERUSER_FIX}.`
    );
  }
  if (input.ownerIsSuperuser) {
    throw new Error(
      `The owner of POLARIS_GATE_DATABASE_URL must not be a superuser: ${CI_SUPERUSER_FIX}.`
    );
  }
}

/**
 * `assertCiOwnerSetup` with the owner's superuser flag read only where it decides something: outside the local Postgres
 * of the CI the check returns before looking at it, so the probe is not run there.
 */
export async function checkCiOwnerSetup(input: {
  hasSuperuserUrl: boolean;
  isLocalCi: boolean;
  ownerIsSuperuser: () => Promise<boolean>;
}): Promise<void> {
  assertCiOwnerSetup({
    hasSuperuserUrl: input.hasSuperuserUrl,
    isLocalCi: input.isLocalCi,
    ownerIsSuperuser: input.isLocalCi ? await input.ownerIsSuperuser() : false,
  });
}

/**
 * Runs `work`, then `cleanup`. A failure of `cleanup` never hides the failure of `work`: it goes to `onCleanupError`
 * and the error of `work` is the one that propagates. After a successful `work`, a failure of `cleanup` propagates.
 */
export async function runThenCleanUp<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  onCleanupError: (error: unknown) => void
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await cleanup().catch(onCleanupError);
    throw error;
  }
  await cleanup();
  return result;
}
