import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSecurityAuditEvent } from "../auth";
import { createBetterAuth } from "../auth";
import { createServerApp } from "../app";
import { enforceAbsoluteSessionLifetime } from "./handler";
import type { WorkerBindings } from "../environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const dayMilliseconds = 24 * 60 * 60 * 1000;
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

interface TestLogin {
  headers: Headers;
  token: string;
}

function requestHeaders(login: TestLogin, contentType?: string): Headers {
  const headers = new Headers(login.headers);
  if (!headers.has("origin")) {
    headers.set("origin", testBaseURL);
  }
  if (contentType) {
    headers.set("content-type", contentType);
  }
  return headers;
}

function createSessionTestApp() {
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
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "pr18-session-test-request",
    secret: testSecret,
  });
  const app = createServerApp({
    authAbuseProtector: async () => undefined,
    authHandler: async (request) => {
      await enforceAbsoluteSessionLifetime(auth, request);
      return auth.handler(request);
    },
  });

  return { app, auditEvents, auth };
}

async function createTestUser(
  auth: ReturnType<typeof createSessionTestApp>["auth"],
  email: string
) {
  const helpers = (
    (await auth.$context) as unknown as { test: TestAuthHelpers }
  ).test;
  const user = await helpers.saveUser(
    helpers.createUser({ email, emailVerified: true })
  );
  return { helpers, user };
}

async function createTestLogin(
  helpers: TestAuthHelpers,
  userId: string
): Promise<TestLogin> {
  const login = await helpers.login({ userId });
  return { headers: login.headers, token: login.token };
}

describe("Better Auth session policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires an idle session after seven days", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);

    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "idle-session@example.invalid"
    );
    const login = await createTestLogin(helpers, user.id);

    vi.setSystemTime(new Date(start.getTime() + 8 * dayMilliseconds));
    const response = await app.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: requestHeaders(login) },
      testBindings
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("enforces a 30-day absolute limit despite active session refreshes", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);

    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "absolute-session@example.invalid"
    );
    const login = await createTestLogin(helpers, user.id);

    const expectSessionActiveAt = async (daysSinceStart: number) => {
      vi.setSystemTime(
        new Date(start.getTime() + daysSinceStart * dayMilliseconds)
      );
      const activeSession = await app.request(
        "/api/auth/get-session?disableCookieCache=true",
        { headers: requestHeaders(login) },
        testBindings
      );
      const body = (await activeSession.json()) as {
        session?: { createdAt?: string; expiresAt?: string };
      };

      expect(activeSession.status).toBe(200);
      expect(body.session?.createdAt).toBe(start.toISOString());
      expect(body.session?.expiresAt).toBe(
        new Date(
          start.getTime() + (daysSinceStart + 7) * dayMilliseconds
        ).toISOString()
      );
    };

    await expectSessionActiveAt(6);
    await expectSessionActiveAt(12);
    await expectSessionActiveAt(18);
    await expectSessionActiveAt(24);
    await expectSessionActiveAt(29);

    vi.setSystemTime(new Date(start.getTime() + 31 * dayMilliseconds));
    const expiredSession = await app.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: requestHeaders(login) },
      testBindings
    );

    expect(expiredSession.status).toBe(200);
    expect(await expiredSession.json()).toBeNull();
  });

  it("requires a recent sign-in to enumerate sessions", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);

    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "fresh-session-list@example.invalid"
    );
    const login = await createTestLogin(helpers, user.id);

    vi.setSystemTime(new Date(start.getTime() + 2 * dayMilliseconds));
    const response = await app.request(
      "/api/auth/list-sessions",
      { headers: requestHeaders(login) },
      testBindings
    );

    expect(response.status).toBe(403);
  });
  it("lists multiple sessions and lets the owner revoke one session", async () => {
    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "multiple-sessions@example.invalid"
    );
    const firstLogin = await createTestLogin(helpers, user.id);
    const secondLogin = await createTestLogin(helpers, user.id);
    const listed = await app.request(
      "/api/auth/list-sessions",
      { headers: requestHeaders(secondLogin) },
      testBindings
    );
    const listedSessions = (await listed.json()) as Array<{
      token?: string;
    }>;

    expect(listed.status).toBe(200);
    expect(listedSessions.map((session) => session.token)).toEqual(
      expect.arrayContaining([firstLogin.token, secondLogin.token])
    );

    const revoked = await app.request(
      "/api/auth/revoke-session",
      {
        body: JSON.stringify({ token: firstLogin.token }),
        headers: requestHeaders(secondLogin, "application/json"),
        method: "POST",
      },
      testBindings
    );
    const currentSessions = await app.request(
      "/api/auth/list-sessions",
      { headers: requestHeaders(secondLogin) },
      testBindings
    );
    const currentSessionsBody = (await currentSessions.json()) as Array<{
      token?: string;
    }>;
    const revokedSession = await app.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: requestHeaders(firstLogin) },
      testBindings
    );

    expect(revoked.status).toBe(200);
    expect(currentSessionsBody.map((session) => session.token)).toEqual([
      secondLogin.token,
    ]);
    expect(await revokedSession.json()).toBeNull();
  });

  it("does not list or revoke another user's sessions", async () => {
    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "session-owner@example.invalid"
    );
    const ownerLogin = await createTestLogin(helpers, user.id);
    const otherAccount = await createTestUser(
      auth,
      "other-session-owner@example.invalid"
    );
    const otherLogin = await createTestLogin(
      otherAccount.helpers,
      otherAccount.user.id
    );
    const otherList = await app.request(
      "/api/auth/list-sessions",
      { headers: requestHeaders(otherLogin) },
      testBindings
    );
    const otherSessions = (await otherList.json()) as Array<{
      token?: string;
    }>;
    const revokeOther = await app.request(
      "/api/auth/revoke-session",
      {
        body: JSON.stringify({ token: ownerLogin.token }),
        headers: requestHeaders(otherLogin, "application/json"),
        method: "POST",
      },
      testBindings
    );
    const ownerStillActive = await app.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: requestHeaders(ownerLogin) },
      testBindings
    );

    expect(otherList.status).toBe(200);
    expect(otherSessions.map((session) => session.token)).toEqual([
      otherLogin.token,
    ]);
    expect(revokeOther.status).toBe(200);
    expect(await ownerStillActive.json()).toMatchObject({
      user: { id: user.id },
    });
  });

  it("does not authenticate with a raw session token", async () => {
    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "raw-session-token@example.invalid"
    );
    const login = await createTestLogin(helpers, user.id);
    const bearerResponse = await app.request(
      "/api/auth/get-session",
      {
        headers: { authorization: `Bearer ${login.token}` },
      },
      testBindings
    );
    const rawCookieResponse = await app.request(
      "/api/auth/get-session",
      {
        headers: {
          cookie: `better-auth.session_token=${login.token}`,
        },
      },
      testBindings
    );

    expect(await bearerResponse.json()).toBeNull();
    expect(await rawCookieResponse.json()).toBeNull();
  });
  it("revokes the current session on logout", async () => {
    const { app, auth } = createSessionTestApp();
    const { helpers, user } = await createTestUser(
      auth,
      "logout-session@example.invalid"
    );
    const login = await createTestLogin(helpers, user.id);

    const logout = await app.request(
      "/api/auth/sign-out",
      {
        headers: requestHeaders(login),
        method: "POST",
      },
      testBindings
    );
    const afterLogout = await app.request(
      "/api/auth/get-session?disableCookieCache=true",
      { headers: requestHeaders(login) },
      testBindings
    );

    expect(logout.status).toBe(200);
    expect(await afterLogout.json()).toBeNull();
  });
});
