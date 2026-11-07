import {
  type ProductMediaAssetReadModel,
  type ProductMediaListResponse,
  type ProductMediaRemoveResponse,
  type ProductMediaUploadResponse,
  productMediaListResponseSchema,
  productMediaRemoveResponseSchema,
  productMediaUploadResponseSchema,
} from "@polaris/contracts";
import type { NormalizedMediaCropRect } from "@polaris/domain/catalog/media";
import {
  cropRectToPixels,
  InvalidMediaCropError,
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_OUTPUT_EDGE,
  MediaImageTooLargeError,
  UnsupportedMediaImageError,
  validateMediaImageSource,
} from "@polaris/domain/catalog/media";
import { browserConnection } from "./browser-connection";
import { trackWrite } from "./writes-in-flight";

/** The Worker's calls go through the connection: an answer without the Worker's mark is no answer (emenda do ADR 0043). */
type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;
export interface PrepareMediaUploadFileDependencies {
  rasterizeHeic?: (file: File) => Promise<Blob>;
}
export interface PrepareMediaUploadMasterDependencies
  extends PrepareMediaUploadFileDependencies {
  /** Draws the crop of the image at no more than `MAX_MEDIA_OUTPUT_EDGE` on its longer side, as JPEG. */
  renderMaster?: (file: File, crop: NormalizedMediaCropRect) => Promise<Blob>;
}

export class MediaUploadHttpError extends Error {
  readonly code: string;
  /** The plan's limit a `entitlement_limit_reached` names (`images.active.max`, `images.per_product.max`), or null. */
  readonly limit: string | null;
  readonly status: number;

  constructor(
    code: string,
    status: number,
    cause?: unknown,
    limit: string | null = null
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MediaUploadHttpError";
    this.code = code;
    this.limit = limit;
    this.status = status;
  }
}

/** The `limit` of the Worker's error body (`{ error: { code, limit } }`), when it has one. */
function errorLimitOf(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "limit" in payload.error &&
    typeof payload.error.limit === "string"
  ) {
    return payload.error.limit;
  }
  return null;
}

export interface UploadProductMediaInput {
  crop: NormalizedMediaCropRect;
  file: File;
  organizationId: string;
  origin?: string;
  productId: string;
  uploadCommandId: string;
  variantIds?: readonly string[];
}

export async function uploadProductMedia(
  input: UploadProductMediaInput,
  fetcher: Fetcher = browserConnection.fetch,
  dependencies: PrepareMediaUploadMasterDependencies = {}
): Promise<ProductMediaUploadResponse> {
  const file = await prepareMediaUploadMaster(
    input.file,
    input.crop,
    dependencies
  );
  const headers = new Headers({
    "Content-Type": file.type,
    "X-Media-Crop": JSON.stringify(fullImageCrop),
    "X-Organization-Id": input.organizationId,
    "X-Upload-Id": input.uploadCommandId,
  });
  if (input.variantIds && input.variantIds.length > 0) {
    headers.set("X-Product-Variant-Ids", JSON.stringify([...input.variantIds]));
  }

  const url = new URL(
    `/api/products/${encodeURIComponent(input.productId)}/media`,
    input.origin || globalThis.location?.origin || "http://localhost"
  );
  // the media goes outside the oRPC link: it counts as a write on its way by itself (it holds the swap of the build)
  const response = await trackWrite(["media", "upload"], () =>
    fetcher(url, {
      body: file,
      credentials: "same-origin",
      headers,
      method: "POST",
    })
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the parse failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError(
      "media_upload_failed",
      response.status,
      cause
    );
  }

  if (!response.ok) {
    const code =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "code" in payload.error &&
      typeof payload.error.code === "string"
        ? payload.error.code
        : "media_upload_failed";
    throw new MediaUploadHttpError(
      code,
      response.status,
      undefined,
      errorLimitOf(payload)
    );
  }

  try {
    return productMediaUploadResponseSchema.parse(payload);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the validation failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError("invalid_media_response", 502, cause);
  }
}

export async function listProductMedia(
  input: {
    organizationId: string;
    origin?: string;
    productId: string;
  },
  fetcher: Fetcher = browserConnection.fetch
): Promise<ProductMediaListResponse> {
  const url = new URL(
    `/api/products/${encodeURIComponent(input.productId)}/media`,
    input.origin || globalThis.location?.origin || "http://localhost"
  );
  url.searchParams.set("organizationId", input.organizationId);
  const response = await fetcher(url, {
    credentials: "same-origin",
    headers: { "X-Organization-Id": input.organizationId },
    method: "GET",
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the parse failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError("media_list_failed", response.status, cause);
  }
  if (!response.ok) {
    const code =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "code" in payload.error &&
      typeof payload.error.code === "string"
        ? payload.error.code
        : "media_list_failed";
    throw new MediaUploadHttpError(code, response.status);
  }
  try {
    return productMediaListResponseSchema.parse(payload);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the validation failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError("invalid_media_list_response", 502, cause);
  }
}

async function sendMediaCommand<T>(
  input: { organizationId: string; origin?: string; path: string },
  init: { body?: string; method: "DELETE" | "PUT" },
  parse: (payload: unknown) => T,
  failureCode: string,
  fetcher: Fetcher
): Promise<T> {
  const url = new URL(
    input.path,
    input.origin || globalThis.location?.origin || "http://localhost"
  );
  const headers = new Headers({ "X-Organization-Id": input.organizationId });
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await trackWrite(["media", init.method], () =>
    fetcher(url, {
      ...(init.body === undefined ? {} : { body: init.body }),
      credentials: "same-origin",
      headers,
      method: init.method,
    })
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the parse failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError(failureCode, response.status, cause);
  }
  if (!response.ok) {
    const code =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "code" in payload.error &&
      typeof payload.error.code === "string"
        ? payload.error.code
        : failureCode;
    throw new MediaUploadHttpError(code, response.status);
  }
  try {
    return parse(payload);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves the validation failure as Error.cause while exposing a stable client code.
    throw new MediaUploadHttpError("invalid_media_response", 502, cause);
  }
}

/** Removes an image from a product; removing one that is already gone answers `removed: false`. */
export function removeProductMedia(
  input: {
    assetId: string;
    organizationId: string;
    origin?: string;
    productId: string;
  },
  fetcher: Fetcher = browserConnection.fetch
): Promise<ProductMediaRemoveResponse> {
  return sendMediaCommand(
    {
      organizationId: input.organizationId,
      path: `/api/products/${encodeURIComponent(input.productId)}/media/${encodeURIComponent(input.assetId)}`,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    },
    { method: "DELETE" },
    (payload) => productMediaRemoveResponseSchema.parse(payload),
    "media_remove_failed",
    fetcher
  );
}

/** Sets the order of the images of a product; the list must be exactly its current images. */
export function reorderProductMedia(
  input: {
    assetIds: readonly string[];
    organizationId: string;
    origin?: string;
    productId: string;
  },
  fetcher: Fetcher = browserConnection.fetch
): Promise<ProductMediaListResponse> {
  return sendMediaCommand(
    {
      organizationId: input.organizationId,
      path: `/api/products/${encodeURIComponent(input.productId)}/media/order`,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    },
    { body: JSON.stringify({ assetIds: [...input.assetIds] }), method: "PUT" },
    (payload) => productMediaListResponseSchema.parse(payload),
    "media_reorder_failed",
    fetcher
  );
}

export function productMediaAssetUrl(
  asset: Pick<ProductMediaAssetReadModel, "assetId">,
  organizationId: string,
  origin?: string,
  size?: 320 | 640
): string {
  const url = new URL(
    `/api/media/${encodeURIComponent(asset.assetId)}`,
    origin || globalThis.location?.origin || "http://localhost"
  );
  url.searchParams.set("organizationId", organizationId);
  if (size !== undefined) {
    url.searchParams.set("size", String(size));
  }
  return url.toString();
}

const supportedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const heicContentTypes = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const heicExtensionPattern = /\.(heic|heif)$/i;
const fileExtensionPattern = /\.[^.]*$/;

function extensionContentType(name: string): string | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  if (extension === "heic") {
    return "image/heic";
  }
  if (extension === "heif") {
    return "image/heif";
  }
  return undefined;
}

function sourceContentType(file: File): string {
  return (
    file.type.trim().toLowerCase() || extensionContentType(file.name) || ""
  );
}

interface DecodedImage {
  height: number;
  release: () => void;
  source: CanvasImageSource;
  width: number;
}

function loadImageElement(image: HTMLImageElement, url: string) {
  return new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("decode_failed")), {
      once: true,
    });
    image.src = url;
    if (image.complete) {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve();
      } else {
        reject(new Error("decode_failed"));
      }
    }
  });
}

/** The image upright (its EXIF orientation applied), as the preview and the crop see it. */
async function decodeImageInBrowser(file: File): Promise<DecodedImage> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new UnsupportedMediaImageError();
  }
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        height: bitmap.height,
        release: () => bitmap.close(),
        source: bitmap,
        width: bitmap.width,
      };
    } catch {
      // Safari can display HEIC in an image element even if ImageBitmap
      // cannot decode that particular file.
    }
  }
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await loadImageElement(image, url);
  } catch (cause: unknown) {
    URL.revokeObjectURL(url);
    throw cause;
  }
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    URL.revokeObjectURL(url);
    throw new UnsupportedMediaImageError();
  }
  return {
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
    source: image,
    width: image.naturalWidth,
  };
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type !== "image/jpeg" || blob.size === 0) {
          reject(new UnsupportedMediaImageError());
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

async function rasterizeHeicInBrowser(file: File): Promise<Blob> {
  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImageInBrowser(file);
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new UnsupportedMediaImageError();
    }
    context.drawImage(decoded.source, 0, 0);
    return await canvasJpeg(canvas, 0.92);
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves decoder details as Error.cause without exposing them in the UI.
    throw new UnsupportedMediaImageError({ cause });
  } finally {
    decoded?.release();
  }
}

const MASTER_JPEG_QUALITY = 0.9;
const fullImageCrop: NormalizedMediaCropRect = {
  height: 1,
  width: 1,
  x: 0,
  y: 0,
};

/** The size of the master: the crop scaled down, never up, to `MAX_MEDIA_OUTPUT_EDGE` on its longer side. */
export function mediaUploadMasterSize(crop: {
  height: number;
  width: number;
}): { height: number; width: number } {
  const scale = Math.min(
    1,
    MAX_MEDIA_OUTPUT_EDGE / Math.max(crop.width, crop.height)
  );
  return {
    height: Math.max(1, Math.round(crop.height * scale)),
    width: Math.max(1, Math.round(crop.width * scale)),
  };
}

async function renderMediaUploadMasterInBrowser(
  file: File,
  crop: NormalizedMediaCropRect
): Promise<Blob> {
  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImageInBrowser(file);
    const pixels = cropRectToPixels(crop, decoded);
    const size = mediaUploadMasterSize(pixels);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new UnsupportedMediaImageError();
    }
    // JPEG has no alpha: a transparent PNG would turn black without a background under it
    context.fillStyle = "white";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      decoded.source,
      pixels.left,
      pixels.top,
      pixels.width,
      pixels.height,
      0,
      0,
      size.width,
      size.height
    );
    return await canvasJpeg(canvas, MASTER_JPEG_QUALITY);
  } catch (cause: unknown) {
    if (cause instanceof InvalidMediaCropError) {
      throw cause;
    }
    // biome-ignore lint/style/useErrorCause: This wrapper preserves decoder details as Error.cause without exposing them in the UI.
    throw new UnsupportedMediaImageError({ cause });
  } finally {
    decoded?.release();
  }
}

/**
 * One master per picked file and crop: a retry sends the very same bytes (a new encoding could differ by a byte and
 * the server would answer 409 for the same command), and a failed preparation is tried again.
 */
const preparedMasters = new WeakMap<File, Map<string, Promise<File>>>();

function cropKey(crop: NormalizedMediaCropRect): string {
  return JSON.stringify([crop.x, crop.y, crop.width, crop.height]);
}

/**
 * The file the server receives: the crop applied and scaled down to `MAX_MEDIA_OUTPUT_EDGE` px, in JPEG, sent with
 * the whole-image crop. The server still makes the master through Images (ADR 0018); it only receives less.
 */
export function prepareMediaUploadMaster(
  file: File,
  crop: NormalizedMediaCropRect,
  dependencies: PrepareMediaUploadMasterDependencies = {}
): Promise<File> {
  const key = cropKey(crop);
  let byCrop = preparedMasters.get(file);
  if (!byCrop) {
    byCrop = new Map();
    preparedMasters.set(file, byCrop);
  }
  const cached = byCrop.get(key);
  if (cached) {
    return cached;
  }
  const prepared = renderMediaUploadMaster(file, crop, dependencies);
  byCrop.set(key, prepared);
  prepared.catch(() => {
    if (byCrop.get(key) === prepared) {
      byCrop.delete(key);
    }
  });
  return prepared;
}

async function renderMediaUploadMaster(
  file: File,
  crop: NormalizedMediaCropRect,
  dependencies: PrepareMediaUploadMasterDependencies
): Promise<File> {
  const source = await prepareMediaUploadFile(file, dependencies);
  const render = dependencies.renderMaster ?? renderMediaUploadMasterInBrowser;
  const jpeg = await render(source, crop);
  if (jpeg.type !== "image/jpeg" || jpeg.size === 0) {
    throw new UnsupportedMediaImageError();
  }
  if (jpeg.size > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaImageTooLargeError();
  }
  const name = source.name.replace(fileExtensionPattern, "") || "media";
  return new File([jpeg], `${name}.jpg`, {
    lastModified: source.lastModified,
    type: "image/jpeg",
  });
}

export async function prepareMediaUploadFile(
  file: File,
  dependencies: PrepareMediaUploadFileDependencies = {}
): Promise<File> {
  if (file.size > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaImageTooLargeError();
  }
  if (file.size === 0) {
    throw new UnsupportedMediaImageError();
  }

  const contentType = sourceContentType(file);
  if (heicContentTypes.has(contentType)) {
    const rasterize = dependencies.rasterizeHeic ?? rasterizeHeicInBrowser;
    const jpeg = await rasterize(file);
    if (
      jpeg.size === 0 ||
      jpeg.size > MAX_MEDIA_INPUT_BYTES ||
      jpeg.type !== "image/jpeg"
    ) {
      if (jpeg.size > MAX_MEDIA_INPUT_BYTES) {
        throw new MediaImageTooLargeError();
      }
      throw new UnsupportedMediaImageError();
    }

    const name = file.name.replace(heicExtensionPattern, "") || "media";
    return new File([jpeg], `${name}.jpg`, {
      lastModified: file.lastModified,
      type: "image/jpeg",
    });
  }

  if (!supportedContentTypes.has(contentType)) {
    throw new UnsupportedMediaImageError();
  }

  validateMediaImageSource({ byteLength: file.size, contentType });
  if (file.type === contentType) {
    return file;
  }
  return new File([file], file.name, {
    lastModified: file.lastModified,
    type: contentType,
  });
}
