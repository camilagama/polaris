import { Hono } from "hono";
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
 * The abuse protection is ready when the form can get past the gate of `protectAuthRequest` for lack of
 * setup: the flag, the Turnstile secret, the base URL and both limiters (the e-mail one is only required by
 * the actions that send e-mail, but the form has sign-up). The site key is not read by the server; it is here
 * so that `turnstileSiteKey` is set exactly when `emailPassword` is. Keep this list with that gate. The
 * server keeps its 503 as the barrier; this only keeps the page from offering a form that can answer nothing else.
 */
function isAbuseProtectionReady(bindings: WorkerBindings): boolean {
  return (
    bindings.AUTH_ABUSE_PROTECTION_ENABLED === "true" &&
    Boolean(
      bindings.TURNSTILE_SECRET_KEY?.trim() &&
        bindings.TURNSTILE_SITE_KEY?.trim() &&
        bindings.BETTER_AUTH_BASE_URL?.trim() &&
        bindings.AUTH_RATE_LIMITER &&
        bindings.AUTH_EMAIL_RATE_LIMITER
    )
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
