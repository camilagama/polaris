import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServerEnv } from "../environment";
import { requestIdMiddleware, runningRequestId } from "./request-id";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createApp() {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.get("/", (context) =>
    context.json({ requestId: context.get("requestId") })
  );
  return app;
}

async function requestWith(header?: string) {
  const response = await createApp().request("/", {
    headers: header === undefined ? {} : { "X-Request-Id": header },
  });
  const body = (await response.json()) as { requestId: string };
  return { body, header: response.headers.get("X-Request-Id") };
}

describe("request id middleware", () => {
  it("generates a UUID when the client sends nothing", async () => {
    const { body, header } = await requestWith();

    expect(body.requestId).toMatch(uuidPattern);
    expect(header).toBe(body.requestId);
  });

  it("keeps a well-formed client UUID", async () => {
    const supplied = "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e";
    const { body, header } = await requestWith(supplied);

    expect(body.requestId).toBe(supplied);
    expect(header).toBe(supplied);
  });

  it.each([
    "abc",
    "user@example.com",
    "not-a-uuid-but-looks-safe-1234567890",
    "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e-extra",
    "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e\n",
    "x".repeat(300),
  ])("replaces the arbitrary client value %j", async (supplied) => {
    const { body, header } = await requestWith(supplied);

    expect(body.requestId).toMatch(uuidPattern);
    expect(body.requestId).not.toBe(supplied);
    expect(header).toBe(body.requestId);
  });

  it("marks a Response a route builds itself, also one with immutable headers", async () => {
    const app = new Hono<ServerEnv>();
    app.use("*", requestIdMiddleware);
    app.get("/raw", () => new Response("null", { status: 401 }));
    app.get("/redirect", () => Response.redirect("https://example.invalid/x"));

    for (const path of ["/raw", "/redirect"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const response = await app.request(path);
      expect(response.headers.get("X-Request-Id")).toMatch(uuidPattern);
    }
  });

  it("tells the running request's identifier to code that only has the Request, and none outside", async () => {
    const app = new Hono<ServerEnv>();
    app.use("*", requestIdMiddleware);
    app.get("/", async (context) => {
      await Promise.resolve();
      return context.json({ running: runningRequestId() });
    });

    const response = await app.request("/");
    const body = (await response.json()) as { running: string };

    expect(body.running).toMatch(uuidPattern);
    expect(body.running).toBe(response.headers.get("X-Request-Id"));
    expect(runningRequestId()).toBeUndefined();
  });
});
