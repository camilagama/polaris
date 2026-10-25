import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { testUtils } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { type AuthSecurityAuditEvent, createBetterAuth } from "../auth";
import {
  currentAuthRequestState,
  currentRequestId,
  runInRequestBackground,
  runWithRequestScope,
} from "./request-database";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";

interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{ headers: Headers }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

/** Holds the requests of one path in the middle, after the hooks of the app, until the test lets them go. */
function pausePlugin() {
  const paused = new Map<
    string,
    { reached: () => void; release: Promise<void> }
  >();
  const plugin = {
    hooks: {
      before: [
        {
          handler: createAuthMiddleware(async (context) => {
            const pause = paused.get(context.path);
            if (pause) {
              paused.delete(context.path);
              pause.reached();
              await pause.release;
            }
          }),
          matcher: () => true,
        },
      ],
    },
    id: "pause-in-the-middle",
  } as unknown as BetterAuthPlugin;
  /** The next request of `path` stops after the hooks of the app; `reached` settles when it gets there. */
  const pauseNext = (path: string) => {
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    paused.set(path, { reached, release: releasePromise });
    return { reached: reachedPromise, release };
  };
  return { pauseNext, plugin };
}

/** One Better Auth for every request, as in the Worker: each request runs in its own scope. */
function createSharedAuth() {
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const { pauseNext, plugin } = pausePlugin();
  const auth = createBetterAuth({
    accessLogWriter: () => Promise.resolve(true),
    auditEventWriter: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
    baseURL: testBaseURL,
    databaseAdapter: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    googleProvider: {
      clientId: "test-google-client",
      clientSecret: "test-google-secret",
      redirectURI: `${testBaseURL}/api/auth/callback/google`,
    },
    plugins: [testUtils() as unknown as BetterAuthPlugin, plugin],
    requestId: currentRequestId,
    requestState: currentAuthRequestState,
    runInBackground: runInRequestBackground,
    secret: testSecret,
  });
  const inRequest = <T>(requestId: string, run: () => Promise<T>) =>
    // the memory adapter holds the rows: the scope's database is never read
    runWithRequestScope({ database: {} as never, requestId }, run);

  const signedIn = (requestId: string, email: string) =>
    inRequest(requestId, async () => {
      const helpers = (
        (await auth.$context) as unknown as { test: TestAuthHelpers }
      ).test;
      const user = await helpers.saveUser(
        helpers.createUser({ email, emailVerified: true })
      );
      const { headers } = await helpers.login({ userId: user.id });
      return { headers, userId: user.id };
    });

  const signOut = (requestId: string, login: { headers: Headers }) => {
    const headers = new Headers(login.headers);
    headers.set("origin", testBaseURL);
    return inRequest(requestId, () =>
      auth.handler(
        new Request(`${testBaseURL}/api/auth/sign-out`, {
          headers,
          method: "POST",
        })
      )
    );
  };

  const startGoogle = (requestId: string) =>
    inRequest(requestId, () =>
      auth.handler(
        new Request(`${testBaseURL}/api/auth/sign-in/social`, {
          body: JSON.stringify({ callbackURL: "/", provider: "google" }),
          headers: { "content-type": "application/json", origin: testBaseURL },
          method: "POST",
        })
      )
    );

  const eventOf = (requestId: string) =>
    auditEvents.find((event) => event.requestId === requestId);

  return { eventOf, pauseNext, signedIn, signOut, startGoogle };
}

describe("one Better Auth for every request of the isolate", () => {
  it("does not take the logout of A into the audit of the next request, B", async () => {
    const shared = createSharedAuth();
    const a = await shared.signedIn("setup-a", "a@example.invalid");

    expect((await shared.signOut("logout-a", a)).status).toBe(200);
    expect((await shared.startGoogle("google-b")).status).toBe(200);

    expect(shared.eventOf("logout-a")).toMatchObject({
      actorId: a.userId,
      eventType: "logout_succeeded",
    });
    expect(shared.eventOf("google-b")).toMatchObject({
      actorId: null,
      eventType: "google_login_started",
    });
  });

  it("keeps B, held in the middle while A logs out, without A as its actor", async () => {
    const shared = createSharedAuth();
    const a = await shared.signedIn("setup-a", "a@example.invalid");
    const pause = shared.pauseNext("/sign-in/social");

    const googleB = shared.startGoogle("google-b");
    await pause.reached;
    expect((await shared.signOut("logout-a", a)).status).toBe(200);
    pause.release();
    expect((await googleB).status).toBe(200);

    expect(shared.eventOf("logout-a")?.actorId).toBe(a.userId);
    expect(shared.eventOf("google-b")).toMatchObject({
      actorId: null,
      eventType: "google_login_started",
    });
  });

  it("keeps the actor of A, held in the middle of its logout, while B logs out", async () => {
    const shared = createSharedAuth();
    const a = await shared.signedIn("setup-a", "a@example.invalid");
    const b = await shared.signedIn("setup-b", "b@example.invalid");
    const pause = shared.pauseNext("/sign-out");

    // A's actor is taken before the pause: an actor kept by the instance would be B's by the time A goes on
    const logoutA = shared.signOut("logout-a", a);
    await pause.reached;
    expect((await shared.signOut("logout-b", b)).status).toBe(200);
    pause.release();
    expect((await logoutA).status).toBe(200);

    expect(shared.eventOf("logout-b")).toMatchObject({
      actorId: b.userId,
      eventType: "logout_succeeded",
    });
    expect(shared.eventOf("logout-a")).toMatchObject({
      actorId: a.userId,
      eventType: "logout_succeeded",
    });
  });
});
