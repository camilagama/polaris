import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gitEnvironment } from "./exact-count-list.mjs";

/**
 * Which expensive CI jobs a change can affect. The browser gate costs about
 * 25 minutes a run (22 to 27 on the hosted runner), so it only runs when
 * something it exercises changed; the dependency audit only when dependencies
 * changed. Everything unknown runs.
 */

/**
 * Operation scripts that the browser gate never runs, bundles or reads: the
 * staging smoke and isolation checks, the production build, workflow and
 * deployed-SHA verifiers, the backup workflow verifier and the two age
 * recipients files it checks (ops/backup/recipients-production.txt and
 * ops/backup/recipients-staging.txt), the neutral wrangler module
 * (scripts/lib/wrangler-config.mjs) that the scripts listed here import
 * (ci-changed.test.mjs fails if an importer is missing here), the migration
 * compatibility check, the ADR number check, the flaky-test report (only the
 * e2e-real job runs it), the real-device runner, and the staging deploy workflow. Listed one by one,
 * never with a wildcard over scripts/ or ops/: a new file is relevant until
 * someone proves otherwise.
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
  "scripts/verify-no-lab-in-build.mjs",
  "scripts/verify-no-lab-in-build.test.mjs",
  "scripts/verify-no-map-published.mjs",
  "scripts/verify-no-map-published.test.mjs",
  "scripts/verify-migration-compat.mjs",
  "scripts/verify-migration-compat.test.mjs",
  "scripts/verify-adr-numbers.test.mjs",
  "scripts/admin-production-guard.test.mjs",
  "scripts/verify-production-build.mjs",
  "scripts/verify-production-build.test.mjs",
  "scripts/verify-production-workflow.mjs",
  "scripts/verify-production-workflow.test.mjs",
  "scripts/verify-deployed-sha.mjs",
  "scripts/verify-deployed-sha.test.mjs",
  "scripts/verify-backup-workflow.mjs",
  "scripts/verify-backup-workflow.test.mjs",
  "ops/backup/recipients-production.txt",
  "ops/backup/recipients-staging.txt",
  "scripts/lib/wrangler-config.mjs",
  "scripts/lib/wrangler-config.test.mjs",
  "scripts/gate5-real-devices.sh",
  "scripts/e2e-flaky-report.mjs",
  "scripts/e2e-flaky-report.test.mjs",
  "scripts/check-protegidos.ts",
  "scripts/check-protegidos.test.mjs",
  "tests/protegidos.txt",
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

/**
 * Files that can change which dependencies are installed, or the audit that checks them (the `--ignore` list lives
 * in ci.yml: a change to it must run the audit, or the exceptions never get exercised).
 */
const DEPENDENCY_FILES = [
  /^\.github\/workflows\/ci\.yml$/,
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^\.bun-version$/,
  /^\.node-version$/,
];

/**
 * Paths that cannot change what the PostgreSQL gates (`packages/db`, `gates:ci`) prove: prose, and the web app's
 * client code that nothing the job runs reaches. The gate scripts, the Worker and the server import some client
 * modules (`home/home-inventory.ts`, `offline/`, `lib/` helpers, the catalog thumbnail modules and
 * `pwa/update-model.ts`), so those stay out of the list; ci-changed.test.mjs reads the import graph from all of
 * them and fails if one reaches a file listed here.
 * Everything else (the database package, the domain, any `apps/*` server, `apps/web/worker`, the manifests and
 * lockfile, `.github/**` including its prose, `scripts/`) is not listed on purpose: a path that is not here runs
 * the gates.
 */
export const DATABASE_IRRELEVANT = [
  /^docs\//,
  /^doc\//,
  /^(?!\.github\/).*\.md$/,
  /^apps\/web\/src\/(?!(?:server|offline|lib)\/|home\/home-inventory\.ts$|catalog\/thumbnail-|pwa\/update-model\.ts$)/,
];

/**
 * `files` is the list of changed paths, or null when it could not be
 * determined (then everything runs).
 */
export function classifyChanges(files) {
  if (files === null) {
    return { browser: true, dependencies: true, e2e: true, database: true };
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
    database: changed.some(
      (file) => !DATABASE_IRRELEVANT.some((pattern) => pattern.test(file))
    ),
  };
}

/**
 * What the sentinel of reloads with the worker in control (`apps/web/e2e-pwa/recarga-com-worker.e2e.ts`, 300 reloads,
 * more than 3 minutes) can catch: the worker, what builds and registers it, the scripts of the page it serves first
 * (`index.html`, the boot-retry, `theme-init.js`), and the spec itself. The configs that mount the chunks and the
 * precache the worker serves are in too: `vite.pwa.config.ts` builds what the sentinel runs, `vite.config.ts` is the
 * production build it must stay equal to, and `vite.ui.ts` is shared by both. The browser gate runs it only then
 * (`POLARIS_RECARGA_COM_WORKER`); `null` (the paths unknown) runs it.
 */
const RELOAD_SENTINEL_FILES = [
  /^apps\/web\/src\/pwa\//,
  /^apps\/web\/pwa\//,
  /^apps\/web\/index\.html$/,
  /^apps\/web\/vite\.(config|pwa\.config|ui)\.ts$/,
  /^apps\/web\/public\/(boot-retry|theme-init)\.js$/,
  /^apps\/web\/e2e-pwa\/recarga-com-worker\.e2e\.ts$/,
];

export function reloadSentinelRuns(files) {
  return (
    files === null ||
    files.some((file) =>
      RELOAD_SENTINEL_FILES.some((pattern) => pattern.test(file))
    )
  );
}

/** The paths changed by the commit under test against its first parent (the base of a pull request merge). */
function changedFiles() {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
    {
      encoding: "utf8",
      env: gitEnvironment(),
    }
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split("\n");
}

/**
 * A run that must not skip anything: every manual dispatch (a branch has no base commit to compare with, so the
 * last commit alone would say nothing about the others) and a pull request that carries the `suite-completa` label
 * (the workflow passes `CI_FULL=true`).
 */
export function fullSuiteRequested(env) {
  return (
    env.CI_FULL === "true" || env.GITHUB_EVENT_NAME === "workflow_dispatch"
  );
}

function main() {
  const files = fullSuiteRequested(process.env) ? null : changedFiles();
  const result = {
    ...classifyChanges(files),
    reloads: reloadSentinelRuns(files),
  };
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
