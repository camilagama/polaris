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
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaBucketBinding, ServerEnv } from "../environment";
import { MAX_MEDIA_THUMBS_PER_REQUEST, readMediaThumbs } from "../media-thumbs";
import { requestIdMiddleware } from "../middleware/request-id";
import { TenantRequestContextError } from "../request-context-error";
import { createMediaRoutes, type MediaRouteDependencies } from "./media";

const organizationId = "org/with space";
const productId = "0199c2d0-0000-7000-8000-000000000001";
const uploadCommandId = "de305d54-75b4-431b-adb2-eb6b9e546014";
const stagingKeyPattern = /^media\/staging\/v1\//;
const fingerprintPattern = /^[0-9a-f]{64}$/;
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
    head: vi.fn((key) => {
      const bytes = stored.get(key);
      return Promise.resolve(bytes ? { size: bytes.byteLength } : null);
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
    listDeliverableMediaAssetIds: vi.fn(() => Promise.resolve(new Set())),
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

  it("answers a retry of the same prepared file with the stored image and the same id with another file with 409", async () => {
    const prepared = new Uint8Array([255, 216, 255, 1, 2, 3]);
    const first = createTestApp();
    const created = await first.app.fetch(
      uploadRequest({ body: prepared }),
      first.bindings
    );
    expect(created.status).toBe(201);
    const [, , command] =
      vi.mocked(first.dependencies.createProductMediaAsset).mock.calls[0] ?? [];
    const { inputFingerprint } = command as { inputFingerprint: string };
    expect(inputFingerprint).toMatch(fingerprintPattern);

    const stored = { asset: mediaAsset, inputFingerprint, productId };
    const retry = createTestApp({
      findMediaUploadCommand: vi.fn(() => Promise.resolve(stored)),
    });
    const replayed = await retry.app.fetch(
      uploadRequest({ body: prepared.slice() }),
      retry.bindings
    );
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      asset: mediaAsset,
      replayed: true,
    });
    expect(retry.dependencies.processMediaImage).not.toHaveBeenCalled();
    expect(retry.mediaBucket.put).not.toHaveBeenCalled();

    const other = createTestApp({
      findMediaUploadCommand: vi.fn(() => Promise.resolve(stored)),
    });
    const conflict = await other.app.fetch(
      uploadRequest({ body: new Uint8Array([255, 216, 255, 1, 2, 4]) }),
      other.bindings
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "media_upload_command_conflict" },
    });
    expect(other.dependencies.processMediaImage).not.toHaveBeenCalled();
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

  it("answers 403 legal_acceptance_required while the legal acceptance is pending, without running the removal", async () => {
    const { app, bindings, dependencies } = createTestApp({
      withTenantRequestContext: vi.fn(() =>
        Promise.reject(
          new TenantRequestContextError("legal_acceptance_required", [
            { document: "terms", version: 1 },
          ])
        )
      ),
    } as unknown as Partial<MediaRouteDependencies>);

    const response = await app.fetch(
      new Request(`${mediaUrl}/${imageId}`, {
        headers: { "x-organization-id": organizationId },
        method: "DELETE",
      }),
      bindings
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "legal_acceptance_required" },
    });
    expect(dependencies.removeProductMedia).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and 503 when authentication is unavailable (the statuses did not change)", async () => {
    for (const [code, status] of [
      ["session_required", 401],
      ["authentication_unavailable", 503],
    ] as const) {
      const { app, bindings } = createTestApp({
        withTenantRequestContext: vi.fn(() =>
          Promise.reject(new TenantRequestContextError(code))
        ),
      } as unknown as Partial<MediaRouteDependencies>);
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      const response = await app.fetch(
        new Request(`${mediaUrl}/${imageId}`, {
          headers: { "x-organization-id": organizationId },
          method: "DELETE",
        }),
        bindings
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code },
      });
    }
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

describe("media thumbnail batch route", () => {
  const thumbsUrl = "https://polaris.example.invalid/api/media/thumbs";
  const thumbId = (index: number) =>
    `0199c2d0-0000-7000-8000-${String(1000 + index).padStart(12, "0")}`;
  const thumbKey = (id: string) => `media/derivatives/v1/${id}/320.webp`;
  const thumbBytes = (index: number, length: number) =>
    Uint8Array.from({ length }, (_, offset) => (index * 31 + offset) % 256);
  const askThumbs = (
    app: Hono<ServerEnv>,
    bindings: ServerEnv["Bindings"],
    ids: string
  ) =>
    app.fetch(
      new Request(
        `${thumbsUrl}?organizationId=${encodeURIComponent(organizationId)}&ids=${ids}`
      ),
      bindings
    );
  const headerEntries = (response: Response) =>
    (response.headers.get("x-polaris-thumbs") ?? "").split(",").map((entry) => {
      const [id, size] = entry.split(":");
      return { id: id as string, size: size as string };
    });
  /** An organization's database as the row level policy shows it: only its own linked images. */
  const tenantImages = (owners: Map<string, string>) =>
    vi.fn(
      (
        _transaction: unknown,
        requestedOrganization: string,
        ids: readonly string[]
      ) =>
        Promise.resolve(
          new Set(ids.filter((id) => owners.get(id) === requestedOrganization))
        )
    );

  it("answers one stored thumbnail with the private binary headers, in one transaction under catalog:read", async () => {
    const id = thumbId(1);
    const { app, bindings, dependencies, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([[id, organizationId]])
      ),
    });
    stored.set(thumbKey(id), thumbBytes(1, 37));

    const response = await askThumbs(app, bindings, id);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-polaris-thumbs")).toBe(`${id}:37`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      thumbBytes(1, 37)
    );
    expect(dependencies.withTenantRequestContext).toHaveBeenCalledTimes(1);
    expect(dependencies.withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "catalog:read",
        requestedOrganizationId: organizationId,
      })
    );
    expect(dependencies.getMediaAssetForDelivery).not.toHaveBeenCalled();
  });

  it("answers the capped number of ids in the asked order, the body slicing into each WebP by the header and Content-Length, with one query and no head", async () => {
    const ids = Array.from(
      { length: MAX_MEDIA_THUMBS_PER_REQUEST },
      (_, index) => thumbId(index)
    );
    const owners = new Map(ids.map((id) => [id, organizationId]));
    const listDeliverable = tenantImages(owners);
    const { app, bindings, mediaBucket, stored } = createTestApp({
      listDeliverableMediaAssetIds: listDeliverable,
    });
    for (const [index, id] of ids.entries()) {
      if (index % 5 !== 3) {
        stored.set(thumbKey(id), thumbBytes(index, 100 + index * 7));
      }
    }
    const asked = [...ids].reverse();

    const response = await askThumbs(app, bindings, asked.join(","));
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    const entries = headerEntries(response);
    expect(entries.map((entry) => entry.id)).toEqual(asked);
    let offset = 0;
    for (const entry of entries) {
      const index = ids.indexOf(entry.id);
      if (index % 5 === 3) {
        expect(entry.size).toBe("missing");
        continue;
      }
      const size = Number(entry.size);
      expect(size).toBe(100 + index * 7);
      expect(body.slice(offset, offset + size)).toEqual(
        thumbBytes(index, size)
      );
      offset += size;
    }
    expect(offset).toBe(body.byteLength);
    expect(response.headers.get("content-length")).toBe(String(offset));
    expect(listDeliverable).toHaveBeenCalledTimes(1);
    expect(listDeliverable.mock.calls[0]?.[2]).toEqual(asked);
    expect(mediaBucket.head).not.toHaveBeenCalled();
    expect(mediaBucket.get).toHaveBeenCalledTimes(ids.length);
  });

  it("keeps the exact response format: header id:bytes|missing in the asked order, the bytes joined, private and not stored", async () => {
    const [first, absent, last] = [thumbId(50), thumbId(51), thumbId(52)];
    const { app, bindings, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([
          [first, organizationId],
          [absent, organizationId],
          [last, organizationId],
        ])
      ),
    });
    stored.set(thumbKey(first), Uint8Array.of(1, 2, 3));
    stored.set(thumbKey(last), Uint8Array.of(9, 8));

    const response = await askThumbs(
      app,
      bindings,
      `${last},${absent},${first}`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-polaris-thumbs")).toBe(
      `${last}:2,${absent}:missing,${first}:3`
    );
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe("5");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      9, 8, 1, 2, 3,
    ]);
  });

  it("never has more than six storage reads open at once, whatever the number of ids", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => thumbId(100 + index));
    let open = 0;
    let mostOpen = 0;
    const bucket = {
      get: vi.fn(async (key: string) => {
        open += 1;
        mostOpen = Math.max(mostOpen, open);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        open -= 1;
        const bytes = Uint8Array.of(key.length % 256, 7);
        return { arrayBuffer: () => Promise.resolve(bodyBuffer(bytes)) };
      }),
    };

    const read = await readMediaThumbs({
      authorizedIds: new Set(ids),
      bucket: bucket as never,
      ids,
    });

    expect(bucket.get).toHaveBeenCalledTimes(20);
    expect(mostOpen).toBe(6);
    expect(read.entries.map((entry) => entry.id)).toEqual(ids);
    expect(read.body.byteLength).toBe(40);
  });

  it("refuses 0, more than the cap and malformed ids with a stable 400 before opening a transaction", async () => {
    const { app, bindings, dependencies } = createTestApp();
    const overCap = Array.from(
      { length: MAX_MEDIA_THUMBS_PER_REQUEST + 1 },
      (_, index) => thumbId(index)
    );
    const cases = [
      overCap.join(","),
      Array.from({ length: 24 }, (_, index) => thumbId(index)).join(","),
      Array.from({ length: 25 }, (_, index) => thumbId(index)).join(","),
      Array.from({ length: MAX_MEDIA_THUMBS_PER_REQUEST + 1 }, () =>
        thumbId(1)
      ).join(","),
      "",
      `${thumbId(1)},not-a-uuid`,
      `${thumbId(1)},`,
      "%27%3B%20DROP%20TABLE",
      "0".repeat(36),
    ];

    for (const ids of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      const response = await askThumbs(app, bindings, ids);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_media_thumbs_request" },
      });
    }
    const withoutIds = await app.fetch(
      new Request(
        `${thumbsUrl}?organizationId=${encodeURIComponent(organizationId)}`
      ),
      bindings
    );
    expect(withoutIds.status).toBe(400);
    const withoutOrganization = await app.fetch(
      new Request(`${thumbsUrl}?ids=${thumbId(1)}`),
      bindings
    );
    expect(withoutOrganization.status).toBe(400);
    expect(dependencies.withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("accepts exactly the cap", async () => {
    const ids = Array.from(
      { length: MAX_MEDIA_THUMBS_PER_REQUEST },
      (_, index) => thumbId(index)
    );
    const { app, bindings } = createTestApp();

    const response = await askThumbs(app, bindings, ids.join(","));

    expect(response.status).toBe(200);
    expect(headerEntries(response)).toHaveLength(MAX_MEDIA_THUMBS_PER_REQUEST);
  });

  it("answers a repeated id once", async () => {
    const id = thumbId(2);
    const { app, bindings, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([[id, organizationId]])
      ),
    });
    stored.set(thumbKey(id), thumbBytes(2, 10));

    const response = await askThumbs(
      app,
      bindings,
      `${id},${id.toUpperCase()},${id}`
    );

    expect(response.headers.get("x-polaris-thumbs")).toBe(`${id}:10`);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });

  it("answers 401 without a session and the single delivery's refusal without the product read capability", async () => {
    const id = thumbId(3);
    for (const [error, status, code] of [
      [
        new TenantRequestContextError("session_required"),
        401,
        "session_required",
      ],
      [new TenantAuthorizationError("capability_denied"), 403, "forbidden"],
      [
        new TenantAuthorizationError("tenant_access_denied"),
        403,
        "tenant_access_denied",
      ],
    ] as const) {
      const { app, bindings, dependencies, mediaBucket } = createTestApp({
        withTenantRequestContext: vi.fn(() => Promise.reject(error)),
      } as unknown as Partial<MediaRouteDependencies>);
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      const batch = await askThumbs(app, bindings, id);
      const single = await app.fetch(
        new Request(
          `https://polaris.example.invalid/api/media/${id}?organizationId=${encodeURIComponent(organizationId)}&size=320`
        ),
        bindings
      );
      expect(batch.status).toBe(status);
      expect(single.status).toBe(status);
      await expect(batch.json()).resolves.toMatchObject({ error: { code } });
      await expect(single.json()).resolves.toMatchObject({ error: { code } });
      expect(dependencies.withTenantRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({ capability: "catalog:read" })
      );
      expect(mediaBucket.head).not.toHaveBeenCalled();
      expect(mediaBucket.get).not.toHaveBeenCalled();
    }
  });

  it("answers another store's image exactly as an unknown, removed or underived one, without reading it from storage", async () => {
    const own = thumbId(10);
    const ofOtherStore = thumbId(11);
    const unknown = thumbId(12);
    const removed = thumbId(13);
    const underived = thumbId(14);
    const owners = new Map([
      [own, organizationId],
      [ofOtherStore, "another-organization"],
      [underived, organizationId],
    ]);
    const { app, bindings, mediaBucket, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(owners),
    });
    stored.set(thumbKey(own), thumbBytes(10, 20));
    // the other store's thumbnail and the removed image's are in the bucket
    stored.set(thumbKey(ofOtherStore), thumbBytes(11, 30));
    stored.set(thumbKey(removed), thumbBytes(13, 40));

    const answers = await Promise.all(
      [ofOtherStore, unknown, removed, underived].map(async (probe) => {
        const response = await askThumbs(app, bindings, `${own},${probe}`);
        // every header but the per-request id, with the probed id masked
        const headers = [...response.headers.entries()]
          .filter(([name]) => name !== "x-request-id")
          .map(([name, value]) =>
            name === "x-polaris-thumbs"
              ? [name, value.replace(probe, "<probe>")]
              : [name, value]
          );
        return {
          body: [...new Uint8Array(await response.arrayBuffer())],
          headers,
          status: response.status,
        };
      })
    );

    const [first] = answers;
    expect(first?.status).toBe(200);
    expect(first?.headers).toContainEqual([
      "x-polaris-thumbs",
      `${own}:20,<probe>:missing`,
    ]);
    for (const answer of answers) {
      expect(answer).toEqual(first);
    }
    expect(mediaBucket.head).not.toHaveBeenCalled();
    const readKeys = vi.mocked(mediaBucket.get).mock.calls.map(([key]) => key);
    expect(readKeys).not.toContain(thumbKey(ofOtherStore));
    expect(readKeys).not.toContain(thumbKey(unknown));
    expect(readKeys).not.toContain(thumbKey(removed));
  });

  it("never reaches Images: an image without its 320 px derivative is missing, with no transformation", async () => {
    const id = thumbId(20);
    const imagesReads: PropertyKey[] = [];
    const images = new Proxy(
      {},
      {
        get: (_target, property) => {
          imagesReads.push(property);
          return vi.fn();
        },
      }
    );
    const { app, bindings, dependencies, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([[id, organizationId]])
      ),
    });
    // the master is there; only the 320 px derivative is not
    stored.set(`media/v2/master/${id}.webp`, thumbBytes(20, 50));

    const response = await askThumbs(
      app,
      { ...bindings, IMAGES: images as never },
      id
    );

    expect(response.headers.get("x-polaris-thumbs")).toBe(`${id}:missing`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(imagesReads).toEqual([]);
    expect(dependencies.processMediaDerivative).not.toHaveBeenCalled();
    expect(dependencies.processMediaImage).not.toHaveBeenCalled();
  });

  it("answers a thumbnail that vanishes between the query and the read as missing, with a whole body", async () => {
    const [kept, vanishing] = [thumbId(30), thumbId(31)];
    const { app, bindings, mediaBucket, stored } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([
          [kept, organizationId],
          [vanishing, organizationId],
        ])
      ),
    });
    stored.set(thumbKey(kept), thumbBytes(30, 12));
    stored.set(thumbKey(vanishing), thumbBytes(31, 12));
    const plainGet = mediaBucket.get;
    mediaBucket.get = vi.fn((key: string) => {
      if (key === thumbKey(vanishing)) {
        stored.delete(key);
      }
      return plainGet(key);
    });

    const response = await askThumbs(app, bindings, `${vanishing},${kept}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-polaris-thumbs")).toBe(
      `${vanishing}:missing,${kept}:12`
    );
    expect(response.headers.get("content-length")).toBe("12");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      ...thumbBytes(30, 12),
    ]);
  });

  it("answers 503 with a stable code when a stored thumbnail cannot be read to the end", async () => {
    const id = thumbId(41);
    const { app, bindings, mediaBucket } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([[id, organizationId]])
      ),
    });
    mediaBucket.get = vi.fn(() =>
      Promise.resolve({
        arrayBuffer: () => Promise.reject(new Error("r2 reset")),
      } as never)
    );

    const response = await askThumbs(app, bindings, id);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "media_processing_unavailable" },
    });
  });

  it("answers 503 with a stable code when storage cannot read the thumbnails", async () => {
    const id = thumbId(40);
    const { app, bindings, mediaBucket } = createTestApp({
      listDeliverableMediaAssetIds: tenantImages(
        new Map([[id, organizationId]])
      ),
    });
    mediaBucket.get = vi.fn(() => Promise.reject(new Error("r2 down")));

    const response = await askThumbs(app, bindings, id);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "media_processing_unavailable" },
    });
  });
});
