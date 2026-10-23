import { Hono } from "hono";
import { abuseProtectionConfigured } from "../auth/abuse-protection";
import { isEmailPasswordAuthEnabled } from "../auth/handler";
import type { ServerEnv, WorkerBindings } from "../environment";

/** What the sign-in page may offer (AC-46). Public: it says which doors exist, never who is behind them. */
export interface AuthMethods {
  emailPassword: boolean;
  google: boolean;
  /** The public key of the challenge, only while the password is on. */
  turnstileSiteKey: string | null;
}

/**
 * The abuse protection is ready when `abuseProtectionConfigured` (the one list, shared with the gate of
 * `protectAuthRequest`) says so and the public key of the Turnstile is set: the server does not read the site
 * key, it is here so that `turnstileSiteKey` is set exactly when `emailPassword` is. The server keeps its 503
 * as the barrier; this only keeps the page from offering a form that can answer nothing else.
 */
function isAbuseProtectionReady(bindings: WorkerBindings): boolean {
  return (
    abuseProtectionConfigured(bindings) &&
    Boolean(bindings.TURNSTILE_SITE_KEY?.trim())
  );
}

export function authMethods(bindings: WorkerBindings): AuthMethods {
  const emailPassword =
    isEmailPasswordAuthEnabled(bindings) && isAbuseProtectionReady(bindings);
  const turnstileSiteKey = bindings.TURNSTILE_SITE_KEY?.trim();
  return {
    emailPassword,
    google: Boolean(
      bindings.GOOGLE_CLIENT_ID?.trim() && bindings.GOOGLE_CLIENT_SECRET?.trim()
    ),
    turnstileSiteKey:
      emailPassword && turnstileSiteKey ? turnstileSiteKey : null,
  };
}

export const authMethodsRoutes = new Hono<ServerEnv>();

authMethodsRoutes.get("/api/auth-methods", (context) =>
  context.json(authMethods(context.env), 200, {
    "Cache-Control": "private, no-store",
  })
);
