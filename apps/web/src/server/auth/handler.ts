import { createDatabase } from "@polaris/db/client";
import { createBetterAuth } from "../auth";
import type { WorkerBindings } from "../environment";

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

  const { db, pool } = createDatabase(bindings.HYPERDRIVE.connectionString, {
    maxConnections: 1,
  });

  try {
    const auth = createBetterAuth({
      baseURL,
      database: db,
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
