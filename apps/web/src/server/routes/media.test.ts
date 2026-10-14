import {
  ProductDeletedError,
  ProductVariantNotFoundError,
} from "@polaris/domain/catalog/product";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
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
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  IMAGES: {} as never,
};

describe("media upload route", () => {
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
    expect(mediaBucket.put).toHaveBeenCalledTimes(2);
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
    expect(stored.size).toBe(1);
    expect(dependencies.createProductMediaAsset).toHaveBeenCalledTimes(1);
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
});
