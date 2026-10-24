import { pathToFileURL } from "node:url";

/**
 * The smoke of the fixed staging (ADR 0097), run by the deploy workflow after the Workers are published.
 * Reads only: no sign-in, no write. The catalog page of a store that does not exist must answer 404, which
 * proves the path Worker → Hyperdrive → Neon (the public_catalog_* functions answered) without seeding data.
 * The Admin is not exposed in staging, so it has no check. Prints the route and the status, never a body.
 */

const NONCE = /'nonce-[^']+'/;
const MISSING_STORE = "smoke-staging-loja-inexistente";

/** `web` and `catalog` are the staging origins; each check says what it proves. */
export function smokeChecks({ catalog, web }) {
  return [
    {
      expect: (response) => response.status === 200,
      name: "web /health",
      url: `${web}/health`,
    },
    {
      expect: (response) =>
        response.status === 200 &&
        Boolean(response.headers.get("content-security-policy")),
      name: "web / (SPA shell with CSP)",
      url: `${web}/`,
    },
    {
      expect: (response) => response.status === 200,
      // 503 auth_unavailable means BETTER_AUTH_SECRET or BETTER_AUTH_BASE_URL is missing
      name: "web /api/auth/get-session (auth configured)",
      url: `${web}/api/auth/get-session`,
    },
    {
      expect: (response) =>
        response.status === 200 &&
        NONCE.test(response.headers.get("content-security-policy") ?? ""),
      name: "catalog / (CSP with nonce)",
      url: `${catalog}/`,
    },
    {
      expect: (response) => response.status === 404,
      name: "catalog store page through Hyperdrive (unknown store answers 404)",
      url: `${catalog}/${MISSING_STORE}`,
    },
  ];
}

const STAGING_HOST = /^polaris-[a-z]+-staging\.[a-z0-9-]+\.workers\.dev$/;
// the web and the catalog of staging are served at these hosts by Custom Domains (ADR 0097)
const STAGING_FIXED_HOST = {
  catalog: "catalogo.araute.app",
  web: "dash.araute.app",
};
const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

/** An https origin of a staging Worker (workers.dev or the fixed host of that Worker), with no path, query or credentials. */
function isStagingOrigin(key, origin) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      url.origin === origin &&
      // TODO(pós STAGING_CATALOG_URL): the workers.dev of the catalog is accepted only for the transition; it leaves in a short PR after the variable changes to the new host (drop STAGING_HOST for the `catalog` key only, since the web shares it).
      (STAGING_HOST.test(url.host) || url.host === STAGING_FIXED_HOST[key])
    );
  } catch {
    return false;
  }
}

/** The code of a network failure (ENOTFOUND, ETIMEDOUT), never its message. */
function reasonOf(error) {
  if (!(error instanceof Error)) {
    return "error";
  }
  const code = error.cause?.code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/**
 * One check, tried up to ATTEMPTS times with a pause: right after a deploy, a version may still be
 * propagating. Each request gives up after TIMEOUT_MS.
 */
async function attempt(check, fetchImpl, pause) {
  let outcome = "";
  for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
      const response = await fetchImpl(check.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (check.expect(response)) {
        return { outcome: String(response.status), passed: true };
      }
      outcome = String(response.status);
    } catch (error) {
      outcome = reasonOf(error);
    }
    if (tries < ATTEMPTS) {
      await pause();
    }
  }
  return { outcome, passed: false };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 5000));

/** Runs every check (none stops the others) and returns the failures. */
export async function runSmoke(origins, fetchImpl = fetch, pause = wait) {
  for (const [key, origin] of Object.entries(origins)) {
    if (!isStagingOrigin(key, origin)) {
      return [
        `${key}: the origin must be https://polaris-<app>-staging.…, https://dash.araute.app (web) or https://catalogo.araute.app (catalog), without a path`,
      ];
    }
  }
  const failures = [];
  for (const check of smokeChecks(origins)) {
    // biome-ignore lint/performance/noAwaitInLoops: one check at a time, for a readable log
    const { passed, outcome } = await attempt(check, fetchImpl, pause);
    console.log(`${passed ? "ok" : "FAIL"} ${check.name}: ${outcome}`);
    if (!passed) {
      failures.push(`${check.name}: ${outcome}`);
    }
  }
  return failures;
}

async function main() {
  const failures = await runSmoke({
    catalog: process.env.STAGING_CATALOG_URL,
    web: process.env.STAGING_WEB_URL,
  });
  if (failures.length > 0) {
    console.error(`Staging smoke failed (${failures.length}).`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
