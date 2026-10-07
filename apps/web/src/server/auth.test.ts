import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { app, createServerApp } from "./app";
import type { WorkerBindings } from "./environment";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const testBindings = {
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
  BETTER_AUTH_SECRET: testSecret,
  BETTER_AUTH_BASE_URL: testBaseURL,
  HYPERDRIVE: { connectionString: "" },
} as WorkerBindings;

interface TestAuthHelpers {
  createUser: () => { id: string };
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
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
