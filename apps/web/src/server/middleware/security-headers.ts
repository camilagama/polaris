import {
  defaultCacheControl,
  type SecurityHeadersOptions,
  securityHeaders,
} from "@polaris/http-security";
import type { MiddlewareHandler } from "hono";

/**
 * Origins the SPA shell opens beyond its own, rendered into public/_headers (the Worker does not run for
 * the shell). Empty: the app loads and connects to itself only. Turning an error reporter on adds its
 * ingest origin here, in the pull request that enables it (ADR 0090).
 */
export const APP_SHELL_SECURITY_OPTIONS: SecurityHeadersOptions = {};

const API_HEADERS = Object.entries(securityHeaders("api"));
const API_CACHE_CONTROL = defaultCacheControl("api");

/**
 * The headers of the Worker's own answers (/health, /ready, /rpc/*, /api/*). A handler that chose its
 * own Cache-Control keeps it; any other answer is not cacheable.
 */
export const securityHeadersMiddleware: MiddlewareHandler = async (
  context,
  next
) => {
  await next();
  for (const [name, value] of API_HEADERS) {
    context.header(name, value);
  }
  if (API_CACHE_CONTROL !== null && !context.res.headers.has("Cache-Control")) {
    context.header("Cache-Control", API_CACHE_CONTROL);
  }
};
