import { crc32, deflateSync } from "node:zlib";

/**
 * What the browser checks of the images panel need: an image that is drawn at a size the screen can be measured
 * with (a 1 × 1 one is a dot in the crop area), and the list the server would answer. Synthetic data only.
 */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/** A PNG of one color, `width` × `height`, 8-bit RGB. */
export function solidPng(width: number, height: number, rgb = [90, 120, 200]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const assetId = (n: number) => `0199c2d0-0000-7000-8000-0000000000${50 + n}`;

/** The asset of the list, as the server reads it. */
export const mediaAsset = (n: number, variantIds: string[] = []) => ({
  assetId: assetId(n),
  byteSize: 280_000 + n * 40_000,
  contentType: "image/webp",
  createdAt: "2026-10-14T12:00:00.000Z",
  height: 800,
  position: n,
  variantIds,
  width: 1000,
});

/** The body of `GET /api/products/:id/media`. */
export const mediaListBody = (count: number) =>
  JSON.stringify({
    media: Array.from({ length: count }, (_, n) => mediaAsset(n)),
    requestId: "0199c2d0-0000-7000-8000-0000000000aa",
  });
