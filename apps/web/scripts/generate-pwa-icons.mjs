// Draws the app icons (a four-pointed star, "polaris", on the brand green) into
// public/icons as PNG files, without any image dependency. The output is
// committed; run this only to change the artwork:
//   node scripts/generate-pwa-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const GREEN = [0x17, 0x65, 0x4d];
const WHITE = [0xff, 0xfe, 0xfa];

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** The star: |x|^p + |y|^p <= r^p with p < 1 gives four concave points. */
function insideStar(x, y, radius) {
  const p = 0.55;
  return Math.abs(x) ** p + Math.abs(y) ** p <= radius ** p;
}

function png(size, { maskable }) {
  const rows = [];
  // Maskable icons keep the artwork inside the central 80% safe zone.
  const radius = size * (maskable ? 0.3 : 0.38);
  const samples = 3;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples - size / 2;
          const py = y + (sy + 0.5) / samples - size / 2;
          covered += insideStar(px, py, radius) ? 1 : 0;
        }
      }
      const share = covered / (samples * samples);
      for (let channel = 0; channel < 3; channel += 1) {
        row[1 + x * 3 + channel] = Math.round(
          GREEN[channel] * (1 - share) + WHITE[channel] * share
        );
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = new URL("../public/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
]) {
  writeFileSync(new URL(name, outDir), png(size, { maskable }));
}
