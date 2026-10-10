import {
  InvalidMediaCropError,
  MediaImageProcessingError,
  MediaImageTooLargeError,
  UnsupportedMediaImageError,
} from "@polaris/domain/catalog/media";
import { describe, expect, it, vi } from "vitest";
import { processMediaImage } from "./media-image-pipeline";

function imageBinding(
  options: {
    decoded?: { format: string; height: number; width: number };
    output?: {
      bytes: Uint8Array;
      format: string;
      height: number;
      width: number;
    };
  } = {}
) {
  const decoded = options.decoded ?? {
    format: "image/jpeg",
    height: 800,
    width: 1200,
  };
  const output = options.output ?? {
    bytes: new Uint8Array([82, 73, 70, 70]),
    format: "image/webp",
    height: 200,
    width: 600,
  };
  const transforms: unknown[] = [];
  let infoCalls = 0;
  const transformer = {
    output: vi.fn((outputOptions: unknown) => {
      transforms.push(outputOptions);
      return Promise.resolve({
        response: () =>
          new Response(output.bytes.slice().buffer as ArrayBuffer, {
            headers: { "Content-Type": output.format },
          }),
      });
    }),
    transform: vi.fn((transform: unknown) => {
      transforms.push(transform);
      return transformer;
    }),
  };

  return {
    binding: {
      info: vi.fn(() => {
        infoCalls += 1;
        return Promise.resolve(infoCalls === 1 ? decoded : output);
      }),
      input: vi.fn(() => transformer),
    },
    transforms,
  };
}

describe("processMediaImage", () => {
  it("crops the selected source rectangle, scales down to 1200, and emits WebP", async () => {
    const { binding, transforms } = imageBinding();

    const result = await processMediaImage({
      crop: { height: 0.25, width: 0.5, x: 0.1, y: 0.25 },
      declaredContentType: "image/jpeg",
      images: binding,
      sourceBytes: new Uint8Array([1, 2, 3]),
    });

    expect(transforms).toEqual([
      { trim: { height: 200, left: 120, top: 200, width: 600 } },
      { fit: "scale-down", height: 1200, width: 1200 },
      { format: "image/webp", quality: 85 },
    ]);
    expect(result).toEqual({
      byteLength: 4,
      bytes: new Uint8Array([82, 73, 70, 70]),
      contentType: "image/webp",
      height: 200,
      width: 600,
    });
    expect(binding.info).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized input before asking Cloudflare to decode it", async () => {
    const { binding } = imageBinding();

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: binding,
        sourceBytes: new Uint8Array(20_000_001),
      })
    ).rejects.toBeInstanceOf(MediaImageTooLargeError);
    expect(binding.info).not.toHaveBeenCalled();
  });

  it("maps the provider's invalid-image response to an unsupported image error", async () => {
    const { binding } = imageBinding();
    binding.info.mockRejectedValueOnce(
      Object.assign(new Error("invalid image bytes"), { code: 9412 })
    );

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(UnsupportedMediaImageError);
  });

  it("does not expose transient provider errors as invalid user files", async () => {
    const { binding } = imageBinding();
    binding.info.mockRejectedValueOnce(new Error("provider offline"));

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(MediaImageProcessingError);
  });

  it("rejects unsupported decoded formats even when the upload header claims JPEG", async () => {
    const { binding } = imageBinding({
      decoded: {
        format: "image/svg+xml",
        height: 800,
        width: 1200,
      },
    });

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(UnsupportedMediaImageError);
    expect(binding.input).not.toHaveBeenCalled();
  });

  it("rejects an invalid crop before starting an image transform", async () => {
    const { binding } = imageBinding();

    await expect(
      processMediaImage({
        crop: { height: 0.5, width: 0.5, x: 0.8, y: 0.8 },
        declaredContentType: "image/jpeg",
        images: binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(InvalidMediaCropError);
    expect(binding.input).not.toHaveBeenCalled();
  });

  it("fails closed if the provider returns a non-WebP or oversized output", async () => {
    const nonWebp = imageBinding({
      output: {
        bytes: new Uint8Array([1]),
        format: "image/jpeg",
        height: 200,
        width: 600,
      },
    });

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: nonWebp.binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(UnsupportedMediaImageError);

    const tooLarge = imageBinding({
      output: {
        bytes: new Uint8Array([1]),
        format: "image/webp",
        height: 1201,
        width: 1200,
      },
    });

    await expect(
      processMediaImage({
        crop: { height: 1, width: 1, x: 0, y: 0 },
        declaredContentType: "image/jpeg",
        images: tooLarge.binding,
        sourceBytes: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toBeInstanceOf(UnsupportedMediaImageError);
  });
});
