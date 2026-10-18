/**
 * The data export of an organization (plan PR104, ADR 0078): the owner asks for a copy of
 * what the organization holds, it is built in the background into a private, temporary
 * file, and it can be downloaded for a short time. It is never offered as a step of closing
 * an organization (AGENTS.md and the privacy rules): it is on request.
 */
import { approvedRetention } from "./retention";

const HOUR_MS = 3_600_000;

export const EXPORT_FORMATS = Object.freeze(["json", "csv", "images"] as const);
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = Object.freeze([
  "requested",
  "running",
  "ready",
  "failed",
  "expired",
] as const);
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** How long a finished export can be downloaded (retention class `data_exports`, ADR 0079). */
export const EXPORT_VALIDITY_HOURS =
  approvedRetention("data_exports") / HOUR_MS;
/** At most this many exports are asked for in 24 hours: an export reads everything the organization has. */
export const MAX_EXPORTS_PER_DAY = 3;
/** A run that dies is tried again, up to this many times, and then the export fails. */
export const MAX_EXPORT_ATTEMPTS = 3;
/**
 * How long one run holds an export before another may take it: longer than the 15 minutes of wall time
 * a queue consumer or cron invocation can live, so a run still alive never loses its export.
 */
export const EXPORT_LEASE_SECONDS = 960;
/** What a failed export is kept for before it is removed (the same retention class). */
export const FAILED_EXPORT_KEEP_HOURS =
  approvedRetention("data_exports") / HOUR_MS;

const MiB = 1024 * 1024;
/** The data files (JSON and CSV) are built in memory: past this, the export fails instead of half-working. */
export const MAX_EXPORT_DATA_BYTES = 16 * MiB;
/** One archive of images is built in memory too, so the images go in parts of at most this size. */
export const EXPORT_IMAGE_PART_BYTES = 32 * MiB;
/**
 * Each image is a read from storage, and one run of the Worker can make a limited number of them (the platform
 * counts every call to the database and to storage): past this many, a copy with images fails before it starts.
 */
export const MAX_EXPORT_IMAGES = 400;
/** The rows read from a table at a time. */
export const EXPORT_PAGE_ROWS = 1000;

export type ExportRefusalCode =
  | "invalid_export_request"
  | "export_already_running"
  | "export_limit_reached";

export class InvalidExportRequestError extends Error {
  readonly code: ExportRefusalCode;

  constructor(code: ExportRefusalCode = "invalid_export_request") {
    super(code);
    this.code = code;
    this.name = "InvalidExportRequestError";
  }
}

/** The export asked for does not exist, is not this organization's, has expired or is not ready. */
export class DataExportUnavailableError extends Error {
  readonly code = "export_not_available";

  constructor() {
    super("export_not_available");
    this.name = "DataExportUnavailableError";
  }
}

/** The formats asked for: at least one, each known, none repeated; the order is the canonical one. */
export function normalizeExportFormats(input: unknown): ExportFormat[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > EXPORT_FORMATS.length
  ) {
    throw new InvalidExportRequestError();
  }
  const asked = new Set<string>();
  for (const value of input) {
    if (
      typeof value !== "string" ||
      !EXPORT_FORMATS.some((format) => format === value) ||
      asked.has(value)
    ) {
      throw new InvalidExportRequestError();
    }
    asked.add(value);
  }
  return EXPORT_FORMATS.filter((format) => asked.has(format));
}

/** When a finished export stops being available. */
export function exportExpiry(readyAt: Date): Date {
  return new Date(readyAt.getTime() + EXPORT_VALIDITY_HOURS * 3_600_000);
}

export function isExportAvailable(
  status: string,
  expiresAt: Date | null,
  now: Date
): boolean {
  return (
    status === "ready" &&
    expiresAt !== null &&
    now.getTime() < expiresAt.getTime()
  );
}

/** What the exported file is called when it is downloaded: the date and the part, never the organization's name. */
export function exportFileName(
  kind: "data" | "images",
  part: number,
  at: Date
): string {
  const day = at.toISOString().slice(0, 10);
  return kind === "data"
    ? `polaris-dados-${day}.zip`
    : `polaris-imagens-${day}-parte-${String(part).padStart(3, "0")}.zip`;
}

export interface ExportDatasetSummary {
  columns: string[];
  name: string;
  rows: number;
}

export interface ExportManifest {
  datasets: ExportDatasetSummary[];
  exportId: string;
  formats: ExportFormat[];
  generatedAt: string;
  /** How many images the organization had when the copy was read; null when images were not asked for. Each image part lists its own images. */
  images: { total: number } | null;
  organizationId: string;
  version: 1;
}

/** A plain explanation placed in the archive, in the language of the people who open it. */
export const EXPORT_README = `Cópia dos dados da organização, gerada pelo Polaris a pedido do responsável.

Conteúdo
- manifest.json: o que o arquivo contém (as tabelas, as colunas e o número de linhas de cada uma).
- data/*.json (quando pedido): uma lista de registros por tabela, com os valores exatamente como estão.
- csv/*.csv (quando pedido): as mesmas tabelas em planilha (UTF-8 com marca de ordem de bytes, para o Excel).
- Imagens (quando pedido): em arquivos separados, em partes. Cada parte tem um indice.json com as imagens que ela contém (e, na última parte, as imagens que não puderam ser incluídas).

Como ler
- Datas e horas estão em UTC (formato ISO 8601).
- Valores em dinheiro e quantidades são texto com ponto decimal (por exemplo "12.50"), sem arredondar.
- Nas planilhas, uma célula de texto que começaria com =, +, -, @ ou tabulação ganha uma aspa simples na frente, para a planilha não executá-la como fórmula. Os arquivos JSON não mudam nenhum valor.
- Os identificadores (id) ligam as tabelas entre si.

Este arquivo contém dados pessoais de clientes. Guarde-o em local seguro. Ele fica disponível para baixar por tempo limitado e é apagado depois.
`;
