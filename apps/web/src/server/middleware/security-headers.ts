import {
  defaultCacheControl,
  type SecurityHeadersOptions,
  securityHeaders,
} from "@polaris/http-security";
import type { MiddlewareHandler } from "hono";
import { tipsStopStyleHash } from "../tips-stop/tips-stop-page";
import { TIPS_STOP_PATH } from "../tips-stop/unsubscribe-token";

/**
 * Origins the SPA shell opens beyond its own, rendered into public/_headers (the Worker does not run for
 * the shell). Empty: the app loads and connects to itself only. The browser Sentry does not add its origin
 * here: the host is part of the DSN, which stays out of the repository, so a build with `VITE_SENTRY_DSN`
 * rewrites `_headers` in its output instead (pwa/sentry-build.ts, ADR 0098).
 */
export const APP_SHELL_SECURITY_OPTIONS: SecurityHeadersOptions = {};

const API_HEADERS = Object.entries(securityHeaders("api"));
const API_CACHE_CONTROL = defaultCacheControl("api");

let tipsStopHeaders: Promise<[string, string][]> | undefined;

/** The page that stops the tips e-mails is a document: its style by hash, its form, no script and no referrer. */
function tipsStopPageHeaders(): Promise<[string, string][]> {
  tipsStopHeaders ??= tipsStopStyleHash().then((hash) =>
    Object.entries(securityHeaders("form-document", { styleHashes: [hash] }))
  );
  return tipsStopHeaders;
}

/**
 * The headers of the Worker's own answers (/health, /ready, /rpc/*, /api/*), and those of a page for the one path that
 * answers HTML. A handler that chose its own Cache-Control keeps it; any other answer is not cacheable.
 */
export const securityHeadersMiddleware: MiddlewareHandler = async (
  context,
  next
) => {
  await next();
  const headers =
    context.req.path === TIPS_STOP_PATH
      ? await tipsStopPageHeaders()
      : API_HEADERS;
  for (const [name, value] of headers) {
    context.header(name, value);
  }
  if (API_CACHE_CONTROL !== null && !context.res.headers.has("Cache-Control")) {
    context.header("Cache-Control", API_CACHE_CONTROL);
  }
};
