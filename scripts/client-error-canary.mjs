import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseSince } from "./client-error-sentinel.mjs";

/**
 * The daily synthetic browser error of the staging (docs/runbooks/erros-do-navegador.md, "Canário diário"). The
 * sentinel reads 0 lines both when nothing failed and when its query is blind; this script tells them apart.
 *
 * Without `--check`: one valid `POST /api/client-errors` with a fixed body. With `--check`: a query of the telemetry
 * (same API and token as the sentinel) for the canary fingerprint; no line in the window is the exit code
 * `EXIT_BLIND`, "the reader is blind". The cron sends, and 10 minutes later checks.
 *
 * The body is made only of words of the closed lists of `@polaris/contracts/client-error-fields`, with a frame
 * that no real build produces (`canario-<hash>.js`), so the fingerprint belongs to no real failure. The route
 * computes the fingerprint from `kind`, `errorName`, `code`, `status`, `boundary`, `routeId` and the piece of the
 * first frame (`clientErrorSignature` in `apps/web/src/server/routes/client-errors.ts`); `canaryFingerprint`
 * repeats that material, and `client-error-canary.test.mjs` runs the real route to keep both equal. The release
 * is not part of it, so a deploy does not change the fingerprint. The sentinel does not compute fingerprints: it
 * reads the `fingerprint` of the line, so the canary is silenced there by listing `CANARY_FINGERPRINT` in `--mute`.
 *
 * The route answers 204 also when `CLIENT_ERRORS_ENABLED` is off, with nothing logged: the 204 proves nothing, the
 * check does. Nothing is loosened for the canary: a 400 or a 429 exits with `EXIT_REFUSED`.
 *
 * The token is read-only (Observability) and never printed. The output is one JSON line with numbers, the fingerprint
 * and a reason, nothing the API wrote.
 *
 * Usage:
 *   node scripts/client-error-canary.mjs --base-url <origin> --release <sha>
 *   node scripts/client-error-canary.mjs --check --service <worker> [--since 24h] [--now <iso>]
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_API_FAILED = 3;
export const EXIT_REFUSED = 4;
export const EXIT_BLIND = 6;

export const CANARY_PATH = "/api/client-errors";
export const DEFAULT_CHECK_SINCE = "24h";

export const CANARY_EVENT = Object.freeze({
  errorName: "Other",
  frames: Object.freeze(["canario-abcdefgh.js:1:1"]),
  kind: "error",
  routeId: "outra",
  v: 1,
});

/** The material of `clientErrorSignature` for `CANARY_EVENT`: kind, errorName, code, status, boundary, routeId, chunk. */
const SIGNATURE_MATERIAL = JSON.stringify([
  CANARY_EVENT.kind,
  CANARY_EVENT.errorName,
  null,
  null,
  null,
  CANARY_EVENT.routeId,
  "canario",
]);

export function canaryFingerprint() {
  return createHash("sha256")
    .update(SIGNATURE_MATERIAL)
    .digest("hex")
    .slice(0, 16);
}

export const CANARY_FINGERPRINT = canaryFingerprint();

const QUERY_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const RELEASE = /^[0-9a-f]{7,12}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const OPTION_PREFIX = /^--/;
const VALUE_OPTIONS = new Set([
  "base-url",
  "now",
  "release",
  "service",
  "since",
]);

export class ApiFailure extends Error {}

/** The body the route accepts: the canary event plus the release of the staging build. */
export function canaryBody(release) {
  return JSON.stringify({
    ...CANARY_EVENT,
    frames: [...CANARY_EVENT.frames],
    release,
  });
}

export function parseArgs(argv) {
  const args = {};
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i]?.replace(OPTION_PREFIX, "");
    if (!argv[i]?.startsWith("--")) {
      throw new Error(`argument invalid: ${argv[i]}`);
    }
    if (name === "check") {
      check = true;
    } else if (VALUE_OPTIONS.has(name) && argv[i + 1] !== undefined) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`argument invalid: ${argv[i]}`);
    }
  }
  const required = check ? ["service"] : ["base-url", "release"];
  for (const name of required) {
    if (!args[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  return { ...args, check };
}

function originOf(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("--base-url is not a URL", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error("--base-url must be https");
  }
  return url.origin;
}

const failure = (code, reason, extra = {}) => ({
  code,
  output: { fingerprint: CANARY_FINGERPRINT, ok: false, reason, ...extra },
});

async function send({ args, fetchImpl }) {
  let origin;
  try {
    origin = originOf(args["base-url"]);
    if (!RELEASE.test(args.release)) {
      throw new Error(
        "--release is not a short commit hash (7 to 12 hex digits)"
      );
    }
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }
  let response;
  try {
    response = await fetchImpl(`${origin}${CANARY_PATH}`, {
      body: canaryBody(args.release),
      headers: { "content-type": "application/json", origin },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failure(EXIT_API_FAILED, "request failed");
  }
  if (response.status !== 204) {
    return failure(EXIT_REFUSED, `route answered ${response.status}`, {
      status: response.status,
    });
  }
  return {
    code: EXIT_OK,
    output: {
      fingerprint: CANARY_FINGERPRINT,
      ok: true,
      sent: true,
      status: 204,
    },
  };
}

/** The lines of the telemetry that carry the canary fingerprint, from `from` to `to`; throws `ApiFailure` otherwise. */
export async function fetchCanaryLines({
  accountId,
  fetchImpl = fetch,
  from,
  service,
  to,
  token,
}) {
  const filters = [
    {
      key: "fingerprint",
      operation: "eq",
      type: "string",
      value: CANARY_FINGERPRINT,
    },
    {
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: service,
    },
  ];
  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
      {
        body: JSON.stringify({
          limit: QUERY_LIMIT,
          parameters: { filterCombination: "and", filters },
          queryId: "client-error-canary",
          timeframe: { from, to },
          view: "events",
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new ApiFailure("request failed", { cause: error });
  }
  if (response.status < 200 || response.status > 299) {
    throw new ApiFailure(`HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new ApiFailure("response is not JSON", { cause: error });
  }
  const events = body?.result?.events?.events;
  if (!Array.isArray(events)) {
    throw new ApiFailure("response without result.events.events");
  }
  return events.map((event) => {
    const fields =
      event?.source && typeof event.source === "object"
        ? event.source
        : (event ?? {});
    const raw = event?.timestamp ?? fields.timestamp;
    const timestamp = typeof raw === "number" ? raw : Date.parse(raw ?? "");
    return { fingerprint: fields.fingerprint, timestamp };
  });
}

async function checkCanary({ args, env, fetchImpl, now }) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!(accountId && token)) {
    return failure(
      EXIT_USAGE,
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required"
    );
  }
  if (!ACCOUNT_ID.test(accountId)) {
    return failure(EXIT_USAGE, "CLOUDFLARE_ACCOUNT_ID is not 32 hex digits");
  }
  let windowMs;
  let at = now;
  try {
    windowMs = parseSince(args.since ?? DEFAULT_CHECK_SINCE);
    if (args.now !== undefined) {
      at = Date.parse(args.now);
      if (!Number.isFinite(at)) {
        throw new Error("--now invalid");
      }
    }
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }
  const from = at - windowMs;
  let lines;
  try {
    lines = await fetchCanaryLines({
      accountId,
      fetchImpl,
      from,
      service: args.service,
      to: at,
      token,
    });
  } catch (error) {
    const reason =
      error instanceof ApiFailure ? error.message : "request failed";
    return failure(EXIT_API_FAILED, `source failed: ${reason}`);
  }
  const found = lines.filter(
    (line) =>
      line.fingerprint === CANARY_FINGERPRINT &&
      Number.isFinite(line.timestamp) &&
      line.timestamp >= from &&
      line.timestamp <= at
  ).length;
  if (found === 0) {
    return failure(
      EXIT_BLIND,
      "reader blind: canary fingerprint not in the logs",
      {
        found,
        window: args.since ?? DEFAULT_CHECK_SINCE,
      }
    );
  }
  return {
    code: EXIT_OK,
    output: {
      fingerprint: CANARY_FINGERPRINT,
      found,
      ok: true,
      window: args.since ?? DEFAULT_CHECK_SINCE,
    },
  };
}

/** The whole run; returns the JSON to print and the exit code. */
export async function run({ argv, env, fetchImpl = fetch, now = Date.now() }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }
  if (args.check) {
    return await checkCanary({ args, env, fetchImpl, now });
  }
  return await send({ args, fetchImpl });
}

async function main() {
  const { code, output } = await run({
    argv: process.argv.slice(2),
    env: process.env,
  });
  console.log(JSON.stringify(output));
  process.exitCode = code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
