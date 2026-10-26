import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";
import { traverseContractProcedures } from "@orpc/server";
import type { ProcedureMeta } from "@polaris/contracts";
import { polarisContract } from "@polaris/contracts";
import { rpcRouter } from "../rpc/router";
import {
  createRateLimitMiddleware,
  isMediaUploadRequest,
  mediaUploadRateLimitMiddleware,
  RPC_WRITE_RULE,
  rpcProcedureKind,
  rpcRateLimitMiddleware,
} from "./rate-limit";
import { requestIdMiddleware } from "./request-id";

const secret = "a".repeat(32);
const sessionToken = "session-token-value.signature";
const clientAddress = "203.0.113.9";
const bucketKeyPattern = /^rpc-mutation-(?:ip|session):[0-9a-f]{64}$/;
const readKeyPattern = /^rpc-read-(?:ip|session):[0-9a-f]{64}$/;
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

function createApp(middleware = rpcRateLimitMiddleware, path = "/rpc/*") {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.use(path, middleware);
  app.all("*", (context) => context.json({ reached: true }));
  return app;
}

function bindings(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    BETTER_AUTH_BASE_URL: "http://localhost:8787",
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

/** Every procedure the given router serves, with the kind it declares (undefined when none). */
function declaredKinds(
  router: Parameters<typeof traverseContractProcedures>[0]["router"]
): Map<string, unknown> {
  const kinds = new Map<string, unknown>();
  traverseContractProcedures({ path: [], router }, ({ contract, path }) => {
    kinds.set(path.join("/"), (contract["~orpc"].meta as ProcedureMeta).kind);
  });
  return kinds;
}

/** The reads, spelled out: making a procedure a read (a wider bucket) shows up here, in review. */
const READ_PROCEDURES = [
  "account/legalStatus",
  "billing/readPlan",
  "category/list",
  "customer/findPossibleDuplicates",
  "customer/list",
  "dataExport/list",
  "dataExport/listClosed",
  "device/list",
  "expense/list",
  "expense/listCategories",
  "expense/listRules",
  "goal/list",
  "goal/targetChanges",
  "inventory/getBalance",
  "inventory/listBalances",
  "organization/closedStatus",
  "organization/listClosed",
  "organization/listClosing",
  "organization/listMine",
  "paymentProfile/list",
  "plan/operationalSelection",
  "product/getVariants",
  "product/list",
  "publicCatalog/setup",
  "report/dailySales",
  "report/periodSummary",
  "sale/get",
  "sale/getCustomerLink",
  "sale/list",
  "sync/bootstrapPage",
  "sync/getCursor",
  "sync/pull",
  "system/ping",
];

describe("request classification", () => {
  it("every procedure the router serves declares read or write", () => {
    const kinds = declaredKinds(rpcRouter);
    const unclassified = [...kinds]
      .filter(([, kind]) => kind !== "read" && kind !== "write")
      .map(([path]) => path);

    expect(kinds.size).toBeGreaterThan(90);
    expect(unclassified).toEqual([]);
    // the router serves exactly the contract, so the middleware's table (read from the contract) covers it
    expect([...kinds.keys()].sort()).toEqual(
      [...declaredKinds(polarisContract).keys()].sort()
    );
  });

  it("the reads are exactly the procedures listed here", () => {
    const reads = [...declaredKinds(polarisContract)]
      .filter(([, kind]) => kind === "read")
      .map(([path]) => path)
      .sort();

    expect(reads).toEqual(READ_PROCEDURES);
  });

  it.each([
    ["POST", "/rpc/sale/confirm", "write"],
    ["POST", "/rpc/category/create", "write"],
    ["POST", "/rpc/inventory/receiveStock", "write"],
    ["POST", "/rpc/sync/push", "write"],
    // every page load confirms the device and promotes the session's link to it: a write, once per load
    ["POST", "/rpc/device/check", "write"],
    ["POST", "/rpc/offline/issueLease", "write"],
    ["POST", "/rpc/sale/list", "read"],
    ["POST", "/rpc/sale/get", "read"],
    ["POST", "/rpc/sale/getCustomerLink", "read"],
    ["POST", "/rpc/customer/findPossibleDuplicates", "read"],
    ["POST", "/rpc/system/ping", "read"],
    // reads whose names the old pattern took for writes
    ["POST", "/rpc/sync/pull", "read"],
    ["POST", "/rpc/sync/bootstrapPage", "read"],
    ["POST", "/rpc/report/periodSummary", "read"],
    ["POST", "/rpc/report/dailySales", "read"],
    // a path the contract does not know is a write, even with a read's name
    ["POST", "/rpc/product/getawayRename", "write"],
    ["POST", "/rpc/category/listing_cleanup", "write"],
    ["POST", "/rpc/sale/list/extra", "write"],
    ["POST", "/rpc/", "write"],
    ["GET", "/rpc/sale/confirm", null],
    ["OPTIONS", "/rpc/sale/confirm", null],
  ])("%s %s is a %s", (method, path, expected) => {
    expect(
      rpcProcedureKind(new Request(`https://x.invalid${path}`, { method }))
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
      bindings({
        BETTER_AUTH_BASE_URL: "https://app.example.test",
        RPC_MUTATION_RATE_LIMIT: binding,
      }),
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

  it("counts reads in their own buckets, never in the write one", async () => {
    const write = limiter(false);
    const readSession = limiter(true);
    const readIp = limiter(true);
    const app = createApp();
    const env = bindings({
      RPC_MUTATION_RATE_LIMIT: write,
      RPC_READ_IP_RATE_LIMIT: readIp,
      RPC_READ_RATE_LIMIT: readSession,
    });
    const headers = {
      "cf-connecting-ip": clientAddress,
      cookie: `better-auth.session_token=${sessionToken}`,
    };

    expect((await post(app, "/rpc/sync/pull", env, headers)).status).toBe(200);
    expect(
      (await post(app, "/rpc/report/periodSummary", env, headers)).status
    ).toBe(200);
    expect(write.limit).not.toHaveBeenCalled();
    // the address in the address bucket, the session in the session one
    const ipKeys = readIp.limit.mock.calls.map(([options]) => options.key);
    const sessionKeys = readSession.limit.mock.calls.map(
      ([options]) => options.key
    );
    expect(ipKeys).toHaveLength(2);
    expect(sessionKeys).toHaveLength(2);
    for (const key of [...ipKeys, ...sessionKeys]) {
      expect(key).toMatch(readKeyPattern);
      expect(key).not.toContain(clientAddress);
      expect(key).not.toContain(sessionToken);
    }
    expect(ipKeys.every((key) => key.startsWith("rpc-read-ip:"))).toBe(true);
    expect(
      sessionKeys.every((key) => key.startsWith("rpc-read-session:"))
    ).toBe(true);
  });

  it("counts writes only in the write bucket, by address and by session", async () => {
    const write = limiter(true);
    const readSession = limiter(false);
    const readIp = limiter(false);
    const response = await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({
        RPC_MUTATION_RATE_LIMIT: write,
        RPC_READ_IP_RATE_LIMIT: readIp,
        RPC_READ_RATE_LIMIT: readSession,
      }),
      {
        "cf-connecting-ip": clientAddress,
        cookie: `better-auth.session_token=${sessionToken}`,
      }
    );

    expect(response.status).toBe(200);
    expect(write.limit).toHaveBeenCalledTimes(2);
    expect(readIp.limit).not.toHaveBeenCalled();
    expect(readSession.limit).not.toHaveBeenCalled();
  });

  it.each([
    ["the address", "rpc-read-ip", "ip"],
    ["the session", "rpc-read-session", "session"],
  ])(
    "a read is refused when only %s bucket is exhausted",
    async (_label, prefix, keyType) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const deny = ({ key }: { key: string }) =>
        Promise.resolve({ success: !key.startsWith(prefix) });
      const readIp = limiter(true);
      const readSession = limiter(true);
      readIp.limit.mockImplementation(deny);
      readSession.limit.mockImplementation(deny);
      const response = await post(
        createApp(),
        "/rpc/sync/pull",
        bindings({
          RPC_READ_IP_RATE_LIMIT: readIp,
          RPC_READ_RATE_LIMIT: readSession,
        }),
        {
          "cf-connecting-ip": clientAddress,
          cookie: `better-auth.session_token=${sessionToken}`,
        }
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: "read",
          event: "rate_limited",
          keyType,
          route: "/rpc/sync/pull",
        })
      );
    }
  );

  it("logs which bucket and which kind of key denied a write, never the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post(
      createApp(),
      "/rpc/sale/confirm",
      bindings({ RPC_MUTATION_RATE_LIMIT: limiter(false) }),
      {
        "cf-connecting-ip": clientAddress,
        cookie: `better-auth.session_token=${sessionToken}`,
      }
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "write",
        event: "rate_limited",
        keyType: "ip+session",
        route: "/rpc/sale/confirm",
      })
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(clientAddress);
    expect(logged).not.toContain(sessionToken);
  });

  it("a limiter that fails opens only its own key: the other key's refusal stands", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readIp = limiter(() => Promise.reject(new Error("limiter down")));
    const readSession = limiter(false);
    const response = await post(
      createApp(),
      "/rpc/sync/pull",
      bindings({
        RPC_READ_IP_RATE_LIMIT: readIp,
        RPC_READ_RATE_LIMIT: readSession,
      }),
      {
        "cf-connecting-ip": clientAddress,
        cookie: `better-auth.session_token=${sessionToken}`,
      }
    );

    expect(response.status).toBe(429);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rate_limit_unavailable" })
    );
  });

  it("logs a path the contract does not know as one, never the client's text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await post(
      createApp(),
      "/rpc/aaaa-made-up-by-the-client",
      bindings({ RPC_MUTATION_RATE_LIMIT: limiter(false) }),
      { "cf-connecting-ip": clientAddress }
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "write",
        event: "rate_limited",
        route: "/rpc/<unknown>",
      })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("made-up");
  });

  it("does not limit GET or paths outside the middleware", async () => {
    const binding = limiter(false);
    const app = createApp();
    const env = bindings({
      RPC_MUTATION_RATE_LIMIT: binding,
      RPC_READ_IP_RATE_LIMIT: binding,
      RPC_READ_RATE_LIMIT: binding,
    });

    expect((await app.request("/rpc/sale/confirm", {}, env)).status).toBe(200);
    expect((await post(app, "/other", env)).status).toBe(200);
    expect(binding.limit).not.toHaveBeenCalled();
  });

  it("does not block when the binding is absent and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createApp(
      createRateLimitMiddleware({
        route: () => "/rpc/sale/confirm",
        rule: () => RPC_WRITE_RULE,
      })
    );
    const headers = { "cf-connecting-ip": clientAddress };

    expect(
      (await post(app, "/rpc/sale/confirm", bindings(), headers)).status
    ).toBe(200);
    expect(
      (await post(app, "/rpc/sale/confirm", bindings(), headers)).status
    ).toBe(200);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rate_limit_binding_missing",
        scope: "rpc-mutation-ip",
      })
    );
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

  describe("key hardening", () => {
    const httpsBase = "https://app.example.test";

    /** The keys one request produced, by kind of key. */
    async function keysOf(
      headers: Record<string, string>,
      baseURL = "http://localhost:8787"
    ) {
      const binding = limiter(true);
      await post(
        createApp(),
        "/rpc/sale/confirm",
        bindings({
          BETTER_AUTH_BASE_URL: baseURL,
          RPC_MUTATION_RATE_LIMIT: binding,
        }),
        headers
      );
      const keys = binding.limit.mock.calls.map(([options]) => options.key);
      return {
        ip: keys.filter((key) => key.startsWith("rpc-mutation-ip:")),
        session: keys.filter((key) => key.startsWith("rpc-mutation-session:")),
      };
    }

    it("reads only the __Secure- cookie under an HTTPS base URL, whatever the order", async () => {
      const real = await keysOf(
        { cookie: `__Secure-better-auth.session_token=${sessionToken}` },
        httpsBase
      );
      const plainFirst = await keysOf(
        {
          cookie: `better-auth.session_token=junk-1; __Secure-better-auth.session_token=${sessionToken}`,
        },
        httpsBase
      );
      const plainLast = await keysOf(
        {
          cookie: `__Secure-better-auth.session_token=${sessionToken}; better-auth.session_token=junk-2`,
        },
        httpsBase
      );

      expect(real.session).toHaveLength(1);
      expect(plainFirst.session).toEqual(real.session);
      expect(plainLast.session).toEqual(real.session);
    });

    it("reads only the unprefixed cookie under a loopback HTTP base URL, whatever the order", async () => {
      const real = await keysOf({
        cookie: `better-auth.session_token=${sessionToken}`,
      });
      const prefixedFirst = await keysOf({
        cookie: `__Secure-better-auth.session_token=junk-1; better-auth.session_token=${sessionToken}`,
      });
      const prefixedLast = await keysOf({
        cookie: `better-auth.session_token=${sessionToken}; __Secure-better-auth.session_token=junk-2`,
      });

      expect(real.session).toHaveLength(1);
      expect(prefixedFirst.session).toEqual(real.session);
      expect(prefixedLast.session).toEqual(real.session);
    });

    it("counts no session when the only cookie is the other environment's name", async () => {
      expect(
        (await keysOf({ cookie: "better-auth.session_token=value" }, httpsBase))
          .session
      ).toEqual([]);
      expect(
        (
          await keysOf({
            cookie: "__Secure-better-auth.session_token=value",
          })
        ).session
      ).toEqual([]);
    });

    it("never opens a bucket for a cookie of another name, whatever its value", async () => {
      const names = [
        "x-better-auth.session_token",
        "better-auth.session_token.x",
        "__Host-better-auth.session_token",
        "__Secure-__Secure-better-auth.session_token",
        "Better-Auth.Session_Token",
        "session",
      ];
      const sessions = await Promise.all(
        ["https://app.example.test", "http://localhost:8787"].flatMap(
          (baseURL) =>
            names.map(async (name, index) => {
              const { session } = await keysOf(
                { cookie: `${name}=value-${index}` },
                baseURL
              );
              return session;
            })
        )
      );

      expect(sessions.flat()).toEqual([]);
    });

    it("counts no session without a usable base URL", async () => {
      const sessions = await Promise.all(
        ["", "not a url"].map(
          async (baseURL) =>
            (
              await keysOf(
                { cookie: `better-auth.session_token=${sessionToken}` },
                baseURL
              )
            ).session
        )
      );

      expect(sessions.flat()).toEqual([]);
    });

    it("puts the addresses of one IPv6 /64 in one bucket and another /64 in another", async () => {
      const ipOf = async (address: string) =>
        (await keysOf({ "cf-connecting-ip": address })).ip;
      const one = await ipOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
      const sameNet = [
        "2001:db8:1:2::1",
        "2001:0DB8:0001:0002:0000:0000:0000:0001",
        "2001:db8:1:2:ffff:ffff:ffff:ffff",
        "2001:db8:1:2::",
        "2001:db8:1:2:1:2:1.2.3.4",
      ];
      const otherNets = [
        "2001:db8:1:3::1",
        "2001:db8:2:2::1",
        "2001:db9:1:2::1",
      ];

      expect(one).toHaveLength(1);
      for (const same of await Promise.all(sameNet.map(ipOf))) {
        expect(same).toEqual(one);
      }
      for (const other of await Promise.all(otherNets.map(ipOf))) {
        expect(other).toHaveLength(1);
        expect(other).not.toEqual(one);
      }
    });

    it("keeps IPv4 as it was, and reads every spelling of a mapped IPv4 as the IPv4 address", async () => {
      const ipOf = async (address: string) =>
        (await keysOf({ "cf-connecting-ip": address })).ip;
      const plain = await ipOf(clientAddress);
      const mapped = await Promise.all(
        [
          `::ffff:${clientAddress}`,
          `::FFFF:${clientAddress}`,
          "::ffff:cb00:7109",
          `0:0:0:0:0:ffff:${clientAddress}`,
        ].map(ipOf)
      );

      expect(plain).toHaveLength(1);
      expect(await ipOf("203.0.113.10")).not.toEqual(plain);
      for (const key of mapped) {
        expect(key).toEqual(plain);
      }
    });

    it("counts no address for text that is not an IPv4 or IPv6 address", async () => {
      const values = [
        "abc",
        "999.1.1.1",
        "1.2.3",
        "1.2.3.4.5",
        "1:2:3",
        "2001:db8::1::2",
        "2001:db8:zz::1",
        "1:2:3:4:5:6:7:8:9",
        "1::2:3:4:5:6:7:8",
        "1:::2",
        ":1:2:3:4:5:6:7",
        "1:2:3:4:5:6:7:",
        "1:2:1.2.3.4",
        "1.2::3",
        "::ffff:300.1.1.1",
        "2001:db8::1 2",
        `2001:db8::${"1".repeat(60)}`,
      ];
      const found = await Promise.all(
        values.map(
          async (value) => (await keysOf({ "cf-connecting-ip": value })).ip
        )
      );

      expect(found.flat()).toEqual([]);
    });

    it("reads the shapes an IPv6 address can take", async () => {
      const ipOf = async (address: string) =>
        (await keysOf({ "cf-connecting-ip": address })).ip;
      const [zeroNet, loopback, zoned, plain, sevenGroups, eightGroups] =
        await Promise.all(
          [
            "::",
            "::1",
            "fe80::1%eth0",
            "fe80::1",
            "1:2:3:4:5:6:7::",
            "1:2:3:4:5:6:7:8",
          ].map(ipOf)
        );

      // both are in the all-zero /64, and the zone is no part of the address
      expect(zeroNet).toHaveLength(1);
      expect(loopback).toEqual(zeroNet);
      expect(zoned).toEqual(plain);
      expect(sevenGroups).toEqual(eightGroups);
    });

    it("keeps one IPv4 spelling per address", async () => {
      expect((await keysOf({ "cf-connecting-ip": "01.2.3.4" })).ip).toEqual(
        (await keysOf({ "cf-connecting-ip": "1.2.3.4" })).ip
      );
    });

    it("gives one session one bucket in every spelling of its cookie", async () => {
      const spellings = [
        "tok.sig",
        '"tok.sig"',
        "tok%2Esig",
        "%74ok.sig",
        "tok.other-signature",
        "tok",
      ];
      const real = await keysOf({
        cookie: `better-auth.session_token=${spellings[0]}`,
      });
      const others = await Promise.all(
        spellings.map(
          async (value) =>
            (await keysOf({ cookie: `better-auth.session_token=${value}` }))
              .session
        )
      );
      const another = await keysOf({
        cookie: "better-auth.session_token=tok2.sig",
      });

      expect(real.session).toHaveLength(1);
      for (const session of others) {
        expect(session).toEqual(real.session);
      }
      expect(another.session).not.toEqual(real.session);
    });
  });
});
