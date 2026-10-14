import { describe, expect, it } from "vitest";
import {
  cropRectToPixels,
  InvalidMediaCropError,
  MediaImageTooLargeError,
  MediaUploadCommandConflictError,
  UnsupportedMediaImageError,
  validateMediaImageSource,
  validateNormalizedMediaCropRect,
} from "./media";

describe("media upload input", () => {
  it("exposes a stable conflict for reusing an upload command with a new payload", () => {
    expect(new MediaUploadCommandConflictError().code).toBe(
      "media_upload_command_conflict"
    );
  });

  it("maps a normalized crop rectangle to outward-rounded source pixels", () => {
    expect(
      cropRectToPixels(
        { height: 0.25, width: 0.5, x: 0.1, y: 0.25 },
        { height: 800, width: 1200 }
      )
    ).toEqual({ height: 200, left: 120, top: 200, width: 600 });
  });

  it("keeps a crop that reaches the right and bottom edges inside the source", () => {
    expect(
      cropRectToPixels(
        { height: 0.2, width: 0.1, x: 0.9, y: 0.8 },
        { height: 1001, width: 1001 }
      )
    ).toEqual({ height: 201, left: 900, top: 800, width: 101 });
  });

  it.each([
    { height: 0.5, width: 0.5, x: -0.01, y: 0 },
    { height: 0.5, width: 0.5, x: 0, y: 0.6 },
    { height: 0.5, width: 0, x: 0, y: 0 },
    { height: Number.NaN, width: 1, x: 0, y: 0 },
  ])("rejects invalid crop coordinates: %o", (crop) => {
    expect(() => cropRectToPixels(crop, { height: 100, width: 100 })).toThrow(
      InvalidMediaCropError
    );
  });

  it("validates an untrusted crop object without needing image dimensions", () => {
    expect(
      validateNormalizedMediaCropRect({ height: 0.5, width: 0.5, x: 0, y: 0 })
    ).toEqual({ height: 0.5, width: 0.5, x: 0, y: 0 });
    expect(() => validateNormalizedMediaCropRect([0, 0, 1, 1])).toThrow(
      InvalidMediaCropError
    );
    expect(() =>
      validateNormalizedMediaCropRect({ height: 1.1, width: 1, x: 0, y: 0 })
    ).toThrow(InvalidMediaCropError);
  });

  it("accepts supported raster MIME types at the provider input limit", () => {
    for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
      expect(() =>
        validateMediaImageSource({ byteLength: 20_000_000, contentType })
      ).not.toThrow();
    }
  });

  it("rejects formats that the server pipeline does not accept", () => {
    for (const contentType of ["image/heic", "image/svg+xml", "image/gif"]) {
      expect(() =>
        validateMediaImageSource({ byteLength: 1024, contentType })
      ).toThrow(UnsupportedMediaImageError);
    }
  });

  it("rejects images larger than 20 MB before image processing", () => {
    expect(() =>
      validateMediaImageSource({
        byteLength: 20_000_001,
        contentType: "image/jpeg",
      })
    ).toThrow(MediaImageTooLargeError);
  });
});
