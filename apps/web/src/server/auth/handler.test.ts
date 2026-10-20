import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import { handleBetterAuthRequest, withBoundedBody } from "./handler";

describe("Better Auth handler database role", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed with a generic 503 when a deployed Worker has no AUTH_HYPERDRIVE", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const bindings: WorkerBindings = {
      BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
      BETTER_AUTH_SECRET: "a".repeat(32),
      HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
    };

    const response = await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/get-session"),
      bindings,
      "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "auth_unavailable" },
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth_database_not_configured",
        requestId: "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e",
      })
    );
  });

  describe("the routes with the token in the URL (ADR 0100, T-f)", () => {
    const passwordBindings: WorkerBindings = {
      AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
      BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PASSWORD_AUTH_ENABLED: "true",
      HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
      RESEND_API_KEY: "re_test_only",
    };
    const origin = "https://polaris.example.invalid";

    it.each([
      ["GET /verify-email?token=", "/api/auth/verify-email?token=abc"],
      ["GET /verify-email without a token", "/api/auth/verify-email"],
      ["GET /reset-password/<token>", "/api/auth/reset-password/abc123"],
      [
        "GET /reset-password/<token> with a trailing slash",
        "/api/auth/reset-password/abc123/",
      ],
    ])(
      "%s answers 404 not_found with the password on, before any database",
      async (_name, path) => {
        const response = await handleBetterAuthRequest(
          new Request(`${origin}${path}`),
          passwordBindings,
          "req-1"
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "not_found" } });
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    );

    it("keeps answering 503 auth_email_unavailable for those routes while the password is off", async () => {
      const response = await handleBetterAuthRequest(
        new Request(`${origin}/api/auth/verify-email?token=abc`),
        { ...passwordBindings, EMAIL_PASSWORD_AUTH_ENABLED: "false" },
        "req-1"
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "auth_email_unavailable" },
      });
    });

    it("does not close the POST of the token in the body: it goes on to the database (503 without one)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await handleBetterAuthRequest(
        new Request(`${origin}/api/auth/reset-password`, {
          body: JSON.stringify({ newPassword: "x", token: "abc" }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        }),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "auth_unavailable" },
      });
    });

    it.each([
      ["with the password on", passwordBindings],
      [
        "with the password off",
        { ...passwordBindings, EMAIL_PASSWORD_AUTH_ENABLED: "false" },
      ],
    ])(
      "POST /verify-password answers 404 not_found %s, before any database",
      async (_name, bindings) => {
        const response = await handleBetterAuthRequest(
          new Request(`${origin}/api/auth/verify-password`, {
            body: JSON.stringify({ password: "x" }),
            headers: { "content-type": "application/json", origin },
            method: "POST",
          }),
          bindings,
          "req-1"
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "not_found" } });
      }
    );

    it("does not close other GET routes (get-session goes on to the database)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await handleBetterAuthRequest(
        new Request(`${origin}/api/auth/get-session`),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(503);
    });
  });

  describe("the password routes decide by the exact path and read at most 8 KiB", () => {
    const passwordBindings: WorkerBindings = {
      AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
      BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PASSWORD_AUTH_ENABLED: "true",
      HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
      RESEND_API_KEY: "re_test_only",
    };
    const origin = "https://polaris.example.invalid";
    const exactPaths = [
      "/api/auth/sign-in/email",
      "/api/auth/change-password",
      "/api/auth/set-password",
    ];
    const json = JSON.stringify({ email: "a@example.invalid", password: "x" });

    function post(path: string, body: BodyInit = json): Request {
      return new Request(`${origin}${path}`, {
        body,
        headers: { "content-type": "application/json", origin },
        method: "POST",
      });
    }

    it.each([
      ["upper case", "/api/auth/Sign-In/Email"],
      ["all upper case", "/API/AUTH/SIGN-IN/EMAIL"],
      ["a trailing slash", "/api/auth/sign-in/email/"],
      ["two trailing slashes", "/api/auth/sign-in/email//"],
      ["%2F for the slash", "/api/auth/sign-in%2Femail"],
      ["%2f in lower case", "/api/auth/sign-in%2femail"],
      ["an encoded letter", "/api/auth/sign-in/emai%6C"],
      ["a similar suffix", "/api/auth/sign-in/email.json"],
      ["a longer last segment", "/api/auth/sign-in/emailx"],
      ["a segment after it", "/api/auth/sign-in/email/extra"],
      ["a prefix", "/api/auth/x/sign-in/email"],
      ["a double slash at the start", "//api/auth/sign-in/email"],
      ["a double slash in the middle", "/api/auth//sign-in/email"],
      ["upper case change-password", "/api/auth/Change-Password"],
      ["change-password with a trailing slash", "/api/auth/change-password/"],
      ["change-password with %2F", "/api/auth%2Fchange-password"],
      ["change-password with a suffix", "/api/auth/change-passwords"],
      ["upper case set-password", "/api/auth/SET-PASSWORD"],
      ["set-password with a trailing slash", "/api/auth/set-password/"],
      ["set-password with a suffix", "/api/auth/set-password.json"],
      ["set-password with a prefix", "/api/auth/x/set-password"],
    ])(
      "POST with %s answers 404 and never reaches Better Auth",
      async (_name, path) => {
        const response = await handleBetterAuthRequest(
          post(path),
          passwordBindings,
          "req-1"
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "not_found" } });
      }
    );

    it.each([
      "/api/auth/Verify-Password",
      "/api/auth/verify-password/",
      "/api/auth/verify%2Dpassword",
      "/api/auth/verify-password.json",
    ])("POST %s is closed like /verify-password", async (path) => {
      const response = await handleBetterAuthRequest(
        post(path),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(404);
    });

    it("keeps the body, the cookies and the headers when it rebuilds the request", async () => {
      const request = new Request(`${origin}/api/auth/sign-in/email`, {
        body: json,
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "content-type": "application/json",
          cookie: "better-auth.session_token=abc",
        },
        method: "POST",
      });

      const bounded = await withBoundedBody(request);

      expect(bounded).toBeInstanceOf(Request);
      const rebuilt = bounded as Request;
      expect(rebuilt.url).toBe(request.url);
      expect(rebuilt.method).toBe("POST");
      expect(rebuilt.headers.get("cookie")).toBe(
        "better-auth.session_token=abc"
      );
      expect(rebuilt.headers.get("cf-connecting-ip")).toBe("203.0.113.7");
      expect(rebuilt.headers.get("content-type")).toBe("application/json");
      // the lock and Better Auth read the clone, as before
      expect(await rebuilt.clone().json()).toEqual(JSON.parse(json));
      expect(await rebuilt.json()).toEqual(JSON.parse(json));
    });

    it("answers 400, not a 500, when the client drops the connection while sending", async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("aborted"));
        },
      });
      const request = new Request(`${origin}/api/auth/sign-in/email`, {
        body: stream,
        duplex: "half",
        headers: { "content-type": "application/json" },
        method: "POST",
      } as RequestInit);

      const response = await withBoundedBody(request);

      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
    });

    it("does not take /reset-password for /set-password", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await handleBetterAuthRequest(
        post("/api/auth/reset-password"),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(503);
    });

    it.each(exactPaths)(
      "POST %s, exactly, goes on to the database (503 without one)",
      async (path) => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const response = await handleBetterAuthRequest(
          post(path),
          passwordBindings,
          "req-1"
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: { code: "auth_unavailable" },
        });
      }
    );

    it.each(exactPaths)("POST %s with 8 KiB goes on", async (path) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await handleBetterAuthRequest(
        post(path, "x".repeat(8 * 1024)),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(503);
    });

    it.each(exactPaths)(
      "POST %s with more than 8 KiB answers 413 before reading the JSON",
      async (path) => {
        const response = await handleBetterAuthRequest(
          post(path, JSON.stringify({ email: "a".repeat(8 * 1024) })),
          passwordBindings,
          "req-1"
        );

        expect(response.status).toBe(413);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
          error: { code: "payload_too_large" },
        });
      }
    );

    it("answers 413 for a body with no Content-Length that grows past 8 KiB", async () => {
      const chunk = new TextEncoder().encode("x".repeat(1024));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          if (sent > 16) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
      });
      const request = new Request(`${origin}/api/auth/sign-in/email`, {
        body: stream,
        duplex: "half",
        headers: { "content-type": "application/json", origin },
        method: "POST",
      } as RequestInit);

      const response = await handleBetterAuthRequest(
        request,
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(413);
      // it stopped reading at the limit: it did not drain the 16 KiB the stream had
      expect(sent).toBeLessThan(16);
    });

    it("does not limit the body of other routes", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await handleBetterAuthRequest(
        post("/api/auth/reset-password", "x".repeat(20 * 1024)),
        passwordBindings,
        "req-1"
      );

      expect(response.status).toBe(503);
    });
  });
});
