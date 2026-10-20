import { logger } from "@polaris/observability/logger";
import { bumpUserAuthorizationEpoch } from "@polaris/db/authorization-epoch";
import { createDatabase } from "@polaris/db/client";
import { isAPIError } from "better-auth/api";
import {
  type AuthSecurityAuditEventWriter,
  createBetterAuth,
  databaseAuditEventWriter,
  passwordAuditEvent,
} from "../auth";
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
import { logServerError } from "../observability/server-log";
import {
  createDatabaseAccessLogWriter,
  guardAccessLogWriter,
  requestIp,
} from "./access-log";
import {
  createResendAuthEmailDelivery,
  type PasswordAuthEmailDelivery,
} from "./email";
import {
  createDatabaseLoginLockStore,
  handleEmailSignInWithLock,
  isEmailSignInRequest,
  loginLockedResponse,
  responseErrorCode,
  type LoginLockQueryable,
  type LoginLockStore,
  newUnlockToken,
  sha256,
  unlockTokenUserId,
} from "./login-lock";
import { loginLockKey } from "./login-lock-key";
import type { BackgroundTaskHandler } from "./security-options";
import {
  isSessionFresh,
  isSessionPastAbsoluteExpiration,
} from "./session-policy";

type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

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

function isPostTo(request: Request, suffix: string): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    new URL(request.url).pathname
      .replace(trailingSlashPattern, "")
      .endsWith(suffix)
  );
}

/**
 * The two Better Auth routes that take the token in the URL (`GET /verify-email?token=` and
 * `GET /reset-password/<token>`). The e-mails link to pages of the app with the token in the fragment
 * and the token goes in the body of a POST (ADR 0100, T-f), so these stay closed: a token in a URL would
 * reach the Worker's log.
 */
function isTokenInUrlRoute(request: Request): boolean {
  if (request.method.toUpperCase() !== "GET") {
    return false;
  }
  const path = new URL(request.url).pathname.replace(trailingSlashPattern, "");
  return (
    path.endsWith("/verify-email") ||
    resetPasswordCallbackPathPattern.test(path)
  );
}

/**
 * `POST /verify-password` says whether a password is the current one for any live session, with no
 * lock and no fresh-session window: a stolen session could guess the password there. Nothing in the
 * app uses it, so it stays closed.
 */
function isClosedPasswordRoute(request: Request): boolean {
  return isPostTo(request, "/verify-password");
}

function safeRequestIdOf(requestId: string | undefined): string {
  return requestId && requestIdPattern.test(requestId)
    ? requestId
    : crypto.randomUUID();
}

async function jsonBody(
  request: Request
): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function jsonError(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    { headers: { "cache-control": "no-store" }, status }
  );
}

/** What the password flows do after a change, besides Better Auth: audit, leases and the notice. */
export interface PasswordChangeEffects {
  /** Invalidates every offline lease of the user (`bump_user_authorization_epoch`). */
  bumpAuthorizationEpoch: (userId: string) => Promise<unknown>;
  /** The sign-in lock: a wrong current password counts on the counter of the session's e-mail. */
  loginLock?: {
    secret: string;
    sendUnlock: (email: string, key: string) => Promise<void>;
    store: LoginLockStore;
  };
  requestId: string;
  runInBackground: (task: Promise<unknown>) => void;
  /** The e-mail that tells the owner of the account a password changed or was added. */
  sendPasswordNotice?: PasswordAuthEmailDelivery["sendPasswordNotice"];
  writeAuditEvent: AuthSecurityAuditEventWriter;
}

/** The session of a password change: signed in, with a verified e-mail and within the last 15 minutes. */
async function freshVerifiedSession(
  auth: BetterAuthInstance,
  request: Request
): Promise<
  | { response: Response }
  | {
      session: NonNullable<
        Awaited<ReturnType<BetterAuthInstance["api"]["getSession"]>>
      >;
    }
> {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) {
    return { response: jsonError(401, "session_required") };
  }
  if (session.user.emailVerified !== true) {
    return { response: jsonError(403, "email_not_verified") };
  }
  // The decision of 19/10/2026 (consolidation of the entry screen design, item 1): a password is
  // changed or added only by a session signed in within the last 15 minutes, as a device revocation.
  if (!isSessionFresh(session.session.createdAt)) {
    return { response: jsonError(403, "fresh_session_required") };
  }
  return { session };
}

async function recordPasswordEvent(
  effects: PasswordChangeEffects,
  eventType: "password_changed" | "password_set",
  user: { email: string; id: string },
  route: string
): Promise<void> {
  try {
    await effects.writeAuditEvent(
      passwordAuditEvent(eventType, user.id, effects.requestId)
    );
  } catch (error) {
    logServerError({
      error,
      method: "POST",
      requestId: effects.requestId,
      route,
    });
  }
  if (effects.sendPasswordNotice) {
    effects.runInBackground(
      effects.sendPasswordNotice({
        eventId: `${user.id}:${effects.requestId}`,
        kind: eventType === "password_changed" ? "changed" : "set",
        to: user.email,
      })
    );
  }
}

/**
 * The epoch of the leases changes after the password does. One retry; then the failure is logged for
 * the operator (the sessions already fell, so no sync passes with the old ones anyway).
 */
async function bumpEpochAfterPasswordChange(
  effects: PasswordChangeEffects,
  userId: string
): Promise<void> {
  try {
    await effects.bumpAuthorizationEpoch(userId);
  } catch {
    try {
      await effects.bumpAuthorizationEpoch(userId);
    } catch (error) {
      logServerError({
        error,
        method: "POST",
        requestId: effects.requestId,
        route: "/api/auth/change-password",
      });
    }
  }
}

/**
 * A change of password checks the current password, so it spends an attempt of the sign-in lock of the
 * session's e-mail (the same counter as the sign-in). The policy of the new password runs first, so a
 * refused new password never spends one.
 */
async function reserveChangePasswordAttempt(
  effects: PasswordChangeEffects,
  email: string,
  newPassword: string
): Promise<{ key?: string } | { response: Response }> {
  const { loginLock } = effects;
  if (!loginLock) {
    return {};
  }
  try {
    await validateNewPassword(newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      return { response: passwordPolicyResponse(error) };
    }
    throw error;
  }
  const key = await loginLockKey(loginLock.secret, email);
  const attempt = await loginLock.store.begin(key);
  if (!attempt.allowed) {
    if (attempt.newlyLocked) {
      effects.runInBackground(loginLock.sendUnlock(email, key));
    }
    return { response: loginLockedResponse(attempt.retryAfterSeconds) };
  }
  return { key };
}

/** A change that went through forgets the e-mail; a wrong current password counts as a failure. */
async function settleChangePasswordAttempt(
  effects: PasswordChangeEffects,
  email: string,
  key: string | undefined,
  response: Response
): Promise<void> {
  const { loginLock } = effects;
  if (!loginLock || key === undefined) {
    return;
  }
  // The password may have changed already: a failure of the lock is logged and the change goes on.
  try {
    if (response.ok) {
      await loginLock.store.clear(key);
    } else if (
      response.status === 400 &&
      (await responseErrorCode(response)) === "INVALID_PASSWORD" &&
      (await loginLock.store.failed(key))
    ) {
      effects.runInBackground(loginLock.sendUnlock(email, key));
    }
  } catch (error) {
    logServerError({
      error,
      method: "POST",
      requestId: effects.requestId,
      route: "/api/auth/change-password",
    });
  }
}

/**
 * The change of the password of a signed-in person (ADR 0044, item "baixo"; ADR 0100, T-b; AC-57).
 * Better Auth checks the current password and the policy runs in its `before` hook; here it always
 * revokes the other sessions (Better Auth then opens a new session for this device, with a new cookie),
 * changes the epoch of the leases, audits `password_changed` and sends the notice. The token of the new
 * session leaves the body: it only travels in the cookie.
 */
export async function handleChangePasswordRequest(
  auth: BetterAuthInstance,
  request: Request,
  effects: PasswordChangeEffects
): Promise<Response> {
  const checked = await freshVerifiedSession(auth, request);
  if ("response" in checked) {
    return checked.response;
  }
  const body = await jsonBody(request);
  if (
    typeof body?.currentPassword !== "string" ||
    typeof body.newPassword !== "string"
  ) {
    return jsonError(400, "invalid_request_body");
  }

  const { user } = checked.session;
  const reserved = await reserveChangePasswordAttempt(
    effects,
    user.email,
    body.newPassword
  );
  if ("response" in reserved) {
    return reserved.response;
  }

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete("content-length");
  const response = await auth.handler(
    new Request(request.url, {
      body: JSON.stringify({
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        revokeOtherSessions: true,
      }),
      headers: forwardedHeaders,
      method: "POST",
    })
  );
  await settleChangePasswordAttempt(
    effects,
    user.email,
    reserved.key,
    response
  );
  if (!response.ok) {
    return response;
  }

  await bumpEpochAfterPasswordChange(effects, user.id);
  await recordPasswordEvent(
    effects,
    "password_changed",
    user,
    "/api/auth/change-password"
  );

  const answer = (await response.json().catch(() => ({}))) as {
    user?: unknown;
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify({ user: answer.user ?? null }), {
    headers,
    status: response.status,
  });
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
  auth: BetterAuthInstance,
  request: Request,
  effects?: PasswordChangeEffects
): Promise<Response> {
  const checked = await freshVerifiedSession(auth, request);
  if ("response" in checked) {
    return checked.response;
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
    const response = await auth.api.setPassword({
      asResponse: true,
      body: { newPassword: normalizedPassword },
      headers: request.headers,
    });
    if (response.ok && effects) {
      // As a change: the other sessions end and the leases are invalidated; this session stays.
      try {
        await auth.api.revokeOtherSessions({ headers: request.headers });
      } catch (error) {
        logServerError({
          error,
          method: "POST",
          requestId: effects.requestId,
          route: "/api/auth/set-password",
        });
      }
      await bumpEpochAfterPasswordChange(effects, checked.session.user.id);
      await recordPasswordEvent(
        effects,
        "password_set",
        checked.session.user,
        "/api/auth/set-password"
      );
    }
    return response;
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      return passwordPolicyResponse(error);
    }

    throw error;
  }
}

function passwordPolicyResponse(error: PasswordPolicyError): Response {
  const details = passwordPolicyErrorDetails(error);
  return Response.json(
    {
      error: { code: details.code, message: details.message },
    },
    { status: details.status }
  );
}

interface AuthRuntime {
  auth: BetterAuthInstance;
  /** Ends the pool now, or after the background tasks when there are some. */
  close: () => Promise<void>;
  delivery?: PasswordAuthEmailDelivery;
  effects: PasswordChangeEffects;
  pool: LoginLockQueryable;
  requestId: string;
  runInBackground: (task: Promise<unknown>) => void;
  store: LoginLockStore;
}

type AuthRuntimeResult = { response: Response } | { runtime: AuthRuntime };

/**
 * Opens the authentication runtime of one request: the pool of the authentication role, Better Auth
 * and the stores of the password flows. A task in the background (an e-mail, the unlock of a lock)
 * still needs the pool after the response, so the pool ends once they all settle.
 */
function openAuthRuntime(
  bindings: WorkerBindings,
  requestId: string | undefined,
  runInBackground: BackgroundTaskHandler | undefined
): AuthRuntimeResult {
  const secret = bindings.BETTER_AUTH_SECRET;
  const baseURL = bindings.BETTER_AUTH_BASE_URL;
  if (!secret || secret.length < 32 || !baseURL) {
    return { response: jsonError(503, "auth_unavailable") };
  }
  const googleClientId = bindings.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = bindings.GOOGLE_CLIENT_SECRET?.trim();
  const resendApiKey = bindings.RESEND_API_KEY?.trim();
  const emailFrom = bindings.AUTH_EMAIL_FROM?.trim();

  let authConnectionString: string;
  try {
    authConnectionString = resolveAuthConnectionString(bindings);
  } catch (error) {
    if (error instanceof AuthDatabaseNotConfiguredError) {
      logger.error("auth_database_not_configured", { requestId });
      return { response: jsonError(503, "auth_unavailable") };
    }
    throw error;
  }

  const safeRequestId = safeRequestIdOf(requestId);
  const { db, pool } = createDatabase(authConnectionString, {
    maxConnections: 1,
  });
  const pending: Promise<unknown>[] = [];
  const background = (task: Promise<unknown>) => {
    const settled = task.catch((error: unknown) => {
      logServerError({
        error,
        method: "POST",
        requestId: safeRequestId,
        route: "/api/auth/background",
      });
    });
    pending.push(settled);
    runInBackground?.(settled);
  };
  const delivery = isEmailPasswordAuthEnabled(bindings)
    ? createResendAuthEmailDelivery({
        apiKey: resendApiKey as string,
        appBaseURL: baseURL,
        from: emailFrom as string,
        ...(bindings.AUTH_EMAIL_REPLY_TO?.trim()
          ? { replyTo: bindings.AUTH_EMAIL_REPLY_TO.trim() }
          : {}),
      })
    : undefined;

  let auth: BetterAuthInstance;
  try {
    auth = createBetterAuth({
      baseURL,
      database: db,
      ...(delivery ? { emailDelivery: delivery } : {}),
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
      requestId: safeRequestId,
      runInBackground: background,
      secret,
    });
  } catch (error) {
    pool.end().catch(() => undefined);
    throw error;
  }

  const store = createDatabaseLoginLockStore(
    pool as unknown as LoginLockQueryable
  );
  const opened: { runtime: AuthRuntime } = {
    runtime: {
      auth,
      async close() {
        if (pending.length === 0) {
          await pool.end();
          return;
        }
        const ended = Promise.allSettled(pending)
          .then(() => pool.end())
          .catch(() => undefined);
        if (runInBackground) {
          runInBackground(ended);
        } else {
          await ended;
        }
      },
      ...(delivery ? { delivery } : {}),
      effects: {
        bumpAuthorizationEpoch: (userId) =>
          bumpUserAuthorizationEpoch(db, userId),
        loginLock: {
          secret,
          sendUnlock: (email, key) =>
            sendLoginUnlock(opened.runtime, email, key),
          store,
        },
        requestId: safeRequestId,
        runInBackground: background,
        ...(delivery
          ? { sendPasswordNotice: delivery.sendPasswordNotice }
          : {}),
        writeAuditEvent: databaseAuditEventWriter(db),
      },
      pool: pool as unknown as LoginLockQueryable,
      requestId: safeRequestId,
      runInBackground: background,
      store,
    },
  };
  return opened;
}

/**
 * The unlock e-mail of a lock that just began (in the background, so the time of the answer never says
 * whether the e-mail has an account). Only an account with a password gets it, once per lock: the token
 * is stored first, and only a stored token is sent. The lock is audited with the account's ID.
 */
async function sendLoginUnlock(
  runtime: AuthRuntime,
  email: string,
  key: string
): Promise<void> {
  if (!runtime.delivery) {
    return;
  }
  const context = await runtime.auth.$context;
  const found = await context.internalAdapter.findUserByEmail(
    email.toLowerCase(),
    { includeAccounts: true }
  );
  // Only a verified account with a password: a lock of an address nobody proved never mails its owner.
  if (
    !(
      found?.user.emailVerified &&
      found.accounts.some((account) => account.providerId === "credential")
    )
  ) {
    return;
  }
  const token = newUnlockToken(found.user.id);
  if (!(await runtime.store.issueUnlock(key, await sha256(token)))) {
    return;
  }
  await runtime.delivery.sendLoginUnlock({ to: found.user.email, token });
  await runtime.effects.writeAuditEvent(
    passwordAuditEvent("login_locked", found.user.id, runtime.requestId)
  );
}

export async function handleBetterAuthRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  const googleClientId = bindings.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = bindings.GOOGLE_CLIENT_SECRET?.trim();
  const secret = bindings.BETTER_AUTH_SECRET;

  if (!secret || secret.length < 32 || !bindings.BETTER_AUTH_BASE_URL) {
    return jsonError(503, "auth_unavailable");
  }

  if (
    (await isGoogleOAuthRequest(request)) &&
    !(googleClientId && googleClientSecret)
  ) {
    return jsonError(503, "auth_provider_unavailable");
  }

  if (
    isEmailPasswordAuthRoute(request) &&
    !isEmailPasswordAuthEnabled(bindings)
  ) {
    return jsonError(503, "auth_email_unavailable");
  }
  if (isTokenInUrlRoute(request) || isClosedPasswordRoute(request)) {
    return jsonError(404, "not_found");
  }

  const opened = openAuthRuntime(bindings, requestId, runInBackground);
  if ("response" in opened) {
    return opened.response;
  }
  const { runtime } = opened;
  const { auth } = runtime;

  try {
    await enforceAbsoluteSessionLifetime(auth, request);
    if (isPostTo(request, "/set-password")) {
      return await handleSetPasswordRequest(auth, request, runtime.effects);
    }
    if (isPostTo(request, "/change-password")) {
      return await handleChangePasswordRequest(auth, request, runtime.effects);
    }
    if (isEmailSignInRequest(request)) {
      const writeAccessLog = guardAccessLogWriter(
        createDatabaseAccessLogWriter(runtime.pool)
      );
      return await handleEmailSignInWithLock(request, {
        recordRefusal: () =>
          writeAccessLog({
            event: "login_failed",
            ip: requestIp(request.headers),
            requestId: runtime.requestId,
            userId: null,
          }),
        runInBackground: runtime.runInBackground,
        secret,
        sendUnlock: (email, key) => sendLoginUnlock(runtime, email, key),
        onSettleError: (error) =>
          logServerError({
            error,
            method: "POST",
            requestId: runtime.requestId,
            route: "/api/auth/sign-in/email",
          }),
        signIn: (signInRequest) => auth.handler(signInRequest),
        store: runtime.store,
      });
    }

    return await auth.handler(request);
  } finally {
    await runtime.close();
  }
}

/**
 * The routes of the links of the e-mails sit outside `/api/auth/*` (ADR 0100): the page of the app
 * reads the token from the fragment and posts it here. Both answer 503 while the password is off.
 */
function passwordLinkRuntime(
  bindings: WorkerBindings,
  requestId: string | undefined,
  runInBackground: BackgroundTaskHandler | undefined
): AuthRuntimeResult {
  if (!isEmailPasswordAuthEnabled(bindings)) {
    return { response: jsonError(503, "auth_email_unavailable") };
  }
  return openAuthRuntime(bindings, requestId, runInBackground);
}

const LINK_TOKEN_MAX_LENGTH = 4096;

async function linkToken(request: Request): Promise<string | undefined> {
  const token = (await jsonBody(request))?.token;
  return typeof token === "string" &&
    token.length > 0 &&
    token.length <= LINK_TOKEN_MAX_LENGTH
    ? token
    : undefined;
}

/**
 * `POST /api/login-unlock {token}`: the link of the unlock e-mail (AC-64). One token frees the lock it
 * was issued for, within its hour; the same token again answers `unlocked` too. Any other token is the
 * same 400, so the answer says nothing about an e-mail or an account.
 */
export async function handleLoginUnlockRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  const opened = passwordLinkRuntime(bindings, requestId, runInBackground);
  if ("response" in opened) {
    return opened.response;
  }
  const { runtime } = opened;
  try {
    return await unlockWithToken(request, {
      requestId: runtime.requestId,
      store: runtime.store,
      writeAuditEvent: runtime.effects.writeAuditEvent,
    });
  } finally {
    await runtime.close();
  }
}

/** The unlock itself, given the lock and the audit: 200 `unlocked` or the one 400. */
export async function unlockWithToken(
  request: Request,
  {
    requestId,
    store,
    writeAuditEvent,
  }: {
    requestId: string;
    store: Pick<LoginLockStore, "unlock">;
    writeAuditEvent: AuthSecurityAuditEventWriter;
  }
): Promise<Response> {
  const token = await linkToken(request);
  const userId = token === undefined ? undefined : unlockTokenUserId(token);
  if (
    token === undefined ||
    userId === undefined ||
    (await store.unlock(await sha256(token))) !== "unlocked"
  ) {
    return jsonError(400, "unlock_link_invalid");
  }
  try {
    await writeAuditEvent(
      passwordAuditEvent("login_unlocked", userId, requestId)
    );
  } catch (error) {
    logServerError({
      error,
      method: "POST",
      requestId,
      route: "/api/login-unlock",
    });
  }
  return Response.json(
    { status: "unlocked" },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * `POST /api/email-verification {token}`: the link of the verification e-mail (AC-48), which Better
 * Auth checks on the server (`verifyEmail`), so the token never sits in a URL. A token used before
 * answers `verified` again (a reload never shows a false "link expired"); an expired one says so,
 * so the page offers a new e-mail.
 */
export async function handleEmailVerificationRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  const opened = passwordLinkRuntime(bindings, requestId, runInBackground);
  if ("response" in opened) {
    return opened.response;
  }
  const { runtime } = opened;
  try {
    return await verifyEmailWithToken(runtime.auth, request);
  } finally {
    await runtime.close();
  }
}

/** The verification itself, given Better Auth: 200 `verified` or a 400 that says expired or invalid. */
export async function verifyEmailWithToken(
  auth: BetterAuthInstance,
  request: Request
): Promise<Response> {
  {
    const token = await linkToken(request);
    if (token === undefined) {
      return jsonError(400, "verification_link_invalid");
    }
    try {
      await auth.api.verifyEmail({
        headers: request.headers,
        query: { token },
      });
    } catch (error) {
      if (!isAPIError(error)) {
        throw error;
      }
      const code = (error as { body?: { code?: unknown } }).body?.code;
      return jsonError(
        400,
        code === "TOKEN_EXPIRED"
          ? "verification_link_expired"
          : "verification_link_invalid"
      );
    }
    return Response.json(
      { status: "verified" },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
