import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import {
  protectAuthLinkRequest,
  protectAuthRequest,
  protectSocialAuthRequest,
} from "./abuse-protection";

const requestId = "pr16-auth-abuse-test";
const turnstileSecret = "test-only-turnstile-secret";
const baseURL = "https://app.example.com";
const linkKeyPattern = /^auth-link-ip:[0-9a-f]{64}$/;
const socialKeyPattern = /^auth-social-ip:[0-9a-f]{64}$/;

function createLimiter(success = true) {
  return {
    limit: vi.fn(async (_options: { key: string }) => ({ success })),
  };
}

function createBindings(overrides: Partial<WorkerBindings> = {}) {
  return {
    AUTH_ABUSE_PROTECTION_ENABLED: "true",
    AUTH_EMAIL_RATE_LIMITER: createLimiter(),
    AUTH_RATE_LIMITER: createLimiter(),
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
    TURNSTILE_SECRET_KEY: turnstileSecret,
    ...overrides,
  } as WorkerBindings;
}

function createRequest(path: string, token?: string, method = "POST"): Request {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.17" });
  if (token) {
    headers.set("x-turnstile-token", token);
  }

  return new Request(`${baseURL}${path}`, { headers, method });
}

function createSuccessfulSiteverify(action: string) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ action, hostname: "app.example.com", success: true })
  );
}

describe("auth abuse protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["/api/auth/sign-up/email", "signup"],
    ["/api/auth/sign-in/email", "login"],
    ["/api/auth/sign-in/email/", "login"],
    ["/api/auth/request-password-reset", "password_reset_request"],
    ["/api/auth/reset-password", "password_reset"],
    ["/api/auth/send-verification-email", "verification_email"],
  ])(
    "validates Turnstile for %s with the expected action",
    async (path, action) => {
      const fetcher = createSuccessfulSiteverify(action);
      const result = await protectAuthRequest(
        createRequest(path, "single-use-token"),
        createBindings(),
        requestId,
        fetcher
      );

      expect(result).toBeUndefined();
      expect(fetcher).toHaveBeenCalledOnce();
      const [siteverifyURL, init] = fetcher.mock.calls[0] ?? [];
      expect(siteverifyURL).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      );
      const body = init?.body as URLSearchParams;
      expect(body.get("secret")).toBe(turnstileSecret);
      expect(body.get("response")).toBe("single-use-token");
      expect(body.get("remoteip")).toBeNull();
      expect(body.get("idempotency_key")).toBeTruthy();
    }
  );

  it("rejects a missing token before calling Siteverify", async () => {
    const fetcher = createSuccessfulSiteverify("signup");
    const bindings = createBindings();
    const result = await protectAuthRequest(
      createRequest("/api/auth/sign-up/email"),
      bindings,
      requestId,
      fetcher
    );

    expect(result?.status).toBe(403);
    expect(await result?.json()).toMatchObject({
      error: { code: "auth_challenge_failed" },
      requestId,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid, replayed, wrong-action, and wrong-hostname tokens", async () => {
    const invalidToken = vi.fn(async () =>
      Response.json({
        "error-codes": ["invalid-input-response"],
        success: false,
      })
    );
    const invalid = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "invalid-token"),
      createBindings(),
      requestId,
      invalidToken
    );
    expect(invalid?.status).toBe(403);

    const replayedTokens = new Set<string>();
    const replayingSiteverify = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        if (!(body instanceof URLSearchParams)) {
          return Promise.reject(new Error("Expected form-encoded Siteverify."));
        }
        const token = body.get("response") ?? "";
        if (replayedTokens.has(token)) {
          return Promise.resolve(
            Response.json({
              "error-codes": ["timeout-or-duplicate"],
              success: false,
            })
          );
        }
        replayedTokens.add(token);
        return Promise.resolve(
          Response.json({
            action: "login",
            hostname: "app.example.com",
            success: true,
          })
        );
      }
    );
    const firstUse = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "replayed-token"),
      createBindings(),
      requestId,
      replayingSiteverify
    );
    const secondUse = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "replayed-token"),
      createBindings(),
      requestId,
      replayingSiteverify
    );
    expect(firstUse).toBeUndefined();
    expect(secondUse?.status).toBe(403);

    const wrongAction = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "wrong-action"),
      createBindings(),
      requestId,
      createSuccessfulSiteverify("signup")
    );
    expect(wrongAction?.status).toBe(403);

    const wrongHostname = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "wrong-hostname"),
      createBindings(),
      requestId,
      vi.fn(async () =>
        Response.json({
          action: "login",
          hostname: "attacker.example",
          success: true,
        })
      )
    );
    expect(wrongHostname?.status).toBe(403);
  });

  it("applies the IP limit before Siteverify and the email-send limit after a valid challenge", async () => {
    const fetcher = createSuccessfulSiteverify("password_reset_request");
    const emailLimiter = createLimiter(false);
    const bindings = createBindings({ AUTH_EMAIL_RATE_LIMITER: emailLimiter });
    const result = await protectAuthRequest(
      createRequest("/api/auth/request-password-reset", "valid-token"),
      bindings,
      requestId,
      fetcher
    );

    expect(result?.status).toBe(429);
    expect(await result?.json()).toMatchObject({
      error: { code: "auth_rate_limited" },
      requestId,
    });
    expect(emailLimiter.limit).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(emailLimiter.limit.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetcher.mock.invocationCallOrder[0] ?? 0
    );
    expect(emailLimiter.limit.mock.calls[0]?.[0].key).not.toContain(
      "203.0.113.17"
    );
  });

  it("blocks at the IP limit before calling Siteverify", async () => {
    const fetcher = createSuccessfulSiteverify("login");
    const ipLimiter = createLimiter(false);
    const result = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "valid-token"),
      createBindings({ AUTH_RATE_LIMITER: ipLimiter }),
      requestId,
      fetcher
    );

    expect(result?.status).toBe(429);
    expect(ipLimiter.limit).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the rate limiter or Siteverify is unavailable", async () => {
    const bindingsWithoutLimiter = {
      ...createBindings(),
      AUTH_RATE_LIMITER: undefined,
    } as unknown as WorkerBindings;
    const missingLimiter = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "valid-token"),
      bindingsWithoutLimiter,
      requestId,
      createSuccessfulSiteverify("login")
    );
    expect(missingLimiter?.status).toBe(503);

    const unavailableSiteverify = await protectAuthRequest(
      createRequest("/api/auth/sign-in/email", "valid-token"),
      createBindings(),
      requestId,
      vi.fn(() =>
        Promise.reject(new Error("provider detail must not be exposed"))
      )
    );
    expect(unavailableSiteverify?.status).toBe(503);
    expect(await unavailableSiteverify?.json()).toMatchObject({
      error: { code: "auth_challenge_unavailable" },
      requestId,
    });
  });

  it("does not challenge auth routes outside public email/password actions", async () => {
    const emailLimiter = createLimiter();
    const ipLimiter = createLimiter();
    const fetcher = createSuccessfulSiteverify("login");
    const result = await protectAuthRequest(
      createRequest("/api/auth/get-session", undefined, "GET"),
      createBindings({
        AUTH_EMAIL_RATE_LIMITER: emailLimiter,
        AUTH_RATE_LIMITER: ipLimiter,
      }),
      requestId,
      fetcher
    );

    expect(result).toBeUndefined();
    expect(ipLimiter.limit).not.toHaveBeenCalled();
    expect(emailLimiter.limit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks protected requests before Better Auth and leaves unrelated auth routes alone", async () => {
    const authHandler = vi.fn(async () => Response.json({ reached: true }));
    const protector = vi.fn(async () =>
      Response.json(
        { error: { code: "auth_challenge_failed" } },
        { status: 403 }
      )
    );
    const testApp = createServerApp({
      authAbuseProtector: protector,
      authHandler,
    });
    const bindings = {
      AUTH_EMAIL_FROM: "Polaris <auth@example.invalid>",
      EMAIL_PASSWORD_AUTH_ENABLED: "true",
      RESEND_API_KEY: "re_test_only",
      ...createBindings(),
    } as WorkerBindings;

    const protectedResponse = await testApp.request(
      "/api/auth/sign-in/email",
      { headers: { origin: baseURL }, method: "POST" },
      bindings
    );
    const protectedTrailingSlashResponse = await testApp.request(
      "/api/auth/sign-in/email/",
      { headers: { origin: baseURL }, method: "POST" },
      bindings
    );
    const unrelatedResponse = await testApp.request(
      "/api/auth/get-session",
      { method: "GET" },
      bindings
    );

    expect(protectedResponse.status).toBe(403);
    expect(protectedTrailingSlashResponse.status).toBe(403);
    expect(authHandler).toHaveBeenCalledOnce();
    expect(protector).toHaveBeenCalledTimes(2);
    expect(unrelatedResponse.status).toBe(200);
  });

  it("fails closed when enabled email/password auth lacks abuse-protection config", async () => {
    const authHandler = vi.fn(async () => Response.json({ reached: true }));
    const testApp = createServerApp({ authHandler });
    const response = await testApp.request(
      "/api/auth/sign-up/email",
      {
        headers: { "cf-connecting-ip": "203.0.113.17", origin: baseURL },
        method: "POST",
      },
      {
        AUTH_ABUSE_PROTECTION_ENABLED: "false",
        AUTH_EMAIL_FROM: "Polaris <auth@example.invalid>",
        BETTER_AUTH_BASE_URL: baseURL,
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
        EMAIL_PASSWORD_AUTH_ENABLED: "true",
        HYPERDRIVE: { connectionString: "" },
        RESEND_API_KEY: "re_test_only",
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_abuse_protection_unavailable" },
    });
    expect(authHandler).not.toHaveBeenCalled();
  });
});

describe("Google sign-in rate limit", () => {
  const socialLimit = 20;
  const socialBindings = (overrides: Partial<WorkerBindings> = {}) =>
    ({
      AUTH_SOCIAL_RATE_LIMITER: createLimiter(),
      BETTER_AUTH_BASE_URL: baseURL,
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
      HYPERDRIVE: { connectionString: "" },
      ...overrides,
    }) as WorkerBindings;
  const withoutSocialLimiter = (overrides: Partial<WorkerBindings> = {}) => {
    const { AUTH_SOCIAL_RATE_LIMITER: _removed, ...rest } =
      socialBindings(overrides);
    return rest as WorkerBindings;
  };

  /** A limiter that allows `socialLimit` calls and then refuses, like the 20 per 60 s of the binding. */
  function countingLimiter() {
    let calls = 0;
    return {
      limit: vi.fn((_options: { key: string }) => {
        calls += 1;
        return Promise.resolve({ success: calls <= socialLimit });
      }),
    };
  }

  function startRequest(ip: string | null = "203.0.113.17") {
    return new Request(`${baseURL}/api/auth/sign-in/social`, {
      headers: {
        ...(ip ? { "cf-connecting-ip": ip } : {}),
        origin: baseURL,
      },
      method: "POST",
    });
  }

  function callbackRequest(ip: string | null = "203.0.113.17") {
    return new Request(
      `${baseURL}/api/auth/callback/google?code=fake-code&state=fake-state`,
      { headers: ip ? { "cf-connecting-ip": ip } : {}, method: "GET" }
    );
  }

  it("lets the 20th start through and answers 429 JSON to the 21st", async () => {
    const bindings = socialBindings({
      AUTH_SOCIAL_RATE_LIMITER: countingLimiter(),
    });

    for (let call = 1; call <= socialLimit; call += 1) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: the calls count in order against one limiter
        await protectSocialAuthRequest(startRequest(), bindings, requestId)
      ).toBeUndefined();
    }
    const refused = await protectSocialAuthRequest(
      startRequest(),
      bindings,
      requestId
    );

    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("location")).toBeNull();
    expect(await refused?.json()).toEqual({
      error: { code: "auth_rate_limited" },
      requestId,
    });
  });

  it("redirects the callback over the limit to the sign-in page instead of showing JSON", async () => {
    const bindings = socialBindings({
      AUTH_SOCIAL_RATE_LIMITER: createLimiter(false),
    });

    const refused = await protectSocialAuthRequest(
      callbackRequest(),
      bindings,
      requestId
    );

    expect(refused?.status).toBe(302);
    expect(refused?.headers.get("location")).toBe("/entrar?erro=limite");
    expect(refused?.headers.get("cache-control")).toBe("no-store");
    expect(await refused?.text()).toBe("");
  });

  it("counts the start and the callback in the same bucket of the same IP", async () => {
    const limiter = createLimiter();
    const bindings = socialBindings({ AUTH_SOCIAL_RATE_LIMITER: limiter });

    await protectSocialAuthRequest(startRequest(), bindings, requestId);
    await protectSocialAuthRequest(callbackRequest(), bindings, requestId);

    const keys = limiter.limit.mock.calls.map(([options]) => options.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(socialKeyPattern);
    expect(keys[0]).not.toContain("203.0.113.17");
  });

  it("separates one IP from another", async () => {
    const limiter = createLimiter();
    const bindings = socialBindings({ AUTH_SOCIAL_RATE_LIMITER: limiter });

    await protectSocialAuthRequest(startRequest("203.0.113.1"), bindings);
    await protectSocialAuthRequest(startRequest("203.0.113.2"), bindings);

    const [first, second] = limiter.limit.mock.calls.map(
      ([options]) => options.key
    );
    expect(first).not.toBe(second);
  });

  it("fails closed with 503 JSON on the start when the binding is missing", async () => {
    const response = await protectSocialAuthRequest(
      startRequest(),
      withoutSocialLimiter(),
      requestId
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      error: { code: "auth_rate_limit_unavailable" },
    });
  });

  it("redirects the callback to the sign-in page when the binding is missing", async () => {
    const response = await protectSocialAuthRequest(
      callbackRequest(),
      withoutSocialLimiter(),
      requestId
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/entrar?erro=indisponivel");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["has no client IP", () => startRequest(null), createLimiter()],
    [
      "has an invalid client IP",
      () => startRequest("1.2.3.4, 5.6.7.8"),
      createLimiter(),
    ],
    [
      "meets a limiter that throws",
      () => startRequest(),
      {
        limit: vi.fn(() => Promise.reject(new Error("limiter down"))),
      },
    ],
    [
      "meets a limiter with an unreadable answer",
      () => startRequest(),
      { limit: vi.fn(async () => ({}) as { success: boolean }) },
    ],
  ])(
    "fails closed with 503 when the request %s",
    async (_name, build, limiter) => {
      const response = await protectSocialAuthRequest(
        build(),
        socialBindings({ AUTH_SOCIAL_RATE_LIMITER: limiter }),
        requestId
      );

      expect(response?.status).toBe(503);
    }
  );

  it.each([
    ["has no client IP", () => callbackRequest(null), createLimiter()],
    [
      "meets a limiter that throws",
      () => callbackRequest(),
      {
        limit: vi.fn(() => Promise.reject(new Error("limiter down"))),
      },
    ],
    [
      "meets a limiter with an unreadable answer",
      () => callbackRequest(),
      { limit: vi.fn(async () => ({}) as { success: boolean }) },
    ],
  ])(
    "redirects the callback to the sign-in page when the request %s",
    async (_name, build, limiter) => {
      const onUnavailable = vi.fn();
      const response = await protectSocialAuthRequest(
        build(),
        socialBindings({ AUTH_SOCIAL_RATE_LIMITER: limiter }),
        requestId,
        onUnavailable
      );

      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe(
        "/entrar?erro=indisponivel"
      );
      expect(onUnavailable).toHaveBeenCalledTimes(1);
    }
  );

  it("does not report an unavailable limiter when someone is only over the limit", async () => {
    const onUnavailable = vi.fn();
    const refused = await protectSocialAuthRequest(
      callbackRequest(),
      socialBindings({ AUTH_SOCIAL_RATE_LIMITER: createLimiter(false) }),
      requestId,
      onUnavailable
    );

    expect(refused?.headers.get("location")).toBe("/entrar?erro=limite");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("ignores every other auth route", async () => {
    const limiter = createLimiter(false);
    const bindings = socialBindings({ AUTH_SOCIAL_RATE_LIMITER: limiter });

    const routes: [string, string][] = [
      ["/api/auth/get-session", "GET"],
      ["/api/auth/sign-in/email", "POST"],
      ["/api/auth/sign-in/social", "GET"],
      ["/api/auth/link-social", "POST"],
      ["/api/auth/callback/other", "GET"],
    ];
    for (const [path, method] of routes) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after the other, then one check of the limiter
      const response = await protectSocialAuthRequest(
        new Request(`${baseURL}${path}`, {
          headers: { "cf-connecting-ip": "203.0.113.17" },
          method,
        }),
        bindings,
        requestId
      );
      expect(response, `${method} ${path}`).toBeUndefined();
    }
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  describe("in the server app", () => {
    // Google is on while the password is off: nothing here turns on the abuse protection flag.
    const appBindings = (overrides: Partial<WorkerBindings> = {}) =>
      socialBindings({
        AUTH_ABUSE_PROTECTION_ENABLED: "false",
        EMAIL_PASSWORD_AUTH_ENABLED: "false",
        ...overrides,
      });

    it("answers 429 to the 21st start and never reaches Better Auth", async () => {
      const authHandler = vi.fn(async () => Response.json({ reached: true }));
      const testApp = createServerApp({ authHandler });
      const bindings = appBindings({
        AUTH_SOCIAL_RATE_LIMITER: countingLimiter(),
      });
      const call = () =>
        testApp.request(
          "/api/auth/sign-in/social",
          {
            headers: { "cf-connecting-ip": "203.0.113.17", origin: baseURL },
            method: "POST",
          },
          bindings
        );

      for (let index = 0; index < socialLimit; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: the calls count in order against one limiter
        expect((await call()).status).toBe(200);
      }
      const refused = await call();

      expect(refused.status).toBe(429);
      expect(authHandler).toHaveBeenCalledTimes(socialLimit);
    });

    it("redirects the callback over the limit with 302 and a Location, without reaching Better Auth", async () => {
      const authHandler = vi.fn(async () => Response.json({ reached: true }));
      const testApp = createServerApp({ authHandler });

      const response = await testApp.request(
        "/api/auth/callback/google?code=fake-code&state=fake-state",
        { headers: { "cf-connecting-ip": "203.0.113.17" } },
        appBindings({ AUTH_SOCIAL_RATE_LIMITER: createLimiter(false) })
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/entrar?erro=limite");
      expect(authHandler).not.toHaveBeenCalled();
    });

    it("logs the failing limiter on the callback, which the 302 hides from a 5xx alert, without the IP", async () => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const testApp = createServerApp({
        authHandler: vi.fn(async () => Response.json({ reached: true })),
      });
      const { AUTH_SOCIAL_RATE_LIMITER: _removed, ...rest } = appBindings();

      await testApp.request(
        "/api/auth/callback/google?code=fake-code&state=fake-state",
        { headers: { "cf-connecting-ip": "203.0.113.17" } },
        rest as WorkerBindings
      );

      expect(warn).toHaveBeenCalledOnce();
      const [entry] = warn.mock.calls[0] ?? [];
      expect(entry).toMatchObject({
        event: "auth_social_rate_limit_unavailable",
        method: "GET",
      });
      expect(JSON.stringify(entry)).not.toContain("203.0.113.17");
      expect(JSON.stringify(entry)).not.toContain("fake-code");
      warn.mockRestore();
    });

    it("answers 503 on the start and a 302 to the sign-in page on the callback when the binding is missing", async () => {
      const authHandler = vi.fn(async () => Response.json({ reached: true }));
      const testApp = createServerApp({ authHandler });
      const { AUTH_SOCIAL_RATE_LIMITER: _removed, ...rest } = appBindings();
      const bindings = rest as WorkerBindings;
      const init = {
        headers: { "cf-connecting-ip": "203.0.113.17", origin: baseURL },
      };

      const start = await testApp.request(
        "/api/auth/sign-in/social",
        { ...init, method: "POST" },
        bindings
      );
      const callback = await testApp.request(
        "/api/auth/callback/google?code=fake-code&state=fake-state",
        init,
        bindings
      );

      expect(start.status).toBe(503);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(
        "/entrar?erro=indisponivel"
      );
      expect(authHandler).not.toHaveBeenCalled();
    });
  });
});

describe("protectAuthLinkRequest (links of the e-mails)", () => {
  const unset = (key: keyof WorkerBindings) =>
    ({ [key]: undefined }) as Partial<WorkerBindings>;
  const linkRequest = (ip: string | null = "203.0.113.17") =>
    new Request(`${baseURL}/api/login-unlock`, {
      headers: ip === null ? {} : { "cf-connecting-ip": ip },
      method: "POST",
    });

  it("lets the request through (undefined) when the limiter allows it, with a key of its own per IP", async () => {
    const limiter = createLimiter(true);

    const response = await protectAuthLinkRequest(
      linkRequest(),
      createBindings({ AUTH_RATE_LIMITER: limiter }),
      requestId
    );

    expect(response).toBeUndefined();
    expect(limiter.limit).toHaveBeenCalledTimes(1);
    expect(limiter.limit.mock.calls[0]?.[0].key).toMatch(linkKeyPattern);
  });

  it("uses a different key for each IP and never the IP itself", async () => {
    const limiter = createLimiter(true);
    const bindings = createBindings({ AUTH_RATE_LIMITER: limiter });

    await protectAuthLinkRequest(linkRequest("203.0.113.1"), bindings);
    await protectAuthLinkRequest(linkRequest("203.0.113.2"), bindings);
    await protectAuthLinkRequest(linkRequest("203.0.113.1"), bindings);

    const keys = limiter.limit.mock.calls.map(([options]) => options.key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
    expect(keys.join()).not.toContain("203.0.113");
  });

  it("answers 429 auth_rate_limited when the limiter denies", async () => {
    const response = await protectAuthLinkRequest(
      linkRequest(),
      createBindings({ AUTH_RATE_LIMITER: createLimiter(false) }),
      requestId
    );

    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({
      error: { code: "auth_rate_limited" },
    });
  });

  it("fails closed with 503 auth_rate_limit_unavailable without the binding", async () => {
    const response = await protectAuthLinkRequest(
      linkRequest(),
      createBindings(unset("AUTH_RATE_LIMITER")),
      requestId
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      error: { code: "auth_rate_limit_unavailable" },
    });
  });

  it.each([
    ["no client IP", null],
    ["an empty client IP", "   "],
    ["a client IP that is too long", "1".repeat(65)],
    ["a client IP with forbidden characters", "203.0.113.1; drop"],
  ])(
    "fails closed with 503 with %s, without calling the limiter",
    async (_name, ip) => {
      const limiter = createLimiter(true);

      const response = await protectAuthLinkRequest(
        linkRequest(ip),
        createBindings({ AUTH_RATE_LIMITER: limiter }),
        requestId
      );

      expect(response?.status).toBe(503);
      expect(limiter.limit).not.toHaveBeenCalled();
    }
  );

  it("fails closed with 503 without the secret", async () => {
    const response = await protectAuthLinkRequest(
      linkRequest(),
      createBindings(unset("BETTER_AUTH_SECRET")),
      requestId
    );

    expect(response?.status).toBe(503);
  });

  it("fails closed with 503 when the limiter throws or answers no boolean", async () => {
    const throwing = {
      limit: vi.fn(() => Promise.reject(new Error("limiter down"))),
    };
    const odd = {
      limit: vi.fn(() => Promise.resolve({ success: "yes" })),
    };

    const first = await protectAuthLinkRequest(
      linkRequest(),
      createBindings({
        AUTH_RATE_LIMITER: throwing as unknown as NonNullable<
          WorkerBindings["AUTH_RATE_LIMITER"]
        >,
      }),
      requestId
    );
    const second = await protectAuthLinkRequest(
      linkRequest(),
      createBindings({
        AUTH_RATE_LIMITER: odd as unknown as NonNullable<
          WorkerBindings["AUTH_RATE_LIMITER"]
        >,
      }),
      requestId
    );

    expect(first?.status).toBe(503);
    expect(second?.status).toBe(503);
  });
});

describe("one identity of the client across the per-IP limits", () => {
  const sameNet = [
    "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
    "2001:0db8:0001:0002::1",
    "2001:DB8:1:2:ffff:ffff:ffff:ffff",
  ] as const;
  const otherNet = "2001:db8:1:3::1";
  const invalid = ["abc", "1.2.3.4, 5.6.7.8", "2001:db8::1 2", "999.1.1.1"];

  /** What one request to a limited flow did: the limiter keys it counted, and the status it answered with. */
  interface Outcome {
    keys: string[];
    status: number | undefined;
  }

  const flows: [string, (ip: string) => Promise<Outcome>][] = [
    [
      "sign-in (auth-ip)",
      async (ip) => {
        const limiter = createLimiter();
        const response = await protectAuthRequest(
          new Request(`${baseURL}/api/auth/sign-in/email`, {
            headers: { "cf-connecting-ip": ip, "x-turnstile-token": "t" },
            method: "POST",
          }),
          createBindings({ AUTH_RATE_LIMITER: limiter }),
          requestId,
          createSuccessfulSiteverify("login")
        );
        return {
          keys: limiter.limit.mock.calls.map(([call]) => call.key),
          status: response?.status,
        };
      },
    ],
    [
      "Google sign-in (auth-social-ip)",
      async (ip) => {
        const limiter = createLimiter();
        const response = await protectSocialAuthRequest(
          new Request(`${baseURL}/api/auth/sign-in/social`, {
            headers: { "cf-connecting-ip": ip, origin: baseURL },
            method: "POST",
          }),
          {
            AUTH_SOCIAL_RATE_LIMITER: limiter,
            BETTER_AUTH_BASE_URL: baseURL,
            BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
            HYPERDRIVE: { connectionString: "" },
          } as WorkerBindings,
          requestId
        );
        return {
          keys: limiter.limit.mock.calls.map(([call]) => call.key),
          status: response?.status,
        };
      },
    ],
    [
      "e-mail links (auth-link-ip)",
      async (ip) => {
        const limiter = createLimiter();
        const response = await protectAuthLinkRequest(
          new Request(`${baseURL}/api/login-unlock`, {
            headers: { "cf-connecting-ip": ip },
            method: "POST",
          }),
          createBindings({ AUTH_RATE_LIMITER: limiter }),
          requestId
        );
        return {
          keys: limiter.limit.mock.calls.map(([call]) => call.key),
          status: response?.status,
        };
      },
    ],
    [
      "e-mail send (auth-email-send-ip)",
      async (ip) => {
        const limiter = createLimiter();
        const response = await protectAuthRequest(
          new Request(`${baseURL}/api/auth/request-password-reset`, {
            headers: { "cf-connecting-ip": ip, "x-turnstile-token": "t" },
            method: "POST",
          }),
          createBindings({ AUTH_EMAIL_RATE_LIMITER: limiter }),
          requestId,
          createSuccessfulSiteverify("password_reset_request")
        );
        return {
          keys: limiter.limit.mock.calls.map(([call]) => call.key),
          status: response?.status,
        };
      },
    ],
  ];

  it.each(flows)(
    "%s: the addresses of one /64 share a bucket and another /64 has its own",
    async (_name, run) => {
      const first = await run(sameNet[0]);
      expect(first.keys).toHaveLength(1);
      for (const outcome of await Promise.all(sameNet.map(run))) {
        expect(outcome.keys).toEqual(first.keys);
      }
      expect((await run(otherNet)).keys).not.toEqual(first.keys);
    }
  );

  it.each(flows)(
    "%s: IPv4 is counted whole, and a mapped IPv4 is the IPv4 address",
    async (_name, run) => {
      const plain = (await run("203.0.113.17")).keys;
      expect(plain).toHaveLength(1);
      expect((await run("::ffff:203.0.113.17")).keys).toEqual(plain);
      expect((await run("::ffff:cb00:7111")).keys).toEqual(plain);
      expect((await run("203.0.113.18")).keys).not.toEqual(plain);
      expect(plain[0]).not.toContain("203.0.113.17");
    }
  );

  it.each(flows)(
    "%s: text that is not an address is a 503 and counts nothing",
    async (_name, run) => {
      for (const outcome of await Promise.all([...invalid, ""].map(run))) {
        expect(outcome.status).toBe(503);
        expect(outcome.keys).toEqual([]);
      }
    }
  );
});
