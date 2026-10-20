import { randomBytes } from "node:crypto";
import {
  assertAllowedGateUrl,
  isLocalGateHost,
} from "../../../packages/db/scripts/gate-hosts";
import { PREVIEW_VARIABLES } from "./closed-environment";

/**
 * What every process of one e2e run shares (T-125a): the run id, the Better Auth secret, the password of each
 * login and the instant T0. Playwright evaluates the config in its main process and again in every worker; the
 * values are made once, written to `process.env`, and the child processes (the previews, the workers) inherit
 * them. Nothing here is printed.
 */

/** The seven Hyperdrive bindings of the Worker and the database role each one connects as (wrangler.jsonc). */
export const HYPERDRIVE_ROLES = {
  AUTH_HYPERDRIVE: "polaris_auth_runtime",
  BILLING_HYPERDRIVE: "polaris_billing_runtime",
  HYPERDRIVE: "polaris_pr11_runtime",
  MEDIA_CLEANUP_HYPERDRIVE: "polaris_media_cleanup_runtime",
  ONBOARDING_HYPERDRIVE: "polaris_onboarding_runtime",
  OUTBOX_HYPERDRIVE: "polaris_outbox_runtime",
  PRIVACY_HYPERDRIVE: "polaris_privacy_runtime",
} as const;

export type HyperdriveBinding = keyof typeof HYPERDRIVE_ROLES;
export const HYPERDRIVE_BINDINGS = Object.keys(
  HYPERDRIVE_ROLES
) as HyperdriveBinding[];

/** The variable the Vite plugin (miniflare) reads in place of a binding's `localConnectionString`. */
export function hyperdriveVariable(binding: HyperdriveBinding): string {
  return `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`;
}

const RUN_ID = "E2E_RUN_ID";
const RUN_SECRET = "E2E_RUN_SECRET";
const runIdPattern = /^[a-f0-9]{12}$/;
// the secret and the passwords enter SQL (CREATE ROLE ... PASSWORD) and a URL: a value set by hand must be hex
const secretPattern = /^[a-f0-9]{64}$/;
const passwordPattern = /^[a-f0-9]{48}$/;

export interface RunEnvironment {
  runId: string;
  secret: string;
  passwords: Record<HyperdriveBinding, string>;
}

function passwordVariable(binding: HyperdriveBinding): string {
  return `E2E_LOGIN_PASSWORD_${binding}`;
}

/**
 * Makes the run values only when they are not in `environment` yet, and writes them there. A second evaluation
 * (another Playwright process) reads the same values.
 */
export function ensureRunEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RunEnvironment {
  environment[RUN_ID] ??= randomBytes(6).toString("hex");
  environment[RUN_SECRET] ??= randomBytes(32).toString("hex");
  for (const binding of HYPERDRIVE_BINDINGS) {
    environment[passwordVariable(binding)] ??= randomBytes(24).toString("hex");
  }
  const runId = environment[RUN_ID] as string;
  if (!runIdPattern.test(runId)) {
    throw new Error(`${RUN_ID} must be 12 hexadecimal characters.`);
  }
  if (!secretPattern.test(environment[RUN_SECRET] as string)) {
    throw new Error(`${RUN_SECRET} must be 64 hexadecimal characters.`);
  }
  for (const binding of HYPERDRIVE_BINDINGS) {
    if (
      !passwordPattern.test(environment[passwordVariable(binding)] as string)
    ) {
      throw new Error(
        `${passwordVariable(binding)} must be 48 hexadecimal characters.`
      );
    }
  }
  return {
    passwords: Object.fromEntries(
      HYPERDRIVE_BINDINGS.map((binding) => [
        binding,
        environment[passwordVariable(binding)] as string,
      ])
    ) as Record<HyperdriveBinding, string>,
    runId,
    secret: environment[RUN_SECRET] as string,
  };
}

export function runDatabaseName(runId: string): string {
  return `e2e_${runId}`;
}

/** One login per binding and run: `polaris_e2e_<run>_<binding>`, lowercase. */
export function runLoginName(
  runId: string,
  binding: HyperdriveBinding
): string {
  return `polaris_e2e_${runId}_${binding.replace("_HYPERDRIVE", "").replace("HYPERDRIVE", "tenant").toLowerCase()}`;
}

export const runLoginPattern = /^polaris_e2e_[a-f0-9]{12}_[a-z_]+$/;

/**
 * The owner URL of the PostgreSQL service (any database on it; the run creates its own). Only a host of
 * packages/db/scripts/gate-hosts.ts passes, and the local service only with `CI=true`.
 */
export function ownerDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env
): URL {
  const url = environment.POLARIS_E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "POLARIS_E2E_DATABASE_URL is required: the owner URL of the local PostgreSQL 18 (CI=true)."
    );
  }
  return assertLocalUrl(url, environment.CI === "true");
}

/**
 * The list of gate-hosts.ts, narrowed to the local PostgreSQL (and only with `CI=true`): its Neon pattern also
 * matches production and staging, and this harness creates databases and logins, so it never goes there.
 */
function assertLocalUrl(value: string, ci = true): URL {
  const url = assertAllowedGateUrl(value, ci);
  if (!isLocalGateHost(url.hostname, ci)) {
    throw new Error(
      "The e2e database must be the local PostgreSQL (localhost or 127.0.0.1, with CI=true), never Neon."
    );
  }
  return url;
}

export function runConnectionString(
  owner: URL,
  run: RunEnvironment,
  binding: HyperdriveBinding
): string {
  const url = new URL(owner.toString());
  url.username = runLoginName(run.runId, binding);
  url.password = run.passwords[binding];
  url.pathname = `/${runDatabaseName(run.runId)}`;
  url.search = "";
  return url.toString();
}

/** BASE_URL may only be the loopback: never staging, Neon or a sandbox. */
export function assertLoopbackBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "The e2e BASE_URL must be the loopback (http://127.0.0.1)."
    );
  }
  return url;
}

const inheritedNames = new Set([
  "BUN_CONFIG_DIR",
  "BUN_INSTALL",
  "CI",
  "HOME",
  "LANG",
  "LD_LIBRARY_PATH",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
]);

/**
 * The closed environment of a preview (as the Gate 2 harness does): the inherited basics, the run's secret, the
 * seven connection strings and the switch of the offline runtime. No `CLOUDFLARE_ENV`: the build and the preview
 * use the top level of wrangler.jsonc, the local one.
 */
export function previewEnvironment(
  owner: URL,
  run: RunEnvironment,
  baseURL: string,
  offlineRuntime: boolean,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && inheritedNames.has(name)) {
      inherited[name] = value;
    }
  }
  const closed: Record<string, string> = {
    ...inherited,
    BETTER_AUTH_BASE_URL: assertLoopbackBaseUrl(baseURL).origin,
    BETTER_AUTH_SECRET: run.secret,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    LEGAL_DRAFT_BUILD: "1",
    VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
    VITE_OFFLINE_RUNTIME_ENABLED: offlineRuntime ? "true" : "false",
    ...Object.fromEntries(
      HYPERDRIVE_BINDINGS.map((binding) => [
        hyperdriveVariable(binding),
        runConnectionString(owner, run, binding),
      ])
    ),
  };
  return { ...closed, [PREVIEW_VARIABLES]: Object.keys(closed).join(",") };
}

/** Refuses a preview environment that misses a binding or leaves one on the wrangler.jsonc fallback. */
export function assertRunHyperdrives(
  environment: Record<string, string | undefined>,
  runId: string
): void {
  for (const binding of HYPERDRIVE_BINDINGS) {
    const value = environment[hyperdriveVariable(binding)];
    if (!value) {
      throw new Error(`${hyperdriveVariable(binding)} is missing.`);
    }
    const url = assertLocalUrl(value);
    if (
      url.username !== runLoginName(runId, binding) ||
      url.pathname !== `/${runDatabaseName(runId)}` ||
      url.username === "postgres"
    ) {
      throw new Error(
        `${hyperdriveVariable(binding)} is not the run login on the run database.`
      );
    }
  }
}
