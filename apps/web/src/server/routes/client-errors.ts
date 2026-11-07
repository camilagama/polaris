import { clientErrorEventSchema } from "@polaris/contracts/client-error";
import {
  CLIENT_ERROR_BODY_MAX_BYTES,
  CLIENT_ERROR_FRAME_PATTERN,
  type ClientErrorEvent,
  chunkNameOfFrame,
} from "@polaris/contracts/client-error-fields";
import { type LogFields, logger } from "@polaris/observability/logger";
import { redactText } from "@polaris/observability/redaction";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { limiterKey } from "../auth/abuse-protection";
import { clientIp } from "../client-ip";
import type { ServerEnv, WorkerBindings } from "../environment";
import {
  type BodyRefusal,
  createBodyLimitMiddleware,
} from "../middleware/body-limit";
import {
  type ClientErrorLog,
  type ClientErrorRefusal,
  createClientErrorLog,
} from "../observability/client-error-log";

/**
 * `POST /api/client-errors`: the report of an error of the app in the browser (ADR 0098, amended; runbook
 * docs/runbooks/erros-do-navegador.md). Outside `/rpc`, so it works with the oRPC client broken. It only writes a
 * log line: no database, no session, no cookie read, no queue, no call outside the Worker.
 *
 * In order: the switch (`CLIENT_ERRORS_ENABLED`, before the origin check of `/api/*`), the origin check, a path
 * without query (400), `Content-Type: application/json` exactly (415), the limit per address
 * (`CLIENT_ERROR_RATE_LIMIT`, 429), the body of at most 2 KiB (413, 415 for an encoding, 400 for a bad length), the
 * redaction net and the strict schema (400). Every answer has no body of the event, and a valid event is 204.
 * None of the refusals is a log line of its own (`client-error-log.ts`).
 */

export const CLIENT_ERRORS_PATH = "/api/client-errors";
const LIMITER_SCOPE = "client-error-ip";
/** A query with a parameter, in any string of the event (`/vendas?id=`, `https://x/?token=`). */
const QUERY_PARAMETER = /\?\S*=/;

/** Only `"1"` turns the route on; anything else (and absent) answers 204 and logs nothing. */
function clientErrorsEnabled(bindings: WorkerBindings | undefined) {
  return bindings?.CLIENT_ERRORS_ENABLED === "1";
}

function noContent(context: Context<ServerEnv>): Response {
  return context.body(null, 204, { "Cache-Control": "no-store" });
}

function refuse(
  context: Context<ServerEnv>,
  status: 400 | 415 | 429,
  code: string,
  headers: Record<string, string> = {}
): Response {
  return context.json(
    { error: { code }, requestId: context.get("requestId") },
    status,
    { "Cache-Control": "no-store", ...headers }
  );
}

/**
 * The switch, mounted before the origin check of `/api/*`: off, a POST is answered 204 with nothing read or logged,
 * not even a refused origin. On a Worker without a WAF of its zone it is the one quick lever of containment.
 */
export const clientErrorsSwitchMiddleware: MiddlewareHandler<
  ServerEnv
> = async (context, next) => {
  if (
    context.req.method.toUpperCase() === "POST" &&
    !clientErrorsEnabled(context.env)
  ) {
    await context.req.raw.body?.cancel().catch(() => undefined);
    return noContent(context);
  }
  await next();
};

/** The most keys and array items the route reads: a valid event has 9 keys and 3 frames, so the net costs little. */
const MAX_KEYS = 16;
const MAX_ITEMS = 3;

/**
 * Whether the body has the shape of an event at all: one flat object of at most `MAX_KEYS` keys, each value a string,
 * a number or a list of at most `MAX_ITEMS` strings. Anything else is refused before the redaction net reads it.
 */
function hasEventShape(body: unknown): body is Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const values = Object.values(body);
  return (
    values.length <= MAX_KEYS &&
    values.every(
      (value) =>
        typeof value === "string" ||
        typeof value === "number" ||
        (Array.isArray(value) &&
          value.length <= MAX_ITEMS &&
          value.every((item) => typeof item === "string"))
    )
  );
}

/** A frame as the log line writes it (`file@line:column`): the policy of the logs masks a name glued to a `:`. */
function loggedFrame(frame: string): string {
  const end = frame.indexOf(".js:") + ".js".length;
  return `${frame.slice(0, end)}@${frame.slice(end + 1)}`;
}

/** The text as it would reach the log: a frame in the form of its line, anything else as it came. */
function asLogged(text: string): string {
  return CLIENT_ERROR_FRAME_PATTERN.test(text) ? loggedFrame(text) : text;
}

function suspectText(text: string): boolean {
  const logged = asLogged(text);
  return redactText(logged) !== logged || QUERY_PARAMETER.test(text);
}

/**
 * Whether any key or string of the body looks like personal data or a secret by the policy of the logs (ADR 0089:
 * an e-mail, a CPF, a phone, a token...) or carries a query: the whole event is then discarded, nothing is corrected.
 * The schema would refuse it as well; this net does not depend on the lists of the schema staying closed.
 */
function suspectsPersonalData(body: Record<string, unknown>): boolean {
  return Object.entries(body).some(
    ([key, value]) =>
      suspectText(key) ||
      (typeof value === "string" && suspectText(value)) ||
      (Array.isArray(value) && value.some((item) => suspectText(String(item))))
  );
}

/**
 * The signature of the failure, computed here from closed fields that stay the same from one build to the next: the
 * kind, the class, the oRPC code and status, the boundary, the screen and the piece of the first frame without its
 * hash. The lines and columns of the frames and the release are out of it, so a deploy does not make the same
 * failure new. 16 hex characters of a SHA-256.
 */
export async function clientErrorSignature(
  event: ClientErrorEvent
): Promise<string> {
  const first = event.frames?.[0];
  const material = JSON.stringify([
    event.kind,
    event.errorName,
    event.code ?? null,
    event.status ?? null,
    event.boundary ?? null,
    event.routeId,
    first === undefined ? null : chunkNameOfFrame(first),
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  );
  return Array.from(digest.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** The line of an event: its fields under the canonical names of the logs (ADR 0091), and nothing else. */
function logFieldsOf(event: ClientErrorEvent): LogFields {
  return {
    boundary: event.boundary,
    errorClass: event.errorName,
    errorCode: event.code,
    frames: event.frames?.map(loggedFrame),
    kind: event.kind,
    release: event.release,
    routeId: event.routeId,
    rpcStatus: event.status,
    v: event.v,
  };
}

const BODY_REFUSALS: Record<BodyRefusal, ClientErrorRefusal> = {
  invalid_content_length: "bad_request",
  payload_too_large: "too_large",
  unsupported_content_encoding: "unsupported",
};

interface ClientErrorRoutesOptions {
  log?: ClientErrorLog;
}

export function createClientErrorRoutes({
  log = createClientErrorLog(),
}: ClientErrorRoutesOptions = {}) {
  let warnedAboutMissingLimiter = false;

  const shape: MiddlewareHandler<ServerEnv> = async (context, next) => {
    // the raw URL: `new URL` drops a lone `?`
    if (context.req.url.includes("?")) {
      log.refused("bad_request");
      return refuse(context, 400, "query_not_allowed");
    }
    if (context.req.header("content-type") !== "application/json") {
      log.refused("unsupported");
      return refuse(context, 415, "unsupported_media_type");
    }
    await next();
  };

  const limit: MiddlewareHandler<ServerEnv> = async (context, next) => {
    const limiter = context.env.CLIENT_ERROR_RATE_LIMIT;
    const secret = context.env.BETTER_AUTH_SECRET;
    const ip = clientIp(context.req.raw);
    if (limiter === undefined || !secret) {
      if (!warnedAboutMissingLimiter) {
        warnedAboutMissingLimiter = true;
        logger.warn("rate_limit_binding_missing", { scope: LIMITER_SCOPE });
      }
    } else if (ip === undefined) {
      // behind the edge the address always comes; without it nothing is counted against a bucket, so say it
      log.refused("limiter_unavailable");
    } else {
      try {
        const { success } = await limiter.limit({
          key: await limiterKey(secret, LIMITER_SCOPE, ip),
        });
        if (!success) {
          log.refused("rate_limited");
          return refuse(context, 429, "rate_limited", { "Retry-After": "60" });
        }
      } catch {
        // open on a failure of the limiter, as the other limits; counted, never a line per request
        log.refused("limiter_unavailable");
      }
    }
    await next();
  };

  const bodyLimit = createBodyLimitMiddleware({
    maxBytes: CLIENT_ERROR_BODY_MAX_BYTES,
    onRefusal: (_context, refusal) => {
      log.refused(BODY_REFUSALS[refusal]);
    },
  });

  const accept = async (context: Context<ServerEnv>) => {
    let text: string;
    try {
      text = await context.req.raw.text();
    } catch {
      // the body went past the ceiling as it was read: the limit answers 413 in place of this one, and counts it
      return refuse(context, 400, "invalid_event");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      log.refused("bad_request");
      return refuse(context, 400, "invalid_event");
    }
    if (!hasEventShape(body)) {
      log.refused("bad_request");
      return refuse(context, 400, "invalid_event");
    }
    if (suspectsPersonalData(body)) {
      log.piiSuspected();
      return refuse(context, 400, "invalid_event");
    }
    const parsed = clientErrorEventSchema.safeParse(body);
    if (!parsed.success) {
      log.refused("bad_request");
      return refuse(context, 400, "invalid_event");
    }
    log.accepted(
      await clientErrorSignature(parsed.data),
      logFieldsOf(parsed.data)
    );
    return noContent(context);
  };

  const routes = new Hono<ServerEnv>();
  routes.post(CLIENT_ERRORS_PATH, shape, limit, bodyLimit, accept);
  return routes;
}
