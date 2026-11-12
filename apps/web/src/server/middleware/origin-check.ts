import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";
import { logServerEvent } from "../observability/server-log";
import { TIPS_STOP_PATH } from "../tips-stop/unsubscribe-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The exact paths under the guarded prefixes that take a POST with any `Origin` or none. Only the page that stops the
 * tips e-mails: a mail reader posts `List-Unsubscribe=One-Click` (RFC 8058) from its own servers, with no `Origin`, and
 * the page proves itself by the HMAC of its token instead, before it reaches the database. Nothing else belongs here:
 * `origin-check.test.ts` holds the list exactly.
 */
export const ORIGIN_CHECK_EXEMPT_PATHS: readonly string[] = [TIPS_STOP_PATH];

function configuredOrigin(baseURL: string | undefined): string | undefined {
  if (!baseURL) {
    return undefined;
  }
  try {
    return new URL(baseURL).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defense for state-changing requests under /rpc and /api. SameSite=Lax
 * cookies are not enough on their own: the oRPC parser accepts "simple"
 * requests (text/plain, urlencoded, multipart) that a cross-site form can send.
 *
 * A request passes when `Origin` equals the configured application origin, or
 * when `Origin` is absent and the browser vouches `Sec-Fetch-Site: same-origin`
 * (a forbidden header name, so page script cannot set it). A present but
 * different `Origin` (including "null") is always rejected. Anything else,
 * including a missing configuration, is rejected with a generic 403.
 *
 * Webhooks are mounted outside the guarded paths; they authenticate with provider
 * signatures instead of browser origin. The one exception inside them is
 * `ORIGIN_CHECK_EXEMPT_PATHS`.
 */
export const originCheckMiddleware: MiddlewareHandler<ServerEnv> = async (
  context,
  next
) => {
  if (
    SAFE_METHODS.has(context.req.method.toUpperCase()) ||
    ORIGIN_CHECK_EXEMPT_PATHS.includes(context.req.path)
  ) {
    await next();
    return;
  }

  const expectedOrigin = configuredOrigin(context.env.BETTER_AUTH_BASE_URL);
  const origin = context.req.header("origin");
  const fetchSite = context.req.header("sec-fetch-site");
  const allowed =
    expectedOrigin !== undefined &&
    (origin === undefined
      ? fetchSite === "same-origin"
      : origin === expectedOrigin);

  if (!allowed) {
    logServerEvent("request_origin_rejected", context, {
      expectedOriginConfigured: expectedOrigin !== undefined,
      originPresent: origin !== undefined,
    });
    return context.json(
      {
        error: { code: "forbidden" },
        requestId: context.get("requestId"),
      },
      403
    );
  }

  await next();
};
