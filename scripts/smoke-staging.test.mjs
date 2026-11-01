import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { polarisContract } from "../packages/contracts/src/index.ts";
import {
  attempt,
  COMMIT_REFUSAL,
  CREATE_INITIAL_INPUT,
  REFUSAL,
  refusalOf,
  runSmoke,
  STAGING_FIXED_HOST,
  STRANGE_ORIGIN,
  send,
  smokeChecks,
  USER_AGENT,
} from "./smoke-staging.mjs";

const origins = {
  catalog: "https://catalogo.araute.app",
  web: "https://dash.araute.app",
};

const COMMIT = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const RELEASE = "9b3d37ed5c22";
const INDEX = "<!doctype html><title>Polaris</title>";
const SERVICE_WORKER = "self.addEventListener('install', () => {});";
const REQUEST_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const AUTH_METHODS = {
  emailPassword: true,
  google: true,
  turnstileSiteKey: "0x4AAAAAAFhym3AGtjg2fgH0",
};

const noPause = () => Promise.resolve();

let buildDir = "";
let options = { buildDir: "", commit: COMMIT };

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "smoke-staging-"));
  await writeFile(join(buildDir, "index.html"), INDEX);
  await writeFile(join(buildDir, "sw.js"), SERVICE_WORKER);
  options = { buildDir, commit: COMMIT };
});

afterAll(async () => {
  await rm(buildDir, { force: true, recursive: true });
});

const answer = (status, headers = {}, body = null) =>
  new Response(body, { headers, status });

const fromWorker = (status, headers = {}, body = null) =>
  answer(status, { "x-request-id": REQUEST_ID, ...headers }, body);

const json = (value) => JSON.stringify(value);

/** The input schema of a procedure of the contract decides between 400 (invalid body) and 401 (no session). */
function anonymousCall(procedure, init) {
  const schema = procedure["~orpc"].inputSchema;
  const input = JSON.parse(init.body).json;
  if (schema && !schema.safeParse(input).success) {
    return fromWorker(400);
  }
  return fromWorker(
    401,
    { "content-type": "application/json" },
    json({ json: { code: "UNAUTHORIZED" } })
  );
}

/** A staging that answers every check as expected. */
function stagingAnswer(url, init = {}) {
  const origin = new Headers(init.headers).get("origin");
  switch (url) {
    case `${origins.web}/health`:
      return fromWorker(
        200,
        { "x-polaris-release": RELEASE },
        json({ status: "ok" })
      );
    case `${origins.web}/`:
      return answer(
        200,
        { "content-security-policy": "default-src 'self'" },
        INDEX
      );
    case `${origins.web}/sw.js`:
      return answer(200, {}, SERVICE_WORKER);
    case `${origins.web}/entrar`:
      return answer(200, {}, INDEX);
    case `${origins.web}/api/auth-methods`:
      return fromWorker(200, {}, json(AUTH_METHODS));
    case `${origins.web}/api/auth/get-session`:
      return fromWorker(200, {}, "null");
    case `${origins.web}/rpc/system/ping`:
      return origin === origins.web
        ? fromWorker(200, {}, json({ json: { message: "pong" } }))
        : fromWorker(403);
    case `${origins.web}/rpc/organization/listMine`:
      return anonymousCall(polarisContract.organization.listMine, init);
    case `${origins.web}/rpc/organization/createInitial`:
      return anonymousCall(polarisContract.organization.createInitial, init);
    case `${origins.catalog}/`:
      return answer(200, {
        "content-security-policy": "script-src 'nonce-abc' 'strict-dynamic'",
      });
    case `${origins.catalog}/robots.txt`:
      return answer(200, { "x-polaris-release": RELEASE }, "User-agent: *\n");
    default:
      return answer(404);
  }
}

/** `override` replaces the answer of one URL; a function there gets the request too. */
const fakeStaging =
  (override = {}) =>
  (url, init) => {
    if (url in override) {
      const replaced = override[url];
      return Promise.resolve(
        typeof replaced === "function" ? replaced(init) : replaced
      );
    }
    return Promise.resolve(stagingAnswer(url, init));
  };

describe("the staging smoke", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when every check answers as expected, with fifteen checks", async () => {
    const fetchImpl = vi.fn(fakeStaging());
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(15);
  });

  it("runs the anonymous /rpc calls that build Better Auth last, after the get-session", () => {
    const names = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    }).map((check) => check.url);
    expect(names).toHaveLength(15);
    expect(names.slice(-2)).toEqual([
      `${origins.web}/rpc/organization/listMine`,
      `${origins.web}/rpc/organization/createInitial`,
    ]);
    expect(names.indexOf(`${origins.web}/api/auth/get-session`)).toBeLessThan(
      13
    );
  });

  it("sends the same-origin Origin from the web origin, and its user agent on every request", async () => {
    const requests = [];
    const fetchImpl = (url, init) => {
      requests.push({
        headers: new Headers(init.headers),
        method: init.method,
        url,
      });
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(
      requests.every(({ headers }) => headers.get("user-agent") === USER_AGENT)
    ).toBe(true);
    const posts = requests.filter(({ method }) => method === "POST");
    expect(posts.map(({ headers }) => headers.get("origin"))).toEqual([
      origins.web,
      null,
      STRANGE_ORIGIN,
      "null",
      origins.web,
      origins.web,
    ]);
    expect(
      posts.every(({ url }) => url.startsWith(`${origins.web}/rpc/`))
    ).toBe(true);
  });

  it("fails on a release different from the deployed commit, and passes when a later attempt has it", async () => {
    let healthCalls = 0;
    const fetchImpl = fakeStaging({
      [`${origins.web}/health`]: () => {
        healthCalls += 1;
        return fromWorker(200, {
          "x-polaris-release": healthCalls === 1 ? "0123456789ab" : RELEASE,
        });
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(healthCalls).toBe(2);

    const stale = fakeStaging({
      [`${origins.web}/health`]: () =>
        fromWorker(200, { "x-polaris-release": "0123456789ab" }),
    });
    expect(await runSmoke(origins, options, stale, noPause)).toEqual([
      "web /health (release of the Worker): 200 release different",
    ]);
  });

  it("fails when a Worker declares no release", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({ [`${origins.catalog}/robots.txt`]: () => answer(200) }),
        noPause
      )
    ).toEqual([
      "catalog /robots.txt (release of the Worker): 200 release absent",
    ]);
  });

  it("fails when the shell served differs from the published artifact", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/`]: () =>
            answer(
              200,
              { "content-security-policy": "default-src 'self'" },
              `${INDEX}<!-- edge -->`
            ),
          [`${origins.web}/sw.js`]: () => answer(200, {}, "old worker"),
        }),
        noPause
      )
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 shell different",
      "web /sw.js (equal to the artifact): 200 service worker different",
    ]);
  });

  it("refuses a HEAD_SHA that is not the 40 lowercase hex characters of a commit, before any request", async () => {
    const fetchImpl = vi.fn();
    for (const commit of [
      undefined,
      "",
      RELEASE,
      COMMIT.toUpperCase(),
      `${COMMIT}0`,
      `${COMMIT.slice(0, 39)}g`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        origins,
        { buildDir, commit },
        fetchImpl,
        noPause
      );
      expect(failures, String(commit)).toEqual([COMMIT_REFUSAL]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails before any request when the published build is not there", async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSmoke(
        origins,
        { buildDir: join(buildDir, "missing"), commit: COMMIT },
        fetchImpl,
        noPause
      )
    ).toEqual([
      "web build: index.html and sw.js of the published build were not found",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the ping without Origin, from a strange origin or with Origin null is answered", async () => {
    const pong = () => fromWorker(200, {}, json({ json: { message: "pong" } }));
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({ [`${origins.web}/rpc/system/ping`]: pong }),
        noPause
      )
    ).toEqual([
      "web POST /rpc/system/ping without Origin (refused): 200 not 403",
      "web POST /rpc/system/ping from a strange origin (refused): 200 not 403",
      "web POST /rpc/system/ping with Origin null (refused): 200 not 403",
    ]);
  });

  it("fails when a strange origin is answered 200 while the others are refused", async () => {
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/system/ping`]: (init) => {
        const origin = new Headers(init.headers).get("origin");
        return origin === origins.web || origin === STRANGE_ORIGIN
          ? fromWorker(200, {}, json({ json: { message: "pong" } }))
          : fromWorker(403);
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web POST /rpc/system/ping from a strange origin (refused): 200 not 403",
    ]);
  });

  it("fails when the ping answers something else than pong", async () => {
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/system/ping`]: (init) =>
        new Headers(init.headers).get("origin") === origins.web
          ? fromWorker(200, {}, "<html>portal</html>")
          : fromWorker(403),
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web POST /rpc/system/ping (the oRPC handler answers): 200 not pong",
    ]);
  });

  it("fails when an anonymous listMine is answered", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/rpc/organization/listMine`]: () =>
            fromWorker(200, {}, json({ json: {} })),
        }),
        noPause
      )
    ).toEqual([
      "web POST /rpc/organization/listMine anonymous (401): 200 not 401",
    ]);
  });

  it("fails when the sign-in methods of staging are not all on", async () => {
    for (const methods of [
      { ...AUTH_METHODS, google: false },
      { ...AUTH_METHODS, emailPassword: false },
      { ...AUTH_METHODS, turnstileSiteKey: null },
      { ...AUTH_METHODS, turnstileSiteKey: " " },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth-methods`]: () =>
            fromWorker(200, {}, json(methods)),
        }),
        noPause
      );
      expect(failures).toEqual([
        "web /api/auth-methods (Google, password and Turnstile configured): 200 sign-in methods different",
      ]);
    }
  });

  it("fails when the get-session is not an empty session, or the auth secrets are missing (503)", async () => {
    const fetchImpl = vi.fn(
      fakeStaging({
        [`${origins.web}/api/auth/get-session`]: () => fromWorker(503),
      })
    );
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web /api/auth/get-session (auth configured, no session): 503 not 200",
    ]);
    // fourteen checks pass at once, the failing one is tried three times
    expect(fetchImpl).toHaveBeenCalledTimes(17);
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth/get-session`]: () =>
            fromWorker(200, {}, json({ user: {} })),
        }),
        noPause
      )
    ).toEqual([
      "web /api/auth/get-session (auth configured, no session): 200 not an empty session",
    ]);
  });

  it("fails an answer of the web Worker without X-Request-Id, the mark that tells it from a captive portal", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth-methods`]: () =>
            answer(200, {}, json(AUTH_METHODS)),
        }),
        noPause
      )
    ).toEqual([
      "web /api/auth-methods (Google, password and Turnstile configured): 200 no X-Request-Id",
    ]);
  });

  it("does not repeat an anonymous /rpc call that failed on the platform (503 or no X-Request-Id), and says cpu/plataforma", async () => {
    let listMineCalls = 0;
    let createInitialCalls = 0;
    const pause = vi.fn(noPause);
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/organization/createInitial`]: () => {
        createInitialCalls += 1;
        return answer(
          500,
          { "content-type": "text/html" },
          "<html>Error 1102</html>"
        );
      },
      [`${origins.web}/rpc/organization/listMine`]: () => {
        listMineCalls += 1;
        return fromWorker(503);
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, pause)).toEqual([
      "web POST /rpc/organization/listMine anonymous (401): cpu/plataforma 503",
      "web POST /rpc/organization/createInitial anonymous (401): cpu/plataforma 500",
    ]);
    expect(listMineCalls).toBe(1);
    expect(createInitialCalls).toBe(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("sends a createInitial body that the contract accepts, so the refusal is the 401 of the session and not a 400", () => {
    const check = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    }).find(({ url }) => url.endsWith("/createInitial"));
    const body = JSON.parse(check.body);
    expect(body).toEqual({ json: CREATE_INITIAL_INPUT });
    const schema =
      polarisContract.organization.createInitial["~orpc"].inputSchema;
    expect(schema.safeParse(body.json).success).toBe(true);
    expect(stagingAnswer(check.url, { body: check.body }).status).toBe(401);
    // control: the body the old smoke would have sent is refused by the contract
    expect(stagingAnswer(check.url, { body: json({}) }).status).toBe(400);
  });

  it("keeps the procedures it calls as the contract declares them: two reads and one write", () => {
    const kindOf = (procedure) => procedure["~orpc"].meta.kind;
    expect(kindOf(polarisContract.system.ping)).toBe("read");
    expect(kindOf(polarisContract.organization.listMine)).toBe("read");
    expect(kindOf(polarisContract.organization.createInitial)).toBe("write");
  });

  it("never logs a body or a header value: only the check, the status and a fixed reason", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = fakeStaging({
      [`${origins.web}/health`]: () =>
        fromWorker(200, { "x-polaris-release": "deadbeefcafe" }, "secret-body"),
      [`${origins.web}/api/auth-methods`]: () =>
        fromWorker(
          200,
          {},
          json({ ...AUTH_METHODS, google: false, secret: "secret-body" })
        ),
    });
    await runSmoke(origins, options, fetchImpl, noPause);
    const printed = log.mock.calls.flat().join("\n");
    for (const leaked of [
      "secret-body",
      "deadbeefcafe",
      RELEASE,
      COMMIT,
      REQUEST_ID,
      "nonce-abc",
      "0x4AAAA",
    ]) {
      expect(printed).not.toContain(leaked);
    }
    expect(printed).toContain(
      "FAIL web /health (release of the Worker): 200 release different"
    );
  });

  it("never posts to a host outside the fixed staging hosts", async () => {
    const fetchImpl = vi.fn();
    for (const url of [
      "https://evil.example/rpc/system/ping",
      "https://dash.araute.app.evil.example/rpc",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await expect(send({ method: "POST", url }, fetchImpl)).rejects.toThrow(
        "post_host_refused"
      );
      expect(
        await attempt(
          { expect: () => true, method: "POST", url },
          fetchImpl,
          noPause
        )
      ).toEqual({
        outcome: "Error",
        passed: false,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure by its name and code only", async () => {
    const fetchImpl = (url, init) =>
      url === `${origins.web}/health`
        ? Promise.reject(
            new TypeError("fetch failed: secret detail", {
              cause: { code: "ENOTFOUND" },
            })
          )
        : fakeStaging()(url, init);
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web /health (release of the Worker): TypeError ENOTFOUND",
    ]);
  });

  it("passes a check that recovers on a later attempt, and gives each request a timeout", async () => {
    let healthCalls = 0;
    const signals = [];
    const pause = vi.fn(noPause);
    const fetchImpl = (url, init) => {
      signals.push(init.signal);
      if (url === `${origins.web}/health`) {
        healthCalls += 1;
        return Promise.resolve(
          healthCalls === 1
            ? fromWorker(503)
            : fromWorker(200, { "x-polaris-release": RELEASE })
        );
      }
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, options, fetchImpl, pause)).toEqual([]);
    expect(healthCalls).toBe(2);
    expect(pause).toHaveBeenCalledOnce();
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("fails when the catalog cannot reach the database (500 instead of 404)", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.catalog}/smoke-staging-loja-inexistente`]: () =>
            answer(500),
        }),
        noPause
      )
    ).toEqual([
      "catalog store page through Hyperdrive (unknown store answers 404): 500 not 404",
    ]);
  });

  it("fails when the catalog page has no nonce in its CSP", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.catalog}/`]: () =>
            answer(200, { "content-security-policy": "script-src 'self'" }),
        }),
        noPause
      )
    ).toEqual(["catalog / (CSP with nonce): 200 no nonce"]);
  });

  it("refuses the workers.dev web, before any request, saying that only the fixed host is accepted", async () => {
    const refusing = vi.fn();
    expect(
      await runSmoke(
        { ...origins, web: "https://polaris-web-staging.example.workers.dev" },
        options,
        refusing,
        noPause
      )
    ).toEqual([
      "web: the staging web only accepts https://dash.araute.app, without a path",
    ]);
    expect(refusing).not.toHaveBeenCalled();
  });

  it("has a refusal message of its own for every key that accepts a host", () => {
    for (const [key, host] of Object.entries(STAGING_FIXED_HOST)) {
      expect(Object.hasOwn(REFUSAL, key)).toBe(true);
      expect(REFUSAL[key]).toContain(`https://${host}`);
    }
    expect(Object.keys(REFUSAL).sort()).toEqual(
      Object.keys(STAGING_FIXED_HOST).sort()
    );
  });

  it("fails loudly for a key with no fixed host or message, naming the key", async () => {
    expect(refusalOf("admin")).toContain("admin:");
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(refusalOf(key)).toContain("no staging host is accepted");
    }
    const fetchImpl = vi.fn();
    const failures = await runSmoke(
      { ...origins, admin: "https://admin.araute.app" },
      options,
      fetchImpl,
      noPause
    );
    expect(failures).toHaveLength(1);
    const inherited = await runSmoke(
      { ...origins, constructor: "https://dash.araute.app" },
      options,
      fetchImpl,
      noPause
    );
    expect(inherited[0]).toContain("constructor: no staging host");
    expect(failures[0].startsWith("admin: no staging host is accepted")).toBe(
      true
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses the workers.dev catalog, before any request", async () => {
    const refusing = vi.fn();
    expect(
      await runSmoke(
        {
          ...origins,
          catalog: "https://polaris-catalog-staging.example.workers.dev",
        },
        options,
        refusing,
        noPause
      )
    ).toEqual([
      "catalog: the staging catalog only accepts https://catalogo.araute.app, without a path",
    ]);
    expect(refusing).not.toHaveBeenCalled();
  });

  it("refuses an origin that is not an https staging origin without a path, before any request", async () => {
    const fetchImpl = vi.fn();
    const refused = (key) => [
      key === "catalog"
        ? "catalog: the staging catalog only accepts https://catalogo.araute.app, without a path"
        : "web: the staging web only accepts https://dash.araute.app, without a path",
    ];
    for (const web of [
      "http://polaris-web-staging.example.workers.dev",
      "https://polaris-web-staging.example.workers.dev/path",
      "https://user:pw@polaris-web-staging.example.workers.dev",
      "https://app.example.com",
      "https://other.araute.app",
      "http://dash.araute.app",
      "https://dash.araute.app/path",
      "https://user:pw@dash.araute.app",
      "https://dash.araute.app.evil.example",
      "https://DASH.araute.app",
      "https://dash.araute.app:8443",
      "https://polaris-web-staging.example.workers.dev:8443",
      "https://dash.araute.app./",
      "https://polaris-web-staging.evil.example",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await runSmoke({ ...origins, web }, options, fetchImpl)).toEqual(
        refused("web")
      );
    }
    expect(
      await runSmoke({ ...origins, catalog: undefined }, options, fetchImpl)
    ).toEqual(refused("catalog"));
    // each fixed host belongs to its own Worker only
    expect(
      await runSmoke(
        { ...origins, catalog: "https://dash.araute.app" },
        options,
        fetchImpl
      )
    ).toEqual(refused("catalog"));
    expect(
      await runSmoke(
        { ...origins, web: "https://catalogo.araute.app" },
        options,
        fetchImpl
      )
    ).toEqual(refused("web"));
    for (const catalog of [
      "http://catalogo.araute.app",
      "https://catalogo.araute.app/path",
      "https://user:pw@catalogo.araute.app",
      "https://catalogo.araute.app.evil.example",
      "https://CATALOGO.araute.app",
      "https://catalogo.araute.app:8443",
      "https://other.araute.app",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        { ...origins, catalog },
        options,
        fetchImpl
      );
      expect(failures).toEqual(refused("catalog"));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the requests of the smoke over the real fetch of Node", () => {
  let server;
  let local = "";
  const received = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({
          body,
          headers: request.headers,
          method: request.method,
          url: request.url,
        });
        response.writeHead(204).end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    local = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("delivers the Origin, the user agent, the content type and the body to the server", async () => {
    const checks = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    });
    const posts = checks.filter((check) => check.method === "POST");
    // the real fetch, only redirected to the local server: what it sends is what the smoke asked for
    const toLocal = (url, init) =>
      fetch(`${local}${new URL(url).pathname}`, init);
    await Promise.all(posts.map((check) => send(check, toLocal)));
    const byOrigin = (origin) =>
      received.filter(({ headers }) => headers.origin === origin);
    expect(
      byOrigin(origins.web)
        .map(({ url }) => url)
        .sort()
    ).toEqual([
      "/rpc/organization/createInitial",
      "/rpc/organization/listMine",
      "/rpc/system/ping",
    ]);
    expect(byOrigin(STRANGE_ORIGIN)).toHaveLength(1);
    expect(byOrigin("null")).toHaveLength(1);
    expect(byOrigin(undefined)).toHaveLength(1);
    for (const request of received) {
      expect(request.method).toBe("POST");
      expect(request.headers["user-agent"]).toBe(USER_AGENT);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    const created = received.find(
      ({ url }) => url === "/rpc/organization/createInitial"
    );
    expect(JSON.parse(created.body)).toEqual({ json: CREATE_INITIAL_INPUT });
  });
});
