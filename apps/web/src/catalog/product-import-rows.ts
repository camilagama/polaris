import type { CategoryReadModel } from "@polaris/contracts";
import {
  hasForbiddenProductText,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
} from "@polaris/domain/catalog/product";
import {
  decodeSpreadsheet,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  parseCsv,
} from "./product-import-csv";
import {
  PRODUCT_NAME_REQUIRED,
  validateOpening,
} from "./product-opening-model";

/**
 * The rows of a spreadsheet, read and checked in the browser before anything is sent (corte 2.5). Each row passes
 * through the rules of the form of a new product (AC-1): the same name rule, the same price, quantity and cost
 * (`validateOpening`, with its messages) and the same description, so a row the form refuses is refused here with
 * the form's message. Only what a spreadsheet writes and the form never sees is read before: "R$" in front of a
 * value and the dot of the thousands in "1.234,56" or "1.234.567" (AC-2). A value like "1.234" (the dot of the
 * thousands or of the decimals?) is not guessed: the row is refused and says how to write it.
 *
 * Nothing is neutralized on the way in: a name that starts with `=` is kept as it came (the CSV of the rows that
 * failed neutralizes it on the way out, `product-import-failed-csv.ts`).
 */

export type ImportColumn =
  | "category"
  | "description"
  | "listPrice"
  | "name"
  | "quantity"
  | "unitCost";

/** The header of each column as the template writes it: the labels of the form. */
export const IMPORT_COLUMN_LABELS: Record<ImportColumn, string> = {
  category: "Categoria",
  description: "Descrição",
  listPrice: "Preço de tabela",
  name: "Nome",
  quantity: "Quantidade",
  unitCost: "Custo de cada unidade",
};

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  "name",
  "listPrice",
  "quantity",
  "unitCost",
  "category",
  "description",
];

/** The other ways a spreadsheet names a column (T-4), compared without accents, case or repeated spaces. */
const HEADER_ALIASES: Record<ImportColumn, readonly string[]> = {
  category: ["categoria"],
  description: ["descricao", "descricao do produto"],
  listPrice: ["preco de tabela", "preco", "preco de venda", "valor de venda"],
  name: ["nome", "produto", "nome do produto"],
  quantity: ["quantidade", "qtd", "qtde", "estoque", "quantos voce tem agora"],
  unitCost: ["custo de cada unidade", "custo", "custo unitario"],
};

const DIACRITICS = /\p{M}/gu;
const SPACES = /\s+/g;
const HEADER_DECORATION = /[*:]+$/;

function headerKey(header: string): string {
  return header
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .replace(SPACES, " ")
    .trim()
    .replace(HEADER_DECORATION, "")
    .trim()
    .toLowerCase();
}

const COLUMN_OF_HEADER = new Map<string, ImportColumn>(
  IMPORT_COLUMNS.flatMap((column) =>
    HEADER_ALIASES[column].map((alias) => [alias, column] as const)
  )
);

/** The key two names share when they differ only by case and repeated spaces, as the server compares them. */
function importNameKey(name: string): string {
  return name.replace(SPACES, " ").trim().toLowerCase();
}

export type ImportSourceCells = Record<ImportColumn, string>;

interface ImportRowError {
  column: ImportColumn;
  message: string;
}

export interface ImportReadyRow {
  categoryId: string | null;
  description: string | null;
  initialStock: { quantity: number; unitCost: string | null } | null;
  listPrice: string | null;
  name: string;
  rowNumber: number;
  /** The cells as they came, for the CSV of the rows that failed. */
  source: ImportSourceCells;
}

export interface ImportRefusedRow {
  errors: ImportRowError[];
  rowNumber: number;
  source: ImportSourceCells;
}

export interface ImportDuplicateRow {
  /** The earlier row of the file with the same name: that one is the one imported. */
  firstRowNumber: number;
  rowNumber: number;
  source: ImportSourceCells;
}

interface ImportCategoryWarning {
  rowNumber: number;
}

export type ImportFileProblem =
  | "empty"
  | "missing_name_column"
  | "repeated_column"
  | "too_large"
  | "too_many_columns"
  | "too_many_rows"
  | "unclosed_quote";

export type ImportPreview =
  | {
      /** Rows whose category is not one of the store: they enter without a category. */
      categoryWarnings: ImportCategoryWarning[];
      duplicates: ImportDuplicateRow[];
      /** Headers of the file that are not columns of the import: they are left out. */
      ignoredHeaders: string[];
      kind: "ok";
      ready: ImportReadyRow[];
      refused: ImportRefusedRow[];
    }
  | { kind: "problem"; problem: ImportFileProblem; rowNumber?: number };

/** What the preview says of a problem of the whole file. */
export const IMPORT_FILE_PROBLEM_MESSAGES: Record<ImportFileProblem, string> = {
  empty: "O arquivo está vazio.",
  missing_name_column: 'O arquivo precisa de uma coluna "Nome".',
  repeated_column: "Uma coluna aparece duas vezes no arquivo.",
  too_large: "O arquivo passa de 1 MB. Divida em arquivos menores.",
  too_many_columns: `Uma linha tem mais de ${IMPORT_MAX_COLUMNS} colunas. Confira se o arquivo foi salvo como CSV.`,
  too_many_rows: `O arquivo passa de ${IMPORT_MAX_ROWS} linhas. Divida em arquivos menores.`,
  unclosed_quote:
    "Uma aspa abre e não fecha no arquivo. Confira se ele foi salvo como CSV.",
};

export const NAME_TOO_LONG = `O nome pode ter até ${MAX_PRODUCT_NAME_LENGTH} caracteres.`;
export const DESCRIPTION_TOO_LONG = `A descrição pode ter até ${MAX_PRODUCT_DESCRIPTION_LENGTH} caracteres.`;
export const FORBIDDEN_CHARACTER =
  "Tem um caractere que não pode ser usado (de controle ou que inverte o texto).";
export const AMBIGUOUS_VALUE =
  "Valor ambíguo: escreva 1234 ou 1.234,00 (a vírgula separa os centavos).";
export const VALUE_TOO_LONG = "O valor é longo demais.";

/** The longest value of a price, a quantity or a cost that `product.create` takes. */
const MAX_VALUE_LENGTH = 64;

const CURRENCY = /^R\$\s*/i;
const BRAZILIAN_THOUSANDS = /^\d{1,3}(?:\.\d{3})+,\d+$/;
const ENGLISH_THOUSANDS = /^\d{1,3}(?:,\d{3})+\.\d+$/;
const DOTTED_THOUSANDS = /^\d{1,3}(?:\.\d{3}){2,}$/;
const AMBIGUOUS_DOT = /^\d{1,3}\.\d{3}$/;
const NO_BREAK_SPACE = /\u00A0/g;

type Prepared = { kind: "ambiguous" } | { kind: "ok"; text: string };

/**
 * A value of money as a spreadsheet writes it, in the text the form reads: "R$" off, and the separator of the
 * thousands off when the value says which one it is. Anything else goes to the form's rule as it came.
 */
export function spreadsheetDecimal(cell: string): Prepared {
  const text = cell.replace(NO_BREAK_SPACE, " ").trim().replace(CURRENCY, "");
  if (BRAZILIAN_THOUSANDS.test(text)) {
    return { kind: "ok", text: text.replaceAll(".", "") };
  }
  if (ENGLISH_THOUSANDS.test(text)) {
    return { kind: "ok", text: text.replaceAll(",", "") };
  }
  if (DOTTED_THOUSANDS.test(text)) {
    return { kind: "ok", text: text.replaceAll(".", "") };
  }
  if (AMBIGUOUS_DOT.test(text)) {
    return { kind: "ambiguous" };
  }
  return { kind: "ok", text };
}

interface Columns {
  ignoredHeaders: string[];
  positions: Map<ImportColumn, number>;
}

function mapHeader(
  header: readonly string[]
): Columns | { problem: ImportFileProblem } {
  const positions = new Map<ImportColumn, number>();
  const ignoredHeaders: string[] = [];
  for (const [index, text] of header.entries()) {
    const column = COLUMN_OF_HEADER.get(headerKey(text));
    if (column === undefined) {
      if (text.trim() !== "") {
        ignoredHeaders.push(text.trim());
      }
      continue;
    }
    if (positions.has(column)) {
      return { problem: "repeated_column" };
    }
    positions.set(column, index);
  }
  if (!positions.has("name")) {
    return { problem: "missing_name_column" };
  }
  return { ignoredHeaders, positions };
}

function sourceOf(
  cells: readonly string[],
  positions: Map<ImportColumn, number>
): ImportSourceCells {
  const cell = (column: ImportColumn) => {
    const position = positions.get(column);
    return position === undefined ? "" : (cells[position] ?? "");
  };
  return {
    category: cell("category"),
    description: cell("description"),
    listPrice: cell("listPrice"),
    name: cell("name"),
    quantity: cell("quantity"),
    unitCost: cell("unitCost"),
  };
}

function nameErrors(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") {
    return PRODUCT_NAME_REQUIRED;
  }
  if (trimmed.length > MAX_PRODUCT_NAME_LENGTH) {
    return NAME_TOO_LONG;
  }
  return hasForbiddenProductText(trimmed) ? FORBIDDEN_CHARACTER : null;
}

function descriptionErrors(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
    return DESCRIPTION_TOO_LONG;
  }
  return hasForbiddenProductText(trimmed) ? FORBIDDEN_CHARACTER : null;
}

/** The price, the quantity and the cost through the form's own rule, after the spreadsheet's way of writing them. */
function openingOf(source: ImportSourceCells): {
  errors: ImportRowError[];
  value: ReturnType<typeof validateOpening>["value"];
} {
  const errors = new Map<ImportColumn, string>();
  const draft = { listPrice: "", quantity: source.quantity, unitCost: "" };
  for (const column of ["listPrice", "unitCost"] as const) {
    const prepared = spreadsheetDecimal(source[column]);
    if (prepared.kind === "ambiguous") {
      errors.set(column, AMBIGUOUS_VALUE);
    } else {
      draft[column] = prepared.text;
    }
  }
  for (const column of ["listPrice", "quantity", "unitCost"] as const) {
    if (source[column].length > MAX_VALUE_LENGTH) {
      errors.set(column, VALUE_TOO_LONG);
      draft[column] = "";
    }
  }
  const validation = validateOpening(draft);
  for (const column of ["listPrice", "quantity", "unitCost"] as const) {
    const message = validation.errors[column];
    if (message !== undefined && !errors.has(column)) {
      errors.set(column, message);
    }
  }
  return {
    errors: IMPORT_COLUMNS.flatMap((column) => {
      const message = errors.get(column);
      return message === undefined ? [] : [{ column, message }];
    }),
    value: errors.size > 0 ? null : validation.value,
  };
}

/** The category of the row, by its name among the store's; a name the store does not have is a warning. */
function categoryOf(
  cell: string,
  categories: ReadonlyMap<string, string>
): { categoryId: string | null; warning: boolean } {
  const key = importNameKey(cell);
  if (key === "") {
    return { categoryId: null, warning: false };
  }
  const categoryId = categories.get(key);
  // a category the store does not have is not created here (T-3): the row enters without one, and the preview says so
  return categoryId === undefined
    ? { categoryId: null, warning: true }
    : { categoryId, warning: false };
}

type RowReading =
  | { kind: "ready"; row: ImportReadyRow; warning: boolean }
  | { kind: "refused"; row: ImportRefusedRow };

function readRow(
  rowNumber: number,
  source: ImportSourceCells,
  categories: ReadonlyMap<string, string>
): RowReading {
  const errors: ImportRowError[] = [];
  const nameError = nameErrors(source.name);
  if (nameError !== null) {
    errors.push({ column: "name", message: nameError });
  }
  const opening = openingOf(source);
  errors.push(...opening.errors);
  const category = categoryOf(source.category, categories);
  const descriptionError = descriptionErrors(source.description);
  if (descriptionError !== null) {
    errors.push({ column: "description", message: descriptionError });
  }
  if (errors.length > 0 || opening.value === null) {
    return { kind: "refused", row: { errors, rowNumber, source } };
  }
  return {
    kind: "ready",
    row: {
      categoryId: category.categoryId,
      description: source.description.trim() || null,
      initialStock: opening.value.initialStock,
      listPrice: opening.value.listPrice,
      name: source.name.trim(),
      rowNumber,
      source,
    },
    warning: category.warning,
  };
}

/** The active categories of the store by name, compared without case or repeated spaces. */
function categoriesByName(
  categories: readonly Pick<CategoryReadModel, "id" | "name" | "status">[]
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const category of categories) {
    const key = importNameKey(category.name);
    if (category.status === "active" && !byName.has(key)) {
      byName.set(key, category.id);
    }
  }
  return byName;
}

/** The preview of a file: what will be sent, what was refused and why, and the names the file repeats. */
export function previewImport(
  bytes: Uint8Array,
  categories: readonly Pick<CategoryReadModel, "id" | "name" | "status">[]
): ImportPreview {
  const decoded = decodeSpreadsheet(bytes);
  if (decoded.kind === "too_large") {
    return { kind: "problem", problem: "too_large" };
  }
  const parsed = parseCsv(decoded.text);
  if (parsed.kind !== "ok") {
    return {
      kind: "problem",
      problem: parsed.kind,
      ...("rowNumber" in parsed ? { rowNumber: parsed.rowNumber } : {}),
    };
  }
  const columns = mapHeader(parsed.header);
  if ("problem" in columns) {
    return { kind: "problem", problem: columns.problem };
  }
  const byName = categoriesByName(categories);
  const ready: ImportReadyRow[] = [];
  const refused: ImportRefusedRow[] = [];
  const duplicates: ImportDuplicateRow[] = [];
  const categoryWarnings: ImportCategoryWarning[] = [];
  const firstRowOfName = new Map<string, number>();
  for (const record of parsed.records) {
    const source = sourceOf(record.cells, columns.positions);
    const reading = readRow(record.rowNumber, source, byName);
    if (reading.kind === "refused") {
      refused.push(reading.row);
      continue;
    }
    const key = importNameKey(reading.row.name);
    const firstRowNumber = firstRowOfName.get(key);
    if (firstRowNumber !== undefined) {
      duplicates.push({ firstRowNumber, rowNumber: record.rowNumber, source });
      continue;
    }
    firstRowOfName.set(key, record.rowNumber);
    ready.push(reading.row);
    if (reading.warning) {
      categoryWarnings.push({ rowNumber: record.rowNumber });
    }
  }
  return {
    categoryWarnings,
    duplicates,
    ignoredHeaders: columns.ignoredHeaders,
    kind: "ok",
    ready,
    refused,
  };
}

/** The ready rows whose name a product of the store already has (`product.namesExisting`): they will be skipped. */
export function splitExisting(
  ready: readonly ImportReadyRow[],
  existingNames: readonly string[]
): { existing: ImportReadyRow[]; fresh: ImportReadyRow[] } {
  const existingKeys = new Set(existingNames.map(importNameKey));
  const existing: ImportReadyRow[] = [];
  const fresh: ImportReadyRow[] = [];
  for (const row of ready) {
    (existingKeys.has(importNameKey(row.name)) ? existing : fresh).push(row);
  }
  return { existing, fresh };
}
