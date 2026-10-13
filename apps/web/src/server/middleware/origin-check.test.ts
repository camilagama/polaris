import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv, WorkerBindings } from "../environment";
import { originCheckMiddleware } from "./origin-check";
import { requestIdMiddleware } from "./request-id";

const baseURL = "https://polaris.example.invalid";
const bindings = {
  BETTER_AUTH_BASE_URL: baseURL,
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
} satisfies WorkerBindings;

function createApp() {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.use("/rpc/*", originCheckMiddleware);
  app.use("/api/*", originCheckMiddleware);
  app.all("/rpc/*", (context) => context.json({ reached: true }));
  app.all("/api/*", (context) => context.json({ reached: true }));
  app.all("/health", (context) => context.json({ reached: true }));
  return app;
}

function post(
  path: string,
  headers: Record<string, string>,
  env: WorkerBindings = bindings
) {
  return createApp().request(
    path,
    { body: "{}", headers, method: "POST" },
    env
  );
}

describe("origin check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["/rpc/category/create", "/api/products/x/media"])(
    "lets a same-origin mutation through on %s",
    async (path) => {
      const response = await post(path, {
        "content-type": "application/json",
        origin: baseURL,
      });

      expect(response.status).toBe(200);
    }
  );

  it("accepts a browser-vouched same-origin request that carries no Origin header", async () => {
    const response = await post("/rpc/category/create", {
      "sec-fetch-site": "same-origin",
    });

    expect(response.status).toBe(200);
  });

  it.each([
    ["a cross-origin page", { origin: "https://evil.example" }],
    ["a sibling subdomain", { origin: "https://app.polaris.example.invalid" }],
    ["a different scheme", { origin: "http://polaris.example.invalid" }],
    ["a different port", { origin: `${baseURL}:8443` }],
    ["an opaque origin", { origin: "null" }],
    [
      "a simple text/plain cross-site form post",
      { "content-type": "text/plain", origin: "https://evil.example" },
    ],
    ["a cross-site Fetch Metadata claim", { "sec-fetch-site": "cross-site" }],
    [
      "same-site (not same-origin) Fetch Metadata",
      { "sec-fetch-site": "same-site" },
    ],
    [
      "a foreign Origin even when Fetch Metadata claims same-origin",
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    ],
    ["no Origin and no Fetch Metadata", {}],
    [
      "a text/plain post without any origin signal",
      { "content-type": "text/plain" },
    ],
  ])("rejects %s with a generic 403", async (_name, headers) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await post("/rpc/category/create", headers);

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: { code: "forbidden" },
      requestId: expect.any(String),
    });
  });

  it("covers every unsafe method and none of the safe ones", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createApp();

    const statusFor = async (method: string) =>
      (await app.request("/api/x", { method }, bindings)).status;

    await expect(
      Promise.all(["POST", "PUT", "PATCH", "DELETE"].map(statusFor))
    ).resolves.toEqual([403, 403, 403, 403]);
    await expect(
      Promise.all(["GET", "HEAD", "OPTIONS"].map(statusFor))
    ).resolves.toEqual([200, 200, 200]);
  });

  it("leaves routes outside /rpc and /api alone", async () => {
    const response = await post("/health", {});

    expect(response.status).toBe(200);
  });

  it("fails closed when the application origin is not configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { BETTER_AUTH_BASE_URL: _unset, ...unconfigured } = bindings;

    const response = await post(
      "/rpc/category/create",
      { origin: baseURL },
      unconfigured
    );

    expect(response.status).toBe(403);
  });

  it("logs the rejection without echoing the offending origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await post("/rpc/category/create", { origin: "https://evil.example" });

    expect(warn).toHaveBeenCalledOnce();
    const [entry] = warn.mock.calls[0] ?? [];
    expect(entry).toMatchObject({
      event: "request_origin_rejected",
      originPresent: true,
      route: "/rpc/*",
    });
    expect(JSON.stringify(entry)).not.toContain("evil.example");
  });
});
