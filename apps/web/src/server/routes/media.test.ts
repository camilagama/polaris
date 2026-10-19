import {
  InvalidMediaOrderError,
  MediaImageProcessingError,
  MediaTransformQuotaExceededError,
  ProductMediaLimitError,
} from "@polaris/domain/catalog/media";
import {
  ProductDeletedError,
  ProductVariantNotFoundError,
} from "@polaris/domain/catalog/product";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaBucketBinding, ServerEnv } from "../environment";
import { requestIdMiddleware } from "../middleware/request-id";
import { createMediaRoutes, type MediaRouteDependencies } from "./media";

const organizationId = "org/with space";
const productId = "0199c2d0-0000-7000-8000-000000000001";
const uploadCommandId = "de305d54-75b4-431b-adb2-eb6b9e546014";
const stagingKeyPattern = /^media\/staging\/v1\//;
interface TestIdentity {
  capability: string;
  organizationId: string;
  role: string;
  userId: string;
}
const mediaAsset = {
  assetId: "0199c2d0-0000-7000-8000-000000000002",
  byteSize: 4,
  contentType: "image/webp" as const,
  createdAt: "2026-10-10T12:00:00.000Z",
  height: 200,
  position: 0,
  variantIds: [],
  width: 600,
};

function bodyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function createTestApp(overrides: Partial<MediaRouteDependencies> = {}) {
  const stored = new Map<string, Uint8Array>();
  const mediaBucket: MediaBucketBinding = {
    delete: vi.fn((key) => {
      stored.delete(key);
      return Promise.resolve();
    }),
    get: vi.fn((key) => {
      const bytes = stored.get(key);
      if (!bytes) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(bodyBuffer(bytes)),
        body: new Response(bodyBuffer(bytes))
          .body as ReadableStream<Uint8Array>,
        httpEtag: '"test-etag"',
        size: bytes.byteLength,
        uploaded: new Date("2026-10-10T12:00:00.000Z"),
      });
    }),
    list: vi.fn(() => Promise.resolve({ objects: [], truncated: false })),
    put: vi.fn((key, value, options) => {
      if (options?.onlyIf?.get("if-none-match") === "*" && stored.has(key)) {
        return Promise.resolve(null);
      }
      stored.set(key, new Uint8Array(value));
      return Promise.resolve({ etag: "test-etag" });
    }),
  };
  const identity = {
    capability: "product:update",
    organizationId,
    role: "owner",
    userId: "verified-session-user",
  };
  const dependencies = {
    assertProductCanReceiveMedia: vi.fn(() => Promise.resolve(undefined)),
    createProductMediaAsset: vi.fn(() =>
      Promise.resolve({
        asset: mediaAsset,
        replayed: false,
      })
    ),
    findMediaUploadCommand: vi.fn(() => Promise.resolve(undefined)),
    getMediaAssetForDelivery: vi.fn(() => Promise.resolve(null)),
    listProductMedia: vi.fn(() => Promise.resolve([])),
    processMediaImage: vi.fn(() =>
      Promise.resolve({
        byteLength: 4,
        bytes: new Uint8Array([82, 73, 70, 70]),
        contentType: "image/webp" as const,
        height: 200,
        width: 600,
      })
    ),
    removeProductMedia: vi.fn(() => Promise.resolve({ removed: true })),
    reorderProductMedia: vi.fn(() => Promise.resolve([mediaAsset])),
    processMediaDerivative: vi.fn(({ maxEdge }: { maxEdge: 320 | 640 }) =>
      Promise.resolve({
        byteLength: 4,
        bytes: new Uint8Array([82, 73, 70, 70]),
        contentType: "image/webp" as const,
        height: maxEdge / 2,
        width: maxEdge,
      })
    ),
    withTenantRequestContext: vi.fn(
      ({
        operation,
      }: {
        operation: (
          transaction: unknown,
          identity: TestIdentity
        ) => Promise<unknown>;
      }) => operation({}, identity)
    ),
    ...overrides,
  } as unknown as MediaRouteDependencies;
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.route("/", createMediaRoutes(dependencies));
  const bindings = { ...testBindings, MEDIA_BUCKET: mediaBucket };
  return { app, bindings, dependencies, mediaBucket, stored };
}

function uploadRequest(input: {
  body?: Uint8Array;
  contentLength?: string;
  crop?: string;
  variantIds?: string;
}) {
  return new Request(
    `https://polaris.example.invalid/api/products/${productId}/media`,
    {
      ...(input.body === undefined ? {} : { body: bodyBuffer(input.body) }),
      headers: {
        "content-length":
          input.contentLength ?? String(input.body?.byteLength ?? 0),
        "content-type": "image/jpeg",
        "x-media-crop":
          input.crop ?? JSON.stringify({ height: 1, width: 1, x: 0, y: 0 }),
        "x-organization-id": organizationId,
        "x-product-variant-ids": input.variantIds ?? "[]",
        "x-upload-id": uploadCommandId,
      },
      method: "POST",
    }
  );
}

const testBindings: ServerEnv["Bindings"] = {
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  IMAGES: {} as never,
};

describe("media upload route", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a private WebP object and commits the product media association", async () => {
    const { app, bindings, dependencies, mediaBucket, stored } =
      createTestApp();
    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      asset: mediaAsset,
      replayed: false,
    });
    // the staging marker, the master, and the two derivatives the public catalog reads
    expect(mediaBucket.put).toHaveBeenCalledTimes(4);
    const [stagingKey, , stagingOptions] =
      vi.mocked(mediaBucket.put).mock.calls[0] ?? [];
    const [key, , options] = vi.mocked(mediaBucket.put).mock.calls[1] ?? [];
    expect(stagingKey).toMatch(stagingKeyPattern);
    expect(stagingOptions?.httpMetadata).toEqual({
      cacheControl: "private, no-store",
      contentType: "application/json",
    });
    expect(key).toContain(`media/v2/${encodeURIComponent(organizationId)}/`);
    expect(options?.httpMetadata).toEqual({
      cacheControl: "private, no-store",
      contentType: "image/webp",
    });
    expect(options?.onlyIf?.get("if-none-match")).toBe("*");
    expect(
      vi
        .mocked(mediaBucket.put)
        .mock.calls.slice(2)
        .map(([derivativeKey]) => derivativeKey)
    ).toEqual([
      `media/derivatives/v1/${mediaAsset.assetId}/320.webp`,
      `media/derivatives/v1/${mediaAsset.assetId}/640.webp`,
    ]);
    expect(stored.size).toBe(3);
    expect(dependencies.createProductMediaAsset).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when a derivative cannot be made, leaving it for the first request", async () => {
    const { app, bindings, mediaBucket, stored } = createTestApp({
      processMediaDerivative: vi.fn(() =>
        Promise.reject(new Error("images down"))
      ),
    });
    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(201);
    expect(mediaBucket.put).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(1);
  });

  it("rejects an excessive declared size before authentication or body processing", async () => {
    const { app, bindings, dependencies, mediaBucket } = createTestApp();
    const response = await app.fetch(
      uploadRequest({ contentLength: "20000001" }),
      bindings
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "media_image_too_large" },
    });
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
    expect(mediaBucket.put).not.toHaveBeenCalled();
  });

  it("rejects malformed crop data before reading or storing the upload", async () => {
    const { app, bindings, dependencies, mediaBucket } = createTestApp();
    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1]), crop: "not-json" }),
      bindings
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_media_crop" },
    });
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
    expect(mediaBucket.put).not.toHaveBeenCalled();
  });

  it("validates variant ownership before writing an object to R2", async () => {
    const invalidVariantId = "0199c2d0-0000-7000-8000-000000000099";
    const { app, bindings, dependencies, mediaBucket } = createTestApp({
      assertProductCanReceiveMedia: vi.fn(() =>
        Promise.reject(new ProductVariantNotFoundError())
      ),
    });
    const response = await app.fetch(
      uploadRequest({
        body: new Uint8Array([1, 2, 3]),
        variantIds: JSON.stringify([invalidVariantId]),
      }),
      bindings
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(dependencies.assertProductCanReceiveMedia).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      productId,
      [invalidVariantId]
    );
    expect(dependencies.processMediaImage).not.toHaveBeenCalled();
    expect(mediaBucket.put).not.toHaveBeenCalled();
  });

  it("removes its newly stored object when a tombstone wins before the DB commit", async () => {
    const { app, bindings, mediaBucket, stored } = createTestApp({
      createProductMediaAsset: vi.fn(() =>
        Promise.reject(new ProductDeletedError())
      ),
    });
    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(404);
    expect(mediaBucket.put).toHaveBeenCalledTimes(2);
    expect(mediaBucket.delete).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it("deletes an unreferenced physical attempt after an idempotent replay", async () => {
    const { app, bindings, mediaBucket, stored } = createTestApp({
      createProductMediaAsset: vi.fn(() =>
        Promise.resolve({ asset: mediaAsset, replayed: true })
      ),
    });

    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(200);
    expect(mediaBucket.put).toHaveBeenCalledTimes(2);
    expect(mediaBucket.delete).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it.each([320, 640] as const)(
    "generates and privately caches the %i-pixel derivative after tenant authorization",
    async (size) => {
      const storageKey = `media/v2/${encodeURIComponent(organizationId)}/${productId}/${uploadCommandId}/${"a".repeat(64)}/de305d54-75b4-431b-adb2-eb6b9e546015.webp`;
      const { app, bindings, dependencies, mediaBucket, stored } =
        createTestApp({
          getMediaAssetForDelivery: vi.fn(() =>
            Promise.resolve({
              assetId: mediaAsset.assetId,
              byteSize: 4,
              contentType: "image/webp" as const,
              height: 200,
              storageKey,
              width: 600,
            })
          ),
        });
      stored.set(storageKey, new Uint8Array([82, 73, 70, 70]));

      const response = await app.fetch(
        new Request(
          `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=${size}`
        ),
        bindings
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(dependencies.processMediaDerivative).toHaveBeenCalledWith({
        images: bindings.IMAGES,
        maxEdge: size,
        sourceBytes: new Uint8Array([82, 73, 70, 70]),
      });
      expect(mediaBucket.put).toHaveBeenCalledWith(
        `media/derivatives/v1/${mediaAsset.assetId}/${size}.webp`,
        expect.any(Uint8Array),
        expect.objectContaining({
          httpMetadata: {
            cacheControl: "private, no-store",
            contentType: "image/webp",
          },
        })
      );
    }
  );

  it("refuses the upload with a stable code when Images is over its quota, storing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, bindings, dependencies, mediaBucket, stored } = createTestApp({
      processMediaImage: vi.fn(() =>
        Promise.reject(new MediaTransformQuotaExceededError())
      ),
    });

    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "media_transform_quota_exceeded" },
    });
    expect(mediaBucket.put).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    expect(dependencies.createProductMediaAsset).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    const [entry] = warn.mock.calls[0] ?? [];
    expect(entry).toMatchObject({
      errorCode: "9422",
      event: "media_transform_quota_exceeded",
      operation: "media.upload",
      outcome: "rejected",
      provider: "cloudflare_images",
      reason: "transform_quota_exceeded",
      route: "/api/products/:productId/media",
    });
    expect(JSON.stringify(entry)).not.toContain(organizationId);
    warn.mockRestore();
  });

  it("keeps the upload and logs the event when only the derivatives hit the quota", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const derivativeProcessor = vi.fn(() =>
      Promise.reject(Object.assign(new Error("limit"), { code: 9422 }))
    );
    const { app, bindings, stored } = createTestApp({
      processMediaDerivative: derivativeProcessor,
    });

    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(201);
    expect(stored.size).toBe(1);
    expect(derivativeProcessor).toHaveBeenCalledTimes(1);
    const events = warn.mock.calls.map(([entry]) => entry?.event);
    expect(events).toContain("media_transform_quota_exceeded");
    expect(events).toContain("media_derivative_deferred");
    warn.mockRestore();
  });

  it.each([320, 640] as const)(
    "serves the master with a short private cache when Images is over quota (%i)",
    async (size) => {
      // each case starts after the delivery log window of the previous one
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 0, size)));
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const storageKey = `media/v2/${encodeURIComponent(organizationId)}/${productId}/${uploadCommandId}/${"a".repeat(64)}/de305d54-75b4-431b-adb2-eb6b9e546015.webp`;
      const { app, bindings, mediaBucket, stored } = createTestApp({
        getMediaAssetForDelivery: vi.fn(() =>
          Promise.resolve({
            assetId: mediaAsset.assetId,
            byteSize: 4,
            contentType: "image/webp" as const,
            height: 200,
            storageKey,
            width: 600,
          })
        ),
        processMediaDerivative: vi.fn(() =>
          Promise.reject(new MediaTransformQuotaExceededError())
        ),
      });
      stored.set(storageKey, new Uint8Array([82, 73, 70, 70]));

      const response = await app.fetch(
        new Request(
          `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=${size}`
        ),
        bindings
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("cache-control")).toBe("private, max-age=60");
      expect(response.headers.get("x-media-fallback")).toBe("master");
      expect(response.headers.get("content-length")).toBe("4");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([82, 73, 70, 70])
      );
      // the fallback is never stored as if it were the derivative
      expect(mediaBucket.put).not.toHaveBeenCalled();
      const [entry] = warn.mock.calls[0] ?? [];
      expect(entry).toMatchObject({
        errorCode: "9422",
        event: "media_transform_quota_exceeded",
        operation: "media.delivery",
        outcome: "partial",
        provider: "cloudflare_images",
      });
      warn.mockRestore();
    }
  );

  it("logs one delivery fallback event per window and counts the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 2)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storageKey = `media/v2/${encodeURIComponent(organizationId)}/${productId}/${uploadCommandId}/${"a".repeat(64)}/de305d54-75b4-431b-adb2-eb6b9e546015.webp`;
    const { app, bindings, stored } = createTestApp({
      getMediaAssetForDelivery: vi.fn(() =>
        Promise.resolve({
          assetId: mediaAsset.assetId,
          byteSize: 4,
          contentType: "image/webp" as const,
          height: 200,
          storageKey,
          width: 600,
        })
      ),
      processMediaDerivative: vi.fn(() =>
        Promise.reject(new MediaTransformQuotaExceededError())
      ),
    });
    stored.set(storageKey, new Uint8Array([82, 73, 70, 70]));
    const deliver = () =>
      app.fetch(
        new Request(
          `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=320`
        ),
        bindings
      );
    const quotaEvents = () =>
      warn.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry?.event === "media_transform_quota_exceeded");

    const responses = await Promise.all([deliver(), deliver(), deliver()]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(quotaEvents()).toHaveLength(1);

    vi.setSystemTime(new Date(Date.UTC(2026, 9, 2, 0, 1, 1)));
    expect((await deliver()).status).toBe(200);
    expect(quotaEvents()).toHaveLength(2);
    expect(quotaEvents()[1]).toMatchObject({ suppressed: 2 });
    warn.mockRestore();
  });

  it("does not hide other derivative failures behind the master", async () => {
    const storageKey = `media/v2/${encodeURIComponent(organizationId)}/${productId}/${uploadCommandId}/${"a".repeat(64)}/de305d54-75b4-431b-adb2-eb6b9e546015.webp`;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { app, bindings, stored } = createTestApp({
      getMediaAssetForDelivery: vi.fn(() =>
        Promise.resolve({
          assetId: mediaAsset.assetId,
          byteSize: 4,
          contentType: "image/webp" as const,
          height: 200,
          storageKey,
          width: 600,
        })
      ),
      processMediaDerivative: vi.fn(() =>
        Promise.reject(new MediaImageProcessingError())
      ),
    });
    stored.set(storageKey, new Uint8Array([82, 73, 70, 70]));

    const response = await app.fetch(
      new Request(
        `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=320`
      ),
      bindings
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-media-fallback")).toBeNull();
    error.mockRestore();
  });

  it("serves a cached derivative without reprocessing", async () => {
    const storageKey = `media/v2/${encodeURIComponent(organizationId)}/${productId}/${uploadCommandId}/${"a".repeat(64)}/de305d54-75b4-431b-adb2-eb6b9e546015.webp`;
    const { app, bindings, dependencies, stored } = createTestApp({
      getMediaAssetForDelivery: vi.fn(() =>
        Promise.resolve({
          assetId: mediaAsset.assetId,
          byteSize: 4,
          contentType: "image/webp" as const,
          height: 200,
          storageKey,
          width: 600,
        })
      ),
    });
    stored.set(storageKey, new Uint8Array([82, 73, 70, 70]));
    stored.set(
      `media/derivatives/v1/${mediaAsset.assetId}/320.webp`,
      new Uint8Array([82, 73, 70, 70])
    );

    const response = await app.fetch(
      new Request(
        `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=320`
      ),
      bindings
    );

    expect(response.status).toBe(200);
    expect(dependencies.processMediaDerivative).not.toHaveBeenCalled();
  });

  it("rejects derivative sizes outside the supported set", async () => {
    const { app, bindings, dependencies, mediaBucket } = createTestApp();
    const response = await app.fetch(
      new Request(
        `https://polaris.example.invalid/api/media/${mediaAsset.assetId}?organizationId=${encodeURIComponent(organizationId)}&size=800`
      ),
      bindings
    );

    expect(response.status).toBe(400);
    expect(dependencies.getMediaAssetForDelivery).not.toHaveBeenCalled();
    expect(mediaBucket.get).not.toHaveBeenCalled();
  });

  it("answers 404 for malformed asset ids without opening a database transaction", async () => {
    const { app, bindings, dependencies } = createTestApp();

    const statuses = await Promise.all(
      ["not-a-uuid", "1", "%27%3B%20DROP%20TABLE", "0".repeat(36)].map(
        async (assetId) =>
          (
            await app.fetch(
              new Request(
                `https://polaris.example.invalid/api/media/${assetId}?organizationId=${encodeURIComponent(organizationId)}`
              ),
              bindings
            )
          ).status
      )
    );

    expect(statuses).toEqual([404, 404, 404, 404]);
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
    expect(dependencies.getMediaAssetForDelivery).not.toHaveBeenCalled();
  });

  it("answers 404 for malformed product ids without opening a database transaction", async () => {
    const { app, bindings, dependencies } = createTestApp();

    const response = await app.fetch(
      new Request(
        `https://polaris.example.invalid/api/products/not-a-uuid/media?organizationId=${encodeURIComponent(organizationId)}`
      ),
      bindings
    );

    expect(response.status).toBe(404);
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
    expect(dependencies.listProductMedia).not.toHaveBeenCalled();
  });

  it("maps the per-product media ceiling to a stable 409 and removes the stored object", async () => {
    const { app, bindings, mediaBucket, stored } = createTestApp({
      createProductMediaAsset: vi.fn(() =>
        Promise.reject(new ProductMediaLimitError())
      ),
    });
    const response = await app.fetch(
      uploadRequest({ body: new Uint8Array([1, 2, 3]) }),
      bindings
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "product_media_limit" },
    });
    expect(mediaBucket.delete).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it("logs unexpected failures without personal data and keeps the response generic", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const databaseFailure = Object.assign(
      new Error(
        'duplicate key value violates unique constraint for "ana@example.com"'
      ),
      { code: "23505", name: "DatabaseError" }
    );
    const { app, bindings } = createTestApp({
      listProductMedia: vi.fn(() => Promise.reject(databaseFailure)),
    });

    const response = await app.fetch(
      new Request(
        `https://polaris.example.invalid/api/products/${productId}/media?organizationId=${encodeURIComponent(organizationId)}`
      ),
      bindings
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("ana@example.com");
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "internal_error" },
    });
    expect(logger).toHaveBeenCalledOnce();
    const [entry] = logger.mock.calls[0] ?? [];
    expect(entry).toMatchObject({
      errorCode: "23505",
      errorClass: "DatabaseError",
      event: "server_error",
      method: "GET",
      route: "/api/products/:productId/media",
      httpStatus: 500,
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("ana@example.com");
    expect(serialized).not.toContain(organizationId);
    expect(serialized).not.toContain(productId);
    expect(serialized).not.toContain("stack");
    logger.mockRestore();
  });
});

const { assetId: imageId } = mediaAsset;
const mediaUrl = `https://polaris.example.invalid/api/products/${productId}/media`;

describe("media removal and order routes", () => {
  it("removes an image under the product update capability and the organization header", async () => {
    const { app, bindings, dependencies } = createTestApp();

    const response = await app.fetch(
      new Request(`${mediaUrl}/${imageId}`, {
        headers: { "x-organization-id": organizationId },
        method: "DELETE",
      }),
      bindings
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ removed: true });
    expect(dependencies.withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "product:update",
        requestedOrganizationId: organizationId,
      })
    );
    expect(dependencies.removeProductMedia).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId }),
      expect.objectContaining({ assetId: imageId, productId })
    );
  });

  it("answers 404 for malformed ids and 400 for a missing organization before opening a transaction", async () => {
    const { app, bindings, dependencies } = createTestApp();
    const send = async (url: string, headers: Record<string, string>) =>
      (
        await app.fetch(
          new Request(url, { headers, method: "DELETE" }),
          bindings
        )
      ).status;

    expect(
      await send(`${mediaUrl}/not-a-uuid`, {
        "x-organization-id": organizationId,
      })
    ).toBe(404);
    expect(
      await send(
        "https://polaris.example.invalid/api/products/not-a-uuid/media/" +
          imageId,
        { "x-organization-id": organizationId }
      )
    ).toBe(404);
    expect(await send(`${mediaUrl}/${imageId}`, {})).toBe(400);
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("reorders the images and returns the new list", async () => {
    const { app, bindings, dependencies } = createTestApp();

    const response = await app.fetch(
      new Request(`${mediaUrl}/order`, {
        body: JSON.stringify({ assetIds: [imageId] }),
        headers: { "x-organization-id": organizationId },
        method: "PUT",
      }),
      bindings
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      media: [expect.objectContaining({ assetId: imageId })],
    });
    expect(dependencies.reorderProductMedia).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId }),
      expect.objectContaining({ assetIds: [imageId], productId })
    );
  });

  it("refuses a malformed order body before opening a transaction", async () => {
    const { app, bindings, dependencies } = createTestApp();
    const send = async (body: string) =>
      (
        await app.fetch(
          new Request(`${mediaUrl}/order`, {
            body,
            headers: { "x-organization-id": organizationId },
            method: "PUT",
          }),
          bindings
        )
      ).status;

    const statuses = await Promise.all(
      [
        "not json",
        "{}",
        JSON.stringify({ assetIds: "x" }),
        JSON.stringify({ assetIds: ["not-a-uuid"] }),
        JSON.stringify({ assetIds: Array.from({ length: 21 }, () => imageId) }),
        "x".repeat(5000),
      ].map((body) => send(body))
    );
    expect(statuses).toEqual(statuses.map(() => 400));
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("maps a stale order to a stable 409 and a deleted product to 404", async () => {
    const stale = createTestApp({
      reorderProductMedia: vi.fn(() =>
        Promise.reject(new InvalidMediaOrderError())
      ),
    });
    const staleResponse = await stale.app.fetch(
      new Request(`${mediaUrl}/order`, {
        body: JSON.stringify({ assetIds: [imageId] }),
        headers: { "x-organization-id": organizationId },
        method: "PUT",
      }),
      stale.bindings
    );
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_media_order" },
    });

    const deleted = createTestApp({
      removeProductMedia: vi.fn(() =>
        Promise.reject(new ProductDeletedError())
      ),
    });
    const deletedResponse = await deleted.app.fetch(
      new Request(`${mediaUrl}/${imageId}`, {
        headers: { "x-organization-id": organizationId },
        method: "DELETE",
      }),
      deleted.bindings
    );
    expect(deletedResponse.status).toBe(404);
  });
});
