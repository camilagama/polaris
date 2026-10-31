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
