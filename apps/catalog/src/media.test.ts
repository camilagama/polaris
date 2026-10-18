import { describe, expect, it, vi } from "vitest";
import {
  type AuthorizedMedia,
  MEDIA_MAX_AGE_SECONDS,
  type MediaDependencies,
  serveMedia,
} from "./media";

const slug = "loja-da-ana";
const productId = "0199a0a0-0000-7000-8000-000000000001";
const assetId = "0199a0a0-0000-7000-8000-000000000002";
const masterKey = "media/v2/org/product/cmd/fingerprint/attempt.webp";
const authorized: AuthorizedMedia = {
  byteSize: 4,
  contentType: "image/webp",
  storageKey: masterKey,
};

function body(text: string) {
  return {
    body: new Response(text).body as ReadableStream,
    size: text.length,
  };
}

function setup(overrides: Partial<MediaDependencies> = {}) {
  const getObject = vi.fn((key: string) =>
    Promise.resolve(key === masterKey ? body("master") : null)
  );
  const authorize = vi.fn(() =>
    Promise.resolve<AuthorizedMedia | null>(authorized)
  );
  const report = vi.fn();
  const dependencies: MediaDependencies = {
    authorize,
    getObject,
    report,
    ...overrides,
  };
  const serve = (
    overrideRequest: Partial<Parameters<typeof serveMedia>[0]> = {}
  ) =>
    serveMedia(
      {
        assetId,
        ifNoneMatch: null,
        productId,
        size: null,
        slug,
        ...overrideRequest,
      },
      dependencies
    );
  return { authorize, getObject, report, serve };
}

describe("serving a public image", () => {
  it("serves the master of an image that may be shown, briefly cacheable", async () => {
    const { serve, authorize } = setup();
    const response = await serve({ slug: "LOJA-DA-ANA" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("master");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe(
      `public, max-age=${MEDIA_MAX_AGE_SECONDS}, s-maxage=${MEDIA_MAX_AGE_SECONDS}`
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"${assetId}-master"`);
    expect(authorize).toHaveBeenCalledWith({ assetId, productId, slug });
  });

  it("is embeddable by any origin and inert if a browser opens it as a document", async () => {
    const missing = setup({ authorize: () => Promise.resolve(null) });
    const down = setup({
      getObject: () => Promise.reject(new Error("bucket down")),
    });

    const responses = await Promise.all([
      setup().serve(),
      missing.serve(),
      down.serve(),
    ]);
    for (const response of responses) {
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "cross-origin"
      );
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox"
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("serves the derivative when it exists and the master until then", async () => {
    const derivativeKey = `media/derivatives/v1/${assetId}/320.webp`;
    const withDerivative = setup({
      getObject: (key) => {
        const objects: Record<string, string> = {
          [derivativeKey]: "small",
          [masterKey]: "master",
        };
        const content = objects[key];
        return Promise.resolve(content === undefined ? null : body(content));
      },
    });
    const small = await withDerivative.serve({ size: "320" });
    expect(await small.text()).toBe("small");
    expect(small.headers.get("etag")).toBe(`"${assetId}-320"`);

    const without = setup();
    const fallback = await without.serve({ size: "640" });
    expect(await fallback.text()).toBe("master");
    expect(fallback.headers.get("etag")).toBe(`"${assetId}-master"`);
  });

  it("answers 304 to a matching ETag, after authorizing", async () => {
    const { serve, authorize } = setup();
    const response = await serve({ ifNoneMatch: `W/"${assetId}-master", "x"` });
    expect(response.status).toBe(304);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("does not answer 304 for an image that may no longer be shown", async () => {
    const { serve, getObject } = setup({
      authorize: () => Promise.resolve(null),
    });
    const response = await serve({ ifNoneMatch: `"${assetId}-master"` });
    expect(response.status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("cancels the object it does not send on a 304, and survives a cancel that fails", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("closed")));
    const { serve } = setup({
      getObject: () =>
        Promise.resolve({
          body: { cancel } as unknown as ReadableStream,
          size: 1,
        }),
    });
    const response = await serve({ ifNoneMatch: `"${assetId}-master"` });
    expect(response.status).toBe(304);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("is a 404 for an image that may not be shown, with nothing read from the bucket", async () => {
    const { serve, getObject } = setup({
      authorize: () => Promise.resolve(null),
    });
    const response = await serve();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("max-age=15");
    expect(getObject).not.toHaveBeenCalled();
  });

  it("is a 404 without asking the database for what cannot be an address, an ID or a size", async () => {
    const { serve, authorize } = setup();
    for (const bad of [
      { slug: "../x" },
      { slug: "ab" },
      { productId: "not-a-uuid" },
      { assetId: "not-a-uuid" },
      { size: "1200" },
      { size: "320; drop" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: A handful of probes, in order.
      expect((await serve(bad)).status).toBe(404);
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it("is a 404 when the object is gone, and reports it", async () => {
    const { serve, report } = setup({ getObject: () => Promise.resolve(null) });
    expect((await serve()).status).toBe(404);
    expect(report).toHaveBeenCalled();
  });

  it("never shows the visitor why something failed", async () => {
    const failing = setup({
      authorize: () =>
        Promise.reject(
          new Error('password authentication failed for user "x"')
        ),
    });
    const response = await failing.serve();
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Unavailable");
    expect(failing.report).toHaveBeenCalled();

    const bucketDown = setup({
      getObject: () => Promise.reject(new Error("r2 down")),
    });
    expect((await bucketDown.serve()).status).toBe(502);
  });

  it("never puts the storage path in what it returns", async () => {
    const { serve } = setup();
    const response = await serve();
    const headers = [...response.headers.entries()].flat().join(" ");
    expect(headers).not.toContain("media/v2");
  });
});
