import { authSchema } from "@polaris/db/auth-schema";
import { authSecurityAuditEvents } from "@polaris/db/security-audit-schema";
import type { createDatabase } from "@polaris/db/client";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import type { GoogleOptions } from "better-auth/social-providers";
import {
  normalizePassword,
  PasswordPolicyError,
  validateNewPassword,
} from "./auth/password-policy";
import { hashPasswordNfc, verifyPasswordNfc } from "./auth/password-hash";
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

type EmailVerificationSender = NonNullable<
  NonNullable<BetterAuthOptions["emailVerification"]>["sendVerificationEmail"]
>;
type PasswordResetSender = NonNullable<
  NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"]
>;

export interface AuthEmailDelivery {
  sendPasswordReset: PasswordResetSender;
  sendVerificationEmail: EmailVerificationSender;
}
type AuthSecurityAuditEventWriter = (
  event: AuthSecurityAuditEvent
) => Promise<void>;

interface CreateBetterAuthOptions {
  auditEventWriter?: AuthSecurityAuditEventWriter;
  baseURL: string;
  database?: PolarisDatabase;
  databaseAdapter?: BetterAuthOptions["database"];
  emailDelivery?: AuthEmailDelivery;
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

function passwordFieldForPath(
  path: string
): "newPassword" | "password" | undefined {
  if (path === "/sign-in/email" || path === "/sign-up/email") {
    return "password";
  }

  if (
    path === "/reset-password" ||
    path === "/change-password" ||
    path === "/set-password"
  ) {
    return "newPassword";
  }

  return undefined;
}

interface PasswordResetVerification {
  expiresAt: Date;
}

interface PasswordResetStore {
  findVerificationValue: (
    identifier: string
  ) => Promise<PasswordResetVerification | null>;
}

type AuthBeforeHookContext = Parameters<typeof getSessionFromCtx>[0];

function passwordResetTokenFromContext(
  context: AuthBeforeHookContext
): string | undefined {
  const body = asRecord(context.body);
  const query = asRecord(context.query);

  if (typeof body?.token === "string") {
    return body.token;
  }

  if (typeof query?.token === "string") {
    return query.token;
  }

  return undefined;
}

async function hasValidPasswordResetToken(
  context: AuthBeforeHookContext
): Promise<boolean> {
  const token = passwordResetTokenFromContext(context);

  if (!token) {
    return false;
  }

  const authContext = context.context as {
    internalAdapter?: PasswordResetStore;
  };
  const verification = await authContext.internalAdapter?.findVerificationValue(
    `reset-password:${token}`
  );

  return Boolean(verification && verification.expiresAt > new Date());
}

async function shouldCheckPasswordAgainstHibp(
  context: AuthBeforeHookContext
): Promise<boolean> {
  if (context.path === "/reset-password") {
    return hasValidPasswordResetToken(context);
  }

  if (context.path === "/change-password" || context.path === "/set-password") {
    return Boolean(await getSessionFromCtx(context));
  }

  return true;
}

function normalizeExistingPasswordField(
  requestBody: Record<string, unknown>,
  field: "currentPassword" | "password"
): void {
  const existingPassword = requestBody[field];

  if (typeof existingPassword !== "string") {
    return;
  }

  try {
    requestBody[field] = normalizePassword(existingPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw passwordPolicyApiError(error);
    }

    throw error;
  }
}
async function normalizeAndValidatePasswordRequest(
  context: AuthBeforeHookContext
): Promise<void> {
  const requestBody = asRecord(context.body);

  if (!requestBody) {
    return;
  }

  if (context.path === "/change-password") {
    normalizeExistingPasswordField(requestBody, "currentPassword");
  }

  if (
    context.path === "/sign-in/email" ||
    context.path === "/verify-password"
  ) {
    normalizeExistingPasswordField(requestBody, "password");
    return;
  }

  const passwordField = passwordFieldForPath(context.path);
  if (!passwordField) {
    return;
  }

  const rawPassword = requestBody[passwordField];
  if (typeof rawPassword !== "string") {
    return;
  }

  if (!(await shouldCheckPasswordAgainstHibp(context))) {
    return;
  }

  try {
    requestBody[passwordField] = await validateNewPassword(rawPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw passwordPolicyApiError(error);
    }

    throw error;
  }
}

function passwordPolicyApiError(error: PasswordPolicyError): APIError {
  const status =
    error.code === "password_hibp_unavailable"
      ? "SERVICE_UNAVAILABLE"
      : "BAD_REQUEST";
  const messages = {
    password_compromised:
      "Choose a password that has not appeared in a breach.",
    password_hibp_unavailable:
      "Password validation is temporarily unavailable.",
    password_invalid_unicode: "Password contains unsupported Unicode.",
    password_too_long: "Password exceeds the maximum length.",
    password_too_short: "Password does not meet the minimum length.",
  } satisfies Record<PasswordPolicyError["code"], string>;

  return APIError.from(status, {
    code: error.code,
    message: messages[error.code],
  });
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
  emailDelivery,
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
    await normalizeAndValidatePasswordRequest(context);

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
    emailAndPassword: emailDelivery
      ? {
          autoSignIn: false,
          enabled: true,
          maxPasswordLength: 256,
          minPasswordLength: 1,
          password: {
            hash: hashPasswordNfc,
            verify: verifyPasswordNfc,
          },
          requireEmailVerification: true,
          resetPasswordTokenExpiresIn: 60 * 60,
          revokeSessionsOnPasswordReset: true,
          sendResetPassword: emailDelivery.sendPasswordReset,
        }
      : { enabled: false },
    emailVerification: emailDelivery
      ? {
          autoSignInAfterVerification: false,
          expiresIn: 24 * 60 * 60,
          sendOnSignIn: false,
          sendOnSignUp: true,
          sendVerificationEmail: emailDelivery.sendVerificationEmail,
        }
      : undefined,
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
