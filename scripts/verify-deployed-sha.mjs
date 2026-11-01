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
];

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTEMPTS = 3;
const WRANGLER_TIMEOUT_MS = 60_000;

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
 * Checks every staging Worker (none stops the others) and returns the failures, one line each. Each check is
 * tried up to ATTEMPTS times: the deployment is read through the API that just accepted it and may not show it yet.
 */
export async function verifyDeployedSha(expectedSha, wranglerJson, pause) {
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha)) {
    return ["HEAD_SHA is not a full commit SHA (40 lowercase hex characters)"];
  }
  const failures = [];
  for (const target of STAGING_WORKERS) {
    let reason = "";
    for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: the attempts are sequential by design
        reason = (await checkWorker(target, expectedSha, wranglerJson)) ?? "";
      } catch (error) {
        reason = `could not read the deployment (${reasonOf(error)})`;
      }
      if (reason === "" || tries === ATTEMPTS) {
        break;
      }
      await pause();
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

const wait = () => new Promise((resolve) => setTimeout(resolve, 5000));

async function main() {
  const failures = await verifyDeployedSha(
    process.env.HEAD_SHA,
    runWrangler,
    wait
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
