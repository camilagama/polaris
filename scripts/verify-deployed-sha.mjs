import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The deploy passes `--message "$HEAD_SHA"`, and that message is stored on the version (not on the deployment),
 * so this reads it back from the active version. It runs in the job that holds the deploy token, so it only reads:
 * the deployments list of the Cloudflare API (which version is active) and that version, two GETs with the Worker
 * name written here and never taken from input, and, when either read fails or the version has no message, two
 * fixed wrangler subcommands. It never prints the body the API answers. The stderr of a failed
 * wrangler, which may carry the error text of the API, is printed only after `cleanStderr`: the token is redacted
 * and every line gets a fixed prefix, as the log is public and the runner acts on workflow commands that start a
 * line (it trims leading spaces, so the prefix is what protects, not the indentation).
 */

export const STAGING_WORKERS = [
  { app: "web", worker: "polaris-web-staging" },
  { app: "catalog", worker: "polaris-catalog-staging" },
  { app: "admin", worker: "polaris-admin-staging" },
];

// the names of env.production in apps/web and apps/catalog (the test reads them back from the wrangler.jsonc)
export const PRODUCTION_WORKERS = [
  { app: "web", worker: "polaris-web" },
  { app: "catalog", worker: "polaris-catalog" },
];

export const WORKERS_BY_ENVIRONMENT = {
  production: PRODUCTION_WORKERS,
  staging: STAGING_WORKERS,
};

/**
 * The Workers of `--env <environment>` (staging without the option, as the staging deploy calls it), or null for
 * anything else: an unknown environment or a stray argument never falls back to a default list.
 */
export function workersFromArgs(args) {
  if (args.length === 0) {
    return STAGING_WORKERS;
  }
  if (
    args.length === 2 &&
    args[0] === "--env" &&
    Object.hasOwn(WORKERS_BY_ENVIRONMENT, args[1])
  ) {
    return WORKERS_BY_ENVIRONMENT[args[1]];
  }
  return null;
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WRANGLER_TIMEOUT_MS = 20_000;
export const API_TIMEOUT_MS = 10_000;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const API_BASE = "https://api.cloudflare.com/client/v4";
const STDERR_MAX_CHARS = 1500;
const STDERR_CAPTURE_BYTES = 64 * 1024;
// pauses before the 2nd, 3rd... try of one Worker: the control plane showed the new version 24 to 47 s late
export const PAUSES_MS = [5000, 10_000, 15_000, 30_000];
export const ATTEMPTS = PAUSES_MS.length + 1;
// no new try starts after this long since the first of the Worker, so the pauses never add up to more
export const RETRY_WINDOW_MS = PAUSES_MS.reduce((sum, ms) => sum + ms, 0);
// `deployments status` and `versions view`: the two wrangler reads of checkWorker when the API read fails
export const WRANGLER_CALLS_PER_TRY = 2;
// the deployments list and the active version
export const API_CALLS_PER_TRY = 2;

/**
 * Longest the whole check can take. The last try of a Worker starts inside RETRY_WINDOW_MS and may hit
 * API_TIMEOUT_MS on each of the two API reads and WRANGLER_TIMEOUT_MS on both wrangler calls, so one Worker takes at most
 * the window plus that try. `workers` is the list checked (or how many).
 */
export function worstCaseMs(workers = STAGING_WORKERS) {
  const count = Array.isArray(workers) ? workers.length : workers;
  return (
    count *
    (RETRY_WINDOW_MS +
      API_CALLS_PER_TRY * API_TIMEOUT_MS +
      WRANGLER_CALLS_PER_TRY * WRANGLER_TIMEOUT_MS)
  );
}

/** A gradual rollout has no single commit. */
function activeVersionId(deployment) {
  const versions = deployment?.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    return {
      failure: `the active deployment is not a single version (${Array.isArray(versions) ? versions.length : "no"} versions listed)`,
    };
  }
  const [{ percentage, version_id: id }] = versions;
  if (percentage !== 100) {
    return { failure: "the active version does not take 100% of the traffic" };
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    return { failure: "the active version has no valid id" };
  }
  return { id };
}

function describeMessage(message) {
  if (typeof message !== "string" || message === "") {
    return "no message";
  }
  return SHA.test(message)
    ? `the commit ${message.slice(0, 12)}`
    : "a message that is not a commit SHA";
}

function compareMessage(message, expectedSha) {
  if (message === expectedSha) {
    return null;
  }
  return `the active version carries ${describeMessage(message)}, expected the commit ${expectedSha.slice(0, 12)}`;
}

class WranglerError extends Error {
  constructor(message, stderr = "") {
    super(message);
    this.stderr = stderr;
  }
}

class ApiError extends Error {}

/**
 * Lines of a failed read that are safe to print: control characters out, the token (exact value, `Bearer ...` and
 * Cloudflare token shapes) redacted, the tail kept, and every line indented so none starts a workflow command.
 */
export function cleanStderr(text, env = process.env) {
  let clean = String(text);
  for (const secret of [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]) {
    if (typeof secret === "string" && secret !== "") {
      clean = clean.split(secret).join("[redacted]");
    }
  }
  clean = clean
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes and control characters
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters other than the newline
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/\bbearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\bcf[a-z]{2}_[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .trim();
  if (clean === "") {
    return "";
  }
  if (clean.length > STDERR_MAX_CHARS) {
    clean = `...${clean.slice(-STDERR_MAX_CHARS)}`;
  }
  return clean
    .split("\n")
    .map((line) => `    wrangler: ${line.trimEnd()}`)
    .join("\n");
}

/**
 * `null` when the active version carries `expectedSha`, otherwise the reason. `api.deployments(worker)` returns the
 * deployments list of the Cloudflare API (newest first) and `api.version(worker, id)` the version with that id; they
 * are asked first, and when one throws or the version has no message, `wranglerJson(app, worker, args)` (the parsed
 * JSON of a wrangler subcommand) reads it instead.
 */
export async function checkWorker(
  { app, worker },
  expectedSha,
  wranglerJson,
  api = null
) {
  if (api) {
    try {
      const decision = await checkApiVersion(worker, expectedSha, api);
      if (decision !== undefined) {
        return decision;
      }
      console.log(
        `${worker}: the API version has no message, reading it with wrangler`
      );
    } catch (error) {
      console.log(
        `${worker}: the API read failed (${error instanceof ApiError ? error.message : reasonOf(error)}), reading it with wrangler`
      );
    }
  }
  const deployment = await wranglerJson(app, worker, [
    "deployments",
    "status",
    "--json",
  ]);
  const { failure, id } = activeVersionId(deployment);
  if (failure) {
    return failure;
  }
  const version = await wranglerJson(app, worker, [
    "versions",
    "view",
    id,
    "--json",
  ]);
  return compareVersion(version, id, expectedSha);
}

/** A decision (`null` or the reason), or `undefined` when the version has no message to compare. */
async function checkApiVersion(worker, expectedSha, api) {
  const deployments = await api.deployments(worker);
  const { failure, id } = activeVersionId(deployments[0]);
  if (failure) {
    return failure;
  }
  const version = await api.version(worker, id);
  if (version?.id !== id) {
    return "the version read back is not the active one";
  }
  const message = version.annotations?.["workers/message"];
  if (typeof message !== "string" || message === "") {
    return;
  }
  return compareMessage(message, expectedSha);
}

function compareVersion(version, id, expectedSha) {
  if (version?.id !== id) {
    return "the version read back is not the active one";
  }
  return compareMessage(version.annotations?.["workers/message"], expectedSha);
}

/** Other errors may carry what the API said, so only their class is printed. */
function reasonOf(error) {
  if (error instanceof WranglerError) {
    return error.message;
  }
  return error instanceof Error ? error.name : "error";
}

/** The `result` of one GET to the Cloudflare API. Errors carry the HTTP status only, never the body. */
async function apiGet(path, env, fetchImpl, timeoutMs) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!(token && ACCOUNT_ID.test(accountId ?? ""))) {
    throw new ApiError("no token or account id for the API");
  }
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/accounts/${accountId}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ApiError("no answer from the API", { cause: error });
  }
  if (!response.ok) {
    throw new ApiError(`the API answered HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new ApiError("the API did not answer JSON", { cause: error });
  }
  if (body?.success !== true) {
    throw new ApiError("the API answer is not a success");
  }
  return body.result;
}

/** The deployments list of the Cloudflare API, newest first. `fetchImpl` and `env` are injected for the test. */
export async function readApiDeployments(
  worker,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS
) {
  const result = await apiGet(
    `/workers/scripts/${encodeURIComponent(worker)}/deployments`,
    env,
    fetchImpl,
    timeoutMs
  );
  const deployments = result?.deployments;
  if (!Array.isArray(deployments)) {
    throw new ApiError("the API answer has no deployments list");
  }
  if (deployments.length === 0) {
    throw new ApiError("the API lists no deployment");
  }
  return deployments;
}

/** One version of a Worker, whose `annotations` carry the deploy message. The id is a UUID before it reaches the path. */
export async function readApiVersion(
  worker,
  versionId,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS
) {
  if (typeof versionId !== "string" || !UUID.test(versionId)) {
    throw new ApiError("the version id is not a UUID");
  }
  const result = await apiGet(
    `/workers/scripts/${encodeURIComponent(worker)}/versions/${versionId}`,
    env,
    fetchImpl,
    timeoutMs
  );
  if (result === null || typeof result !== "object") {
    throw new ApiError("the API answer has no version");
  }
  return result;
}

/** The API readers of checkWorker. */
export const apiReaders = {
  deployments: (worker) => readApiDeployments(worker),
  version: (worker, id) => readApiVersion(worker, id),
};

/** One read of a Worker: its failure reason (`""` when it carries the commit) and the cleaned stderr of a failed wrangler. */
async function attempt(target, expectedSha, wranglerJson, api) {
  try {
    const reason = await checkWorker(target, expectedSha, wranglerJson, api);
    return { reason: reason ?? "", stderr: "" };
  } catch (error) {
    return {
      reason: `could not read the deployment (${reasonOf(error)})`,
      stderr: error instanceof WranglerError ? error.stderr : "",
    };
  }
}

/**
 * Checks every Worker of `workers` (none stops the others) and returns the failures, one line each. The deployment
 * is read through the API that just accepted it and may not show it yet, so a check that does not pass is tried
 * again after PAUSES_MS (growing) while the Worker is inside RETRY_WINDOW_MS; a Worker that still carries another
 * commit after the window fails with the reason of its last try. `pause(ms)` sleeps and `now()` reads a clock in
 * ms, both injected so a test never waits. `api` is the API readers of checkWorker (none: wrangler only).
 */
export async function verifyDeployedSha(
  expectedSha,
  wranglerJson,
  pause,
  workers = STAGING_WORKERS,
  now = Date.now,
  api = null
) {
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha)) {
    return ["HEAD_SHA is not a full commit SHA (40 lowercase hex characters)"];
  }
  const checkStart = now();
  const seconds = () => Math.floor((now() - checkStart) / 1000);
  const failures = [];
  for (const target of workers) {
    const workerStart = now();
    let reason = "";
    for (let tries = 1; ; tries += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
      const outcome = await attempt(target, expectedSha, wranglerJson, api);
      ({ reason } = outcome);
      console.log(
        `try ${tries}/${ATTEMPTS} ${target.worker}: ${reason === "" ? `active version is ${expectedSha.slice(0, 12)}` : reason} (${seconds()} s since the check started)`
      );
      if (outcome.stderr !== "") {
        console.log(outcome.stderr);
      }
      const remaining = workerStart + RETRY_WINDOW_MS - now();
      if (reason === "" || tries === ATTEMPTS || remaining <= 0) {
        break;
      }
      await pause(Math.min(PAUSES_MS[tries - 1], remaining));
    }
    if (reason === "") {
      console.log(
        `ok ${target.worker}: active version is ${expectedSha.slice(0, 12)}`
      );
    } else {
      const failure = `${target.worker}: ${reason}`;
      console.log(`FAIL ${failure}`);
      failures.push(failure);
    }
  }
  return failures;
}

/**
 * The timeout kills the whole process group: killing only `bunx` would leave wrangler holding the stdout pipe,
 * and `close` would never come.
 */
export function runWrangler(
  app,
  worker,
  args,
  timeoutMs = WRANGLER_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bunx",
      ["--no-install", "wrangler", ...args, "--name", worker],
      {
        cwd: `apps/${app}`,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const killGroup = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    const chunks = [];
    const errChunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    let errBytes = 0;
    child.stderr.on("data", (chunk) => {
      if (errBytes < STDERR_CAPTURE_BYTES) {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on("error", (error) => {
      clearTimeout(killGroup);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killGroup);
      if (code !== 0) {
        reject(
          new WranglerError(
            `wrangler ${signal ? `was stopped (${signal})` : `exited with code ${code}`}`,
            cleanStderr(Buffer.concat(errChunks).toString("utf8"))
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new WranglerError("wrangler did not print JSON"));
      }
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const workers = workersFromArgs(process.argv.slice(2));
  if (workers === null) {
    console.error(
      "usage: verify-deployed-sha.mjs [--env staging|production] (HEAD_SHA in the environment)"
    );
    process.exitCode = 1;
    return;
  }
  const failures = await verifyDeployedSha(
    process.env.HEAD_SHA,
    runWrangler,
    wait,
    workers,
    Date.now,
    apiReaders
  );
  if (failures.length > 0) {
    console.error(`Deployed version check failed (${failures.length}).`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
