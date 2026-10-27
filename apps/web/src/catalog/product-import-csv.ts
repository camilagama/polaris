/**
 * Reading a spreadsheet saved as CSV in the browser (corte 2.5): the file never leaves the device. The bytes are
 * decoded by the browser's own `TextDecoder` (UTF-8 with or without the byte-order mark, UTF-16 with its mark, and
 * Windows-1252, the encoding of an Excel in Portuguese, when the bytes are not UTF-8), and the text is cut into
 * records by RFC 4180 (cells between quotes may hold the separator, a quote written twice and line breaks). The
 * separator is the one of the header, `;` or `,`.
 *
 * The limits are of use, not of security (the server has its own): the reading stops past `IMPORT_MAX_ROWS` rows,
 * a file over `IMPORT_MAX_BYTES` is not read at all, and a record with more than `IMPORT_MAX_COLUMNS` cells (a file
 * of `;;;;`) stops it too, so the device never holds a file it would not import.
 */

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_COLUMNS = 50;
/**
 * The longest cell kept as it came: the longest field of `product.create` (the description, 5000) and one more, so
 * a longer cell is still refused by its length and never cut in silence.
 */
const MAX_KEPT_CELL = 5001;

type SpreadsheetEncoding =
  | "utf-16be"
  | "utf-16le"
  | "utf-8"
  | "windows-1252";

export type DecodedSpreadsheet =
  | { encoding: SpreadsheetEncoding; kind: "ok"; text: string }
  | { kind: "too_large" };

function startsWith(bytes: Uint8Array, mark: readonly number[]): boolean {
  return mark.every((byte, index) => bytes[index] === byte);
}

/** The text of the file's bytes; the byte-order mark is dropped. */
export function decodeSpreadsheet(bytes: Uint8Array): DecodedSpreadsheet {
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    return { kind: "too_large" };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      encoding: "utf-16le",
      kind: "ok",
      text: new TextDecoder("utf-16le").decode(bytes),
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      encoding: "utf-16be",
      kind: "ok",
      text: new TextDecoder("utf-16be").decode(bytes),
    };
  }
  try {
    return {
      encoding: "utf-8",
      kind: "ok",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    // bytes that are not UTF-8 are the encoding of an Excel in Portuguese
    return {
      encoding: "windows-1252",
      kind: "ok",
      text: new TextDecoder("windows-1252").decode(bytes),
    };
  }
}

type CsvSeparator = "," | ";";

interface CsvRecord {
  cells: string[];
  /** The row of the spreadsheet, as the person sees it: the header is row 1. */
  rowNumber: number;
}

export type ParsedCsv =
  | {
      header: string[];
      kind: "ok";
      records: CsvRecord[];
      /** `null` when the header has one column only: each line is one cell. */
      separator: CsvSeparator | null;
    }
  | { kind: "empty" }
  | { kind: "too_many_columns"; rowNumber: number }
  | { kind: "too_many_rows" }
  | { kind: "unclosed_quote"; rowNumber: number };

const QUOTE = '"';

const LINE_BREAK = /\r\n|\n|\r/;

/**
 * The separator of the header (its first line that is not blank): the one it uses more, outside quotes; none when
 * it has one column.
 */
function headerSeparator(text: string): CsvSeparator | null {
  const line = text.split(LINE_BREAK).find((part) => part.trim() !== "") ?? "";
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (const char of line) {
    if (char === QUOTE) {
      quoted = !quoted;
    } else if (!quoted && char === ";") {
      semicolons += 1;
    } else if (!quoted && char === ",") {
      commas += 1;
    }
  }
  if (semicolons === 0 && commas === 0) {
    return null;
  }
  return semicolons >= commas ? ";" : ",";
}

const isBlank = (cells: readonly string[]) =>
  cells.every((cell) => cell.trim() === "");

type Step = { kind: "continue" } | Exclude<ParsedCsv, { kind: "empty" | "ok" }>;

const CONTINUE: Step = { kind: "continue" };

/** The state of one reading: the cell and the record being read, the header and the records read so far. */
class CsvReader {
  cell = "";
  cells: string[] = [];
  header: string[] | null = null;
  /** The cell was opened by a quote: a separator or a line break inside it is text. */
  inQuotes: boolean;
  /** The cell started with a quote (a quote after its closing one is kept as text). */
  quotedCell: boolean;
  readonly records: CsvRecord[] = [];
  rowNumber = 1;

  constructor() {
    this.inQuotes = false;
    this.quotedCell = false;
  }

  append(char: string): void {
    if (this.cell.length < MAX_KEPT_CELL) {
      this.cell += char;
    }
  }

  endCell(): Step {
    this.cells.push(this.cell);
    this.cell = "";
    this.quotedCell = false;
    return this.cells.length > IMPORT_MAX_COLUMNS
      ? { kind: "too_many_columns", rowNumber: this.rowNumber }
      : CONTINUE;
  }

  endRecord(): Step {
    const ended = this.endCell();
    if (ended.kind !== "continue") {
      return ended;
    }
    const { cells, rowNumber } = this;
    this.cells = [];
    this.rowNumber += 1;
    if (isBlank(cells)) {
      return CONTINUE;
    }
    if (this.header === null) {
      this.header = cells;
      return CONTINUE;
    }
    if (this.records.length >= IMPORT_MAX_ROWS) {
      // past the last row the import takes: the reading stops here, the rest of the file is not read
      return { kind: "too_many_rows" };
    }
    this.records.push({ cells, rowNumber });
    return CONTINUE;
  }

  /** Whether something was read after the last line break. */
  get pending(): boolean {
    return this.cell !== "" || this.cells.length > 0 || this.quotedCell;
  }
}

/** Reads the character at `index`; returns how many characters it took and whether the reading goes on. */
function readAt(
  reader: CsvReader,
  text: string,
  index: number,
  separator: CsvSeparator | null
): { step: Step; taken: number } {
  const char = text.charAt(index);
  const next = text.charAt(index + 1);
  if (reader.inQuotes) {
    if (char === QUOTE && next === QUOTE) {
      reader.append(QUOTE);
      return { step: CONTINUE, taken: 2 };
    }
    if (char === QUOTE) {
      reader.inQuotes = false;
    } else {
      reader.append(char);
    }
    return { step: CONTINUE, taken: 1 };
  }
  if (char === QUOTE && reader.cell === "" && !reader.quotedCell) {
    reader.inQuotes = true;
    reader.quotedCell = true;
    return { step: CONTINUE, taken: 1 };
  }
  if (separator !== null && char === separator) {
    return { step: reader.endCell(), taken: 1 };
  }
  if (char === "\r" || char === "\n") {
    return {
      step: reader.endRecord(),
      taken: char === "\r" && next === "\n" ? 2 : 1,
    };
  }
  reader.append(char);
  return { step: CONTINUE, taken: 1 };
}

/**
 * Cuts the text into records. Blank records are skipped (they still count in the numbering, as rows of the
 * spreadsheet); the first record that is not blank is the header.
 */
export function parseCsv(text: string): ParsedCsv {
  const separator = headerSeparator(text);
  const reader = new CsvReader();
  let index = 0;
  while (index < text.length) {
    const { step, taken } = readAt(reader, text, index, separator);
    if (step.kind !== "continue") {
      return step;
    }
    index += taken;
  }
  if (reader.inQuotes) {
    return { kind: "unclosed_quote", rowNumber: reader.rowNumber };
  }
  if (reader.pending) {
    const step = reader.endRecord();
    if (step.kind !== "continue") {
      return step;
    }
  }
  if (reader.header === null) {
    return { kind: "empty" };
  }
  return {
    header: reader.header,
    kind: "ok",
    records: reader.records,
    separator,
  };
}
