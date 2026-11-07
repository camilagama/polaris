import { readFileSync } from "node:fs";
import type { ClientErrorEvent } from "@polaris/contracts/client-error-fields";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createClientErrorLog } from "../observability/client-error-log";
import { clientErrorSignature } from "./client-errors";

const baseURL = "https://polaris.example.invalid";
const PATH = "/api/client-errors";
const KIB = 1024;
const MAX_BYTES = 2 * KIB;
const CLIENT_ADDRESS = "203.0.113.9";
const MINUTE_MS = 60_000;
const SIGNATURE = /^[0-9a-f]{16}$/;
const LIMITER_KEY = /^client-error-ip:[0-9a-f]{64}$/;

/** The keys evlog puts on every line; the rest is what the route chose to log. */
const EVLOG_KEYS = new Set([
  "commitHash",
  "environment",
  "event",
  "level",
  "region",
  "service",
  "timestamp",
  "version",
]);

const validEvent = {
  errorName: "TypeError",
  frames: ["sale-form-model-AAAAAAAA.js:10:5"],
  kind: "error",
  release: "abcdef1",
  routeId: "sale",
  v: 1,
} as const;

const fullEvent = {
  ...validEvent,
  boundary: "screen",
  code: "INTERNAL_SERVER_ERROR",
  status: 503,
} as const;

function spyLogs() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  };
}

type Logs = ReturnType<typeof spyLogs>;

/** Every line written through any console method, as the objects the logger passed. */
function lines(logs: Logs): Record<string, unknown>[] {
  return Object.values(logs).flatMap((spy) =>
    spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
  );
}

function linesOf(logs: Logs, event: string) {
  return lines(logs).filter((line) => line.event === event);
}

function limiter(initial = true) {
  const state = { success: initial };
  const binding = {
    limit: vi.fn((_options: { key: string }) =>
      Promise.resolve({ success: state.success })
    ),
  };
  return { binding, state };
}

function setup(
  overrides: {
    [K in keyof WorkerBindings]?: WorkerBindings[K] | undefined;
  } = {},
  { limiterSuccess = true }: { limiterSuccess?: boolean } = {}
) {
  const clock = { now: Date.UTC(2026, 9, 28, 12, 0, 10) };
  const log = createClientErrorLog(() => clock.now);
  const rateLimit = limiter(limiterSuccess);
  const env = {
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: "a".repeat(32),
    CLIENT_ERROR_RATE_LIMIT: rateLimit.binding,
    CLIENT_ERRORS_ENABLED: "1",
    ...overrides,
  } as WorkerBindings;
  const app = createServerApp({ clientErrorRoutes: { log } });
  const post = (
    body: BodyInit | null,
    headers: Record<string, string> = {},
    path = PATH
  ) =>
    app.request(
      path,
      {
        body,
        duplex: "half",
        headers: {
          "cf-connecting-ip": CLIENT_ADDRESS,
          "content-type": "application/json",
          origin: baseURL,
          ...headers,
        },
        method: "POST",
      } as RequestInit,
      env
    );
  const send = (event: unknown = validEvent, headers = {}) =>
    post(JSON.stringify(event), headers);
  const nextMinute = () => {
    clock.now += MINUTE_MS;
  };
  return { clock, nextMinute, post, rateLimit, send };
}

/** The body in chunks, as a client without `Content-Length` sends it; `pulled` counts what was read. */
function chunked(total: number, chunk = 512) {
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

function padded(event: unknown, bytes: number): string {
  const text = JSON.stringify(event);
  return text.padEnd(bytes, " ");
}

describe("POST /api/client-errors: the accepted event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("answers 204 with an empty body and logs one client_error line with the closed fields only", async () => {
    const logs = spyLogs();
    const { send } = setup();

    const response = await send(fullEvent, {
      cookie: "better-auth.session_token=cookie-secret-value",
      "user-agent": "UA-Marker/9.9",
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const found = linesOf(logs, "client_error");
    expect(found).toHaveLength(1);
    const [line] = found as [Record<string, unknown>];
    expect(
      Object.keys(line)
        .filter((key) => !EVLOG_KEYS.has(key))
        .sort()
    ).toEqual([
      "boundary",
      "errorClass",
      "errorCode",
      "fingerprint",
      "frames",
      "kind",
      "release",
      "routeId",
      "rpcStatus",
      "v",
    ]);
    expect(line).toMatchObject({
      boundary: "screen",
      errorClass: "TypeError",
      errorCode: "INTERNAL_SERVER_ERROR",
      frames: ["sale-form-model-AAAAAAAA.js@10:5"],
      kind: "error",
      level: "warn",
      release: "abcdef1",
      routeId: "sale",
      rpcStatus: 503,
      v: 1,
    });
    const serialized = JSON.stringify(lines(logs));
    expect(serialized).not.toContain(CLIENT_ADDRESS);
    expect(serialized).not.toContain("UA-Marker");
    expect(serialized).not.toContain("cookie-secret-value");
    expect(serialized).not.toContain("session_token");
  });

  it("leaves the optional fields out of the line when the event omits them", async () => {
    const logs = spyLogs();
    const { send } = setup();

    const response = await send({
      errorName: "Error",
      kind: "boundary",
      routeId: "home",
      v: 1,
    });

    expect(response.status).toBe(204);
    const [line] = linesOf(logs, "client_error") as [Record<string, unknown>];
    expect(
      Object.keys(line)
        .filter((key) => !EVLOG_KEYS.has(key))
        .sort()
    ).toEqual(["errorClass", "fingerprint", "kind", "routeId", "v"]);
  });

  it("writes the signature of the failure as fingerprint, 16 hex characters, on the line", async () => {
    const logs = spyLogs();
    const { send } = setup();

    await send();

    const [line] = linesOf(logs, "client_error") as [Record<string, unknown>];
    expect(line.fingerprint).toMatch(SIGNATURE);
  });
});

describe("POST /api/client-errors: hostile events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a valid event plus one extra key with 400 and logs no client_error line", async () => {
    const logs = spyLogs();
    const { send } = setup();

    const response = await send({ ...validEvent, extra: 1 });

    expect(response.status).toBe(400);
    expect(linesOf(logs, "client_error")).toEqual([]);
  });

  it("refuses a body that is not a flat event (nested object, long list, too many keys) before the redaction net", async () => {
    const logs = spyLogs();
    const { nextMinute, send } = setup();
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`k${index}`, index])
    );

    const statuses = [
      (await send({ ...validEvent, nested: { a: "maria@example.com" } }))
        .status,
      (await send({ ...validEvent, frames: ["a", "b", "c", "d"] })).status,
      (await send(many)).status,
      (await send(["maria@example.com"])).status,
    ];

    expect(statuses).toEqual([400, 400, 400, 400]);
    nextMinute();
    await send(validEvent);
    expect(linesOf(logs, "client_error_pii_suspected")).toEqual([]);
    expect(linesOf(logs, "client_error_refused")[0]).toMatchObject({
      bad_request: 4,
    });
  });

  it("takes a frame of a piece named after a secret word (change-password-page) and logs it whole", async () => {
    const logs = spyLogs();
    const { send } = setup();

    const response = await send({
      ...validEvent,
      frames: [
        "change-password-page-AbCdEfGh.js:10:20",
        "index-sidAbCdE.js:1:2",
      ],
    });

    expect(response.status).toBe(204);
    const [line] = linesOf(logs, "client_error") as [Record<string, unknown>];
    expect(line.frames).toEqual([
      "change-password-page-AbCdEfGh.js@10:20",
      "index-sidAbCdE.js@1:2",
    ]);
  });

  it.each([
    "organizationId",
    "userId",
    "sessionId",
    "deviceId",
    "user",
    "session",
  ])(
    "refuses the key %s with 400 and logs no client_error line",
    async (key) => {
      const logs = spyLogs();
      const { send } = setup();

      const response = await send({ ...validEvent, [key]: "x" });

      expect(response.status).toBe(400);
      expect(linesOf(logs, "client_error")).toEqual([]);
    }
  );

  it.each([
    [
      "an e-mail in a known field",
      { ...validEvent, routeId: "maria@example.com" },
    ],
    ["an e-mail in an extra key", { ...validEvent, note: "maria@example.com" }],
    ["an e-mail as a key", { ...validEvent, "maria@example.com": 1 }],
    ["a path with a query", { ...validEvent, routeId: "/vendas?id=1" }],
    [
      "a URL with a query",
      { ...validEvent, note: "https://x.example/?token=a" },
    ],
  ])(
    "discards %s with 400 and counts it once in the next minute",
    async (_label, event) => {
      const logs = spyLogs();
      const { nextMinute, send } = setup();

      const response = await send(event);

      expect(response.status).toBe(400);
      expect(lines(logs)).toEqual([]);

      nextMinute();
      const next = await send(validEvent);

      expect(next.status).toBe(204);
      const found = linesOf(logs, "client_error_pii_suspected");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ count: 1 });
      expect(JSON.stringify(lines(logs))).not.toContain("maria");
      expect(JSON.stringify(lines(logs))).not.toContain("token=a");
      expect(linesOf(logs, "client_error")).toHaveLength(1);
    }
  );

  it("refuses a body that is not JSON with 400", async () => {
    const logs = spyLogs();
    const { post } = setup();

    const response = await post("{not json");

    expect(response.status).toBe(400);
    expect(linesOf(logs, "client_error")).toEqual([]);
  });
});

describe("POST /api/client-errors: the size of the body", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 413 to 2 KiB + 1 declared by Content-Length without reading the body", async () => {
    spyLogs();
    const { post } = setup();
    const { state, stream } = chunked(MAX_BYTES + 1);

    const response = await post(stream, {
      "content-length": String(MAX_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThan(MAX_BYTES);
    expect(state.cancelled).toBe(true);
  });

  it("answers 413 to 2049 bytes streamed without Content-Length, reading no further", async () => {
    spyLogs();
    const { post } = setup();
    const { state, stream } = chunked(8 * MAX_BYTES);

    const response = await post(stream);

    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(MAX_BYTES + 4 * KIB);
  });

  it("answers 413 to exactly 2049 bytes streamed without Content-Length", async () => {
    spyLogs();
    const { post } = setup();

    const response = await post(chunked(MAX_BYTES + 1).stream);

    expect(response.status).toBe(413);
  });

  it("does not answer 413 to a body of exactly 2048 bytes", async () => {
    const logs = spyLogs();
    const { post } = setup();
    const body = padded(validEvent, MAX_BYTES);
    expect(new TextEncoder().encode(body).length).toBe(MAX_BYTES);

    const response = await post(body, {
      "content-length": String(MAX_BYTES),
    });

    expect(response.status).toBe(204);
    expect(linesOf(logs, "client_error")).toHaveLength(1);
  });

  it("answers 415 to a Content-Encoding other than identity", async () => {
    spyLogs();
    const { send } = setup();

    const response = await send(validEvent, { "content-encoding": "gzip" });

    expect(response.status).toBe(415);
  });

  it.each([
    "text/plain",
    "application/json; charset=utf-8",
    "application/x-www-form-urlencoded",
  ])("answers 415 to the Content-Type %j", async (contentType) => {
    spyLogs();
    const { send } = setup();

    const response = await send(validEvent, { "content-type": contentType });

    expect(response.status).toBe(415);
  });

  it.each([`${PATH}?x=1`, `${PATH}?`])(
    "answers 400 to the address %s",
    async (path) => {
      const logs = spyLogs();
      const { post } = setup();

      const response = await post(JSON.stringify(validEvent), {}, path);

      expect(response.status).toBe(400);
      expect(linesOf(logs, "client_error")).toEqual([]);
    }
  );
});

describe("POST /api/client-errors: the rate limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 429 with Retry-After 60 when the limiter denies, and logs no event", async () => {
    const logs = spyLogs();
    const { send } = setup({}, { limiterSuccess: false });

    const response = await send();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(linesOf(logs, "client_error")).toEqual([]);
  });

  it("keys the limiter by an HMAC of the address, called once, never reading the session cookie", async () => {
    spyLogs();
    const { rateLimit, send } = setup();

    await send(validEvent, {
      cookie: "better-auth.session_token=cookie-secret-value",
    });

    expect(rateLimit.binding.limit).toHaveBeenCalledOnce();
    const { key } = rateLimit.binding.limit.mock.calls[0]?.[0] ?? { key: "" };
    expect(key).toMatch(LIMITER_KEY);
    expect(key).not.toContain(CLIENT_ADDRESS);
    expect(key).not.toContain("cookie-secret-value");
  });

  it("does not call the limiter for a request refused by its shape", async () => {
    spyLogs();
    const { rateLimit, send } = setup();

    await send(validEvent, { "content-type": "text/plain" });

    expect(rateLimit.binding.limit).not.toHaveBeenCalled();
  });
});

describe("POST /api/client-errors: refusals are counted, never logged one by one", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes zero lines for 25 requests of each refusal, then one client_error_refused line with the counts", async () => {
    const logs = spyLogs();
    const { nextMinute, post, rateLimit, send } = setup({
      ROUTE_TIMING_ALL: "true",
    });
    const oversized = () =>
      post(chunked(MAX_BYTES + 1).stream, {
        "content-length": String(MAX_BYTES + 1),
      });
    const burst = async (attempt: () => Promise<Response> | Response) =>
      (await Promise.all(Array.from({ length: 25 }, attempt))).map(
        (response) => response.status
      );

    rateLimit.state.success = false;
    const denied = await burst(() => send());
    rateLimit.state.success = true;
    const withQuery = await burst(() =>
      post(JSON.stringify(validEvent), {}, `${PATH}?x=1`)
    );
    const tooLarge = await burst(oversized);
    const wrongType = await burst(() =>
      send(validEvent, { "content-type": "text/plain" })
    );

    expect(new Set(denied)).toEqual(new Set([429]));
    expect(new Set(withQuery)).toEqual(new Set([400]));
    expect(new Set(tooLarge)).toEqual(new Set([413]));
    expect(new Set(wrongType)).toEqual(new Set([415]));
    expect(lines(logs)).toEqual([]);

    nextMinute();
    await send(validEvent, { "content-type": "text/plain" });

    const found = lines(logs);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      bad_request: 25,
      event: "client_error_refused",
      rate_limited: 25,
      too_large: 25,
      unsupported: 25,
    });
    expect(found[0]).not.toHaveProperty("limiter_unavailable");
  });

  it("never logs rate_limited, rpc_payload_too_large or http_request_timed for a refusal", async () => {
    const logs = spyLogs();
    const { rateLimit, send } = setup({ ROUTE_TIMING_ALL: "true" });

    rateLimit.state.success = false;
    await send();
    rateLimit.state.success = true;
    await send(validEvent, { "content-encoding": "gzip" });

    const names = lines(logs).map((line) => line.event);
    expect(names).not.toContain("rate_limited");
    expect(names).not.toContain("rpc_payload_too_large");
    expect(names).not.toContain("http_request_timed");
    expect(names).toEqual([]);
  });

  it("counts a limiter that throws as unavailable and lets the event through", async () => {
    const logs = spyLogs();
    const { nextMinute, rateLimit, send } = setup();
    rateLimit.binding.limit.mockRejectedValueOnce(new Error("down"));

    const response = await send();

    expect(response.status).toBe(204);
    nextMinute();
    await send();
    expect(linesOf(logs, "client_error_refused")[0]).toMatchObject({
      limiter_unavailable: 1,
    });
  });
});

describe("POST /api/client-errors: the switch CLIENT_ERRORS_ENABLED", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["absent", undefined],
    ["0", "0"],
    ["true", "true"],
  ])(
    "with the variable %s, answers 204 and logs nothing, even for a bad origin and a body over 2 KiB",
    async (_label, value) => {
      const logs = spyLogs();
      const { nextMinute, post, rateLimit } = setup({
        CLIENT_ERRORS_ENABLED: value,
        ROUTE_TIMING_ALL: "true",
      });

      const bad = await post(JSON.stringify(validEvent), {
        origin: "https://evil.example",
      });
      const big = await post(padded(validEvent, 3 * KIB), {
        "content-length": String(3 * KIB),
      });
      const streamed = await post(chunked(8 * MAX_BYTES).stream, {
        "content-type": "text/plain",
      });
      nextMinute();
      const later = await post(JSON.stringify(validEvent));

      expect([bad, big, streamed, later].map((r) => r.status)).toEqual([
        204, 204, 204, 204,
      ]);
      expect(await later.text()).toBe("");
      expect(lines(logs)).toEqual([]);
      expect(rateLimit.binding.limit).not.toHaveBeenCalled();
    }
  );

  it("with 1, still refuses a wrong Origin with 403", async () => {
    spyLogs();
    const { send } = setup();

    const response = await send(validEvent, { origin: "https://evil.example" });

    expect(response.status).toBe(403);
  });
});

describe("the signature of a failure", () => {
  const base: ClientErrorEvent = {
    errorName: "TypeError",
    frames: ["sale-form-model-AAAAAAAA.js:10:5"],
    kind: "error",
    release: "abcdef1",
    routeId: "sale",
    v: 1,
  };

  it("is 16 hex characters", async () => {
    expect(await clientErrorSignature(base)).toMatch(SIGNATURE);
  });

  it("is the same in two builds: only the release and the hash, line and column of the frame differ", async () => {
    const other = {
      ...base,
      frames: ["sale-form-model-BbBbBbBb.js:99:7"],
      release: "1234567",
    };

    expect(await clientErrorSignature(other)).toBe(
      await clientErrorSignature(base)
    );
  });

  it("differs for another chunk name, another screen, another class, code, status or boundary", async () => {
    const original = await clientErrorSignature(base);
    const variants = [
      { ...base, frames: ["customer-form-AAAAAAAA.js:10:5"] },
      { ...base, routeId: "customers" },
      { ...base, errorName: "RangeError" },
      { ...base, code: "NOT_FOUND" },
      { ...base, status: 404 },
      { ...base, boundary: "app" },
      { ...base, kind: "rejection" },
    ] satisfies ClientErrorEvent[];

    const signatures = await Promise.all(
      variants.map((variant) => clientErrorSignature(variant))
    );

    for (const signature of signatures) {
      expect(signature).not.toBe(original);
    }
    expect(new Set(signatures).size).toBe(variants.length);
  });

  it("repeats of the same failure across two builds make one client_error line through the route", async () => {
    const logs = spyLogs();
    const { send } = setup();

    await send(validEvent);
    await send({
      ...validEvent,
      frames: ["sale-form-model-BbBbBbBb.js:99:7"],
      release: "1234567",
    });

    expect(linesOf(logs, "client_error")).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("POST /api/client-errors: no database, no session, no call outside", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("works without HYPERDRIVE and with fetch throwing", async () => {
    spyLogs();
    const fetchStub = vi.fn(() => {
      throw new Error("no external call allowed");
    });
    vi.stubGlobal("fetch", fetchStub);
    const { send } = setup({
      AUTH_HYPERDRIVE: undefined,
      HYPERDRIVE: undefined,
    });

    const response = await send();

    expect(response.status).toBe(204);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("the schema of the event", () => {
  it("says in the comment above it that a new field needs a new privacy review", () => {
    const text = readFileSync(
      new URL(
        "../../../../../packages/contracts/src/client-error.ts",
        import.meta.url
      ),
      "utf8"
    );
    const comment = text.slice(
      0,
      text.indexOf("export const clientErrorEventSchema")
    );

    expect(comment).toContain("new privacy review");
  });
});
