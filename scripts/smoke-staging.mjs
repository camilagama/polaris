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

const HTTPS_ORIGIN = /^https:\/\/[^/]+$/;

/** Runs every check (none stops the others) and returns the failures. */
export async function runSmoke(origins, fetchImpl = fetch) {
  for (const [key, origin] of Object.entries(origins)) {
    if (!HTTPS_ORIGIN.test(origin ?? "")) {
      return [
        `${key}: the staging origin must be https://host, without a path`,
      ];
    }
  }
  const failures = [];
  for (const check of smokeChecks(origins)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, for a readable log
      const response = await fetchImpl(check.url, { redirect: "manual" });
      const passed = check.expect(response);
      console.log(
        `${passed ? "ok" : "FAIL"} ${check.name}: ${response.status}`
      );
      if (!passed) {
        failures.push(`${check.name}: ${response.status}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.name : "error";
      console.log(`FAIL ${check.name}: ${reason}`);
      failures.push(`${check.name}: ${reason}`);
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
