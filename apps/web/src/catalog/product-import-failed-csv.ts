import type {
  ProductImportRowResult,
  ProductImportRowStatus,
} from "@polaris/contracts";
import { csvFile, csvRow } from "@polaris/domain/privacy/csv";
import {
  DESCRIPTION_TOO_LONG,
  IMPORT_COLUMN_LABELS,
  IMPORT_COLUMNS,
  type ImportColumn,
  type ImportDuplicateRow,
  type ImportRefusedRow,
  type ImportSourceCells,
  NAME_TOO_LONG,
} from "./product-import-rows";
import type { ImportRun } from "./product-import-send";
import {
  COST_INVALID,
  PRICE_INVALID,
  QUANTITY_INVALID,
} from "./product-opening-model";

/**
 * "Só as linhas que falharam" (corte 2.5): a CSV of the rows that did not enter, with the cells as they came and the
 * reason, to fix and send again. Its cells are text of the person's file (a name may start with `=` or `@`), so the
 * file is written by the same `csvRow`/`csvFile` as the data export: a cell that a spreadsheet would take as a
 * formula (`=`, `+`, `-`, `@`, tab, carriage return) gets a leading apostrophe, and the file gets the byte-order mark.
 * Sending this file again brings that apostrophe into the name; the preview shows it as it is.
 */

const ROW_HEADER = "Linha";
const REASON_HEADER = "Motivo";

/** What a refusal of the server says, by field: the messages of the form (AC-1). */
const FIELD_MESSAGES: Record<ImportColumn, string> = {
  category: "A categoria não está mais disponível.",
  description: `Confira a descrição. ${DESCRIPTION_TOO_LONG}`,
  listPrice: PRICE_INVALID,
  name: `Confira o nome. ${NAME_TOO_LONG}`,
  quantity: QUANTITY_INVALID,
  unitCost: COST_INVALID,
};

const STATUS_MESSAGES: Partial<Record<ProductImportRowStatus, string>> = {
  conflict: "Esta linha já foi enviada com outros dados.",
  exists_by_name: "Já existe um produto com este nome.",
  limit_reached: "O plano chegou ao limite de variantes.",
};
/** A row of the run with no answer: the run stopped before it, or it was left out after stopping it. */
const NOT_ANSWERED =
  "Esta linha não foi confirmada. Confira na lista de produtos antes de enviar de novo.";
const EXISTING = STATUS_MESSAGES.exists_by_name ?? "";

/** What a row that did not enter says in the column "Motivo". */
function importResultMessage(result: ProductImportRowResult): string | null {
  if (result.status === "invalid") {
    return FIELD_MESSAGES[result.field];
  }
  return STATUS_MESSAGES[result.status] ?? null;
}

interface FailedRow {
  reason: string;
  rowNumber: number;
  source: ImportSourceCells;
}

/** The rows of a file that did not enter: refused in the preview, repeated in the file, or refused by the server. */
export function failedImportRows(input: {
  duplicates: readonly ImportDuplicateRow[];
  /** The rows the preview left out because the store has a product of that name (`splitExisting`). */
  existing?: readonly { rowNumber: number }[];
  refused: readonly ImportRefusedRow[];
  run: ImportRun | null;
  /** The cells of each row the run sent, by its row number. */
  sources: ReadonlyMap<number, ImportSourceCells>;
}): FailedRow[] {
  const failed: FailedRow[] = [
    ...input.refused.map((row) => ({
      reason: row.errors
        .map((error) =>
          error.column === null
            ? error.message
            : `${IMPORT_COLUMN_LABELS[error.column]}: ${error.message}`
        )
        .join(" "),
      rowNumber: row.rowNumber,
      source: row.source,
    })),
    ...input.duplicates.map((row) => ({
      reason: `Nome repetido na linha ${row.firstRowNumber}.`,
      rowNumber: row.rowNumber,
      source: row.source,
    })),
  ];
  const withSource = (rowNumber: number, reason: string) => {
    const source = input.sources.get(rowNumber);
    if (source !== undefined) {
      failed.push({ reason, rowNumber, source });
    }
  };
  for (const row of input.existing ?? []) {
    withSource(row.rowNumber, EXISTING);
  }
  for (const row of input.run?.rows ?? []) {
    const result = input.run?.results.get(row.rowNumber);
    const reason = result ? importResultMessage(result) : NOT_ANSWERED;
    if (reason !== null) {
      withSource(row.rowNumber, reason);
    }
  }
  return failed.sort((a, b) => a.rowNumber - b.rowNumber);
}

/** The CSV of the rows that failed: the columns of the import, then the row of the file and the reason. */
export function failedImportCsv(rows: readonly FailedRow[]): string {
  return csvFile(
    [
      ...IMPORT_COLUMNS.map((column) => IMPORT_COLUMN_LABELS[column]),
      ROW_HEADER,
      REASON_HEADER,
    ],
    rows.map((row) =>
      csvRow([
        ...IMPORT_COLUMNS.map((column) => row.source[column]),
        row.rowNumber,
        row.reason,
      ])
    )
  );
}
