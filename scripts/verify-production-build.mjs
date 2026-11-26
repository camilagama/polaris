import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bindingsSnapshot,
  parseJsonc,
  readBuilt,
  stringsOf,
  WORKERS,
} from "./lib/wrangler-config.mjs";
import { findIsolationProblems } from "./verify-staging-isolation.mjs";

/**
 * What the production deploy publishes (ADR 0097), checked before any database or Cloudflare step: it fails
 * closed while `env.production` still carries the placeholders of the go-live, so the deploy cannot run until
 * the responsible fills in the real account and resources. It fails when:
 * - the static isolation check of the three `wrangler.jsonc` fails (it covers production reaching a host of
 *   staging, the billing hosts of production, flags that stay off and shared resources);
 * - the web or the catalog has no build for production (`CLOUDFLARE_ENV=production`), or the generated
 *   `wrangler.json` targets another environment, has another name, other bindings or other vars than
 *   `env.production` (so a host the static check refused in the source cannot come back through the build);
 * - what is published (the generated config of the web and the catalog, `env.production` of the Admin, which
 *   `wrangler deploy --env production` reads from its source) still has a PLACEHOLDER anywhere, an account or a
 *   Hyperdrive id that is not a Cloudflare id, a name, bucket or queue of staging or local, POLARIS_ENVIRONMENT
 *   other than "production", workers_dev or previews on;
 * - the three Workers are not in the same account, or not in the one of `CLOUDFLARE_ACCOUNT_ID` when it is set.
 * Nothing is printed but names, paths and the problem.
 */

const PLACEHOLDER = /PLACEHOLDER/i;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const OTHER_ENVIRONMENT = /-(local|staging)$/;

function checkPublished(where, block, problems) {
  for (const [path, value] of stringsOf(block)) {
    if (PLACEHOLDER.test(value)) {
      problems.push(`${where}: ${path} is still a placeholder`);
    }
  }
  const account = block.account_id ?? "";
  if (!(CLOUDFLARE_ID.test(account) || PLACEHOLDER.test(account))) {
    problems.push(`${where}: account_id is not a Cloudflare account id`);
  }
  const name = block.name ?? "";
  if (name === "" || OTHER_ENVIRONMENT.test(name)) {
    problems.push(`${where}: name must be the production one`);
  }
  if (block.vars?.POLARIS_ENVIRONMENT !== "production") {
    problems.push(`${where}: vars.POLARIS_ENVIRONMENT must be "production"`);
  }
  if (block.workers_dev !== false || block.preview_urls !== false) {
    problems.push(`${where}: workers_dev and preview_urls must be false`);
  }
  checkResources(where, block, problems);
}

function checkResources(where, block, problems) {
  for (const item of block.hyperdrive ?? []) {
    if (!(CLOUDFLARE_ID.test(item.id ?? "") || PLACEHOLDER.test(item.id))) {
      problems.push(
        `${where}: Hyperdrive ${item.binding} is not a Cloudflare id`
      );
    }
  }
  const snapshot = bindingsSnapshot(block);
  for (const [binding, resource] of [
    ...snapshot.buckets,
    ...snapshot.producers,
    ...snapshot.consumers.map((queue) => ["consumer", queue]),
  ]) {
    if (OTHER_ENVIRONMENT.test(resource)) {
      problems.push(
        `${where}: ${binding} uses ${resource}, a resource of another environment`
      );
    }
  }
}

function checkBuilt(app, production, built, problems) {
  const where = `${app}: built wrangler.json`;
  if (built === null || built === undefined) {
    problems.push(
      `${app}: no production build found (run the build with CLOUDFLARE_ENV=production first)`
    );
    return null;
  }
  if (built.targetEnvironment !== "production") {
    problems.push(`${where} does not target production`);
  }
  if (built.name !== production.name) {
    problems.push(`${where} has another name than env.production`);
  }
  if (
    JSON.stringify(bindingsSnapshot(built)) !==
    JSON.stringify(bindingsSnapshot(production))
  ) {
    problems.push(`${where} bindings differ from env.production`);
  }
  const sortedVars = (config) =>
    JSON.stringify(Object.entries(config.vars ?? {}).sort());
  if (sortedVars(built) !== sortedVars(production)) {
    problems.push(`${where} vars differ from env.production`);
  }
  return built;
}

/**
 * `entries`: one `{ app, config, built }` per Worker, `config` the parsed `wrangler.jsonc` and `built` the generated
 * `wrangler.json` (null when absent; ignored for the Admin). `expectedAccount` is `CLOUDFLARE_ACCOUNT_ID` or empty.
 */
export function findProductionBuildProblems(entries, expectedAccount = "") {
  const problems = findIsolationProblems(
    entries.map(({ app, config }) => ({ app, config }))
  );
  const accounts = new Set();
  for (const { app, built, config } of entries) {
    const production = config.env?.production;
    if (!production) {
      problems.push(`${app}: env.production is missing`);
      continue;
    }
    const published =
      app === "admin"
        ? production
        : checkBuilt(app, production, built, problems);
    if (published === null) {
      continue;
    }
    checkPublished(
      app === "admin"
        ? `${app}: env.production`
        : `${app}: built wrangler.json`,
      published,
      problems
    );
    accounts.add(published.account_id);
  }
  if (accounts.size > 1) {
    problems.push("the production Workers are not all in the same account");
  }
  if (
    expectedAccount !== "" &&
    [...accounts].some((account) => account !== expectedAccount)
  ) {
    problems.push(
      "the account of the production Workers is not CLOUDFLARE_ACCOUNT_ID"
    );
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = WORKERS.map((app) => {
    const appDir = resolve(root, "apps", app);
    return {
      app,
      built: app === "admin" ? undefined : readBuilt(appDir),
      config: parseJsonc(
        readFileSync(resolve(appDir, "wrangler.jsonc"), "utf8")
      ),
    };
  });
  const problems = findProductionBuildProblems(
    entries,
    (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()
  );
  if (problems.length > 0) {
    console.error(`Production build check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Production build check passed.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
