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

  describe("ROUTE_TIMING_ALL (staging only, ADR 0094)", () => {
    const nonCritical: [string, string][] = [
      ["POST", "/rpc/category/create"],
      ["POST", "/rpc/report/dailySales"],
      ["GET", "/api/products/0199c2d0-0000-7000-8000-000000000001/stats"],
    ];

    function createWideApp() {
      const app = createApp();
      app.post("/rpc/report/dailySales", (context) => context.json({ ok: true }));
      app.get("/api/products/:productId/stats", (context) =>
        context.json({ ok: true })
      );
      return app;
    }

    it.each([
      ["absent", {}],
      ["false", { ROUTE_TIMING_ALL: "false" }],
      ["TRUE", { ROUTE_TIMING_ALL: "TRUE" }],
      ["1", { ROUTE_TIMING_ALL: "1" }],
    ])("with the variable %s, logs the critical routes only, as before", async (_label, env) => {
      const logs = spyLogs();
      const app = createWideApp();

      for (const [method, path] of nonCritical) {
        await app.request(path, { method }, env);
      }
      await app.request("/health", {}, env);
      await app.request("/rpc/sale/confirm", { method: "POST" }, env);

      const events = timedEvents(logs);
      expect(events.map((event) => event.route)).toEqual(["/rpc/sale/confirm"]);
    });

    it("with true, logs every /rpc and /api request by its pattern, with the isolate, and still not /health", async () => {
      const logs = spyLogs();
      const app = createWideApp();
      const env = { ROUTE_TIMING_ALL: "true" };

      await app.request("/rpc/report/dailySales", { method: "POST" }, env);
      await app.request("/health", {}, env);
      await app.request("/rpc/category/create", { method: "POST" }, env);
      await app.request(
        "/api/products/0199c2d0-0000-7000-8000-000000000001/stats?token=abc123",
        {},
        env
      );
      await app.request("/rpc/sale/confirm", { method: "POST" }, env);

      const events = timedEvents(logs) as {
        isolate: { id: string; seq: number };
        route: string;
      }[];
      expect(events.map((event) => event.route)).toEqual([
        "/rpc/report/dailySales",
        "/rpc/category/create",
        "/api/products/:productId/stats",
        "/rpc/sale/confirm",
      ]);
      expect(events[0]).toMatchObject({
        event: "http_request_timed",
        httpStatus: 200,
        method: "POST",
        outcome: "success",
      });
      expect(events[0]?.isolate.id).toMatch(UUID);
      // `/health` is counted, not logged
      expect(events[1]?.isolate.seq).toBe((events[0]?.isolate.seq ?? 0) + 2);
      expect(events[1]?.isolate.id).toBe(events[0]?.isolate.id);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("0199c2d0");
      expect(serialized).not.toContain("abc123");
    });

    it("with true, labels a /rpc path that is not a procedure name, or an unknown /api path, without the URL", async () => {
      const logs = spyLogs();
      const app = createWideApp();
      const env = { ROUTE_TIMING_ALL: "true" };

      await app.request("/rpc/report/pessoa@example.test", { method: "POST" }, env);
      await app.request("/rpc/a/b/c/d/e", { method: "POST" }, env);
      await app.request("/api/nao-existe/0199c2d0", {}, env);

      const events = timedEvents(logs);
      expect(events.map((event) => [event.route, event.httpStatus])).toEqual([
        ["/rpc/*", 404],
        ["/rpc/*", 404],
        [expect.not.stringContaining("0199c2d0"), 404],
      ]);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("pessoa@");
      expect(serialized).not.toContain("nao-existe");
    });
  });
});
