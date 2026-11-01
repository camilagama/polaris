import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The smoke of the fixed staging (ADR 0097), run by the deploy workflow after the Workers are published.
 * No sign-in and no write: the /rpc calls are a public ping and two anonymous calls that must be refused.
 * The catalog page of a store that does not exist must answer 404, which proves the path Worker → Hyperdrive →
 * Neon (the public_catalog_* functions answered) without seeding data. Each Worker declares the commit it was
 * built from (`X-Polaris-Release`, ADR 0098 amended), compared with `HEAD_SHA`; the shell, served by Static
 * Assets without the Worker, is compared with the build artifact the deploy published. The Admin is not exposed
 * in staging, so it has no check. Prints the check, the status and a fixed reason, never a body or a header.
 */

const NONCE = /'nonce-[^']+'/;
const MISSING_STORE = "smoke-staging-loja-inexistente";
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RELEASE_HEADER = "x-polaris-release";

/** Sent on every request, so the requests of the smoke are told apart in the logs of the Workers. */
export const USER_AGENT = "polaris-staging-smoke/1";

/** An origin no Worker accepts: a POST under /rpc with it must be refused by the origin check. */
export const STRANGE_ORIGIN = "https://origem-estranha.invalid";

/** The name `createInitial` gets in the anonymous call; refused before the handler, so nothing is created. */
export const CREATE_INITIAL_INPUT = {
  name: "smoke - nao criar",
  timezone: "America/Sao_Paulo",
};

/** What `/api/auth-methods` must say in staging: the Google and the password sign-in, with the Turnstile key. */
const EXPECTED_AUTH_METHODS = { emailPassword: true, google: true };

/** The release a Worker declares: the first 12 characters of the commit (`pwa/server-release.ts`). */
const releaseOf = (commit) => commit.slice(0, 12);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function parsed(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function releaseReason(response, release) {
  const declared = response.headers.get(RELEASE_HEADER);
  if (declared === null) {
    return "release absent";
  }
  return declared === release ? true : "release different";
}

const status = (expected) => (response) =>
  response.status === expected || `not ${expected}`;

const rpc = (body) => ({
  body: JSON.stringify(body),
  method: "POST",
});

/**
 * The checks, in order. `web` and `catalog` are the staging origins; `release` is the 12 characters each Worker
 * must declare and `shell` the sha256 of `index.html` and `sw.js` of the build artifact. `worker: true` marks an
 * answer of the web Worker, which always carries an `X-Request-Id`. `platform: true` marks the anonymous /rpc
 * calls that build Better Auth: on the Workers Free plan a cold isolate may exceed its CPU (error 1102, a 503
 * of the platform), and repeating it only spends more CPU, so a 503 or an answer without `X-Request-Id` fails at
 * once as `cpu/plataforma`. They run last, after the get-session has warmed the auth path.
 */
export function smokeChecks({ catalog, web }, { release, shell }) {
  const appOrigin = new URL(web).origin;
  const sameOrigin = { origin: appOrigin };
  return [
    {
      expect: (response) =>
        response.status === 200 ? releaseReason(response, release) : "not 200",
      name: "web /health (release of the Worker)",
      url: `${web}/health`,
      worker: true,
    },
    {
      expect: (response, body) => {
        if (response.status !== 200) {
          return "not 200";
        }
        if (!response.headers.get("content-security-policy")) {
          return "no CSP";
        }
        return sha256(body) === shell.index || "shell different";
      },
      name: "web / (SPA shell with CSP, equal to the artifact)",
      readBody: true,
      url: `${web}/`,
    },
    {
      expect: (response, body) =>
        response.status === 200
          ? sha256(body) === shell.serviceWorker || "service worker different"
          : "not 200",
      name: "web /sw.js (equal to the artifact)",
      readBody: true,
      url: `${web}/sw.js`,
    },
    {
      expect: (response, body) =>
        response.status === 200
          ? sha256(body) === shell.index || "shell different"
          : "not 200",
      name: "web /entrar (the shell, equal to the artifact)",
      readBody: true,
      url: `${web}/entrar`,
    },
    {
      expect: (response, body) => {
        if (response.status !== 200) {
          return "not 200";
        }
        const methods = parsed(body);
        const ready =
          methods?.google === EXPECTED_AUTH_METHODS.google &&
          methods?.emailPassword === EXPECTED_AUTH_METHODS.emailPassword &&
          typeof methods?.turnstileSiteKey === "string" &&
          methods.turnstileSiteKey.trim() !== "";
        return ready || "sign-in methods different";
      },
      name: "web /api/auth-methods (Google, password and Turnstile configured)",
      readBody: true,
      url: `${web}/api/auth-methods`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: (response, body) =>
        response.status === 200
          ? parsed(body)?.json?.message === "pong" || "not pong"
          : "not 200",
      headers: sameOrigin,
      name: "web POST /rpc/system/ping (the oRPC handler answers)",
      readBody: true,
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: status(403),
      name: "web POST /rpc/system/ping without Origin (refused)",
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: status(403),
      headers: { origin: STRANGE_ORIGIN },
      name: "web POST /rpc/system/ping from a strange origin (refused)",
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: status(403),
      headers: { origin: "null" },
      name: "web POST /rpc/system/ping with Origin null (refused)",
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      // 503 auth_unavailable means BETTER_AUTH_SECRET or BETTER_AUTH_BASE_URL is missing
      expect: (response, body) =>
        response.status === 200
          ? body.trim() === "null" || "not an empty session"
          : "not 200",
      name: "web /api/auth/get-session (auth configured, no session)",
      readBody: true,
      url: `${web}/api/auth/get-session`,
      worker: true,
    },
    {
      expect: (response) =>
        response.status === 200 &&
        NONCE.test(response.headers.get("content-security-policy") ?? "")
          ? true
          : "no nonce",
      name: "catalog / (CSP with nonce)",
      url: `${catalog}/`,
    },
    {
      expect: (response) =>
        response.status === 200 ? releaseReason(response, release) : "not 200",
      name: "catalog /robots.txt (release of the Worker)",
      url: `${catalog}/robots.txt`,
    },
    {
      expect: status(404),
      name: "catalog store page through Hyperdrive (unknown store answers 404)",
      url: `${catalog}/${MISSING_STORE}`,
    },
    {
      ...rpc({}),
      expect: status(401),
      headers: sameOrigin,
      name: "web POST /rpc/organization/listMine anonymous (401)",
      platform: true,
      url: `${web}/rpc/organization/listMine`,
      worker: true,
    },
    {
      ...rpc({ json: CREATE_INITIAL_INPUT }),
      expect: status(401),
      headers: sameOrigin,
      name: "web POST /rpc/organization/createInitial anonymous (401)",
      platform: true,
      url: `${web}/rpc/organization/createInitial`,
      worker: true,
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

export const COMMIT_REFUSAL =
  "HEAD_SHA: must be the 40 lowercase hex characters of the deployed commit";

/** The code of a network failure (ENOTFOUND, ETIMEDOUT), never its message. */
function reasonOf(error) {
  if (!(error instanceof Error)) {
    return "error";
  }
  const code = error.cause?.code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

const ALLOWED_HOSTS = new Set(Object.values(STAGING_FIXED_HOST));

/**
 * One request of a check. A POST leaves only for a fixed staging host: whatever builds the list, nothing is ever
 * posted elsewhere.
 */
export async function send(check, fetchImpl) {
  const method = check.method ?? "GET";
  if (method !== "GET" && !ALLOWED_HOSTS.has(new URL(check.url).host)) {
    throw new Error("post_host_refused");
  }
  return await fetchImpl(check.url, {
    body: check.body,
    headers: {
      ...(check.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...check.headers,
      "user-agent": USER_AGENT,
    },
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** True when the check passed, otherwise the fixed reason of the failure; never a body or a header value. */
async function judge(check, response) {
  if (
    check.worker &&
    !REQUEST_ID.test(response.headers.get("x-request-id") ?? "")
  ) {
    return "no X-Request-Id";
  }
  const body = check.readBody ? await response.text() : "";
  return check.expect(response, body);
}

/** A failure of the platform, not of the Worker: Cloudflare's own 503 (CPU exceeded, 1102) has no request id. */
const isPlatformFailure = (response) =>
  response.status === 503 || !response.headers.get("x-request-id");

/**
 * One check, tried up to ATTEMPTS times with a pause: right after a deploy, a version may still be
 * propagating. Each request gives up after TIMEOUT_MS. A check marked `platform` is not repeated after a failure
 * of the platform.
 */
export async function attempt(check, fetchImpl, pause) {
  let outcome = "";
  for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
      const response = await send(check, fetchImpl);
      if (check.platform && isPlatformFailure(response)) {
        return { outcome: `cpu/plataforma ${response.status}`, passed: false };
      }
      const verdict = await judge(check, response);
      if (verdict === true) {
        return { outcome: String(response.status), passed: true };
      }
      outcome = `${response.status} ${verdict}`;
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

/** The sha256 of the shell files of the web build the deploy published (`apps/web/dist/client`). */
async function shellOf(buildDir) {
  const [index, serviceWorker] = await Promise.all(
    ["index.html", "sw.js"].map((file) =>
      readFile(join(buildDir, file), "utf8")
    )
  );
  return { index: sha256(index), serviceWorker: sha256(serviceWorker) };
}

/**
 * Runs every check (none stops the others) and returns the failures. `commit` is the deployed commit
 * (`HEAD_SHA`) and `buildDir` the client folder of the web build that was published.
 */
export async function runSmoke(
  origins,
  { buildDir, commit },
  fetchImpl = fetch,
  pause = wait
) {
  for (const [key, origin] of Object.entries(origins)) {
    if (!isStagingOrigin(key, origin)) {
      return [refusalOf(key)];
    }
  }
  if (typeof commit !== "string" || !COMMIT_SHA.test(commit)) {
    return [COMMIT_REFUSAL];
  }
  let shell;
  try {
    shell = await shellOf(buildDir);
  } catch {
    return [
      "web build: index.html and sw.js of the published build were not found",
    ];
  }
  const failures = [];
  for (const check of smokeChecks(origins, {
    release: releaseOf(commit),
    shell,
  })) {
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
  const failures = await runSmoke(
    {
      catalog: process.env.STAGING_CATALOG_URL,
      web: process.env.STAGING_WEB_URL,
    },
    { buildDir: "apps/web/dist/client", commit: process.env.HEAD_SHA }
  );
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
