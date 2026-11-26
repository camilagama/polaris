/**
 * What the deploy database check reads from its command line and environment: the phase, the environment whose
 * marker the database must carry and the owner's URL of that environment. Each environment has its own variable, so
 * a run for production never falls back to the URL of staging (and the other way round).
 */
export const DEPLOY_ENVIRONMENTS = {
  production: "PRODUCTION_MIGRATOR_DATABASE_URL",
  staging: "STAGING_MIGRATOR_DATABASE_URL",
} as const;

export type DeployEnvironment = keyof typeof DEPLOY_ENVIRONMENTS;
export type DeployPhase = "after-migrate" | "before-migrate";

export interface DeployDatabaseTarget {
  environment: DeployEnvironment;
  phase: DeployPhase;
  url: string;
  urlVariable: string;
}

export const USAGE =
  "usage: verify-deploy-database.ts [--env staging|production] before-migrate|after-migrate";

function isEnvironment(value: string): value is DeployEnvironment {
  return Object.hasOwn(DEPLOY_ENVIRONMENTS, value);
}

function isPhase(value: string | undefined): value is DeployPhase {
  return value === "before-migrate" || value === "after-migrate";
}

/**
 * Throws on anything but one phase and at most one `--env <environment>`, in any order (the package scripts put
 * `--env` first and the deploy appends the phase): an unknown or repeated option is refused instead of ignored.
 * Without `--env` it is staging, the only environment the check served before.
 */
export function deployDatabaseTarget(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): DeployDatabaseTarget {
  const phases: string[] = [];
  const environments: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--env") {
      index += 1;
      environments.push(args[index] ?? "");
    } else {
      phases.push(arg);
    }
  }
  const [phase] = phases;
  if (phases.length !== 1 || !isPhase(phase) || environments.length > 1) {
    throw new Error(USAGE);
  }
  const [named = "staging"] = environments;
  if (!isEnvironment(named)) {
    throw new Error(`unknown environment "${named}"; ${USAGE}`);
  }
  const urlVariable = DEPLOY_ENVIRONMENTS[named];
  const url = env[urlVariable] ?? "";
  if (url.trim() === "") {
    throw new Error(`${urlVariable} is not set`);
  }
  return { environment: named, phase, url, urlVariable };
}
