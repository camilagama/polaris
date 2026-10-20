import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AUTH_ENTRY_PATHS as HEADERS_AUTH_ENTRY_PATHS } from "@polaris/http-security";
import { transformWithEsbuild } from "vite";
import { describe, expect, it, vi } from "vitest";
import { buildId, precacheList } from "../../pwa/service-worker-plugin";
import {
  AUTH_ENTRY_PATHS,
  cachesToDelete,
  isSkipWaitingMessage,
  routeFor,
  SHELL_CACHE_PREFIX,
  shellCacheName,
} from "./sw";

const origin = "https://app.example";
const twelveHexPattern = /^[0-9a-f]{12}$/;
const precache = new Set([
  "/",
  "/assets/index-AAA.js",
  "/manifest.webmanifest",
]);
const get = (path: string, mode = "cors") => ({
  method: "GET",
  mode,
  url: `${origin}${path}`,
});

describe("what the worker touches", () => {
  it("answers navigations and serves precached files, nothing else", () => {
    expect(routeFor(get("/sales", "navigate"), origin, precache)).toBe(
      "navigate"
    );
    expect(routeFor(get("/", "navigate"), origin, precache)).toBe("navigate");
    expect(routeFor(get("/assets/index-AAA.js"), origin, precache)).toBe(
      "asset"
    );
    expect(routeFor(get("/manifest.webmanifest"), origin, precache)).toBe(
      "asset"
    );
    expect(routeFor(get("/assets/unknown-ZZZ.js"), origin, precache)).toBe(
      "bypass"
    );
  });

  it("never intercepts the tenant API, authentication or the health checks", () => {
    for (const path of [
      "/rpc/sale/confirm",
      "/rpc/sync/pull",
      "/api/auth/get-session",
      "/api/auth/callback/google",
      "/health",
      "/ready",
    ]) {
      // not even as a navigation (an OAuth callback is one)
      expect(routeFor(get(path, "navigate"), origin, precache)).toBe("bypass");
      expect(routeFor(get(path), origin, precache)).toBe("bypass");
    }
  });

  it("leaves writes and other origins alone", () => {
    expect(
      routeFor(
        { method: "POST", mode: "cors", url: `${origin}/assets/index-AAA.js` },
        origin,
        precache
      )
    ).toBe("bypass");
    expect(
      routeFor(
        {
          method: "GET",
          mode: "navigate",
          url: "https://elsewhere.example/sales",
        },
        origin,
        precache
      )
    ).toBe("bypass");
  });
});

describe("the shell caches", () => {
  const build = { builtAt: 1_700_000_000_000, id: "abc123def456" };

  it("are named after the build so two builds never share files", () => {
    expect(shellCacheName(build)).toBe(
      `${SHELL_CACHE_PREFIX}001700000000000-abc123def456`
    );
  });

  it("keep the current build and the newest other, and drop the rest, and only ours", () => {
    const current = shellCacheName({ builtAt: 300, id: "c" });
    const names = [
      shellCacheName({ builtAt: 100, id: "a" }),
      shellCacheName({ builtAt: 200, id: "b" }),
      current,
      shellCacheName({ builtAt: 50, id: "z" }),
      "someone-elses-cache",
    ];
    expect(cachesToDelete(names, current).sort()).toEqual(
      [
        shellCacheName({ builtAt: 100, id: "a" }),
        shellCacheName({ builtAt: 50, id: "z" }),
      ].sort()
    );
  });

  it("keep everything when there is nothing older than one previous build", () => {
    const current = shellCacheName({ builtAt: 2, id: "b" });
    expect(
      cachesToDelete(
        [shellCacheName({ builtAt: 1, id: "a" }), current],
        current
      )
    ).toEqual([]);
  });
});

describe("the update message", () => {
  it("only SKIP_WAITING from a page asks the new worker to take over", () => {
    expect(isSkipWaitingMessage({ type: "SKIP_WAITING" })).toBe(true);
    for (const data of [null, "SKIP_WAITING", {}, { type: "OTHER" }, 7]) {
      expect(isSkipWaitingMessage(data)).toBe(false);
    }
  });
});

describe("the build manifest", () => {
  it("lists the shell first and every static file, without maps or host config", () => {
    expect(
      precacheList({
        files: [
          "index.html",
          "assets/index-AAA.js",
          "assets/index-AAA.js.map",
          "assets/page-BBB.css",
          "manifest.webmanifest",
          "icons/icon-192.png",
          "sw.js",
          "_headers",
          ".assetsignore",
        ],
      })
    ).toEqual([
      "/",
      "/assets/index-AAA.js",
      "/assets/page-BBB.css",
      "/icons/icon-192.png",
      "/manifest.webmanifest",
    ]);
  });

  it("changes the build id when the shell or an unhashed file changes, not otherwise", () => {
    const files = ["index.html", "assets/a-1.js", "manifest.webmanifest"];
    const contents: Record<string, string> = {
      "index.html": "<html>v1</html>",
      "manifest.webmanifest": "{}",
    };
    const read = (file: string) => Buffer.from(contents[file] ?? "");
    const first = buildId(files, read);
    expect(buildId([...files].reverse(), read)).toBe(first);
    expect(first).toMatch(twelveHexPattern);

    contents["index.html"] = "<html>v2</html>";
    expect(buildId(files, read)).not.toBe(first);
    contents["index.html"] = "<html>v1</html>";
    expect(buildId([...files, "assets/b-2.js"], read)).not.toBe(first);
  });
});

/** Runs the compiled worker in a sandbox with a fake service worker scope. */
async function runWorker(build: {
  builtAt: number;
  id: string;
  precache: string[];
}) {
  const source = readFileSync(new URL("./sw.ts", import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source, "sw.ts", {
    format: "iife",
    loader: "ts",
    target: "es2020",
  });
  const listeners: Record<string, (event: never) => void> = {};
  const stores = new Map<string, Map<string, string>>();
  const fetched: string[] = [];
  const network: { online: boolean } = { online: true };
  const skipWaiting = vi.fn(() => Promise.resolve());
  const scope = {
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners[type] = listener;
    },
    clients: { claim: vi.fn(() => Promise.resolve()) },
    location: { origin },
    registration: {},
    skipWaiting,
  };
  const keyOf = (request: { url?: string } | string) =>
    new URL(
      typeof request === "string" ? request : (request.url as string),
      origin
    ).pathname;
  const cacheApi = {
    delete: (name: string) => Promise.resolve(stores.delete(name)),
    keys: () => Promise.resolve([...stores.keys()]),
    match: (request: { url?: string } | string) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(request));
        if (hit !== undefined) {
          return Promise.resolve({ body: hit });
        }
      }
      return Promise.resolve(undefined);
    },
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return Promise.resolve({
        addAll: async (requests: { url: string }[]) => {
          const responses = await Promise.all(
            requests.map((request) => fakeFetch(request))
          );
          requests.forEach((request, index) => {
            store.set(
              keyOf(request),
              (responses[index] as { body: string }).body
            );
          });
        },
        match: (request: { url?: string } | string) =>
          Promise.resolve(
            store.has(keyOf(request))
              ? { body: store.get(keyOf(request)) }
              : undefined
          ),
      });
    },
  };
  const fakeFetch = (request: { url: string }) => {
    fetched.push(keyOf(request));
    return network.online
      ? Promise.resolve({ body: `net:${keyOf(request)}` })
      : Promise.reject(new TypeError("offline"));
  };
  runInNewContext(`const POLARIS_BUILD=${JSON.stringify(build)};\n${code}`, {
    caches: cacheApi,
    fetch: fakeFetch,
    Request: class {
      url: string;
      constructor(url: string) {
        this.url = new URL(url, origin).toString();
      }
    },
    Response: { error: () => ({ body: "error" }) },
    self: scope,
    URL,
  });
  const run = async (type: string, event: object) => {
    const pending: Promise<unknown>[] = [];
    let answer: Promise<unknown> | undefined;
    listeners[type]?.({
      ...event,
      respondWith: (response: Promise<unknown>) => {
        answer = response;
      },
      waitUntil: (work: Promise<unknown>) => pending.push(work),
    } as never);
    await Promise.all(pending);
    return answer === undefined ? undefined : await answer;
  };
  return { fetched, listeners, network, run, skipWaiting, stores };
}

describe("the worker as the browser runs it", () => {
  const build = {
    builtAt: 200,
    id: "bbb",
    precache: ["/", "/assets/index-BBB.js"],
  };

  it("installs by precaching exactly the shell of its build, under its own cache", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    const cache = worker.stores.get(shellCacheName(build));
    expect([...(cache?.keys() ?? [])].sort()).toEqual(
      ["/", "/assets/index-BBB.js", "/entrar"].sort()
    );
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("opens the app offline: the network when it answers, the cached shell when it does not", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    const navigate = {
      method: "GET",
      mode: "navigate",
      url: `${origin}/sales`,
    };
    expect(await worker.run("fetch", { request: navigate })).toEqual({
      body: "net:/sales",
    });
    worker.network.online = false;
    expect(await worker.run("fetch", { request: navigate })).toEqual({
      body: "net:/",
    });
  });

  it("opens a sign-in page offline from its own copy, which carries the challenge policy (ADR 0100)", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    worker.network.online = false;
    const answers = async (paths: string[]) =>
      Promise.all(
        paths.map((path) =>
          worker.run("fetch", {
            request: {
              method: "GET",
              mode: "navigate",
              url: `${origin}${path}`,
            },
          })
        )
      );
    expect(
      await answers(["/entrar", "/redefinir-senha", "/confirmar-email/"])
    ).toEqual(new Array(3).fill({ body: "net:/entrar" }));
    // the unlock page and the rest of the app keep the shell of /
    expect(await answers(["/desbloquear", "/conta/seguranca"])).toEqual(
      new Array(2).fill({ body: "net:/" })
    );
  });

  it("lists the same sign-in pages as the headers file", () => {
    expect([...AUTH_ENTRY_PATHS]).toEqual([...HEADERS_AUTH_ENTRY_PATHS]);
  });

  it("serves precached files from the cache and leaves everything else to the network untouched", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    worker.fetched.length = 0;
    const asset = {
      method: "GET",
      mode: "cors",
      url: `${origin}/assets/index-BBB.js`,
    };
    expect(await worker.run("fetch", { request: asset })).toEqual({
      body: "net:/assets/index-BBB.js",
    });
    expect(worker.fetched).toEqual([]); // came from the cache, not the network
    for (const path of ["/rpc/sale/confirm", "/api/auth/get-session"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      const answer = await worker.run("fetch", {
        request: { method: "GET", mode: "cors", url: `${origin}${path}` },
      });
      expect(answer).toBeUndefined(); // respondWith was never called
    }
    const stored = [...worker.stores.values()].flatMap((store) => [
      ...store.keys(),
    ]);
    expect(stored.some((path) => path.startsWith("/rpc/"))).toBe(false);
    expect(stored.some((path) => path.startsWith("/api/"))).toBe(false);
  });

  it("an update waits for the page: it does not take over by itself, and obeys SKIP_WAITING", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    await worker.run("activate", {});
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    await worker.run("message", { data: { type: "other" } });
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    await worker.run("message", { data: { type: "SKIP_WAITING" } });
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("activating a build removes old shell caches but keeps the previous one and other caches", async () => {
    const worker = await runWorker(build);
    const old = shellCacheName({ builtAt: 10, id: "old" });
    const previous = shellCacheName({ builtAt: 100, id: "prev" });
    worker.stores.set(old, new Map());
    worker.stores.set(previous, new Map());
    worker.stores.set("unrelated", new Map());
    await worker.run("install", {});
    await worker.run("activate", {});
    expect([...worker.stores.keys()].sort()).toEqual(
      [previous, shellCacheName(build), "unrelated"].sort()
    );
  });
});
