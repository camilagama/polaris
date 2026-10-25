import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "../environment";
import { requestIdMiddleware } from "./request-id";
import { routeTimingMiddleware } from "./route-timing";

const requestId = "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createApp() {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.use("*", routeTimingMiddleware);
  app.post("/rpc/sale/confirm", (context) => context.json({ ok: true }));
  app.post("/rpc/category/create", (context) => context.json({ ok: true }));
  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/api/products/:productId/media", (context) =>
    context.json({ ok: true })
  );
  app.get("/api/auth/*", (context) => context.json({ ok: true }));
  app.post("/rpc/sync/push", (context) => context.json({ error: "bad" }, 409));
  app.post("/rpc/sync/pull", (context) => context.json({ error: "boom" }, 503));
  app.post("/rpc/sync/bootstrapPage", () => {
    throw new Error("unhandled");
  });
  return app;
}

function spyLogs() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  };
}

function timedEvents(logs: ReturnType<typeof spyLogs>) {
  return Object.values(logs)
    .flatMap((spy) => spy.mock.calls.map(([entry]) => entry))
    .filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { event?: string }).event === "http_request_timed"
    ) as Record<string, unknown>[];
}

describe("route timing middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one http_request_timed event for a critical oRPC route", async () => {
    const logs = spyLogs();

    const response = await createApp().request("/rpc/sale/confirm", {
      headers: { "X-Request-Id": requestId },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const events = timedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "http_request_timed",
      httpStatus: 200,
      method: "POST",
      outcome: "success",
      requestId,
      route: "/rpc/sale/confirm",
    });
    expect(events[0]?.durationMs).toEqual(expect.any(Number));
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["POST", "/health"],
    ["GET", "/health"],
    ["POST", "/rpc/category/create"],
  ])("emits nothing for the non-critical route %s %s", async (method, path) => {
    const logs = spyLogs();

    await createApp().request(path, { method });

    expect(timedEvents(logs)).toEqual([]);
  });

  it("labels a Hono route by its pattern and never carries the URL or query", async () => {
    const logs = spyLogs();

    await createApp().request(
      "/api/products/0199c2d0-0000-7000-8000-000000000001/media?token=abc123",
      {}
    );

    const events = timedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "GET",
      route: "/api/products/:productId/media",
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("0199c2d0");
    expect(serialized).not.toContain("abc123");
  });

  it("labels the auth wildcard route by its pattern", async () => {
    const logs = spyLogs();

    await createApp().request("/api/auth/get-session?token=abc123");

    const events = timedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ route: "/api/auth/*" });
    expect(JSON.stringify(events[0])).not.toContain("abc123");
  });

  it.each([
    ["/rpc/sync/push", 409, "rejected"],
    ["/rpc/sync/pull", 503, "failure"],
  ])("maps %s answering %i to outcome %s", async (path, status, outcome) => {
    const logs = spyLogs();

    await createApp().request(path, { method: "POST" });

    const events = timedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      httpStatus: status,
      outcome,
      route: path,
    });
  });

  it("still emits one event, as a failure, when the handler throws", async () => {
    const logs = spyLogs();

    const response = await createApp().request("/rpc/sync/bootstrapPage", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    const events = timedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      httpStatus: 500,
      outcome: "failure",
      route: "/rpc/sync/bootstrapPage",
    });
  });

  it("says which isolate answered and the place of the request in it, counting the requests it does not log", async () => {
    const logs = spyLogs();
    const app = createApp();

    await app.request("/api/auth/get-session");
    await app.request("/health");
    await app.request("/api/auth/get-session");

    const [first, second] = timedEvents(logs) as {
      isolate: { closedByUs: number; id: string; seq: number };
    }[];
    expect(first?.isolate).toEqual({
      closedByUs: expect.any(Number),
      id: expect.stringMatching(UUID),
      seq: expect.any(Number),
    });
    expect(second?.isolate.id).toBe(first?.isolate.id);
    // `/health` is not logged, but it is a request of the isolate
    expect(second?.isolate.seq).toBe((first?.isolate.seq ?? 0) + 2);
  });
});
