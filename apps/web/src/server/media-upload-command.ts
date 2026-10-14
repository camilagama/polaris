import type { NormalizedMediaCropRect } from "@polaris/domain/catalog/media";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const derivativeSizes = new Set([320, 640]);

export type MediaDerivativeSize = 320 | 640;

export interface MediaUploadFingerprintInput {
  crop: NormalizedMediaCropRect;
  organizationId: string;
  productId: string;
  sourceBytes: Uint8Array;
  variantIds: readonly string[];
}

export class InvalidMediaUploadCommandIdError extends Error {
  constructor() {
    super("invalid_media_upload_command_id");
    this.name = "InvalidMediaUploadCommandIdError";
  }
}

export async function mediaUploadFingerprint(
  input: MediaUploadFingerprintInput
): Promise<string> {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      crop: {
        height: input.crop.height,
        width: input.crop.width,
        x: input.crop.x,
        y: input.crop.y,
      },
      organizationId: input.organizationId,
      productId: input.productId,
      transformVersion: 1,
      variantIds: [...input.variantIds].sort(),
    })
  );
  const payload = new Uint8Array(
    metadata.byteLength + 1 + input.sourceBytes.byteLength
  );
  payload.set(metadata);
  payload[metadata.byteLength] = 0;
  payload.set(input.sourceBytes, metadata.byteLength + 1);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function mediaObjectKey(
  organizationId: string,
  productId: string,
  uploadCommandId: string,
  inputFingerprint: string,
  attemptId: string
): string {
  const validCommandId = parseUploadCommandId(uploadCommandId);
  const normalizedProductId = productId.trim();
  const normalizedOrganizationId = organizationId.trim();
  if (
    !normalizedOrganizationId ||
    normalizedOrganizationId !== organizationId ||
    organizationId.length > 255
  ) {
    throw new Error("invalid_media_organization_id");
  }
  if (!normalizedProductId || normalizedProductId !== productId) {
    throw new Error("invalid_media_product_id");
  }
  if (!fingerprintPattern.test(inputFingerprint)) {
    throw new Error("invalid_media_upload_fingerprint");
  }
  if (!uuidV4Pattern.test(attemptId)) {
    throw new Error("invalid_media_attempt_id");
  }
  return `media/v2/${encodeURIComponent(organizationId)}/${normalizedProductId}/${validCommandId}/${inputFingerprint}/${attemptId.toLowerCase()}.webp`;
}

export function mediaStagingMarkerKey(
  attemptId: string,
  createdAt: Date
): string {
  if (
    !(uuidV4Pattern.test(attemptId) && Number.isFinite(createdAt.getTime()))
  ) {
    throw new Error("invalid_media_staging_marker");
  }
  const [date, hour] = createdAt.toISOString().split("T");
  const [year, month, day] = date?.split("-") ?? [];
  if (!(year && month && day && hour)) {
    throw new Error("invalid_media_staging_marker");
  }
  return `media/staging/v1/${year}/${month}/${day}/${hour.slice(0, 2)}/${attemptId.toLowerCase()}.json`;
}

export function mediaDerivativeKey(
  assetId: string,
  size: MediaDerivativeSize
): string {
  if (!(uuidPattern.test(assetId) && derivativeSizes.has(size))) {
    throw new Error("invalid_media_derivative");
  }
  return `media/derivatives/v1/${assetId.toLowerCase()}/${size}.webp`;
}

export function isMediaObjectKey(value: string): boolean {
  const segments = value.split("/");
  if (
    segments.length !== 7 ||
    segments[0] !== "media" ||
    segments[1] !== "v2" ||
    !segments[2] ||
    !uuidPattern.test(segments[3] ?? "") ||
    !uuidV4Pattern.test(segments[4] ?? "") ||
    !fingerprintPattern.test(segments[5] ?? "")
  ) {
    return false;
  }
  const attemptFile = segments[6] ?? "";
  return (
    attemptFile.toLowerCase().endsWith(".webp") &&
    uuidV4Pattern.test(attemptFile.slice(0, -5))
  );
}

export function parseUploadCommandId(value: string): string {
  if (!uuidV4Pattern.test(value)) {
    throw new InvalidMediaUploadCommandIdError();
  }
  return value.toLowerCase();
}
