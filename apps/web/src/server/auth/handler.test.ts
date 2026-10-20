import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import { handleBetterAuthRequest } from "./handler";

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
});
