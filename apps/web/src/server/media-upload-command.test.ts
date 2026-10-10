import { describe, expect, it } from "vitest";
import {
  isMediaObjectKey,
  mediaDerivativeKey,
  mediaObjectKey,
  mediaStagingMarkerKey,
  mediaUploadFingerprint,
  parseUploadCommandId,
} from "./media-upload-command";

const sha256Pattern = /^[0-9a-f]{64}$/;
const crop = { height: 0.75, width: 0.8, x: 0.1, y: 0.15 };
const command = {
  crop,
  organizationId: "org/example",
  productId: "0199c2d0-0000-7000-8000-000000000001",
  sourceBytes: new Uint8Array([1, 2, 3]),
  variantIds: [],
};

describe("media upload command", () => {
  it("creates a stable SHA-256 fingerprint from the target, crop, and bytes", async () => {
    const first = await mediaUploadFingerprint(command);
    const replay = await mediaUploadFingerprint({
      ...command,
      crop: { ...crop },
    });
    const differentFile = await mediaUploadFingerprint({
      ...command,
      sourceBytes: new Uint8Array([1, 2, 4]),
    });

    expect(first).toMatch(sha256Pattern);
    expect(replay).toBe(first);
    expect(differentFile).not.toBe(first);
  });

  it("creates unique private R2 keys for physical attempts", () => {
    const commandId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const attemptId = "de305d54-75b4-431b-adb2-eb6b9e546015";
    const anotherAttemptId = "de305d54-75b4-431b-adb2-eb6b9e546016";
    const fingerprint = "a".repeat(64);
    const productId = "0199c2d0-0000-7000-8000-000000000001";
    const storageKey = mediaObjectKey(
      "org/example",
      productId,
      commandId,
      fingerprint,
      attemptId
    );

    expect(parseUploadCommandId(commandId)).toBe(commandId);
    expect(storageKey).toBe(
      `media/v2/org%2Fexample/${productId}/${commandId}/${fingerprint}/${attemptId}.webp`
    );
    expect(
      mediaObjectKey(
        "org/example",
        productId,
        commandId,
        fingerprint,
        anotherAttemptId
      )
    ).not.toBe(storageKey);
    expect(isMediaObjectKey(storageKey)).toBe(true);
    expect(isMediaObjectKey("media/v2/not-a-valid-object.webp")).toBe(false);
    expect(() =>
      mediaObjectKey("org/example", productId, commandId, fingerprint, "bad")
    ).toThrow("invalid_media_attempt_id");
    expect(() => parseUploadCommandId("../escape")).toThrow();
    expect(() =>
      mediaObjectKey(
        "org/example",
        productId,
        commandId,
        "bad-fingerprint",
        attemptId
      )
    ).toThrow("invalid_media_upload_fingerprint");
  });

  it("uses ordered UTC staging prefixes and versioned derivative keys", () => {
    const attemptId = "de305d54-75b4-431b-adb2-eb6b9e546015";
    const assetId = "0199c2d0-0000-7000-8000-000000000002";

    expect(
      mediaStagingMarkerKey(attemptId, new Date("2026-10-10T15:42:00.000Z"))
    ).toBe(`media/staging/v1/2026/10/10/15/${attemptId}.json`);
    expect(mediaDerivativeKey(assetId, 320)).toBe(
      `media/derivatives/v1/${assetId}/320.webp`
    );
    expect(mediaDerivativeKey(assetId, 640)).toBe(
      `media/derivatives/v1/${assetId}/640.webp`
    );
    expect(() => mediaStagingMarkerKey(attemptId, new Date("invalid"))).toThrow(
      "invalid_media_staging_marker"
    );
  });
});
