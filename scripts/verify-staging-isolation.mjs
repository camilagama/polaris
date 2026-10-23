import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Isolation of the fixed staging (ADR 0097). Reads the three `wrangler.jsonc` and, with `--built`,
 * the `wrangler.json` the staging build generated (what `wrangler deploy` actually publishes), and
 * fails when:
 * - the top level is not local-only (it must never deploy anything);
 * - `env.staging` or `env.production` is missing, or a binding of the top level is missing in them;
 * - a staging value is still a PLACEHOLDER, or a staging id, queue, bucket or rate limit namespace is
 *   shared with production or the top level, or does not say `staging`;
 * - two staging roles share a Hyperdrive configuration (the billing role of the Admin is the one exception);
 * - the deployed name does not end in `-staging`, previews are on, or password sign-in is on with a sender or reply-to outside araute.app;
 * - the web of staging is not at exactly https://dash.araute.app with workers_dev off, or production uses a host of staging;
 * - the Admin is reachable in staging (it is not exposed: no workers.dev, no route, no Access, no database).
 * With `--remote`, it also reads each staging Hyperdrive configuration (`wrangler hyperdrive get`, with
 * the staging token) and checks host, user and caching. Nothing is printed but names and ids.
 */

export const WORKERS = ["web", "catalog", "admin"];

const PLACEHOLDER = /PLACEHOLDER/i;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const LOCAL_SUFFIX = /-local$/;
const STAGING_SUFFIX = /-staging$/;
// exact names: the queue consumer and the dead-letter handler recognize `polaris-<lane>-<environment>`
const STAGING_BUCKET = /^polaris-media-staging$/;
const STAGING_QUEUE = /^polaris-(critical|default|media|dlq)-staging$/;
const ENVIRONMENT_SUFFIX = /-(local|staging)$/;
const POOLER = /pooler/i;
const LOCAL_QUEUE = /^polaris-(critical|default|media|dlq)-local$/;
// The web of staging is served at this host by a Custom Domain created outside the config (ADR 0097):
// an exact string, so another subdomain, http, a path or userinfo never matches. The catalog stays on workers.dev.
export const STAGING_WEB_ORIGIN = "https://dash.araute.app";
const TRAILING_DOTS = /\.+$/;
const STAGING_CATALOG_ORIGIN =
  /^https:\/\/polaris-catalog-staging\.[a-z0-9-]+\.workers\.dev$/;
const STAGING_URLS = {
  BETTER_AUTH_BASE_URL: {
    accepts: (value) => value === STAGING_WEB_ORIGIN,
    says: `exactly ${STAGING_WEB_ORIGIN}`,
  },
  CATALOG_ORIGIN: {
    accepts: (value) => STAGING_CATALOG_ORIGIN.test(value),
    says: "the workers.dev URL of the staging catalog Worker",
  },
};
// binding kinds staging does not use: any of them in env.staging (or in the build) could reach another resource
const UNUSED_BINDING_KINDS = [
  "ai",
  "analytics_engine_datasets",
  "browser",
  "d1_databases",
  "dispatch_namespaces",
  "durable_objects",
  "kv_namespaces",
  "mtls_certificates",
  "pipelines",
  "secrets_store_secrets",
  "send_email",
  "services",
  "tail_consumers",
  "vectorize",
  "vpc_services",
  "worker_loaders",
  "workflows",
];
// a role whose configuration is shared on purpose: the Admin's billing commands log in as the billing role (ADR 0073)
const SHARED_HYPERDRIVE = new Set([
  "BILLING_HYPERDRIVE",
  "ADMIN_BILLING_HYPERDRIVE",
]);
const OWNER_USER = /_owner$/;

/**
 * Calls `visit(char, index)` for every character outside a string literal and copies string literals
 * as they are; `visit` returns how many characters it consumed and what to write.
 */
function scanOutsideStrings(text, visit) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      out += text.slice(start, index);
    } else {
      const { length, write } = visit(text[index], index);
      out += write;
      index += length;
    }
  }
  return out;
}

const NEXT_NON_SPACE = /\S/g;

/** JSON with comments and trailing commas (the wrangler.jsonc format), without touching strings. */
export function parseJsonc(text) {
  const withoutComments = scanOutsideStrings(text, (char, index) => {
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      return { length: (end === -1 ? text.length : end) - index, write: "" };
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        throw new Error("unterminated comment");
      }
      return { length: end + 2 - index, write: "" };
    }
    return { length: 1, write: char };
  });
  const withoutTrailingCommas = scanOutsideStrings(
    withoutComments,
    (char, index) => {
      if (char !== ",") {
        return { length: 1, write: char };
      }
      NEXT_NON_SPACE.lastIndex = index + 1;
      const next = NEXT_NON_SPACE.exec(withoutComments)?.[0];
      return { length: 1, write: next === "}" || next === "]" ? "" : char };
    }
  );
  return JSON.parse(withoutTrailingCommas);
}

/** The resources a config binds, by binding name. */
export function bindingsOf(config) {
  const hyperdrive = new Map(
    (config.hyperdrive ?? []).map((item) => [item.binding, item.id])
  );
  const buckets = new Map(
    (config.r2_buckets ?? []).map((item) => [item.binding, item.bucket_name])
  );
  const producers = new Map(
    (config.queues?.producers ?? []).map((item) => [item.binding, item.queue])
  );
  const consumers = (config.queues?.consumers ?? []).flatMap((item) =>
    [item.queue, item.dead_letter_queue].filter(Boolean)
  );
  const ratelimits = new Map(
    (config.ratelimits ?? []).map((item) => [
      item.name,
      String(item.namespace_id),
    ])
  );
  const images = config.images?.binding ? [config.images.binding] : [];
  // the lane, without the environment suffix: polaris-critical-staging and polaris-critical are the same consumer
  const consumerLanes = (config.queues?.consumers ?? []).map((item) =>
    item.queue.replace(ENVIRONMENT_SUFFIX, "")
  );
  return {
    buckets,
    consumerLanes,
    consumers,
    hyperdrive,
    images,
    producers,
    ratelimits,
  };
}

function bindingNames(config) {
  const b = bindingsOf(config);
  return [
    ...[...b.hyperdrive.keys()].map((name) => `hyperdrive:${name}`),
    ...[...b.buckets.keys()].map((name) => `r2:${name}`),
    ...[...b.producers.keys()].map((name) => `queue:${name}`),
    ...[...b.ratelimits.keys()].map((name) => `ratelimit:${name}`),
    ...b.images.map((name) => `images:${name}`),
    ...b.consumerLanes.map((lane) => `consumer:${lane}`),
  ];
}

function stringsOf(value, path = "") {
  if (typeof value === "string") {
    return [[path, value]];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringsOf(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      stringsOf(item, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

function checkTopLevel(app, config, problems) {
  const where = `${app}: top level`;
  if (!LOCAL_SUFFIX.test(config.name ?? "")) {
    problems.push(
      `${where}: name "${config.name}" must end in -local (the top level is never deployed)`
    );
  }
  if (config.workers_dev !== false) {
    problems.push(`${where}: workers_dev must be false`);
  }
  if (config.account_id !== undefined) {
    problems.push(
      `${where}: account_id belongs to an environment, not to the top level`
    );
  }
  if ((config.routes ?? []).length > 0 || config.route !== undefined) {
    problems.push(
      `${where}: routes belong to an environment, not to the top level`
    );
  }
  const b = bindingsOf(config);
  for (const [binding, id] of b.hyperdrive) {
    if (id !== "local-only") {
      problems.push(`${where}: Hyperdrive ${binding} must be local-only`);
    }
  }
  for (const [binding, bucket] of b.buckets) {
    if (!LOCAL_SUFFIX.test(bucket)) {
      problems.push(`${where}: bucket of ${binding} must end in -local`);
    }
  }
  for (const queue of [...b.producers.values(), ...b.consumers]) {
    if (!LOCAL_QUEUE.test(queue)) {
      problems.push(`${where}: queue ${queue} must be a -local queue`);
    }
  }
}

function checkParity(
  app,
  top,
  environment,
  envName,
  problems,
  { allowMissing = [] } = {}
) {
  const present = new Set(bindingNames(environment));
  for (const name of bindingNames(top)) {
    if (!(present.has(name) || allowMissing.includes(name))) {
      problems.push(
        `${app}: env.${envName} lacks ${name} (bindings are not inherited)`
      );
    }
  }
}

/** The checks that hold for the staging block in the source and for the built wrangler.json alike. */
function checkStagingBlock(app, where, staging, problems) {
  if (!STAGING_SUFFIX.test(staging.name ?? "")) {
    problems.push(
      `${where}: name "${staging.name}" must end in -staging, or the deploy would publish another Worker`
    );
  }
  if (
    !(
      CLOUDFLARE_ID.test(staging.account_id ?? "") ||
      PLACEHOLDER.test(staging.account_id ?? "")
    )
  ) {
    problems.push(
      `${where}: account_id must be the 32-hex id of the staging account`
    );
  }
  if (staging.preview_urls !== false) {
    problems.push(
      `${where}: preview_urls must be false (no Cloudflare Previews)`
    );
  }
  if (staging.vars?.POLARIS_ENVIRONMENT !== "staging") {
    problems.push(`${where}: vars.POLARIS_ENVIRONMENT must be "staging"`);
  }
  for (const [path, value] of stringsOf(staging)) {
    if (PLACEHOLDER.test(value)) {
      problems.push(`${where}: ${path} is still a placeholder`);
    }
  }
  checkStagingResources(where, staging, problems);
  if (app === "web") {
    checkStagingPasswordSender(where, staging, problems);
    checkStagingAbuseProtection(where, staging, problems);
  }
  if (app === "web" && staging.workers_dev !== false) {
    problems.push(
      `${where}: workers_dev must be false (the origin check accepts only ${STAGING_WEB_ORIGIN})`
    );
  }
  if (app === "admin") {
    checkAdminNotExposed(where, staging, problems);
  }
}

// Password sign-in is on in staging by decision of the user (22/10, ADR 0100), open to anyone because the
// data is synthetic. It may only send e-mail from the staging domain: a sender of another domain would
// send from a verified domain of production or of a third party. Name and address, or the bare address.
const STAGING_SENDER =
  /^(?:[^<>@\r\n]*<[A-Za-z0-9._+-]+@araute\.app>|[A-Za-z0-9._+-]+@araute\.app)$/i;

function checkStagingPasswordSender(where, staging, problems) {
  const enabled = staging.vars?.EMAIL_PASSWORD_AUTH_ENABLED;
  if (enabled === "false") {
    return;
  }
  if (enabled !== "true") {
    problems.push(
      `${where}: vars.EMAIL_PASSWORD_AUTH_ENABLED must be "true" or "false"`
    );
    return;
  }
  if (!STAGING_SENDER.test((staging.vars?.AUTH_EMAIL_FROM ?? "").trim())) {
    problems.push(
      `${where}: password sign-in in staging needs vars.AUTH_EMAIL_FROM on @araute.app`
    );
  }
  // The reply-to is optional, but when it is there the answer of a person goes to a mailbox of the staging
  // domain, with the same rules as the sender.
  const replyTo = (staging.vars?.AUTH_EMAIL_REPLY_TO ?? "").trim();
  if (replyTo !== "" && !STAGING_SENDER.test(replyTo)) {
    problems.push(
      `${where}: password sign-in in staging needs vars.AUTH_EMAIL_REPLY_TO absent, empty or on @araute.app`
    );
  }
}

// The protection against abuse of the password routes (ADR 0100): on, it needs the public key of the Turnstile
// widget; without it the page offers no form while the flag says the protection is ready. The limiters are
// bindings, so the check of the bindings that are not inherited already covers them. The secret is a Worker
// secret and no test can see it.
function checkStagingAbuseProtection(where, staging, problems) {
  const enabled = staging.vars?.AUTH_ABUSE_PROTECTION_ENABLED;
  if (enabled !== "true" && enabled !== "false") {
    problems.push(
      `${where}: vars.AUTH_ABUSE_PROTECTION_ENABLED must be "true" or "false"`
    );
    return;
  }
  const siteKey = (staging.vars?.TURNSTILE_SITE_KEY ?? "").trim();
  if (enabled === "true" && siteKey === "") {
    problems.push(
      `${where}: vars.AUTH_ABUSE_PROTECTION_ENABLED "true" needs vars.TURNSTILE_SITE_KEY (the public key of the staging widget)`
    );
  }
}

function checkStagingResources(where, staging, problems) {
  const b = bindingsOf(staging);
  for (const [binding, id] of b.hyperdrive) {
    if (!(CLOUDFLARE_ID.test(id) || PLACEHOLDER.test(id))) {
      problems.push(
        `${where}: Hyperdrive ${binding} must be a real 32-hex configuration id`
      );
    }
  }
  for (const [binding, bucket] of b.buckets) {
    if (!STAGING_BUCKET.test(bucket)) {
      problems.push(
        `${where}: bucket of ${binding} must be polaris-media-staging`
      );
    }
  }
  for (const queue of [...b.producers.values(), ...b.consumers]) {
    if (!STAGING_QUEUE.test(queue)) {
      problems.push(`${where}: queue ${queue} must be polaris-<lane>-staging`);
    }
  }
  for (const kind of UNUSED_BINDING_KINDS) {
    if (!isEmptyBinding(staging[kind])) {
      problems.push(`${where}: ${kind} is not used by staging`);
    }
  }
  if ((staging.routes ?? []).length > 0 || staging.route !== undefined) {
    problems.push(
      `${where}: staging has no routes (the web Custom Domain is managed outside the config)`
    );
  }
  for (const [name, rule] of Object.entries(STAGING_URLS)) {
    const value = staging.vars?.[name];
    if (
      value !== undefined &&
      !PLACEHOLDER.test(value) &&
      !rule.accepts(value)
    ) {
      problems.push(`${where}: vars.${name} must be ${rule.says}`);
    }
  }
}

function isEmptyBinding(value) {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    // the generated wrangler.json writes `{ bindings: [] }` for some kinds
    return keys.every(
      (key) => key === "bindings" && (value.bindings ?? []).length === 0
    );
  }
  return false;
}

/** Not exposed: no public hostname, no Access (every API request is refused) and no database. */
function checkAdminNotExposed(where, staging, problems) {
  if (staging.workers_dev !== false) {
    problems.push(
      `${where}: the Admin is not exposed in staging (workers_dev must be false)`
    );
  }
  if (staging.vars?.ACCESS_TEAM_DOMAIN || staging.vars?.ACCESS_AUDIENCE) {
    problems.push(`${where}: the Admin has no Access application in staging`);
  }
  if ((staging.hyperdrive ?? []).length > 0) {
    problems.push(`${where}: the Admin has no database binding in staging`);
  }
}

/** Values that must never repeat between two environments of the same Worker set. */
function resources(config) {
  const b = bindingsOf(config);
  return {
    accounts: config.account_id ? [config.account_id] : [],
    buckets: [...b.buckets.values()],
    hyperdrive: [...b.hyperdrive.values()].filter((id) => id !== "local-only"),
    namespaces: [...b.ratelimits.values()],
    queues: [...new Set([...b.producers.values(), ...b.consumers])],
  };
}

function checkCrossEnvironment(entries, problems) {
  const staging = entries.map(({ app, config }) => ({
    app,
    values: resources(config.env?.staging ?? {}),
  }));
  const others = entries.flatMap(({ app, config }) => [
    { app, label: "top level", values: resources(config) },
    {
      app,
      label: "env.production",
      values: resources(config.env?.production ?? {}),
    },
  ]);
  for (const kind of [
    "hyperdrive",
    "buckets",
    "queues",
    "namespaces",
    "accounts",
  ]) {
    for (const { app, values } of staging) {
      for (const value of values[kind]) {
        const clash = others.find((other) =>
          other.values[kind].includes(value)
        );
        if (clash) {
          problems.push(
            `${app}: env.staging ${kind} "${value}" is also used by ${clash.app} ${clash.label}`
          );
        }
      }
    }
  }
  // one configuration per role: two staging bindings never share a Hyperdrive id, except the billing pair
  const owners = new Map();
  for (const { app, config } of entries) {
    for (const [binding, id] of bindingsOf(config.env?.staging ?? {})
      .hyperdrive) {
      const previous = owners.get(id);
      if (
        previous &&
        !(
          SHARED_HYPERDRIVE.has(previous.binding) &&
          SHARED_HYPERDRIVE.has(binding)
        )
      ) {
        problems.push(
          `${app}: env.staging Hyperdrive ${binding} shares its id with ${previous.app} ${previous.binding}`
        );
      }
      owners.set(id, previous ?? { app, binding });
    }
  }
}

/**
 * `entries`: one `{ app, config, built }` per Worker, `config` the parsed wrangler.jsonc and `built`
 * the parsed wrangler.json of the staging build (or undefined when not checked). Returns the problems.
 */
export function findIsolationProblems(entries) {
  const problems = [];
  for (const { app, config, built } of entries) {
    checkTopLevel(app, config, problems);
    const staging = config.env?.staging;
    const production = config.env?.production;
    if (!(staging && production)) {
      problems.push(
        `${app}: env.staging and env.production must both be declared`
      );
      continue;
    }
    checkProductionBlock(app, production, staging, problems);
    checkParity(app, config, staging, "staging", problems, {
      // the Admin is not exposed in staging: it keeps no database binding
      allowMissing:
        app === "admin"
          ? bindingNames(config).filter((name) =>
              name.startsWith("hyperdrive:")
            )
          : [],
    });
    checkParity(app, config, production, "production", problems);
    checkStagingBlock(app, `${app}: env.staging`, staging, problems);
    if (built !== undefined) {
      checkBuilt(app, staging, built, problems);
    }
  }
  checkCrossEnvironment(entries, problems);
  return problems;
}

/** The lowercase host of a URL without a trailing dot (a name that resolves the same), or undefined when the value is not a URL. */
function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(TRAILING_DOTS, "");
  } catch {
    // not a URL: no host
  }
}

function checkProductionBlock(app, production, staging, problems) {
  const name = production.name ?? "";
  if (!name || STAGING_SUFFIX.test(name) || LOCAL_SUFFIX.test(name)) {
    problems.push(
      `${app}: env.production needs its own name, without -staging or -local`
    );
  }
  if (production.vars?.POLARIS_ENVIRONMENT !== "production") {
    problems.push(
      `${app}: env.production vars.POLARIS_ENVIRONMENT must be "production"`
    );
  }
  for (const variable of Object.keys(staging.vars ?? {})) {
    if (production.vars?.[variable] === undefined) {
      problems.push(
        `${app}: env.production lacks vars.${variable}, which env.staging sets`
      );
    }
  }
  for (const variable of Object.keys(STAGING_URLS)) {
    const host = hostOf(production.vars?.[variable]);
    if (
      host !== undefined &&
      (host === hostOf(staging.vars?.[variable]) ||
        (variable === "BETTER_AUTH_BASE_URL" &&
          host === hostOf(STAGING_WEB_ORIGIN)))
    ) {
      problems.push(
        `${app}: env.production vars.${variable} must not use the host of staging`
      );
    }
  }
  const stagingSiteKey = (staging.vars?.TURNSTILE_SITE_KEY ?? "").trim();
  if (
    stagingSiteKey !== "" &&
    (production.vars?.TURNSTILE_SITE_KEY ?? "").trim() === stagingSiteKey
  ) {
    problems.push(
      `${app}: env.production vars.TURNSTILE_SITE_KEY must not be the widget key of staging`
    );
  }
  if (production.workers_dev !== false) {
    problems.push(`${app}: env.production workers_dev must be false`);
  }
  if (production.preview_urls !== false) {
    problems.push(`${app}: env.production preview_urls must be false`);
  }
}

/** The wrangler.json the staging build generated: the file the deploy follows. */
function checkBuilt(app, staging, built, problems) {
  if (built === null) {
    problems.push(
      `${app}: no staging build found (run the build with CLOUDFLARE_ENV=staging first)`
    );
    return;
  }
  checkStagingBlock(app, `${app}: built wrangler.json`, built, problems);
  if (
    built.targetEnvironment !== undefined &&
    built.targetEnvironment !== "staging"
  ) {
    problems.push(
      `${app}: built wrangler.json targets "${built.targetEnvironment}", not staging`
    );
  }
  const expected = JSON.stringify(bindingsSnapshot(staging));
  if (JSON.stringify(bindingsSnapshot(built)) !== expected) {
    problems.push(
      `${app}: built wrangler.json bindings differ from env.staging`
    );
  }
}

function bindingsSnapshot(config) {
  const b = bindingsOf(config);
  return {
    account: config.account_id,
    buckets: [...b.buckets].sort(),
    consumers: [...b.consumers].sort(),
    hyperdrive: [...b.hyperdrive].sort(),
    producers: [...b.producers].sort(),
    ratelimits: [...b.ratelimits].sort(),
  };
}

/**
 * One staging Hyperdrive configuration as `wrangler hyperdrive get` shows it. The staging database host
 * comes from STAGING_DATABASE_HOST (not a secret); the password never appears in that output.
 */
export function findHyperdriveProblems(binding, details, expectedHost) {
  const problems = [];
  const origin = details?.origin ?? {};
  if (!expectedHost) {
    problems.push("STAGING_DATABASE_HOST is not set");
  } else if (origin.host !== expectedHost || POOLER.test(origin.host ?? "")) {
    problems.push(
      `${binding}: Hyperdrive points to another host than the staging database, or to the pooler`
    );
  }
  if (details?.caching?.disabled !== true) {
    problems.push(`${binding}: query caching must be disabled`);
  }
  if (
    !origin.user ||
    OWNER_USER.test(origin.user) ||
    !origin.user.includes("staging")
  ) {
    problems.push(
      `${binding}: Hyperdrive must log in as a staging runtime login, never as the database owner`
    );
  }
  return problems;
}

/** Pinned to the staging account, so a token that sees several accounts never reads another one. */
function hyperdriveDetails(id, cwd, accountId) {
  const result = spawnSync(
    "bunx",
    ["--no-install", "wrangler", "hyperdrive", "get", id],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    }
  );
  if (result.status !== 0) {
    return null;
  }
  const start = result.stdout.indexOf("{");
  try {
    return start === -1 ? null : JSON.parse(result.stdout.slice(start));
  } catch {
    return null;
  }
}

function readBuilt(appDir) {
  // the deploy follows .wrangler/deploy/config.json to the generated wrangler.json; so does this check
  const redirect = resolve(appDir, ".wrangler/deploy/config.json");
  if (!existsSync(redirect)) {
    return null;
  }
  const { configPath } = JSON.parse(readFileSync(redirect, "utf8"));
  const file = resolve(dirname(redirect), configPath);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function findRemoteProblems(entries) {
  return entries.flatMap(({ app, appDir, config }) =>
    [...bindingsOf(config.env.staging).hyperdrive].flatMap(([binding, id]) => {
      // the static check already proved account_id is the 32-hex staging account
      const details = hyperdriveDetails(
        id,
        appDir,
        config.env.staging.account_id
      );
      if (details === null) {
        return [`${app}: could not read Hyperdrive ${binding}`];
      }
      return findHyperdriveProblems(
        `${app} ${binding}`,
        details,
        process.env.STAGING_DATABASE_HOST
      );
    })
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = WORKERS.map((app) => {
    const appDir = resolve(root, "apps", app);
    const config = parseJsonc(
      readFileSync(resolve(appDir, "wrangler.jsonc"), "utf8")
    );
    // the Admin is not deployed to staging and is not built by Vite: its source block is what counts
    const built =
      args.has("--built") && app !== "admin" ? readBuilt(appDir) : undefined;
    return { app, appDir, built, config };
  });
  const problems = findIsolationProblems(entries);
  if (args.has("--remote") && problems.length === 0) {
    problems.push(...findRemoteProblems(entries));
  }
  if (problems.length > 0) {
    console.error(`Staging isolation check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Staging isolation check passed.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
