import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Which expensive CI jobs a change can affect. The browser gate costs about
 * 25 minutes a run (22 to 27 on the hosted runner), so it only runs when
 * something it exercises changed; the dependency audit only when dependencies
 * changed. Everything unknown runs.
 */

/**
 * Operation scripts that the browser gate never runs, bundles or reads: the
 * staging smoke and isolation checks, the migration compatibility check, the
 * flaky-test report (only the e2e-real job runs it), the real-device runner,
 * and the staging deploy workflow. Listed one by one, never with a wildcard
 * over scripts/: a new script is relevant until someone proves otherwise.
 * ci-changed.test.mjs reads the imports and configs of apps/web (Playwright
 * configs included), apps/catalog and packages/ and fails if any of them
 * reaches one of these files. The workerd-* scripts are not here: the Vitest
 * configs of apps/web and apps/catalog import workerd-harness.mjs.
 */
export const OPERATIONS_FILES = [
  "scripts/smoke-staging.mjs",
  "scripts/smoke-staging.test.mjs",
  "scripts/verify-staging-isolation.mjs",
  "scripts/verify-staging-isolation.test.mjs",
  "scripts/verify-migration-compat.mjs",
  "scripts/verify-migration-compat.test.mjs",
  "scripts/admin-production-guard.test.mjs",
  "scripts/gate5-real-devices.sh",
  "scripts/e2e-flaky-report.mjs",
  "scripts/e2e-flaky-report.test.mjs",
  ".github/workflows/deploy-staging.yml",
];

/**
 * Paths that cannot change what the browser gate proves: prose; the database
 * package; the web app's server, Worker and gate scripts; the Admin app; and
 * the operation scripts above. The gate serves the static client bundle and
 * answers the `/rpc` calls itself (page.route), so none of that code runs in
 * it, and the client never imports it. Nothing under apps/web, apps/catalog or
 * packages/ depends on apps/admin (ci-changed.test.mjs reads the import graph
 * and fails if that changes), so the Admin app is outside both bundles the
 * gate exercises.
 */
const MARKDOWN_FILE = /\.md$/;

const BROWSER_IRRELEVANT = [
  /^docs\//,
  /^doc\//,
  /\.md$/,
  /^packages\/db\//,
  /^apps\/admin\//,
  /^apps\/web\/(src\/server|worker|scripts)\//,
];

/**
 * What the e2e journeys on the real local stack (T-125a, job `e2e-real`) exercise: the whole web app (client,
 * server and Worker), the packages it bundles, the lockfile and runtime versions, and the workflow and scripts of
 * the job. Prose, the Admin app and the public catalog never run in it.
 */
const E2E_RELEVANT = [
  /^apps\/web\//,
  /^packages\//,
  /^bun\.lock$/,
  /^package\.json$/,
  /^\.bun-version$/,
  /^\.node-version$/,
  /^\.github\/workflows\//,
  /^scripts\/(ci-changed|e2e-flaky-report)\.mjs$/,
];

/** Files that can change which dependencies are installed. */
const DEPENDENCY_FILES = [
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^\.bun-version$/,
  /^\.node-version$/,
];

/**
 * `files` is the list of changed paths, or null when it could not be
 * determined (then everything runs).
 */
export function classifyChanges(files) {
  if (files === null) {
    return { browser: true, dependencies: true, e2e: true };
  }
  const changed = files.filter(Boolean);
  return {
    browser: changed.some(
      (file) =>
        !(
          OPERATIONS_FILES.includes(file) ||
          BROWSER_IRRELEVANT.some((pattern) => pattern.test(file))
        )
    ),
    dependencies: changed.some((file) =>
      DEPENDENCY_FILES.some((pattern) => pattern.test(file))
    ),
    e2e: changed.some(
      (file) =>
        !MARKDOWN_FILE.test(file) &&
        E2E_RELEVANT.some((pattern) => pattern.test(file))
    ),
  };
}

/** The paths changed by the commit under test against its first parent (the base of a pull request merge). */
function changedFiles() {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
    {
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split("\n");
}

function main() {
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const result = manual
    ? { browser: true, dependencies: true, e2e: true }
    : classifyChanges(changedFiles());
  const lines = Object.entries(result).map(
    ([name, value]) => `${name}=${value}`
  );
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
