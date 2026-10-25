import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AUTH_ENTRY_PATHS as HEADERS_AUTH_ENTRY_PATHS } from "@polaris/http-security";
import { transformWithEsbuild } from "vite";
import { describe, expect, it, vi } from "vitest";
import {
  buildId,
  buildManifest,
  precacheList,
} from "../../pwa/service-worker-plugin";
import {
  AUTH_ENTRY_PATHS,
  cachesToDelete,
  isExpectedResponse,
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
  it("are named after the build so two builds never share files", () => {
    expect(shellCacheName({ id: "abc123def456" })).toBe(
      `${SHELL_CACHE_PREFIX}abc123def456`
    );
  });

  it("keep the current build and the newest other (the last created), and drop the rest, and only ours", () => {
    const current = shellCacheName({ id: "c" });
    // in the order of creation, as `caches.keys()` lists them
    const names = [
      shellCacheName({ id: "z" }),
      shellCacheName({ id: "a" }),
      "someone-elses-cache",
      shellCacheName({ id: "b" }),
      current,
    ];
    expect(cachesToDelete(names, current).sort()).toEqual(
      [shellCacheName({ id: "z" }), shellCacheName({ id: "a" })].sort()
    );
  });

  it("count the caches named with the time of the build (before t344) as older ones, in the order they were created", () => {
    const current = shellCacheName({ id: "c" });
    const legacy = (time: string) => `${SHELL_CACHE_PREFIX}${time}-abc`;
    const names = [
      legacy("001792882534887"),
      legacy("001792887639279"),
      current,
    ];
    expect(cachesToDelete(names, current)).toEqual([legacy("001792882534887")]);
  });

  it("keep everything when there is nothing older than one previous build", () => {
    const current = shellCacheName({ id: "b" });
    expect(
      cachesToDelete([shellCacheName({ id: "a" }), current], current)
    ).toEqual([]);
  });
});

describe("what counts as the file that was asked for", () => {
  const answer = (status: number, type: string | null) => ({
    headers: { get: () => type },
    status,
  });

  it("takes a script as a script and a style sheet as a style sheet, with a 200", () => {
    expect(
      isExpectedResponse(
        "/assets/a-1.js",
        answer(200, "text/javascript; charset=utf-8")
      )
    ).toBe(true);
    expect(
      isExpectedResponse(
        "/assets/a-1.js",
        answer(200, "application/javascript")
      )
    ).toBe(true);
    expect(isExpectedResponse("/assets/a-1.css", answer(200, "text/css"))).toBe(
      true
    );
  });

  it("refuses the page the host answers for a file that is not there, and anything that is not a 200", () => {
    expect(isExpectedResponse("/assets/a-1.js", answer(200, "text/html"))).toBe(
      false
    );
    expect(
      isExpectedResponse(
        "/assets/a-1.css",
        answer(200, "text/html; charset=utf-8")
      )
    ).toBe(false);
    expect(isExpectedResponse("/assets/a-1.js", answer(200, null))).toBe(false);
    expect(
      isExpectedResponse("/assets/a-1.js", answer(404, "text/javascript"))
    ).toBe(false);
    expect(
      isExpectedResponse("/assets/a-1.js", answer(304, "text/javascript"))
    ).toBe(false);
  });

  it("wants a page for the shell and anything but a page for the other files", () => {
    expect(isExpectedResponse("/", answer(200, "text/html"))).toBe(true);
    expect(isExpectedResponse("/entrar", answer(200, "text/html"))).toBe(true);
    expect(isExpectedResponse("/", answer(200, "text/javascript"))).toBe(false);
    expect(
      isExpectedResponse(
        "/manifest.webmanifest",
        answer(200, "application/manifest+json")
      )
    ).toBe(true);
    expect(isExpectedResponse("/icons/a.png", answer(200, "image/png"))).toBe(
      true
    );
    expect(isExpectedResponse("/icons/a.png", answer(200, "text/html"))).toBe(
      false
    );
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

  it("lists the chunks that load on demand, the charts and the calendar, so they open offline (t363, t369)", () => {
    const listed = precacheList({
      files: [
        "index.html",
        "assets/calendar-Ab12_x.js",
        "assets/charts-Dk3jf9.js",
        "assets/index-AAA.js",
      ],
    });
    expect(listed).toContain("/assets/calendar-Ab12_x.js");
    expect(listed).toContain("/assets/charts-Dk3jf9.js");
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

  it("is the same for the same content, whenever the build is made: no time in the worker", () => {
    const files = ["index.html", "assets/a-1.js", "manifest.webmanifest"];
    const read = (file: string) => Buffer.from(`content of ${file}`);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-24T19:55:00Z"));
      const first = JSON.stringify(buildManifest(files, read));
      vi.setSystemTime(new Date("2026-10-24T21:20:00Z"));
      const second = JSON.stringify(buildManifest(files, read));
      expect(second).toBe(first);
      expect(first).not.toContain("builtAt");
    } finally {
      vi.useRealTimers();
    }
  });
});

interface FakeResponse {
  body: string;
  clone: () => FakeResponse;
  headers: { get: (name: string) => string | null };
  status: number;
}

const EXTENSION_TYPES: Record<string, string> = {
  css: "text/css",
  js: "text/javascript; charset=utf-8",
  webmanifest: "application/manifest+json",
};

function withClone(response: Omit<FakeResponse, "clone">): FakeResponse {
  const copy: FakeResponse = {
    ...response,
    clone: () => withClone(response),
  };
  return copy;
}

/** The file as the host serves it: 200 with the type of its extension (a page for a path with none). */
function fileOf(path: string): FakeResponse {
  const type =
    EXTENSION_TYPES[path.split(".").pop() ?? ""] ?? "text/html; charset=utf-8";
  return withClone({
    body: `net:${path}`,
    headers: { get: () => type },
    status: 200,
  });
}

/** What the host answers for a path it does not have: the shell, 200, `text/html`. */
function htmlOf(path: string): FakeResponse {
  return withClone({
    body: `<html>shell instead of ${path}</html>`,
    headers: { get: () => "text/html; charset=utf-8" },
    status: 200,
  });
}

/** Runs the compiled worker in a sandbox with a fake service worker scope. */
async function runWorker(build: { id: string; precache: string[] }) {
  const source = readFileSync(new URL("./sw.ts", import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source, "sw.ts", {
    format: "iife",
    loader: "ts",
    target: "es2020",
  });
  const listeners: Record<string, (event: never) => void> = {};
  const stores = new Map<string, Map<string, FakeResponse>>();
  const fetched: string[] = [];
  const network: {
    failPath?: string;
    /** Paths the host answers with its page, 200 `text/html`, as it does for a file that is not there. */
    htmlPaths: Set<string>;
    online: boolean;
  } = { htmlPaths: new Set(), online: true };
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
          return Promise.resolve(hit);
        }
      }
      return Promise.resolve(undefined);
    },
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, FakeResponse>();
      stores.set(name, store);
      return Promise.resolve({
        match: (request: { url?: string } | string) =>
          Promise.resolve(store.get(keyOf(request))),
        put: (request: { url: string }, response: FakeResponse) => {
          store.set(keyOf(request), response);
          return Promise.resolve();
        },
      });
    },
  };
  const fakeFetch = (request: { url: string }) => {
    const path = keyOf(request);
    fetched.push(path);
    if (!network.online || path === network.failPath) {
      return Promise.reject(new TypeError("offline"));
    }
    return Promise.resolve(
      network.htmlPaths.has(path) ? htmlOf(path) : fileOf(path)
    );
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
    expect(await worker.run("fetch", { request: navigate })).toMatchObject({
      body: "net:/sales",
    });
    worker.network.online = false;
    expect(await worker.run("fetch", { request: navigate })).toMatchObject({
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
    ).toEqual(
      new Array(3).fill(expect.objectContaining({ body: "net:/entrar" }))
    );
    // the unlock page and the rest of the app keep the shell of /
    expect(await answers(["/desbloquear", "/conta/seguranca"])).toEqual(
      new Array(2).fill(expect.objectContaining({ body: "net:/" }))
    );
  });

  it("installs even when the sign-in copy cannot be fetched: the copy is a bonus", async () => {
    const worker = await runWorker(build);
    worker.network.failPath = "/entrar";
    await worker.run("install", {});
    const cache = worker.stores.get(shellCacheName(build));
    expect([...(cache?.keys() ?? [])].sort()).toEqual(
      ["/", "/assets/index-BBB.js"].sort()
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
    expect(await worker.run("fetch", { request: asset })).toMatchObject({
      body: "net:/assets/index-BBB.js",
    });
    expect(worker.fetched).toEqual([]); // came from the cache, not the network
    // a clone, not the object `cache.match` returned (Chrome refuses the page's preload of the latter, t344)
    const kept = worker.stores
      .get(shellCacheName(build))
      ?.get("/assets/index-BBB.js");
    expect(await worker.run("fetch", { request: asset })).not.toBe(kept);
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
    // created in this order: the previous build is the one created last
    const old = shellCacheName({ id: "old" });
    const previous = shellCacheName({ id: "prev" });
    worker.stores.set(old, new Map());
    worker.stores.set(previous, new Map());
    worker.stores.set("unrelated", new Map());
    await worker.run("install", {});
    await worker.run("activate", {});
    expect([...worker.stores.keys()].sort()).toEqual(
      [previous, shellCacheName(build), "unrelated"].sort()
    );
  });

  it("does not install when a chunk comes back as the host's page: nothing is cached", async () => {
    const worker = await runWorker(build);
    worker.network.htmlPaths.add("/assets/index-BBB.js");
    await expect(worker.run("install", {})).rejects.toThrow(
      "unexpected response for /assets/index-BBB.js"
    );
    const cached = [...worker.stores.values()].flatMap((store) => [
      ...store.keys(),
    ]);
    expect(cached).toEqual([]);
  });

  it("does not keep the sign-in copy when it comes back as something else, and installs anyway", async () => {
    const worker = await runWorker(build);
    worker.network.htmlPaths.add("/entrar"); // a page for a page: kept
    await worker.run("install", {});
    expect(
      [...(worker.stores.get(shellCacheName(build))?.keys() ?? [])].sort()
    ).toEqual(["/", "/assets/index-BBB.js", "/entrar"].sort());
  });

  it("does not serve a page kept in place of a chunk by an older worker: it asks the network", async () => {
    const worker = await runWorker(build);
    await worker.run("install", {});
    worker.stores
      .get(shellCacheName(build))
      ?.set("/assets/index-BBB.js", htmlOf("/assets/index-BBB.js"));
    worker.fetched.length = 0;
    const asset = {
      method: "GET",
      mode: "cors",
      url: `${origin}/assets/index-BBB.js`,
    };
    expect(await worker.run("fetch", { request: asset })).toMatchObject({
      body: "net:/assets/index-BBB.js",
    });
    expect(worker.fetched).toEqual(["/assets/index-BBB.js"]);
    // and what the network answers is not stored either
    expect(
      worker.stores.get(shellCacheName(build))?.get("/assets/index-BBB.js")
        ?.body
    ).toContain("shell instead of");
  });
});
