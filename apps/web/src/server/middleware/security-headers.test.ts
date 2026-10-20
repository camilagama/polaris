import {
  renderStaticHeadersFile,
  securityHeaders,
  TURNSTILE_ORIGIN,
} from "@polaris/http-security";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import staticHeadersFile from "../../../public/_headers?raw";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import {
  APP_SHELL_SECURITY_OPTIONS,
  securityHeadersMiddleware,
} from "./security-headers";

const UNSAFE_OR_WILDCARD = /unsafe-|\*/;

const HTTP_URL = /https?:\/\//;
const baseURL = "https://polaris.example.invalid";
const bindings = {
  BETTER_AUTH_BASE_URL: baseURL,
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
} satisfies WorkerBindings;

const API_HEADERS = securityHeaders("api");

function expectApiHeaders(response: Response) {
  for (const [name, value] of Object.entries(API_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

describe("the headers of the app shell (public/_headers)", () => {
  it("is exactly what the shared module renders, so the two cannot drift", () => {
    expect(staticHeadersFile).toBe(
      renderStaticHeadersFile(APP_SHELL_SECURITY_OPTIONS)
    );
  });

  it("opens no origin beyond the app's own, but the challenge on the sign-in pages", () => {
    expect(APP_SHELL_SECURITY_OPTIONS).toEqual({});
    expect(
      staticHeadersFile.replaceAll(TURNSTILE_ORIGIN, "TURNSTILE")
    ).not.toMatch(HTTP_URL);
  });
});

describe("the headers of the Worker's answers", () => {
  const app = createServerApp();

  it("covers a health check, an unknown route and a refused request alike", async () => {
    const answers = [
      await app.request("/health", {}, bindings),
      await app.request("/ready", {}, bindings),
      await app.request("/api/does-not-exist", {}, bindings),
      await app.request("/rpc/category/create", { method: "POST" }, bindings),
      await app.request(
        "/api/auth/get-session",
        { headers: { origin: "https://evil.example" } },
        { ...bindings, BETTER_AUTH_SECRET: "short" }
      ),
    ];

    for (const response of answers) {
      expectApiHeaders(response);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(answers.map((response) => response.status)).toContain(404);
  });

  it("never lets a response be framed, sniffed or loaded by another origin", async () => {
    const response = await app.request("/health", {}, bindings);
    const policy = response.headers.get("Content-Security-Policy") ?? "";

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(UNSAFE_OR_WILDCARD);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin"
    );
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin"
    );
    expect(response.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000"
    );
  });

  it("keeps the Cache-Control a handler chose and replaces a security header it set", async () => {
    const probe = new Hono();
    probe.use("*", securityHeadersMiddleware);
    probe.get("/file", (context) =>
      context.body("x", 200, {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src *",
      })
    );
    probe.get("/cached", (context) =>
      context.body("x", 200, { "Cache-Control": "private, max-age=30" })
    );
    probe.get("/redirect", () =>
      Response.redirect("https://example.com/", 302)
    );
    probe.get("/boom", () => {
      throw new Error("boom");
    });

    const file = await probe.request("/file");
    expect(file.headers.get("Cache-Control")).toBe("private, no-store");
    expectApiHeaders(file);
    expect((await probe.request("/cached")).headers.get("Cache-Control")).toBe(
      "private, max-age=30"
    );
    // a redirect from Response.redirect has immutable headers; the policy still lands on it
    const redirect = await probe.request("/redirect");
    expect(redirect.status).toBe(302);
    expectApiHeaders(redirect);
    const failed = await probe.request("/boom");
    expect(failed.status).toBe(500);
    expectApiHeaders(failed);
  });
});
