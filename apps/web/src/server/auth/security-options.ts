import type { BetterAuthOptions } from "better-auth";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type BackgroundTaskHandler = (promise: Promise<unknown>) => void;

export function isLoopbackBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) {
    return false;
  }
  try {
    const { hostname } = new URL(baseURL);
    return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function isSecureBaseURL(baseURL: string): boolean {
  return new URL(baseURL).protocol === "https:";
}

/**
 * The exact name of the session cookie Better Auth sets for this base URL: `better-auth.session_token`,
 * with the `__Secure-` prefix when `useSecureCookies` is on (an HTTPS base URL). Undefined when the base
 * URL is missing or not a URL. Anything that reads the cookie outside Better Auth (the rate limiter) takes
 * the name from here, so the two never disagree.
 */
export function sessionCookieName(
  baseURL: string | undefined
): string | undefined {
  if (!baseURL) {
    return undefined;
  }
  try {
    return `${isSecureBaseURL(baseURL) ? "__Secure-" : ""}better-auth.session_token`;
  } catch {
    return undefined;
  }
}

/**
 * Pins the cookie, origin and client-IP settings that Better Auth would
 * otherwise infer from the environment or from untrusted headers.
 *
 * - Cookies are HttpOnly, SameSite=Lax, Path=/ and Secure whenever the base URL
 *   is HTTPS (which also yields the `__Secure-` name prefix). A plain-HTTP base
 *   URL is only accepted for loopback development.
 * - The client IP comes from `cf-connecting-ip`, which Cloudflare overwrites at
 *   the edge; `x-forwarded-for` is client-controlled and is not consulted.
 * - Only the application origin is trusted for callbacks and CSRF checks.
 * - Email delivery runs through `backgroundTasks` (Worker `waitUntil`) so the
 *   response time of sign-up and password reset no longer reveals whether an
 *   account exists (an existing user skips the send). Without a handler (unit
 *   tests, scripts) Better Auth awaits the send as before.
 */
export function betterAuthSecurityOptions(
  baseURL: string,
  runInBackground?: BackgroundTaskHandler
): Pick<BetterAuthOptions, "advanced" | "trustedOrigins"> {
  const { origin } = new URL(baseURL);
  const secure = isSecureBaseURL(baseURL);

  if (!(secure || isLoopbackBaseURL(baseURL))) {
    throw new Error("auth_base_url_must_be_https");
  }

  return {
    advanced: {
      ...(runInBackground
        ? { backgroundTasks: { handler: runInBackground } }
        : {}),
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure,
      },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: secure,
    },
    trustedOrigins: [origin],
  };
}
