import { createDatabase } from "@polaris/db/client";
import { logger } from "@polaris/observability/logger";
import { createBetterAuth } from "../auth";
import {
  PasswordPolicyError,
  passwordPolicyErrorDetails,
  validateNewPassword,
} from "../auth/password-policy";
import type { WorkerBindings } from "../environment";
import {
  AuthDatabaseNotConfiguredError,
  resolveAuthConnectionString,
} from "./auth-database";
import { createResendAuthEmailDelivery } from "./email";
import type { BackgroundTaskHandler } from "./security-options";
import { isSessionPastAbsoluteExpiration } from "./session-policy";

const trailingSlashPattern = /\/+$/;

function isEmailPasswordAuthRoute(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname.replace(trailingSlashPattern, "");
  const method = request.method.toUpperCase();

  if (method === "POST") {
    return [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/change-password",
      "/set-password",
      "/link-social",
    ].some((suffix) => path.endsWith(suffix));
  }

  if (method === "GET") {
    return (
      path.endsWith("/verify-email") ||
      resetPasswordCallbackPathPattern.test(path)
    );
  }

  return false;
}

export function isEmailPasswordAuthEnabled(bindings: WorkerBindings): boolean {
  return (
    bindings.EMAIL_PASSWORD_AUTH_ENABLED === "true" &&
    Boolean(bindings.RESEND_API_KEY?.trim() && bindings.AUTH_EMAIL_FROM?.trim())
  );
}
const resetPasswordCallbackPathPattern = /\/reset-password\/[^/]+$/;

async function isGoogleOAuthRequest(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const path = url.pathname.replace(trailingSlashPattern, "");

  if (path.endsWith("/callback/google")) {
    return true;
  }

  if (
    request.method !== "POST" ||
    !(path.endsWith("/sign-in/social") || path.endsWith("/link-social"))
  ) {
    return false;
  }

  const body = await request
    .clone()
    .json()
    .catch(() => null);

  return (
    typeof body === "object" &&
    body !== null &&
    "provider" in body &&
    (body as { provider?: unknown }).provider === "google"
  );
}

function isSetPasswordRequest(request: Request): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    new URL(request.url).pathname
      .replace(trailingSlashPattern, "")
      .endsWith("/set-password")
  );
}

export async function enforceAbsoluteSessionLifetime(
  auth: ReturnType<typeof createBetterAuth>,
  request: Request,
  now = Date.now()
): Promise<void> {
  const currentSession = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });

  if (
    !(
      currentSession &&
      isSessionPastAbsoluteExpiration(currentSession.session.createdAt, now)
    )
  ) {
    return;
  }

  await auth.api.revokeSession({
    body: { token: currentSession.session.token },
    headers: request.headers,
  });
}
export async function handleSetPasswordRequest(
  auth: ReturnType<typeof createBetterAuth>,
  request: Request
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { error: { code: "session_required" } },
      { status: 401 }
    );
  }
  if (session.user.emailVerified !== true) {
    return Response.json(
      { error: { code: "email_not_verified" } },
      { status: 403 }
    );
  }

  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const requestBody =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { newPassword?: unknown })
      : undefined;
  if (typeof requestBody?.newPassword !== "string") {
    return Response.json(
      { error: { code: "invalid_request_body" } },
      { status: 400 }
    );
  }

  try {
    const normalizedPassword = await validateNewPassword(
      requestBody.newPassword
    );
    return await auth.api.setPassword({
      asResponse: true,
      body: { newPassword: normalizedPassword },
      headers: request.headers,
    });
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      const details = passwordPolicyErrorDetails(error);
      return Response.json(
        {
          error: { code: details.code, message: details.message },
        },
        { status: details.status }
      );
    }

    throw error;
  }
}

export async function handleBetterAuthRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  const secret = bindings.BETTER_AUTH_SECRET;
  const baseURL = bindings.BETTER_AUTH_BASE_URL;
  const googleClientId = bindings.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = bindings.GOOGLE_CLIENT_SECRET?.trim();

  if (!secret || secret.length < 32 || !baseURL) {
    return Response.json(
      { error: { code: "auth_unavailable" } },
      { status: 503 }
    );
  }

  if (
    (await isGoogleOAuthRequest(request)) &&
    !(googleClientId && googleClientSecret)
  ) {
    return Response.json(
      { error: { code: "auth_provider_unavailable" } },
      { status: 503 }
    );
  }

  const resendApiKey = bindings.RESEND_API_KEY?.trim();
  const emailFrom = bindings.AUTH_EMAIL_FROM?.trim();
  const emailPasswordAuthEnabled = isEmailPasswordAuthEnabled(bindings);

  if (isEmailPasswordAuthRoute(request) && !emailPasswordAuthEnabled) {
    return Response.json(
      { error: { code: "auth_email_unavailable" } },
      { status: 503 }
    );
  }

  let authConnectionString: string;
  try {
    authConnectionString = resolveAuthConnectionString(bindings);
  } catch (error) {
    if (error instanceof AuthDatabaseNotConfiguredError) {
      logger.error("auth_database_not_configured", { requestId });
      return Response.json(
        { error: { code: "auth_unavailable" } },
        { status: 503 }
      );
    }
    throw error;
  }

  const { db, pool } = createDatabase(authConnectionString, {
    maxConnections: 1,
  });

  try {
    const auth = createBetterAuth({
      baseURL,
      database: db,
      ...(emailPasswordAuthEnabled
        ? {
            emailDelivery: createResendAuthEmailDelivery({
              apiKey: resendApiKey as string,
              from: emailFrom as string,
              ...(bindings.AUTH_EMAIL_REPLY_TO?.trim()
                ? { replyTo: bindings.AUTH_EMAIL_REPLY_TO.trim() }
                : {}),
            }),
          }
        : {}),
      ...(googleClientId && googleClientSecret
        ? {
            googleProvider: {
              accessType: "online",
              clientId: googleClientId,
              clientSecret: googleClientSecret,
              disableIdTokenSignIn: true,
              redirectURI: new URL(
                "/api/auth/callback/google",
                baseURL
              ).toString(),
            },
          }
        : {}),
      ...(requestId ? { requestId } : {}),
      ...(runInBackground ? { runInBackground } : {}),
      secret,
    });
    await enforceAbsoluteSessionLifetime(auth, request);
    if (isSetPasswordRequest(request)) {
      return await handleSetPasswordRequest(auth, request);
    }

    return await auth.handler(request);
  } finally {
    await pool.end();
  }
}
