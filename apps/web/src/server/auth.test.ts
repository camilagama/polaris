import { logger } from "@polaris/observability/logger";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import type { GoogleOptions } from "better-auth/social-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createServerApp } from "./app";
import type { AuthEmailDelivery, AuthSecurityAuditEvent } from "./auth";
import { createBetterAuth, databaseVerificationLinkRecorder } from "./auth";
import type { AccessLogWriter } from "./auth/access-log";
import { createResendAuthEmailDelivery } from "./auth/email";
import { handleBetterAuthRequest } from "./auth/handler";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./auth/legal-acceptance-test-support";
import {
  hostileRedirectTargets,
  validReturnCallbackURL,
} from "./auth/redirect-target-test-cases";
import { withSocialRateLimit } from "./auth/social-rate-limit-test-support";
import type { WorkerBindings } from "./environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const SET_COOKIE_SPLIT_REGEX = /,(?=\s*[^;,=\s]+=)/;
const EXPIRED_COOKIE_REGEX = /;\s*max-age=0/i;
const SESSION_COOKIE_REGEX = /(?:__Secure-)?better-auth\.session_token=/;
const HIBP_RANGE_PATH_PATTERN =
  /^https:\/\/api\.pwnedpasswords\.com\/range\/[A-F0-9]{5}$/;
const testBindings = {
  BETTER_AUTH_BASE_URL: testBaseURL,
  BETTER_AUTH_SECRET: testSecret,
  HYPERDRIVE: { connectionString: "" },
} as WorkerBindings;

interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
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

type LegalAcceptanceRecorder = NonNullable<
  Parameters<typeof createBetterAuth>[0]["legalAcceptanceRecorder"]
>;

function createGoogleTestApp(
  accessLogWriter?: AccessLogWriter,
  legalAcceptanceRecorder?: LegalAcceptanceRecorder
) {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const databaseAdapter = memoryAdapter({
    account: [],
    session: [],
    user: [],
    verification: [],
  });
  const auth = createBetterAuth({
    ...(accessLogWriter ? { accessLogWriter } : {}),
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter,
    googleProvider: testGoogleProvider,
    ...(legalAcceptanceRecorder ? { legalAcceptanceRecorder } : {}),
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "pr14-oauth-test-request",
    secret: testSecret,
  });
  const testApp = withSocialRateLimit(
    createServerApp({
      authHandler: (request) => auth.handler(request),
    })
  );

  return { app: testApp, auditEvents, auth };
}
function createEmailPasswordTestApp(
  emailDeliveryOverride?: AuthEmailDelivery,
  options: {
    failEpochBump?: boolean;
    legalAcceptanceRecorder?: LegalAcceptanceRecorder;
    verificationLinkRecorder?: (userId: string) => Promise<void>;
  } = {}
) {
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
  const epochBumps: string[] = [];
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
    authorizationEpochBumper: (userId) => {
      epochBumps.push(userId);
      return options.failEpochBump
        ? Promise.reject(new Error("epoch bump failed"))
        : Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter,
    emailDelivery: emailDeliveryOverride ?? emailDelivery,
    ...(options.legalAcceptanceRecorder
      ? { legalAcceptanceRecorder: options.legalAcceptanceRecorder }
      : {}),
    ...(options.verificationLinkRecorder
      ? { verificationLinkRecorder: options.verificationLinkRecorder }
      : {}),
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
    epochBumps,
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
    addPadding: () => addPadding,
    calls: () => calls,
    requestURL: () => requestURL,
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

describe("Better Auth session configuration", () => {
  it("keeps the session cookie cache off, so a deleted session row drops the cookie on the next request", () => {
    const auth = createBetterAuth({
      auditEventWriter: () => Promise.resolve(),
      baseURL: testBaseURL,
      databaseAdapter: memoryAdapter({
        account: [],
        session: [],
        user: [],
        verification: [],
      }),
      secret: testSecret,
    });

    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
  });
});

describe("Better Auth route", () => {
  it("fails closed when the Worker secret is not configured", async () => {
    const env = {
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
    revokeHeaders.set("origin", testBaseURL);
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
        body: JSON.stringify({
          email,
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
          name: "Password User",
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
      epochBumps,
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
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
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
    const secondLogin = await testApp.request(
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
    expect(secondLogin.status).toBe(200);
    const secondSessionCookie = cookieHeader(secondLogin.headers);
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
    // A password reset invalidates every offline lease of the user.
    expect(epochBumps).toHaveLength(1);
    expect(epochBumps[0]).toBeTruthy();

    const priorSession = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: sessionCookie } },
      testBindings
    );
    expect(await priorSession.json()).toBeNull();

    const secondPriorSession = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: secondSessionCookie } },
      testBindings
    );
    expect(await secondPriorSession.json()).toBeNull();

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
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
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
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
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
          "content-type": "application/json",
          cookie: cookieHeader(login.headers),
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
  it("still revokes every session when the offline epoch bump fails during a password reset", async () => {
    const {
      app: testApp,
      epochBumps,
      passwordResetEmails,
      verificationEmails,
    } = createEmailPasswordTestApp(undefined, { failEpochBump: true });
    stubPwnedPasswordRange();
    const email = "reset-bump-failure@example.invalid";
    const oldPassword = "Old long password for Polaris 2026!";
    const post = (path: string, body: unknown, cookie?: string) =>
      testApp.request(
        path,
        {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            origin: testBaseURL,
            ...(cookie ? { cookie } : {}),
          },
          method: "POST",
        },
        testBindings
      );
    await post("/api/auth/sign-up/email", {
      email,
      legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
      name: "Reset Bump Failure",
      password: oldPassword,
    });
    const verificationURL = new URL(verificationEmails[0]?.url as string);
    await testApp.request(
      `${verificationURL.pathname}?token=${encodeURIComponent(verificationEmails[0]?.token as string)}`,
      { headers: { origin: testBaseURL } },
      testBindings
    );
    const login = await post("/api/auth/sign-in/email", {
      email,
      password: oldPassword,
    });
    const sessionCookie = cookieHeader(login.headers);
    await post("/api/auth/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });

    const reset = await post("/api/auth/reset-password", {
      newPassword: "A different long password for Polaris 2026!",
      token: passwordResetEmails[0]?.token,
    });

    expect(reset.status).toBe(200);
    expect(epochBumps).toHaveLength(1); // it was attempted, and failed
    const priorSession = await testApp.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: sessionCookie } },
      testBindings
    );
    expect(await priorSession.json()).toBeNull();
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
      appBaseURL: "http://localhost",
      from: "Polaris <auth@example.invalid>",
    });
    const { app: testApp } = createEmailPasswordTestApp(emailDelivery);
    const email = "resend-outage@example.invalid";
    const password = "A unique long password for resend tests!";
    const signUp = await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
          name: "Resend Outage",
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
    const knownVerification = await testApp.request(
      "/api/auth/send-verification-email",
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
    const unknownVerification = await testApp.request(
      "/api/auth/send-verification-email",
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
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
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

  it("does not give a failed Google callback the user of an earlier sign-out", async () => {
    const entries: { event: string; userId: string | null }[] = [];
    const { app: testApp } = createGoogleTestApp((entry) => {
      entries.push({ event: entry.event, userId: entry.userId });
      return Promise.resolve(true);
    });
    stubGoogleTokenExchange();
    const first = await beginGoogleLogin(testApp);
    const callback = await testApp.request(
      "/api/auth/callback/google?code=fake-code&state=" +
        encodeURIComponent(first.state),
      { headers: { cookie: first.cookies } },
      testBindings
    );
    await testApp.request(
      "/api/auth/sign-out",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          cookie: cookieHeader(callback.headers),
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const second = await beginGoogleLogin(testApp);
    await testApp.request(
      "/api/auth/callback/google?error=access_denied&state=" +
        encodeURIComponent(second.state),
      {
        headers: {
          "cf-connecting-ip": "203.0.113.8",
          cookie: second.cookies,
        },
      },
      testBindings
    );

    expect(entries.map((entry) => entry.event)).toContain("logout");
    expect(entries.filter((entry) => entry.event === "login_failed")).toEqual([
      { event: "login_failed", userId: null },
    ]);
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
        legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
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
      HYPERDRIVE: { connectionString: "" },
    } as WorkerBindings;

    const response = await handleBetterAuthRequest(request, env, "pr14-test");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "auth_provider_unavailable" },
    });
  });
});

describe("redirect targets of the Google sign-in start (open redirect)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function startGoogleLogin(
    testApp: ReturnType<typeof createGoogleTestApp>["app"],
    body: Record<string, unknown>
  ) {
    return testApp.request(
      "/api/auth/sign-in/social",
      {
        body: JSON.stringify({ provider: "google", ...body }),
        headers: { "content-type": "application/json", origin: testBaseURL },
        method: "POST",
      },
      testBindings
    );
  }

  it("accepts the sign-in page carrying a totally encoded destination with a query", async () => {
    const { app: testApp } = createGoogleTestApp();

    const response = await startGoogleLogin(testApp, {
      callbackURL: validReturnCallbackURL,
      errorCallbackURL: "/entrar?erro=google",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url?: string };
    expect(new URL(body.url as string).origin).toBe(
      "https://accounts.google.com"
    );
  });

  describe.each(["callbackURL", "errorCallbackURL", "newUserCallbackURL"])(
    "in %s",
    (field) => {
      it.each(hostileRedirectTargets)(
        "refuses %s with 403 and no Location",
        async (_reason, target) => {
          vi.spyOn(console, "error").mockImplementation(() => undefined);
          const { app: testApp } = createGoogleTestApp();

          const response = await startGoogleLogin(testApp, { [field]: target });

          expect(response.status).toBe(403);
          expect(response.headers.get("location")).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(await response.text()).not.toContain("accounts.google.com");
        }
      );
    }
  );

  it.each([
    ["the API", "/api/auth/sign-out"],
    ["RPC", "/rpc/sales/list"],
    ["the characters the library refuses (the '(x)' case)", "/vendas(x)"],
    ["a dot segment that turns the path protocol-relative", "/.//evil.example"],
    [
      "a destination (voltar) that points to the API",
      "/entrar?voltar=%2Fapi%2Fx",
    ],
  ])(
    "refuses %s with the code of the app's own rule",
    async (_reason, target) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { app: testApp } = createGoogleTestApp();

      const response = await startGoogleLogin(testApp, { callbackURL: target });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "invalid_redirect_target",
      });
    }
  );

  describe("in the other routes that take a redirect target", () => {
    it("refuses a hostile redirectTo when a password reset is requested", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { app: testApp, passwordResetEmails } =
        createEmailPasswordTestApp();

      for (const redirectTo of [
        "https://evil.example",
        "//evil.example",
        "/api/auth/sign-out",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: one request after the other
        const response = await testApp.request(
          "/api/auth/request-password-reset",
          {
            body: JSON.stringify({
              email: "owner@example.invalid",
              redirectTo,
            }),
            headers: {
              "content-type": "application/json",
              origin: testBaseURL,
            },
            method: "POST",
          },
          testBindings
        );

        expect(response.status, redirectTo).toBe(403);
        expect(response.headers.get("location")).toBeNull();
      }
      expect(passwordResetEmails).toHaveLength(0);
    });

    it.each([
      "/api/auth/verify-email?token=any-token&callbackURL=https%3A%2F%2Fevil.example",
      "/api/auth/verify-email?token=any-token&callbackURL=%2F%2Fevil.example",
      "/api/auth/verify-email?token=any-token&callbackURL=%2Fapi%2Fauth%2Fsign-out",
      "/api/auth/reset-password/any-token?callbackURL=https%3A%2F%2Fevil.example",
      "/api/auth/reset-password/any-token?callbackURL=%2Frpc%2Fsales",
    ])("refuses a hostile callbackURL in the query of %s", async (path) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { app: testApp } = createEmailPasswordTestApp();

      const response = await testApp.request(
        path,
        { method: "GET" },
        testBindings
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    });
  });
});

describe("Sign-up legal acceptance (AC-68)", () => {
  const password = "frase longa e segura para o cadastro 2026";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function signUp(
    testApp: ReturnType<typeof createEmailPasswordTestApp>["app"],
    email: string,
    legalAcceptance?: unknown
  ) {
    return await testApp.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          ...(legalAcceptance === undefined ? {} : { legalAcceptance }),
          name: "Legal User",
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
  }

  async function findUserByEmail(
    auth: ReturnType<typeof createEmailPasswordTestApp>["auth"],
    email: string
  ) {
    const context = (await auth.$context) as unknown as {
      internalAdapter: {
        findUserByEmail: (email: string) => Promise<unknown>;
      };
    };
    return await context.internalAdapter.findUserByEmail(email);
  }

  it.each([
    ["without legalAcceptance", undefined],
    ["with an empty legalAcceptance", {}],
    ["with only the terms", { terms: SIGN_UP_LEGAL_ACCEPTANCE.terms }],
    [
      "with only the privacy policy",
      { privacy: SIGN_UP_LEGAL_ACCEPTANCE.privacy },
    ],
    ["with a boolean instead of the versions", { privacy: true, terms: true }],
    ["with the versions as strings", { privacy: "1", terms: "1" }],
    [
      "with an older version of the terms",
      { ...SIGN_UP_LEGAL_ACCEPTANCE, terms: 0 },
    ],
    [
      "with a newer version of the privacy policy",
      {
        ...SIGN_UP_LEGAL_ACCEPTANCE,
        privacy: SIGN_UP_LEGAL_ACCEPTANCE.privacy + 1,
      },
    ],
    ["with the acceptance as a string", "terms,privacy"],
    ["with the acceptance as null", null],
  ])(
    "refuses the sign-up %s with 400 legal_acceptance_required and creates no user",
    async (_name, legalAcceptance) => {
      const hibp = stubPwnedPasswordRange();
      const recorder = vi.fn(async () => undefined);
      const {
        app: testApp,
        auth,
        verificationEmails,
      } = createEmailPasswordTestApp(undefined, {
        legalAcceptanceRecorder: recorder,
      });
      const email = "no-acceptance@example.invalid";

      const response = await signUp(testApp, email, legalAcceptance);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "legal_acceptance_required",
      });
      expect(await findUserByEmail(auth, email)).toBeNull();
      expect(verificationEmails).toHaveLength(0);
      expect(recorder).not.toHaveBeenCalled();
      expect(hibp.calls()).toBe(0);

      const login = await testApp.request(
        "/api/auth/sign-in/email",
        {
          body: JSON.stringify({ email, password }),
          headers: { "content-type": "application/json", origin: testBaseURL },
          method: "POST",
        },
        testBindings
      );
      expect(login.status).not.toBe(200);
    }
  );

  it("creates the user and records the acceptance of terms and privacy with the new user id", async () => {
    stubPwnedPasswordRange();
    const recorder = vi.fn(
      async (_entry: { document: string; userId: string }) => undefined
    );
    const {
      app: testApp,
      auth,
      verificationEmails,
    } = createEmailPasswordTestApp(undefined, {
      legalAcceptanceRecorder: recorder,
    });
    const email = "accepted@example.invalid";

    const response = await signUp(testApp, email, SIGN_UP_LEGAL_ACCEPTANCE);

    expect(response.status).toBe(200);
    const user = (await findUserByEmail(auth, email)) as {
      user: { id: string };
    } | null;
    expect(user?.user.id).toBeTruthy();
    expect(verificationEmails).toHaveLength(1);
    expect(recorder.mock.calls.map(([entry]) => entry)).toEqual([
      { document: "terms", userId: user?.user.id },
      { document: "privacy", userId: user?.user.id },
    ]);
  });

  it("accepts the sign-up with the acceptance even when it carries extra keys", async () => {
    stubPwnedPasswordRange();
    const recorder = vi.fn(async () => undefined);
    const { app: testApp } = createEmailPasswordTestApp(undefined, {
      legalAcceptanceRecorder: recorder,
    });

    const response = await signUp(testApp, "extra-keys@example.invalid", {
      ...SIGN_UP_LEGAL_ACCEPTANCE,
      cookies: 1,
    });

    expect(response.status).toBe(200);
    expect(recorder).toHaveBeenCalledTimes(2);
  });

  it("does not take a failed record as a failed sign-up: the user is created and the response is 200", async () => {
    stubPwnedPasswordRange();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logged = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    const recorder = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("record failed for ana@example.invalid"), {
          code: "42501",
        })
      )
    );
    const {
      app: testApp,
      auth,
      verificationEmails,
    } = createEmailPasswordTestApp(undefined, {
      legalAcceptanceRecorder: recorder,
    });
    const email = "record-fails@example.invalid";

    const response = await signUp(testApp, email, SIGN_UP_LEGAL_ACCEPTANCE);

    expect(response.status).toBe(200);
    expect(recorder).toHaveBeenCalled();
    expect(await findUserByEmail(auth, email)).not.toBeNull();
    expect(verificationEmails).toHaveLength(1);
    // the named event the operational alert counts, with class and SQLSTATE and nothing personal
    expect(logged).toHaveBeenCalledWith(
      "legal_acceptance_signup_record_failed",
      expect.objectContaining({ errorClass: "Error", sqlState: "42501" })
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("example.invalid");
  });

  it("only guards the email sign-up: the other auth routes need no acceptance", async () => {
    stubPwnedPasswordRange();
    const { app: testApp } = createEmailPasswordTestApp();

    const response = await testApp.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({ email: "nobody@example.invalid", password }),
        headers: { "content-type": "application/json", origin: testBaseURL },
        method: "POST",
      },
      testBindings
    );

    const body = (await response.json()) as { code?: string };
    expect(body.code).not.toBe("legal_acceptance_required");
  });

  it("does not record an acceptance for a login by Google (it is asked for at the first access)", async () => {
    const recorder = vi.fn(async () => undefined);
    const { app: testApp } = createGoogleTestApp(undefined, recorder);
    stubGoogleTokenExchange();
    const start = await beginGoogleLogin(testApp);

    const callback = await testApp.request(
      "/api/auth/callback/google?code=fake-code&state=" +
        encodeURIComponent(start.state),
      { headers: { cookie: start.cookies } },
      testBindings
    );
    const session = await testApp.request(
      "/api/auth/get-session",
      { headers: { cookie: cookieHeader(callback.headers) } },
      testBindings
    );

    expect(callback.status).toBe(302);
    // the user was created by this login, and still nothing was recorded for it
    expect(
      ((await session.json()) as { user?: { id?: string } }).user?.id
    ).toBeTruthy();
    expect(recorder).not.toHaveBeenCalled();
  });
});

describe("Verification link record (ADR 0100, P10)", () => {
  const password = "frase longa e segura para o cadastro 2026";
  const email = "link-record@example.invalid";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const post = (
    testApp: ReturnType<typeof createEmailPasswordTestApp>["app"],
    path: string,
    body: Record<string, unknown>
  ) =>
    testApp.request(
      path,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", origin: testBaseURL },
        method: "POST",
      },
      testBindings
    );
  const signUp = (
    testApp: ReturnType<typeof createEmailPasswordTestApp>["app"]
  ) =>
    post(testApp, "/api/auth/sign-up/email", {
      email,
      legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
      name: "Link User",
      password,
    });

  it("records the end of the link of the user before each verification e-mail goes out, at the sign-up and at a resend", async () => {
    stubPwnedPasswordRange();
    const order: string[] = [];
    const recorded: string[] = [];
    const recorder = vi.fn((userId: string) => {
      recorded.push(userId);
      order.push("recorded");
      return Promise.resolve();
    });
    const { app: testApp } = createEmailPasswordTestApp(
      {
        sendPasswordReset: () => Promise.resolve(),
        sendVerificationEmail: () => {
          order.push("sent");
          return Promise.resolve();
        },
      },
      { verificationLinkRecorder: recorder }
    );

    expect((await signUp(testApp)).status).toBe(200);
    expect(order).toEqual(["recorded", "sent"]);

    expect(
      (await post(testApp, "/api/auth/send-verification-email", { email }))
        .status
    ).toBe(200);
    expect(order).toEqual(["recorded", "sent", "recorded", "sent"]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toBeTruthy();
    expect(recorded[1]).toBe(recorded[0]);
  });

  it("sends no e-mail when the end of its link could not be recorded: a link the purge does not know of must not exist", async () => {
    stubPwnedPasswordRange();
    const logged = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    const recorder = vi.fn(() => Promise.reject(new Error("database down")));
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp(
      undefined,
      { verificationLinkRecorder: recorder }
    );

    await signUp(testApp);

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(verificationEmails).toHaveLength(0);
    // the named event, with the class of the error and nothing personal
    expect(logged).toHaveBeenCalledWith(
      "auth_verification_link_record_failed",
      expect.objectContaining({ errorClass: "Error" })
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("example.invalid");
  });

  it("answers the resend without a session the same for an address that exists and one that does not, also when the record fails", async () => {
    stubPwnedPasswordRange();
    const state: { failing: boolean } = { failing: false };
    const recorder = vi.fn(() =>
      state.failing
        ? Promise.reject(new Error("lock timeout"))
        : Promise.resolve()
    );
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp(
      undefined,
      { verificationLinkRecorder: recorder }
    );
    expect((await signUp(testApp)).status).toBe(200);
    expect(verificationEmails).toHaveLength(1);
    state.failing = true;

    const known = await post(testApp, "/api/auth/send-verification-email", {
      email,
    });
    const unknown = await post(testApp, "/api/auth/send-verification-email", {
      email: "never-registered@example.invalid",
    });

    expect(recorder).toHaveBeenCalledTimes(2);
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await known.json()).toEqual(await unknown.json());
    expect(verificationEmails).toHaveLength(1);
  });

  it("records and sends the resend inside the cap of 72 hours, and neither records nor sends after it, with the same answer", async () => {
    stubPwnedPasswordRange();
    const logged = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    const ageHours: { value: number } = { value: 0 };
    const updates: string[] = [];
    // The database as the UPDATE sees it: the row matches only while `created_at` is within the cap.
    const query = vi.fn(
      (
        text: string,
        values: unknown[]
      ): Promise<{ rowCount: number | null }> => {
        if (text.startsWith("UPDATE")) {
          const capSeconds = Number(values[2]);
          if (ageHours.value * 60 * 60 < capSeconds) {
            updates.push(String(values[0]));
            return Promise.resolve({ rowCount: 1 });
          }
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rowCount: 1 });
      }
    );
    const record = databaseVerificationLinkRecorder({
      $client: { query },
    } as unknown as Parameters<typeof databaseVerificationLinkRecorder>[0]);
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp(
      undefined,
      record ? { verificationLinkRecorder: record } : {}
    );
    expect((await signUp(testApp)).status).toBe(200);
    expect(verificationEmails).toHaveLength(1);

    ageHours.value = 71;
    const inside = await post(testApp, "/api/auth/send-verification-email", {
      email,
    });
    expect(updates).toHaveLength(2);
    expect(verificationEmails).toHaveLength(2);

    ageHours.value = 73;
    const outside = await post(testApp, "/api/auth/send-verification-email", {
      email,
    });
    const unknown = await post(testApp, "/api/auth/send-verification-email", {
      email: "never-registered@example.invalid",
    });

    expect(updates).toHaveLength(2);
    expect(verificationEmails).toHaveLength(2);
    expect(outside.status).toBe(inside.status);
    expect(await outside.json()).toEqual(await inside.json());
    expect(unknown.status).toBe(outside.status);
    // past the cap is expected, not a failure of the record
    expect(logged).not.toHaveBeenCalledWith(
      "auth_verification_link_record_failed",
      expect.anything()
    );
  });

  it("records through the database with the clock of the database and refuses a user row that is not there", async () => {
    const query = vi.fn(
      async (
        _text: string,
        _values: unknown[]
      ): Promise<{ rowCount: number | null }> => ({ rowCount: 1 })
    );
    const record = databaseVerificationLinkRecorder({
      $client: { query },
    } as unknown as Parameters<typeof databaseVerificationLinkRecorder>[0]);
    expect(record).toBeDefined();

    await record?.("user-1");

    expect(query).toHaveBeenCalledTimes(1);
    const [text, values] = query.mock.calls[0] ?? [];
    expect(text).toContain("clock_timestamp()");
    expect(text).toContain("verification_link_expires_at");
    expect(text).toContain("created_at > pg_catalog.clock_timestamp()");
    expect(values).toEqual(["user-1", 24 * 60 * 60, 72 * 60 * 60]);

    // an impossible count of the UPDATE is a failure, even when the row is there
    const missing = (updated: number | null) => {
      query.mockReset();
      // the row is there for the SELECT: only an UPDATE count of 0 may be read as the cap
      query.mockImplementation((sql: string) =>
        Promise.resolve({
          rowCount: sql.startsWith("UPDATE") ? updated : 1,
        })
      );
      return expect(record?.("user-1")).rejects.toThrow("not found");
    };
    await missing(null);
    await missing(2);
    // the UPDATE matched nothing and the row is not there either: the user is gone, not past the cap
    query.mockReset();
    query.mockResolvedValue({ rowCount: 0 });
    await expect(record?.("user-1")).rejects.toThrow("not found");
    // the UPDATE matched nothing but the row is there: past the cap, not a failure of the record
    query.mockReset();
    query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    await expect(record?.("user-1")).rejects.toThrow("cap of the resend");
    expect(databaseVerificationLinkRecorder(undefined)).toBeUndefined();
  });

  it("sends the e-mail as before when there is no recorder (the test adapter has no database)", async () => {
    stubPwnedPasswordRange();
    const { app: testApp, verificationEmails } = createEmailPasswordTestApp();

    expect((await signUp(testApp)).status).toBe(200);

    expect(verificationEmails).toHaveLength(1);
  });
});
