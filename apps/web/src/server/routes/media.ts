import type { ProductMediaReadModel } from "@polaris/db/media-repository";
import {
  assertProductCanReceiveMedia,
  createProductMediaAsset,
  findMediaUploadCommand,
  getMediaAssetForDelivery,
  listProductMedia,
} from "@polaris/db/media-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  InvalidMediaCropError,
  MAX_MEDIA_INPUT_BYTES,
  MediaImageProcessingError,
  MediaImageTooLargeError,
  MediaUploadCommandConflictError,
  type NormalizedMediaCropRect,
  UnsupportedMediaImageError,
  validateNormalizedMediaCropRect,
} from "@polaris/domain/catalog/media";
import {
  MAX_PRODUCT_VARIANTS,
  ProductDeletedError,
  ProductNotFoundError,
  ProductVariantNotFoundError,
} from "@polaris/domain/catalog/product";
import { type Context, Hono } from "hono";
import type { MediaBucketBinding, ServerEnv } from "../environment";
import type { ProcessedMediaImage } from "../media-image-pipeline";
import { processMediaImage } from "../media-image-pipeline";
import {
  InvalidMediaUploadCommandIdError,
  mediaObjectKey,
  mediaUploadFingerprint,
  parseUploadCommandId,
} from "../media-upload-command";
import { TenantRequestContextError } from "../request-context-error";
import { withTenantRequestContext } from "../tenant-request-context";

type TenantRunner = typeof withTenantRequestContext;
type ImageProcessor = typeof processMediaImage;

export interface MediaRouteDependencies {
  assertProductCanReceiveMedia: typeof assertProductCanReceiveMedia;
  createProductMediaAsset: typeof createProductMediaAsset;
  findMediaUploadCommand: typeof findMediaUploadCommand;
  getMediaAssetForDelivery: typeof getMediaAssetForDelivery;
  listProductMedia: typeof listProductMedia;
  processMediaImage: ImageProcessor;
  withTenantRequestContext: TenantRunner;
}

class InvalidMediaUploadRequestError extends Error {
  constructor(options?: ErrorOptions) {
    super("invalid_media_upload_request", options);
    this.name = "InvalidMediaUploadRequestError";
  }
}

interface MediaUploadTarget {
  crop: NormalizedMediaCropRect;
  organizationId: string;
  productId: string;
  uploadCommandId: string;
  variantIds: string[];
}

function parseUploadTarget(context: Context<ServerEnv>): MediaUploadTarget {
  const organizationId = context.req.header("x-organization-id") ?? "";
  const productId = context.req.param("productId");
  const uploadId = context.req.header("x-upload-id") ?? "";
  const serializedVariantIds =
    context.req.header("x-product-variant-ids") ?? "[]";
  const serializedCrop = context.req.header("x-media-crop");

  if (
    !organizationId.trim() ||
    organizationId !== organizationId.trim() ||
    !productId ||
    !uuidPattern.test(productId) ||
    !serializedCrop ||
    serializedCrop.length > 2048 ||
    serializedVariantIds.length > 4096
  ) {
    throw new InvalidMediaUploadRequestError();
  }

  let cropValue: unknown;
  try {
    cropValue = JSON.parse(serializedCrop);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve parser details internally while returning a stable request error.
    throw new InvalidMediaCropError({ cause });
  }

  const crop = validateNormalizedMediaCropRect(cropValue);
  const uploadCommandId = parseUploadCommandId(uploadId);
  let variantIdsValue: unknown;
  try {
    variantIdsValue = JSON.parse(serializedVariantIds);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve parser details internally while returning a stable request error.
    throw new InvalidMediaUploadRequestError({ cause });
  }
  if (
    !Array.isArray(variantIdsValue) ||
    variantIdsValue.length > MAX_PRODUCT_VARIANTS ||
    variantIdsValue.some(
      (variantId) =>
        typeof variantId !== "string" || !uuidPattern.test(variantId)
    ) ||
    new Set(variantIdsValue).size !== variantIdsValue.length
  ) {
    throw new InvalidMediaUploadRequestError();
  }

  return {
    crop,
    organizationId,
    productId,
    uploadCommandId,
    variantIds: variantIdsValue as string[],
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contentLengthPattern = /^\d+$/;

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) {
    return null;
  }
  if (!contentLengthPattern.test(value)) {
    throw new InvalidMediaUploadRequestError();
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new InvalidMediaUploadRequestError();
  }
  if (length > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaImageTooLargeError();
  }
  return length;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const expectedLength = declaredContentLength(request);
  if (!request.body) {
    throw new UnsupportedMediaImageError();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Stream reads are sequential to honor backpressure.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > MAX_MEDIA_INPUT_BYTES) {
        await reader.cancel();
        throw new MediaImageTooLargeError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (
      error instanceof MediaImageTooLargeError ||
      error instanceof UnsupportedMediaImageError
    ) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: Preserve stream details internally while returning a stable request error.
    throw new InvalidMediaUploadRequestError({ cause: error });
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) {
    throw new UnsupportedMediaImageError();
  }
  if (expectedLength !== null && expectedLength !== byteLength) {
    throw new InvalidMediaUploadRequestError();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function errorResponse(context: Context<ServerEnv>, error: unknown): Response {
  if (error instanceof InvalidMediaCropError) {
    return context.json(
      {
        error: { code: "invalid_media_crop" },
        requestId: context.get("requestId"),
      },
      400
    );
  }
  if (
    error instanceof InvalidMediaUploadRequestError ||
    error instanceof InvalidMediaUploadCommandIdError
  ) {
    return context.json(
      {
        error: { code: "invalid_media_upload_request" },
        requestId: context.get("requestId"),
      },
      400
    );
  }
  if (error instanceof MediaImageTooLargeError) {
    return context.json(
      {
        error: { code: "media_image_too_large" },
        requestId: context.get("requestId"),
      },
      413
    );
  }
  if (error instanceof UnsupportedMediaImageError) {
    return context.json(
      {
        error: { code: "unsupported_media_image" },
        requestId: context.get("requestId"),
      },
      415
    );
  }
  if (error instanceof MediaUploadCommandConflictError) {
    return context.json(
      {
        error: { code: "media_upload_command_conflict" },
        requestId: context.get("requestId"),
      },
      409
    );
  }
  if (
    error instanceof ProductNotFoundError ||
    error instanceof ProductDeletedError ||
    error instanceof ProductVariantNotFoundError
  ) {
    return context.json(
      { error: { code: "not_found" }, requestId: context.get("requestId") },
      404
    );
  }
  if (error instanceof MediaImageProcessingError) {
    return context.json(
      {
        error: { code: "media_processing_unavailable" },
        requestId: context.get("requestId"),
      },
      503
    );
  }
  if (error instanceof TenantRequestContextError) {
    const status = error.code === "session_required" ? 401 : 503;
    return context.json(
      { error: { code: error.code }, requestId: context.get("requestId") },
      status
    );
  }
  if (error instanceof TenantAuthorizationError) {
    return context.json(
      {
        error: {
          code:
            error.code === "capability_denied"
              ? "forbidden"
              : "tenant_access_denied",
        },
        requestId: context.get("requestId"),
      },
      403
    );
  }
  return context.json(
    { error: { code: "internal_error" }, requestId: context.get("requestId") },
    500
  );
}

function jsonAssetResponse(
  context: Context<ServerEnv>,
  asset: ProductMediaReadModel,
  replayed: boolean,
  status: 200 | 201
): Response {
  return context.json(
    { asset, replayed, requestId: context.get("requestId") },
    status
  );
}

async function findUploadPreflight(
  context: Context<ServerEnv>,
  target: MediaUploadTarget,
  tenantRequest: TenantRunner,
  findUpload: typeof findMediaUploadCommand,
  authorizeProduct: typeof assertProductCanReceiveMedia
) {
  return await tenantRequest({
    bindings: context.env,
    capability: "product:update",
    operation: async (transaction, identity) => {
      const existing = await findUpload(
        transaction,
        identity.organizationId,
        target.uploadCommandId
      );
      if (!existing) {
        await authorizeProduct(
          transaction,
          identity.organizationId,
          target.productId,
          target.variantIds
        );
      }
      return existing;
    },
    request: context.req.raw,
    requestedOrganizationId: target.organizationId,
  });
}

async function storeMediaObject(
  mediaBucket: MediaBucketBinding,
  storageKey: string,
  processed: ProcessedMediaImage
): Promise<boolean> {
  let stored: { etag: string } | null;
  try {
    stored = await mediaBucket.put(storageKey, processed.bytes, {
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "image/webp",
      },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve provider details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
  if (stored !== null) {
    return true;
  }

  let existingObject: Awaited<ReturnType<MediaBucketBinding["get"]>>;
  try {
    existingObject = await mediaBucket.get(storageKey);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve provider details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
  if (!existingObject) {
    throw new MediaImageProcessingError();
  }

  let existingBytes: Uint8Array;
  try {
    existingBytes = new Uint8Array(await existingObject.arrayBuffer());
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve provider details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
  if (!sameBytes(existingBytes, processed.bytes)) {
    throw new MediaUploadCommandConflictError();
  }
  return false;
}

function canCompensateRejectedMediaWrite(error: unknown): boolean {
  return (
    error instanceof ProductNotFoundError ||
    error instanceof ProductDeletedError ||
    error instanceof ProductVariantNotFoundError ||
    error instanceof MediaUploadCommandConflictError
  );
}

async function handleMediaUpload(
  context: Context<ServerEnv>,
  dependencies: {
    authorizeProduct: typeof assertProductCanReceiveMedia;
    createAsset: typeof createProductMediaAsset;
    findUpload: typeof findMediaUploadCommand;
    imageProcessor: ImageProcessor;
    tenantRequest: TenantRunner;
  }
): Promise<Response> {
  const target = parseUploadTarget(context);
  declaredContentLength(context.req.raw);

  const { MEDIA_BUCKET: mediaBucket, IMAGES: images } = context.env;
  if (!(mediaBucket && images)) {
    throw new MediaImageProcessingError();
  }

  const preflight = await findUploadPreflight(
    context,
    target,
    dependencies.tenantRequest,
    dependencies.findUpload,
    dependencies.authorizeProduct
  );
  const sourceBytes = await readBoundedBody(context.req.raw);
  const inputFingerprint = await mediaUploadFingerprint({
    crop: target.crop,
    organizationId: target.organizationId,
    productId: target.productId,
    sourceBytes,
    variantIds: target.variantIds,
  });

  if (preflight) {
    if (
      preflight.productId !== target.productId ||
      preflight.inputFingerprint !== inputFingerprint
    ) {
      throw new MediaUploadCommandConflictError();
    }
    return jsonAssetResponse(context, preflight.asset, true, 200);
  }

  const declaredContentType = context.req.header("content-type");
  const processed = await dependencies.imageProcessor({
    crop: target.crop,
    images,
    sourceBytes,
    ...(declaredContentType === undefined ? {} : { declaredContentType }),
  });
  const storageKey = mediaObjectKey(
    target.organizationId,
    target.productId,
    target.uploadCommandId,
    inputFingerprint
  );
  const objectCreated = await storeMediaObject(
    mediaBucket,
    storageKey,
    processed
  );

  let result: Awaited<ReturnType<typeof createProductMediaAsset>>;
  try {
    result = await dependencies.tenantRequest({
      bindings: context.env,
      capability: "product:update",
      operation: (transaction, identity) =>
        dependencies.createAsset(transaction, identity, {
          byteSize: processed.byteLength,
          height: processed.height,
          inputFingerprint,
          productId: target.productId,
          requestId: context.get("requestId"),
          storageKey,
          uploadCommandId: target.uploadCommandId,
          variantIds: target.variantIds,
          width: processed.width,
        }),
      request: context.req.raw,
      requestedOrganizationId: target.organizationId,
    });
  } catch (error: unknown) {
    if (objectCreated && canCompensateRejectedMediaWrite(error)) {
      try {
        await mediaBucket.delete(storageKey);
      } catch {
        // PR35 will reconcile private objects left by failed compensation.
      }
    }
    throw error;
  }

  return jsonAssetResponse(
    context,
    result.asset,
    result.replayed,
    result.replayed ? 200 : 201
  );
}

export function createMediaRoutes(
  overrides: Partial<MediaRouteDependencies> = {}
): Hono<ServerEnv> {
  const authorizeProduct =
    overrides.assertProductCanReceiveMedia ?? assertProductCanReceiveMedia;
  const createAsset =
    overrides.createProductMediaAsset ?? createProductMediaAsset;
  const findUpload = overrides.findMediaUploadCommand ?? findMediaUploadCommand;
  const getAsset =
    overrides.getMediaAssetForDelivery ?? getMediaAssetForDelivery;
  const listMedia = overrides.listProductMedia ?? listProductMedia;
  const imageProcessor = overrides.processMediaImage ?? processMediaImage;
  const tenantRequest =
    overrides.withTenantRequestContext ?? withTenantRequestContext;

  const app = new Hono<ServerEnv>();

  app.post("/api/products/:productId/media", async (context) => {
    try {
      return await handleMediaUpload(context, {
        authorizeProduct,
        createAsset,
        findUpload,
        imageProcessor,
        tenantRequest,
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get("/api/products/:productId/media", async (context) => {
    const organizationId =
      context.req.query("organizationId") ??
      context.req.header("x-organization-id") ??
      "";
    const productId = context.req.param("productId");
    if (!organizationId.trim() || organizationId !== organizationId.trim()) {
      return errorResponse(context, new InvalidMediaUploadRequestError());
    }

    try {
      const media = await tenantRequest({
        bindings: context.env,
        capability: "catalog:read",
        operation: (transaction, identity) =>
          listMedia(transaction, identity.organizationId, productId),
        request: context.req.raw,
        requestedOrganizationId: organizationId,
      });
      return context.json({ media, requestId: context.get("requestId") });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get("/api/media/:assetId", async (context) => {
    const organizationId =
      context.req.query("organizationId") ??
      context.req.header("x-organization-id") ??
      "";
    if (!organizationId.trim() || organizationId !== organizationId.trim()) {
      return errorResponse(context, new InvalidMediaUploadRequestError());
    }
    const { MEDIA_BUCKET: mediaBucket } = context.env;
    if (!mediaBucket) {
      return errorResponse(context, new MediaImageProcessingError());
    }

    try {
      const asset = await tenantRequest({
        bindings: context.env,
        capability: "catalog:read",
        operation: (transaction, identity) =>
          getAsset(
            transaction,
            identity.organizationId,
            context.req.param("assetId")
          ),
        request: context.req.raw,
        requestedOrganizationId: organizationId,
      });
      if (!asset) {
        return context.json(
          { error: { code: "not_found" }, requestId: context.get("requestId") },
          404
        );
      }

      let object: Awaited<ReturnType<MediaBucketBinding["get"]>>;
      try {
        object = await mediaBucket.get(asset.storageKey);
      } catch (cause: unknown) {
        // biome-ignore lint/style/useErrorCause: Preserve storage details internally while returning a stable processing error.
        throw new MediaImageProcessingError({ cause });
      }
      if (!object) {
        return context.json(
          { error: { code: "not_found" }, requestId: context.get("requestId") },
          404
        );
      }
      return context.body(object.body, 200, {
        "Cache-Control": "private, no-store",
        "Content-Length": String(asset.byteSize),
        "Content-Type": "image/webp",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}
