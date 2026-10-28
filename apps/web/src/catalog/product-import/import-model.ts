import type { BillingPlanView } from "@polaris/contracts";
import { legalAcceptanceMessage, rpcErrorCode } from "../../lib/rpc-error";
import { IMPORT_MAX_BYTES } from "../product-import-csv";
import { csvFile } from "@polaris/domain/privacy/csv";
import {
  type FailedRowKind,
  failedImportRows,
} from "../product-import-failed-csv";
import {
  IMPORT_COLUMN_LABELS,
  IMPORT_COLUMNS,
  type ImportAliasedHeader,
  type ImportDuplicateRow,
  type ImportPreview,
  type ImportReadyRow,
  type ImportRefusedRow,
  type ImportSourceCells,
  splitExisting,
} from "../product-import-rows";
import {
  IMPORT_CALL_INTERVAL_MS,
  type ImportRun,
  type ImportStop,
  summarizeImport,
} from "../product-import-send";

/**
 * What the dialog "Importar planilha" says and decides, apart from React (corte 2.5):
 * what of the file enters, what the plan holds, the rows of the tables and the sentences of each step. Before the
 * start the dialog gives a range of time (`importDurationText`), never one number; during the run, the time left comes
 * only from the pace of this import, its pauses included.
 */

type OkPreview = Extract<ImportPreview, { kind: "ok" }>;

/** What a file becomes once the store was asked for its names and the plan for its room: nothing sent yet. */
export interface ImportPlan {
  aliasedHeaders: readonly ImportAliasedHeader[];
  /** The rows sent whose category is not one of the store (they enter without one). */
  categoryWarningRows: ReadonlySet<number>;
  duplicates: readonly ImportDuplicateRow[];
  /** Rows whose name a product of the store already has: skipped. */
  existing: readonly ImportReadyRow[];
  ignoredHeaders: readonly string[];
  /** Rows past the room of the plan: left out, only with the person's confirmation of the first ones. */
  overLimit: readonly ImportReadyRow[];
  refused: readonly ImportRefusedRow[];
  /** The variants the plan still holds, from its read; `null` when it was not read (the server stops at the limit). */
  room: number | null;
  /** The cells of every row of the file that passed the reading, by row number, for the tables and the CSV. */
  sources: ReadonlyMap<number, ImportSourceCells>;
  /** The rows that go to the server, in the order of the file. */
  toSend: readonly ImportReadyRow[];
  /** The rows of the file under the header. */
  total: number;
}

/** The variants the plan still holds: its limit less what is used, never below zero; `null` with no limit or no read. */
export function planRoom(
  plan: Pick<BillingPlanView, "limits" | "usage"> | null
): number | null {
  const max = plan?.limits.variants;
  if (plan === null || max === null || max === undefined) {
    return null;
  }
  return Math.max(max - plan.usage.variants, 0);
}

export function planImport(
  preview: OkPreview,
  existingNames: readonly string[],
  room: number | null
): ImportPlan {
  const { existing, fresh } = splitExisting(preview.ready, existingNames);
  const fits = room === null ? fresh.length : Math.min(room, fresh.length);
  const toSend = fresh.slice(0, fits);
  const sent = new Set(toSend.map((row) => row.rowNumber));
  return {
    aliasedHeaders: preview.aliasedHeaders,
    categoryWarningRows: new Set(
      preview.categoryWarnings
        .map((warning) => warning.rowNumber)
        .filter((rowNumber) => sent.has(rowNumber))
    ),
    duplicates: preview.duplicates,
    existing,
    ignoredHeaders: preview.ignoredHeaders,
    overLimit: fresh.slice(fits),
    refused: preview.refused,
    room,
    sources: new Map(preview.ready.map((row) => [row.rowNumber, row.source])),
    toSend,
    total:
      preview.ready.length + preview.refused.length + preview.duplicates.length,
  };
}

/** What a row of the preview becomes; the mark is a word, never a color alone. */
export type RowSituation =
  | "enters"
  | "error"
  | "exists"
  | "no_category"
  | "over_limit";

export const SITUATION_LABELS: Record<RowSituation, string> = {
  enters: "Entra",
  error: "Erro",
  exists: "Já existe",
  no_category: "Sem categoria",
  over_limit: "Fica de fora",
};

export interface TableRow {
  name: string;
  reason: string | null;
  rowNumber: number;
  situation: RowSituation;
}

const EXISTS_IN_PREVIEW = "Já existe um produto com este nome. Fica como está.";
const OVER_LIMIT_IN_PREVIEW = "Não cabe no plano: esta linha fica de fora.";

function noCategoryReason(category: string): string {
  // a cell of the file can be as long as the file: written as the headers are
  return `A categoria “${shortHeader(category.trim())}” não existe na loja. O produto entra sem categoria.`;
}

/** Every row of the file in the preview, in its order, with its mark and its reason. */
export function previewTableRows(plan: ImportPlan): TableRow[] {
  const rows: TableRow[] = [
    // the refusals and the repeats of the file, with the reasons of the CSV of the rows that failed
    ...failedImportRows({
      duplicates: plan.duplicates,
      refused: plan.refused,
      run: null,
      sources: plan.sources,
    }).map((row) => ({
      name: row.source.name.trim(),
      reason: row.reason,
      rowNumber: row.rowNumber,
      situation: "error" as const,
    })),
    ...plan.existing.map((row) => ({
      name: row.name,
      reason: EXISTS_IN_PREVIEW,
      rowNumber: row.rowNumber,
      situation: "exists" as const,
    })),
    ...plan.overLimit.map((row) => ({
      name: row.name,
      reason: OVER_LIMIT_IN_PREVIEW,
      rowNumber: row.rowNumber,
      situation: "over_limit" as const,
    })),
    ...plan.toSend.map((row) =>
      plan.categoryWarningRows.has(row.rowNumber)
        ? {
            name: row.name,
            reason: noCategoryReason(row.source.category),
            rowNumber: row.rowNumber,
            situation: "no_category" as const,
          }
        : {
            name: row.name,
            reason: null,
            rowNumber: row.rowNumber,
            situation: "enters" as const,
          }
    ),
  ];
  return rows.sort((a, b) => a.rowNumber - b.rowNumber);
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/** The three counts of the preview, one line each. */
export function previewCounts(plan: ImportPlan): string[] {
  const errors = plan.refused.length + plan.duplicates.length;
  const lines = [
    `${plan.total} ${plural(plan.total, "linha", "linhas")} no arquivo`,
    `${plan.toSend.length} ${plural(plan.toSend.length, "vai entrar", "vão entrar")}`,
  ];
  if (plan.existing.length > 0) {
    lines.push(
      `${plan.existing.length} ${plural(plan.existing.length, "já existe (fica como está)", "já existem (ficam como estão)")}`
    );
  }
  if (errors > 0) {
    lines.push(`${errors} com erro (não ${plural(errors, "entra", "entram")})`);
  }
  if (plan.overLimit.length > 0) {
    lines.push(
      `${plan.overLimit.length} além do limite do plano (${plural(plan.overLimit.length, "fica", "ficam")} de fora)`
    );
  }
  return lines;
}

/** "N produtos entram sem categoria…", when some of the rows sent name a category the store does not have. */
export function noCategoryText(plan: ImportPlan): string | null {
  const count = plan.categoryWarningRows.size;
  if (count === 0) {
    return null;
  }
  return `${count} ${plural(count, "produto entra", "produtos entram")} sem categoria (a categoria do arquivo não existe na loja).`;
}

/** What the preview says when the file passes the room of the plan; `null` when it fits or the plan was not read. */
export function overLimitText(plan: ImportPlan): string | null {
  const left = plan.overLimit.length;
  if (left === 0 || plan.room === null) {
    return null;
  }
  if (plan.room === 0) {
    return "O plano chegou ao limite: nenhum produto novo cabe.";
  }
  const fits =
    plan.room === 1
      ? "Cabe 1 no seu plano. Entra a primeira"
      : `Cabem ${plan.room} no seu plano. Entram as ${plan.room} primeiras`;
  return `${fits}; ${left} ${plural(left, "fica", "ficam")} de fora.`;
}

/** "Lemos "Qtd" como Quantidade." and "A coluna "Marca" não é usada.", for the person to check the columns. */
export function headerNotes(plan: ImportPlan): string[] {
  return [
    ...plan.aliasedHeaders.map(
      (alias) =>
        `Lemos “${shortHeader(alias.header)}” como ${IMPORT_COLUMN_LABELS[alias.column]}.`
    ),
    ...plan.ignoredHeaders.map(
      (header) => `A coluna “${shortHeader(header)}” não é usada.`
    ),
  ];
}

/** The longest header (or category) the preview writes whole: a cell of the file can be as long as the file. */
const HEADER_SHOWN = 60;

function shortHeader(header: string): string {
  return header.length > HEADER_SHOWN
    ? `${header.slice(0, HEADER_SHOWN)}…`
    : header;
}

/**
 * Why "Importar" stays off: a file with no row under the header (the template as it was downloaded) is not a file
 * whose rows were refused.
 */
export function nothingToImportText(plan: ImportPlan): string {
  return plan.total === 0
    ? "O arquivo não tem linhas abaixo do cabeçalho."
    : "Nenhuma linha do arquivo pode entrar.";
}

/** "Importar 46 produtos": the number is what will be sent. */
export function importButtonLabel(count: number): string {
  return `Importar ${count} ${plural(count, "produto", "produtos")}`;
}

/** Whether any row sent has a quantity: the preview says what the opening stock is. */
export function hasOpeningStock(rows: readonly ImportReadyRow[]): boolean {
  return rows.some((row) => row.initialStock !== null);
}

export function progressTitle(count: number): string {
  return `Importando ${count} ${plural(count, "produto", "produtos")}…`;
}

/** The rows of the run with an answer (or left out): the progress, never a time. */
export function answeredCount(run: ImportRun): number {
  return run.nextIndex;
}

export function progressValueText(done: number, count: number): string {
  return `${done} de ${count} ${plural(count, "produto", "produtos")}`;
}

/** "23 produtos entraram; 23 faltam." */
export function enteredAndLeft(entered: number, left: number): string {
  return `${entered} ${plural(entered, "produto entrou", "produtos entraram")}; ${left} ${plural(left, "falta", "faltam")}.`;
}

/** What a pause says before "N produtos entraram; M faltam.". */
function pauseLead(pause: ImportPause): string {
  switch (pause.kind) {
    case "offline":
      return "Sem internet.";
    case "stopped":
      return "Importação parada.";
    case "interrupted":
      return "O servidor não respondeu a esta linha.";
    case "rate_limited":
      return "O envio está ocupado agora. Espere um minuto e continue.";
    default:
      return pause.message;
  }
}

/**
 * What a pause says: why the run stopped, then what entered and what is left. What entered stays (no word of
 * cancelling or undoing: nothing is undone); a row the server never answered says so ("Pular esta linha" goes with it).
 */
export function pauseText(
  pause: ImportPause,
  entered: number,
  left: number
): string {
  return `${pauseLead(pause)} ${enteredAndLeft(entered, left)}`;
}

const MINUTE_MS = 60_000;

/** "1 hora", "1 hora e 20 minutos", "45 minutos". */
function durationWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const minutePart = `${rest} ${plural(rest, "minuto", "minutos")}`;
  if (hours === 0) {
    return minutePart;
  }
  const hourPart = `${hours} ${plural(hours, "hora", "horas")}`;
  return rest === 0 ? hourPart : `${hourPart} e ${minutePart}`;
}

/**
 * The time left, only from the pace of this import (the rows answered since it started or continued, the pauses
 * included), said as an estimate; `null` before three rows, too few for a pace.
 */
export function estimateText(
  answered: number,
  elapsedMs: number,
  left: number
): string | null {
  if (answered < 3 || elapsedMs <= 0 || left <= 0) {
    return null;
  }
  const minutes = Math.max(
    1,
    Math.ceil(((elapsedMs / answered) * left) / MINUTE_MS)
  );
  const verb = minutes === 1 || minutes === 60 ? "Falta" : "Faltam";
  return `${verb} cerca de ${durationWords(minutes)}.`;
}

/** The share of the calls the regime of the Free plan cuts on an ordinary day, each sent again. */
const CUT_SHARE = 0.1;
/** What one regime of the platform costs a run: its pauses and the half pace after them. */
const REGIME_COST_MS = 15 * MINUTE_MS;
/** A run this long meets, at most, one more regime. */
const REGIME_EVERY_MS = 45 * MINUTE_MS;
/** A run shorter than this is not counted to meet one. */
const REGIME_FROM_MS = 5 * MINUTE_MS;

function ceilTo(minutes: number, step: number): number {
  return Math.max(step, Math.ceil(minutes / step) * step);
}

interface RangeEnd {
  unit: "horas" | "minutos";
  value: number;
}

/** One end of the range: whole hours from one hour up, 5 minutes below. */
function rangeEnd(ms: number, round: (hours: number) => number): RangeEnd {
  const minutes = ms / MINUTE_MS;
  if (minutes <= 55) {
    return { unit: "minutos", value: ceilTo(minutes, 5) };
  }
  return { unit: "horas", value: Math.max(1, round(minutes / 60)) };
}

function rangeEndWords({ unit, value }: RangeEnd): string {
  return unit === "horas"
    ? `${value} ${plural(value, "hora", "horas")}`
    : `${value} minutos`;
}

/**
 * The time of an import before it starts, as a range: the rows at the pace plus the share of cuts at the low end,
 * and the pauses of the regimes it may meet at the high end (one for every 45 minutes). 100 rows: 15 to 30
 * minutes; 500: 1 to 2 hours.
 */
function importDurationRange(count: number): {
  high: RangeEnd;
  low: RangeEnd;
} {
  const base = count * IMPORT_CALL_INTERVAL_MS * (1 + CUT_SHARE);
  const regimes = base < REGIME_FROM_MS ? 0 : Math.ceil(base / REGIME_EVERY_MS);
  return {
    high: rangeEnd(base + regimes * REGIME_COST_MS, Math.ceil),
    low: rangeEnd(base, Math.floor),
  };
}

/** "até 5 minutos", "de 15 a 30 minutos", "de 45 minutos a 2 horas", "de 1 a 2 horas". */
function rangeWords(low: RangeEnd, high: RangeEnd): string {
  if (low.unit === high.unit && low.value === high.value) {
    return `até ${rangeEndWords(high)}`;
  }
  const from = low.unit === high.unit ? low.value : rangeEndWords(low);
  return `de ${from} a ${rangeEndWords(high)}`;
}

/** What the preview says of the time before "Importar": the range, keep the screen open, and how to continue. */
export function importDurationText(count: number): string {
  const { high, low } = importDurationRange(count);
  return `Importar ${count} ${plural(count, "produto", "produtos")} leva ${rangeWords(low, high)}. Deixe esta tela aberta. Se fechar, abra a mesma planilha de novo: o que já entrou não é repetido.`;
}

/** Above this many rows to send, the preview recommends smaller files (without holding the import). */
const IMPORT_SPLIT_FROM_ROWS = 200;

export function splitAdviceText(count: number): string | null {
  return count > IMPORT_SPLIT_FROM_ROWS
    ? `São mais de ${IMPORT_SPLIT_FROM_ROWS} produtos. Se puder, divida a planilha em arquivos menores e importe fora do horário de vendas.`
    : null;
}

/**
 * Whether the tab's own work is failing now, so the import holds its next call: the breaker of the reads open, or a
 * command of the queue (a sale) waiting after the server died on its send (`server_busy`, or the quiet failures of
 * the first 60 s). A send that failed otherwise (a 413, a 429) is not the server's regime, and would hold the import
 * for nothing.
 */
export function tillIsFailing(till: {
  quietRetries: boolean;
  reason: string | null;
  serverFailing: boolean;
  waiting: number;
}): boolean {
  return (
    till.serverFailing ||
    (till.waiting > 0 && (till.reason === "server_busy" || till.quietRetries))
  );
}

/**
 * Whether a paused run offers "Pular esta linha": after a row the server never answered, and after a stop while the
 * run was at the longest pause of the regime (a row the Worker cannot finish is cut every time, and the first row,
 * or one right after a row left out, is never left out by the run itself).
 */
export function canSkipRow(pause: ImportPause, run: ImportRun): boolean {
  return (
    pause.kind === "interrupted" ||
    (pause.kind === "stopped" && run.regime.lastPauseAtCeiling)
  );
}

/** The pause of the regime: the hour it goes on by itself, in the store's time zone. No "try now": it would prolong the regime. */
export function busyPauseText(resumeAt: number, timeZone: string): string {
  const hour = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(resumeAt);
  return `O servidor está ocupado. A importação continua sozinha às ${hour}.`;
}

/** The rows that did not enter, for the table and the CSV of the result: what already existed is not a failure. */
export function resultFailedRows(plan: ImportPlan, run: ImportRun | null) {
  return failedImportRows({
    duplicates: plan.duplicates,
    overLimit: plan.overLimit,
    refused: plan.refused,
    run,
    sources: plan.sources,
  }).filter((row) => row.kind !== "exists");
}

/**
 * The text of the button of the CSV of the result. With a row not confirmed (it may have entered) the file is no longer
 * only of rows that failed: it says "para conferir". The file keeps those rows, since sending again is safe (a name
 * that exists is skipped).
 */
export function failedCsvLabel(
  failed: readonly { kind: FailedRowKind }[]
): string {
  const count = failed.length;
  const check = failed.some((row) => row.kind === "unconfirmed");
  if (count === 1) {
    return check
      ? "Baixar a linha para conferir (CSV)"
      : "Baixar a linha que falhou (CSV)";
  }
  return check
    ? `Baixar as ${count} linhas para conferir (CSV)`
    : `Baixar as ${count} linhas que falharam (CSV)`;
}

export const FAILED_KIND_LABELS: Record<
  Exclude<FailedRowKind, "exists">,
  string
> = {
  error: "Erro",
  not_entered: "Não entrou",
  unconfirmed: "Não confirmada",
};

export interface ResultTexts {
  existing: string | null;
  /** The server stopped at the plan's limit: the result shows what goes with that limit (corte 1.6). */
  limitReached: boolean;
  /**
   * The rows that did not enter, in one sentence with the part the plan's limit left out (never counted twice):
   * "1 linha não entrou.", "2 linhas não entraram: o plano chegou ao limite.", "3 linhas não entraram, 2 delas pelo
   * limite do plano."
   */
  notEntered: string | null;
  title: string;
  /** Rows with no answer (the run stopped on them, or before them, or left them out): they may have entered. */
  unconfirmed: string | null;
}

/** The rows that did not enter, and of them the ones the plan's limit left out, in one sentence. */
function notEnteredText(count: number, byLimit: number): string | null {
  if (count === 0) {
    return null;
  }
  const lead = `${count} ${plural(count, "linha não entrou", "linhas não entraram")}`;
  if (byLimit === 0) {
    return `${lead}.`;
  }
  return byLimit >= count
    ? `${lead}: o plano chegou ao limite.`
    : `${lead}, ${byLimit} delas pelo limite do plano.`;
}

const NO_RUN = {
  entered: 0,
  existing: 0,
  failed: 0,
  limitReached: 0,
  pending: 0,
};

/**
 * The rows whose name the store already had: from an earlier import of the same file (the way to continue one) or made
 * by hand; the device keeps no record of which, so the text names both.
 */
function existingText(count: number): string | null {
  if (count === 0) {
    return null;
  }
  return `${count} ${plural(count, "já estava na loja (importado antes ou cadastrado) e ficou como estava", "já estavam na loja (importados antes ou cadastrados) e ficaram como estavam")}.`;
}

export function resultTexts(
  plan: ImportPlan,
  run: ImportRun | null
): ResultTexts {
  const summary = run ? summarizeImport(run) : NO_RUN;
  // `skipStuckRow` leaves a row out with no answer: counted as failed by the run, said here as not confirmed
  const skipped = run?.skipped.size ?? 0;
  const unconfirmed = summary.pending + skipped;
  const notEntered =
    plan.refused.length +
    plan.duplicates.length +
    plan.overLimit.length +
    summary.failed -
    skipped +
    summary.limitReached;
  const existing = plan.existing.length + summary.existing;
  return {
    existing: existingText(existing),
    limitReached: summary.limitReached > 0,
    notEntered: notEnteredText(
      notEntered,
      plan.overLimit.length + summary.limitReached
    ),
    title:
      summary.entered === 0
        ? "Nenhum produto foi importado."
        : `Importamos ${summary.entered} ${plural(summary.entered, "produto", "produtos")}.`,
    unconfirmed:
      unconfirmed === 0
        ? null
        : `${unconfirmed} ${plural(unconfirmed, "linha não foi confirmada", "linhas não foram confirmadas")}: confira na lista de produtos antes de enviar de novo.`,
  };
}

/** Whether a row with a quantity entered: the result says the date of the opening stock. */
export function stockEntered(run: ImportRun): boolean {
  return run.rows.some((row) => {
    const status = run.results.get(row.rowNumber)?.status;
    return (
      row.initialStock !== null &&
      (status === "created" || status === "repeated")
    );
  });
}

/**
 * The date of the opening stock, as the device knows it: the server dates each row by the store's day when it
 * creates it, so the screen names no day; an import that crossed midnight on the device says the day of each row.
 */
export function stockText(sameDay: boolean): string {
  return sameDay
    ? "Estoque de abertura lançado com a data de hoje."
    : "Estoque de abertura lançado com a data do dia em que cada linha entrou.";
}

/**
 * The template to download: only the six columns with the form's labels. No example row: one left in the file would
 * become a product; the step of the file says an example in its text.
 */
export function importTemplateCsv(): string {
  return csvFile(
    IMPORT_COLUMNS.map((column) => IMPORT_COLUMN_LABELS[column]),
    []
  );
}

export type ImportFileRead =
  | { bytes: Uint8Array; kind: "ok" }
  | { kind: "too_large" };

/** The bytes of the file chosen; one past the size of an import is not read at all (the tab would hold it whole). */
export async function readImportFile(
  file: Pick<File, "arrayBuffer" | "size">
): Promise<ImportFileRead> {
  if (file.size > IMPORT_MAX_BYTES) {
    return { kind: "too_large" };
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), kind: "ok" };
}

export type ImportPause =
  /** The connection went: the run stopped after the row on its way. */
  | { kind: "offline" }
  /** "Parar depois desta linha". */
  | { kind: "stopped" }
  /** The server kept failing the same row (tried again by the run, then by the screen). */
  | { kind: "interrupted" }
  /** The bucket of the import kept refusing. */
  | { kind: "rate_limited" }
  /** The server refused the call itself: what the screen says of it. */
  | { kind: "refused"; message: string };

export type ImportStep =
  | { kind: "file" }
  | { kind: "preview" }
  | { kind: "running" }
  /** The regime of the platform (or the tab's own failing sales): the run waits, and goes on by itself at `resumeAt`. */
  | { kind: "paused_busy"; resumeAt: number }
  | { kind: "paused"; pause: ImportPause }
  /** `limit`: the server stopped at the plan's limit (another tab made products after the preview). */
  | { kind: "result"; limit: boolean };

/**
 * What the screen says when the server refused a call of the import: never the words of the form of one product
 * (with rows already in, "O produto não foi alterado." would be false).
 */
function importRefusalMessage(error: unknown): string {
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  return rpcErrorCode(error) === "FORBIDDEN"
    ? "Sua conta não tem acesso a esta loja ou a esta ação."
    : "O servidor recusou o envio.";
}

/** What a stop of the run makes of the step; "continue" when it stopped with no answer and the connection holds. */
export function stepAfter(
  stop: ImportStop,
  abortedFor: "offline" | "stopped" | null,
  online: boolean
): ImportStep | "continue" {
  switch (stop.kind) {
    case "done":
      return { kind: "result", limit: false };
    case "limit_reached":
      return { kind: "result", limit: true };
    case "aborted":
      return {
        kind: "paused",
        pause: { kind: abortedFor === "stopped" ? "stopped" : "offline" },
      };
    case "interrupted":
      return online
        ? "continue"
        : { kind: "paused", pause: { kind: "offline" } };
    case "rate_limited":
      return { kind: "paused", pause: { kind: "rate_limited" } };
    default:
      return {
        kind: "paused",
        pause: { kind: "refused", message: importRefusalMessage(stop.error) },
      };
  }
}
