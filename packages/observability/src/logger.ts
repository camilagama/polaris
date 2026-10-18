import { initLogger, log } from "evlog";

/**
 * Typed logger for the backend (Workers, Hono, Queue consumers, jobs, billing
 * integrations). It wraps evlog's simple `log` API: evlog is the logging API,
 * Cloudflare Observability stays the destination (stdout, no external drain).
 *
 * Never import this from `packages/domain` or from browser code: the domain
 * stays free of logging and the V1 has no client logging (see ADR 0089). The wide-event field schema (PR115) and
 * the centralised redaction (PR116) build on this wrapper; until then callers
 * keep emitting only allow-listed, non-personal fields.
 */

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

export type LogFields = {
  readonly [key: string]: LogValue;
} & { readonly [key in ReservedKey]?: never };

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

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (!configured) {
    applyConfig({ service: "polaris" });
  }

  const safe: Record<string, LogValue> = {};
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      // The type already forbids these; this keeps a cast from forging them.
      if (!(reservedKeys.has(key) || value === undefined)) {
        safe[key] = value;
      }
    }
  }

  log[level]({ ...safe, event });
}

export const logger: Logger = {
  debug: (event, fields) => emit("debug", event, fields),
  error: (event, fields) => emit("error", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
};
