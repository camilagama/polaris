import { createDatabase } from "@polaris/db/client";
import { createBetterAuth } from "../auth";
import { createResendAuthEmailDelivery } from "./email";
import type { WorkerBindings } from "../environment";

function isEmailPasswordRoute(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "POST") {
    return [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/change-password",
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
const resetPasswordCallbackPathPattern = /\/reset-password\/[^/]+$/;

async function isGoogleOAuthRequest(request: Request): Promise<boolean> {
  const url = new URL(request.url);

  if (url.pathname.endsWith("/callback/google")) {
    return true;
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/sign-in/social")) {
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

export async function handleBetterAuthRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string
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
  const emailPasswordAuthEnabled =
    bindings.EMAIL_PASSWORD_AUTH_ENABLED === "true" &&
    Boolean(resendApiKey && emailFrom);

  if (isEmailPasswordRoute(request) && !emailPasswordAuthEnabled) {
    return Response.json(
      { error: { code: "auth_email_unavailable" } },
      { status: 503 }
    );
  }

  const { db, pool } = createDatabase(bindings.HYPERDRIVE.connectionString, {
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
              disableIdTokenSignIn: true,
              clientId: googleClientId,
              clientSecret: googleClientSecret,
              redirectURI: new URL(
                "/api/auth/callback/google",
                baseURL
              ).toString(),
            },
          }
        : {}),
      ...(requestId ? { requestId } : {}),
      secret,
    });
    return await auth.handler(request);
  } finally {
    await pool.end();
  }
}
