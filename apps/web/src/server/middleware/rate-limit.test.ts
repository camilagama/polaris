import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";
import {
  createRateLimitMiddleware,
  isMediaUploadRequest,
  isRpcMutationRequest,
  mediaUploadRateLimitMiddleware,
  rpcMutationRateLimitMiddleware,
} from "./rate-limit";
import { requestIdMiddleware } from "./request-id";

const secret = "a".repeat(32);
const sessionToken = "session-token-value.signature";
const clientAddress = "203.0.113.9";
const bucketKeyPattern = /^rpc-mutation-(?:ip|session):[0-9a-f]{64}$/;
const mediaKeyPattern = /^media-upload-ip:/;

function limiter(outcome: boolean | (() => Promise<{ success: boolean }>)) {
  return {
    limit: vi.fn(
      typeof outcome === "function"
        ? outcome
        : (_options: { key: string }) => Promise.resolve({ success: outcome })
    ),
  } satisfies RateLimitBinding;
}

function createApp(
  middleware = rpcMutationRateLimitMiddleware,
  path = "/rpc/*"
) {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.use(path, middleware);
  app.all("*", (context) => context.json({ reached: true }));
  return app;
}

function bindings(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    BETTER_AUTH_SECRET: secret,
    HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
    ...overrides,
  };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  env: WorkerBindings,
  headers: Record<string, string> = {}
) {
  return app.request(path, { headers, method: "POST" }, env);
}

describe("request classification", () => {
  it.each([
    ["POST", "/rpc/sale/confirm", true],
    ["POST", "/rpc/category/create", true],
    ["POST", "/rpc/inventory/receiveStock", true],
    ["POST", "/rpc/sale/list", false],
    ["POST", "/rpc/sale/get", false],
    ["POST", "/rpc/sale/getCustomerLink", false],
    ["POST", "/rpc/customer/findPossibleDuplicates", false],
    ["POST", "/rpc/system/ping", false],
    ["POST", "/rpc/product/getawayRename", true],
    ["POST", "/rpc/category/listing_cleanup", true],
    ["GET", "/rpc/sale/confirm", false],
  ])("%s %s counts as a mutation: %s", (method, path, expected) => {
    expect(
      isRpcMutationRequest(new Request(`https://x.invalid${path}`, { method }))
    ).toBe(expected);
  });

  it("only counts POST as a media upload", () => {
    const url = "https://x.invalid/api/products/p/media";

    expect(isMediaUploadRequest(new Request(url, { method: "POST" }))).toBe(
      true
    );
    expect(isMediaUploadRequest(new Request(url))).toBe(false);
  });
});

describe("rate limit middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets requests through while the limiter allows them", async () => {
    const binding = limiter(true);
    const response = await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: binding }),
      { "cf-connecting-ip": clientAddress }
    );

    expect(response.status).toBe(200);
    expect(binding.limit).toHaveBeenCalledOnce();
  });

  it("answers 429 with Retry-After once the limit is exhausted", async () => {
    const binding = limiter(false);
    const response = await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: binding }),
      { "cf-connecting-ip": clientAddress }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: { code: "rate_limited" },
      requestId: expect.any(String),
    });
  });

  it("keys on both the client address and the session without exposing either", async () => {
    const binding = limiter(true);
    await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: binding }),
      {
        "cf-connecting-ip": clientAddress,
        cookie: `theme=dark; __Secure-better-auth.session_token=${sessionToken}`,
      }
    );

    const keys = binding.limit.mock.calls.map(([options]) => options.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toMatch(bucketKeyPattern);
      expect(key).not.toContain(clientAddress);
      expect(key).not.toContain(sessionToken);
    }
  });

  it("gives each session its own bucket", async () => {
    const binding = limiter(true);
    const app = createApp();
    const env = bindings({ RPC_MUTATION_RATE_LIMIT: binding });
    await Promise.all(
      ["one", "two"].map((token) =>
        post(app, "/rpc/sale/confirm", env, {
          "cf-connecting-ip": clientAddress,
          cookie: `better-auth.session_token=${token}`,
        })
      )
    );

    const sessionKeys = binding.limit.mock.calls
      .map(([options]) => options.key)
      .filter((key) => key.startsWith("rpc-mutation-session"));
    expect(new Set(sessionKeys).size).toBe(2);
  });

  it("rejects when only the session bucket is exhausted", async () => {
    const binding = limiter(true);
    binding.limit.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ success: !key.startsWith("rpc-mutation-session") })
    );
    const response = await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: binding }),
      {
        "cf-connecting-ip": clientAddress,
        cookie: `better-auth.session_token=${sessionToken}`,
      }
    );

    expect(response.status).toBe(429);
  });

  it("does not limit reads or other paths", async () => {
    const binding = limiter(false);
    const app = createApp();
    const env = bindings({ RPC_MUTATION_RATE_LIMIT: binding });

    expect((await post(app, "/rpc/sale/list", env)).status).toBe(200);
    expect((await app.request("/rpc/sale/confirm", {}, env)).status).toBe(200);
    expect((await post(app, "/other", env)).status).toBe(200);
    expect(binding.limit).not.toHaveBeenCalled();
  });

  it("does not block when the binding is absent and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createApp(
      createRateLimitMiddleware({
        applies: () => true,
        binding: (env) => env.RPC_MUTATION_RATE_LIMIT,
        scope: "rpc-mutation",
      })
    );

    expect((await post(app, "/rpc/sale/confirm", bindings())).status).toBe(200);
    expect((await post(app, "/rpc/sale/confirm", bindings())).status).toBe(200);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({
      event: "rate_limit_binding_missing",
      scope: "rpc-mutation",
    });
  });

  it("fails open, with a payload-free error log, when the limiter itself fails", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const binding = limiter(() =>
      Promise.reject(new Error(`${clientAddress} boom`))
    );
    const response = await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: binding }),
      { "cf-connecting-ip": clientAddress }
    );

    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toContain(clientAddress);
  });

  it("limits media uploads on their own namespace and ignores media reads", async () => {
    const rpcBinding = limiter(true);
    const mediaBinding = limiter(false);
    const app = createApp(
      mediaUploadRateLimitMiddleware,
      "/api/products/:productId/media"
    );
    const env = bindings({
      MEDIA_UPLOAD_RATE_LIMIT: mediaBinding,
      RPC_MUTATION_RATE_LIMIT: rpcBinding,
    });

    const upload = await post(app, "/api/products/p1/media", env, {
      "cf-connecting-ip": clientAddress,
    });
    const list = await app.request("/api/products/p1/media", {}, env);

    expect(upload.status).toBe(429);
    expect(list.status).toBe(200);
    expect(mediaBinding.limit).toHaveBeenCalledOnce();
    expect(rpcBinding.limit).not.toHaveBeenCalled();
    expect(mediaBinding.limit.mock.calls[0]?.[0].key).toMatch(mediaKeyPattern);
  });
});
