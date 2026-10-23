import { describe, expect, it } from "vitest";
import { createServerApp } from "../app";
import { protectAuthRequest } from "../auth/abuse-protection";
import type { WorkerBindings } from "../environment";
import { authMethods } from "./auth-methods";

const bindings = (extra: Partial<WorkerBindings> = {}) =>
  ({
    BETTER_AUTH_BASE_URL: "https://polaris.example",
    ...extra,
  }) as WorkerBindings;

const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
const limiter = { limit: () => Promise.resolve({ success: true }) };
const protection = {
  AUTH_ABUSE_PROTECTION_ENABLED: "true",
  AUTH_EMAIL_RATE_LIMITER: limiter,
  AUTH_RATE_LIMITER: limiter,
  TURNSTILE_SECRET_KEY: "secret-key",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
};
const { AUTH_EMAIL_RATE_LIMITER: _emailLimiter, ...withoutEmailLimiter } =
  protection;
const { AUTH_RATE_LIMITER: _ipLimiter, ...withoutIpLimiter } = protection;
const passwordSetup = {
  AUTH_EMAIL_FROM: "Polaris <no-reply@polaris.example>",
  EMAIL_PASSWORD_AUTH_ENABLED: "true",
  RESEND_API_KEY: "re_test",
};
const password = { ...passwordSetup, ...protection };

describe("authMethods", () => {
  it.each([
    ["nothing is configured", {}, false, false, null],
    ["only Google is configured", google, true, false, null],
    [
      "Google has an id and no secret",
      { GOOGLE_CLIENT_ID: "id" },
      false,
      false,
      null,
    ],
    [
      "Google values are blank",
      { GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: " " },
      false,
      false,
      null,
    ],
    [
      "the password is on",
      { ...google, ...password },
      true,
      true,
      "1x00000000000000000000AA",
    ],
    [
      "the password flag is on without the e-mail sender",
      {
        ...google,
        ...protection,
        EMAIL_PASSWORD_AUTH_ENABLED: "true",
        RESEND_API_KEY: "re_test",
      },
      true,
      false,
      null,
    ],
    [
      "the password is on without a site key",
      { ...google, ...password, TURNSTILE_SITE_KEY: " " },
      true,
      false,
      null,
    ],
    [
      "the password is on and the abuse protection flag is off",
      { ...google, ...password, AUTH_ABUSE_PROTECTION_ENABLED: "false" },
      true,
      false,
      null,
    ],
    [
      "the password is on without the Turnstile secret",
      { ...google, ...password, TURNSTILE_SECRET_KEY: " " },
      true,
      false,
      null,
    ],
    [
      "the password is on without the base URL",
      { ...google, ...password, BETTER_AUTH_BASE_URL: " " },
      true,
      false,
      null,
    ],
    [
      "the password is on without the e-mail limiter",
      { ...google, ...passwordSetup, ...withoutEmailLimiter },
      true,
      false,
      null,
    ],
    [
      "the password is on without the IP limiter",
      { ...google, ...passwordSetup, ...withoutIpLimiter },
      true,
      false,
      null,
    ],
    [
      "the site key is set while the password is off",
      { ...google, ...protection },
      true,
      false,
      null,
    ],
    [
      "the password is on and Google is off",
      password,
      false,
      true,
      "1x00000000000000000000AA",
    ],
  ] as const)(
    "says what is on when %s",
    (_name, extra, googleOn, emailPassword, key) => {
      expect(authMethods(bindings(extra))).toEqual({
        emailPassword,
        google: googleOn,
        turnstileSiteKey: key,
      });
    }
  );
});

const CONFIGURATION_503 = new Set([
  "auth_abuse_protection_unavailable",
  "auth_rate_limit_unavailable",
]);

/** Sign-up is the action of the form that asks the most of the setup (it sends e-mail). */
async function signUpGetsConfigurationError(
  extra: Partial<WorkerBindings>
): Promise<boolean> {
  const request = new Request(
    "https://polaris.example/api/auth/sign-up/email",
    {
      headers: {
        "cf-connecting-ip": "203.0.113.17",
        "x-turnstile-token": "token",
      },
      method: "POST",
    }
  );
  const response = await protectAuthRequest(
    request,
    bindings(extra),
    undefined,
    () => Promise.resolve(Response.json({ success: false }))
  );
  if (response?.status !== 503) {
    return false;
  }
  const body = (await response.json()) as { error: { code: string } };
  return CONFIGURATION_503.has(body.error.code);
}

describe("authMethods and protectAuthRequest share one list of what is ready", () => {
  it.each([
    ["everything is set", { ...passwordSetup, ...protection }],
    [
      "the flag is off",
      { ...protection, AUTH_ABUSE_PROTECTION_ENABLED: "false" },
    ],
    [
      "the flag is missing",
      { ...protection, AUTH_ABUSE_PROTECTION_ENABLED: undefined },
    ],
    [
      "the flag is not exactly true",
      { ...protection, AUTH_ABUSE_PROTECTION_ENABLED: "TRUE" },
    ],
    [
      "the Turnstile secret is missing",
      { ...protection, TURNSTILE_SECRET_KEY: undefined },
    ],
    [
      "the Turnstile secret is blank",
      { ...protection, TURNSTILE_SECRET_KEY: " " },
    ],
    ["the base URL is blank", { ...protection, BETTER_AUTH_BASE_URL: " " }],
    [
      "the base URL is missing",
      { ...protection, BETTER_AUTH_BASE_URL: undefined },
    ],
    ["the e-mail limiter is missing", withoutEmailLimiter],
    ["the IP limiter is missing", withoutIpLimiter],
    [
      "both limiters are missing",
      { ...withoutEmailLimiter, AUTH_RATE_LIMITER: undefined },
    ],
    ["nothing is set", {}],
  ] as const)(
    "%s: the form is offered if and only if sign-up gets no configuration 503",
    async (_name, setup) => {
      const extra = { ...passwordSetup, ...setup } as Partial<WorkerBindings>;
      const ready = !(await signUpGetsConfigurationError(extra));
      expect(authMethods(bindings(extra)).emailPassword).toBe(ready);
    }
  );

  it("adds only the public site key: without it the form is not offered although the server has no 503", async () => {
    const extra = { ...passwordSetup, ...protection, TURNSTILE_SITE_KEY: " " };
    expect(await signUpGetsConfigurationError(extra)).toBe(false);
    expect(authMethods(bindings(extra)).emailPassword).toBe(false);
  });
});

describe("GET /api/auth-methods", () => {
  it("answers the methods, with no session and no cache", async () => {
    const response = await createServerApp().request(
      "/api/auth-methods",
      undefined,
      bindings(google)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      emailPassword: false,
      google: true,
      turnstileSiteKey: null,
    });
  });

  it("never carries a secret", async () => {
    const response = await createServerApp().request(
      "/api/auth-methods",
      undefined,
      bindings({ ...google, ...password, BETTER_AUTH_SECRET: "x".repeat(40) })
    );

    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("re_test");
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("x".repeat(40));
  });
});
