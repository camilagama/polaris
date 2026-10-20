import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { vi } from "vitest";
import type { LoginLockAttempt } from "./login-lock";
import type { AuthEmailDelivery, AuthSecurityAuditEvent } from "../auth";
import { createBetterAuth } from "../auth";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./legal-acceptance-test-support";

/** Support of the tests of the password flows (ADR 0100): Better Auth over the memory adapter, no database. */
export const testSecret = "test-only-better-auth-secret-32-bytes";
export const testBaseURL = "http://localhost";
export const testPassword = "Uma senha longa e segura para o Polaris 2026";

const MINUTE = 60 * 1000;
const SET_COOKIE_SPLIT_REGEX = /,(?=\s*[^;,=\s]+=)/;
const EXPIRED_COOKIE_REGEX = /;\s*max-age=0/i;
const SESSION_COOKIE_REGEX = /(?:__Secure-)?better-auth\.session_token=/;

export interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

export interface PasswordTestAuthOptions {
  existingAccountDelivery?: boolean;
  loginLockClearer?: (email: string) => Promise<void>;
}

export function createPasswordTestAuth(options: PasswordTestAuthOptions = {}) {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const verificationEmails: { email: string; token: string }[] = [];
  const passwordResetEmails: { email: string; token: string }[] = [];
  const sendExistingAccount = vi.fn(
    (_input: { user: { email: string; id: string } }) => Promise.resolve()
  );
  const authorizationEpochBumper = vi.fn((_userId: string) =>
    Promise.resolve()
  );
  const emailDelivery: AuthEmailDelivery = {
    ...(options.existingAccountDelivery === false
      ? {}
      : { sendExistingAccount }),
    sendPasswordReset: ({ user, token }) => {
      passwordResetEmails.push({ email: user.email, token });
      return Promise.resolve();
    },
    sendVerificationEmail: ({ user, token }) => {
      verificationEmails.push({ email: user.email, token });
      return Promise.resolve();
    },
  };
  const auth = createBetterAuth({
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    authorizationEpochBumper,
    baseURL: testBaseURL,
    databaseAdapter: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    emailDelivery,
    ...(options.loginLockClearer
      ? { loginLockClearer: options.loginLockClearer }
      : {}),
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "password-test-request",
    secret: testSecret,
  });

  return {
    auditEvents,
    auth,
    authorizationEpochBumper,
    passwordResetEmails,
    sendExistingAccount,
    verificationEmails,
  };
}

export type PasswordTestAuth = ReturnType<
  typeof createPasswordTestAuth
>["auth"];

/** Answers the range of the breach check with no match, so any password passes it. */
export function stubPwnedPasswordRange() {
  vi.stubGlobal(
    "fetch",
    (): Promise<Response> =>
      Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`))
  );
}

export function jsonRequest(
  path: string,
  body: unknown,
  headers: Headers | Record<string, string> = {}
): Request {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  merged.set("origin", testBaseURL);
  return new Request(`${testBaseURL}${path}`, {
    body: JSON.stringify(body),
    headers: merged,
    method: "POST",
  });
}

function setCookieValues(headers: Headers): string[] {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(SET_COOKIE_SPLIT_REGEX);
  return values
    .filter((value) => value.length > 0 && !EXPIRED_COOKIE_REGEX.test(value))
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter((value) => value.length > 0 && !value.endsWith("="));
}

/** The cookie header a browser would send back after this response. */
export function cookieHeader(headers: Headers): string {
  return setCookieValues(headers).join("; ");
}

export function hasSessionCookie(headers: Headers): boolean {
  return SESSION_COOKIE_REGEX.test(headers.get("set-cookie") ?? "");
}

export async function authTestHelpers(
  auth: PasswordTestAuth
): Promise<TestAuthHelpers> {
  return ((await auth.$context) as unknown as { test: TestAuthHelpers }).test;
}

/** Signs up by e-mail and password and marks the e-mail verified, as the link of the e-mail would. */
export async function createVerifiedPasswordUser(
  auth: PasswordTestAuth,
  email: string,
  password = testPassword
): Promise<{ id: string }> {
  const signUp = await auth.handler(
    jsonRequest("/api/auth/sign-up/email", {
      email,
      legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
      name: "Pessoa de Teste",
      password,
    })
  );
  if (signUp.status !== 200) {
    throw new Error(`sign-up failed in the test: ${signUp.status}`);
  }
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email);
  if (!found) {
    throw new Error("the user of the test was not created");
  }
  await context.internalAdapter.updateUser(found.user.id, {
    emailVerified: true,
  });
  return { id: found.user.id };
}

/** Signs in with the password; the cookie header of the new session. */
export async function signInCookie(
  auth: PasswordTestAuth,
  email: string,
  password = testPassword
): Promise<string> {
  const response = await auth.handler(
    jsonRequest("/api/auth/sign-in/email", { email, password })
  );
  if (response.status !== 200) {
    throw new Error(`sign-in failed in the test: ${response.status}`);
  }
  return cookieHeader(response.headers);
}

/** What `/get-session` answers for this cookie: the session, or null. */
export async function sessionOf(
  auth: PasswordTestAuth,
  cookie: string
): Promise<unknown> {
  const response = await auth.handler(
    new Request(`${testBaseURL}/api/auth/get-session?disableCookieCache=true`, {
      headers: { cookie, origin: testBaseURL },
    })
  );
  return response.json();
}

interface LockRow {
  attempts: number;
  lockedUntil: number | null;
  tokenExpiresAt: number | null;
  tokenSha: string | null;
  windowStartedAt: number;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/**
 * The store in memory, after the six functions of migration 0082: 5 failures in 15 minutes lock the key
 * for 15 minutes, and the attempt is reserved (counted) before the password is checked.
 */
export function createMemoryLoginLockStore() {
  const rows = new Map<string, LockRow>();

  const beginNow = (key: string): LoginLockAttempt => {
    const now = Date.now();
    let row = rows.get(key);
    if (row?.lockedUntil !== null && row?.lockedUntil !== undefined) {
      if (row.lockedUntil > now) {
        return {
          allowed: false,
          newlyLocked: false,
          retryAfterSeconds: Math.ceil((row.lockedUntil - now) / 1000),
        };
      }
      rows.delete(key);
      row = undefined;
    }
    if (!row) {
      rows.set(key, {
        attempts: 1,
        lockedUntil: null,
        tokenExpiresAt: null,
        tokenSha: null,
        windowStartedAt: now,
      });
    } else if (row.windowStartedAt + 15 * MINUTE <= now) {
      Object.assign(row, {
        attempts: 1,
        tokenExpiresAt: null,
        tokenSha: null,
        windowStartedAt: now,
      });
    } else if (row.attempts >= 5) {
      Object.assign(row, {
        lockedUntil: now + 15 * MINUTE,
        tokenExpiresAt: null,
        tokenSha: null,
      });
      return { allowed: false, newlyLocked: true, retryAfterSeconds: 900 };
    } else {
      row.attempts += 1;
    }
    return { allowed: true, newlyLocked: false, retryAfterSeconds: 0 };
  };
  const begin = vi.fn((key: string) => Promise.resolve(beginNow(key)));
  const failedNow = (key: string) => {
    const now = Date.now();
    const row = rows.get(key);
    if (
      !row ||
      row.attempts < 5 ||
      (row.lockedUntil !== null && row.lockedUntil > now)
    ) {
      return false;
    }
    Object.assign(row, {
      lockedUntil: now + 15 * MINUTE,
      tokenExpiresAt: null,
      tokenSha: null,
    });
    return true;
  };
  const failed = vi.fn((key: string) => Promise.resolve(failedNow(key)));
  const clear = vi.fn((key: string) => {
    rows.delete(key);
    return Promise.resolve();
  });
  const issueUnlockNow = (key: string, tokenSha256: Uint8Array) => {
    const now = Date.now();
    const row = rows.get(key);
    if (
      !row ||
      row.lockedUntil === null ||
      row.lockedUntil <= now ||
      row.tokenSha !== null
    ) {
      return false;
    }
    row.tokenSha = hexOf(tokenSha256);
    row.tokenExpiresAt = now + 60 * MINUTE;
    return true;
  };
  const issueUnlock = vi.fn((key: string, tokenSha256: Uint8Array) =>
    Promise.resolve(issueUnlockNow(key, tokenSha256))
  );
  const unlockNow = (tokenSha256: Uint8Array) => {
    const now = Date.now();
    for (const row of rows.values()) {
      if (
        row.tokenSha === hexOf(tokenSha256) &&
        (row.tokenExpiresAt ?? 0) > now
      ) {
        if (row.lockedUntil !== null && row.lockedUntil > now) {
          Object.assign(row, {
            attempts: 0,
            lockedUntil: null,
            windowStartedAt: now,
          });
        }
        return "unlocked" as const;
      }
    }
    return "invalid" as const;
  };
  const unlock = vi.fn((tokenSha256: Uint8Array) =>
    Promise.resolve(unlockNow(tokenSha256))
  );
  const store: LoginLockStore = { begin, clear, failed, issueUnlock, unlock };
  return { begin, clear, failed, issueUnlock, rows, store, unlock };
}

