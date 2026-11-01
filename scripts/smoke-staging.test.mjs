import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFUSAL,
  refusalOf,
  runSmoke,
  STAGING_FIXED_HOST,
} from "./smoke-staging.mjs";

const origins = {
  catalog: "https://catalogo.araute.app",
  web: "https://dash.araute.app",
};

const noPause = () => Promise.resolve();

const response = (status, headers = {}, body = null) => ({
  headers: new Headers(headers),
  json: () =>
    body === null
      ? Promise.reject(new SyntaxError("no body"))
      : Promise.resolve(body),
  status,
});

const SESSION_REFUSAL = { json: { code: "UNAUTHORIZED", status: 401 } };
const ORIGIN_REFUSAL = { error: { code: "forbidden" } };

const SHELL_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const SIGN_IN_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com/turnstile/v0/api.js; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'";

/** A staging that answers every check as expected; `override` replaces the answer of one URL. */
const fakeStaging =
  (override = {}) =>
  (url, init = {}) => {
    if (url in override) {
      return Promise.resolve(override[url]);
    }
    if (url === `${origins.web}/entrar`) {
      return Promise.resolve(
        response(200, {
          ...SHELL_HEADERS,
          "content-security-policy": SIGN_IN_CSP,
        })
      );
    }
    if (url.startsWith(`${origins.web}/rpc/`)) {
      return Promise.resolve(
        init.headers?.origin === origins.web
          ? response(401, {}, SESSION_REFUSAL)
          : response(403, {}, ORIGIN_REFUSAL)
      );
    }
    if (url.startsWith(origins.catalog)) {
      return Promise.resolve(
        url.endsWith("/")
          ? response(200, {
              "content-security-policy":
                "script-src 'nonce-abc' 'strict-dynamic'",
            })
          : response(404)
      );
    }
    return Promise.resolve(
      response(200, { "content-security-policy": "default-src 'self'" })
    );
  };

describe("the staging smoke", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when every check answers as expected", async () => {
    expect(await runSmoke(origins, fakeStaging(), noPause)).toEqual([]);
  });

  it("fails when the auth secrets are missing (503) and keeps running the other checks", async () => {
    const fetchImpl = vi.fn(
      fakeStaging({
        [`${origins.web}/api/auth/get-session`]: response(503),
      })
    );
    expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([
      "web /api/auth/get-session (auth configured): 503 (expected 200)",
    ]);
    // eight checks pass at once, the failing one is tried three times
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it("fails when the catalog cannot reach the database (500 instead of 404)", async () => {
    expect(
      await runSmoke(
        origins,
        fakeStaging({
          [`${origins.catalog}/smoke-staging-loja-inexistente`]: response(500),
        }),
        noPause
      )
    ).toEqual([
      "catalog store page through Hyperdrive (unknown store answers 404): 500 (expected 404)",
    ]);
  });

  it("fails when the catalog page has no nonce in its CSP", async () => {
    expect(
      await runSmoke(
        origins,
        fakeStaging({
          [`${origins.catalog}/`]: response(200, {
            "content-security-policy": "script-src 'self'",
          }),
        }),
        noPause
      )
    ).toEqual([
      "catalog / (CSP with nonce): 200 (expected 200 with a nonce in the CSP)",
    ]);
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
    expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([
      "web /health: TypeError ENOTFOUND (expected 200)",
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
        return Promise.resolve(response(healthCalls === 1 ? 503 : 200));
      }
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, fetchImpl, pause)).toEqual([]);
    expect(healthCalls).toBe(2);
    expect(pause).toHaveBeenCalledOnce();
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("accepts the fixed staging web host and checks it like any other staging origin", async () => {
    const urls = [];
    const fetchImpl = (url, init) => {
      urls.push(url);
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([]);
    expect(urls).toContain(`${origins.web}/health`);
  });

  it("refuses the workers.dev web, before any request, saying that only the fixed host is accepted", async () => {
    const refusing = vi.fn();
    expect(
      await runSmoke(
        {
          ...origins,
          web: "https://polaris-web-staging.example.workers.dev",
        },
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
      fetchImpl,
      noPause
    );
    expect(failures).toHaveLength(1);
    const inherited = await runSmoke(
      { ...origins, constructor: "https://dash.araute.app" },
      fetchImpl,
      noPause
    );
    expect(inherited[0]).toContain("constructor: no staging host");
    expect(failures[0].startsWith("admin: no staging host is accepted")).toBe(
      true
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the fixed staging catalog host and refuses the workers.dev one, before any request", async () => {
    const urls = [];
    const fetchImpl = (url, init) => {
      urls.push(url);
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([]);
    expect(urls).toContain(`${origins.catalog}/`);

    const refusing = vi.fn();
    expect(
      await runSmoke(
        {
          ...origins,
          catalog: "https://polaris-catalog-staging.example.workers.dev",
        },
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
      expect(await runSmoke({ ...origins, web }, fetchImpl)).toEqual(
        refused("web")
      );
    }
    expect(
      await runSmoke({ ...origins, catalog: undefined }, fetchImpl)
    ).toEqual(refused("catalog"));
    // each fixed host belongs to its own Worker only
    expect(
      await runSmoke(
        { ...origins, catalog: "https://dash.araute.app" },
        fetchImpl
      )
    ).toEqual(refused("catalog"));
    expect(
      await runSmoke(
        { ...origins, web: "https://catalogo.araute.app" },
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
      expect(await runSmoke({ ...origins, catalog }, fetchImpl)).toEqual(
        refused("catalog")
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  describe("the checks of the sign-in page and of /rpc", () => {
    const run = (override) => runSmoke(origins, fakeStaging(override), noPause);
    const rpc = (procedure) => `${origins.web}/rpc/category/${procedure}`;

    it("reads the sign-in page: 200, the shell headers and the Turnstile CSP", async () => {
      const entrar = `${origins.web}/entrar`;
      const signIn = (headers) => response(200, headers);
      const complete = {
        ...SHELL_HEADERS,
        "content-security-policy": SIGN_IN_CSP,
      };
      expect(await run({ [entrar]: signIn(complete) })).toEqual([]);
      for (const [name, headers] of [
        ["no nosniff", { ...complete, "x-content-type-options": undefined }],
        ["no frame protection", { ...complete, "x-frame-options": undefined }],
        ["no HSTS", { ...complete, "strict-transport-security": undefined }],
        [
          "HSTS without max-age",
          { ...complete, "strict-transport-security": "preload" },
        ],
        ["no COOP", { ...complete, "cross-origin-opener-policy": undefined }],
        [
          "COOP unsafe-none",
          { ...complete, "cross-origin-opener-policy": "unsafe-none" },
        ],
        ["no Referrer-Policy", { ...complete, "referrer-policy": undefined }],
        [
          "Referrer-Policy unsafe-url",
          { ...complete, "referrer-policy": "unsafe-url" },
        ],
        [
          "nosniff with another value",
          { ...complete, "x-content-type-options": "sniff" },
        ],
        [
          "frame protection with another value",
          { ...complete, "x-frame-options": "SAMEORIGIN" },
        ],
        [
          "a Turnstile script followed by another source",
          {
            ...complete,
            "content-security-policy": SIGN_IN_CSP.replace(
              "turnstile/v0/api.js;",
              "turnstile/v0/api.js https://evil.example;"
            ),
          },
        ],
        [
          "the shell CSP without the Turnstile script",
          { ...complete, "content-security-policy": "default-src 'self'" },
        ],
        [
          "a CSP that can be framed",
          {
            ...complete,
            "content-security-policy": SIGN_IN_CSP.replace(
              "frame-ancestors 'none'",
              "frame-ancestors *"
            ),
          },
        ],
      ]) {
        const defined = Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value !== undefined)
        );
        // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
        expect(await run({ [entrar]: signIn(defined) }), name).toEqual([
          "web /entrar (sign-in page with its headers): 200 (expected 200 with the shell headers and the Turnstile CSP)",
        ]);
      }
      expect(await run({ [entrar]: response(404, complete) })).toEqual([
        "web /entrar (sign-in page with its headers): 404 (expected 200 with the shell headers and the Turnstile CSP)",
      ]);
    });

    it("sends a valid anonymous input with the Origin of the web, so the 401 is the session and not the input", async () => {
      const calls = [];
      const fetchImpl = (url, init) => {
        calls.push({ init, url });
        return fakeStaging()(url, init);
      };
      expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([]);
      const nilId = "00000000-0000-4000-8000-000000000000";
      const rpcCalls = calls.filter(({ url }) => url.includes("/rpc/"));
      expect(
        rpcCalls.map(({ init, url }) => [
          url,
          init.method,
          init.headers.origin,
          init.headers["content-type"],
          JSON.parse(init.body),
        ])
      ).toEqual([
        [
          rpc("list"),
          "POST",
          origins.web,
          "application/json",
          { json: { organizationId: nilId } },
        ],
        [
          rpc("archive"),
          "POST",
          origins.web,
          "application/json",
          { json: { id: nilId, organizationId: nilId } },
        ],
        [
          rpc("archive"),
          "POST",
          "https://forged-origin.invalid",
          "application/json",
          { json: { id: nilId, organizationId: nilId } },
        ],
      ]);
    });

    it("fails when the read answers a 5xx instead of the 401, and says what it expected", async () => {
      expect(await run({ [rpc("list")]: response(500) })).toEqual([
        "web /rpc read without a session (refused, not a 5xx): 500 (expected 401 UNAUTHORIZED from the Worker)",
      ]);
    });

    it("fails when the read is not refused (200) or is refused as input (400)", async () => {
      const statuses = [200, 400];
      const results = await Promise.all(
        statuses.map((status) => run({ [rpc("list")]: response(status) }))
      );
      expect(results).toEqual(
        statuses.map((status) => [
          `web /rpc read without a session (refused, not a 5xx): ${status} (expected 401 UNAUTHORIZED from the Worker)`,
        ])
      );
    });

    it("fails when the write with the right Origin is not refused for the session", async () => {
      const fetchImpl = (url, init) =>
        url === rpc("archive") && init.headers.origin === origins.web
          ? Promise.resolve(response(502))
          : fakeStaging()(url, init);
      expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([
        "web /rpc write with the right Origin and no session (refused, not a 5xx): 502 (expected 401 UNAUTHORIZED from the Worker)",
      ]);
    });

    it("fails when a forged Origin is not refused by the origin check", async () => {
      const fetchImpl = (url, init) =>
        url === rpc("archive") && init.headers.origin !== origins.web
          ? Promise.resolve(response(401, {}, SESSION_REFUSAL))
          : fakeStaging()(url, init);
      expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([
        "web /rpc write with a forged Origin (origin check): 401 (expected 403 forbidden from the origin check)",
      ]);
    });

    it("does not take a 401 or a 403 of another layer for the Worker's refusal", async () => {
      const edge401 = response(401, {}, { message: "Access denied" });
      const edgeHtml403 = response(403);
      const forgedFetch = (url, init) => {
        if (url === rpc("archive") && init.headers.origin !== origins.web) {
          return Promise.resolve(edgeHtml403);
        }
        return fakeStaging({ [rpc("list")]: edge401 })(url, init);
      };
      expect(await runSmoke(origins, forgedFetch, noPause)).toEqual([
        "web /rpc read without a session (refused, not a 5xx): 401 (expected 401 UNAUTHORIZED from the Worker)",
        "web /rpc write with a forged Origin (origin check): 403 (expected 403 forbidden from the origin check)",
      ]);
    });
  });
});
