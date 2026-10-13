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

type LogValue = boolean | number | string | undefined;

const safeNamePattern = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const safeCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CAUSE_DEPTH = 4;

interface ErrorSummary {
  code?: string;
  name: string;
}

function summarizeOne(error: unknown): ErrorSummary {
  if (typeof error !== "object" || error === null) {
    return { name: "NonObjectError" };
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  const summary: ErrorSummary = {
    name:
      typeof name === "string" && safeNamePattern.test(name)
        ? name
        : "UnknownError",
  };
  if (typeof code === "string" && safeCodePattern.test(code)) {
    summary.code = code;
  } else if (typeof code === "number" && Number.isSafeInteger(code)) {
    summary.code = String(code);
  }
  return summary;
}

function summarizeError(error: unknown): ErrorSummary[] {
  const chain: ErrorSummary[] = [];
  let current: unknown = error;

  while (chain.length < MAX_CAUSE_DEPTH) {
    chain.push(summarizeOne(current));
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
  extra?: Record<string, LogValue>;
  method: string;
  requestId: string;
  route: string;
  status?: number;
}

export function logServerError(input: ServerErrorLogInput): void {
  const [top, ...causes] = summarizeError(input.error);

  console.error({
    ...input.extra,
    causes: causes.length > 0 ? causes : undefined,
    errorCode: top?.code,
    errorName: top?.name,
    event: "server_error",
    method: input.method,
    requestId: input.requestId,
    route: input.route,
    status: input.status,
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
  fields: Record<string, LogValue> = {}
): void {
  console.warn({
    ...fields,
    event,
    method: context.req.method,
    requestId: context.get("requestId"),
    route: honoRoute(context),
  });
}
