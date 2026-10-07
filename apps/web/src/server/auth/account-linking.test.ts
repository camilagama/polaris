import { afterEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { GoogleOptions } from "better-auth/social-providers";
import { testUtils } from "better-auth/plugins";
import { createServerApp } from "../app";
import type { AuthEmailDelivery, AuthSecurityAuditEvent } from "../auth";
import { createBetterAuth } from "../auth";
import {
  handleBetterAuthRequest,
  handleSetPasswordRequest,
} from "../auth/handler";
import type { WorkerBindings } from "../environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const setCookieSplitPattern = /,(?=\s*[^;,=\s]+=)/;
const expiredCookiePattern = /;\s*max-age=0/i;

const testBindings = {
  BETTER_AUTH_BASE_URL: testBaseURL,
  BETTER_AUTH_SECRET: testSecret,
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
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

interface VerificationEmail {
  email: string;
  token: string;
  url: string;
}

interface AccountLinkingTestAppOptions {
  googleEmail?: string;
  googleEmailVerified?: boolean;
}

function createGoogleProvider({
  googleEmail: email = "google@example.invalid",
  googleEmailVerified: emailVerified = true,
}: AccountLinkingTestAppOptions = {}) {
  const googleProfile = { email, emailVerified };
  const googleUserEmails: string[] = [];
  const verifyIdToken = vi.fn(async () => true);
  const provider: GoogleOptions = {
    accessType: "online",
    clientId: "google-test-client",
    clientSecret: "google-test-secret",
    disableIdTokenSignIn: true,
    getUserInfo: () => {
      googleUserEmails.push(googleProfile.email);
      return Promise.resolve({
        data: { sub: "google-subject-1" },
        user: {
          email: googleProfile.email,
          emailVerified: googleProfile.emailVerified,
          id: "google-subject-1",
          name: "Google Test User",
        },
      });
    },
    redirectURI: `${testBaseURL}/api/auth/callback/google`,
    verifyIdToken,
  };

  return {
    googleUserEmails,
    provider,
    setGoogleEmail: (nextEmail: string) => {
      googleProfile.email = nextEmail;
    },
    verifyIdToken,
  };
}

function createAccountLinkingTestApp(
  options: AccountLinkingTestAppOptions = {}
) {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const verificationEmails: VerificationEmail[] = [];
  const passwordResetEmails: VerificationEmail[] = [];
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
  const { googleUserEmails, provider, setGoogleEmail, verifyIdToken } =
    createGoogleProvider(options);
  const auth = createBetterAuth({
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter,
    emailDelivery,
    googleProvider: provider,
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "pr17-account-linking-test-request",
    secret: testSecret,
  });
  const app = createServerApp({
    authAbuseProtector: async () => undefined,
    authHandler: (request) =>
      new URL(request.url).pathname.endsWith("/set-password")
        ? handleSetPasswordRequest(auth, request)
        : auth.handler(request),
  });

  return {
    app,
    auditEvents,
    auth,
    passwordResetEmails,
    verificationEmails,
    googleUserEmails,
    setGoogleEmail,
    verifyIdToken,
  };
}

function cookieHeader(headers: Headers): string {
  const existingCookie = headers.get("cookie");
  if (existingCookie) {
    return existingCookie;
  }

  const headersWithGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values =
    typeof headersWithGetSetCookie.getSetCookie === "function"
      ? headersWithGetSetCookie.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(setCookieSplitPattern);

  return values
    .filter((value) => value.length > 0 && !expiredCookiePattern.test(value))
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter((value) => value.length > 0 && !value.endsWith("="))
    .join("; ");
}

function stubExternalAuthServices() {
  let hibpCalls = 0;
  let googleTokenCalls = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    let target: string;
    if (typeof input === "string") {
      target = input;
    } else if (input instanceof Request) {
      target = input.url;
    } else {
      target = input.href;
    }

    if (target.startsWith("https://api.pwnedpasswords.com/range/")) {
      hibpCalls += 1;
      return Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`));
    }

    if (target === "https://oauth2.googleapis.com/token") {
      googleTokenCalls += 1;
      return Promise.resolve(
        Response.json({
          access_token: "test-access-token",
          expires_in: 3600,
          id_token: "test-id-token",
          scope: "openid email profile",
          token_type: "Bearer",
        })
      );
    }

    return Promise.reject(
      new Error("Unexpected outbound request during account-linking test.")
    );
  });

  return {
    googleTokenCalls: () => googleTokenCalls,
    hibpCalls: () => hibpCalls,
  };
}

async function createVerifiedPasswordSession(
  app: ReturnType<typeof createAccountLinkingTestApp>["app"],
  verificationEmails: VerificationEmail[],
  email: string
) {
  const password = "A unique verified password for PR17!";
  const signUp = await app.request(
    "/api/auth/sign-up/email",
    {
      body: JSON.stringify({ email, name: "Account Link User", password }),
      headers: {
        "content-type": "application/json",
        origin: testBaseURL,
      },
      method: "POST",
    },
    testBindings
  );
  const signUpBody = (await signUp.json()) as { user?: { id?: string } };
  expect(signUp.status).toBe(200);

  const verification = verificationEmails.find(
    (entry) => entry.email === email
  );
  expect(verification).toBeDefined();
  const verificationURL = new URL(verification?.url as string);
  const verify = await app.request(
    `${verificationURL.pathname}?token=${encodeURIComponent(verification?.token ?? "")}`,
    { headers: { origin: testBaseURL } },
    testBindings
  );
  expect(verify.status).toBe(200);

  const login = await app.request(
    "/api/auth/sign-in/email",
    {
      body: JSON.stringify({ email, password }),
      headers: {
        "content-type": "application/json",
        origin: testBaseURL,
      },
      method: "POST",
    },
    testBindings
  );
  expect(login.status).toBe(200);

  return {
    email,
    password,
    sessionCookie: cookieHeader(login.headers),
    userId: signUpBody.user?.id,
  };
}

async function beginGoogleLink(
  app: ReturnType<typeof createAccountLinkingTestApp>["app"],
  sessionCookie: string
) {
  const response = await app.request(
    "/api/auth/link-social",
    {
      body: JSON.stringify({
        callbackURL: "/settings/account",
        errorCallbackURL: "/settings/account?link=failed",
        provider: "google",
      }),
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        origin: testBaseURL,
      },
      method: "POST",
    },
    testBindings
  );
  const body = (await response.json()) as { url?: string };
  expect(response.status).toBe(200);
  expect(body.url).toBeTruthy();

  const authorizationURL = new URL(body.url as string);
  const state = authorizationURL.searchParams.get("state");
  expect(authorizationURL.origin).toBe("https://accounts.google.com");
  expect(state).toBeTruthy();

  return {
    cookies: [sessionCookie, cookieHeader(response.headers)]
      .filter(Boolean)
      .join("; "),
    state: state as string,
  };
}

function completeGoogleLink(
  app: ReturnType<typeof createAccountLinkingTestApp>["app"],
  state: string,
  cookies: string
) {
  return app.request(
    `/api/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: cookies,
        origin: testBaseURL,
      },
    },
    testBindings
  );
}

async function findGoogleAccount(
  auth: ReturnType<typeof createAccountLinkingTestApp>["auth"]
) {
  const authContext = (await auth.$context) as unknown as {
    internalAdapter: {
      findAccountByProviderId: (
        accountId: string,
        providerId: string
      ) => Promise<{
        accessToken?: string | null;
        id: string;
        idToken?: string | null;
        userId: string;
      } | null>;
    };
  };
  return authContext.internalAdapter.findAccountByProviderId(
    "google-subject-1",
    "google"
  );
}

describe("Google and password account linking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("links Google to the authenticated password account with the same verified email", async () => {
    const { app, auth, auditEvents, googleUserEmails, verificationEmails } =
      createAccountLinkingTestApp({ googleEmail: "owner@example.invalid" });
    stubExternalAuthServices();
    const passwordSession = await createVerifiedPasswordSession(
      app,
      verificationEmails,
      "owner@example.invalid"
    );
    const linkStart = await beginGoogleLink(app, passwordSession.sessionCookie);
    const currentSession = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: passwordSession.sessionCookie } },
      testBindings
    );
    const currentSessionBody = (await currentSession.json()) as {
      user?: { email?: string };
    };
    expect(currentSessionBody.user?.email).toBe(passwordSession.email);
    const callback = await completeGoogleLink(
      app,
      linkStart.state,
      linkStart.cookies
    );
    const linkedAccount = await findGoogleAccount(auth);
    const sessionAfterLink = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: passwordSession.sessionCookie } },
      testBindings
    );
    const sessionAfterLinkBody = (await sessionAfterLink.json()) as {
      user?: { id?: string; name?: string };
    };

    expect(callback.status).toBe(302);
    expect(googleUserEmails).toEqual(["owner@example.invalid"]);
    expect(callback.headers.get("location")).toBe("/settings/account");
    expect(linkedAccount?.userId).toBe(passwordSession.userId);
    expect(linkedAccount?.idToken).toBeNull();
    expect(linkedAccount?.accessToken).not.toBe("test-access-token");
    expect(sessionAfterLinkBody.user?.id).toBe(passwordSession.userId);
    expect(sessionAfterLinkBody.user?.name).toBe("Account Link User");
    expect(
      auditEvents.map(({ eventType, outcome, errorCode }) => ({
        errorCode,
        eventType,
        outcome,
      }))
    ).toEqual([
      {
        errorCode: null,
        eventType: "google_callback_succeeded",
        outcome: "succeeded",
      },
    ]);
    expect(
      auditEvents.find(
        (event) => event.eventType === "google_callback_succeeded"
      )?.actorId
    ).toBe(passwordSession.userId);
  });

  it("rejects a different Google email without linking it to the password user", async () => {
    const { app, auth, auditEvents, verificationEmails } =
      createAccountLinkingTestApp({
        googleEmail: "different@example.invalid",
      });
    stubExternalAuthServices();
    const passwordSession = await createVerifiedPasswordSession(
      app,
      verificationEmails,
      "owner@example.invalid"
    );
    const linkStart = await beginGoogleLink(app, passwordSession.sessionCookie);
    const callback = await completeGoogleLink(
      app,
      linkStart.state,
      linkStart.cookies
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("link=failed");
    expect(await findGoogleAccount(auth)).toBeNull();
    expect(
      auditEvents.find((event) => event.eventType === "google_callback_failed")
        ?.actorId
    ).toBe(passwordSession.userId);
  });

  it("rejects a Google identity whose email is unverified", async () => {
    const { app, auth, verificationEmails } = createAccountLinkingTestApp({
      googleEmail: "owner@example.invalid",
      googleEmailVerified: false,
    });
    stubExternalAuthServices();
    const passwordSession = await createVerifiedPasswordSession(
      app,
      verificationEmails,
      "owner@example.invalid"
    );
    const linkStart = await beginGoogleLink(app, passwordSession.sessionCookie);
    const callback = await completeGoogleLink(
      app,
      linkStart.state,
      linkStart.cookies
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("link=failed");
    expect(await findGoogleAccount(auth)).toBeNull();
  });

  it("does not move a Google identity already linked to another user", async () => {
    const { app, auth, verificationEmails, setGoogleEmail } =
      createAccountLinkingTestApp({
        googleEmail: "original-owner@example.invalid",
      });
    stubExternalAuthServices();
    const originalGoogleLogin = await beginGoogleLogin(app);
    const originalGoogleCallback = await completeGoogleLink(
      app,
      originalGoogleLogin.state,
      originalGoogleLogin.cookies
    );
    const originalGoogleSession = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: cookieHeader(originalGoogleCallback.headers) } },
      testBindings
    );
    const originalGoogleSessionBody = (await originalGoogleSession.json()) as {
      user?: { id?: string };
    };
    const passwordSession = await createVerifiedPasswordSession(
      app,
      verificationEmails,
      "new-owner@example.invalid"
    );

    setGoogleEmail("new-owner@example.invalid");
    const linkStart = await beginGoogleLink(app, passwordSession.sessionCookie);
    const linkCallback = await completeGoogleLink(
      app,
      linkStart.state,
      linkStart.cookies
    );
    const linkedAccount = await findGoogleAccount(auth);
    const linkError = new URL(
      linkCallback.headers.get("location") ?? testBaseURL,
      testBaseURL
    ).searchParams.get("error");

    expect(originalGoogleCallback.status).toBe(302);
    expect(originalGoogleSessionBody.user?.id).toBeTruthy();
    expect(linkError).toBe("account_already_linked_to_different_user");
    expect(linkedAccount?.userId).toBe(originalGoogleSessionBody.user?.id);
    expect(linkedAccount?.userId).not.toBe(passwordSession.userId);
  });

  it("does not start linking from an unverified local session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, auth } = createAccountLinkingTestApp();
    const authContext = (await auth.$context) as unknown as {
      test: TestAuthHelpers;
    };
    const user = await authContext.test.saveUser(
      authContext.test.createUser({
        email: "unverified@example.invalid",
        emailVerified: false,
      })
    );
    const login = await authContext.test.login({ userId: user.id });
    const response = await app.request(
      "/api/auth/link-social",
      {
        body: JSON.stringify({ provider: "google" }),
        headers: {
          cookie: cookieHeader(login.headers),
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "email_not_verified",
    });
  });

  it("requires the OAuth redirect flow instead of a client-supplied Google ID token", async () => {
    const { app, auth, verificationEmails, verifyIdToken } =
      createAccountLinkingTestApp({ googleEmail: "owner@example.invalid" });
    stubExternalAuthServices();
    const passwordSession = await createVerifiedPasswordSession(
      app,
      verificationEmails,
      "owner@example.invalid"
    );
    const response = await app.request(
      "/api/auth/link-social",
      {
        body: JSON.stringify({
          idToken: { token: "untrusted-client-token" },
          provider: "google",
        }),
        headers: {
          cookie: passwordSession.sessionCookie,
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "oauth_redirect_required",
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(await findGoogleAccount(auth)).toBeNull();
  });

  it("requires an authenticated session before starting Google account linking", async () => {
    const { app } = createAccountLinkingTestApp();
    const response = await app.request(
      "/api/auth/link-social",
      {
        body: JSON.stringify({ provider: "google" }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "session_required",
    });
  });

  it("lets a verified Google session add a password for that same account", async () => {
    const { app } = createAccountLinkingTestApp({
      googleEmail: "google-password@example.invalid",
    });
    const externalRequests = stubExternalAuthServices();
    const loginStart = await beginGoogleLogin(app);
    const callback = await completeGoogleLink(
      app,
      loginStart.state,
      loginStart.cookies
    );
    const googleSessionCookie = cookieHeader(callback.headers);
    const sessionResponse = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: googleSessionCookie } },
      testBindings
    );
    const sessionBody = (await sessionResponse.json()) as {
      user?: { email?: string; id?: string };
    };
    const newPassword = "A newly added verified Google password 2026!";
    const setPassword = await app.request(
      "/api/auth/set-password",
      {
        body: JSON.stringify({ newPassword }),
        headers: {
          cookie: googleSessionCookie,
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const passwordLogin = await app.request(
      "/api/auth/sign-in/email",
      {
        body: JSON.stringify({
          email: sessionBody.user?.email,
          password: newPassword,
        }),
        headers: {
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    const passwordSessionResponse = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: cookieHeader(passwordLogin.headers) } },
      testBindings
    );
    const passwordSessionBody = (await passwordSessionResponse.json()) as {
      user?: { id?: string };
    };

    expect(callback.status).toBe(302);
    expect(sessionResponse.status).toBe(200);
    expect(setPassword.status).toBe(200);
    expect(passwordLogin.status).toBe(200);
    expect(passwordSessionBody.user?.id).toBe(sessionBody.user?.id);
    expect(externalRequests.hibpCalls()).toBe(1);
  });

  it("rejects setting a password on an unverified account before HIBP", async () => {
    const { app, auth } = createAccountLinkingTestApp();
    const externalRequests = stubExternalAuthServices();
    const authContext = (await auth.$context) as unknown as {
      test: TestAuthHelpers;
    };
    const user = await authContext.test.saveUser(
      authContext.test.createUser({
        email: "unverified-password@example.invalid",
        emailVerified: false,
      })
    );
    const login = await authContext.test.login({ userId: user.id });
    const response = await app.request(
      "/api/auth/set-password",
      {
        body: JSON.stringify({
          newPassword: "A long unverified account password 2026!",
        }),
        headers: {
          cookie: cookieHeader(login.headers),
          "content-type": "application/json",
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "email_not_verified" },
    });
    expect(externalRequests.hibpCalls()).toBe(0);
  });

  it("keeps set-password disabled with the email/password feature off", async () => {
    const bindings = {
      ...testBindings,
      EMAIL_PASSWORD_AUTH_ENABLED: "false",
      GOOGLE_CLIENT_ID: "google-test-client",
      GOOGLE_CLIENT_SECRET: "google-test-secret",
    } as WorkerBindings;
    const responses = await Promise.all([
      handleBetterAuthRequest(
        new Request(`${testBaseURL}/api/auth/set-password`, {
          body: JSON.stringify({
            newPassword: "A password that should be blocked",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        bindings,
        "pr17-disabled-set-password-test"
      ),
      handleBetterAuthRequest(
        new Request(`${testBaseURL}/api/auth/link-social`, {
          body: JSON.stringify({ provider: "google" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        bindings,
        "pr17-disabled-link-social-test"
      ),
    ]);

    const responseBodies = await Promise.all(
      responses.map((response) => response.json())
    );
    responses.forEach((response, index) => {
      expect(response.status).toBe(503);
      expect(responseBodies[index]).toEqual({
        error: { code: "auth_email_unavailable" },
      });
    });
  });
});

async function beginGoogleLogin(
  app: ReturnType<typeof createAccountLinkingTestApp>["app"]
) {
  const response = await app.request(
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
  const body = (await response.json()) as { url?: string };
  expect(response.status).toBe(200);
  expect(body.url).toBeTruthy();
  const authorizationURL = new URL(body.url as string);
  const state = authorizationURL.searchParams.get("state");
  expect(state).toBeTruthy();

  return {
    cookies: cookieHeader(response.headers),
    state: state as string,
  };
}
