const encoder = new TextEncoder();

/** Printable ASCII with no character `JSON.stringify` escapes: one byte each, plus the two quotes. */
const PLAIN_TEXT = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

function textBytes(text: string): number {
  return PLAIN_TEXT.test(text)
    ? text.length + 2
    : encoder.encode(JSON.stringify(text)).byteLength;
}

/**
 * The size in UTF-8 bytes of `JSON.stringify(value)`, without building that
 * text: a log of the size of an answer must not serialize the answer a second
 * time (a cost of CPU that grows with the answer). Exact for what an answer is
 * made of (objects, arrays, text, finite numbers, booleans and null); a key
 * whose value is `undefined` is left out, as `JSON.stringify` leaves it.
 */
export function jsonByteLength(value: unknown): number {
  if (value === null) {
    return 4;
  }
  switch (typeof value) {
    case "string":
      return textBytes(value);
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "object":
      return Array.isArray(value)
        ? arrayBytes(value)
        : objectBytes(value as Record<string, unknown>);
    default:
      // undefined, a function or a symbol: JSON.stringify writes nothing
      return 0;
  }
}

function arrayBytes(items: readonly unknown[]): number {
  let bytes = 2 + Math.max(items.length - 1, 0);
  for (const item of items) {
    bytes += item === undefined ? 4 : jsonByteLength(item);
  }
  return bytes;
}

function objectBytes(record: Record<string, unknown>): number {
  if (typeof (record as { toJSON?: unknown }).toJSON === "function") {
    return encoder.encode(JSON.stringify(record)).byteLength;
  }
  let bytes = 2;
  let entries = 0;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === undefined || typeof entry === "function") {
      continue;
    }
    bytes += textBytes(key) + 1 + jsonByteLength(entry);
    entries += 1;
  }
  return bytes + Math.max(entries - 1, 0);
}
