import { describe, expect, it } from "vitest";
import {
  decodeSpreadsheet,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  parseCsv,
} from "./product-import-csv";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Windows-1252 bytes of a Latin text (each character below U+0100 is its own byte, the euro sign is 0x80). */
const windows1252 = (text: string) =>
  new Uint8Array(
    [...text].map((char) => (char === "€" ? 0x80 : char.charCodeAt(0)))
  );

function utf16le(text: string, mark = true): Uint8Array {
  const bytes: number[] = mark ? [0xff, 0xfe] : [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes.push(unit % 256, Math.floor(unit / 256));
  }
  return new Uint8Array(bytes);
}

describe("decoding the bytes of a spreadsheet", () => {
  const text = "Nome;Preço de tabela\r\nCamisa Ação;59,90\r\n";

  it.each([
    ["UTF-8 without a byte-order mark", utf8(text), "utf-8"],
    [
      "UTF-8 with a byte-order mark",
      new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]),
      "utf-8",
    ],
    ["Windows-1252 (Excel in Portuguese)", windows1252(text), "windows-1252"],
    ["UTF-16 with its mark", utf16le(text), "utf-16le"],
  ])("reads %s with the accents right", (_label, bytes, encoding) => {
    expect(decodeSpreadsheet(bytes)).toEqual({ encoding, kind: "ok", text });
  });

  it("reads the euro sign and the accents of Windows-1252", () => {
    expect(decodeSpreadsheet(windows1252("€ é ç ã õ"))).toMatchObject({
      text: "€ é ç ã õ",
    });
  });

  it("does not read a file over 1 MB", () => {
    expect(decodeSpreadsheet(new Uint8Array(IMPORT_MAX_BYTES + 1))).toEqual({
      kind: "too_large",
    });
    expect(decodeSpreadsheet(new Uint8Array(IMPORT_MAX_BYTES)).kind).toBe("ok");
  });
});

describe("cutting the text into records", () => {
  it("takes the separator of the header, ; or ,", () => {
    expect(parseCsv("Nome;Preço\nA;1,50\n")).toEqual({
      header: ["Nome", "Preço"],
      kind: "ok",
      records: [{ cells: ["A", "1,50"], rowNumber: 2 }],
      separator: ";",
    });
    expect(parseCsv("Nome,Preço\nA,1.50\n")).toMatchObject({
      records: [{ cells: ["A", "1.50"], rowNumber: 2 }],
      separator: ",",
    });
  });

  it("reads Windows, Unix and old Mac line ends, and a last line without one", () => {
    for (const end of ["\r\n", "\n", "\r"]) {
      expect(parseCsv(`Nome;Qtd${end}A;1${end}B;2`)).toMatchObject({
        records: [
          { cells: ["A", "1"], rowNumber: 2 },
          { cells: ["B", "2"], rowNumber: 3 },
        ],
      });
    }
  });

  it("keeps a separator, a line break and a doubled quote inside quotes", () => {
    const parsed = parseCsv(
      'Nome;Descrição\r\n"Camisa; azul";"linha 1\r\nlinha 2"\r\n"Bota ""top""";x\r\n'
    );
    expect(parsed).toMatchObject({
      records: [
        { cells: ["Camisa; azul", "linha 1\r\nlinha 2"], rowNumber: 2 },
        { cells: ['Bota "top"', "x"], rowNumber: 3 },
      ],
    });
  });

  it("numbers the records as rows of the spreadsheet, blank ones skipped but counted", () => {
    expect(parseCsv("\nNome;Qtd\n;\nA;1\n\nB;2\n")).toMatchObject({
      records: [
        { cells: ["A", "1"], rowNumber: 4 },
        { cells: ["B", "2"], rowNumber: 6 },
      ],
    });
  });

  it("reads a header of one column as one cell per line, commas and all", () => {
    expect(parseCsv("Nome\nCamisa, azul\nBota; preta\n")).toEqual({
      header: ["Nome"],
      kind: "ok",
      records: [
        { cells: ["Camisa, azul"], rowNumber: 2 },
        { cells: ["Bota; preta"], rowNumber: 3 },
      ],
      separator: null,
    });
  });

  it("ignores the separator a header has inside quotes", () => {
    expect(parseCsv('"Nome;x",Preço\nA,1\n')).toMatchObject({
      header: ["Nome;x", "Preço"],
      separator: ",",
    });
  });

  it(`reads ${IMPORT_MAX_ROWS} rows and stops at the next one, without reading the rest`, () => {
    const rows = (count: number) =>
      `Nome\n${Array.from({ length: count }, (_, i) => `P${i}`).join("\n")}\n`;
    const full = parseCsv(rows(IMPORT_MAX_ROWS));
    expect(full.kind === "ok" && full.records.length).toBe(IMPORT_MAX_ROWS);
    // the rest of the file would be an unclosed quote: the reading stopped before it
    expect(parseCsv(`${rows(IMPORT_MAX_ROWS + 1)}"open`)).toEqual({
      kind: "too_many_rows",
    });
  });

  it("stops at a record with more cells than any spreadsheet of products has", () => {
    expect(parseCsv(`Nome;Qtd\n${";".repeat(10_000)}\n`)).toEqual({
      kind: "too_many_columns",
      rowNumber: 2,
    });
    expect(
      parseCsv(`Nome;Qtd\n${";".repeat(IMPORT_MAX_COLUMNS - 1)}x\n`).kind
    ).toBe("ok");
  });

  // never cut: a cut cell could lose the text after leading spaces; the 1 MB of the file bounds the memory
  it("keeps a long cell whole, so it is refused by its length and not cut", () => {
    const parsed = parseCsv(`Nome;Descrição\nA;"${"d".repeat(900_000)}"\n`);
    expect(parsed.kind === "ok" && parsed.records[0]?.cells[1]?.length).toBe(
      900_000
    );
  });

  it("says where a quote opens and never closes, and when there is nothing", () => {
    expect(parseCsv('Nome\nA\n"B\n')).toEqual({
      kind: "unclosed_quote",
      rowNumber: 3,
    });
    expect(parseCsv("")).toEqual({ kind: "empty" });
    expect(parseCsv("\r\n;;\r\n")).toEqual({ kind: "empty" });
  });
});
