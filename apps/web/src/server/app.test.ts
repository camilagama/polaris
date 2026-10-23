import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "./app";
import type { RateLimitBinding, WorkerBindings } from "./environment";
import { TenantRequestContextError } from "./request-context-error";
import { createRpcRouter } from "./rpc/router";

const baseURL = "https://polaris.example.invalid";
const secret = "a".repeat(32);

function createBindings(overrides: Partial<WorkerBindings> = {}) {
  return {
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: secret,
    HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
    ...overrides,
  } satisfies WorkerBindings;
}

function createRpcClient(
  router: ReturnType<typeof createRpcRouter>,
  bindings = createBindings(),
  headers: Record<string, string> = { origin: baseURL }
) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, bindings)),
    headers,
    method: "POST",
    url: new URL("/rpc", baseURL),
  });

  return createORPCClient(link) as unknown as {
    category: { create: (input: unknown) => Promise<unknown> };
  };
}

describe("RPC request guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a text/plain cross-site post before it reaches any procedure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tenantRequest = vi.fn();
    const app = createServerApp({
      rpcRouter: createRpcRouter({
        withTenantRequestContext: tenantRequest as never,
      }),
    });

    const response = await app.request(
      "/rpc/category/create",
      {
        body: JSON.stringify({ json: { name: "x", organizationId: "o" } }),
        headers: {
          "content-type": "text/plain",
          origin: "https://evil.example",
        },
        method: "POST",
      },
      createBindings()
    );

    expect(response.status).toBe(403);
    expect(tenantRequest).not.toHaveBeenCalled();
  });

  it("rejects a mutation that carries no Origin at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tenantRequest = vi.fn();
    const client = createRpcClient(
      createRpcRouter({ withTenantRequestContext: tenantRequest }),
      createBindings(),
      {}
    );

    await expect(
      client.category.create({ name: "x", organizationId: "o" })
    ).rejects.toMatchObject({ status: 403 });
    expect(tenantRequest).not.toHaveBeenCalled();
  });

  it("logs a structured server fault for a failing procedure without leaking its message", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error("insert failed for customer ana@example.com"),
      { code: "57014", name: "DatabaseError" }
    );
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () => Promise.reject(failure),
      })
    );

    await expect(
      client.category.create({ name: "Camisas", organizationId: "org-1" })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(logger).toHaveBeenCalledOnce();
    const [entry] = logger.mock.calls[0] ?? [];
    expect(entry).toMatchObject({
      errorCode: "57014",
      errorClass: "DatabaseError",
      event: "server_error",
      route: "/rpc/category/create",
      httpStatus: 500,
    });
    const serialized = JSON.stringify(entry);
    for (const secretValue of [
      "ana@example.com",
      "Camisas",
      "org-1",
      "stack",
    ]) {
      expect(serialized).not.toContain(secretValue);
    }
  });

  it("logs infrastructure unavailability (503) but not expected client failures", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const unavailable = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () =>
          Promise.reject(
            new TenantRequestContextError("authentication_unavailable")
          ),
      })
    );
    const unauthenticated = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () =>
          Promise.reject(new TenantRequestContextError("session_required")),
      })
    );

    await expect(
      unavailable.category.create({ name: "x", organizationId: "o" })
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      unauthenticated.category.create({ name: "x", organizationId: "o" })
    ).rejects.toMatchObject({ status: 401 });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]?.[0]).toMatchObject({
      causes: [
        {
          errorClass: "TenantRequestContextError",
          errorCode: "authentication_unavailable",
        },
      ],
      errorCode: "SERVICE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("logs unhandled route errors with the route pattern and a generic response", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const app = createServerApp({
      authHandler: () =>
        Promise.reject(new Error("token=abc123 for bob@example.com")),
    });

    const response = await app.request(
      "/api/auth/get-session?token=abc123",
      {},
      createBindings()
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "internal_error" },
    });
    expect(text).not.toContain("bob@example.com");
    // /api/auth/* is a critical route: besides server_error it emits one http_request_timed
    const [serverError, ...otherErrors] = logger.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.event === "server_error");
    expect(otherErrors).toEqual([]);
    expect(logger.mock.calls.map(([entry]) => entry.event).sort()).toEqual([
      "http_request_timed",
      "server_error",
    ]);
    const serialized = JSON.stringify(serverError);
    expect(serverError).toMatchObject({
      errorClass: "Error",
      event: "server_error",
      method: "GET",
      route: "/api/auth/*",
      httpStatus: 500,
    });
    for (const secretValue of ["abc123", "bob@example.com", "stack"]) {
      expect(serialized).not.toContain(secretValue);
    }
  });
});

describe("rate limit wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits RPC mutations per client but not RPC reads", async () => {
    const limiter: RateLimitBinding = {
      limit: vi.fn(() => Promise.resolve({ success: false })),
    };
    const tenantRequest = vi.fn(() => Promise.resolve({ categories: [] }));
    const app = createServerApp({
      rpcRouter: createRpcRouter({
        withTenantRequestContext: tenantRequest as never,
      }),
    });
    const bindings = createBindings({ RPC_MUTATION_RATE_LIMIT: limiter });
    const request = (path: string) =>
      app.request(
        path,
        {
          body: JSON.stringify({
            json: { organizationId: "org-1", name: "x" },
          }),
          headers: {
            "cf-connecting-ip": "203.0.113.9",
            "content-type": "application/json",
            origin: baseURL,
          },
          method: "POST",
        },
        bindings
      );

    const mutation = await request("/rpc/category/create");
    const read = await request("/rpc/category/list");

    expect(mutation.status).toBe(429);
    expect(read.status).not.toBe(429);
    expect(limiter.limit).toHaveBeenCalledOnce();
  });
});

// The client takes a response for the Worker's only by this mark (emenda do ADR 0043): every answer has it,
// the unhandled error, the not-found, the raw answer of a route and the one of the RPC handler too.
describe("the Worker's mark on every response", () => {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is on the 500 of onError, the 404, the health check, a raw Response and an RPC answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failing = createServerApp({
      authHandler: () => Promise.reject(new Error("boom")),
    });
    const raw = createServerApp({
      authHandler: () =>
        Promise.resolve(new Response("null", { status: 401 })),
    });
    const responses = [
      await failing.request("/api/auth/get-session", {}, createBindings()),
      await failing.request("/nada-aqui", {}, createBindings()),
      await failing.request("/health", {}, createBindings()),
      await raw.request("/api/auth/get-session", {}, createBindings()),
      await failing.request(
        "/rpc/category/list",
        {
          body: JSON.stringify({ json: { organizationId: "o" } }),
          headers: { "content-type": "application/json", origin: baseURL },
          method: "POST",
        },
        createBindings()
      ),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      500,
      404,
      200,
      401,
      expect.any(Number),
    ]);
    expect(
      responses.map((response) =>
        uuidPattern.test(response.headers.get("x-request-id") ?? "")
      )
    ).toEqual([true, true, true, true, true]);
  });
});
