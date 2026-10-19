import {
  cropRectToPixels,
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_OUTPUT_EDGE,
  MediaImageProcessingError,
  MediaImageTooLargeError,
  MediaTransformQuotaExceededError,
  type NormalizedMediaCropRect,
  UnsupportedMediaImageError,
  validateMediaImageSource,
} from "@polaris/domain/catalog/media";

interface ImageInfo {
  fileSize?: number;
  format: string;
  height?: number;
  width?: number;
}

type ImageTransform =
  | { trim: { height: number; left: number; top: number; width: number } }
  | { fit: "scale-down"; height: number; width: number };

interface ImageTransformation {
  response: () => Response;
}

interface ImageTransformer {
  output: (options: {
    format: "image/webp";
    quality: number;
  }) => Promise<ImageTransformation>;
  transform: (options: ImageTransform) => ImageTransformer;
}

export interface MediaImagesBinding {
  info: (stream: ReadableStream<Uint8Array>) => Promise<ImageInfo>;
  input: (stream: ReadableStream<Uint8Array>) => ImageTransformer;
}

export interface ProcessedMediaImage {
  byteLength: number;
  bytes: Uint8Array;
  contentType: "image/webp";
  height: number;
  width: number;
}

interface ProcessMediaImageInput {
  crop: NormalizedMediaCropRect;
  declaredContentType?: string;
  images: MediaImagesBinding;
  sourceBytes: Uint8Array;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function normalizedImageFormat(format: string): string | null {
  switch (format.trim().toLowerCase()) {
    case "jpeg":
    case "jpg":
    case "image/jpeg":
      return "image/jpeg";
    case "png":
    case "image/png":
      return "image/png";
    case "webp":
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Cloudflare Images answers 9422 ("the transformation request is rejected because
 * the usage limit was reached") once the free allowance of 5,000 unique
 * transformations in the month is spent. The documentation does not show how the
 * Workers binding exposes it, so every plausible shape is accepted: the numeric
 * (or numeric string) `code`, the same shape used for 9412; the standalone number
 * 9422 in the error message (or in a thrown string); and the `Cf-Resized:
 * err=9422` header of a rejected response. The real format is a go-live BLOCK in
 * the release checklist. Source: developers.cloudflare.com/images/pricing and
 * /images/reference/troubleshooting (consulted 18/10/2026).
 */
const QUOTA_EXCEEDED_CODE = 9422;
const QUOTA_EXCEEDED_HEADER = /(?:^|[\s,;])err=9422(?:$|[\s,;])/;
// 9422 as its own token: not inside UUIDs, versions or longer numbers, and not a
// dimension ("9422 px", "9422x600", "9422 x 600").
const QUOTA_EXCEEDED_MESSAGE =
  /(?<![\w.-])9422(?![\w.-])(?!\s*(?:px\b|x\s*\d))/i;

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "";
}

function hasQuotaExceededCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === QUOTA_EXCEEDED_CODE ||
      error.code === String(QUOTA_EXCEEDED_CODE))
  );
}

function hasProviderInvalidImageCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 9412
  );
}

/** Only for errors thrown by the Images binding: the message is a last-resort signal. */
function isProviderQuotaFailure(cause: unknown): boolean {
  if (hasProviderInvalidImageCode(cause)) {
    return false;
  }
  return (
    hasQuotaExceededCode(cause) ||
    QUOTA_EXCEEDED_MESSAGE.test(errorMessage(cause))
  );
}

function isQuotaExceededResponse(response: Response): boolean {
  return QUOTA_EXCEEDED_HEADER.test(response.headers.get("cf-resized") ?? "");
}

/** The transformation was refused for quota; any other failure is a processing error. */
export function isMediaTransformQuotaExceeded(error: unknown): boolean {
  return (
    error instanceof MediaTransformQuotaExceededError ||
    hasQuotaExceededCode(error)
  );
}

function providerFailure(cause: unknown): Error {
  if (isProviderQuotaFailure(cause)) {
    return new MediaTransformQuotaExceededError({ cause });
  }
  return new MediaImageProcessingError({ cause });
}

async function readImageInfo(
  images: MediaImagesBinding,
  bytes: Uint8Array
): Promise<ImageInfo> {
  try {
    return await images.info(byteStream(bytes));
  } catch (cause: unknown) {
    if (hasProviderInvalidImageCode(cause)) {
      // biome-ignore lint/style/useErrorCause: Keep provider details available internally while returning a stable image validation error.
      throw new UnsupportedMediaImageError({ cause });
    }
    throw providerFailure(cause);
  }
}

function validatedDimensions(info: ImageInfo): {
  height: number;
  width: number;
} {
  const { height, width } = info;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new UnsupportedMediaImageError();
  }
  return { height, width };
}

export async function processMediaImage({
  crop,
  declaredContentType,
  images,
  sourceBytes,
}: ProcessMediaImageInput): Promise<ProcessedMediaImage> {
  if (sourceBytes.byteLength > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaImageTooLargeError();
  }

  if (sourceBytes.byteLength === 0) {
    throw new UnsupportedMediaImageError();
  }

  const sourceInfo = await readImageInfo(images, sourceBytes);
  const sourceContentType = normalizedImageFormat(sourceInfo.format);
  if (sourceContentType === null) {
    throw new UnsupportedMediaImageError();
  }

  validateMediaImageSource({
    byteLength: sourceBytes.byteLength,
    contentType: sourceContentType,
  });

  const declaredFormat = declaredContentType
    ? normalizedImageFormat(declaredContentType)
    : null;
  if (declaredFormat !== null && declaredFormat !== sourceContentType) {
    throw new UnsupportedMediaImageError();
  }

  const sourceDimensions = validatedDimensions(sourceInfo);
  const cropPixels = cropRectToPixels(crop, sourceDimensions);

  let transformed: ImageTransformation;
  try {
    transformed = await images
      .input(byteStream(sourceBytes))
      .transform({ trim: cropPixels })
      .transform({
        fit: "scale-down",
        height: MAX_MEDIA_OUTPUT_EDGE,
        width: MAX_MEDIA_OUTPUT_EDGE,
      })
      .output({ format: "image/webp", quality: 85 });
  } catch (cause: unknown) {
    throw providerFailure(cause);
  }

  let response: Response;
  try {
    response = transformed.response();
  } catch (cause: unknown) {
    throw providerFailure(cause);
  }

  if (isQuotaExceededResponse(response)) {
    throw new MediaTransformQuotaExceededError();
  }
  if (!response.ok || response.body === null) {
    throw new MediaImageProcessingError();
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "image/webp") {
    throw new UnsupportedMediaImageError();
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Keep provider details available internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
  if (bytes.byteLength === 0) {
    throw new MediaImageProcessingError();
  }

  const outputInfo = await readImageInfo(images, bytes);
  const outputContentType = normalizedImageFormat(outputInfo.format);
  const outputDimensions = validatedDimensions(outputInfo);
  if (
    outputContentType !== "image/webp" ||
    outputDimensions.width > MAX_MEDIA_OUTPUT_EDGE ||
    outputDimensions.height > MAX_MEDIA_OUTPUT_EDGE ||
    outputDimensions.width > cropPixels.width ||
    outputDimensions.height > cropPixels.height
  ) {
    throw new UnsupportedMediaImageError();
  }

  return {
    byteLength: bytes.byteLength,
    bytes,
    contentType: "image/webp",
    ...outputDimensions,
  };
}

export async function processMediaDerivative(input: {
  images: MediaImagesBinding;
  maxEdge: 320 | 640;
  sourceBytes: Uint8Array;
}): Promise<ProcessedMediaImage> {
  if (
    input.sourceBytes.byteLength === 0 ||
    input.sourceBytes.byteLength > MAX_MEDIA_INPUT_BYTES
  ) {
    throw new MediaImageProcessingError();
  }

  const sourceInfo = await readImageInfo(input.images, input.sourceBytes);
  if (normalizedImageFormat(sourceInfo.format) !== "image/webp") {
    throw new UnsupportedMediaImageError();
  }
  const sourceDimensions = validatedDimensions(sourceInfo);

  let transformed: ImageTransformation;
  try {
    transformed = await input.images
      .input(byteStream(input.sourceBytes))
      .transform({
        fit: "scale-down",
        height: input.maxEdge,
        width: input.maxEdge,
      })
      .output({ format: "image/webp", quality: 85 });
  } catch (cause: unknown) {
    throw providerFailure(cause);
  }

  let response: Response;
  try {
    response = transformed.response();
  } catch (cause: unknown) {
    throw providerFailure(cause);
  }
  if (isQuotaExceededResponse(response)) {
    throw new MediaTransformQuotaExceededError();
  }
  if (!response.ok || response.body === null) {
    throw new MediaImageProcessingError();
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "image/webp") {
    throw new UnsupportedMediaImageError();
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Preserve provider details internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }
  if (bytes.byteLength === 0) {
    throw new MediaImageProcessingError();
  }

  const outputInfo = await readImageInfo(input.images, bytes);
  const outputContentType = normalizedImageFormat(outputInfo.format);
  const outputDimensions = validatedDimensions(outputInfo);
  if (
    outputContentType !== "image/webp" ||
    outputDimensions.width > input.maxEdge ||
    outputDimensions.height > input.maxEdge ||
    outputDimensions.width > sourceDimensions.width ||
    outputDimensions.height > sourceDimensions.height
  ) {
    throw new UnsupportedMediaImageError();
  }

  return {
    byteLength: bytes.byteLength,
    bytes,
    contentType: "image/webp",
    ...outputDimensions,
  };
}
