import {
  cropRectToPixels,
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_OUTPUT_EDGE,
  MediaImageProcessingError,
  MediaImageTooLargeError,
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

function hasProviderInvalidImageCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 9412
  );
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
    // biome-ignore lint/style/useErrorCause: Keep provider details available internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
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
    // biome-ignore lint/style/useErrorCause: Keep provider details available internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
  }

  let response: Response;
  try {
    response = transformed.response();
  } catch (cause: unknown) {
    // biome-ignore lint/style/useErrorCause: Keep provider details available internally while returning a stable processing error.
    throw new MediaImageProcessingError({ cause });
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
