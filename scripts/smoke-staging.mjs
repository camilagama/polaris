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
 * Assets without the Worker, is compared with the build artifact the deploy published. The Admin of staging sits
 * behind Cloudflare Access (amendments to ADR 0097 and ADR 0070): without a sign-in, its health and its API must be
 * answered by Access with a redirect to the login of the staging team, never by the Worker. The billing webhooks of
 * Asaas and Woovi get a POST without a token or a signature, which the Worker must refuse with 401 before storing
 * anything (a 503 says a provider secret is missing). Before the checks that compare the release or the shell, a
 * Worker that still answers with another release is waited for, up to `RELEASE_WAIT_CEILING_MS`: the edge shows a
 * new version some seconds after the deploy says it is active. Prints the check, the status and a fixed reason,
 * never a body or a header; the one value taken from a header is the release a Worker still serves, and only when
 * it is 12 hex characters.
 *
 * `--env production` runs the same checks against the production Workers. The production domain is not defined in the repository,
 * so no host is written in this file: the hosts, the Access team of the Admin, the expected sign-in methods and release header come
 * from `PRODUCTION_*` variables, and the smoke refuses to run (before any request) while one is missing or malformed.
 * Without `--env`, the environment is staging, exactly as the deploy workflow of staging runs it.
 */

const NONCE = /'nonce-[^']+'/;
const MISSING_STORE = "smoke-staging-loja-inexistente";
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RELEASE_HEADER = "x-polaris-release";

/**
 * The ingest origin of a Sentry DSN, with the same host pattern as `INGEST_HOST` in
 * `apps/web/src/observability/sentry-dsn.ts` (a deliberate copy, so the smoke imports no code of the app;
 * `smoke-staging.test.mjs` fails when the two patterns differ). The build opens it in the `connect-src` of the
 * app shell only when it was made with a valid `VITE_SENTRY_DSN` and a valid `VITE_SENTRY_ENVIRONMENT`
 * (`apps/web/pwa/sentry-build.ts`), so its presence in the CSP of the shell proves the DSN reached the build that is
 * on the air.
 */
const SENTRY_INGEST_ORIGIN =
  /^https:\/\/o\d+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/;

/** The Access team of staging: an anonymous request to the Admin is sent to the login of its application. */
export const STAGING_ACCESS_TEAM = "polaris-staging.cloudflareaccess.com";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Sent on every request, so the requests of the smoke are told apart in the logs of the Workers. */
export const USER_AGENT = "polaris-staging-smoke/1";
export const PRODUCTION_USER_AGENT = "polaris-production-smoke/1";

/** An origin no Worker accepts: a POST under /rpc with it must be refused by the origin check. */
export const STRANGE_ORIGIN = "https://origem-estranha.invalid";

/** The name `createInitial` gets in the anonymous call; refused before the handler, so nothing is created. */
export const CREATE_INITIAL_INPUT = {
  name: "smoke - nao criar",
  timezone: "America/Sao_Paulo",
};

/** What `/api/auth-methods` must say in staging: the Google and the password sign-in, with the Turnstile key (the key is only expected while the password is on). */
const EXPECTED_AUTH_METHODS = { emailPassword: true, google: true };

const ACCESS_LOGIN_PREFIX = "/cdn-cgi/access/login/";

/** The release a Worker declares: the first 12 characters of the commit (`packages/http-security/src/server-release.ts`). */
const releaseOf = (commit) => commit.slice(0, 12);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parsed(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function releaseReason(response, release, declares = true) {
  const declared = response.headers.get(RELEASE_HEADER);
  if (!declares) {
    return declared === null || "release header present (flag is off)";
  }
  if (declared === null) {
    return "release absent";
  }
  return declared === release ? true : "release different";
}

const WHITESPACE = /\s+/;

/** True when the `connect-src` of the policy lists an ingest origin of Sentry. */
const opensSentryIngest = (policy) =>
  policy
    .split(";")
    .map((directive) => directive.trim().split(WHITESPACE))
    .some(
      ([name, ...sources]) =>
        name?.toLowerCase() === "connect-src" &&
        sources.some((source) => SENTRY_INGEST_ORIGIN.test(source))
    );

const status = (expected) => (response) =>
  response.status === expected || `not ${expected}`;

/** The origin check refuses with 403 and `error.code === "forbidden"`; any other 403 is not that refusal. */
const refusedByOrigin = (response, body) => {
  if (response.status !== 403) {
    return "not 403";
  }
  return parsed(body)?.error?.code === "forbidden" || "403 not forbidden";
};

/**
 * Access answered instead of the Worker: a redirect to an https page of the team of the environment, and no mark of
 * the Worker (release or request id), which would mean the request went through.
 */
const sentToAccess =
  ({ accessLoginPath, accessTeam }) =>
  (response) => {
    if (!REDIRECT_STATUS.has(response.status)) {
      return "not a redirect to Access";
    }
    if (
      response.headers.get(RELEASE_HEADER) !== null ||
      response.headers.get("x-request-id") !== null
    ) {
      return "answered by the Worker";
    }
    try {
      const location = new URL(response.headers.get("location") ?? "");
      if (location.protocol !== "https:" || location.host !== accessTeam) {
        return "redirect outside the Access team";
      }
      return (
        location.pathname === accessLoginPath ||
        "redirect to another Access page"
      );
    } catch {
      return "redirect outside the Access team";
    }
  };

const rpc = (body) => ({
  body: JSON.stringify(body),
  method: "POST",
});

/** The billing providers whose webhook route the smoke knocks on, without a token or a signature. */
export const BILLING_WEBHOOK_PROVIDERS = ["asaas", "woovi"];

/**
 * A delivery without proof of the provider is refused with 401 `unauthorized` before the body is read as an event,
 * so nothing is stored. A 503 `billing_provider_not_configured` (or `resend_webhook_not_configured`, the Resend
 * webhook of the tips series) means a secret or a public key of the provider is missing in the Worker; a 200 would
 * mean the route took a delivery nobody signed.
 */
const refusedWebhook = (response, body) => {
  const code = parsed(body)?.error?.code;
  if (response.status === 401) {
    return code === "unauthorized" || "401 not unauthorized";
  }
  if (
    response.status === 503 &&
    (code === "billing_provider_not_configured" ||
      code === "resend_webhook_not_configured")
  ) {
    return "provider not configured (a secret is missing)";
  }
  return response.status === 200 ? "accepted without a signature" : "not 401";
};

/**
 * The checks, in order. `web` and `catalog` are the origins of the environment (`target`, staging by default); `release` is the 12 characters each Worker
 * must declare and `shell` the sha256 of `index.html` and `sw.js` of the build artifact. `worker: true` marks an
 * answer of the web Worker, which always carries an `X-Request-Id`. `awaitsRelease` names the Worker whose release the
 * smoke waits for before the checks run. `platform: true` marks the anonymous /rpc
 * calls that build Better Auth: on the Workers Free plan a cold isolate may exceed its CPU (error 1102, a 503
 * of the platform), and repeating it only spends more CPU, so a 503 or an answer without `X-Request-Id` fails at
 * once as `cpu/plataforma`. They run last, after the get-session has warmed the auth path.
 */
export function smokeChecks(
  { admin, catalog, web },
  { release, shell },
  target = STAGING_TARGET
) {
  const appOrigin = new URL(web).origin;
  const toAccess = sentToAccess(target);
  const { authMethods, declaresRelease, expectsSentryIngest } = target;
  const sameOrigin = { origin: appOrigin };
  return [
    {
      awaitsRelease: "web",
      expect: (response) =>
        response.status === 200
          ? releaseReason(response, release, declaresRelease)
          : "not 200",
      name: "web /health (release of the Worker)",
      url: `${web}/health`,
      worker: true,
    },
    {
      expect: (response, body) => {
        if (response.status !== 200) {
          return "not 200";
        }
        const policy = response.headers.get("content-security-policy");
        if (!policy) {
          return "no CSP";
        }
        if (sha256(body) !== shell.index) {
          return "shell different";
        }
        return (
          !expectsSentryIngest ||
          opensSentryIngest(policy) ||
          "sentry ingest host missing in CSP"
        );
      },
      name: "web / (SPA shell with CSP, equal to the artifact)",
      readBody: "bytes",
      url: `${web}/`,
    },
    {
      expect: (response, body) =>
        response.status === 200
          ? sha256(body) === shell.serviceWorker || "service worker different"
          : "not 200",
      name: "web /sw.js (equal to the artifact)",
      readBody: "bytes",
      url: `${web}/sw.js`,
    },
    {
      expect: (response, body) =>
        response.status === 200
          ? sha256(body) === shell.index || "shell different"
          : "not 200",
      name: "web /entrar (the shell, equal to the artifact)",
      readBody: "bytes",
      url: `${web}/entrar`,
    },
    {
      expect: (response, body) => {
        if (response.status !== 200) {
          return "not 200";
        }
        const methods = parsed(body);
        if (
          methods?.google !== authMethods.google ||
          methods?.emailPassword !== authMethods.emailPassword
        ) {
          return "sign-in methods different";
        }
        const siteKey = methods.turnstileSiteKey;
        if (authMethods.emailPassword) {
          return (
            (typeof siteKey === "string" && siteKey.trim() !== "") ||
            "Turnstile site key missing with the password on"
          );
        }
        return (
          siteKey === null || "Turnstile site key set with the password off"
        );
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
      expect: refusedByOrigin,
      name: "web POST /rpc/system/ping without Origin (refused)",
      readBody: true,
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: refusedByOrigin,
      headers: { origin: STRANGE_ORIGIN },
      name: "web POST /rpc/system/ping from a strange origin (refused)",
      readBody: true,
      url: `${web}/rpc/system/ping`,
      worker: true,
    },
    {
      ...rpc({}),
      expect: refusedByOrigin,
      headers: { origin: "null" },
      name: "web POST /rpc/system/ping with Origin null (refused)",
      readBody: true,
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
      awaitsRelease: "catalog",
      expect: (response) =>
        response.status === 200
          ? releaseReason(response, release, declaresRelease)
          : "not 200",
      name: "catalog /robots.txt (release of the Worker)",
      url: `${catalog}/robots.txt`,
    },
    {
      expect: status(404),
      name: "catalog store page through Hyperdrive (unknown store answers 404)",
      url: `${catalog}/${MISSING_STORE}`,
    },
    {
      expect: toAccess,
      name: "admin /health without sign-in (redirected to Access)",
      url: `${admin}/health`,
    },
    {
      expect: toAccess,
      name: "admin /api/whoami without sign-in (redirected to Access)",
      url: `${admin}/api/whoami`,
    },
    ...BILLING_WEBHOOK_PROVIDERS.map((provider) => ({
      ...rpc({}),
      expect: refusedWebhook,
      name: `web POST /webhooks/billing/${provider} without a signature (refused with 401)`,
      readBody: true,
      url: `${web}/webhooks/billing/${provider}`,
      worker: true,
    })),
    {
      ...rpc({}),
      expect: refusedWebhook,
      name: "web POST /webhooks/email/resend without a signature (refused with 401)",
      readBody: true,
      url: `${web}/webhooks/email/resend`,
      worker: true,
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

// the Workers of staging are served at these hosts by Custom Domains (ADR 0097); each Worker accepts its own host
// only, and the workers.dev hosts are off (`workers_dev: false`)
export const STAGING_FIXED_HOST = {
  admin: "admin.araute.app",
  catalog: "catalogo.araute.app",
  web: "dash.araute.app",
};
const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

/**
 * Total time the smoke waits for the edge to serve the new release, counted from the first read of each Worker (the
 * Workers wait side by side). The wait is by condition: it ends when the Worker declares the new release.
 */
export const RELEASE_WAIT_CEILING_MS = 120_000;
const RELEASE_WAIT_FIRST_PAUSE_MS = 2000;
const RELEASE_WAIT_LAST_PAUSE_MS = 15_000;
const RELEASE_VALUE = /^[0-9a-f]{12}$/;

/**
 * An https origin of a Worker of the environment, with no path, query or credentials, whose host is the fixed host
 * of that key. A key with no fixed host is never accepted.
 */
function isTargetOrigin(hosts, key, origin) {
  const host = Object.hasOwn(hosts, key) ? hosts[key] : undefined;
  if (!host || typeof origin !== "string") {
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
  admin:
    "admin: the staging Admin only accepts https://admin.araute.app, without a path",
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

/**
 * What the smoke needs to know about an environment: the host each Worker is served at (the only hosts a request
 * may leave for), the Access team and login path the Admin is redirected to, the sign-in methods `/api/auth-methods`
 * must declare, whether the Workers declare their release, whether the CSP of the shell must open the ingest origin
 * of Sentry (`expectsSentryIngest`, a flag of the target: only staging builds with a DSN), the refusal of a key and the
 * user agent.
 */
export const STAGING_TARGET = {
  accessLoginPath: `${ACCESS_LOGIN_PREFIX}${STAGING_FIXED_HOST.admin}`,
  accessTeam: STAGING_ACCESS_TEAM,
  authMethods: EXPECTED_AUTH_METHODS,
  declaresRelease: true,
  expectsSentryIngest: true,
  hosts: STAGING_FIXED_HOST,
  name: "staging",
  refusalOf,
  userAgent: USER_AGENT,
};

/** The variables that give the production smoke its hosts; none has a default, so the domain is never guessed. */
export const PRODUCTION_VARIABLES = {
  accessTeam: "PRODUCTION_ACCESS_TEAM",
  admin: "PRODUCTION_ADMIN_URL",
  catalog: "PRODUCTION_CATALOG_URL",
  passwordSignIn: "PRODUCTION_EXPECT_PASSWORD_SIGN_IN",
  releaseHeader: "PRODUCTION_EXPECT_RELEASE_HEADER",
  web: "PRODUCTION_WEB_URL",
};

const ACCESS_TEAM_HOST = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const DNS_HOST =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PROTECTED_SUFFIXES = [
  ".workers.dev",
  ".cloudflareaccess.com",
  ".invalid",
  ".localhost",
  ".local",
  ".test",
  ".example",
  ".internal",
  ".home.arpa",
];

const originRefusal = (variable, why) =>
  `${variable}: ${why} (set it to the lowercase https origin of the production Worker, without a path)`;

/** The host of a production origin variable, or the fixed reason it is refused. */
function productionHost(variable, origin) {
  if (typeof origin !== "string" || origin.trim() === "") {
    return {
      refusal: originRefusal(
        variable,
        "missing: the production domain is not configured"
      ),
    };
  }
  if (origin !== origin.trim()) {
    return {
      refusal: originRefusal(variable, "has whitespace around the value"),
    };
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { refusal: originRefusal(variable, "not a URL") };
  }
  if (url.protocol !== "https:") {
    return { refusal: originRefusal(variable, "must be https") };
  }
  if (url.port !== "") {
    return { refusal: originRefusal(variable, "must not have a port") };
  }
  if (url.origin !== origin) {
    return {
      refusal: originRefusal(
        variable,
        "must be the origin only: lowercase, with no path, query or credentials"
      ),
    };
  }
  const stagingHosts = Object.values(STAGING_FIXED_HOST);
  if (
    !DNS_HOST.test(url.host) ||
    PROTECTED_SUFFIXES.some((suffix) => url.host.endsWith(suffix))
  ) {
    return { refusal: originRefusal(variable, "not a custom domain host") };
  }
  if (stagingHosts.includes(url.host)) {
    return { refusal: originRefusal(variable, "is a staging host") };
  }
  return { host: url.host };
}

/**
 * The production target from the environment variables, or the refusals (each naming its variable) when the
 * domain, the Access team or the expected password sign-in are missing, malformed or collide. Nothing is
 * guessed: with no domain configured, every variable is empty and the smoke refuses to run.
 */
export function productionTarget(env) {
  const refusals = [];
  const hosts = {};
  for (const key of ["web", "catalog", "admin"]) {
    const variable = PRODUCTION_VARIABLES[key];
    const result = productionHost(variable, env[variable]);
    if (result.host) {
      hosts[key] = result.host;
    } else {
      refusals.push(result.refusal);
    }
  }
  if (new Set(Object.values(hosts)).size !== Object.keys(hosts).length) {
    refusals.push("production hosts: web, catalog and admin must be distinct");
  }
  const team = env[PRODUCTION_VARIABLES.accessTeam];
  if (
    typeof team !== "string" ||
    !ACCESS_TEAM_HOST.test(team) ||
    team === STAGING_ACCESS_TEAM
  ) {
    refusals.push(
      `${PRODUCTION_VARIABLES.accessTeam}: must be the <team>.cloudflareaccess.com host of the production Access team, not the staging one`
    );
  }
  const password = env[PRODUCTION_VARIABLES.passwordSignIn];
  if (password !== "true" && password !== "false") {
    refusals.push(
      `${PRODUCTION_VARIABLES.passwordSignIn}: must be "true" or "false" (the password sign-in is behind a flag in production)`
    );
  }
  const release = env[PRODUCTION_VARIABLES.releaseHeader];
  if (release !== "true" && release !== "false") {
    refusals.push(
      `${PRODUCTION_VARIABLES.releaseHeader}: must be "true" or "false" (RELEASE_HEADER_ENABLED of the production Workers)`
    );
  }
  if (refusals.length > 0) {
    return { refusals, target: null };
  }
  return {
    refusals,
    target: {
      accessLoginPath: `${ACCESS_LOGIN_PREFIX}${hosts.admin}`,
      accessTeam: team,
      authMethods: { emailPassword: password === "true", google: true },
      declaresRelease: release === "true",
      expectsSentryIngest: false,
      hosts,
      name: "production",
      refusalOf: (key) =>
        Object.hasOwn(hosts, key)
          ? `${key}: the origin is not the one declared for the production ${key}`
          : `${key}: no production host is accepted for this key`,
      userAgent: PRODUCTION_USER_AGENT,
    },
  };
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

/**
 * One request of a check. It leaves only for a fixed host of the environment: whatever builds the list, nothing is
 * ever sent (and above all posted) elsewhere.
 */
export async function send(check, fetchImpl, target = STAGING_TARGET) {
  const method = check.method ?? "GET";
  if (!Object.values(target.hosts).includes(new URL(check.url).host)) {
    throw new Error("host_refused");
  }
  return await fetchImpl(check.url, {
    body: check.body,
    headers: {
      ...(check.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...check.headers,
      "user-agent": target.userAgent,
    },
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** The shell is compared as bytes, as published; the answers of the Worker are read as text. */
async function bodyOf(check, response) {
  if (check.readBody === "bytes") {
    return new Uint8Array(await response.arrayBuffer());
  }
  return check.readBody ? await response.text() : "";
}

/** True when the check passed, otherwise the fixed reason of the failure; never a body or a header value. */
async function judge(check, response) {
  if (
    check.worker &&
    !REQUEST_ID.test(response.headers.get("x-request-id") ?? "")
  ) {
    return "no X-Request-Id";
  }
  return check.expect(response, await bodyOf(check, response));
}

/** A failure of the platform, not of the Worker: Cloudflare's own 503 (CPU exceeded, 1102) has no request id. */
const isPlatformFailure = (response) =>
  response.status === 503 || !response.headers.get("x-request-id");

/**
 * One check, tried up to ATTEMPTS times with a pause: right after a deploy, a version may still be
 * propagating. Each request gives up after TIMEOUT_MS. A check marked `platform` is not repeated after a failure
 * of the platform.
 */
export async function attempt(
  check,
  fetchImpl,
  pause,
  target = STAGING_TARGET
) {
  let outcome = "";
  for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
      const response = await send(check, fetchImpl, target);
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

/** The time of the release wait; the tests give it a clock that moves only when it sleeps. */
const SYSTEM_CLOCK = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * What a Worker declares as its release: `arrived` is the new one, `stale` is an answer 200 with another release (the
 * version is still propagating), and `other` is anything else (no header, an error, no answer).
 */
async function releaseRead(check, release, fetchImpl, target) {
  let response;
  try {
    response = await send(check, fetchImpl, target);
    const declared = response.headers.get(RELEASE_HEADER) ?? "";
    if (response.status === 200 && declared === release) {
      return { active: declared, state: "arrived" };
    }
    if (response.status === 200 && RELEASE_VALUE.test(declared)) {
      return { active: declared, state: "stale" };
    }
  } catch {
    return { active: null, state: "other" };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
  return { active: null, state: "other" };
}

/**
 * Reads the release of one Worker until it declares the new one, with a pause that doubles up to
 * `RELEASE_WAIT_LAST_PAUSE_MS`. A first read that is neither the new release nor another one (no header, an error, no
 * answer) ends the wait, and the check judges it as it always did; once another release was seen, a failed read does
 * not end it, because the Worker is still propagating. Returns null when the wait is over, or the failure when
 * `RELEASE_WAIT_CEILING_MS` ran out (only a release of 12 hex characters is printed, never another header value).
 */
export async function awaitRelease(
  check,
  release,
  fetchImpl,
  clock,
  target = STAGING_TARGET
) {
  const started = clock.now();
  let active = null;
  for (let step = 0; ; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the reads are sequential, each one after its pause
    const read = await releaseRead(check, release, fetchImpl, target);
    if (read.state === "arrived" || (read.state === "other" && !active)) {
      return null;
    }
    active = read.active ?? active;
    const remaining = RELEASE_WAIT_CEILING_MS - (clock.now() - started);
    if (remaining <= 0) {
      return `release wait (${check.awaitsRelease}): the release ${release} did not reach the edge in ${RELEASE_WAIT_CEILING_MS / 1000} s; active: ${active}`;
    }
    await clock.sleep(
      Math.min(
        RELEASE_WAIT_FIRST_PAUSE_MS * 2 ** step,
        RELEASE_WAIT_LAST_PAUSE_MS,
        remaining
      )
    );
  }
}

/** The sha256 of the shell files of the web build the deploy published (`apps/web/dist/client`). */
async function shellOf(buildDir) {
  const [index, serviceWorker] = await Promise.all(
    ["index.html", "sw.js"].map((file) => readFile(join(buildDir, file)))
  );
  return { index: sha256(index), serviceWorker: sha256(serviceWorker) };
}

/**
 * Runs every check (none stops the others) and returns the failures. `commit` is the deployed commit
 * (`HEAD_SHA`) and `buildDir` the client folder of the web build that was published.
 */
export async function runSmoke(
  origins,
  { buildDir, clock = SYSTEM_CLOCK, commit, target = STAGING_TARGET },
  fetchImpl = fetch,
  pause = wait
) {
  for (const [key, origin] of Object.entries(origins)) {
    if (!isTargetOrigin(target.hosts, key, origin)) {
      return [target.refusalOf(key)];
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
  const checks = smokeChecks(
    origins,
    { release: releaseOf(commit), shell },
    target
  );
  const failures = [];
  const waits = target.declaresRelease
    ? await Promise.all(
        checks
          .filter((check) => check.awaitsRelease)
          .map((check) =>
            awaitRelease(check, releaseOf(commit), fetchImpl, clock, target)
          )
      )
    : [];
  for (const failure of waits.filter((reason) => reason !== null)) {
    console.log(`FAIL ${failure}`);
    failures.push(failure);
  }
  for (const check of checks) {
    // biome-ignore lint/performance/noAwaitInLoops: one check at a time, for a readable log
    const { passed, outcome } = await attempt(check, fetchImpl, pause, target);
    console.log(`${passed ? "ok" : "FAIL"} ${check.name}: ${outcome}`);
    if (!passed) {
      failures.push(`${check.name}: ${outcome}`);
    }
  }
  return failures;
}

const ENVIRONMENTS = ["staging", "production"];

/**
 * The environment of the arguments: staging with none, `--env <name>` or `--env=<name>` with a known name. Anything
 * else (an unknown name, a repeated or misspelled option, a stray argument) is null, so a mistyped production step
 * never falls back to staging.
 */
export function environmentOf(argv) {
  if (argv.length === 0) {
    return "staging";
  }
  let value = null;
  if (argv.length === 2 && argv[0] === "--env") {
    [, value] = argv;
  } else if (argv.length === 1 && argv[0].startsWith("--env=")) {
    value = argv[0].slice("--env=".length);
  }
  return ENVIRONMENTS.includes(value) ? value : null;
}

/** The origins and the target of an environment from its variables, or the refusals that stop the run. */
export function planOf(environment, env) {
  if (environment === "production") {
    const { refusals, target } = productionTarget(env);
    if (target === null) {
      return { origins: {}, refusals, target: STAGING_TARGET };
    }
    return {
      origins: {
        admin: env[PRODUCTION_VARIABLES.admin],
        catalog: env[PRODUCTION_VARIABLES.catalog],
        web: env[PRODUCTION_VARIABLES.web],
      },
      refusals,
      target,
    };
  }
  return {
    origins: {
      admin: env.STAGING_ADMIN_URL,
      catalog: env.STAGING_CATALOG_URL,
      web: env.STAGING_WEB_URL,
    },
    refusals: [],
    target: STAGING_TARGET,
  };
}

async function main() {
  const environment = environmentOf(process.argv.slice(2));
  if (environment === null) {
    console.error(
      `Smoke refused: --env must be one of ${ENVIRONMENTS.join(", ")}, given once as --env <name> or --env=<name>, with no other argument.`
    );
    process.exitCode = 1;
    return;
  }
  const { origins, refusals, target } = planOf(environment, process.env);
  if (refusals.length > 0) {
    for (const refusal of refusals) {
      console.error(refusal);
    }
    console.error(`Smoke refused (${environment}): nothing was requested.`);
    process.exitCode = 1;
    return;
  }
  const failures = await runSmoke(origins, {
    buildDir: "apps/web/dist/client",
    commit: process.env.HEAD_SHA,
    target,
  });
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    const label = environment === "staging" ? "Staging" : "Production";
    console.error(`${label} smoke failed (${failures.length}).`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
