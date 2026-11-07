import { initLogger, log } from "evlog";
import {
  type CanonicalFields,
  canonicalNameFor,
  type ForbiddenAlias,
  isOpaqueId,
  type OpaqueId,
  opaqueIdFields,
} from "./fields";
import { redact, redactText } from "./redaction";

/**
 * Typed logger for the backend (Workers, Hono, Queue consumers, jobs, billing
 * integrations). It wraps evlog's simple `log` API: evlog is the logging API,
 * Cloudflare Observability stays the destination (stdout, no external drain).
 *
 * Never import this from `packages/domain` or from browser code: the domain
 * stays free of logging and the V1 has no client logging (see ADR 0089). The
 * field names are the canonical schema of `./fields` (ADR 0091): the type
 * refuses the forbidden aliases and the call drops them. Every event then goes
 * through the redaction policy of `./redaction` (PR116) before evlog sees it,
 * so a field that carries personal data or a secret leaves masked even when a
 * call site forgets to leave it out.
 */

export type {
  CanonicalFields,
  ForbiddenAlias,
  OpaqueId,
  Outcome,
} from "./fields";

/**
 * The value as an `OpaqueId`, or `undefined` when it does not have the shape of
 * one (the logger drops an `undefined` field). Pass an id the system minted
 * (the session's user id, the membership's organization id), never text the
 * client sent.
 */
export function opaqueId(value: unknown): OpaqueId | undefined {
  return isOpaqueId(value) ? value : undefined;
}

export type LogScalar = boolean | null | number | string | undefined;

/** One level of nesting at most: a counter report or a short list of error summaries. */
export interface LogRecord {
  readonly [key: string]: LogScalar;
}

export type LogValue =
  | LogScalar
  | LogRecord
  | readonly LogRecord[]
  | readonly LogScalar[];

/** Keys evlog owns on every event; a caller can neither set nor override them. */
type ReservedKey =
  | "ai"
  | "audit"
  | "commitHash"
  | "environment"
  | "event"
  | "ignoredFields"
  | "level"
  | "region"
  | "service"
  | "timestamp"
  | "version";

/**
 * Canonical fields keep their type (an `outcome` is one of the known values, a
 * `durationMs` a number); any other key is a free metric. The reserved keys and
 * the forbidden aliases are `never`, so a call that uses one does not compile.
 */
export type LogFields = {
  readonly [key: string]: LogValue;
} & CanonicalFields & {
    readonly [key in ForbiddenAlias | ReservedKey]?: never;
  };

export type LogLevel = "debug" | "error" | "info" | "warn";

export interface Logger {
  debug: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
}

export interface LoggingConfig {
  environment?: string;
  /** Worker name, e.g. `polaris-web`. Identifies the emitter on every event. */
  service: string;
  version?: string;
}

const reservedKeys: ReadonlySet<string> = new Set<ReservedKey>([
  "ai",
  "audit",
  "commitHash",
  "environment",
  "event",
  "ignoredFields",
  "level",
  "region",
  "service",
  "timestamp",
  "version",
]);

let configured = false;
let current: LoggingConfig = { service: "polaris" };

function applyConfig(config: LoggingConfig): void {
  current = config;
  initLogger({
    env: {
      ...(config.environment === undefined
        ? {}
        : { environment: config.environment }),
      service: config.service,
      ...(config.version === undefined ? {} : { version: config.version }),
    },
    // Workers Logs indexes the object as JSON; no ANSI, no timestamps prefix.
    pretty: false,
    // The Polaris policy (`./redaction`) masks every event in `emit`; evlog's
    // generic masking would only mask a second time (and IP is masked there
    // with no way to carry an exception an ADR asks for).
    redact: false,
    stringify: false,
  });
  configured = true;
}

/**
 * Names the emitter. Call once at the top of each Worker entry. Calling it
 * again replaces the configuration (evlog's state is process-wide).
 */
export function configureLogging(config: LoggingConfig): void {
  applyConfig(config);
}

const deployedEnvironments: ReadonlySet<string> = new Set([
  "production",
  "staging",
]);

/**
 * Takes the `environment` of the events from the Worker's `POLARIS_ENVIRONMENT`
 * variable (`staging` or `production`, set per environment in `wrangler.jsonc`).
 * Without it evlog falls back to the bundle's `NODE_ENV`, or `production`, so a
 * staging Worker would be labelled by a build default; any other value is
 * ignored, so a mistyped variable cannot invent an environment. Cheap to call on every
 * invocation: it only reconfigures when the value changes.
 */
export function useLoggingEnvironment(value: unknown): void {
  if (
    typeof value !== "string" ||
    !deployedEnvironments.has(value) ||
    current.environment === value
  ) {
    return;
  }
  applyConfig({ ...current, environment: value });
}

const opaqueIds: ReadonlySet<string> = new Set(opaqueIdFields);

/**
 * What the event carries: the fields that passed the schema and the names of
 * the ones that did not. A dropped name is listed in `ignoredFields` (names
 * only, never the values) so a wrong call is visible instead of silent.
 */
function applySchema(fields: LogFields | undefined): {
  ignored: string[];
  safe: Record<string, LogValue>;
} {
  // `Object.create(null)`: a key named `__proto__` is data here, not the prototype
  const safe: Record<string, LogValue> = Object.create(null);
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) {
      continue;
    }
    // The type already forbids these; a cast cannot forge them, and the name is listed like any other dropped field.
    if (
      reservedKeys.has(key) ||
      canonicalNameFor(key) !== undefined ||
      (opaqueIds.has(key) && !isOpaqueId(value))
    ) {
      ignored.push(key);
      continue;
    }
    safe[key] = value;
  }
  return { ignored, safe };
}

/** Writes one event; the logger and `wide-event` use it, callers use `logger.*`. */
export function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (!configured) {
    applyConfig({ service: "polaris" });
  }

  log[level]({ ...redacted(fields), event: redactText(event) });
}

/**
 * The fields that go out. Fails closed: if the policy cannot read a value (a
 * getter or a proxy that throws), the event carries only `redactionFailed`
 * and the log call never throws into the code that was logging an error.
 */
function redacted(fields: LogFields | undefined): Record<string, unknown> {
  try {
    const { ignored, safe } = applySchema(fields);
    return redact({
      ...safe,
      ...(ignored.length > 0 ? { ignoredFields: ignored } : {}),
    });
  } catch {
    return { redactionFailed: true };
  }
}

export const logger: Logger = {
  debug: (event, fields) => emit("debug", event, fields),
  error: (event, fields) => emit("error", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
};
