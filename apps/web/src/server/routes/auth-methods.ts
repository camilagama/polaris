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

export function authMethods(bindings: WorkerBindings): AuthMethods {
  const emailPassword = isEmailPasswordAuthEnabled(bindings);
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
