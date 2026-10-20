import { logger } from "@polaris/observability/logger";
import { authSchema } from "@polaris/db/auth-schema";
import { bumpUserAuthorizationEpoch } from "@polaris/db/authorization-epoch";
import type { createDatabase } from "@polaris/db/client";
import { authSecurityAuditEvents } from "@polaris/db/security-audit-schema";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import type { GoogleOptions } from "better-auth/social-providers";
import {
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";
import { isSafeAuthCallbackPath } from "../lib/return-path";
import { hashPasswordNfc, verifyPasswordNfc } from "./auth/password-hash";
import {
  type AccessLogEvent,
  type AccessLogWriter,
  createDatabaseAccessLogWriter,
  guardAccessLogWriter,
  requestIp,
  requestIpForSessionRow,
} from "./auth/access-log";
import {
  normalizePassword,
  PasswordPolicyError,
  passwordPolicyErrorDetails,
  validateNewPassword,
} from "./auth/password-policy";
import {
  type BackgroundTaskHandler,
  betterAuthSecurityOptions,
} from "./auth/security-options";
import {
  SESSION_IDLE_TTL_SECONDS,
  SESSION_REFRESH_INTERVAL_SECONDS,
} from "./auth/session-policy";
import {
  type LegalAcceptanceQueryable,
  recordLegalAcceptance,
} from "./legal-acceptance";
import { logServerError } from "./observability/server-log";

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
/** Records the acceptance, at sign-up, of the version in force of one legal document. */
type SignUpLegalAcceptanceRecorder = (entry: {
  document: LegalDocumentId;
  userId: string;
}) => Promise<unknown>;
/** Invalidates every offline lease of a user after a security event. */
type AuthorizationEpochBumper = (userId: string) => Promise<void>;

interface CreateBetterAuthOptions {
  /** Appends the record of access (ADR 0092); the default writes through `database`, none without one. */
  accessLogWriter?: AccessLogWriter;
  auditEventWriter?: AuthSecurityAuditEventWriter;
  authorizationEpochBumper?: AuthorizationEpochBumper;
  baseURL: string;
  database?: PolarisDatabase;
  databaseAdapter?: BetterAuthOptions["database"];
  emailDelivery?: AuthEmailDelivery;
  googleProvider?: GoogleOptions;
  /** Records the acceptance given at sign-up; the default writes through `database`, none without one. */
  legalAcceptanceRecorder?: SignUpLegalAcceptanceRecorder;
  plugins?: BetterAuthOptions["plugins"];
  requestId?: string;
  runInBackground?: BackgroundTaskHandler;
  secret: string;
}

interface AuthHookContext {
  newSession?: { user?: { id?: string } };
  returned?: unknown;
  session?: {
    session?: { userId?: string };
    user?: { emailVerified?: boolean; id?: string };
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

const authRedirectFields = [
  "callbackURL",
  "errorCallbackURL",
  "newUserCallbackURL",
  "redirectTo",
] as const;

/**
 * Better Auth only checks that a redirect target is a path of this origin. The app goes further: the
 * target has to be a path of the app (never `/api`, `/rpc`, a host, a scheme or a control character),
 * and the destination carried by the sign-in page in `voltar` has to be a valid return path too.
 * A refusal is a 403 and never a redirect.
 */
function validateAuthRedirectTargets(context: AuthBeforeHookContext): void {
  for (const source of [asRecord(context.body), asRecord(context.query)]) {
    for (const field of authRedirectFields) {
      const target = source?.[field];
      if (target !== undefined && !isSafeAuthCallbackPath(target)) {
        throw APIError.from("FORBIDDEN", {
          code: "invalid_redirect_target",
          message: "The redirect target is not a path of this app.",
        });
      }
    }
  }
}

/**
 * The sign-up carries `legalAcceptance: { terms, privacy }` with the versions in force (ADR 0100,
 * AC-68): without them, or with another version, it is refused before any user is created. The box
 * on the screen is not the proof; this is.
 */
function validateSignUpLegalAcceptance(context: AuthBeforeHookContext): void {
  if (context.path !== "/sign-up/email") {
    return;
  }
  const acceptance = asRecord(asRecord(context.body)?.legalAcceptance);
  const accepted =
    acceptance !== undefined &&
    LEGAL_DOCUMENT_IDS.every(
      (document) => acceptance[document] === LEGAL_DOCUMENTS[document].version
    );
  if (!accepted) {
    throw APIError.from("BAD_REQUEST", {
      code: "legal_acceptance_required",
      message: "Accept the terms of use and the privacy policy in force.",
    });
  }
}

async function validateVerifiedAccountLinkingRequest(
  context: AuthBeforeHookContext
): Promise<void> {
  if (context.path !== "/link-social" && context.path !== "/set-password") {
    return;
  }

  const currentSession = (await getSessionFromCtx(
    context
  )) as unknown as AuthHookContext["session"];
  if (!currentSession?.user?.id) {
    throw APIError.from("UNAUTHORIZED", {
      code: "session_required",
      message: "Sign in before managing linked sign-in methods.",
    });
  }
  if (currentSession.user.emailVerified !== true) {
    throw APIError.from("FORBIDDEN", {
      code: "email_not_verified",
      message: "Verify your email before linking or adding a password.",
    });
  }

  if (context.path === "/link-social") {
    const requestBody = asRecord(context.body);
    if (requestBody?.provider !== "google") {
      throw APIError.from("BAD_REQUEST", {
        code: "provider_not_supported",
        message: "Only Google account linking is supported.",
      });
    }
    if (requestBody.idToken !== undefined) {
      throw APIError.from("BAD_REQUEST", {
        code: "oauth_redirect_required",
        message: "Link Google with the OAuth redirect flow.",
      });
    }
  }
}

function passwordPolicyApiError(error: PasswordPolicyError): APIError {
  const details = passwordPolicyErrorDetails(error);
  const status = details.status === 503 ? "SERVICE_UNAVAILABLE" : "BAD_REQUEST";

  return APIError.from(status, {
    code: details.code,
    message: details.message,
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

function googleCallbackRedirectLocation(returned: unknown): string | undefined {
  let status: number | undefined;
  let location: string | undefined;

  if (returned instanceof Response) {
    const { headers, status: responseStatus } = returned;
    status = responseStatus;
    location = headers.get("location") ?? undefined;
  } else if (isAPIError(returned)) {
    const redirect = returned as APIError & {
      headers?: Headers;
      statusCode?: number;
    };
    status = redirect.statusCode;
    location = redirect.headers?.get("location") ?? undefined;
  }

  if (status === undefined || status < 300 || status >= 400) {
    return undefined;
  }

  return location;
}

function isSuccessfulGoogleCallbackRedirect(returned: unknown): boolean {
  const location = googleCallbackRedirectLocation(returned);
  if (!location) {
    return false;
  }

  try {
    return !new URL(location, "http://localhost").searchParams.has("error");
  } catch {
    return false;
  }
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
  const { newSession, returned, session } = context;
  const user = newSession?.user;
  const actorId =
    user?.id ??
    session?.user?.id ??
    session?.session?.userId ??
    capturedLogoutActorId;

  if (typeof queryParams?.error === "string") {
    return {
      actorId: actorId ?? null,
      errorCode: "provider_error",
      eventType: "google_callback_failed",
      outcome: "failed",
      provider: "google",
      requestId,
    };
  }

  if (user?.id || isSuccessfulGoogleCallbackRedirect(returned)) {
    return {
      actorId: actorId ?? null,
      errorCode: null,
      eventType: "google_callback_succeeded",
      outcome: "succeeded",
      provider: "google",
      requestId,
    };
  }

  if (returned === undefined) {
    return undefined;
  }

  const errorCode = callbackErrorCode(returned);

  return {
    actorId: actorId ?? null,
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

/** What the access log records for a request the audit hook sees finish, besides the sessions the database hooks see. */
function accessLogEventFor(
  input: AuthAuditHookInput,
  auditEvent: AuthSecurityAuditEvent | undefined
): { event: AccessLogEvent; userId: string | null } | undefined {
  const { context, path } = input;

  if (path === "/sign-out") {
    // a logout without a known session has no user to record
    return auditEvent?.eventType === "logout_succeeded" && auditEvent.actorId
      ? { event: "logout", userId: auditEvent.actorId }
      : undefined;
  }
  if (path === "/sign-in/email") {
    const { returned } = context;
    const failed =
      isAPIError(returned) ||
      (returned instanceof Response && returned.status >= 400);
    // nobody looks a user up by e-mail on a failure: the row holds the IP and the request only
    return failed ? { event: "login_failed", userId: null } : undefined;
  }
  if (auditEvent?.eventType === "google_callback_failed") {
    // only the session this request carries, if any: `capturedLogoutActorId` is set on a sign-out, lives as long
    // as the auth instance and belongs to no callback, and the audit event's actor may have fallen back to it
    return {
      event: "login_failed",
      userId:
        context.session?.user?.id ?? context.session?.session?.userId ?? null,
    };
  }
  return undefined;
}

interface StoredSession {
  id?: string;
  ipAddress?: string | null;
  token?: string;
  userId?: string;
}

/** The session a `/get-session` answer carries, if it carries one. */
function sessionFromGetSession(returned: unknown): StoredSession | undefined {
  const session = asRecord(asRecord(returned)?.session);
  if (!session || typeof session.userId !== "string") {
    return undefined;
  }
  return session as StoredSession;
}

export function createBetterAuth({
  accessLogWriter,
  auditEventWriter,
  authorizationEpochBumper,
  baseURL,
  database,
  databaseAdapter,
  emailDelivery,
  googleProvider,
  legalAcceptanceRecorder,
  plugins,
  requestId,
  runInBackground,
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

  // Without a database or a writer (the test adapter) nothing is recorded.
  const accessLogEnabled = Boolean(accessLogWriter ?? database);
  const writeAccessLog: AccessLogWriter = guardAccessLogWriter(
    accessLogWriter ??
      (database
        ? createDatabaseAccessLogWriter(database.$client)
        : () => Promise.resolve(false))
  );
  // The last IP recorded for a session by this instance (one per request in production, so it only keeps one
  // request from recording the same change twice); the session row keeps it between requests.
  const recordedSessionIps = new Map<string, string>();
  // the update requests that extend a session (the daily refresh), told apart from the other updates of a session
  const refreshing = new WeakSet<object>();

  // A password reset revokes every offline lease of the user (plan section 56):
  // the database function bumps the epoch of the memberships and revokes the
  // live grants. Without a database (the test adapter) there is nothing to bump.
  const bumpAuthorizationEpoch =
    authorizationEpochBumper ??
    (database
      ? async (userId: string) => {
          await bumpUserAuthorizationEpoch(database, userId);
        }
      : undefined);

  // The acceptance given at sign-up is recorded once the user exists. Without a database or a recorder (the
  // test adapter) nothing is recorded.
  const recordSignUpAcceptance: SignUpLegalAcceptanceRecorder | undefined =
    legalAcceptanceRecorder ??
    (database
      ? (entry) =>
          recordLegalAcceptance(
            database.$client as unknown as LegalAcceptanceQueryable,
            { ...entry, origin: "signup", requestId: safeRequestId }
          )
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
    validateAuthRedirectTargets(context);
    validateSignUpLegalAcceptance(context);
    await validateVerifiedAccountLinkingRequest(context);
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
    if (
      isGoogleCallbackPath(context.path, context.params) &&
      !authContext.newSession?.user?.id &&
      googleCallbackRedirectLocation(authContext.returned) !== undefined &&
      !authContext.session?.user?.id
    ) {
      try {
        const callbackSession = (await getSessionFromCtx(context)) as unknown as
          | AuthHookContext["session"]
          | null;
        if (callbackSession) {
          authContext.session = callbackSession;
        }
      } catch {
        // A successful OAuth callback can be a link flow with an existing session.
      }
    }
    const event = buildAuthSecurityAuditEvent({
      body: context.body,
      capturedLogoutActorId,
      context: authContext,
      params: context.params,
      path: context.path,
      query: context.query,
      requestId: safeRequestId,
    });

    if (accessLogEnabled) {
      const accessEvent = accessLogEventFor(
        {
          body: context.body,
          capturedLogoutActorId,
          context: authContext,
          params: context.params,
          path: context.path,
          query: context.query,
          requestId: safeRequestId,
        },
        event
      );
      // before the audit event: a failure of that write must not leave the access unrecorded
      if (accessEvent) {
        await writeAccessLog({
          ...accessEvent,
          ip: requestIp(context.headers ?? context.request?.headers),
          requestId: safeRequestId,
        });
      }
      if (context.path === "/get-session") {
        await recordSessionIpChange(context, authContext.returned);
      }
    }

    if (event) {
      await writeAuditEvent(event);
    }
  });

  // A request from another IP than the one the session row holds is an access of its own: it is recorded when
  // it happens, not only at the daily refresh, and the row then holds the new IP (so the next request of the
  // same IP costs nothing). Without a record, the row is left as it was and the next request tries again: that holds
  // for the daily refresh as well, which leaves the row with the old IP when its own record failed.
  async function recordSessionIpChange(
    context: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
    returned: unknown
  ): Promise<void> {
    const session = sessionFromGetSession(returned);
    const headers = context.headers ?? context.request?.headers;
    const ip = requestIp(headers);
    const rowIp = requestIpForSessionRow(headers);
    if (
      !(session?.id && session.token && session.userId && ip && rowIp) ||
      session.ipAddress === rowIp
    ) {
      return;
    }
    // the refresh of this very request may have recorded the IP already: then only the row is left to update
    const recorded =
      recordedSessionIps.get(session.id) === ip ||
      (await writeAccessLog({
        event: "session_refreshed",
        ip,
        requestId: safeRequestId,
        userId: session.userId,
      }));
    if (!recorded) {
      return;
    }
    recordedSessionIps.set(session.id, ip);
    try {
      await (
        context.context as unknown as {
          internalAdapter: {
            updateSession: (
              token: string,
              data: { ipAddress: string }
            ) => Promise<unknown>;
          };
        }
      ).internalAdapter.updateSession(session.token, { ipAddress: rowIp });
    } catch (error) {
      logServerError({
        error,
        method: "GET",
        requestId: safeRequestId,
        route: "/api/auth/get-session",
      });
    }
  }

  return betterAuth({
    account: {
      accountLinking: {
        allowDifferentEmails: false,
        disableImplicitLinking: true,
        enabled: true,
        requireLocalEmailVerified: true,
        trustedProviders: [],
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
    },
    ...betterAuthSecurityOptions(baseURL, runInBackground),
    appName: "Polaris",
    baseURL,
    database: resolvedDatabase,
    databaseHooks: {
      session: {
        create: {
          after: async (session, hookContext) => {
            await writeAccessLog({
              event: "login_succeeded",
              ip: requestIp(
                hookContext?.headers ?? hookContext?.request?.headers
              ),
              requestId: safeRequestId,
              userId: session.userId,
            });
          },
        },
        update: {
          // the session is extended once a day of use (`updateAge`): that is the daily record of access, with the
          // IP of this request. The row takes the IP only when `/get-session` has seen the record made
          before: (data, hookContext) => {
            if (accessLogEnabled && data.expiresAt && hookContext) {
              refreshing.add(hookContext);
            }
            return Promise.resolve();
          },
          after: async (session, hookContext) => {
            if (!(session && hookContext && refreshing.delete(hookContext))) {
              return;
            }
            const ip = requestIp(
              hookContext.headers ?? hookContext.request?.headers
            );
            // the hooks of the update run after the ones of `/get-session`, which may have recorded this IP already
            if (ip && recordedSessionIps.get(session.id) === ip) {
              return;
            }
            const recorded = await writeAccessLog({
              event: "session_refreshed",
              ip,
              requestId: safeRequestId,
              userId: session.userId,
            });
            if (recorded && ip) {
              recordedSessionIps.set(session.id, ip);
            }
          },
        },
      },
      account: {
        create: {
          before: async (data) => ({ data: { ...data, idToken: null } }),
        },
        update: {
          before: async (data) => ({ data: { ...data, idToken: null } }),
        },
      },
      user: {
        create: {
          // Only the sign-up by email carries an acceptance (checked by the before hook). A failed record
          // leaves the user without it: the acceptance control then asks for it at the first access,
          // because what lets the person in is the row, never this request.
          after: async (user, hookContext) => {
            if (
              hookContext?.path !== "/sign-up/email" ||
              !recordSignUpAcceptance
            ) {
              return;
            }
            try {
              for (const document of LEGAL_DOCUMENT_IDS) {
                // biome-ignore lint/performance/noAwaitInLoops: two rows, one after the other
                await recordSignUpAcceptance({ document, userId: user.id });
              }
            } catch (error) {
              logServerError({
                error,
                method: "POST",
                requestId: safeRequestId,
                route: "/api/auth/sign-up/email",
              });
            }
          },
        },
      },
    },
    emailAndPassword: emailDelivery
      ? {
          autoSignIn: false,
          enabled: true,
          maxPasswordLength: 256,
          minPasswordLength: 1,
          onPasswordReset: async ({ user }) => {
            // Better Auth revokes the sessions only after this hook returns, so a
            // failure here must never escape: the password is already changed and
            // the reset token consumed. Sessions are what authorize a sync, so
            // revoking them still makes every offline lease useless; the failed
            // bump is logged for the operator to see.
            try {
              await bumpAuthorizationEpoch?.(user.id);
            } catch (error) {
              logServerError({
                error,
                method: "POST",
                requestId: "password-reset",
                route: "/api/auth/reset-password",
              });
            }
          },
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
    hooks: { after: auditHook, before: captureLogoutSession },
    logger: {
      level: "error",
      log: (level) =>
        logger.error("better_auth_internal_error", { logLevel: level }),
    },
    session: {
      cookieCache: { enabled: false },
      expiresIn: SESSION_IDLE_TTL_SECONDS,
      freshAge: SESSION_REFRESH_INTERVAL_SECONDS,
      updateAge: SESSION_REFRESH_INTERVAL_SECONDS,
    },
    ...(googleProvider ? { socialProviders: { google: googleProvider } } : {}),
    ...(plugins ? { plugins } : {}),
    secret,
  });
}
