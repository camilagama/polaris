import { loginLockKey } from "./login-lock-key";

/**
 * The Worker side of the lock of the sign-in by password (ADR 0100, entry screen P8): 5 failures in
 * 15 minutes lock the e-mail typed for 15 minutes. The counter lives in `auth_login_lock` (migration of
 * P2) and the six functions of that migration are the whole interface; this module only calls them, in
 * the order the design fixes: reserve the attempt, let Better Auth check the password, then record the
 * failure or forget the e-mail.
 */

/** The time a call to the lock waits for the database, at most. */
const LOGIN_LOCK_QUERY_TIMEOUT_MS = 5000;
/** The unlock token: the user's ID, a dot and 32 bytes of CSPRNG in base64url (43 characters). */
const unlockTokenPattern = /^([A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]{43}$/;
const trailingSlashPattern = /\/+$/;
const base64PaddingPattern = /[=]+$/;

/** The part of a `pg` pool (or client) this module uses. */
export interface LoginLockQueryable {
  query: (config: {
    query_timeout: number;
    text: string;
    values: unknown[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface LoginLockAttempt {
  allowed: boolean;
  /** True only for the call that began a lock: the unlock e-mail goes out for it, once. */
  newlyLocked: boolean;
  retryAfterSeconds: number;
}

export interface LoginLockStore {
  begin: (key: string) => Promise<LoginLockAttempt>;
  clear: (key: string) => Promise<void>;
  /** True when the failure began a lock. */
  failed: (key: string) => Promise<boolean>;
  /** Stores the SHA-256 of an unlock token; false when the key is not locked or already has a token. */
  issueUnlock: (key: string, tokenSha256: Uint8Array) => Promise<boolean>;
  unlock: (tokenSha256: Uint8Array) => Promise<"invalid" | "unlocked">;
}

export function createDatabaseLoginLockStore(
  pool: LoginLockQueryable
): LoginLockStore {
  const run = (text: string, values: unknown[]) =>
    pool.query({ query_timeout: LOGIN_LOCK_QUERY_TIMEOUT_MS, text, values });

  return {
    async begin(key) {
      const { rows } = await run(
        "SELECT allowed, retry_after_seconds, newly_locked FROM public.auth_login_lock_begin($1::text)",
        [key]
      );
      const [row] = rows;
      return {
        allowed: row?.allowed === true,
        newlyLocked: row?.newly_locked === true,
        retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
      };
    },
    async clear(key) {
      await run("SELECT public.auth_login_lock_clear($1::text)", [key]);
    },
    async failed(key) {
      const { rows } = await run(
        "SELECT public.auth_login_lock_failed($1::text) AS locked",
        [key]
      );
      return rows[0]?.locked === true;
    },
    async issueUnlock(key, tokenSha256) {
      const { rows } = await run(
        "SELECT public.auth_login_lock_issue_unlock($1::text, $2::bytea) AS issued",
        [key, tokenSha256]
      );
      return rows[0]?.issued === true;
    },
    async unlock(tokenSha256) {
      const { rows } = await run(
        "SELECT public.auth_login_unlock($1::bytea) AS result",
        [tokenSha256]
      );
      return rows[0]?.result === "unlocked" ? "unlocked" : "invalid";
    },
  };
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(base64PaddingPattern, "");
}

/**
 * A new unlock token for a user. The user's ID goes in the clear so the unlock can say whose account
 * it freed (the audit `login_unlocked`); it cannot be swapped, because the database only knows the
 * SHA-256 of the whole token. The secret part is 32 bytes of CSPRNG.
 */
export function newUnlockToken(userId: string): string {
  return `${userId}.${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The user an unlock token was issued for, or undefined for a token of another shape. */
export function unlockTokenUserId(token: string): string | undefined {
  return unlockTokenPattern.exec(token)?.[1];
}

export function isEmailSignInRequest(request: Request): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    new URL(request.url).pathname
      .replace(trailingSlashPattern, "")
      .endsWith("/sign-in/email")
  );
}

// Only a shape check: an e-mail Better Auth then refuses (400) reserved an attempt on a key no account has.
const emailShapePattern = /^[^\s@]+@[^\s@]+$/;
const EMAIL_MAX_LENGTH = 320;

async function typedEmail(request: Request): Promise<string | undefined> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const email =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { email?: unknown }).email
      : undefined;
  return typeof email === "string" &&
    email.length <= EMAIL_MAX_LENGTH &&
    emailShapePattern.test(email.trim())
    ? email
    : undefined;
}

export async function responseErrorCode(
  response: Response
): Promise<string | undefined> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const code =
    typeof body === "object" && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

export interface EmailSignInLockOptions {
  /** Records the refused attempt in the access log (`login_failed`, no user). */
  recordRefusal: () => Promise<unknown>;
  /** Runs a task after the response (Worker `waitUntil`), so its time never reaches the answer. */
  runInBackground: (task: Promise<unknown>) => void;
  /** Sends the unlock e-mail, if the e-mail has an account; runs in the background. */
  sendUnlock: (email: string, key: string) => Promise<void>;
  secret: string;
  signIn: (request: Request) => Promise<Response>;
  store: LoginLockStore;
}

export function loginLockedResponse(retryAfterSeconds: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return Response.json(
    { error: { code: "auth_login_locked" }, retryAfterSeconds: seconds },
    {
      headers: { "cache-control": "no-store", "retry-after": String(seconds) },
      status: 429,
    }
  );
}

/**
 * `POST /sign-in/email` with the lock (ADR 0100, AC-62 to AC-65). The attempt is reserved before the
 * password is checked; a locked e-mail gets the same 429 whether it has an account or not, because
 * nothing on that path reads the `user` table. After Better Auth: a success or a 403
 * `EMAIL_NOT_VERIFIED` (the password was right) forgets the e-mail, a 401 records a failure, anything
 * else leaves the reserved attempt counted. The unlock e-mail looks the account up in the background.
 */
export async function handleEmailSignInWithLock(
  request: Request,
  options: EmailSignInLockOptions
): Promise<Response> {
  const email = await typedEmail(request);
  if (email === undefined) {
    return options.signIn(request);
  }

  const key = await loginLockKey(options.secret, email);
  const sendUnlock = () =>
    options.runInBackground(options.sendUnlock(email, key));
  const attempt = await options.store.begin(key);
  if (!attempt.allowed) {
    if (attempt.newlyLocked) {
      sendUnlock();
    }
    await options.recordRefusal();
    return loginLockedResponse(attempt.retryAfterSeconds);
  }

  const response = await options.signIn(request);
  if (
    response.ok ||
    (response.status === 403 &&
      (await responseErrorCode(response)) === "EMAIL_NOT_VERIFIED")
  ) {
    await options.store.clear(key);
  } else if (response.status === 401 && (await options.store.failed(key))) {
    sendUnlock();
  }
  return response;
}
