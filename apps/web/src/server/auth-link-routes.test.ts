import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "./app";
import type { WorkerBindings } from "./environment";

const baseURL = "https://app.example.com";
const routes = ["/api/login-unlock", "/api/email-verification"] as const;

function createLimiter(success = true) {
  return { limit: vi.fn(async (_options: { key: string }) => ({ success })) };
}

function createBindings(overrides: Partial<WorkerBindings> = {}) {
  return {
    AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
    AUTH_RATE_LIMITER: createLimiter(),
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes",
    EMAIL_PASSWORD_AUTH_ENABLED: "true",
    RESEND_API_KEY: "re_test_only",
    ...overrides,
  } as WorkerBindings;
}

function createApp() {
  const handled = () =>
    vi.fn(async (..._args: unknown[]) =>
      Response.json({ handled: true }, { status: 200 })
    );
  const loginUnlock = handled();
  const emailVerification = handled();
  const app = createServerApp({
    authLinkHandlers: { emailVerification, loginUnlock },
  });
  return { app, emailVerification, loginUnlock };
}

function post(
  path: string,
  headers: Record<string, string> = {},
  method = "POST"
) {
  const request: {
    body?: string;
    headers: Record<string, string>;
    method: string;
    path: string;
  } = {
    ...(method === "POST" ? { body: JSON.stringify({ token: "t" }) } : {}),
    headers: {
      "cf-connecting-ip": "203.0.113.50",
      "content-type": "application/json",
      origin: baseURL,
      ...headers,
    },
    method,
    path,
  };
  return request;
}

/** Bindings with some keys left out, as a Worker without them would have. */
function without(...keys: (keyof WorkerBindings)[]): Partial<WorkerBindings> {
  return Object.fromEntries(
    keys.map((key) => [key, undefined])
  ) as Partial<WorkerBindings>;
}

function send(
  app: ReturnType<typeof createApp>["app"],
  request: ReturnType<typeof post>,
  bindings: WorkerBindings
) {
  const { path, ...init } = request;
  return app.request(path, init, bindings);
}

describe.each(routes)("POST %s (the links of the e-mails)", (path) => {
  const handlerOf = (ctx: ReturnType<typeof createApp>) =>
    path === "/api/login-unlock" ? ctx.loginUnlock : ctx.emailVerification;
  const otherOf = (ctx: ReturnType<typeof createApp>) =>
    path === "/api/login-unlock" ? ctx.emailVerification : ctx.loginUnlock;

  it("answers 503 auth_email_unavailable while the password is off, without touching the limiter or the handler", async () => {
    const ctx = createApp();
    const limiter = createLimiter();

    const response = await send(
      ctx.app,
      post(path),
      createBindings({
        AUTH_RATE_LIMITER: limiter,
        EMAIL_PASSWORD_AUTH_ENABLED: "false",
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_email_unavailable" },
    });
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("is off too without the e-mail sender configured", async () => {
    const ctx = createApp();

    const response = await send(
      ctx.app,
      post(path),
      createBindings(without("RESEND_API_KEY"))
    );

    expect(response.status).toBe(503);
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("answers 503 auth_rate_limit_unavailable without AUTH_RATE_LIMITER", async () => {
    const ctx = createApp();

    const response = await send(
      ctx.app,
      post(path),
      createBindings(without("AUTH_RATE_LIMITER"))
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_rate_limit_unavailable" },
    });
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("answers 503 without the client IP (fails closed)", async () => {
    const ctx = createApp();
    const request = post(path);
    request.headers["cf-connecting-ip"] = "";

    const response = await send(ctx.app, request, createBindings());

    expect(response.status).toBe(503);
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("answers 429 auth_rate_limited when the limiter denies, and the handler never runs", async () => {
    const ctx = createApp();

    const response = await send(
      ctx.app,
      post(path),
      createBindings({ AUTH_RATE_LIMITER: createLimiter(false) })
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_rate_limited" },
    });
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("calls only its own handler when the limiter allows, with the request, the bindings and the request ID", async () => {
    const ctx = createApp();
    const limiter = createLimiter();
    const bindings = createBindings({ AUTH_RATE_LIMITER: limiter });

    const response = await send(ctx.app, post(path), bindings);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: true });
    expect(limiter.limit).toHaveBeenCalledTimes(1);
    expect(handlerOf(ctx)).toHaveBeenCalledTimes(1);
    expect(otherOf(ctx)).not.toHaveBeenCalled();
    const [request, passedBindings, requestId, runInBackground] = handlerOf(ctx)
      .mock.calls[0] as [Request, WorkerBindings, string, unknown];
    expect(new URL(request.url).pathname).toBe(path);
    expect(passedBindings.BETTER_AUTH_BASE_URL).toBe(baseURL);
    expect(typeof requestId).toBe("string");
    expect(typeof runInBackground).toBe("function");
  });

  it("refuses a foreign Origin with 403 before the limiter and the handler", async () => {
    const ctx = createApp();
    const limiter = createLimiter();

    const response = await send(
      ctx.app,
      post(path, { origin: "https://evil.example.com" }),
      createBindings({ AUTH_RATE_LIMITER: limiter })
    );

    expect(response.status).toBe(403);
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("refuses a request with no Origin and no same-origin fetch metadata", async () => {
    const ctx = createApp();
    const request = post(path);
    request.headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => name !== "origin")
    );

    const response = await send(ctx.app, request, createBindings());

    expect(response.status).toBe(403);
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });

  it("is POST only: a GET is a 404", async () => {
    const ctx = createApp();

    const response = await send(
      ctx.app,
      post(`${path}?token=abc`, {}, "GET"),
      createBindings()
    );

    expect(response.status).toBe(404);
    expect(handlerOf(ctx)).not.toHaveBeenCalled();
  });
});
