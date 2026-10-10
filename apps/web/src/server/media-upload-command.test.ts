import { describe, expect, it } from "vitest";
import {
  mediaObjectKey,
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

  it("creates a private R2 key with escaped tenant scope and a validated command ID", () => {
    const commandId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const fingerprint = "a".repeat(64);
    const productId = "0199c2d0-0000-7000-8000-000000000001";

    expect(parseUploadCommandId(commandId)).toBe(commandId);
    expect(
      mediaObjectKey("org/example", productId, commandId, fingerprint)
    ).toBe(
      `media/org%2Fexample/${productId}/de305d54-75b4-431b-adb2-eb6b9e546014/${fingerprint}.webp`
    );
    expect(
      mediaObjectKey(
        "org/example",
        "0199c2d0-0000-7000-8000-000000000002",
        commandId,
        fingerprint
      )
    ).not.toBe(
      mediaObjectKey("org/example", productId, commandId, fingerprint)
    );
    expect(() => parseUploadCommandId("../escape")).toThrow();
    expect(() =>
      mediaObjectKey("org/example", productId, commandId, "bad-fingerprint")
    ).toThrow("invalid_media_upload_fingerprint");
  });
});
