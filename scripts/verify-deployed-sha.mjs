import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The deploy passes `--message "$HEAD_SHA"`, and that message is what this reads back from each active version.
 * It runs in the job that holds the deploy token, so it only reads (two fixed wrangler subcommands, the Worker
 * name written here and never taken from input) and never prints what the API answers: the stderr of wrangler is discarded too, as the log is public and
 * the runner acts on workflow commands written there.
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
// pauses before the 2nd, 3rd... try of one Worker: the control plane showed the new version 24 to 47 s late
export const PAUSES_MS = [5000, 10_000, 15_000, 30_000];
export const ATTEMPTS = PAUSES_MS.length + 1;
// no new try starts after this long since the first of the Worker, so the pauses never add up to more
export const RETRY_WINDOW_MS = PAUSES_MS.reduce((sum, ms) => sum + ms, 0);
// `deployments status` and `versions view`: the two reads of checkWorker
export const WRANGLER_CALLS_PER_TRY = 2;

/**
 * Longest the whole check can take. The last try of a Worker starts inside RETRY_WINDOW_MS and may hit
 * WRANGLER_TIMEOUT_MS on both of its calls, so one Worker takes at most the window plus that try.
 * `workers` is the list checked (or how many).
 */
export function worstCaseMs(workers = STAGING_WORKERS) {
  const count = Array.isArray(workers) ? workers.length : workers;
  return (
    count * (RETRY_WINDOW_MS + WRANGLER_CALLS_PER_TRY * WRANGLER_TIMEOUT_MS)
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

/**
 * `null` when the active version carries `expectedSha`, otherwise the reason. `wranglerJson(app, worker, args)`
 * returns the parsed JSON of a wrangler subcommand.
 */
export async function checkWorker({ app, worker }, expectedSha, wranglerJson) {
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
  if (version?.id !== id) {
    return "the version read back is not the active one";
  }
  const message = version.annotations?.["workers/message"];
  if (message === expectedSha) {
    return null;
  }
  return `the active version carries ${describeMessage(message)}, expected the commit ${expectedSha.slice(0, 12)}`;
}

class WranglerError extends Error {}

/** Other errors may carry what the API said, so only their class is printed. */
function reasonOf(error) {
  if (error instanceof WranglerError) {
    return error.message;
  }
  return error instanceof Error ? error.name : "error";
}

/**
 * Checks every Worker of `workers` (none stops the others) and returns the failures, one line each. The deployment
 * is read through the API that just accepted it and may not show it yet, so a check that does not pass is tried
 * again after PAUSES_MS (growing) while the Worker is inside RETRY_WINDOW_MS; a Worker that still carries another
 * commit after the window fails with the reason of its last try. `pause(ms)` sleeps and `now()` reads a clock in
 * ms, both injected so a test never waits.
 */
export async function verifyDeployedSha(
  expectedSha,
  wranglerJson,
  pause,
  workers = STAGING_WORKERS,
  now = Date.now
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
      try {
        // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
        reason = (await checkWorker(target, expectedSha, wranglerJson)) ?? "";
      } catch (error) {
        reason = `could not read the deployment (${reasonOf(error)})`;
      }
      console.log(
        `try ${tries}/${ATTEMPTS} ${target.worker}: ${reason === "" ? `active version is ${expectedSha.slice(0, 12)}` : reason} (${seconds()} s since start)`
      );
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
        stdio: ["ignore", "pipe", "ignore"],
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
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(killGroup);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killGroup);
      if (code !== 0) {
        reject(
          new WranglerError(
            `wrangler ${signal ? `was stopped (${signal})` : `exited with code ${code}`}`
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
    workers
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
