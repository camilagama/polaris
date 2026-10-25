import { bumpUserAuthorizationEpoch } from "@polaris/db/authorization-epoch";
import { createDatabase } from "@polaris/db/client";
import { logger } from "@polaris/observability/logger";
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
import { logServerError } from "../observability/server-log";
import {
  createDatabaseAccessLogWriter,
  guardAccessLogWriter,
  requestIp,
} from "./access-log";
import {
  AuthDatabaseNotConfiguredError,
  resolveAuthConnectionString,
} from "./auth-database";
import {
  createResendAuthEmailDelivery,
  type PasswordAuthEmailDelivery,
} from "./email";
import {
  createDatabaseLoginLockStore,
  EMAIL_SIGN_IN_PATH,
  handleEmailSignInWithLock,
  isEmailSignInRequest,
  type LoginLockQueryable,
  type LoginLockStore,
  loginLockedResponse,
  newUnlockToken,
  responseErrorCode,
  sha256,
  unlockTokenUserId,
} from "./login-lock";
import { loginLockKey } from "./login-lock-key";
import {
  currentAuthRequestState,
  currentRequestId,
  requestScopedDatabase,
  requestScopedEmailDelivery,
  runInRequestBackground,
  runWithRequestScope,
} from "./request-database";
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

const CHANGE_PASSWORD_PATH = "/api/auth/change-password";
const SET_PASSWORD_PATH = "/api/auth/set-password";
/** The password routes: the lock and the notices live in the handler, so only the exact path may reach it. */
const passwordRoutePaths = [
  EMAIL_SIGN_IN_PATH,
  CHANGE_PASSWORD_PATH,
  SET_PASSWORD_PATH,
] as const;

/** The most a password route reads from the body (JSON of an e-mail and one or two passwords). */
const PASSWORD_BODY_MAX_BYTES = 8 * 1024;

function lowercaseDecoded(pathname: string): string {
  try {
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    return pathname.toLowerCase();
  }
}

/**
 * A POST that looks like a password route (any case, `%2F`, a trailing slash, a suffix, a prefix) without
 * being exactly its path. It never reaches Better Auth: whether its router would take that spelling is
 * not something the lock can bet on, so the answer is 404 (a segment boundary is required, so
 * `/reset-password` is not `/set-password`). A Better Auth plugin with a route that holds one of these
 * segments (`/sign-in/email-otp`) would be closed here too: add it to the list of exceptions then.
 */
function isPasswordRouteLookalike(request: Request): boolean {
  if (request.method !== "POST") {
    return false;
  }
  const { pathname } = new URL(request.url);
  if ((passwordRoutePaths as readonly string[]).includes(pathname)) {
    return false;
  }
  const decoded = lowercaseDecoded(pathname);
  return passwordRoutePaths.some((path) =>
    decoded.includes(path.slice("/api/auth".length))
  );
}

function isExactPost(request: Request, path: string): boolean {
  return request.method === "POST" && new URL(request.url).pathname === path;
}

function isPasswordRoute(request: Request): boolean {
  return passwordRoutePaths.some((path) => isExactPost(request, path));
}

/**
 * Reads the body of a password route up to the limit: above it, 413 without parsing. The bytes are read
 * once and the request is rebuilt on them, so every later `clone().json()` reads the same bounded body.
 */
export async function withBoundedBody(
  request: Request
): Promise<Request | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > PASSWORD_BODY_MAX_BYTES) {
    await request.body?.cancel();
    return jsonError(413, "payload_too_large");
  }
  if (!request.body) {
    return request;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: the chunks come in order, and the read stops at the limit.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > PASSWORD_BODY_MAX_BYTES) {
        await reader.cancel();
        return jsonError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } catch {
    // The client dropped the connection while sending: nothing to answer to, and not a 5xx for the alerts.
    return jsonError(400, "invalid_request_body");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  // Rebuilt on purpose: the abort `signal` and `request.cf` are not carried, and nothing downstream reads them.
  return new Request(request.url, { body: bytes, headers, method: "POST" });
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
  return (
    request.method === "POST" &&
    lowercaseDecoded(new URL(request.url).pathname).includes("/verify-password")
  );
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
  delivery?: PasswordAuthEmailDelivery;
  effects: PasswordChangeEffects;
  pool: LoginLockQueryable;
  requestId: string;
  runInBackground: (task: Promise<unknown>) => void;
  store: LoginLockStore;
}

/** What the instance is built from: the environment only, never the request. */
interface SharedAuthConfiguration {
  baseURL: string;
  emailPasswordEnabled: boolean;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  secret: string;
}

interface SharedAuthEntry {
  auth: BetterAuthInstance;
  configuration: SharedAuthConfiguration;
}

function sameConfiguration(
  a: SharedAuthConfiguration,
  b: SharedAuthConfiguration
): boolean {
  return (
    a.baseURL === b.baseURL &&
    a.emailPasswordEnabled === b.emailPasswordEnabled &&
    a.googleClientId === b.googleClientId &&
    a.googleClientSecret === b.googleClientSecret &&
    a.secret === b.secret
  );
}

/**
 * Built once per isolate (ADR 0017, emenda de 25/10/2026): assembling Better Auth costs more CPU than a request has.
 * It holds configuration only. The `db`, the request identifier, the `waitUntil`, the e-mails and what the hooks
 * remember are read at each call from the request scope (`runWithRequestScope`), so nothing of a request or of a
 * user stays here. It is built again when the environment changes, or after a failure.
 */
let sharedAuth: SharedAuthEntry | undefined;

function sharedAuthFor(
  configuration: SharedAuthConfiguration
): SharedAuthEntry {
  if (
    sharedAuth &&
    sameConfiguration(sharedAuth.configuration, configuration)
  ) {
    return sharedAuth;
  }
  const { baseURL, googleClientId, googleClientSecret, secret } = configuration;
  sharedAuth = {
    auth: createBetterAuth({
      baseURL,
      database: requestScopedDatabase(),
      ...(configuration.emailPasswordEnabled
        ? { emailDelivery: requestScopedEmailDelivery() }
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
      requestId: currentRequestId,
      requestState: currentAuthRequestState,
      runInBackground: runInRequestBackground,
      secret,
    }),
    configuration,
  };
  return sharedAuth;
}

/**
 * Runs one request of the authentication routes: the pool of the authentication role and the stores of the password
 * flows are its own, and the shared Better Auth reads them from the request scope. A task in the background (an
 * e-mail, the unlock of a lock) still needs the pool after the response, so the pool ends once they all settle.
 */
async function withAuthRuntime(
  bindings: WorkerBindings,
  requestId: string | undefined,
  runInBackground: BackgroundTaskHandler | undefined,
  use: (runtime: AuthRuntime) => Promise<Response>
): Promise<Response> {
  const secret = bindings.BETTER_AUTH_SECRET;
  const baseURL = bindings.BETTER_AUTH_BASE_URL;
  if (!secret || secret.length < 32 || !baseURL) {
    return jsonError(503, "auth_unavailable");
  }
  const resendApiKey = bindings.RESEND_API_KEY?.trim();
  const emailFrom = bindings.AUTH_EMAIL_FROM?.trim();

  let authConnectionString: string;
  try {
    authConnectionString = resolveAuthConnectionString(bindings);
  } catch (error) {
    if (error instanceof AuthDatabaseNotConfiguredError) {
      logger.error("auth_database_not_configured", { requestId });
      return jsonError(503, "auth_unavailable");
    }
    throw error;
  }

  const emailPasswordEnabled = isEmailPasswordAuthEnabled(bindings);
  const entry = sharedAuthFor({
    baseURL,
    emailPasswordEnabled,
    googleClientId: bindings.GOOGLE_CLIENT_ID?.trim(),
    googleClientSecret: bindings.GOOGLE_CLIENT_SECRET?.trim(),
    secret,
  });
  const { auth } = entry;

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
  const delivery = emailPasswordEnabled
    ? createResendAuthEmailDelivery({
        apiKey: resendApiKey as string,
        appBaseURL: baseURL,
        from: emailFrom as string,
        ...(bindings.AUTH_EMAIL_REPLY_TO?.trim()
          ? { replyTo: bindings.AUTH_EMAIL_REPLY_TO.trim() }
          : {}),
      })
    : undefined;

  const store = createDatabaseLoginLockStore(
    pool as unknown as LoginLockQueryable
  );
  const writeAuditEvent = databaseAuditEventWriter(db);
  const runtime: AuthRuntime = {
    auth,
    ...(delivery ? { delivery } : {}),
    effects: {
      bumpAuthorizationEpoch: (userId) =>
        bumpUserAuthorizationEpoch(db, userId),
      loginLock: {
        secret,
        sendUnlock: (email, key) =>
          sendLoginUnlock(unlockSenderOf(runtime), email, key),
        store,
      },
      requestId: safeRequestId,
      runInBackground: background,
      ...(delivery ? { sendPasswordNotice: delivery.sendPasswordNotice } : {}),
      writeAuditEvent,
    },
    pool: pool as unknown as LoginLockQueryable,
    requestId: safeRequestId,
    runInBackground: background,
    store,
  };

  try {
    return await runWithRequestScope(
      {
        database: db,
        ...(delivery ? { emailDelivery: delivery } : {}),
        requestId: safeRequestId,
        runInBackground: background,
      },
      () => use(runtime)
    );
  } catch (error) {
    // a failed start of the instance would otherwise be kept for the whole life of the isolate
    if (sharedAuth === entry) {
      sharedAuth = undefined;
    }
    throw error;
  } finally {
    await closeAfterBackground(pool, pending, runInBackground);
  }
}

/** Ends the pool now, or after the background tasks when there are some. */
async function closeAfterBackground(
  pool: { end: () => Promise<void> },
  pending: Promise<unknown>[],
  runInBackground: BackgroundTaskHandler | undefined
): Promise<void> {
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
}

/**
 * The unlock e-mail of a lock that just began (in the background, so the time of the answer never says
 * whether the e-mail has an account). Only an account with a password gets it, once per lock: the token
 * is stored first, and only a stored token is sent. The lock is audited with the account's ID.
 */
export interface LoginUnlockSender {
  auth: BetterAuthInstance;
  requestId: string;
  send?: PasswordAuthEmailDelivery["sendLoginUnlock"];
  store: Pick<LoginLockStore, "issueUnlock">;
  writeAuditEvent: AuthSecurityAuditEventWriter;
}

function unlockSenderOf(runtime: AuthRuntime): LoginUnlockSender {
  return {
    auth: runtime.auth,
    requestId: runtime.requestId,
    ...(runtime.delivery ? { send: runtime.delivery.sendLoginUnlock } : {}),
    store: runtime.store,
    writeAuditEvent: runtime.effects.writeAuditEvent,
  };
}

export async function sendLoginUnlock(
  sender: LoginUnlockSender,
  email: string,
  key: string
): Promise<void> {
  if (!sender.send) {
    return;
  }
  const context = await sender.auth.$context;
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
  if (!(await sender.store.issueUnlock(key, await sha256(token)))) {
    return;
  }
  await sender.send({ to: found.user.email, token });
  await sender.writeAuditEvent(
    passwordAuditEvent("login_locked", found.user.id, sender.requestId)
  );
}

export async function handleBetterAuthRequest(
  received: Request,
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
    (await isGoogleOAuthRequest(received)) &&
    !(googleClientId && googleClientSecret)
  ) {
    return jsonError(503, "auth_provider_unavailable");
  }

  if (
    isEmailPasswordAuthRoute(received) &&
    !isEmailPasswordAuthEnabled(bindings)
  ) {
    return jsonError(503, "auth_email_unavailable");
  }
  if (
    isTokenInUrlRoute(received) ||
    isClosedPasswordRoute(received) ||
    isPasswordRouteLookalike(received)
  ) {
    return jsonError(404, "not_found");
  }
  const request = isPasswordRoute(received)
    ? await withBoundedBody(received)
    : received;
  if (request instanceof Response) {
    return request;
  }

  return withAuthRuntime(
    bindings,
    requestId,
    runInBackground,
    async (runtime) => {
      const { auth } = runtime;
      await enforceAbsoluteSessionLifetime(auth, request);
      if (isExactPost(request, SET_PASSWORD_PATH)) {
        return await handleSetPasswordRequest(auth, request, runtime.effects);
      }
      if (isExactPost(request, CHANGE_PASSWORD_PATH)) {
        return await handleChangePasswordRequest(
          auth,
          request,
          runtime.effects
        );
      }
      if (isEmailSignInRequest(request)) {
        const writeAccessLog = guardAccessLogWriter(
          createDatabaseAccessLogWriter(runtime.pool)
        );
        return await handleEmailSignInWithLock(request, {
          onSettleError: (error) =>
            logServerError({
              error,
              method: "POST",
              requestId: runtime.requestId,
              route: "/api/auth/sign-in/email",
            }),
          recordRefusal: () =>
            writeAccessLog({
              event: "login_failed",
              ip: requestIp(request.headers),
              requestId: runtime.requestId,
              userId: null,
            }),
          runInBackground: runtime.runInBackground,
          secret,
          sendUnlock: (email, key) =>
            sendLoginUnlock(unlockSenderOf(runtime), email, key),
          signIn: (signInRequest) => auth.handler(signInRequest),
          store: runtime.store,
        });
      }

      return await auth.handler(request);
    }
  );
}

/**
 * The routes of the links of the e-mails sit outside `/api/auth/*` (ADR 0100): the page of the app
 * reads the token from the fragment and posts it here. Both answer 503 while the password is off.
 */
function withPasswordLinkRuntime(
  bindings: WorkerBindings,
  requestId: string | undefined,
  runInBackground: BackgroundTaskHandler | undefined,
  use: (runtime: AuthRuntime) => Promise<Response>
): Promise<Response> {
  if (!isEmailPasswordAuthEnabled(bindings)) {
    return Promise.resolve(jsonError(503, "auth_email_unavailable"));
  }
  return withAuthRuntime(bindings, requestId, runInBackground, use);
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
export function handleLoginUnlockRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  return withPasswordLinkRuntime(
    bindings,
    requestId,
    runInBackground,
    (runtime) =>
      unlockWithToken(request, {
        requestId: runtime.requestId,
        store: runtime.store,
        writeAuditEvent: runtime.effects.writeAuditEvent,
      })
  );
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
export function handleEmailVerificationRequest(
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  runInBackground?: BackgroundTaskHandler
): Promise<Response> {
  return withPasswordLinkRuntime(
    bindings,
    requestId,
    runInBackground,
    (runtime) => verifyEmailWithToken(runtime.auth, request)
  );
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
