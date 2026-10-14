/**
 * A UUIDv7 made in the browser (RFC 9562): 48 bits of Unix milliseconds, the
 * version and variant bits, and random bits for the rest. An offline device
 * uses it to name what it creates before the server has seen it; being
 * time-ordered it sorts like the IDs the database generates.
 */
export function uuidv7(
  now: number = Date.now(),
  randomBytes: () => Uint8Array = () =>
    crypto.getRandomValues(new Uint8Array(16))
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError("invalid_uuidv7_timestamp");
  }
  const bytes = randomBytes();
  // 48-bit big-endian millisecond timestamp
  let remaining = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  // version 7 in the high nibble of byte 6, variant 10 in the top bits of byte 8
  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
