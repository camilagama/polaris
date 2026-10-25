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

const response = (status, headers = {}) => ({
  headers: new Headers(headers),
  status,
});

/** A staging that answers every check as expected; `override` replaces the answer of one URL. */
const fakeStaging =
  (override = {}) =>
  (url) => {
    if (url in override) {
      return Promise.resolve(override[url]);
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
      "web /api/auth/get-session (auth configured): 503",
    ]);
    // four checks pass at once, the failing one is tried three times
    expect(fetchImpl).toHaveBeenCalledTimes(7);
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
      "catalog store page through Hyperdrive (unknown store answers 404): 500",
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
    ).toEqual(["catalog / (CSP with nonce): 200"]);
  });

  it("reports a network failure by its name and code only", async () => {
    const fetchImpl = (url) =>
      url === `${origins.web}/health`
        ? Promise.reject(
            new TypeError("fetch failed: secret detail", {
              cause: { code: "ENOTFOUND" },
            })
          )
        : fakeStaging()(url);
    expect(await runSmoke(origins, fetchImpl, noPause)).toEqual([
      "web /health: TypeError ENOTFOUND",
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
      return fakeStaging()(url);
    };
    expect(await runSmoke(origins, fetchImpl, pause)).toEqual([]);
    expect(healthCalls).toBe(2);
    expect(pause).toHaveBeenCalledOnce();
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("accepts the fixed staging web host and checks it like any other staging origin", async () => {
    const urls = [];
    const fetchImpl = (url) => {
      urls.push(url);
      return fakeStaging()(url);
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
    const fetchImpl = (url) => {
      urls.push(url);
      return fakeStaging()(url);
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
});
