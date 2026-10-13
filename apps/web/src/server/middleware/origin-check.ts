import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "../environment";
import { logServerEvent } from "../observability/server-log";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
 * Future webhooks must be mounted outside the guarded paths; they authenticate
 * with provider signatures instead of browser origin.
 */
export const originCheckMiddleware: MiddlewareHandler<ServerEnv> = async (
  context,
  next
) => {
  if (SAFE_METHODS.has(context.req.method.toUpperCase())) {
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
