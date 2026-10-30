import {
  isConnectionFailure,
  isPlatformCut,
  isLegalAcceptanceRefusal,
  legalAcceptanceMessage,
  readErrorMessage,
  rpcErrorCode,
  rpcErrorReason,
  unconfirmedWriteFaultMessage,
} from "../lib/rpc-error";

export type ExportFormat = "json" | "csv" | "images";
type ExportStatus = "requested" | "running" | "ready" | "failed" | "expired";

/**
 * One copy as `dataExport.list` gives it. The closed store's list (`dataExport.listClosed`) has the same fields and one
 * more, so its items fit here too.
 */
export interface DataExportItem {
  errorCode: string | null;
  expiresAt: string | null;
  files: readonly { name: string; ordinal: number; sizeBytes: number }[];
  formats: readonly ExportFormat[];
  id: string;
  requestedAt: string;
  status: ExportStatus;
}

/** In the order of the screen. */
export const EXPORT_FORMAT_OPTIONS: readonly {
  label: string;
  value: ExportFormat;
}[] = [
  { label: "Dados em JSON", value: "json" },
  { label: "Dados em planilha (CSV)", value: "csv" },
  { label: "Imagens dos produtos", value: "images" },
];

/** The images make a copy many times bigger, and with too many it fails: they are asked for, never assumed. */
export const DEFAULT_EXPORT_FORMATS: readonly ExportFormat[] = ["json", "csv"];

export const EXPORT_SUPPORT_TEXT =
  "A cópia leva até uma hora para ficar pronta e fica disponível por 24 horas. Ela tem dados pessoais dos seus clientes: guarde com cuidado.";
export const NO_EXPORT_PERMISSION_TEXT =
  "Só o dono da loja pode pedir e baixar a cópia dos dados.";
export const NO_FORMAT_TEXT = "Marque pelo menos um formato.";
export const PREPARING_TEXT =
  "Preparando sua cópia. Pode levar até uma hora. Você pode sair e voltar.";
export const EXPIRED_TEXT = "Esta cópia expirou. Peça outra.";
export const FAILED_TEXT = "Não foi possível preparar a cópia. Peça de novo.";
export const TOO_LARGE_TEXT =
  "Sua loja é grande demais para uma cópia com imagens. Peça só os dados (JSON ou planilha).";
export const LIMIT_REACHED_TEXT =
  "Você já pediu 3 cópias nas últimas 24 horas. Tente de novo mais tarde.";
export const ALREADY_RUNNING_TEXT =
  "Já há uma cópia sendo preparada. Espere ela ficar pronta.";
export const REQUEST_UNCONFIRMED_TEXT =
  "O pedido não foi confirmado. Pode ter sido feito: toque em Atualizar antes de repetir.";
export const REQUEST_FAILED_TEXT =
  "Não foi possível pedir a cópia. Tente de novo.";
export const REQUEST_DONE_TEXT =
  "Cópia pedida. Preparando: pode levar até uma hora. Você pode sair e voltar.";
export const NO_EXPORTS_TEXT = "Nenhuma cópia pedida ainda.";

/** What the form says before anything leaves: null when it may send. */
export function formatsProblem(
  formats: readonly ExportFormat[]
): string | null {
  return formats.length === 0 ? NO_FORMAT_TEXT : null;
}

/** The formats in the order the contract and the screen use, each once. */
export function orderedFormats(
  formats: Iterable<ExportFormat>
): ExportFormat[] {
  const chosen = new Set(formats);
  return EXPORT_FORMAT_OPTIONS.map((option) => option.value).filter((value) =>
    chosen.has(value)
  );
}

const SHORT_FORMAT_NAMES: Record<ExportFormat, string> = {
  csv: "planilha",
  images: "imagens",
  json: "JSON",
};

/** The formats of a copy in the list: "JSON, planilha e imagens"; the long labels stay on the request's boxes. */
function shortFormats(formats: readonly ExportFormat[]): string {
  const names = orderedFormats(formats).map(
    (value) => SHORT_FORMAT_NAMES[value]
  );
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

const KB = 1000;
const MB = 1_000_000;

/** A size the way the screen writes it: "820 KB", "1,2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < MB) {
    return `${Math.max(1, Math.round(bytes / KB))} KB`;
  }
  return `${(bytes / MB).toFixed(1).replace(".", ",")} MB`;
}

function instantIn(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const parts = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

type ExportViewKind =
  | "preparing"
  | "ready"
  | "expired"
  | "failed"
  | "too_large";

interface ExportFileView {
  label: string;
  ordinal: number;
}

export interface ExportView {
  files: readonly ExportFileView[];
  /** What was asked for, in short: "JSON e planilha". */
  formats: string;
  id: string;
  kind: ExportViewKind;
  requested: string;
  text: string;
}

/**
 * What the screen says of one copy at `now`. "Pronta" only with `status = ready` and before its expiry: past it the
 * server answers the download with a 404, so the copy reads as expired before the hourly job says it. The `errorCode`
 * only picks the text, never shows.
 */
export function exportView(
  item: DataExportItem,
  now: number,
  timeZone: string
): ExportView {
  const base = {
    formats: shortFormats(item.formats),
    id: item.id,
    requested: `Pedida em ${instantIn(item.requestedAt, timeZone)}`,
  };
  const expiresAt =
    item.expiresAt === null ? Number.NaN : Date.parse(item.expiresAt);
  if (item.status === "ready" && expiresAt > now && item.files.length > 0) {
    return {
      ...base,
      files: [...item.files]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((file) => ({
          label: `Baixar ${file.name} (${formatFileSize(file.sizeBytes)})`,
          ordinal: file.ordinal,
        })),
      kind: "ready",
      text: `Sua cópia está pronta. Baixe até ${instantIn(item.expiresAt as string, timeZone)}.`,
    };
  }
  if (item.status === "ready" || item.status === "expired") {
    return { ...base, files: [], kind: "expired", text: EXPIRED_TEXT };
  }
  if (item.status === "failed") {
    const tooLarge =
      item.errorCode === "export_too_large" && item.formats.includes("images");
    return {
      ...base,
      files: [],
      kind: tooLarge ? "too_large" : "failed",
      text: tooLarge ? TOO_LARGE_TEXT : FAILED_TEXT,
    };
  }
  return { ...base, files: [], kind: "preparing", text: PREPARING_TEXT };
}

/** The route that streams a file of a copy (ADR 0078); the store is context the server checks again. */
export function exportFileHref(
  exportId: string,
  ordinal: number,
  organizationId: string
): string {
  const query = new URLSearchParams({ organizationId });
  return `/api/data-exports/${encodeURIComponent(exportId)}/files/${ordinal}?${query.toString()}`;
}

/** Any 5xx: the Worker may have failed after the COMMIT, so the request is in doubt whatever the reason says. */
function serverFault(error: unknown): boolean {
  const { status } = (error ?? {}) as { status?: unknown };
  return typeof status === "number" && status >= 500;
}

export const FRESH_SESSION_TEXT =
  "Por segurança, para pedir a cópia é preciso ter entrado no Polaris há menos de 15 minutos. Saia, entre de novo e peça a cópia.";

export interface RequestRefusal {
  /** Asking again now would only be refused the same way: the button stays off until the list is read again. */
  repeatsNow: boolean;
  text: string;
}

/**
 * What a refused or unanswered `dataExport.request` says. No answer, the cut of the platform and the Worker's own 503
 * may come after the request was saved: the text says so and asks for Atualizar, never "não foi feito".
 */
export function requestRefusal(error: unknown): RequestRefusal {
  if (
    isConnectionFailure(error) ||
    isPlatformCut(error) ||
    unconfirmedWriteFaultMessage(error) !== undefined ||
    serverFault(error)
  ) {
    return { repeatsNow: false, text: REQUEST_UNCONFIRMED_TEXT };
  }
  const reason = rpcErrorReason(error);
  if (reason === "fresh_session_required") {
    return { repeatsNow: false, text: FRESH_SESSION_TEXT };
  }
  if (reason === "export_limit_reached") {
    return { repeatsNow: true, text: LIMIT_REACHED_TEXT };
  }
  if (reason === "export_already_running") {
    return { repeatsNow: true, text: ALREADY_RUNNING_TEXT };
  }
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return { repeatsNow: false, text: unaccepted };
  }
  if (rpcErrorCode(error) === "FORBIDDEN") {
    return { repeatsNow: false, text: NO_EXPORT_PERMISSION_TEXT };
  }
  return { repeatsNow: false, text: REQUEST_FAILED_TEXT };
}

/** What a failed read of the list says. */
export function listRefusal(error: unknown): string {
  if (rpcErrorCode(error) === "FORBIDDEN" && !isLegalAcceptanceRefusal(error)) {
    return NO_EXPORT_PERMISSION_TEXT;
  }
  return readErrorMessage(error, "suas cópias");
}
