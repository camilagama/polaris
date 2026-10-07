import { authSchema } from "@polaris/db/auth-schema";
import { authSecurityAuditEvents } from "@polaris/db/security-audit-schema";
import type { createDatabase } from "@polaris/db/client";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import type { GoogleOptions } from "better-auth/social-providers";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

type PolarisDatabase = ReturnType<typeof createDatabase>["db"];

const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export interface AuthSecurityAuditEvent {
  actorId: string | null;
  errorCode:
    | "callback_failed"
    | "invalid_callback"
    | "logout_failed"
    | "provider_error"
    | null;
  eventType:
    | "google_callback_failed"
    | "google_callback_succeeded"
    | "google_login_started"
    | "logout_failed"
    | "logout_succeeded";
  outcome: "failed" | "started" | "succeeded";
  provider: "google" | null;
  requestId: string;
}

type AuthSecurityAuditEventWriter = (
  event: AuthSecurityAuditEvent
) => Promise<void>;

interface CreateBetterAuthOptions {
  auditEventWriter?: AuthSecurityAuditEventWriter;
  baseURL: string;
  database?: PolarisDatabase;
  databaseAdapter?: BetterAuthOptions["database"];
  googleProvider?: GoogleOptions;
  plugins?: BetterAuthOptions["plugins"];
  requestId?: string;
  secret: string;
}

interface AuthHookContext {
  newSession?: { user?: { id?: string } };
  returned?: unknown;
  session?: {
    session?: { userId?: string };
    user?: { id?: string };
  };
}

interface AuthAuditHookInput {
  body?: unknown;
  capturedLogoutActorId: string | null;
  context: AuthHookContext;
  params?: unknown;
  path: string;
  query?: unknown;
  requestId: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeRequestId(requestId: string | undefined): string {
  if (requestId && requestIdPattern.test(requestId)) {
    return requestId;
  }

  return crypto.randomUUID();
}

function isGoogleCallbackPath(path: string, params: unknown): boolean {
  if (path === "/callback/google" || path.endsWith("/callback/google")) {
    return true;
  }

  if (path !== "/callback/:id" && !path.endsWith("/callback/:id")) {
    return false;
  }

  const routeParams = asRecord(params);
  return routeParams?.id === "google";
}

function callbackErrorCode(
  returned: unknown
): AuthSecurityAuditEvent["errorCode"] {
  let code = "";

  if (isAPIError(returned)) {
    const { body } = returned as { body?: { code?: unknown } };
    code = typeof body?.code === "string" ? body.code.toLowerCase() : "";
  } else if (
    typeof returned === "object" &&
    returned !== null &&
    "code" in returned
  ) {
    const { code: returnedCode } = returned as { code?: unknown };
    code = typeof returnedCode === "string" ? returnedCode.toLowerCase() : "";
  } else if (returned instanceof Response) {
    const location = returned.headers.get("location");

    if (location) {
      try {
        code =
          new URL(location, "http://localhost").searchParams
            .get("error")
            ?.toLowerCase() ?? "";
      } catch {
        code = "";
      }
    }
  }

  return [
    "state_not_found",
    "state_mismatch",
    "invalid_callback_request",
    "no_code",
  ].includes(code)
    ? "invalid_callback"
    : "callback_failed";
}

function googleLoginStartedEvent(
  input: AuthAuditHookInput
): AuthSecurityAuditEvent | undefined {
  const { body, capturedLogoutActorId, context, path, requestId } = input;
  const requestBody = asRecord(body);

  if (path !== "/sign-in/social" || requestBody?.provider !== "google") {
    return undefined;
  }

  const { session } = context;

  return {
    actorId:
      capturedLogoutActorId ??
      session?.user?.id ??
      session?.session?.userId ??
      null,
    errorCode: null,
    eventType: "google_login_started",
    outcome: "started",
    provider: "google",
    requestId,
  };
}

function googleCallbackEvent(
  input: AuthAuditHookInput
): AuthSecurityAuditEvent | undefined {
  const { capturedLogoutActorId, context, params, path, query, requestId } =
    input;

  if (!isGoogleCallbackPath(path, params)) {
    return undefined;
  }

  const queryParams = asRecord(query);
  const { newSession, returned } = context;
  const user = newSession?.user;
  const actorId = user?.id ?? null;

  if (actorId) {
    return {
      actorId,
      errorCode: null,
      eventType: "google_callback_succeeded",
      outcome: "succeeded",
      provider: "google",
      requestId,
    };
  }

  const errorCode =
    typeof queryParams?.error === "string"
      ? "provider_error"
      : callbackErrorCode(returned);

  return {
    actorId: capturedLogoutActorId,
    errorCode,
    eventType: "google_callback_failed",
    outcome: "failed",
    provider: "google",
    requestId,
  };
}

function logoutEvent(
  input: AuthAuditHookInput
): AuthSecurityAuditEvent | undefined {
  const { capturedLogoutActorId, context, path, requestId } = input;

  if (path !== "/sign-out") {
    return undefined;
  }

  const { returned, session } = context;
  const sessionData = session?.session;
  const sessionUser = session?.user;
  const failed =
    isAPIError(returned) ||
    (returned instanceof Response && returned.status >= 400);

  return {
    actorId:
      capturedLogoutActorId ?? sessionUser?.id ?? sessionData?.userId ?? null,
    errorCode: failed ? "logout_failed" : null,
    eventType: failed ? "logout_failed" : "logout_succeeded",
    outcome: failed ? "failed" : "succeeded",
    provider: null,
    requestId,
  };
}

function buildAuthSecurityAuditEvent(
  input: AuthAuditHookInput
): AuthSecurityAuditEvent | undefined {
  return (
    googleLoginStartedEvent(input) ??
    googleCallbackEvent(input) ??
    logoutEvent(input)
  );
}

export function createBetterAuth({
  auditEventWriter,
  baseURL,
  database,
  databaseAdapter,
  googleProvider,
  plugins,
  requestId,
  secret,
}: CreateBetterAuthOptions) {
  const safeRequestId = normalizeRequestId(requestId);
  const writeAuditEvent =
    auditEventWriter ??
    (database
      ? async (event: AuthSecurityAuditEvent) => {
          await database.insert(authSecurityAuditEvents).values(event);
        }
      : undefined);

  if (!writeAuditEvent) {
    throw new Error(
      "An audit event writer is required for the test database adapter."
    );
  }

  const resolvedDatabase =
    databaseAdapter ??
    (database
      ? drizzleAdapter(database, {
          provider: "pg",
          schema: authSchema,
        })
      : undefined);

  if (!resolvedDatabase) {
    throw new Error("A Better Auth database adapter is required.");
  }

  let capturedLogoutActorId: string | null = null;
  const captureLogoutSession = createAuthMiddleware(async (context) => {
    if (context.path !== "/sign-out") {
      return;
    }

    const currentSession = (await getSessionFromCtx(
      context
    )) as unknown as AuthHookContext["session"];
    const { session, user } = currentSession ?? {};
    capturedLogoutActorId = user?.id ?? session?.userId ?? null;
  });

  const auditHook = createAuthMiddleware(async (context) => {
    const authContext = context.context as unknown as AuthHookContext;
    const event = buildAuthSecurityAuditEvent({
      body: context.body,
      capturedLogoutActorId,
      context: authContext,
      params: context.params,
      path: context.path,
      query: context.query,
      requestId: safeRequestId,
    });

    if (event) {
      await writeAuditEvent(event);
    }
  });

  return betterAuth({
    account: {
      accountLinking: { enabled: false },
      encryptOAuthTokens: true,
    },
    appName: "Polaris",
    baseURL,
    database: resolvedDatabase,
    databaseHooks: {
      account: {
        create: {
          before: async (data) => ({ data: { ...data, idToken: null } }),
        },
        update: {
          before: async (data) => ({ data: { ...data, idToken: null } }),
        },
      },
    },
    emailAndPassword: { enabled: false },
    hooks: { before: captureLogoutSession, after: auditHook },
    logger: {
      level: "error",
      log: (level) => console.error("better_auth_internal_error", level),
    },
    ...(googleProvider ? { socialProviders: { google: googleProvider } } : {}),
    ...(plugins ? { plugins } : {}),
    secret,
  });
}
