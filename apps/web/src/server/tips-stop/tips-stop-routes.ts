import {
  type ActivationOptOutWriter,
  createActivationOptOutWriter,
} from "@polaris/db/activation-opt-out";
import { logger } from "@polaris/observability/logger";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { limiterKey } from "../auth/abuse-protection";
import { clientIp } from "../client-ip";
import type { ServerEnv } from "../environment";
import { renderTipsStopPage, type TipsStopPageState } from "./tips-stop-page";
import {
  TIPS_STOP_PATH,
  UNSUBSCRIBE_TOKEN_PARAMETER,
  unsubscribeSecretsOf,
  verifyUnsubscribeToken,
} from "./unsubscribe-token";

/**
 * `/api/parar-dicas?t=<token>`: the page that stops the tips e-mails (ADR 0106, D8), public and with no session. A
 * mail reader posts here too (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, RFC 8058) with no `Origin`, so this
 * is the one path the origin check of `/api/*` lets through (`ORIGIN_CHECK_EXEMPT_PATHS`).
 *
 * In order: the limit per address (before anything, with the same page as every other answer); the token, checked in
 * the Worker, so a token that does not verify never opens a connection to the database; then GET and HEAD only show
 * the question, and a POST (the form of the page or the one of the mail reader, whose body is never read) records the
 * stop with `activation_record_opt_out`, on the billing connection. A valid token gets the same page whether the person
 * exists or not, and every token that does not verify gets the same refusal.
 *
 * The log has the outcome and nothing else: no token, no query, no person, no address (the route of the log is the
 * pattern, never the URL).
 */

const LIMITER_SCOPE = "tips-stop-ip";

/** What the answer was, as the log's short reason, and how it ended for the canonical `outcome`. */
const REASONS = {
  asked: "success",
  invalid_token: "rejected",
  limiter_unavailable: undefined,
  rate_limited: "rejected",
  recorded: "success",
  unavailable: "failure",
} as const;

type Reason = keyof typeof REASONS;

type PageStatus = 200 | 400 | 429 | 503;

export interface TipsStopRoutesOptions {
  createWriter?: (connectionString: string) => ActivationOptOutWriter;
}

function logOutcome(context: Context<ServerEnv>, reason: Reason): void {
  logger.info("tips_stop_answered", {
    method: context.req.method,
    outcome: REASONS[reason],
    reason,
    requestId: context.get("requestId"),
  });
}

function page(
  context: Context<ServerEnv>,
  state: TipsStopPageState,
  status: PageStatus,
  headers: Record<string, string> = {}
): Response {
  return context.html(renderTipsStopPage(state), status, {
    "Cache-Control": "no-store",
    ...headers,
  });
}

function runInBackground(
  context: Context<ServerEnv>,
  promise: Promise<unknown>
): void {
  try {
    context.executionCtx.waitUntil(promise.catch(() => undefined));
  } catch {
    // No ExecutionContext (unit tests): detach the task without an unhandled rejection.
    promise.catch(() => undefined);
  }
}

export function createTipsStopRoutes({
  createWriter = createActivationOptOutWriter,
}: TipsStopRoutesOptions = {}) {
  let warnedAboutMissingLimiter = false;

  const limit: MiddlewareHandler<ServerEnv> = async (context, next) => {
    const limiter = context.env.TIPS_STOP_RATE_LIMIT;
    const secret = context.env.BETTER_AUTH_SECRET;
    const ip = clientIp(context.req.raw);
    if (limiter === undefined || !secret) {
      if (!warnedAboutMissingLimiter) {
        warnedAboutMissingLimiter = true;
        logger.warn("rate_limit_binding_missing", { scope: LIMITER_SCOPE });
      }
    } else if (ip === undefined) {
      logOutcome(context, "limiter_unavailable");
    } else {
      try {
        const { success } = await limiter.limit({
          key: await limiterKey(secret, LIMITER_SCOPE, ip),
        });
        if (!success) {
          await context.req.raw.body?.cancel().catch(() => undefined);
          logOutcome(context, "rate_limited");
          return page(context, "rate_limited", 429, { "Retry-After": "60" });
        }
      } catch {
        // open on a failure of the limiter, as the other limits; the outcome says it
        logOutcome(context, "limiter_unavailable");
      }
    }
    await next();
  };

  /** Records the stop; false (logged with the class only) when the write did not happen. */
  const record = async (
    context: Context<ServerEnv>,
    connectionString: string,
    userId: string
  ): Promise<boolean> => {
    let writer: ActivationOptOutWriter | undefined;
    try {
      writer = createWriter(connectionString);
      await writer.record(userId);
      return true;
    } catch (error) {
      // the class only: the message of a driver error may quote the statement, never its parameters, but stays out
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn("tips_stop_write_failed", {
        errorClass: error instanceof Error ? error.name : typeof error,
        requestId: context.get("requestId"),
        sqlState: typeof code === "string" ? code : undefined,
      });
      logOutcome(context, "unavailable");
      return false;
    } finally {
      if (writer !== undefined) {
        runInBackground(context, writer.close());
      }
    }
  };

  const answer = async (context: Context<ServerEnv>) => {
    const posted = context.req.method.toUpperCase() === "POST";
    if (posted) {
      // the form sends `List-Unsubscribe=One-Click` and a mail reader the same or nothing: the stop does not read it
      await context.req.raw.body?.cancel().catch(() => undefined);
    }
    const secrets = unsubscribeSecretsOf(context.env);
    if (secrets === undefined) {
      logOutcome(context, "unavailable");
      return page(context, "unavailable", 503);
    }
    const userId = await verifyUnsubscribeToken(
      secrets,
      context.req.query(UNSUBSCRIBE_TOKEN_PARAMETER)
    );
    if (userId === undefined) {
      logOutcome(context, "invalid_token");
      return page(context, "invalid", 400);
    }
    if (!posted) {
      logOutcome(context, "asked");
      return page(context, "confirm", 200);
    }
    const connectionString = context.env.BILLING_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      logOutcome(context, "unavailable");
      return page(context, "unavailable", 503);
    }
    if (!(await record(context, connectionString, userId))) {
      return page(context, "unavailable", 503);
    }
    logOutcome(context, "recorded");
    return page(context, "done", 200);
  };

  const routes = new Hono<ServerEnv>();
  // GET answers HEAD too, with the same headers and no body
  routes.get(TIPS_STOP_PATH, limit, answer);
  routes.post(TIPS_STOP_PATH, limit, answer);
  return routes;
}
