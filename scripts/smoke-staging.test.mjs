import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSmoke } from "./smoke-staging.mjs";

const origins = {
  catalog: "https://polaris-catalog-staging.example.workers.dev",
  web: "https://polaris-web-staging.example.workers.dev",
};

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
    expect(await runSmoke(origins, fakeStaging())).toEqual([]);
  });

  it("fails when the auth secrets are missing (503) and keeps running the other checks", async () => {
    const fetchImpl = vi.fn(
      fakeStaging({
        [`${origins.web}/api/auth/get-session`]: response(503),
      })
    );
    expect(await runSmoke(origins, fetchImpl)).toEqual([
      "web /api/auth/get-session (auth configured): 503",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("fails when the catalog cannot reach the database (500 instead of 404)", async () => {
    expect(
      await runSmoke(
        origins,
        fakeStaging({
          [`${origins.catalog}/smoke-staging-loja-inexistente`]: response(500),
        })
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
        })
      )
    ).toEqual(["catalog / (CSP with nonce): 200"]);
  });

  it("reports a network failure by its name only", async () => {
    const fetchImpl = (url) =>
      url === `${origins.web}/health`
        ? Promise.reject(new TypeError("fetch failed: secret detail"))
        : fakeStaging()(url);
    expect(await runSmoke(origins, fetchImpl)).toEqual([
      "web /health: TypeError",
    ]);
  });

  it("refuses an origin that is not https or has a path, before any request", async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSmoke({ ...origins, web: "http://localhost:5173" }, fetchImpl)
    ).toEqual(["web: the staging origin must be https://host, without a path"]);
    expect(
      await runSmoke({ ...origins, catalog: undefined }, fetchImpl)
    ).toEqual([
      "catalog: the staging origin must be https://host, without a path",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
