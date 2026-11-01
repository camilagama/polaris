import { pathToFileURL } from "node:url";

/**
 * The smoke of the fixed staging (ADR 0097), run by the deploy workflow after the Workers are published.
 * No secret, no sign-in and nothing written: every /rpc call is anonymous and must be refused. The Admin is not
 * exposed in staging, so it has no check. Prints the route, the status and what was expected, never a body.
 */

const NONCE = /'nonce-[^']+'/;
const MISSING_STORE = "smoke-staging-loja-inexistente";
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";
const FORGED_ORIGIN = "https://forged-origin.invalid";
// oRPC validates the input before it reads the session: an anonymous call reaches the 401 only with a valid input
const NIL_ID = "00000000-0000-4000-8000-000000000000";

function hasShellHeaders(response) {
  const { headers } = response;
  return (
    (headers.get("strict-transport-security") ?? "").startsWith("max-age=") &&
    headers.get("x-content-type-options") === "nosniff" &&
    headers.get("x-frame-options") === "DENY" &&
    headers.get("cross-origin-opener-policy") === "same-origin" &&
    headers.get("referrer-policy") === "strict-origin-when-cross-origin"
  );
}

function cspDirectives(response) {
  return (response.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((directive) => directive.trim());
}

function isSignInPage(response) {
  const directives = cspDirectives(response);
  return (
    response.status === 200 &&
    hasShellHeaders(response) &&
    directives.includes(
      `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_SCRIPT}`
    ) &&
    directives.includes("frame-ancestors 'none'")
  );
}

function bodyOf(response) {
  return response.json().catch(() => null);
}

// the status alone could come from the edge (WAF, Access); the body names the layer that refused
async function isSessionRefusal(response) {
  return (
    response.status === 401 &&
    (await bodyOf(response))?.json?.code === "UNAUTHORIZED"
  );
}

async function isOriginRefusal(response) {
  return (
    response.status === 403 &&
    (await bodyOf(response))?.error?.code === "forbidden"
  );
}

function rpcCall(origin, input) {
  return {
    body: JSON.stringify({ json: input }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  };
}

/** `web` and `catalog` are the staging origins; each check says what it proves. */
export function smokeChecks({ catalog, web }) {
  return [
    {
      expect: (response) => response.status === 200,
      expected: "200",
      name: "web /health",
      url: `${web}/health`,
    },
    {
      expect: (response) =>
        response.status === 200 &&
        Boolean(response.headers.get("content-security-policy")),
      expected: "200 with a Content-Security-Policy",
      name: "web / (SPA shell with CSP)",
      url: `${web}/`,
    },
    {
      expect: isSignInPage,
      expected: "200 with the shell headers and the Turnstile CSP",
      name: "web /entrar (sign-in page with its headers)",
      url: `${web}/entrar`,
    },
    {
      expect: (response) => response.status === 200,
      // 503 auth_unavailable means BETTER_AUTH_SECRET or BETTER_AUTH_BASE_URL is missing
      expected: "200",
      name: "web /api/auth/get-session (auth configured)",
      url: `${web}/api/auth/get-session`,
    },
    {
      expect: isSessionRefusal,
      expected: "401 UNAUTHORIZED from the Worker",
      init: rpcCall(web, { organizationId: NIL_ID }),
      name: "web /rpc read without a session (refused, not a 5xx)",
      url: `${web}/rpc/category/list`,
    },
    {
      expect: isSessionRefusal,
      expected: "401 UNAUTHORIZED from the Worker",
      init: rpcCall(web, { id: NIL_ID, organizationId: NIL_ID }),
      name: "web /rpc write with the right Origin and no session (refused, not a 5xx)",
      url: `${web}/rpc/category/archive`,
    },
    {
      expect: isOriginRefusal,
      expected: "403 forbidden from the origin check",
      init: rpcCall(FORGED_ORIGIN, { id: NIL_ID, organizationId: NIL_ID }),
      name: "web /rpc write with a forged Origin (origin check)",
      url: `${web}/rpc/category/archive`,
    },
    {
      expect: (response) =>
        response.status === 200 &&
        NONCE.test(response.headers.get("content-security-policy") ?? ""),
      expected: "200 with a nonce in the CSP",
      name: "catalog / (CSP with nonce)",
      url: `${catalog}/`,
    },
    {
      expect: (response) => response.status === 404,
      expected: "404",
      name: "catalog store page through Hyperdrive (unknown store answers 404)",
      url: `${catalog}/${MISSING_STORE}`,
    },
  ];
}

// the web and the catalog of staging are served at these hosts by Custom Domains (ADR 0097); each Worker
// accepts its own host only, and the workers.dev hosts are off (`workers_dev: false`)
export const STAGING_FIXED_HOST = {
  catalog: "catalogo.araute.app",
  web: "dash.araute.app",
};
const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

/**
 * An https origin of a staging Worker, with no path, query or credentials, whose host is the fixed host of
 * that key. A key with no fixed host is never accepted.
 */
function isStagingOrigin(key, origin) {
  const host = Object.hasOwn(STAGING_FIXED_HOST, key)
    ? STAGING_FIXED_HOST[key]
    : undefined;
  if (!host) {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" && url.origin === origin && url.host === host
    );
  } catch {
    return false;
  }
}

/** One refusal message per key: each Worker accepts its own host only. */
export const REFUSAL = {
  catalog:
    "catalog: the staging catalog only accepts https://catalogo.araute.app, without a path",
  web: "web: the staging web only accepts https://dash.araute.app, without a path",
};

/** The refusal of a key; a key with no message of its own still fails, naming itself. */
export function refusalOf(key) {
  return Object.hasOwn(REFUSAL, key)
    ? REFUSAL[key]
    : `${key}: no staging host is accepted for this key (add it to STAGING_FIXED_HOST and REFUSAL)`;
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
        ...check.init,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (await check.expect(response)) {
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
      return [refusalOf(key)];
    }
  }
  const failures = [];
  for (const check of smokeChecks(origins)) {
    // biome-ignore lint/performance/noAwaitInLoops: one check at a time, for a readable log
    const { passed, outcome } = await attempt(check, fetchImpl, pause);
    if (passed) {
      console.log(`ok ${check.name}: ${outcome}`);
    } else {
      const failure = `${check.name}: ${outcome} (expected ${check.expected})`;
      console.log(`FAIL ${failure}`);
      failures.push(failure);
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
