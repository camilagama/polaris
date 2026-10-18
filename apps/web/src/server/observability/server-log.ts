import { type LogFields, logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { Context } from "hono";
import { routePath } from "hono/route";
import type { ServerEnv } from "../environment";

/**
 * Structured server-side diagnostics (Workers observability / `wrangler tail`).
 *
 * Only allow-listed, non-personal fields are emitted: request id, route
 * *pattern* (never the concrete URL, query or parameters), method, error class
 * names and provider/SQLSTATE style codes. Error messages, stacks, headers and
 * bodies are never logged because they can echo user input (names, e-mails,
 * SQL parameters). Clients keep receiving generic responses.
 */

const MAX_CAUSE_DEPTH = 4;

type ErrorSummary = ReturnType<typeof describeError>;

function summarizeError(error: unknown): ErrorSummary[] {
  const chain: ErrorSummary[] = [];
  let current: unknown = error;

  while (chain.length < MAX_CAUSE_DEPTH) {
    chain.push(describeError(current));
    if (typeof current !== "object" || current === null) {
      break;
    }
    const { cause } = current as { cause?: unknown };
    if (cause === undefined || cause === null) {
      break;
    }
    current = cause;
  }

  return chain;
}

export interface ServerErrorLogInput {
  error: unknown;
  extra?: LogFields;
  method: string;
  requestId: string;
  route: string;
  /** HTTP status of the answer; logged as `httpStatus`. */
  status?: number;
}

export function logServerError(input: ServerErrorLogInput): void {
  const [top, ...causes] = summarizeError(input.error);

  logger.error("server_error", {
    ...input.extra,
    causes:
      causes.length > 0 ? causes.map((cause) => ({ ...cause })) : undefined,
    errorClass: top?.errorClass,
    errorCode: top?.errorCode,
    httpStatus: input.status,
    method: input.method,
    requestId: input.requestId,
    route: input.route,
  });
}

function honoRoute(context: Context<ServerEnv>): string {
  try {
    return routePath(context, -1);
  } catch {
    return "unknown";
  }
}

export function logServerErrorFromContext(
  context: Context<ServerEnv>,
  error: unknown,
  status: number
): void {
  logServerError({
    error,
    method: context.req.method,
    requestId: context.get("requestId"),
    route: honoRoute(context),
    status,
  });
}

export function logServerEvent(
  event: string,
  context: Context<ServerEnv>,
  fields: LogFields = {}
): void {
  logger.warn(event, {
    ...fields,
    method: context.req.method,
    requestId: context.get("requestId"),
    route: honoRoute(context),
  });
}
