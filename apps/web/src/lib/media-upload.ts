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
  MAX_MEDIA_INPUT_BYTES,
  MediaImageTooLargeError,
  UnsupportedMediaImageError,
  validateMediaImageSource,
} from "@polaris/domain/catalog/media";
import { browserConnection } from "./browser-connection";

/** The Worker's calls go through the connection: an answer without the Worker's mark is no answer (emenda do ADR 0043). */
type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;
export interface PrepareMediaUploadFileDependencies {
  rasterizeHeic?: (file: File) => Promise<Blob>;
}

export class MediaUploadHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MediaUploadHttpError";
    this.code = code;
    this.status = status;
  }
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
  fetcher: Fetcher = browserConnection.fetch
): Promise<ProductMediaUploadResponse> {
  const file = await prepareMediaUploadFile(input.file);
  const headers = new Headers({
    "Content-Type": file.type,
    "X-Media-Crop": JSON.stringify(input.crop),
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
  const response = await fetcher(url, {
    body: file,
    credentials: "same-origin",
    headers,
    method: "POST",
  });

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
    throw new MediaUploadHttpError(code, response.status);
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
  const response = await fetcher(url, {
    ...(init.body === undefined ? {} : { body: init.body }),
    credentials: "same-origin",
    headers,
    method: init.method,
  });
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

async function rasterizeHeicInBrowser(file: File): Promise<Blob> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new UnsupportedMediaImageError();
  }

  let bitmap: ImageBitmap | undefined;
  let image: HTMLImageElement | undefined;
  let imageUrl: string | undefined;
  try {
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
      } catch {
        // Safari can display HEIC in an image element even if ImageBitmap
        // cannot decode that particular file.
      }
    }

    if (!bitmap) {
      const fallbackImage = new Image();
      const fallbackUrl = URL.createObjectURL(file);
      image = fallbackImage;
      imageUrl = fallbackUrl;
      await new Promise<void>((resolve, reject) => {
        fallbackImage.addEventListener("load", () => resolve(), {
          once: true,
        });
        fallbackImage.addEventListener(
          "error",
          () => reject(new Error("decode_failed")),
          { once: true }
        );
        fallbackImage.src = fallbackUrl;
        if (fallbackImage.complete) {
          if (
            fallbackImage.naturalWidth > 0 &&
            fallbackImage.naturalHeight > 0
          ) {
            resolve();
          } else {
            reject(new Error("decode_failed"));
          }
        }
      });
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        throw new UnsupportedMediaImageError();
      }
    }

    const imageSource: CanvasImageSource | undefined = bitmap ?? image;
    const width = bitmap?.width ?? image?.naturalWidth;
    const height = bitmap?.height ?? image?.naturalHeight;
    if (!(imageSource && width && height)) {
      throw new UnsupportedMediaImageError();
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new UnsupportedMediaImageError();
    }
    context.drawImage(imageSource, 0, 0);

    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob?.type !== "image/jpeg" || blob.size === 0) {
            reject(new UnsupportedMediaImageError());
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        0.92
      );
    });

    return jpeg;
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: This wrapper preserves decoder details as Error.cause without exposing them in the UI.
    throw new UnsupportedMediaImageError({ cause });
  } finally {
    bitmap?.close();
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
  }
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
