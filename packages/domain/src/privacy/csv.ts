/**
 * CSV for the data export (plan PR104, ADR 0078): RFC 4180 quoting, UTF-8 with a byte-order mark
 * (spreadsheets read accented text correctly with it), and no spreadsheet formula injection: a
 * cell that starts with a character a spreadsheet takes as a formula (=, +, -, @, tab, carriage
 * return) is written with a leading apostrophe, so opening an export never runs something a
 * customer typed into a name or a note. The JSON export keeps every value exactly as it is.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain number as text (the database hands money and quantities over as strings): a negative amount stays as it is. */
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;
const BYTE_ORDER_MARK = "\uFEFF";

/** A value as a CSV cell. Money and quantities arrive as strings from the database and stay as they are. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  // only text can start a formula: a number or a date never does, and a negative number keeps its sign
  const isText = typeof value === "string" || typeof value === "object";
  if (isText && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}

/** A whole CSV file from lines already written with `csvRow`, so a large table never sits in memory twice. */
export function csvFile(
  columns: readonly string[],
  lines: readonly string[]
): string {
  return `${BYTE_ORDER_MARK}${[csvRow(columns), ...lines].join("\r\n")}\r\n`;
}

/** A whole CSV file: the byte-order mark, the header, then one line per row, each ending in CRLF. */
export function toCsv(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[]
): string {
  return csvFile(columns, rows.map(csvRow));
}
