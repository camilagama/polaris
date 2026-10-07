import { betterAuth, type BetterAuthPlugin } from "better-auth";
import type { GoogleOptions } from "better-auth/social-providers";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSecurityAuditEvent } from "./auth";
import { createBetterAuth } from "./auth";
import { handleBetterAuthRequest } from "./auth/handler";
import { app, createServerApp } from "./app";
import type { WorkerBindings } from "./environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const SET_COOKIE_SPLIT_REGEX = /,(?=\s*[^;,=\s]+=)/;
const EXPIRED_COOKIE_REGEX = /;\s*max-age=0/i;
const SESSION_COOKIE_REGEX = /(?:__Secure-)?better-auth\.session_token=/;
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
