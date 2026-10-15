import {
  MediaImageTooLargeError,
  UnsupportedMediaImageError,
} from "@polaris/domain/catalog/media";
import { describe, expect, it, vi } from "vitest";
import {
  type MediaUploadHttpError,
  prepareMediaUploadFile,
  removeProductMedia,
  reorderProductMedia,
  uploadProductMedia,
} from "./media-upload";

describe("prepareMediaUploadFile", () => {
  it("converts HEIC uploads to JPEG in the browser", async () => {
    const source = new File(["heic-bytes"], "iphone-photo.HEIC", {
      lastModified: 123,
      type: "image/heic",
    });
    const rasterizeHeic = vi.fn(
      async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })
    );

    const prepared = await prepareMediaUploadFile(source, { rasterizeHeic });

    expect(rasterizeHeic).toHaveBeenCalledWith(source);
    expect(prepared.name).toBe("iphone-photo.jpg");
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.lastModified).toBe(123);
    await expect(prepared.text()).resolves.toBe("jpeg-bytes");
  });

  it("keeps supported JPEG, PNG, and WebP files unchanged", async () => {
    const sources = ["image/jpeg", "image/png", "image/webp"].map(
      (contentType) =>
        new File(["image-bytes"], "product-image", { type: contentType })
    );
    const rasterizeHeic = vi.fn(async () => new Blob());
    const prepared = await Promise.all(
      sources.map((source) => prepareMediaUploadFile(source, { rasterizeHeic }))
    );

    expect(prepared).toEqual(sources);
    expect(rasterizeHeic).not.toHaveBeenCalled();
  });

  it("rejects oversized originals before attempting HEIC conversion", async () => {
    const source = new File([new Uint8Array(20_000_001)], "large.heic", {
      type: "image/heic",
    });
    const rasterizeHeic = vi.fn(async () => new Blob());

    await expect(
      prepareMediaUploadFile(source, { rasterizeHeic })
    ).rejects.toBeInstanceOf(MediaImageTooLargeError);
    expect(rasterizeHeic).not.toHaveBeenCalled();
  });

  it("rejects unsupported formats instead of relying on the filename", async () => {
    const source = new File(["svg"], "product.svg", {
      type: "image/svg+xml",
    });

    await expect(prepareMediaUploadFile(source)).rejects.toBeInstanceOf(
      UnsupportedMediaImageError
    );
  });

  it("rejects HEIC conversion that returns an empty blob", async () => {
    const source = new File(["heic-bytes"], "photo.heic", {
      type: "image/heic",
    });

    await expect(
      prepareMediaUploadFile(source, { rasterizeHeic: async () => new Blob() })
    ).rejects.toBeInstanceOf(UnsupportedMediaImageError);
  });

  it("sends a prepared binary upload with the tenant, crop, and idempotency headers", async () => {
    const file = new File(["image-bytes"], "product.png", {
      type: "image/png",
    });
    const responseBody = {
      asset: {
        assetId: "0199c2d0-0000-7000-8000-000000000002",
        byteSize: 4,
        contentType: "image/webp",
        createdAt: "2026-10-10T12:00:00.000Z",
        height: 200,
        position: 0,
        variantIds: [],
        width: 600,
      },
      replayed: false,
      requestId: "0199c2d0-0000-7000-8000-000000000003",
    };
    const fetcher = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response(JSON.stringify(responseBody), {
          headers: { "content-type": "application/json" },
          status: 201,
        })
    );

    const response = await uploadProductMedia(
      {
        crop: { height: 1, width: 1, x: 0, y: 0 },
        file,
        organizationId: "org-1",
        origin: "https://polaris.example.invalid",
        productId: "0199c2d0-0000-7000-8000-000000000001",
        uploadCommandId: "de305d54-75b4-431b-adb2-eb6b9e546014",
      },
      fetcher
    );

    expect(response).toEqual(responseBody);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://polaris.example.invalid/api/products/0199c2d0-0000-7000-8000-000000000001/media"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("x-organization-id")).toBe("org-1");
    expect(headers.get("x-upload-id")).toBe(
      "de305d54-75b4-431b-adb2-eb6b9e546014"
    );
    expect(headers.get("x-media-crop")).toBe(
      JSON.stringify({ height: 1, width: 1, x: 0, y: 0 })
    );
    expect(init?.body).toBe(file);
  });

  it("preserves the server error code for a user-facing upload message", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "unsupported_media_image" } }),
          {
            headers: { "content-type": "application/json" },
            status: 415,
          }
        )
    );

    await expect(
      uploadProductMedia(
        {
          crop: { height: 1, width: 1, x: 0, y: 0 },
          file: new File(["image"], "product.jpg", { type: "image/jpeg" }),
          organizationId: "org-1",
          origin: "https://polaris.example.invalid",
          productId: "0199c2d0-0000-7000-8000-000000000001",
          uploadCommandId: "de305d54-75b4-431b-adb2-eb6b9e546014",
        },
        fetcher
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "unsupported_media_image",
      status: 415,
    });
  });
});

const productId = "0199c2d0-0000-7000-8000-000000000001";
const assetId = "0199c2d0-0000-7000-8000-000000000002";
const secondAssetId = "0199c2d0-0000-7000-8000-000000000004";
const requestId = "0199c2d0-0000-7000-8000-000000000003";
const origin = "https://polaris.example.invalid";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function asset(id: string, position: number) {
  return {
    assetId: id,
    byteSize: 4,
    contentType: "image/webp",
    createdAt: "2026-10-10T12:00:00.000Z",
    height: 200,
    position,
    variantIds: [],
    width: 600,
  };
}

describe("removeProductMedia", () => {
  it("sends a tenant-scoped DELETE for the image and returns the answer", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) =>
      jsonResponse({ removed: true, requestId })
    );

    const response = await removeProductMedia(
      { assetId, organizationId: "org-1", origin, productId },
      fetcher
    );

    expect(response).toEqual({ removed: true, requestId });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${origin}/api/products/${productId}/media/${assetId}`
    );
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe("same-origin");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-organization-id")).toBe("org-1");
    expect(headers.has("content-type")).toBe(false);
  });

  it("accepts an image that was already removed", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ removed: false, requestId })
    );
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        fetcher
      )
    ).resolves.toMatchObject({ removed: false });
  });

  it("preserves the server error code and status", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ error: { code: "forbidden" }, requestId }, 403)
    );
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        fetcher
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "forbidden",
      status: 403,
    });
  });

  it("falls back to a stable code when the error body has none", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ oops: true }, 500));
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        fetcher
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "media_remove_failed",
      status: 500,
    });
  });

  it("rejects a body that is not JSON or does not match the contract", async () => {
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        vi.fn(async () => new Response("<html>", { status: 502 }))
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "media_remove_failed",
      status: 502,
    });
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        vi.fn(async () => jsonResponse({ removed: "yes" }))
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "invalid_media_response",
      status: 502,
    });
  });

  it("lets a network failure reach the caller", async () => {
    const fetcher = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    );
    await expect(
      removeProductMedia(
        { assetId, organizationId: "org-1", origin, productId },
        fetcher
      )
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("reorderProductMedia", () => {
  it("sends the whole new order as a JSON PUT and returns the list", async () => {
    const body = {
      media: [asset(secondAssetId, 0), asset(assetId, 1)],
      requestId,
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) =>
      jsonResponse(body)
    );

    const response = await reorderProductMedia(
      {
        assetIds: [secondAssetId, assetId],
        organizationId: "org-1",
        origin,
        productId,
      },
      fetcher
    );

    expect(response).toEqual(body);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${origin}/api/products/${productId}/media/order`);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(
      JSON.stringify({ assetIds: [secondAssetId, assetId] })
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-organization-id")).toBe("org-1");
  });

  it("preserves invalid_media_order so the screen can reload", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ error: { code: "invalid_media_order" }, requestId }, 409)
    );
    await expect(
      reorderProductMedia(
        { assetIds: [assetId], organizationId: "org-1", origin, productId },
        fetcher
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "invalid_media_order",
      status: 409,
    });
  });

  it("rejects a response that is not a media list", async () => {
    await expect(
      reorderProductMedia(
        { assetIds: [assetId], organizationId: "org-1", origin, productId },
        vi.fn(async () => jsonResponse({ media: "none", requestId }))
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "invalid_media_response",
      status: 502,
    });
  });

  it("falls back to a stable code when the error body has none", async () => {
    await expect(
      reorderProductMedia(
        { assetIds: [assetId], organizationId: "org-1", origin, productId },
        vi.fn(async () => jsonResponse({}, 500))
      )
    ).rejects.toMatchObject<Partial<MediaUploadHttpError>>({
      code: "media_reorder_failed",
      status: 500,
    });
  });
});
