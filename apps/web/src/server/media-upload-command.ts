import type { NormalizedMediaCropRect } from "@polaris/domain/catalog/media";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{64}$/;

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
  inputFingerprint: string
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
  return `media/${encodeURIComponent(organizationId)}/${productId}/${validCommandId}/${inputFingerprint}.webp`;
}

export function parseUploadCommandId(value: string): string {
  if (!uuidV4Pattern.test(value)) {
    throw new InvalidMediaUploadCommandIdError();
  }
  return value.toLowerCase();
}
