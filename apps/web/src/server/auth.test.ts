import { betterAuth, type BetterAuthPlugin } from "better-auth";
import type { GoogleOptions } from "better-auth/social-providers";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEmailDelivery, AuthSecurityAuditEvent } from "./auth";
import { createBetterAuth } from "./auth";
import { handleBetterAuthRequest } from "./auth/handler";
import { createResendAuthEmailDelivery } from "./auth/email";
import { app, createServerApp } from "./app";
import type { WorkerBindings } from "./environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const SET_COOKIE_SPLIT_REGEX = /,(?=\s*[^;,=\s]+=)/;
const EXPIRED_COOKIE_REGEX = /;\s*max-age=0/i;
const SESSION_COOKIE_REGEX = /(?:__Secure-)?better-auth\.session_token=/;
const HIBP_RANGE_PATH_PATTERN =
  /^https:\/\/api\.pwnedpasswords\.com\/range\/[A-F0-9]{5}$/;
const testBindings = {
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
  BETTER_AUTH_SECRET: testSecret,
  BETTER_AUTH_BASE_URL: testBaseURL,
  HYPERDRIVE: { connectionString: "" },
} as WorkerBindings;

interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
}

const testGoogleProvider: GoogleOptions = {
  accessType: "online",
  clientId: "google-test-client",
  clientSecret: "google-test-secret",
  disableIdTokenSignIn: true,
  getUserInfo: async () => ({
    data: { sub: "google-subject-1" },
    user: {
      email: "google@example.invalid",
      emailVerified: true,
      id: "google-subject-1",
      name: "Google Test User",
    },
  }),
  redirectURI: `${testBaseURL}/api/auth/callback/google`,
  verifyIdToken: async () => true,
};

function createGoogleTestApp() {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const databaseAdapter = memoryAdapter({
    account: [],
    session: [],
    user: [],
    verification: [],
  });
  const auth = createBetterAuth({
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter,
    googleProvider: testGoogleProvider,
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "pr14-oauth-test-request",
    secret: testSecret,
  });
  const testApp = createServerApp({
    authHandler: (request) => auth.handler(request),
  });

  return { app: testApp, auditEvents, auth };
}
function createEmailPasswordTestApp(emailDeliveryOverride?: AuthEmailDelivery) {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const verificationEmails: Array<{
    email: string;
    token: string;
    url: string;
  }> = [];
  const passwordResetEmails: Array<{
    email: string;
    token: string;
    url: string;
  }> = [];
  const databaseAdapter = memoryAdapter({
    account: [],
    session: [],
    user: [],
    verification: [],
  });
  const emailDelivery: AuthEmailDelivery = {
    sendPasswordReset: ({ user, token, url }) => {
      passwordResetEmails.push({ email: user.email, token, url });
      return Promise.resolve();
    },
    sendVerificationEmail: ({ user, token, url }) => {
      verificationEmails.push({ email: user.email, token, url });
      return Promise.resolve();
    },
  };
  const auth = createBetterAuth({
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter,
    emailDelivery: emailDeliveryOverride ?? emailDelivery,
    requestId: "pr15-email-auth-test-request",
    secret: testSecret,
  });
  const testApp = createServerApp({
    // These tests isolate Better Auth; abuse controls have dedicated tests.
    authAbuseProtector: async () => undefined,
    authHandler: (request) => auth.handler(request),
  });

  return {
    app: testApp,
    auditEvents,
    auth,
    passwordResetEmails,
    verificationEmails,
  };
}

function stubPwnedPasswordRange() {
  let calls = 0;
  let requestURL = "";
  let addPadding = "";

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === "string") {
        requestURL = input;
      } else if (input instanceof Request) {
        requestURL = input.url;
      } else {
        requestURL = input.href;
      }

      if (!requestURL.startsWith("https://api.pwnedpasswords.com/range/")) {
        throw new Error("Unexpected outbound request during auth test.");
      }

      addPadding = new Headers(init?.headers).get("Add-Padding") ?? "";
      calls += 1;
      return Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`));
    }
  );

  return {
    calls: () => calls,
    requestURL: () => requestURL,
    addPadding: () => addPadding,
  };
}

function setCookieValues(headers: Headers): string[] {
  const headersWithGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values =
    typeof headersWithGetSetCookie.getSetCookie === "function"
      ? headersWithGetSetCookie.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(SET_COOKIE_SPLIT_REGEX);

  return values
    .filter((value) => value.length > 0 && !EXPIRED_COOKIE_REGEX.test(value))
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter((value) => value.length > 0 && !value.endsWith("="));
}

function cookieHeader(headers: Headers): string {
  return setCookieValues(headers).join("; ");
}

async function beginGoogleLogin(
  testApp: ReturnType<typeof createGoogleTestApp>["app"]
) {
  const response = await testApp.request(
    "/api/auth/sign-in/social",
    {
      body: JSON.stringify({
        callbackURL: "/dashboard",
        errorCallbackURL: "/auth-error",
        provider: "google",
      }),
      headers: {
        "content-type": "application/json",
        origin: testBaseURL,
      },
      method: "POST",
    },
    testBindings
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  expect(body.url).toBeTruthy();

  const authorizationURL = new URL(body.url as string);
  const state = authorizationURL.searchParams.get("state");
  const cookies = cookieHeader(response.headers);

  expect(authorizationURL.origin).toBe("https://accounts.google.com");
  expect(authorizationURL.searchParams.get("client_id")).toBe(
    "google-test-client"
  );
  expect(authorizationURL.searchParams.get("redirect_uri")).toBe(
    `${testBaseURL}/api/auth/callback/google`
  );
  expect(state).toBeTruthy();
  expect(cookies.length).toBeGreaterThan(0);

  return { cookies, state: state as string };
}

function stubGoogleTokenExchange() {
  let tokenCalls = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    let target: string;
    if (typeof input === "string") {
      target = input;
    } else if (input instanceof Request) {
      target = input.url;
    } else {
      target = input.href;
    }

    if (target !== "https://oauth2.googleapis.com/token") {
      throw new Error("Unexpected OAuth endpoint in the test.");
    }

    tokenCalls += 1;
    return Promise.resolve(
      Response.json({
        access_token: "test-access-token",
        expires_in: 3600,
        id_token: "test-id-token",
        scope: "openid email profile",
        token_type: "Bearer",
      })
    );
  });

  return () => tokenCalls;
}

describe("Better Auth route", () => {
  it("fails closed when the Worker secret is not configured", async () => {
    const env = {
      DB_POC_ENABLED: "false",
      DB_RLS_POC_ENABLED: "false",
      HYPERDRIVE: { connectionString: "" },
    } as WorkerBindings;

    const response = await app.request("/api/auth/get-session", {}, env);

    expect(response.status).toBe(503);
  });

  it("creates, reads, and revokes a server-side session through the Worker route", async () => {
    const testPlugin = testUtils() as unknown as BetterAuthPlugin;
    const auth = betterAuth({
      baseURL: testBaseURL,
      database: memoryAdapter({
        account: [],
        session: [],
        user: [],
        verification: [],
      }),
      plugins: [testPlugin],
      secret: testSecret,
    });
    const helpers = (
      (await auth.$context) as unknown as { test: TestAuthHelpers }
    ).test;
    const user = await helpers.saveUser(helpers.createUser());
    const login = await helpers.login({ userId: user.id });

    const testApp = createServerApp({
      authHandler: (request) => auth.handler(request),
    });
    const sessionResponse = await testApp.request(
      "/api/auth/get-session",
      { headers: login.headers },
      testBindings
    );
    const sessionBody = (await sessionResponse.json()) as {
      session?: { token?: string };
    };

    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.session?.token).toBe(login.token);

    const revokeHeaders = new Headers(login.headers);
    revokeHeaders.set("content-type", "application/json");
    const revokeResponse = await testApp.request(
      "/api/auth/revoke-session",
      {
        body: JSON.stringify({ token: login.token }),
        headers: revokeHeaders,
        method: "POST",
      },
      testBindings
    );
    const afterRevoke = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: login.headers },
      testBindings
    );

    expect(revokeResponse.status).toBe(200);
    expect(await afterRevoke.json()).toBeNull();
  });
});

describe("Email/password authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires verified email before password login and normalizes Unicode", async () => {
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp();
    const hibp = stubPwnedPasswordRange();
    const password = "frase longa com acento e\u0301 para uma senha segura 42";
    const normalizedPassword = password.normalize("NFC");
    const email = "password-user@example.invalid";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({ email, name: "Password User", password }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(signUp.status).toBe(200);
    expect(signUp.headers.get("set-cookie") ?? "").not.toMatch(
      SESSION_COOKIE_REGEX
    );
    expect(verificationEmails).toHaveLength(1);
    expect(verificationEmails[0]?.email).toBe(email);
    expect(hibp.calls()).toBe(1);
    expect(hibp.addPadding()).toBe("true");
    expect(hibp.requestURL()).toMatch(HIBP_RANGE_PATH_PATTERN);

    const unverifiedLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: normalizedPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(unverifiedLogin.status).not.toBe(200);

    const verificationURL = new URL(verificationEmails[0]?.url as string);
    const verify = await testApp.request(
      `${verificationURL.pathname}?token=${encodeURIComponent(verificationEmails[0]?.token as string)}`,
      { headers: { origin: testBaseURL } },
      testBindings
    );
    expect(verify.status).toBe(200);
    expect(verify.headers.get("set-cookie") ?? "").not.toMatch(
      SESSION_COOKIE_REGEX
    );

    const login = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: normalizedPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(login.status).toBe(200);
    expect(cookieHeader(login.headers)).toMatch(SESSION_COOKIE_REGEX);
    expect(hibp.calls()).toBe(1);
  });

  it("uses generic reset responses and revokes all sessions after password reset", async () => {
    const {
      app: testApp,
      passwordResetEmails,
      verificationEmails,
    } = createEmailPasswordTestApp();
    const hibp = stubPwnedPasswordRange();
    const email = "reset-user@example.invalid";
    const oldPassword = "Old long password for Polaris 2026!";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          name: "Reset User",
          password: oldPassword,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(signUp.status).toBe(200);
    const verificationURL = new URL(verificationEmails[0]?.url as string);
    const verify = await testApp.request(
      `${verificationURL.pathname}?token=${encodeURIComponent(verificationEmails[0]?.token as string)}`,
      { headers: { origin: testBaseURL } },
      testBindings
    );
    expect(verify.status).toBe(200);

    const login = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: oldPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(login.status).toBe(200);
    const sessionCookie = cookieHeader(login.headers);
    const knownEmailReset = await testApp.request(
      "/api/auth/request-password-reset",
      {
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const unknownEmailReset = await testApp.request(
      "/api/auth/request-password-reset",
      {
        body: JSON.stringify({
          email: "unknown-user@example.invalid",
          redirectTo: "/reset-password",
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(knownEmailReset.status).toBe(200);
    expect(await knownEmailReset.json()).toEqual(
      await unknownEmailReset.json()
    );
    expect(passwordResetEmails).toHaveLength(1);

    const newPassword = "A different long password for Polaris 2026!";
    const reset = await testApp.request(
      "/api/auth/reset-password",
      {
        body: JSON.stringify({
          newPassword,
          token: passwordResetEmails[0]?.token,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(reset.status).toBe(200);
    expect(hibp.calls()).toBe(2);

    const priorSession = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: sessionCookie } },
      testBindings
    );
    expect(await priorSession.json()).toBeNull();

    const oldPasswordLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: oldPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(oldPasswordLogin.status).not.toBe(200);

    const newPasswordLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: newPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(newPasswordLogin.status).toBe(200);
  });

  it("uses NFC rather than compatibility normalization for password hashes", async () => {
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp();
    stubPwnedPasswordRange();
    const fullWidthPassword = `${"Ａ".repeat(15)}!`;
    const asciiPassword = `${"A".repeat(15)}!`;
    const email = "unicode-password@example.invalid";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          name: "Unicode Password",
          password: fullWidthPassword,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(signUp.status).toBe(200);

    const verificationToken = verificationEmails[0]?.token;
    const verify = await testApp.request(
      `/api/auth/verify-email?token=${encodeURIComponent(verificationToken ?? "")}`,
      { headers: { origin: testBaseURL } },
      testBindings
    );
    expect(verify.status).toBe(200);

    const compatibilityVariantLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: asciiPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const originalPasswordLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: fullWidthPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(compatibilityVariantLogin.status).not.toBe(200);
    expect(originalPasswordLogin.status).toBe(200);
  });
  it("normalizes the existing password before an authenticated password change", async () => {
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp();
    const hibp = stubPwnedPasswordRange();
    const email = "change-password@example.invalid";
    const currentPassword = "A passphrase with e\u0301 for Polaris 2026!";
    const newPassword = "A newly chosen passphrase for Polaris 2026!";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          name: "Password Change",
          password: currentPassword,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(signUp.status).toBe(200);
    const verify = await testApp.request(
      `/api/auth/verify-email?token=${encodeURIComponent(verificationEmails[0]?.token ?? "")}`,
      { headers: { origin: testBaseURL } },
      testBindings
    );
    expect(verify.status).toBe(200);

    const login = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({
          email,
          password: currentPassword.normalize("NFC"),
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(login.status).toBe(200);
    const change = await testApp.request(
      "/api/auth/change-password",
      {
        body: JSON.stringify({ currentPassword, newPassword }),
        headers: {
          cookie: cookieHeader(login.headers),
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(change.status).toBe(200);
    expect(hibp.calls()).toBe(2);

    const newPasswordLogin = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email, password: newPassword }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(newPasswordLogin.status).toBe(200);
  });
  it("does not query HIBP for an invalid reset token or unauthenticated password change", async () => {
    const { app: testApp } = createEmailPasswordTestApp();
    const hibp = stubPwnedPasswordRange();
    const invalidReset = await testApp.request(
      "/api/auth/reset-password",
      {
        body: JSON.stringify({
          newPassword: "A long password to test invalid reset token!",
          token: "invalid-reset-token",
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const unauthenticatedChange = await testApp.request(
      "/api/auth/change-password",
      {
        body: JSON.stringify({
          currentPassword: "A current long password!",
          newPassword: "A different long password to test session!",
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(invalidReset.status).not.toBe(200);
    expect(unauthenticatedChange.status).not.toBe(200);
    expect(hibp.calls()).toBe(0);
  });
  it("keeps verification and reset responses generic when Resend rejects delivery", async () => {
    const resendFetch = vi.fn<typeof fetch>((input) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof Request) {
        ({ url } = input);
      } else {
        ({ href: url } = input);
      }

      if (url.startsWith("https://api.pwnedpasswords.com/range/")) {
        return Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`));
      }

      if (url === "https://api.resend.com/emails") {
        return Promise.resolve(
          Response.json(
            { message: "provider detail must not be exposed" },
            { status: 403 }
          )
        );
      }

      return Promise.reject(
        new Error("Unexpected outbound request in auth test.")
      );
    });
    vi.stubGlobal("fetch", resendFetch);
    const loggerSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const emailDelivery = createResendAuthEmailDelivery({
      apiKey: "re_test_only",
      from: "Polaris <auth@example.invalid>",
    });
    const { app: testApp } = createEmailPasswordTestApp(emailDelivery);
    const email = "resend-outage@example.invalid";
    const password = "A unique long password for resend tests!";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({ email, name: "Resend Outage", password }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const knownVerification = await testApp.request(
      "/api/auth/send-verification-email",
      {
        body: JSON.stringify({ email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      testBindings
    );
    const unknownVerification = await testApp.request(
      "/api/auth/send-verification-email",
      {
        body: JSON.stringify({ email: "not-registered@example.invalid" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      testBindings
    );
    const knownReset = await testApp.request(
      "/api/auth/request-password-reset",
      {
        body: JSON.stringify({ email }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const unknownReset = await testApp.request(
      "/api/auth/request-password-reset",
      {
        body: JSON.stringify({ email: "not-registered@example.invalid" }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(signUp.status).toBe(200);
    expect(knownVerification.status).toBe(200);
    expect(unknownVerification.status).toBe(200);
    expect(await knownVerification.json()).toEqual(
      await unknownVerification.json()
    );
    expect(knownReset.status).toBe(200);
    expect(unknownReset.status).toBe(200);
    expect(await knownReset.json()).toEqual(await unknownReset.json());
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain(email);
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain(
      "provider detail must not be exposed"
    );
  });
  it("fails closed when HIBP is unavailable before account creation", async () => {
    const {
      app: testApp,
      verificationEmails,
      auth,
    } = createEmailPasswordTestApp();
    const password = "A very long test passphrase 2026!";
    const loggerSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () => Promise.reject(new Error(password)));

    const response = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email: "hibp-down@example.invalid",
          name: "HIBP Down",
          password,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const authContext = (await auth.$context) as unknown as {
      internalAdapter: {
        findUserByEmail: (email: string) => Promise<unknown>;
      };
    };

    expect(response.status).toBe(503);
    expect(
      await authContext.internalAdapter.findUserByEmail(
        "hibp-down@example.invalid"
      )
    ).toBeNull();
    expect(verificationEmails).toHaveLength(0);
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain(password);
  });
});
describe("Google OAuth and security audit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes OAuth, persists a session, logs out, and records payload-free audit events", async () => {
    const { app: testApp, auditEvents, auth } = createGoogleTestApp();
    const getTokenCalls = stubGoogleTokenExchange();
    const start = await beginGoogleLogin(testApp);
    const callback = await testApp.request(
      "/api/auth/callback/google?code=fake-code&state=" +
        encodeURIComponent(start.state),
      { headers: { cookie: start.cookies } },
      testBindings
    );
    const callbackCookies = cookieHeader(callback.headers);

    expect(callback.status).toBe(302);
    expect(callbackCookies.length).toBeGreaterThan(0);

    const sessionResponse = await testApp.request(
      "/api/auth/get-session",
      { headers: { cookie: callbackCookies } },
      testBindings
    );
    const sessionBody = (await sessionResponse.json()) as {
      user?: { id?: string };
      session?: { token?: string };
    };

    const authContext = (await auth.$context) as unknown as {
      internalAdapter: {
        findAccountByProviderId: (
          accountId: string,
          providerId: string
        ) => Promise<{
          accessToken?: string | null;
          idToken?: string | null;
        } | null>;
      };
    };
    const googleAccount =
      await authContext.internalAdapter.findAccountByProviderId(
        "google-subject-1",
        "google"
      );
    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.user?.id).toBeTruthy();
    expect(sessionBody.session?.token).toBeTruthy();
    expect(googleAccount?.idToken).toBeNull();
    expect(googleAccount?.accessToken).not.toBe("test-access-token");

    const logout = await testApp.request(
      "/api/auth/sign-out",
      {
        headers: {
          cookie: callbackCookies,
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const afterLogout = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: callbackCookies } },
      testBindings
    );

    expect(logout.status).toBe(200);
    expect(await afterLogout.json()).toBeNull();
    expect(getTokenCalls()).toBe(1);
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      "google_login_started",
      "google_callback_succeeded",
      "logout_succeeded",
    ]);
    expect(auditEvents[1]?.actorId).toBe(sessionBody.user?.id);
    expect(auditEvents[2]?.actorId).toBe(sessionBody.user?.id);

    const auditJSON = JSON.stringify(auditEvents);
    for (const sensitiveValue of [
      "google@example.invalid",
      "fake-code",
      "test-access-token",
      "test-id-token",
    ]) {
      expect(auditJSON).not.toContain(sensitiveValue);
    }
  });

  it("records a generic provider failure without persisting provider descriptions", async () => {
    const { app: testApp, auditEvents } = createGoogleTestApp();
    const start = await beginGoogleLogin(testApp);
    const callback =
      "/api/auth/callback/google?error=access_denied&error_description=" +
      encodeURIComponent("do-not-store-this-provider-detail") +
      "&state=" +
      encodeURIComponent(start.state);
    const response = await testApp.request(
      callback,
      { headers: { cookie: start.cookies } },
      testBindings
    );

    expect(response.status).toBe(302);
    expect(
      auditEvents.find((event) => event.eventType === "google_callback_failed")
        ?.errorCode
    ).toBe("provider_error");
    expect(JSON.stringify(auditEvents)).not.toContain(
      "do-not-store-this-provider-detail"
    );
    expect(JSON.stringify(auditEvents)).not.toContain("access_denied");
  });

  it("rejects an invalid state without exchanging the code or creating a session", async () => {
    const { app: testApp, auditEvents, auth } = createGoogleTestApp();
    const getTokenCalls = stubGoogleTokenExchange();
    const loggerSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await testApp.request(
      "/api/auth/callback/google?code=fake-code&state=forged-state",
      {},
      testBindings
    );
    const authContext = (await auth.$context) as unknown as {
      internalAdapter: {
        findAccountByProviderId: (
          accountId: string,
          providerId: string
        ) => Promise<{ id: string } | null>;
      };
    };
    const googleAccount =
      await authContext.internalAdapter.findAccountByProviderId(
        "google-subject-1",
        "google"
      );

    expect(response.status).not.toBe(200);
    expect(getTokenCalls()).toBe(0);
    expect(googleAccount).toBeNull();
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(
      SESSION_COOKIE_REGEX
    );
    expect(
      auditEvents.find((event) => event.eventType === "google_callback_failed")
        ?.errorCode
    ).toBe("callback_failed");
    expect(JSON.stringify(auditEvents)).not.toContain("forged-state");
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain("forged-state");
  });

  it("does not implicitly link a Google identity to an existing verified-email user", async () => {
    const { app: testApp, auditEvents, auth } = createGoogleTestApp();
    const helpers = (
      (await auth.$context) as unknown as { test: TestAuthHelpers }
    ).test;
    const existingUser = await helpers.saveUser(
      helpers.createUser({
        email: "google@example.invalid",
        emailVerified: true,
      })
    );
    const start = await beginGoogleLogin(testApp);
    const getTokenCalls = stubGoogleTokenExchange();
    const callback = await testApp.request(
      "/api/auth/callback/google?code=fake-code&state=" +
        encodeURIComponent(start.state),
      { headers: { cookie: start.cookies } },
      testBindings
    );
    const responseCookies = cookieHeader(callback.headers);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).not.toContain("/dashboard");
    expect(responseCookies).not.toMatch(SESSION_COOKIE_REGEX);
    expect(
      auditEvents.some(
        (event) => event.eventType === "google_callback_succeeded"
      )
    ).toBe(false);
    expect(
      auditEvents.find((event) => event.eventType === "google_callback_failed")
        ?.actorId
    ).toBeNull();
    expect(existingUser.id).toBeTruthy();
    expect(getTokenCalls()).toBe(1);
  });

  it("keeps email/password routes disabled without the feature flag and Resend sender", async () => {
    const request = new Request(`${testBaseURL}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email: "user@example.invalid",
        name: "Test User",
        password: "A long enough test password!",
      }),
      headers: { "content-type": "application/json", origin: testBaseURL },
      method: "POST",
    });
    const missingSender = await handleBetterAuthRequest(
      request,
      { ...testBindings, EMAIL_PASSWORD_AUTH_ENABLED: "true" },
      "pr15-test"
    );
    const disabledFeature = await handleBetterAuthRequest(
      request,
      {
        ...testBindings,
        AUTH_EMAIL_FROM: "Polaris <auth@example.invalid>",
        EMAIL_PASSWORD_AUTH_ENABLED: "false",
        RESEND_API_KEY: "re_test_only",
      },
      "pr15-test"
    );

    expect(missingSender.status).toBe(503);
    expect(await missingSender.json()).toEqual({
      error: { code: "auth_email_unavailable" },
    });
    expect(disabledFeature.status).toBe(503);
    expect(await disabledFeature.json()).toEqual({
      error: { code: "auth_email_unavailable" },
    });
  });
  it("fails closed when Google credentials are missing", async () => {
    const request = new Request(`${testBaseURL}/api/auth/sign-in/social`, {
      body: JSON.stringify({ provider: "google" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const env = {
      BETTER_AUTH_BASE_URL: testBaseURL,
      BETTER_AUTH_SECRET: testSecret,
      DB_POC_ENABLED: "false",
      DB_RLS_POC_ENABLED: "false",
      HYPERDRIVE: { connectionString: "" },
    } as WorkerBindings;

    const response = await handleBetterAuthRequest(request, env, "pr14-test");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "auth_provider_unavailable" },
    });
  });
});
