import type { ProductMediaReadModel } from "@polaris/db/media-repository";
import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
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
  ProductMediaLimitError,
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
import {
  processMediaDerivative,
  processMediaImage,
} from "../media-image-pipeline";
import {
  InvalidMediaUploadCommandIdError,
  mediaDerivativeKey,
  mediaObjectKey,
  mediaStagingMarkerKey,
  mediaUploadFingerprint,
  parseUploadCommandId,
} from "../media-upload-command";
import { logServerErrorFromContext } from "../observability/server-log";
import { TenantRequestContextError } from "../request-context-error";
import { withTenantRequestContext } from "../tenant-request-context";

type TenantRunner = typeof withTenantRequestContext;
type ImageProcessor = typeof processMediaImage;
type DerivativeProcessor = typeof processMediaDerivative;

export interface MediaRouteDependencies {
  assertProductCanReceiveMedia: typeof assertProductCanReceiveMedia;
  createProductMediaAsset: typeof createProductMediaAsset;
  findMediaUploadCommand: typeof findMediaUploadCommand;
  getMediaAssetForDelivery: typeof getMediaAssetForDelivery;
  listProductMedia: typeof listProductMedia;
  processMediaImage: ImageProcessor;
  processMediaDerivative: DerivativeProcessor;
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
  if (error instanceof ProductMediaLimitError) {
    return context.json(
      {
        error: { code: "product_media_limit" },
        requestId: context.get("requestId"),
      },
      409
    );
  }
  if (error instanceof EntitlementLimitReachedError) {
    return context.json(
      {
        error: { code: error.code, limit: error.key },
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
    logServerErrorFromContext(context, error, 503);
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
    if (status === 503) {
      logServerErrorFromContext(context, error, status);
    }
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
  logServerErrorFromContext(context, error, 500);
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

async function storeMediaStagingMarker(
  mediaBucket: MediaBucketBinding,
  stagingKey: string,
  storageKey: string
): Promise<void> {
  try {
    const stored = await mediaBucket.put(
      stagingKey,
      new TextEncoder().encode(JSON.stringify({ storageKey, version: 1 })),
      {
        httpMetadata: {
          cacheControl: "private, no-store",
          contentType: "application/json",
        },
        onlyIf: new Headers({ "If-None-Match": "*" }),
      }
    );
    if (stored === null) {
      throw new MediaImageProcessingError();
    }
  } catch (cause: unknown) {
    if (cause instanceof MediaImageProcessingError) {
      throw cause;
    }
    // biome-ignore lint/style/useErrorCause: Preserve provider details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
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
    error instanceof MediaUploadCommandConflictError ||
    error instanceof ProductMediaLimitError ||
    error instanceof EntitlementLimitReachedError
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
  const attemptId = crypto.randomUUID();
  const storageKey = mediaObjectKey(
    target.organizationId,
    target.productId,
    target.uploadCommandId,
    inputFingerprint,
    attemptId
  );
  const stagingKey = mediaStagingMarkerKey(attemptId, new Date());
  await storeMediaStagingMarker(mediaBucket, stagingKey, storageKey);
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
    if (canCompensateRejectedMediaWrite(error)) {
      await cleanupRejectedMediaAttempt({
        mediaBucket,
        objectCreated,
        stagingKey,
        storageKey,
      });
    }
    throw error;
  }

  await cleanupSuccessfulMediaAttempt({
    mediaBucket,
    objectCreated,
    replayed: result.replayed,
    stagingKey,
    storageKey,
  });

  return jsonAssetResponse(
    context,
    result.asset,
    result.replayed,
    result.replayed ? 200 : 201
  );
}

type MediaDerivativeRequestSize = 320 | 640 | null;
type ParsedMediaDerivativeRequestSize = MediaDerivativeRequestSize | "invalid";
interface MediaDeliveryPayload {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  byteLength: number;
}
type StoredMediaObject = NonNullable<
  Awaited<ReturnType<MediaBucketBinding["get"]>>
>;

function parseMediaDerivativeSize(
  value: string | undefined
): ParsedMediaDerivativeRequestSize {
  if (value === undefined) {
    return null;
  }
  if (value === "320") {
    return 320;
  }
  if (value === "640") {
    return 640;
  }
  return "invalid";
}

async function getMediaObject(
  bucket: MediaBucketBinding,
  key: string
): Promise<StoredMediaObject | null> {
  try {
    return await bucket.get(key);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve storage details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
}

async function putMediaDerivative(
  bucket: MediaBucketBinding,
  key: string,
  bytes: Uint8Array
): Promise<{ etag: string } | null> {
  try {
    return await bucket.put(key, bytes, {
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "image/webp",
      },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve storage details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
}

async function readStoredMediaBytes(
  object: StoredMediaObject
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await object.arrayBuffer());
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve storage details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
}

async function createOrReadMediaDerivative(input: {
  asset: NonNullable<Awaited<ReturnType<typeof getMediaAssetForDelivery>>>;
  derivativeProcessor: DerivativeProcessor;
  mediaBucket: MediaBucketBinding;
  size: 320 | 640;
  images: NonNullable<ServerEnv["Bindings"]["IMAGES"]>;
}): Promise<MediaDeliveryPayload | null> {
  const derivativeKey = mediaDerivativeKey(input.asset.assetId, input.size);
  const cached = await getMediaObject(input.mediaBucket, derivativeKey);
  if (cached) {
    return { body: cached.body, byteLength: cached.size };
  }

  const master = await getMediaObject(
    input.mediaBucket,
    input.asset.storageKey
  );
  if (!master) {
    return null;
  }

  const derivative = await input.derivativeProcessor({
    images: input.images,
    maxEdge: input.size,
    sourceBytes: await readStoredMediaBytes(master),
  });
  const stored = await putMediaDerivative(
    input.mediaBucket,
    derivativeKey,
    derivative.bytes
  );
  if (stored !== null) {
    return {
      body: derivative.bytes.slice().buffer as ArrayBuffer,
      byteLength: derivative.byteLength,
    };
  }

  const raced = await getMediaObject(input.mediaBucket, derivativeKey);
  if (!raced) {
    throw new MediaImageProcessingError();
  }
  return { body: raced.body, byteLength: raced.size };
}

async function resolveMediaDeliveryPayload(input: {
  asset: NonNullable<Awaited<ReturnType<typeof getMediaAssetForDelivery>>>;
  derivativeProcessor: DerivativeProcessor;
  mediaBucket: MediaBucketBinding;
  size: MediaDerivativeRequestSize;
  images: ServerEnv["Bindings"]["IMAGES"];
}): Promise<MediaDeliveryPayload | null> {
  if (input.size === null) {
    const master = await getMediaObject(
      input.mediaBucket,
      input.asset.storageKey
    );
    return master
      ? { body: master.body, byteLength: input.asset.byteSize }
      : null;
  }
  if (!input.images) {
    throw new MediaImageProcessingError();
  }
  return await createOrReadMediaDerivative({
    asset: input.asset,
    derivativeProcessor: input.derivativeProcessor,
    images: input.images,
    mediaBucket: input.mediaBucket,
    size: input.size,
  });
}

async function getTenantMediaAsset(input: {
  context: Context<ServerEnv>;
  getAsset: typeof getMediaAssetForDelivery;
  organizationId: string;
  tenantRequest: TenantRunner;
}) {
  return await input.tenantRequest({
    bindings: input.context.env,
    capability: "catalog:read",
    operation: (transaction, identity) =>
      input.getAsset(
        transaction,
        identity.organizationId,
        input.context.req.param("assetId") ?? ""
      ),
    request: input.context.req.raw,
    requestedOrganizationId: input.organizationId,
  });
}

function mediaNotFoundResponse(context: Context<ServerEnv>): Response {
  return context.json(
    { error: { code: "not_found" }, requestId: context.get("requestId") },
    404
  );
}

function mediaDeliveryResponse(
  context: Context<ServerEnv>,
  payload: MediaDeliveryPayload
): Response {
  return context.body(payload.body, 200, {
    "Cache-Control": "private, no-store",
    "Content-Length": String(payload.byteLength),
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
  });
}

async function handleMediaDelivery(
  context: Context<ServerEnv>,
  dependencies: {
    derivativeProcessor: DerivativeProcessor;
    getAsset: typeof getMediaAssetForDelivery;
    tenantRequest: TenantRunner;
  }
): Promise<Response> {
  // A malformed id can never name an asset; answer before opening a database transaction.
  if (!uuidPattern.test(context.req.param("assetId") ?? "")) {
    return mediaNotFoundResponse(context);
  }
  const organizationId =
    context.req.query("organizationId") ??
    context.req.header("x-organization-id") ??
    "";
  if (!organizationId.trim() || organizationId !== organizationId.trim()) {
    return errorResponse(context, new InvalidMediaUploadRequestError());
  }
  const size = parseMediaDerivativeSize(context.req.query("size"));
  if (size === "invalid") {
    return errorResponse(context, new InvalidMediaUploadRequestError());
  }
  const mediaBucket = context.env.MEDIA_BUCKET;
  if (!mediaBucket) {
    return errorResponse(context, new MediaImageProcessingError());
  }

  try {
    const asset = await getTenantMediaAsset({
      context,
      getAsset: dependencies.getAsset,
      organizationId,
      tenantRequest: dependencies.tenantRequest,
    });
    if (!asset) {
      return mediaNotFoundResponse(context);
    }
    const payload = await resolveMediaDeliveryPayload({
      asset,
      derivativeProcessor: dependencies.derivativeProcessor,
      images: context.env.IMAGES,
      mediaBucket,
      size,
    });
    return payload
      ? mediaDeliveryResponse(context, payload)
      : mediaNotFoundResponse(context);
  } catch (error) {
    return errorResponse(context, error);
  }
}

async function cleanupRejectedMediaAttempt(input: {
  mediaBucket: MediaBucketBinding;
  objectCreated: boolean;
  stagingKey: string;
  storageKey: string;
}): Promise<void> {
  if (!input.objectCreated) {
    return;
  }
  try {
    await input.mediaBucket.delete(input.storageKey);
    await input.mediaBucket.delete(input.stagingKey);
  } catch {
    // Keep the staging marker so the reconciler can retry both deletions.
  }
}

async function cleanupSuccessfulMediaAttempt(input: {
  mediaBucket: MediaBucketBinding;
  objectCreated: boolean;
  replayed: boolean;
  stagingKey: string;
  storageKey: string;
}): Promise<void> {
  try {
    if (input.replayed && input.objectCreated) {
      await input.mediaBucket.delete(input.storageKey);
    }
    if (!input.replayed || input.objectCreated) {
      await input.mediaBucket.delete(input.stagingKey);
    }
  } catch {
    // The marker lets the reconciler distinguish referenced and orphan objects.
  }
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
  const derivativeProcessor =
    overrides.processMediaDerivative ?? processMediaDerivative;
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
    // A malformed id can never name a product; answer before opening a database transaction.
    if (!uuidPattern.test(productId)) {
      return mediaNotFoundResponse(context);
    }
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

  app.get(
    "/api/media/:assetId",
    async (context) =>
      await handleMediaDelivery(context, {
        derivativeProcessor,
        getAsset,
        tenantRequest,
      })
  );

  return app;
}
