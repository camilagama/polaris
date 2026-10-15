export const MAX_MEDIA_INPUT_BYTES = 20_000_000;
export const MAX_MEDIA_OUTPUT_EDGE = 1200;
export const MAX_PRODUCT_MEDIA = 20;

const supportedMediaContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface NormalizedMediaCropRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface MediaImageDimensions {
  height: number;
  width: number;
}

export interface MediaCropPixels {
  height: number;
  left: number;
  top: number;
  width: number;
}

export class InvalidMediaCropError extends Error {
  constructor(options?: ErrorOptions) {
    super("invalid_media_crop", options);
    this.name = "InvalidMediaCropError";
  }
}

export class MediaImageTooLargeError extends Error {
  constructor() {
    super("media_image_too_large");
    this.name = "MediaImageTooLargeError";
  }
}

export class MediaImageProcessingError extends Error {
  constructor(options?: ErrorOptions) {
    super("media_image_processing_failed", options);
    this.name = "MediaImageProcessingError";
  }
}

export class MediaUploadCommandConflictError extends Error {
  readonly code = "media_upload_command_conflict";

  constructor() {
    super("media_upload_command_conflict");
    this.name = "MediaUploadCommandConflictError";
  }
}

export class UnsupportedMediaImageError extends Error {
  constructor(options?: ErrorOptions) {
    super("unsupported_media_image", options);
    this.name = "UnsupportedMediaImageError";
  }
}

export function validateNormalizedMediaCropRect(
  input: unknown
): NormalizedMediaCropRect {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidMediaCropError();
  }

  const value = input as Partial<NormalizedMediaCropRect>;
  const values = [value.x, value.y, value.width, value.height];
  if (
    values.some(
      (coordinate) =>
        typeof coordinate !== "number" || !Number.isFinite(coordinate)
    ) ||
    (value.x as number) < 0 ||
    (value.y as number) < 0 ||
    (value.width as number) <= 0 ||
    (value.height as number) <= 0 ||
    (value.x as number) + (value.width as number) > 1 ||
    (value.y as number) + (value.height as number) > 1
  ) {
    throw new InvalidMediaCropError();
  }

  return {
    height: value.height as number,
    width: value.width as number,
    x: value.x as number,
    y: value.y as number,
  };
}

export function cropRectToPixels(
  crop: NormalizedMediaCropRect,
  source: MediaImageDimensions
): MediaCropPixels {
  const { height: sourceHeight, width: sourceWidth } = source;
  const normalizedCrop = validateNormalizedMediaCropRect(crop);

  if (
    !Number.isSafeInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceHeight <= 0
  ) {
    throw new InvalidMediaCropError();
  }

  const left = Math.floor(normalizedCrop.x * sourceWidth);
  const top = Math.floor(normalizedCrop.y * sourceHeight);
  const right = Math.ceil(
    (normalizedCrop.x + normalizedCrop.width) * sourceWidth - 1e-9
  );
  const bottom = Math.ceil(
    (normalizedCrop.y + normalizedCrop.height) * sourceHeight - 1e-9
  );
  const width = Math.min(sourceWidth, right) - left;
  const height = Math.min(sourceHeight, bottom) - top;

  if (width <= 0 || height <= 0) {
    throw new InvalidMediaCropError();
  }

  return { height, left, top, width };
}

export function validateMediaImageSource(input: {
  byteLength: number;
  contentType: string;
}): void {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    !supportedMediaContentTypes.has(input.contentType.trim().toLowerCase())
  ) {
    throw new UnsupportedMediaImageError();
  }

  if (input.byteLength > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaImageTooLargeError();
  }
}

export class ProductMediaLimitError extends Error {
  readonly code = "product_media_limit";

  constructor() {
    super("product_media_limit");
    this.name = "ProductMediaLimitError";
  }
}

/** The requested order is not exactly the product's current images (one was added or removed meanwhile, or an ID repeats). */
export class InvalidMediaOrderError extends Error {
  readonly code = "invalid_media_order";

  constructor() {
    super("invalid_media_order");
    this.name = "InvalidMediaOrderError";
  }
}

/**
 * The new order of a product's images: the requested asset IDs, which must be
 * exactly the current ones in any order (no repeats, none missing, none extra).
 * A stale screen that does not know about a change is refused, never applied
 * over it. Returns the positions each asset takes (0, 1, 2...).
 */
export function planMediaOrder(
  currentAssetIds: readonly string[],
  requestedAssetIds: readonly string[]
): Map<string, number> {
  const current = new Set(currentAssetIds);
  const requested = new Set(requestedAssetIds);
  if (
    requested.size !== requestedAssetIds.length ||
    requested.size !== current.size ||
    requestedAssetIds.some((id) => !current.has(id))
  ) {
    throw new InvalidMediaOrderError();
  }
  return new Map(requestedAssetIds.map((id, position) => [id, position]));
}
