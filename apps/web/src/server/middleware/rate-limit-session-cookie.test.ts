import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBetterAuth } from "../auth";
import { sessionCookieName } from "../auth/security-options";
import type { RateLimitBinding, ServerEnv } from "../environment";
import { rpcRateLimitMiddleware } from "./rate-limit";
import { requestIdMiddleware } from "./request-id";

/**
 * The session bucket of the `/rpc` limiter against the Better Auth that is installed, not against a copy of its
 * rules (Better Auth 1.7.8 aligned the cookie attributes with RFC 6265bis): the cookie it reads is the one
 * Better Auth sets, and every spelling of a cookie header that Better Auth reads as a session lands in that
 * session's bucket, so a session never gets a second bucket by spelling its cookie another way.
 */

const testSecret = "test-only-better-auth-secret-32-bytes";

interface TestHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

function createHarness(baseURL: string) {
  const auth = createBetterAuth({
    auditEventWriter: () => Promise.resolve(),
    baseURL,
    databaseAdapter: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "t435-rate-limit-cookie",
    secret: testSecret,
  });
  const limiterApp = new Hono<ServerEnv>();
  limiterApp.use("*", requestIdMiddleware);
  limiterApp.use("/rpc/*", rpcRateLimitMiddleware);
  limiterApp.all("*", (context) => context.json({ reached: true }));

  /** The `name=value` pair Better Auth sets for a new session of a new user. */
  async function newSessionCookie(email: string) {
    const helpers = ((await auth.$context) as unknown as { test: TestHelpers })
      .test;
    const user = await helpers.saveUser(
      helpers.createUser({ email, emailVerified: true })
    );
    const { headers, token } = await helpers.login({ userId: user.id });
    const setCookie = headers.get("cookie") ?? "";
    const separator = setCookie.indexOf("=");
    return {
      name: setCookie.slice(0, separator),
      token,
      value: setCookie.slice(separator + 1),
    };
  }

  /** The token of the session Better Auth reads from this cookie header, or null. */
  async function sessionRead(cookie: string): Promise<string | null> {
    const response = await auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie, origin: new URL(baseURL).origin },
      })
    );
    const body = (await response.json()) as {
      session?: { token?: string };
    } | null;
    return body?.session?.token ?? null;
  }

  /** The session bucket the limiter counts this cookie header in, or undefined. */
  async function sessionBucket(cookie: string): Promise<string | undefined> {
    const binding = {
      limit: vi.fn((_options: { key: string }) =>
        Promise.resolve({ success: true })
      ),
    } satisfies RateLimitBinding;
    await limiterApp.request(
      "/rpc/sale/confirm",
      { headers: { cookie }, method: "POST" },
      {
        BETTER_AUTH_BASE_URL: baseURL,
        BETTER_AUTH_SECRET: testSecret,
        HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
        RPC_MUTATION_RATE_LIMIT: binding,
      }
    );
    return binding.limit.mock.calls
      .map(([options]) => options.key)
      .find((key) => key.startsWith("rpc-mutation-session:"));
  }

  return { newSessionCookie, sessionBucket, sessionRead };
}

describe.each([
  ["HTTPS", "https://polaris.example.invalid"],
  ["loopback HTTP", "http://localhost"],
])(
  "the /rpc limiter and the session cookie of Better Auth (%s)",
  (_label, baseURL) => {
    it("reads the cookie by the name Better Auth sets", async () => {
      const harness = createHarness(baseURL);
      const cookie = await harness.newSessionCookie("name@example.invalid");

      expect(cookie.name).toBe(sessionCookieName(baseURL));
      expect(await harness.sessionRead(`${cookie.name}=${cookie.value}`)).toBe(
        cookie.token
      );
      expect(
        await harness.sessionBucket(`${cookie.name}=${cookie.value}`)
      ).toBeDefined();
    });

    it("puts every cookie header Better Auth reads as a session in that session's bucket", async () => {
      const harness = createHarness(baseURL);
      const first = await harness.newSessionCookie("first@example.invalid");
      const second = await harness.newSessionCookie("second@example.invalid");
      const otherName =
        first.name === "better-auth.session_token"
          ? "__Secure-better-auth.session_token"
          : "better-auth.session_token";
      const pair = (cookie: typeof first, value = cookie.value) =>
        `${cookie.name}=${value}`;
      const headers = [
        pair(first),
        pair(first, `"${first.value}"`),
        pair(first, decodeURIComponent(first.value)),
        pair(first, ` ${first.value} `),
        `theme=dark; ${pair(first)}; locale=pt-BR`,
        `${otherName}=${second.value}; ${pair(first)}`,
        `${pair(first)}; ${otherName}=${second.value}`,
        `${pair(first)}; ${pair(second)}`,
        `${pair(second)}; ${pair(first)}`,
        pair(first, `${first.token}.forged-signature`),
      ];
      const buckets = new Map([
        [first.token, await harness.sessionBucket(pair(first))],
        [second.token, await harness.sessionBucket(pair(second))],
      ]);
      let read = 0;

      expect(buckets.get(first.token)).not.toEqual(buckets.get(second.token));
      for (const header of headers) {
        // biome-ignore lint/performance/noAwaitInLoops: one header after the other, each its own request
        const token = await harness.sessionRead(header);
        if (token === null) {
          continue;
        }
        read += 1;
        expect(await harness.sessionBucket(header), header).toBe(
          buckets.get(token)
        );
      }
      // the plain, the quoted, the decoded and the ones among other cookies at least
      expect(read).toBeGreaterThanOrEqual(5);
    });
  }
);
