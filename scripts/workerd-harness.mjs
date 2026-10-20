/**
 * Support for the Workers test harness (`@cloudflare/vitest-plugin`, the
 * `*.workerd.test.ts` files). One guard decides which database a Worker under
 * test may be pointed at, so no test can reach a real database by accident
 * (the wrangler file of an app carries a `localConnectionString`, and a
 * developer machine may have a PostgreSQL on its default port).
 *
 * - Admin (no database): the Hyperdrive goes to a loopback port nobody listens
 *   on. A query fails closed, and that failure is what the test observes.
 * - Tests that do need PostgreSQL (T-121b, T-127a) run in the `database` job,
 *   with CI=true, and may also use loopback or the Postgres service of that job
 *   (the same rule as the gates, `packages/db/scripts/gate-hosts.ts`).
 */

/** Loopback port nobody listens on: a connection is refused at once. */
export const CLOSED_PORT = 1;

/** A Hyperdrive connection string that always fails closed; never a real database. */
export const closedHyperdriveConnectionString = `postgresql://harness:harness@127.0.0.1:${CLOSED_PORT}/harness`;

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const postgresProtocols = ["postgres:", "postgresql:"];
// Parameters that make a driver connect somewhere other than the host of the URL.
const overridingParameters = ["host", "hostaddr", "service"];

/**
 * Refuses a connection string whose host is not loopback or one of
 * `serviceHosts` (the Postgres service of the `database` job). Like the gates
 * (`packages/db/scripts/gate-hosts.ts`), a PostgreSQL that can actually answer
 * is accepted only when `CI=true`: on a developer machine the only database a
 * Worker under test may reach is the closed port. Never opens a connection.
 */
export function assertAllowedHyperdriveHost(
  connectionString,
  { serviceHosts = [], environment = process.env } = {}
) {
  let url;
  try {
    url = new URL(connectionString);
  } catch (cause) {
    throw new Error("Workers harness: the connection string is not a URL.", {
      cause,
    });
  }
  if (!postgresProtocols.includes(url.protocol)) {
    throw new Error("Workers harness: the connection must be PostgreSQL.");
  }
  if (overridingParameters.some((name) => url.searchParams.has(name))) {
    throw new Error(
      "Workers harness: a host override in the query string is refused."
    );
  }
  const ci = environment.CI === "true";
  const closedPort =
    loopbackHosts.includes(url.hostname) && url.port === String(CLOSED_PORT);
  const allowed =
    closedPort ||
    (ci &&
      (loopbackHosts.includes(url.hostname) ||
        serviceHosts.includes(url.hostname)));
  if (!allowed) {
    throw new Error(
      "Workers harness: the Worker under test may reach only the closed loopback port, or, with CI=true, loopback or the Postgres service of the database job."
    );
  }
  return connectionString;
}

/**
 * The `miniflare.hyperdrives` of a project, every connection string checked by
 * the guard. A project that points a Hyperdrive anywhere builds it here.
 */
export function harnessHyperdrives(connections, options) {
  return Object.fromEntries(
    Object.entries(connections).map(([binding, connectionString]) => [
      binding,
      assertAllowedHyperdriveHost(connectionString, options),
    ])
  );
}
