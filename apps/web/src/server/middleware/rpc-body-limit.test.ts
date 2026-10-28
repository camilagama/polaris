import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyResponse } from "../../lib/connection";
import { isPayloadTooLarge } from "../../lib/rpc-error";
import { createServerApp } from "../app";
import type { RateLimitBinding, WorkerBindings } from "../environment";
import { createRpcRouter } from "../rpc/router";
import { RPC_BODY_MAX_BYTES } from "./rpc-body-limit";

const baseURL = "https://polaris.example.invalid";
const KIB = 1024;

function bindings(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: "a".repeat(32),
    HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
    ...overrides,
  };
}

function setup(env: WorkerBindings = bindings()) {
  const reached = vi.fn(() => Promise.resolve({ categories: [] }));
  const app = createServerApp({
    rpcRouter: createRpcRouter({ withTenantRequestContext: reached as never }),
  });
  const post = (
    body: BodyInit | null,
    headers: Record<string, string> = {},
    path = "/rpc/category/create"
  ) =>
    app.request(
      path,
      {
        body,
        duplex: "half",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
          origin: baseURL,
          ...headers,
        },
        method: "POST",
      } as RequestInit,
      env
    );
  return { app, post, reached };
}

/** A valid RPC call of exactly `bytes` bytes: the procedure ignores the padding key. */
function callOfSize(bytes: number): string {
  const frame = JSON.stringify({
    json: { name: "x", organizationId: "o", pad: "" },
  });
  return JSON.stringify({
    json: {
      name: "x",
      organizationId: "o",
      pad: "a".repeat(bytes - frame.length),
    },
  });
}

/** The body in chunks, as a client without `Content-Length` sends it; `pulled` counts what was read. */
function chunked(total: number, chunk = 32 * KIB) {
  const state = { cancelled: false, pulled: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - sent);
      sent += size;
      state.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
  });
  return { state, stream };
}

/** What an answer of the limit may say: never the ceiling, in any spelling. */
const CEILING_SPELLINGS = /524[ .,]?288|512\s?(?:KiB|KB|k)|\b512\b/i;

async function expectFixedRefusal(
  response: Response,
  status: number,
  code: string
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    error: { code },
    requestId: expect.any(String),
  });
  expect(text).not.toMatch(CEILING_SPELLINGS);
  expect(JSON.stringify([...response.headers])).not.toMatch(CEILING_SPELLINGS);
}

describe("the body ceiling of /rpc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses ceiling + 1 declared by Content-Length without reaching the procedure or reading the body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post, reached } = setup();
    const { state, stream } = chunked(RPC_BODY_MAX_BYTES + 1);

    const response = await post(stream, {
      "content-length": String(RPC_BODY_MAX_BYTES + 1),
    });

    await expectFixedRefusal(response, 413, "payload_too_large");
    expect(reached).not.toHaveBeenCalled();
    expect(state.pulled).toBeLessThan(RPC_BODY_MAX_BYTES);
    expect(state.cancelled).toBe(true);
  });

  it("accepts a body of exactly the ceiling, declared and read to the end", async () => {
    const { post, reached } = setup();
    const body = callOfSize(RPC_BODY_MAX_BYTES);
    expect(new TextEncoder().encode(body).length).toBe(RPC_BODY_MAX_BYTES);

    const response = await post(body, {
      "content-length": String(RPC_BODY_MAX_BYTES),
    });

    expect(response.status).not.toBe(413);
    expect(reached).toHaveBeenCalledOnce();
  });

  it("cuts a body in chunks without Content-Length at ceiling + 1, reading no further", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post, reached } = setup();
    const { state, stream } = chunked(8 * RPC_BODY_MAX_BYTES);

    const response = await post(stream);

    await expectFixedRefusal(response, 413, "payload_too_large");
    expect(reached).not.toHaveBeenCalled();
    expect(state.cancelled).toBe(true);
    // the read stopped near the ceiling, not at the end of 4 MiB
    expect(state.pulled).toBeLessThan(RPC_BODY_MAX_BYTES + 256 * KIB);
  });

  it("cuts a body that is larger than the small Content-Length it declares", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post, reached } = setup();
    const { state, stream } = chunked(RPC_BODY_MAX_BYTES + 1);

    const response = await post(stream, { "content-length": "10" });

    await expectFixedRefusal(response, 413, "payload_too_large");
    expect(reached).not.toHaveBeenCalled();
    expect(state.pulled).toBeLessThan(RPC_BODY_MAX_BYTES + 256 * KIB);
  });

  it("lets a body that stays within the ceiling through to the procedure", async () => {
    const { post, reached } = setup();

    const response = await post(callOfSize(2 * KIB));

    expect(response.status).not.toBe(413);
    expect(reached).toHaveBeenCalledOnce();
  });

  it.each([
    "abc",
    "10, 10",
    "-1",
    "1e3",
    "0x10",
    "1.5",
    " ",
    "",
    "99999999999999999999",
  ])("refuses the invalid Content-Length %j, never as zero", async (value) => {
    const { post, reached } = setup();

    const response = await post(callOfSize(KIB), { "content-length": value });

    await expectFixedRefusal(response, 400, "invalid_content_length");
    expect(reached).not.toHaveBeenCalled();
  });

  it.each([
    "gzip",
    "GZIP",
    "br",
    "deflate",
    "gzip, identity",
    "identity, gzip",
  ])(
    "answers 415 to Content-Encoding %j before the procedure",
    async (encoding) => {
      const { post, reached } = setup();

      const response = await post(callOfSize(KIB), {
        "content-encoding": encoding,
      });

      await expectFixedRefusal(response, 415, "unsupported_content_encoding");
      expect(reached).not.toHaveBeenCalled();
    }
  );

  it.each(["identity", "Identity "])(
    "takes Content-Encoding %j as no encoding",
    async (encoding) => {
      const { post, reached } = setup();

      const response = await post(callOfSize(KIB), {
        "content-encoding": encoding,
      });

      expect(response.status).not.toBe(415);
      expect(reached).toHaveBeenCalledOnce();
    }
  );

  it("does not decompress: a gzip body is refused whole, whatever its size", async () => {
    const { post, reached } = setup();
    const compressed = new Blob([callOfSize(KIB)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));

    const response = await post(compressed, { "content-encoding": "gzip" });

    expect(response.status).toBe(415);
    expect(reached).not.toHaveBeenCalled();
  });

  it("leaves a call without a body, and a GET, to the handler", async () => {
    const { app, post } = setup();

    const empty = await post(null);
    const read = await app.request(
      "/rpc/category/list",
      {
        headers: {
          "content-length": String(RPC_BODY_MAX_BYTES + 1),
          origin: baseURL,
        },
        method: "GET",
      },
      bindings()
    );

    expect([413, 415]).not.toContain(empty.status);
    expect(await empty.text()).not.toContain("invalid_content_length");
    // the handler's own refusal of a GET (it runs no procedure), not the ceiling's
    expect(read.status).toBe(405);
  });

  it("logs one line per 413 with the route and a band of the declared size, never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post } = setup();

    await post(callOfSize(KIB).padEnd(RPC_BODY_MAX_BYTES + 10, " "), {
      "content-length": String(3 * 1024 * KIB),
    });
    await post(
      chunked(RPC_BODY_MAX_BYTES + 1).stream,
      {},
      "/rpc/product/create"
    );
    await post(
      callOfSize(KIB),
      { "content-length": String(RPC_BODY_MAX_BYTES + 1) },
      "/rpc/nao/existe"
    );

    const lines = warn.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "rpc_payload_too_large");
    expect(lines).toEqual([
      expect.objectContaining({
        cut: "declared",
        declared: "up_to_8MiB",
        route: "/rpc/category/create",
      }),
      expect.objectContaining({
        cut: "stream",
        declared: "absent",
        route: "/rpc/product/create",
      }),
      expect.objectContaining({
        cut: "declared",
        declared: "up_to_1MiB",
        route: "/rpc/<unknown>",
      }),
    ]);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("organizationId");
    expect(serialized).not.toMatch(CEILING_SPELLINGS);
  });

  it("does not log the cut of a body as a server fault", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { post } = setup();

    const response = await post(chunked(RPC_BODY_MAX_BYTES + 1).stream);

    expect(response.status).toBe(413);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("the ceiling and the rate limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts the 413 in the bucket of the procedure's kind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const limiter: RateLimitBinding = {
      limit: vi.fn(() => Promise.resolve({ success: true })),
    };
    const { post, reached } = setup(
      bindings({ RPC_MUTATION_RATE_LIMIT: limiter })
    );

    const response = await post(callOfSize(KIB), {
      "content-length": String(RPC_BODY_MAX_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(reached).not.toHaveBeenCalled();
    // the address and the session cookie are not both present: one key, one count
    expect(limiter.limit).toHaveBeenCalledOnce();
  });

  it("answers 429 to the oversized call that finds the bucket empty: the limit runs first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const limiter: RateLimitBinding = {
      limit: vi.fn(() => Promise.resolve({ success: false })),
    };
    const { post } = setup(bindings({ RPC_MUTATION_RATE_LIMIT: limiter }));

    const response = await post(callOfSize(KIB), {
      "content-length": String(RPC_BODY_MAX_BYTES + 1),
    });

    expect(response.status).toBe(429);
  });

  it("does not run for a request the origin check refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn");
    const { post } = setup();

    const response = await post(callOfSize(KIB), {
      "content-length": String(RPC_BODY_MAX_BYTES + 1),
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(
      warn.mock.calls.some(
        ([entry]) =>
          (entry as { event?: string }).event === "rpc_payload_too_large"
      )
    ).toBe(false);
  });
});

describe("the 413 as the client sees it", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the Worker's mark, so it is an answer and not a failure of the server", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post } = setup();

    const response = await post(callOfSize(KIB), {
      "content-length": String(RPC_BODY_MAX_BYTES + 1),
    });

    expect(classifyResponse(response)).toBe("worker");
  });

  it("reaches the oRPC client as PAYLOAD_TOO_LARGE, which the sync reads as a batch to split", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = setup();
    const client = createORPCClient(
      new RPCLink({
        fetch: (request) => Promise.resolve(app.fetch(request, bindings())),
        headers: { origin: baseURL },
        method: "POST",
        url: new URL("/rpc", baseURL),
      })
    ) as unknown as {
      category: { create: (input: unknown) => Promise<unknown> };
    };

    const failure = await client.category
      .create({
        name: "x".repeat(RPC_BODY_MAX_BYTES + 1),
        organizationId: "o",
      })
      .catch((error: unknown) => error);

    expect(isPayloadTooLarge(failure)).toBe(true);
    expect(failure).toMatchObject({ status: 413 });
  });
});
