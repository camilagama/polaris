// biome-ignore-all lint/suspicious/noBitwiseOperators: UTF-8 encoding, CRC-32 and the ZIP header fields are bit-level formats.
/**
 * A ZIP writer for the data export (plan PR104, ADR 0078): entries are STORED (not
 * compressed), UTF-8 names, one pass, no ZIP64. An export part is kept under a size the
 * Worker can hold in memory, so none of these limits is reached (a part has far fewer
 * than 65,535 entries and is far smaller than 4 GiB); the builder refuses to go past
 * them rather than write an archive other tools could not open.
 */

/** UTF-8 bytes of a name (the domain has no TextEncoder: it needs no platform). */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x8_00) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x1_00_00) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

const MAX_ENTRIES = 65_000;
const MAX_ENTRY_BYTES = 0xff_ff_ff_ff - 1;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_DIRECTORY_BYTES = 22;
/** 1980-01-01 00:00:00, the earliest DOS date: entries carry no time, so an archive is the same bytes every time. */
const DOS_TIME = 0;
const DOS_DATE = 33; // year 1980, month 1, day 1
const UTF8_FLAG = 0x08_00;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  // biome-ignore lint/style/useForOf: `for...of` over a typed array took ~0.9 s for 32 MiB, the indexed loop ~0.09 s (ADR 0078).
  for (let index = 0; index < data.length; index += 1) {
    crc =
      (crcTable[(crc ^ (data[index] as number)) & 0xff] as number) ^
      (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

export class ZipLimitError extends Error {
  readonly code = "zip_limit";

  constructor() {
    super("zip_limit");
    this.name = "ZipLimitError";
  }
}

interface Entry {
  crc: number;
  data: Uint8Array;
  name: Uint8Array;
  offset: number;
}

/** What an entry adds to the archive besides its data (its two headers and its name, twice). */
export function zipEntryOverhead(name: string): number {
  return LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * utf8(name).length;
}

export class ZipBuilder {
  private readonly entries: Entry[] = [];
  private bytes = 0;
  private directory = 0;
  private readonly names = new Set<string>();

  /** The size the archive would have if it were finished now. */
  get size(): number {
    return this.bytes + this.directory + END_OF_DIRECTORY_BYTES;
  }

  get count(): number {
    return this.entries.length;
  }

  add(name: string, data: Uint8Array): void {
    if (
      name === "" ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error("zip_entry_name_invalid");
    }
    if (this.names.has(name)) {
      throw new Error("zip_entry_name_repeated");
    }
    if (this.entries.length >= MAX_ENTRIES || data.length > MAX_ENTRY_BYTES) {
      throw new ZipLimitError();
    }
    const encoded = utf8(name);
    this.entries.push({
      crc: crc32(data),
      data,
      name: encoded,
      offset: this.bytes,
    });
    this.names.add(name);
    this.bytes += LOCAL_HEADER_BYTES + encoded.length + data.length;
    this.directory += CENTRAL_HEADER_BYTES + encoded.length;
    if (this.size > MAX_ENTRY_BYTES) {
      throw new ZipLimitError();
    }
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.size);
    const view = new DataView(out.buffer);
    let at = 0;
    for (const entry of this.entries) {
      view.setUint32(at, 0x04_03_4b_50, true);
      view.setUint16(at + 4, 20, true);
      view.setUint16(at + 6, UTF8_FLAG, true);
      view.setUint16(at + 8, 0, true);
      view.setUint16(at + 10, DOS_TIME, true);
      view.setUint16(at + 12, DOS_DATE, true);
      view.setUint32(at + 14, entry.crc, true);
      view.setUint32(at + 18, entry.data.length, true);
      view.setUint32(at + 22, entry.data.length, true);
      view.setUint16(at + 26, entry.name.length, true);
      view.setUint16(at + 28, 0, true);
      out.set(entry.name, at + LOCAL_HEADER_BYTES);
      out.set(entry.data, at + LOCAL_HEADER_BYTES + entry.name.length);
      at += LOCAL_HEADER_BYTES + entry.name.length + entry.data.length;
    }
    const directoryStart = at;
    for (const entry of this.entries) {
      view.setUint32(at, 0x02_01_4b_50, true);
      view.setUint16(at + 4, 20, true);
      view.setUint16(at + 6, 20, true);
      view.setUint16(at + 8, UTF8_FLAG, true);
      view.setUint16(at + 10, 0, true);
      view.setUint16(at + 12, DOS_TIME, true);
      view.setUint16(at + 14, DOS_DATE, true);
      view.setUint32(at + 16, entry.crc, true);
      view.setUint32(at + 20, entry.data.length, true);
      view.setUint32(at + 24, entry.data.length, true);
      view.setUint16(at + 28, entry.name.length, true);
      view.setUint16(at + 30, 0, true);
      view.setUint16(at + 32, 0, true);
      view.setUint16(at + 34, 0, true);
      view.setUint16(at + 36, 0, true);
      view.setUint32(at + 38, 0, true);
      view.setUint32(at + 42, entry.offset, true);
      out.set(entry.name, at + CENTRAL_HEADER_BYTES);
      at += CENTRAL_HEADER_BYTES + entry.name.length;
    }
    view.setUint32(at, 0x06_05_4b_50, true);
    view.setUint16(at + 4, 0, true);
    view.setUint16(at + 6, 0, true);
    view.setUint16(at + 8, this.entries.length, true);
    view.setUint16(at + 10, this.entries.length, true);
    view.setUint32(at + 12, at - directoryStart, true);
    view.setUint32(at + 16, directoryStart, true);
    view.setUint16(at + 20, 0, true);
    return out;
  }
}
