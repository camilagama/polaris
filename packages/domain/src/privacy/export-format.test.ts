// biome-ignore-all lint/suspicious/noBitwiseOperators: the reference CRC-32 is a bit-level algorithm.
/// <reference types="node" />
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { csvCell, csvFile, csvRow, toCsv } from "./csv";
import { crc32, ZipBuilder, ZipLimitError, zipEntryOverhead } from "./zip";

/** A small reader of what the builder writes, independent of it: the central directory, then each entry. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06_05_4b_50);
  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const entries: { crc: number; data: Uint8Array; name: string }[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02_01_4b_50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.slice(at + 46, at + 46 + nameLength)
    );
    expect(view.getUint32(localOffset, true)).toBe(0x04_03_4b_50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLength;
    entries.push({ crc, data: bytes.slice(dataStart, dataStart + size), name });
    at += 46 + nameLength;
  }
  return entries;
}

const LEADING_QUOTE = /^"/;

describe("the zip writer", () => {
  it("writes entries that read back exactly, with their names, sizes and checksums", () => {
    const zip = new ZipBuilder();
    const text = new TextEncoder().encode('{"nome":"José"}');
    const binary = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    zip.add("data/clientes.json", text);
    zip.add("images/a.bin", binary);
    zip.add("vazio.txt", new Uint8Array());
    const entries = readZip(zip.finish());
    expect(entries.map((entry) => entry.name)).toEqual([
      "data/clientes.json",
      "images/a.bin",
      "vazio.txt",
    ]);
    expect(entries[0]?.data).toEqual(text);
    expect(entries[1]?.data).toEqual(binary);
    expect(entries[2]?.data.length).toBe(0);
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(entry.data));
    }
  });

  it("writes names with accents and symbols as UTF-8, as a platform encoder would", () => {
    const zip = new ZipBuilder();
    const names = ["dados/ação-ñ.json", "dados/€-日本.csv", "dados/😀.txt"];
    for (const name of names) {
      zip.add(name, new Uint8Array());
    }
    expect(readZip(zip.finish()).map((entry) => entry.name)).toEqual(names);
  });

  it("checks against the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcb_f4_39_26);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("matches a bit-by-bit CRC-32 on a long buffer of odd length", () => {
    const data = new Uint8Array(100_003);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (index * 31 + 7) & 0xff;
    }
    let reference = 0xff_ff_ff_ff;
    for (const byte of data) {
      reference ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        reference =
          reference & 1 ? 0xed_b8_83_20 ^ (reference >>> 1) : reference >>> 1;
      }
    }
    expect(crc32(data)).toBe((reference ^ 0xff_ff_ff_ff) >>> 0);
  });

  it("reports the size it will have, so a part can be closed before it is too big", () => {
    const zip = new ZipBuilder();
    expect(zip.size).toBe(22);
    const data = new Uint8Array(500);
    zip.add("a.bin", data);
    expect(zip.size).toBe(22 + 500 + zipEntryOverhead("a.bin"));
    expect(zip.finish().length).toBe(zip.size);
    expect(zip.count).toBe(1);
  });

  it("writes the same bytes every time (no clock in it)", () => {
    const build = () => {
      const zip = new ZipBuilder();
      zip.add("a.txt", new TextEncoder().encode("a"));
      return zip.finish();
    };
    expect(build()).toEqual(build());
  });

  it("is a valid archive other tools read: the entries are stored, not compressed", () => {
    const zip = new ZipBuilder();
    zip.add("a.txt", new TextEncoder().encode("hello"));
    const bytes = zip.finish();
    // method 0 in the local header, and the data is there verbatim
    expect(new DataView(bytes.buffer).getUint16(8, true)).toBe(0);
    expect(new TextDecoder().decode(bytes.slice(30 + 5, 30 + 5 + 5))).toBe(
      "hello"
    );
    // raw deflate is not needed to read it: inflating a stored block would be a different format
    expect(() => inflateRawSync(Buffer.from("hello"))).toThrow();
  });

  it("refuses a name that could escape the folder it is unpacked in, and a name used twice", () => {
    const zip = new ZipBuilder();
    for (const name of [
      "",
      "/etc/passwd",
      "../x",
      "a/../x",
      "a\\b",
      "a//b",
      "dir/",
    ]) {
      expect(() => zip.add(name, new Uint8Array())).toThrow(
        "zip_entry_name_invalid"
      );
    }
    zip.add("a.txt", new Uint8Array());
    expect(() => zip.add("a.txt", new Uint8Array())).toThrow(
      "zip_entry_name_repeated"
    );
  });

  it("refuses to go past what a plain zip can hold", () => {
    const zip = new ZipBuilder();
    for (let index = 0; index < 65_000; index += 1) {
      zip.add(`f${index}`, new Uint8Array());
    }
    expect(() => zip.add("one-more", new Uint8Array())).toThrow(ZipLimitError);
  });
});

describe("csv", () => {
  it("quotes what needs it and doubles the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("linha1\nlinha2")).toBe('"linha1\nlinha2"');
    expect(csvCell("simples")).toBe("simples");
  });

  it("writes nothing for a missing value, ISO for a date and the text of a number, a boolean or an amount", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-10-17T12:00:00.000Z"))).toBe(
      "2026-10-17T12:00:00.000Z"
    );
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("does not let a cell run as a spreadsheet formula", () => {
    for (const cell of [
      "=1+1",
      "+cmd|' /C calc'!A0",
      "-2+3",
      "@SUM(A1)",
      "\tcmd",
      "\rcmd",
    ]) {
      expect(csvCell(cell).replace(LEADING_QUOTE, "").startsWith("'")).toBe(
        true
      );
    }
    // but a plain number written as text keeps its sign
    expect(csvCell("+5")).toBe("+5");
    expect(csvCell("-5")).toBe("-5");
  });

  it("builds a file with the byte-order mark, a header and CRLF lines", () => {
    expect(toCsv(["id", "nome"], [["1", "Ana, a"]])).toBe(
      '﻿id,nome\r\n1,"Ana, a"\r\n'
    );
    expect(csvRow([1, null, "x"])).toBe("1,,x");
    expect(toCsv(["id"], [])).toBe("﻿id\r\n");
  });

  it("builds the same file from lines already written", () => {
    const rows = [
      ["1", "Ana, a"],
      ["2", "=cmd"],
    ];
    expect(csvFile(["id", "nome"], rows.map(csvRow))).toBe(
      toCsv(["id", "nome"], rows)
    );
  });
});
