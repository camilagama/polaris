import { initLogger, log } from "evlog";
import {
  type CanonicalFields,
  canonicalNameFor,
  type ForbiddenAlias,
  isOpaqueId,
  opaqueIdFields,
} from "./fields";

/**
 * Typed logger for the backend (Workers, Hono, Queue consumers, jobs, billing
 * integrations). It wraps evlog's simple `log` API: evlog is the logging API,
 * Cloudflare Observability stays the destination (stdout, no external drain).
 *
 * Never import this from `packages/domain` or from browser code: the domain
 * stays free of logging and the V1 has no client logging (see ADR 0089). The
 * field names are the canonical schema of `./fields` (ADR 0091): the type
 * refuses the forbidden aliases and the call drops them. The centralised
 * redaction (PR116) builds on this wrapper; until then callers keep emitting
 * only allow-listed, non-personal fields.
 */

export type {
  CanonicalFields,
  ForbiddenAlias,
  Outcome,
} from "./fields";

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
  "level",
  "region",
  "service",
  "timestamp",
  "version",
]);

let configured = false;

function applyConfig(config: LoggingConfig): void {
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
    // evlog's built-in masking (e-mail, card number, IP, phone, secret-like
    // keys) stays on as a safety net; the allow-list in each call site is still
    // what keeps personal data out. The project's own policy is PR116.
    redact: true,
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
  const safe: Record<string, LogValue> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) {
      continue;
    }
    // The type already forbids these; this keeps a cast from forging them.
    if (reservedKeys.has(key)) {
      continue;
    }
    if (
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

export function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (!configured) {
    applyConfig({ service: "polaris" });
  }

  const { ignored, safe } = applySchema(fields);
  log[level]({
    ...safe,
    ...(ignored.length > 0 ? { ignoredFields: ignored } : {}),
    event,
  });
}

export const logger: Logger = {
  debug: (event, fields) => emit("debug", event, fields),
  error: (event, fields) => emit("error", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
};
