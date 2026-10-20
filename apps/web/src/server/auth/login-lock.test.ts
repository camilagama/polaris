import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabaseLoginLockStore,
  handleEmailSignInWithLock,
  type LoginLockAttempt,
  type LoginLockQueryable,
  type LoginLockStore,
  loginLockedResponse,
  newUnlockToken,
  sha256,
  unlockTokenUserId,
} from "./login-lock";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./legal-acceptance-test-support";
import { loginLockKey } from "./login-lock-key";
import {
  createPasswordTestAuth,
  createVerifiedPasswordUser,
  jsonRequest,
  stubPwnedPasswordRange,
  testPassword,
  testSecret,
} from "./password-test-support";

const MINUTE = 60 * 1000;
const START = new Date("2026-10-20T12:00:00.000Z");
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const wrongPassword = "uma senha errada, bem comprida também";

interface LockRow {
  attempts: number;
  lockedUntil: number | null;
  tokenExpiresAt: number | null;
  tokenSha: string | null;
  windowStartedAt: number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/**
 * The store in memory, after the six functions of migration 0082: 5 failures in 15 minutes lock the key
 * for 15 minutes, and the attempt is reserved (counted) before the password is checked.
 */
function createMemoryLoginLockStore() {
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
    row.tokenSha = hex(tokenSha256);
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
        row.tokenSha === hex(tokenSha256) &&
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

async function setup(emailVerified = true) {
  stubPwnedPasswordRange();
  const parts = createPasswordTestAuth();
  const email = "ana.lock@example.invalid";
  if (emailVerified) {
    await createVerifiedPasswordUser(parts.auth, email);
  } else {
    await parts.auth.handler(
      jsonRequest("/api/auth/sign-up/email", {
        email,
        legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
        name: "Sem verificação",
        password: testPassword,
      })
    );
  }
  const memory = createMemoryLoginLockStore();
  const background: Promise<unknown>[] = [];
  const sendUnlock = vi.fn((_email: string, _key: string) => Promise.resolve());
  const recordRefusal = vi.fn(() => Promise.resolve());
  const runInBackground = vi.fn((task: Promise<unknown>) => {
    background.push(task);
  });
  const signIn = vi.fn((request: Request) => parts.auth.handler(request));
  const attempt = (emailTyped: string, password: string) =>
    handleEmailSignInWithLock(
      jsonRequest("/api/auth/sign-in/email", {
        email: emailTyped,
        password,
      }),
      {
        recordRefusal,
        runInBackground,
        secret: testSecret,
        sendUnlock,
        signIn,
        store: memory.store,
      }
    );
  return {
    ...memory,
    attempt,
    background,
    email,
    recordRefusal,
    runInBackground,
    sendUnlock,
    signIn,
  };
}

describe("sign-in lock by password (AC-62, AC-63, AC-65)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("AC-62: five wrong passwords lock the e-mail, and the sixth, even with the right password, is a 429 with the seconds left", async () => {
    const ctx = await setup();

    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      const response = await ctx.attempt(ctx.email, wrongPassword);
      expect(response.status).toBe(401);
    }
    const locked = await ctx.attempt(ctx.email, testPassword);

    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect(locked.headers.get("cache-control")).toBe("no-store");
    expect(await locked.json()).toEqual({
      error: { code: "auth_login_locked" },
      retryAfterSeconds: 900,
    });
    // the sixth never reached the password check
    expect(ctx.signIn).toHaveBeenCalledTimes(5);
  });

  it("AC-62: the 429 counts down and the e-mail works again after the 15 minutes", async () => {
    const ctx = await setup();
    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(ctx.email, wrongPassword);
    }
    vi.setSystemTime(new Date(START.getTime() + 5 * MINUTE));
    const during = await ctx.attempt(ctx.email, testPassword);
    expect(during.status).toBe(429);
    expect(during.headers.get("retry-after")).toBe("600");

    vi.setSystemTime(new Date(START.getTime() + 15 * MINUTE + 1000));
    const after = await ctx.attempt(ctx.email, testPassword);
    expect(after.status).toBe(200);
  });

  it("reserves the attempt before the password is checked", async () => {
    const ctx = await setup();
    const order: string[] = [];
    ctx.begin.mockImplementationOnce(() => {
      order.push("begin");
      return Promise.resolve({
        allowed: true,
        newlyLocked: false,
        retryAfterSeconds: 0,
      });
    });
    ctx.signIn.mockImplementationOnce(() => {
      order.push("signIn");
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    await ctx.attempt(ctx.email, wrongPassword);

    expect(order).toEqual(["begin", "signIn"]);
  });

  it("AC-63: a success on the third attempt forgets the count", async () => {
    const ctx = await setup();
    const key = await loginLockKey(testSecret, ctx.email);

    await ctx.attempt(ctx.email, wrongPassword);
    await ctx.attempt(ctx.email, wrongPassword);
    expect(ctx.rows.get(key)?.attempts).toBe(2);
    const success = await ctx.attempt(ctx.email, testPassword);

    expect(success.status).toBe(200);
    expect(ctx.clear).toHaveBeenCalledWith(key);
    expect(ctx.rows.has(key)).toBe(false);
    // the count began again: four more failures do not lock
    for (let count = 1; count <= 4; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(ctx.email, wrongPassword);
    }
    const next = await ctx.attempt(ctx.email, testPassword);
    expect(next.status).toBe(200);
  });

  it("AC-65: the 429 of an e-mail with an account and of one with none are the same", async () => {
    const ctx = await setup();
    const stranger = "ninguem@example.invalid";

    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(ctx.email, wrongPassword);
      await ctx.attempt(stranger, wrongPassword);
    }
    const known = await ctx.attempt(ctx.email, wrongPassword);
    const unknown = await ctx.attempt(stranger, wrongPassword);

    expect(known.status).toBe(429);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    for (const name of ["retry-after", "cache-control", "content-type"]) {
      expect(unknown.headers.get(name)).toBe(known.headers.get(name));
    }
    expect([...unknown.headers.keys()].sort()).toEqual(
      [...known.headers.keys()].sort()
    );
  });

  it("AC-65: the stranger's fifth failure locks the key too (nothing reads the user table)", async () => {
    const ctx = await setup();
    const stranger = "ninguem@example.invalid";

    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      const response = await ctx.attempt(stranger, wrongPassword);
      expect(response.status).toBe(401);
    }
    expect((await ctx.attempt(stranger, wrongPassword)).status).toBe(429);
  });

  it("a 403 EMAIL_NOT_VERIFIED means the password was right: it forgets the count", async () => {
    const ctx = await setup(false);
    const key = await loginLockKey(testSecret, ctx.email);

    await ctx.attempt(ctx.email, wrongPassword);
    await ctx.attempt(ctx.email, wrongPassword);
    expect(ctx.rows.get(key)?.attempts).toBe(2);
    const response = await ctx.attempt(ctx.email, testPassword);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "EMAIL_NOT_VERIFIED"
    );
    expect(ctx.clear).toHaveBeenCalledWith(key);
    expect(ctx.rows.has(key)).toBe(false);
  });

  it("any other 403 leaves the attempt counted and does not clear", async () => {
    const ctx = await setup();
    ctx.signIn.mockResolvedValueOnce(
      Response.json({ code: "OTHER" }, { status: 403 })
    );

    await ctx.attempt(ctx.email, wrongPassword);

    expect(ctx.clear).not.toHaveBeenCalled();
    expect(ctx.failed).not.toHaveBeenCalled();
  });

  it("sends the unlock e-mail once, in the background, only when the lock begins", async () => {
    const ctx = await setup();
    const key = await loginLockKey(testSecret, ctx.email);

    for (let count = 1; count <= 4; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(ctx.email, wrongPassword);
    }
    expect(ctx.sendUnlock).not.toHaveBeenCalled();
    expect(ctx.runInBackground).not.toHaveBeenCalled();

    await ctx.attempt(ctx.email, wrongPassword);
    expect(ctx.sendUnlock).toHaveBeenCalledTimes(1);
    expect(ctx.sendUnlock).toHaveBeenCalledWith(ctx.email, key);
    expect(ctx.runInBackground).toHaveBeenCalledTimes(1);
    expect(ctx.runInBackground).toHaveBeenCalledWith(ctx.background[0]);

    // the refusals of the lock in force do not send again
    await ctx.attempt(ctx.email, wrongPassword);
    await ctx.attempt(ctx.email, testPassword);
    expect(ctx.sendUnlock).toHaveBeenCalledTimes(1);
  });

  it("sends the unlock e-mail when the lock begins in `begin` (a sixth request of a burst)", async () => {
    const ctx = await setup();
    ctx.begin.mockResolvedValueOnce({
      allowed: false,
      newlyLocked: true,
      retryAfterSeconds: 900,
    });

    const response = await ctx.attempt(ctx.email, wrongPassword);

    expect(response.status).toBe(429);
    expect(ctx.sendUnlock).toHaveBeenCalledTimes(1);
    expect(ctx.runInBackground).toHaveBeenCalledTimes(1);
    expect(ctx.signIn).not.toHaveBeenCalled();
  });

  it("records the refusal in the access log on a 429, and only then", async () => {
    const ctx = await setup();
    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(ctx.email, wrongPassword);
    }
    expect(ctx.recordRefusal).not.toHaveBeenCalled();

    await ctx.attempt(ctx.email, testPassword);
    await ctx.attempt(ctx.email, testPassword);

    expect(ctx.recordRefusal).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["without an at sign", "sem-arroba"],
    ["with a space", "ana @example.invalid"],
    ["empty", ""],
    ["too long", `${"a".repeat(320)}@example.invalid`],
    ["not a string", 42],
    ["missing", undefined],
  ])(
    "an e-mail %s does not touch the store and goes to Better Auth",
    async (_name, typed) => {
      const ctx = await setup();

      const response = await handleEmailSignInWithLock(
        jsonRequest("/api/auth/sign-in/email", {
          email: typed,
          password: wrongPassword,
        }),
        {
          recordRefusal: ctx.recordRefusal,
          runInBackground: ctx.runInBackground,
          secret: testSecret,
          sendUnlock: ctx.sendUnlock,
          signIn: ctx.signIn,
          store: {
            begin: ctx.begin,
            clear: ctx.clear,
            failed: ctx.failed,
            issueUnlock: ctx.issueUnlock,
            unlock: ctx.unlock,
          },
        }
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(429);
      expect(ctx.signIn).toHaveBeenCalledTimes(1);
      expect(ctx.begin).not.toHaveBeenCalled();
      expect(ctx.clear).not.toHaveBeenCalled();
      expect(ctx.failed).not.toHaveBeenCalled();
    }
  );

  it("a body that is not JSON does not touch the store", async () => {
    const ctx = await setup();
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      body: "isto não é json",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await handleEmailSignInWithLock(request, {
      recordRefusal: ctx.recordRefusal,
      runInBackground: ctx.runInBackground,
      secret: testSecret,
      sendUnlock: ctx.sendUnlock,
      signIn: () => Promise.resolve(new Response(null, { status: 400 })),
      store: ctx.store,
    });

    expect(ctx.begin).not.toHaveBeenCalled();
  });

  it("counts upper and lower case spellings of the e-mail on the same key", async () => {
    const ctx = await setup();
    const variants = [
      ctx.email,
      ctx.email.toUpperCase(),
      ` ${ctx.email} `,
      "Ana.Lock@Example.Invalid",
      ctx.email,
    ];

    for (const typed of variants) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.attempt(typed, wrongPassword);
    }

    expect(ctx.rows.size).toBe(1);
    const sixth = await ctx.attempt(ctx.email.toUpperCase(), testPassword);
    expect(sixth.status).toBe(429);
    const keys = ctx.begin.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(HEX_64);
  });

  it("never gives the e-mail or the password to the store, only the key", async () => {
    const ctx = await setup();

    await ctx.attempt(ctx.email, wrongPassword);

    expect(JSON.stringify(ctx.begin.mock.calls)).not.toContain("example");
    expect(JSON.stringify(ctx.failed.mock.calls)).not.toContain("example");
  });
});

describe("loginLockedResponse", () => {
  it.each([
    [900, 900],
    [0, 1],
    [-5, 1],
    [59.2, 60],
  ])("answers %s seconds as Retry-After %s", async (given, expected) => {
    const response = loginLockedResponse(given);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(expected));
    expect(await response.json()).toEqual({
      error: { code: "auth_login_locked" },
      retryAfterSeconds: expected,
    });
  });
});

describe("unlock token", () => {
  it("is the user's ID, a dot and 32 random bytes in 43 characters of base64url", () => {
    const token = newUnlockToken("user_123-abc");
    const [userId, secret, ...rest] = token.split(".");

    expect(rest).toEqual([]);
    expect(userId).toBe("user_123-abc");
    expect(secret).toMatch(BASE64URL_43);
    const bytes = Uint8Array.from(
      atob((secret as string).replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0)
    );
    expect(bytes).toHaveLength(32);
  });

  it("is different each time", () => {
    const tokens = new Set(
      Array.from({ length: 20 }, () => newUnlockToken("u1"))
    );

    expect(tokens.size).toBe(20);
  });

  it("is read back by unlockTokenUserId", () => {
    expect(unlockTokenUserId(newUnlockToken("user-9"))).toBe("user-9");
  });

  const secret43 = "A".repeat(43);
  it.each([
    ["empty", ""],
    ["no dot", `user${secret43}`],
    ["no user", `.${secret43}`],
    ["short secret", `user.${"A".repeat(42)}`],
    ["long secret", `user.${"A".repeat(44)}`],
    ["padding", `user.${"A".repeat(42)}=`],
    ["standard base64 characters", `user.${"A".repeat(41)}+/`],
    ["user with a dot", `us.er.${secret43}`],
    ["user with a space", `us er.${secret43}`],
    ["user too long", `${"u".repeat(65)}.${secret43}`],
    ["trailing newline", `user.${secret43}\n`],
  ])(
    "unlockTokenUserId refuses a token of the wrong shape: %s",
    (_name, token) => {
      expect(unlockTokenUserId(token)).toBeUndefined();
    }
  );

  it("unlockTokenUserId accepts a user of 64 characters", () => {
    expect(unlockTokenUserId(`${"u".repeat(64)}.${secret43}`)).toBe(
      "u".repeat(64)
    );
  });

  it("sha256 gives the 32 bytes of the standard digest", async () => {
    const digest = await sha256("abc");

    expect(hex(digest)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("createDatabaseLoginLockStore", () => {
  function fakePool(rows: Record<string, unknown>[] = []) {
    const query = vi.fn(
      (_config: { query_timeout: number; text: string; values: unknown[] }) =>
        Promise.resolve({ rows })
    );
    const pool: LoginLockQueryable = { query };
    return {
      pool,
      query,
      setRows: (next: Record<string, unknown>[]) =>
        rows.splice(0, rows.length, ...next),
    };
  }
  const key = "a".repeat(64);

  it("begin calls auth_login_lock_begin with the key and reads the three columns", async () => {
    const { pool, query } = fakePool([
      { allowed: true, newly_locked: false, retry_after_seconds: 0 },
    ]);

    const attempt = await createDatabaseLoginLockStore(pool).begin(key);

    expect(attempt).toEqual({
      allowed: true,
      newlyLocked: false,
      retryAfterSeconds: 0,
    });
    expect(query).toHaveBeenCalledWith({
      query_timeout: 5000,
      text: "SELECT allowed, retry_after_seconds, newly_locked FROM public.auth_login_lock_begin($1::text)",
      values: [key],
    });
  });

  it("begin reads a lock (integer as a string, as a driver may give it)", async () => {
    const { pool } = fakePool([
      { allowed: false, newly_locked: true, retry_after_seconds: "900" },
    ]);

    expect(await createDatabaseLoginLockStore(pool).begin(key)).toEqual({
      allowed: false,
      newlyLocked: true,
      retryAfterSeconds: 900,
    });
  });

  it("begin fails closed when the function answers no row", async () => {
    const { pool } = fakePool([]);

    expect(await createDatabaseLoginLockStore(pool).begin(key)).toEqual({
      allowed: false,
      newlyLocked: false,
      retryAfterSeconds: 0,
    });
  });

  it("begin does not catch a database error: the sign-in fails closed", async () => {
    const pool: LoginLockQueryable = {
      query: () => Promise.reject(new Error("db down")),
    };

    await expect(createDatabaseLoginLockStore(pool).begin(key)).rejects.toThrow(
      "db down"
    );
  });

  it("clear calls auth_login_lock_clear", async () => {
    const { pool, query } = fakePool();

    await createDatabaseLoginLockStore(pool).clear(key);

    expect(query).toHaveBeenCalledWith({
      query_timeout: 5000,
      text: "SELECT public.auth_login_lock_clear($1::text)",
      values: [key],
    });
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])("failed answers %s as %s", async (locked, expected) => {
    const { pool, query } = fakePool([{ locked }]);

    expect(await createDatabaseLoginLockStore(pool).failed(key)).toBe(expected);
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: "SELECT public.auth_login_lock_failed($1::text) AS locked",
      values: [key],
    });
  });

  it("issueUnlock gives the key and the digest, and answers whether it was stored", async () => {
    const digest = new Uint8Array(32).fill(7);
    const { pool, query } = fakePool([{ issued: true }]);
    const store = createDatabaseLoginLockStore(pool);

    expect(await store.issueUnlock(key, digest)).toBe(true);
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: "SELECT public.auth_login_lock_issue_unlock($1::text, $2::bytea) AS issued",
      values: [key, digest],
    });

    const none = fakePool([{ issued: false }]);
    expect(
      await createDatabaseLoginLockStore(none.pool).issueUnlock(key, digest)
    ).toBe(false);
  });

  it.each([
    ["unlocked", "unlocked"],
    ["invalid", "invalid"],
    ["anything else", "invalid"],
    [undefined, "invalid"],
  ])("unlock reads %s as %s", async (result, expected) => {
    const digest = new Uint8Array(32).fill(1);
    const { pool, query } = fakePool([{ result }]);

    expect(await createDatabaseLoginLockStore(pool).unlock(digest)).toBe(
      expected
    );
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      text: "SELECT public.auth_login_unlock($1::bytea) AS result",
      values: [digest],
    });
  });

  it("unlock treats an empty answer as invalid", async () => {
    const { pool } = fakePool([]);

    expect(
      await createDatabaseLoginLockStore(pool).unlock(new Uint8Array(32))
    ).toBe("invalid");
  });
});
