import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSecurityAuditEvent } from "../auth";
import {
  handleChangePasswordRequest,
  handleSetPasswordRequest,
  type PasswordChangeEffects,
  sendLoginUnlock,
  unlockWithToken,
  verifyEmailWithToken,
} from "./handler";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./legal-acceptance-test-support";
import { newUnlockToken, sha256 } from "./login-lock";
import { loginLockKey } from "./login-lock-key";
import {
  authTestHelpers,
  cookieHeader,
  createMemoryLoginLockStore,
  createPasswordTestAuth,
  createVerifiedPasswordUser,
  hasSessionCookie,
  jsonRequest,
  type PasswordTestAuth,
  sessionOf,
  signInCookie,
  stubPwnedPasswordRange,
  testBaseURL,
  testPassword,
  testSecret,
} from "./password-test-support";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = new Date("2026-10-20T12:00:00.000Z");
const newPassword = "Outra senha longa e segura para 2026";

function useFakeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
}

function silenceLogs() {
  for (const method of ["error", "log", "warn", "info"] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
}

function createEffects(
  auditEvents: AuthSecurityAuditEvent[],
  bump: PasswordChangeEffects["bumpAuthorizationEpoch"]
) {
  const background: Promise<unknown>[] = [];
  const sendPasswordNotice = vi.fn(
    (_input: { eventId: string; kind: "changed" | "set"; to: string }) =>
      Promise.resolve()
  );
  const runInBackground = vi.fn((task: Promise<unknown>) => {
    background.push(task);
  });
  const effects: PasswordChangeEffects = {
    bumpAuthorizationEpoch: bump,
    requestId: "req-password-1",
    runInBackground,
    sendPasswordNotice,
    writeAuditEvent: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
  };
  return { background, effects, runInBackground, sendPasswordNotice };
}

describe("change of the password of a signed-in person (AC-57)", () => {
  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function twoSessions() {
    const parts = createPasswordTestAuth();
    const email = "troca@example.invalid";
    const user = await createVerifiedPasswordUser(parts.auth, email);
    const s1 = await signInCookie(parts.auth, email);
    const s2 = await signInCookie(parts.auth, email);
    const bump = vi.fn((_userId: string) => Promise.resolve());
    const fx = createEffects(parts.auditEvents, bump);
    const change = (cookie: string, body: Record<string, unknown>) =>
      handleChangePasswordRequest(
        parts.auth,
        jsonRequest("/api/auth/change-password", body, { cookie }),
        fx.effects
      );
    return { ...parts, bump, change, email, fx, s1, s2, user };
  }

  it("AC-57: changes the password, drops the other session, opens a new one and leaves the token out of the body", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    expect(Object.keys(body)).toEqual(["user"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(hasSessionCookie(response.headers)).toBe(true);
    const fresh = cookieHeader(response.headers);
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(ctx.s1);

    expect(await sessionOf(ctx.auth, ctx.s2)).toBeNull();
    expect(await sessionOf(ctx.auth, ctx.s1)).toBeNull();
    expect(await sessionOf(ctx.auth, fresh)).toMatchObject({
      user: { id: ctx.user.id },
    });
    // the new password is the one that signs in
    await expect(
      signInCookie(ctx.auth, ctx.email, newPassword)
    ).resolves.toBeTruthy();
    await expect(signInCookie(ctx.auth, ctx.email)).rejects.toThrow();
  });

  it("changes the epoch of the leases with the user's ID, audits password_changed and schedules the notice of kind changed", async () => {
    const ctx = await twoSessions();

    await ctx.change(ctx.s1, { currentPassword: testPassword, newPassword });

    expect(ctx.bump).toHaveBeenCalledTimes(1);
    expect(ctx.bump).toHaveBeenCalledWith(ctx.user.id);
    expect(ctx.auditEvents).toContainEqual({
      actorId: ctx.user.id,
      errorCode: null,
      eventType: "password_changed",
      outcome: "succeeded",
      provider: null,
      requestId: "req-password-1",
    });
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledTimes(1);
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledWith({
      eventId: `${ctx.user.id}:req-password-1`,
      kind: "changed",
      to: ctx.email,
    });
    expect(ctx.fx.runInBackground).toHaveBeenCalledTimes(1);
  });

  it("ignores a revokeOtherSessions: false sent by the client: the other session always falls", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
      revokeOtherSessions: false,
    });

    expect(response.status).toBe(200);
    expect(await sessionOf(ctx.auth, ctx.s2)).toBeNull();
  });

  it("403 fresh_session_required for a session created more than 15 minutes ago, and nothing changes", async () => {
    const ctx = await twoSessions();
    vi.setSystemTime(new Date(START.getTime() + 15 * MINUTE + 1000));

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "fresh_session_required" },
    });
    expect(ctx.bump).not.toHaveBeenCalled();
    expect(ctx.auditEvents).toEqual([]);
    expect(ctx.fx.sendPasswordNotice).not.toHaveBeenCalled();
    expect(await sessionOf(ctx.auth, ctx.s2)).not.toBeNull();
    // the old password still signs in
    await expect(signInCookie(ctx.auth, ctx.email)).resolves.toBeTruthy();
  });

  it("accepts a session created 14 minutes ago", async () => {
    const ctx = await twoSessions();
    vi.setSystemTime(new Date(START.getTime() + 14 * MINUTE));

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(200);
  });

  it("401 session_required without a session", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change("", {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(401);
    expect(ctx.bump).not.toHaveBeenCalled();
  });

  it("403 email_not_verified for a session of an unverified e-mail", async () => {
    const parts = createPasswordTestAuth();
    const helpers = await authTestHelpers(parts.auth);
    const user = await helpers.saveUser(
      helpers.createUser({
        email: "sem-verificar@example.invalid",
        emailVerified: false,
      })
    );
    const login = await helpers.login({ userId: user.id });
    const fx = createEffects(parts.auditEvents, () => Promise.resolve());

    const response = await handleChangePasswordRequest(
      parts.auth,
      jsonRequest(
        "/api/auth/change-password",
        { currentPassword: testPassword, newPassword },
        login.headers
      ),
      fx.effects
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "email_not_verified" },
    });
  });

  it("400 invalid_request_body when the passwords are not strings", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change(ctx.s1, {
      currentPassword: 123,
      newPassword,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request_body" },
    });
    expect(ctx.bump).not.toHaveBeenCalled();
  });

  it("a wrong current password is refused by Better Auth and has no effect", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change(ctx.s1, {
      currentPassword: "a senha atual que não é esta",
      newPassword,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(ctx.bump).not.toHaveBeenCalled();
    expect(ctx.auditEvents).toEqual([]);
    expect(ctx.fx.sendPasswordNotice).not.toHaveBeenCalled();
    expect(ctx.fx.runInBackground).not.toHaveBeenCalled();
    expect(await sessionOf(ctx.auth, ctx.s2)).not.toBeNull();
    expect(await sessionOf(ctx.auth, ctx.s1)).not.toBeNull();
    await expect(signInCookie(ctx.auth, ctx.email)).resolves.toBeTruthy();
  });

  it("refuses a new password under the policy (too short) and has no effect", async () => {
    const ctx = await twoSessions();

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword: "curta demais",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "password_too_short" });
    expect(ctx.bump).not.toHaveBeenCalled();
    expect(ctx.auditEvents).toEqual([]);
    expect(await sessionOf(ctx.auth, ctx.s2)).not.toBeNull();
  });

  it("tries the epoch bump a second time when the first fails, and still answers 200", async () => {
    const ctx = await twoSessions();
    ctx.bump.mockRejectedValueOnce(new Error("bump failed once"));

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(200);
    expect(ctx.bump).toHaveBeenCalledTimes(2);
    expect(ctx.bump).toHaveBeenNthCalledWith(2, ctx.user.id);
    expect(ctx.auditEvents.map((event) => event.eventType)).toContain(
      "password_changed"
    );
  });

  it("gives up after two failed bumps, keeps the 200, the audit and the notice", async () => {
    const ctx = await twoSessions();
    ctx.bump.mockRejectedValue(new Error("bump failed"));

    const response = await ctx.change(ctx.s1, {
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(200);
    expect(ctx.bump).toHaveBeenCalledTimes(2);
    expect(ctx.auditEvents.map((event) => event.eventType)).toContain(
      "password_changed"
    );
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledTimes(1);
  });

  it("a failed audit write does not change the answer and the notice still goes out", async () => {
    const ctx = await twoSessions();
    const fx = createEffects([], () => Promise.resolve());
    fx.effects.writeAuditEvent = () => Promise.reject(new Error("audit down"));

    const response = await handleChangePasswordRequest(
      ctx.auth,
      jsonRequest(
        "/api/auth/change-password",
        { currentPassword: testPassword, newPassword },
        { cookie: ctx.s1 }
      ),
      fx.effects
    );

    expect(response.status).toBe(200);
    expect(fx.sendPasswordNotice).toHaveBeenCalledTimes(1);
  });

  it("without a notice sender it still changes and audits", async () => {
    const ctx = await twoSessions();
    const { sendPasswordNotice: _omitted, ...effects } = ctx.fx.effects;

    const response = await handleChangePasswordRequest(
      ctx.auth,
      jsonRequest(
        "/api/auth/change-password",
        { currentPassword: testPassword, newPassword },
        { cookie: ctx.s1 }
      ),
      effects
    );

    expect(response.status).toBe(200);
    expect(ctx.auditEvents.map((event) => event.eventType)).toContain(
      "password_changed"
    );
  });
});

describe("addition of a password to an account without one", () => {
  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function accountWithoutPassword() {
    const parts = createPasswordTestAuth();
    const helpers = await authTestHelpers(parts.auth);
    const email = "so-google@example.invalid";
    const user = await helpers.saveUser(
      helpers.createUser({ email, emailVerified: true })
    );
    const login = await helpers.login({ userId: user.id });
    const fx = createEffects(parts.auditEvents, () => Promise.resolve());
    const set = (
      body: Record<string, unknown>,
      headers: Headers | Record<string, string> = login.headers
    ) =>
      handleSetPasswordRequest(
        parts.auth,
        jsonRequest("/api/auth/set-password", body, headers),
        fx.effects
      );
    return { ...parts, email, fx, login, set, user };
  }

  it("sets the password, audits password_set and schedules the notice of kind set", async () => {
    const ctx = await accountWithoutPassword();

    const response = await ctx.set({ newPassword: testPassword });

    expect(response.status).toBe(200);
    expect(ctx.auditEvents).toEqual([
      {
        actorId: ctx.user.id,
        errorCode: null,
        eventType: "password_set",
        outcome: "succeeded",
        provider: null,
        requestId: "req-password-1",
      },
    ]);
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledWith({
      eventId: `${ctx.user.id}:req-password-1`,
      kind: "set",
      to: ctx.email,
    });
    expect(ctx.fx.runInBackground).toHaveBeenCalledTimes(1);
    // the password now signs in
    await expect(
      signInCookie(ctx.auth, ctx.email, testPassword)
    ).resolves.toBeTruthy();
  });

  it("403 fresh_session_required for a session older than 15 minutes, and nothing changes", async () => {
    const ctx = await accountWithoutPassword();
    vi.setSystemTime(new Date(START.getTime() + 16 * MINUTE));

    const response = await ctx.set({ newPassword: testPassword });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "fresh_session_required" },
    });
    expect(ctx.auditEvents).toEqual([]);
    expect(ctx.fx.sendPasswordNotice).not.toHaveBeenCalled();
    await expect(
      signInCookie(ctx.auth, ctx.email, testPassword)
    ).rejects.toThrow();
  });

  it("refuses a short password with the policy error and records nothing", async () => {
    const ctx = await accountWithoutPassword();

    const response = await ctx.set({ newPassword: "curta" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "password_too_short",
        message: "Password does not meet the minimum length.",
      },
    });
    expect(ctx.auditEvents).toEqual([]);
    expect(ctx.fx.sendPasswordNotice).not.toHaveBeenCalled();
  });

  it("does not audit or notice when Better Auth refuses (an account that already has a password)", async () => {
    const parts = createPasswordTestAuth();
    const email = "ja-tem@example.invalid";
    await createVerifiedPasswordUser(parts.auth, email);
    const cookie = await signInCookie(parts.auth, email);
    const fx = createEffects(parts.auditEvents, () => Promise.resolve());

    const response = await handleSetPasswordRequest(
      parts.auth,
      jsonRequest(
        "/api/auth/set-password",
        { newPassword: "Mais uma senha longa para 2026!" },
        { cookie }
      ),
      fx.effects
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(parts.auditEvents).toEqual([]);
    expect(fx.sendPasswordNotice).not.toHaveBeenCalled();
  });

  it("401 without a session and 400 without a string password", async () => {
    const ctx = await accountWithoutPassword();

    expect((await ctx.set({ newPassword: testPassword }, {})).status).toBe(401);
    const bad = await ctx.set({ newPassword: 42 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: { code: "invalid_request_body" },
    });
  });
});

describe("what a password reset does besides the new password", () => {
  beforeEach(() => {
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function completeReset(
    parts: ReturnType<typeof createPasswordTestAuth>,
    email: string
  ) {
    await createVerifiedPasswordUser(parts.auth, email);
    const requested = await parts.auth.handler(
      jsonRequest("/api/auth/request-password-reset", {
        email,
        redirectTo: "/reset-password",
      })
    );
    expect(requested.status).toBe(200);
    const token = parts.passwordResetEmails.at(-1)?.token;
    expect(token).toBeTruthy();
    return parts.auth.handler(
      jsonRequest("/api/auth/reset-password", { newPassword, token })
    );
  }

  it("forgets the sign-in lock of the e-mail and audits password_reset_completed", async () => {
    const clearer = vi.fn((_email: string) => Promise.resolve());
    const parts = createPasswordTestAuth({ loginLockClearer: clearer });
    const email = "reset-lock@example.invalid";

    const reset = await completeReset(parts, email);

    expect(reset.status).toBe(200);
    expect(clearer).toHaveBeenCalledTimes(1);
    expect(clearer).toHaveBeenCalledWith(email);
    const completed = parts.auditEvents.filter(
      (event) => event.eventType === "password_reset_completed"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      actorId: expect.any(String),
      errorCode: null,
      outcome: "succeeded",
      provider: null,
      requestId: "password-test-request",
    });
    expect(parts.authorizationEpochBumper).toHaveBeenCalledTimes(1);
  });

  it("a failing clearer stops neither the audit nor the reset", async () => {
    const clearer = vi.fn((_email: string) =>
      Promise.reject(new Error("lock store down"))
    );
    const parts = createPasswordTestAuth({ loginLockClearer: clearer });
    const email = "reset-lock-fail@example.invalid";

    const reset = await completeReset(parts, email);

    expect(reset.status).toBe(200);
    expect(clearer).toHaveBeenCalledTimes(1);
    expect(parts.auditEvents.map((event) => event.eventType)).toContain(
      "password_reset_completed"
    );
    await expect(
      signInCookie(parts.auth, email, newPassword)
    ).resolves.toBeTruthy();
  });

  it("a failing epoch bump stops neither the clearer nor the audit", async () => {
    const clearer = vi.fn((_email: string) => Promise.resolve());
    const parts = createPasswordTestAuth({ loginLockClearer: clearer });
    parts.authorizationEpochBumper.mockRejectedValue(new Error("bump down"));
    const email = "reset-bump-fail@example.invalid";

    const reset = await completeReset(parts, email);

    expect(reset.status).toBe(200);
    expect(clearer).toHaveBeenCalledWith(email);
    expect(parts.auditEvents.map((event) => event.eventType)).toContain(
      "password_reset_completed"
    );
  });

  it("a failing audit write does not stop the reset", async () => {
    const clearer = vi.fn((_email: string) => Promise.resolve());
    const parts = createPasswordTestAuth({ loginLockClearer: clearer });
    const failing = parts.auditEvents;
    const email = "reset-audit-fail@example.invalid";
    await createVerifiedPasswordUser(parts.auth, email);
    // the next audit write fails: replace push for the reset step only
    const push = failing.push.bind(failing);
    failing.push = () => {
      throw new Error("audit down");
    };
    const requested = await parts.auth.handler(
      jsonRequest("/api/auth/request-password-reset", {
        email,
        redirectTo: "/reset-password",
      })
    );
    expect(requested.status).toBe(200);

    const reset = await parts.auth.handler(
      jsonRequest("/api/auth/reset-password", {
        newPassword,
        token: parts.passwordResetEmails.at(-1)?.token,
      })
    );
    failing.push = push;

    expect(reset.status).toBe(200);
    expect(clearer).toHaveBeenCalledWith(email);
  });
});

describe("sign-up with an e-mail that already has an account", () => {
  beforeEach(() => {
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const signUp = (
    auth: ReturnType<typeof createPasswordTestAuth>["auth"],
    email: string
  ) =>
    auth.handler(
      jsonRequest("/api/auth/sign-up/email", {
        email,
        legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
        name: "Quem Cadastra",
        password: testPassword,
      })
    );

  it("answers the same status and shape as for a new e-mail, and sends the existing-account e-mail only in that case", async () => {
    const parts = createPasswordTestAuth();

    const fresh = await signUp(parts.auth, "nova@example.invalid");
    expect(parts.sendExistingAccount).not.toHaveBeenCalled();
    const existing = await signUp(parts.auth, "nova@example.invalid");

    expect(existing.status).toBe(fresh.status);
    expect(existing.status).toBe(200);
    const freshBody = (await fresh.json()) as {
      token: unknown;
      user: Record<string, unknown>;
    };
    const existingBody = (await existing.json()) as typeof freshBody;
    expect(Object.keys(existingBody).sort()).toEqual(
      Object.keys(freshBody).sort()
    );
    // `image` is left out: the synthetic user always carries `image: null`, while the memory adapter drops the
    // undefined image of a created row (a database row answers `null` too)
    const shape = (user: Record<string, unknown>) =>
      Object.keys(user)
        .filter((key) => key !== "image")
        .sort();
    expect(shape(existingBody.user)).toEqual(shape(freshBody.user));
    expect(existingBody.token).toBeNull();
    expect(freshBody.token).toBeNull();
    expect(existing.headers.get("set-cookie")).toBe(
      fresh.headers.get("set-cookie")
    );
    expect(parts.sendExistingAccount).toHaveBeenCalledTimes(1);
    expect(parts.sendExistingAccount.mock.calls[0]?.[0].user.email).toBe(
      "nova@example.invalid"
    );
    // only the new e-mail got a verification link
    expect(parts.verificationEmails).toHaveLength(1);
  });

  it("does not give the existing account's ID in the answer", async () => {
    const parts = createPasswordTestAuth();
    const user = await createVerifiedPasswordUser(
      parts.auth,
      "dona@example.invalid"
    );

    const existing = await signUp(parts.auth, "dona@example.invalid");

    expect(JSON.stringify(await existing.json())).not.toContain(user.id);
    expect(parts.sendExistingAccount).toHaveBeenCalledTimes(1);
    expect(parts.sendExistingAccount.mock.calls[0]?.[0].user.id).toBe(user.id);
  });
});

describe("unlock of the sign-in lock by the link of the e-mail (AC-64)", () => {
  const unlockRequest = (body: unknown) =>
    jsonRequest("/api/login-unlock", body);

  function setup(result: "invalid" | "unlocked" = "unlocked") {
    const audit: AuthSecurityAuditEvent[] = [];
    const unlock = vi.fn((_digest: Uint8Array) => Promise.resolve(result));
    return {
      audit,
      run: (
        body: unknown,
        write?: (e: AuthSecurityAuditEvent) => Promise<void>
      ) =>
        unlockWithToken(unlockRequest(body), {
          requestId: "req-unlock-1",
          store: { unlock },
          writeAuditEvent:
            write ??
            ((event) => {
              audit.push(event);
              return Promise.resolve();
            }),
        }),
      unlock,
    };
  }

  beforeEach(silenceLogs);
  afterEach(() => vi.restoreAllMocks());

  it("a valid token answers 200 unlocked and audits login_unlocked with the user of the token", async () => {
    const ctx = setup();
    const token = newUnlockToken("user-77");

    const response = await ctx.run({ token });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unlocked" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ctx.audit).toEqual([
      {
        actorId: "user-77",
        errorCode: null,
        eventType: "login_unlocked",
        outcome: "succeeded",
        provider: null,
        requestId: "req-unlock-1",
      },
    ]);
    expect(ctx.unlock).toHaveBeenCalledTimes(1);
    expect(ctx.unlock).toHaveBeenCalledWith(await sha256(token));
  });

  it("a token the store does not know is the one 400 unlock_link_invalid, and nothing is audited", async () => {
    const ctx = setup("invalid");

    const response = await ctx.run({ token: newUnlockToken("user-77") });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "unlock_link_invalid" },
    });
    expect(ctx.audit).toEqual([]);
  });

  it.each([
    ["no token", {}],
    ["empty token", { token: "" }],
    ["token that is not a string", { token: 123 }],
    ["token of the wrong shape", { token: "isto-nao-e-um-token" }],
    ["token with a short secret", { token: `user-1.${"A".repeat(42)}` }],
    ["token too long", { token: "a".repeat(5000) }],
    ["body that is an array", [newUnlockToken("user-1")]],
  ])(
    "%s answers 400 unlock_link_invalid without calling the store",
    async (_name, body) => {
      const ctx = setup();

      const response = await ctx.run(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "unlock_link_invalid" },
      });
      expect(ctx.unlock).not.toHaveBeenCalled();
      expect(ctx.audit).toEqual([]);
    }
  );

  it("a body that is not JSON answers 400 unlock_link_invalid", async () => {
    const ctx = setup();
    const request = new Request("http://localhost/api/login-unlock", {
      body: "não é json",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const response = await unlockWithToken(request, {
      requestId: "r",
      store: { unlock: ctx.unlock },
      writeAuditEvent: () => Promise.resolve(),
    });

    expect(response.status).toBe(400);
    expect(ctx.unlock).not.toHaveBeenCalled();
  });

  it("a failed audit write does not change the 200", async () => {
    const ctx = setup();

    const response = await ctx.run({ token: newUnlockToken("user-77") }, () =>
      Promise.reject(new Error("audit down"))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unlocked" });
  });

  it("a failing store is not hidden as an invalid link (the error reaches the caller)", async () => {
    const unlock = vi.fn(() => Promise.reject(new Error("db down")));

    await expect(
      unlockWithToken(unlockRequest({ token: newUnlockToken("user-1") }), {
        requestId: "r",
        store: { unlock },
        writeAuditEvent: () => Promise.resolve(),
      })
    ).rejects.toThrow("db down");
  });
});

describe("verification of the e-mail by the link of the e-mail (AC-48)", () => {
  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function pendingVerification() {
    const parts = createPasswordTestAuth();
    const email = "verificar@example.invalid";
    const signUp = await parts.auth.handler(
      jsonRequest("/api/auth/sign-up/email", {
        email,
        legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
        name: "Quem Verifica",
        password: testPassword,
      })
    );
    expect(signUp.status).toBe(200);
    const token = parts.verificationEmails.at(-1)?.token as string;
    expect(token).toBeTruthy();
    const verify = (body: unknown) =>
      verifyEmailWithToken(
        parts.auth,
        jsonRequest("/api/email-verification", body)
      );
    const verified = async () => {
      const found = (await parts.auth.$context).internalAdapter.findUserByEmail(
        email
      );
      return (await found)?.user.emailVerified;
    };
    return { ...parts, email, token, verified, verify };
  }

  it("a valid token answers 200 verified and the e-mail becomes verified", async () => {
    const ctx = await pendingVerification();
    expect(await ctx.verified()).toBe(false);

    const response = await ctx.verify({ token: ctx.token });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "verified" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await ctx.verified()).toBe(true);
    // no session is opened by the link
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("the same token again answers 200 verified again (a reload is not a false expiry)", async () => {
    const ctx = await pendingVerification();

    const first = await ctx.verify({ token: ctx.token });
    const second = await ctx.verify({ token: ctx.token });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "verified" });
  });

  it("a garbage token answers 400 verification_link_invalid", async () => {
    const ctx = await pendingVerification();

    const response = await ctx.verify({ token: "lixo.lixo.lixo" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "verification_link_invalid" },
    });
    expect(await ctx.verified()).toBe(false);
  });

  it("a token past its 24 hours answers 400 verification_link_expired", async () => {
    const ctx = await pendingVerification();
    vi.setSystemTime(new Date(START.getTime() + 24 * HOUR + 60 * 1000));

    const response = await ctx.verify({ token: ctx.token });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "verification_link_expired" },
    });
    expect(await ctx.verified()).toBe(false);
  });

  it("a token within its 24 hours still works", async () => {
    const ctx = await pendingVerification();
    vi.setSystemTime(new Date(START.getTime() + 23 * HOUR));

    const response = await ctx.verify({ token: ctx.token });

    expect(response.status).toBe(200);
  });

  it.each([
    ["no token", {}],
    ["empty token", { token: "" }],
    ["token that is not a string", { token: 5 }],
    ["token too long", { token: "a".repeat(4097) }],
    ["body that is an array", ["x"]],
  ])("%s answers 400 verification_link_invalid", async (_name, body) => {
    const ctx = await pendingVerification();

    const response = await ctx.verify(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "verification_link_invalid" },
    });
  });

  it("a body that is not JSON answers 400 verification_link_invalid", async () => {
    const ctx = await pendingVerification();

    const response = await verifyEmailWithToken(
      ctx.auth,
      new Request(`${testBaseURL}/api/email-verification`, {
        body: "não é json",
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
  });
});

describe("change of the password and the sign-in lock (same counter)", {
  timeout: 30_000,
}, () => {
  const wrong = "a senha atual que não é esta, de jeito nenhum";

  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function lockedSetup(withLock = true) {
    const parts = createPasswordTestAuth();
    const email = "troca-trava@example.invalid";
    await createVerifiedPasswordUser(parts.auth, email);
    const cookie = await signInCookie(parts.auth, email);
    const memory = createMemoryLoginLockStore();
    const sendUnlock = vi.fn((_email: string, _key: string) =>
      Promise.resolve()
    );
    const fx = createEffects(parts.auditEvents, () => Promise.resolve());
    if (withLock) {
      fx.effects.loginLock = {
        secret: testSecret,
        sendUnlock,
        store: memory.store,
      };
    }
    const key = await loginLockKey(testSecret, email);
    const change = (body: Record<string, unknown>, headers = cookie) =>
      handleChangePasswordRequest(
        parts.auth,
        jsonRequest("/api/auth/change-password", body, { cookie: headers }),
        fx.effects
      );
    return { ...parts, ...memory, change, cookie, email, fx, key, sendUnlock };
  }

  it("five wrong current passwords lock, and the sixth with the right one is a 429 that changes nothing", async () => {
    const ctx = await lockedSetup();

    for (let count = 1; count <= 5; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      const response = await ctx.change({
        currentPassword: wrong,
        newPassword,
      });
      expect(response.status).toBe(400);
    }
    const locked = await ctx.change({
      currentPassword: testPassword,
      newPassword,
    });

    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect(await locked.json()).toEqual({
      error: { code: "auth_login_locked" },
      retryAfterSeconds: 900,
    });
    expect(ctx.auditEvents).toEqual([]);
    expect(ctx.fx.sendPasswordNotice).not.toHaveBeenCalled();
    expect(await sessionOf(ctx.auth, ctx.cookie)).not.toBeNull();
    // the password did not change: the old one signs in, the new one does not
    await expect(signInCookie(ctx.auth, ctx.email)).resolves.toBeTruthy();
    await expect(
      signInCookie(ctx.auth, ctx.email, newPassword)
    ).rejects.toThrow();
  });

  it("sends the unlock e-mail once, in the background, when the fifth failure locks", async () => {
    const ctx = await lockedSetup();

    for (let count = 1; count <= 4; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count one after the other
      await ctx.change({ currentPassword: wrong, newPassword });
    }
    expect(ctx.sendUnlock).not.toHaveBeenCalled();
    await ctx.change({ currentPassword: wrong, newPassword });
    await ctx.change({ currentPassword: testPassword, newPassword });

    expect(ctx.sendUnlock).toHaveBeenCalledTimes(1);
    expect(ctx.sendUnlock).toHaveBeenCalledWith(ctx.email, ctx.key);
    expect(ctx.fx.runInBackground).toHaveBeenCalledTimes(1);
  });

  it("schedules the unlock e-mail when `begin` reports the lock as new", async () => {
    const ctx = await lockedSetup();
    ctx.begin.mockResolvedValueOnce({
      allowed: false,
      newlyLocked: true,
      retryAfterSeconds: 900,
    });

    const response = await ctx.change({
      currentPassword: testPassword,
      newPassword,
    });

    expect(response.status).toBe(429);
    expect(ctx.sendUnlock).toHaveBeenCalledWith(ctx.email, ctx.key);
    expect(ctx.fx.runInBackground).toHaveBeenCalledTimes(1);
  });

  it("failures of the change and of the sign-in add up on the same key", async () => {
    const ctx = await lockedSetup();
    const { handleEmailSignInWithLock } = await import("./login-lock");
    const signInWrong = () =>
      handleEmailSignInWithLock(
        jsonRequest("/api/auth/sign-in/email", {
          email: ctx.email,
          password: wrong,
        }),
        {
          recordRefusal: () => Promise.resolve(),
          runInBackground: () => undefined,
          secret: testSecret,
          sendUnlock: () => Promise.resolve(),
          signIn: (request) => ctx.auth.handler(request),
          store: ctx.store,
        }
      );

    await signInWrong();
    await signInWrong();
    await ctx.change({ currentPassword: wrong, newPassword });
    await ctx.change({ currentPassword: wrong, newPassword });
    expect(ctx.rows.size).toBe(1);
    expect(ctx.rows.get(ctx.key)?.attempts).toBe(4);
    const fifth = await signInWrong();
    expect(fifth.status).toBe(401);

    const sixth = await ctx.change({
      currentPassword: testPassword,
      newPassword,
    });
    expect(sixth.status).toBe(429);
    const keys = new Set(ctx.begin.mock.calls.map(([key]) => key));
    expect(keys).toEqual(new Set([ctx.key]));
  });

  it("a successful change forgets the count", async () => {
    const ctx = await lockedSetup();

    await ctx.change({ currentPassword: wrong, newPassword });
    await ctx.change({ currentPassword: wrong, newPassword });
    expect(ctx.rows.get(ctx.key)?.attempts).toBe(2);
    const ok = await ctx.change({ currentPassword: testPassword, newPassword });

    expect(ok.status).toBe(200);
    expect(ctx.clear).toHaveBeenCalledWith(ctx.key);
    expect(ctx.rows.has(ctx.key)).toBe(false);
  });

  it("a new password outside the policy does not reserve an attempt", async () => {
    const ctx = await lockedSetup();

    const response = await ctx.change({
      currentPassword: wrong,
      newPassword: "curta demais",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "password_too_short" },
    });
    expect(ctx.begin).not.toHaveBeenCalled();
    expect(ctx.failed).not.toHaveBeenCalled();
    expect(ctx.clear).not.toHaveBeenCalled();
  });

  it("a request without a valid session is refused before the lock is touched", async () => {
    const ctx = await lockedSetup();

    const response = await ctx.change(
      { currentPassword: testPassword, newPassword },
      "better-auth.session_token=lixo"
    );

    // no session: refused before the lock
    expect(response.status).toBe(401);
    expect(ctx.begin).not.toHaveBeenCalled();
  });

  it("without loginLock the old behavior stands: no counter, wrong passwords never lock", async () => {
    const ctx = await lockedSetup(false);

    for (let count = 1; count <= 6; count += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one after the other
      const response = await ctx.change({
        currentPassword: wrong,
        newPassword,
      });
      expect(response.status).toBe(400);
    }
    const ok = await ctx.change({ currentPassword: testPassword, newPassword });

    expect(ok.status).toBe(200);
    expect(ctx.begin).not.toHaveBeenCalled();
    expect(ctx.failed).not.toHaveBeenCalled();
    expect(ctx.clear).not.toHaveBeenCalled();
  });
});

describe("settling of the change of password when the lock store fails", () => {
  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setupWithLock() {
    const parts = createPasswordTestAuth();
    const email = "troca-store@example.invalid";
    const user = await createVerifiedPasswordUser(parts.auth, email);
    const cookie = await signInCookie(parts.auth, email);
    const memory = createMemoryLoginLockStore();
    const bump = vi.fn((_userId: string) => Promise.resolve());
    const fx = createEffects(parts.auditEvents, bump);
    fx.effects.loginLock = {
      secret: testSecret,
      sendUnlock: () => Promise.resolve(),
      store: memory.store,
    };
    const change = (currentPassword: string) =>
      handleChangePasswordRequest(
        parts.auth,
        jsonRequest(
          "/api/auth/change-password",
          { currentPassword, newPassword },
          { cookie }
        ),
        fx.effects
      );
    return { ...parts, ...memory, bump, change, fx, user };
  }

  it("a clear that throws after the change leaves the 200, the bump, the audit and the notice", async () => {
    const ctx = await setupWithLock();
    ctx.clear.mockRejectedValueOnce(new Error("lock store down"));

    const response = await ctx.change(testPassword);

    expect(response.status).toBe(200);
    expect(ctx.bump).toHaveBeenCalledWith(ctx.user.id);
    expect(ctx.auditEvents.map((event) => event.eventType)).toContain(
      "password_changed"
    );
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledTimes(1);
  });

  it("a failed that throws after a wrong current password still answers the 400 of Better Auth", async () => {
    const ctx = await setupWithLock();
    ctx.failed.mockRejectedValueOnce(new Error("lock store down"));

    const response = await ctx.change("a senha atual que não é esta, nada");

    expect(response.status).toBe(400);
    expect(ctx.bump).not.toHaveBeenCalled();
    expect(ctx.auditEvents).toEqual([]);
  });
});

describe("set-password revokes the other sessions and the leases", () => {
  beforeEach(() => {
    useFakeClock();
    stubPwnedPasswordRange();
    silenceLogs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setup() {
    const parts = createPasswordTestAuth();
    const helpers = await authTestHelpers(parts.auth);
    const email = "set-revoga@example.invalid";
    const user = await helpers.saveUser(
      helpers.createUser({ email, emailVerified: true })
    );
    const current = await helpers.login({ userId: user.id });
    const other = await helpers.login({ userId: user.id });
    const bump = vi.fn((_userId: string) => Promise.resolve());
    const fx = createEffects(parts.auditEvents, bump);
    return { ...parts, bump, current, email, fx, other, user };
  }

  it("after the success the other session falls, this one stays, the epoch changes, and the audit and notice happen", async () => {
    const ctx = await setup();

    const response = await handleSetPasswordRequest(
      ctx.auth,
      jsonRequest(
        "/api/auth/set-password",
        { newPassword: testPassword },
        ctx.current.headers
      ),
      ctx.fx.effects
    );

    expect(response.status).toBe(200);
    const currentCookie = ctx.current.headers.get("cookie") ?? "";
    const otherCookie = ctx.other.headers.get("cookie") ?? "";
    expect(await sessionOf(ctx.auth, otherCookie)).toBeNull();
    expect(await sessionOf(ctx.auth, currentCookie)).toMatchObject({
      user: { id: ctx.user.id },
    });
    expect(ctx.bump).toHaveBeenCalledTimes(1);
    expect(ctx.bump).toHaveBeenCalledWith(ctx.user.id);
    expect(ctx.auditEvents.map((event) => event.eventType)).toEqual([
      "password_set",
    ]);
    expect(ctx.fx.sendPasswordNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "set", to: ctx.email })
    );
  });

  it("a refused password (policy) revokes nothing and does not bump", async () => {
    const ctx = await setup();

    const response = await handleSetPasswordRequest(
      ctx.auth,
      jsonRequest(
        "/api/auth/set-password",
        { newPassword: "curta" },
        ctx.current.headers
      ),
      ctx.fx.effects
    );

    expect(response.status).toBe(400);
    expect(
      await sessionOf(ctx.auth, ctx.other.headers.get("cookie") ?? "")
    ).not.toBeNull();
    expect(ctx.bump).not.toHaveBeenCalled();
  });

  it("without effects the old behavior stands: no revocation, no bump", async () => {
    const ctx = await setup();

    const response = await handleSetPasswordRequest(
      ctx.auth,
      jsonRequest(
        "/api/auth/set-password",
        { newPassword: testPassword },
        ctx.current.headers
      )
    );

    expect(response.status).toBe(200);
    expect(
      await sessionOf(ctx.auth, ctx.other.headers.get("cookie") ?? "")
    ).not.toBeNull();
    expect(ctx.bump).not.toHaveBeenCalled();
  });
});

describe("the unlock e-mail of a new lock (sendLoginUnlock)", () => {
  beforeEach(() => {
    stubPwnedPasswordRange();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sender(auth: PasswordTestAuth) {
    const send = vi.fn((_input: { to: string; token: string }) =>
      Promise.resolve()
    );
    const issueUnlock = vi.fn((_key: string, _sha: Uint8Array) =>
      Promise.resolve(true)
    );
    const audits: AuthSecurityAuditEvent[] = [];
    return {
      audits,
      issueUnlock,
      send,
      value: {
        auth,
        requestId: "unlock-test-request",
        send,
        store: { issueUnlock },
        writeAuditEvent: (event: AuthSecurityAuditEvent) => {
          audits.push(event);
          return Promise.resolve();
        },
      },
    };
  }

  it("sends to a verified account with a password, stores only the hash and audits login_locked (AC-64)", async () => {
    const { auth } = createPasswordTestAuth();
    const user = await createVerifiedPasswordUser(
      auth,
      "travada@example.invalid"
    );
    const unlock = sender(auth);
    const key = await loginLockKey(testSecret, "travada@example.invalid");

    await sendLoginUnlock(unlock.value, "Travada@Example.invalid", key);

    expect(unlock.send).toHaveBeenCalledTimes(1);
    const sent = unlock.send.mock.calls[0]?.[0];
    expect(sent?.to).toBe("travada@example.invalid");
    expect(sent?.token.startsWith(`${user.id}.`)).toBe(true);
    expect(unlock.issueUnlock).toHaveBeenCalledWith(
      key,
      await sha256(sent?.token ?? "")
    );
    expect(unlock.audits).toEqual([
      expect.objectContaining({ actorId: user.id, eventType: "login_locked" }),
    ]);
  });

  it("sends nothing to an account whose e-mail was never verified", async () => {
    const { auth } = createPasswordTestAuth();
    await auth.handler(
      jsonRequest("/api/auth/sign-up/email", {
        email: "nao-verificada@example.invalid",
        legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
        name: "Pessoa",
        password: testPassword,
      })
    );
    const unlock = sender(auth);

    await sendLoginUnlock(
      unlock.value,
      "nao-verificada@example.invalid",
      await loginLockKey(testSecret, "nao-verificada@example.invalid")
    );

    expect(unlock.issueUnlock).not.toHaveBeenCalled();
    expect(unlock.send).not.toHaveBeenCalled();
    expect(unlock.audits).toEqual([]);
  });

  it("sends nothing to an e-mail without an account or without a password", async () => {
    const { auth } = createPasswordTestAuth();
    const helpers = await authTestHelpers(auth);
    await helpers.saveUser(
      helpers.createUser({
        email: "so-google@example.invalid",
        emailVerified: true,
      })
    );
    const unlock = sender(auth);

    for (const email of [
      "so-google@example.invalid",
      "ninguem@example.invalid",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one case after the other
      await sendLoginUnlock(
        unlock.value,
        email,
        await loginLockKey(testSecret, email)
      );
    }

    expect(unlock.issueUnlock).not.toHaveBeenCalled();
    expect(unlock.send).not.toHaveBeenCalled();
  });

  it("sends nothing when the lock already has a token (one e-mail per lock)", async () => {
    const { auth } = createPasswordTestAuth();
    await createVerifiedPasswordUser(auth, "segunda@example.invalid");
    const unlock = sender(auth);
    unlock.issueUnlock.mockResolvedValue(false);

    await sendLoginUnlock(
      unlock.value,
      "segunda@example.invalid",
      await loginLockKey(testSecret, "segunda@example.invalid")
    );

    expect(unlock.send).not.toHaveBeenCalled();
    expect(unlock.audits).toEqual([]);
  });
});
