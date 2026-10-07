import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { protectAuthRequest } from "./abuse-protection";

const requestId = "pr16-auth-abuse-test";
const turnstileSecret = "test-only-turnstile-secret";
const baseURL = "https://app.example.com";

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
      { method: "POST" },
      bindings
    );
    const unrelatedResponse = await testApp.request(
      "/api/auth/get-session",
      { method: "GET" },
      bindings
    );

    expect(protectedResponse.status).toBe(403);
    expect(authHandler).toHaveBeenCalledOnce();
    expect(protector).toHaveBeenCalledOnce();
    expect(unrelatedResponse.status).toBe(200);
  });

  it("fails closed when enabled email/password auth lacks abuse-protection config", async () => {
    const authHandler = vi.fn(async () => Response.json({ reached: true }));
    const testApp = createServerApp({ authHandler });
    const response = await testApp.request(
      "/api/auth/sign-up/email",
      { headers: { "cf-connecting-ip": "203.0.113.17" }, method: "POST" },
      {
        AUTH_ABUSE_PROTECTION_ENABLED: "false",
        AUTH_EMAIL_FROM: "Polaris <auth@example.invalid>",
        BETTER_AUTH_BASE_URL: baseURL,
        BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
        DB_POC_ENABLED: "false",
        DB_RLS_POC_ENABLED: "false",
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
