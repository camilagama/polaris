/**
 * The single list of hosts a PostgreSQL gate may connect to. The runner and the
 * gate scripts all read it, so a host outside the list is refused before any
 * connection opens (and a new host is one reviewed change here).
 *
 * - Neon: a direct (non-pooled) endpoint of a disposable branch in São Paulo.
 * - Local: the Postgres service of the CI job, accepted only when `CI=true`
 *   (a developer machine never gets it).
 */
export const neonDisposableHostPattern =
  /^(?!.*pooler)ep-[a-z0-9-]+\.[a-z0-9-]+\.sa-east-1\.aws\.neon\.tech$/;
export const localCiHosts: readonly string[] = ["localhost", "127.0.0.1"];
const poolerPattern = /pooler/i;
const postgresProtocols = ["postgres:", "postgresql:"];
const overridingHostParameters = ["host", "hostaddr"];
const refusal =
  "The gate target must be a direct disposable Neon endpoint (or local Postgres in CI).";

export function isCiEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return environment.CI === "true";
}

export function isAllowedGateHost(
  hostname: string,
  ci: boolean = isCiEnvironment()
): boolean {
  if (poolerPattern.test(hostname)) {
    return false;
  }
  return (
    neonDisposableHostPattern.test(hostname) ||
    (ci && localCiHosts.includes(hostname))
  );
}

/** True when the host is the job's own Postgres, which has no TLS to verify. */
export function isLocalGateHost(
  hostname: string,
  ci: boolean = isCiEnvironment()
): boolean {
  return ci && localCiHosts.includes(hostname);
}

/** Refuses a URL whose host is outside the list. Never opens a connection. */
export function assertAllowedGateUrl(
  url: string,
  ci: boolean = isCiEnvironment()
): URL {
  const parsed = new URL(url);
  // The driver reads `?host=` and `?hostaddr=` over the host of the URL, so a
  // URL can name an allowed host and connect to another.
  if (
    !postgresProtocols.includes(parsed.protocol) ||
    overridingHostParameters.some((name) => parsed.searchParams.has(name))
  ) {
    throw new Error(refusal);
  }
  if (!isAllowedGateHost(parsed.hostname, ci)) {
    throw new Error(refusal);
  }
  return parsed;
}

const gateHostPatternForCi = new RegExp(
  `^(?:${neonDisposableHostPattern.source.slice(1, -1)}|${localCiHosts
    .map((host) => host.replaceAll(".", "\\."))
    .join("|")})$`
);

/**
 * Pattern form of the same list, for the gates that `assert.match` the host.
 * Evaluated when the module loads, like the `CI` variable it depends on.
 */
export const disposableHostPattern = isCiEnvironment()
  ? gateHostPatternForCi
  : neonDisposableHostPattern;
