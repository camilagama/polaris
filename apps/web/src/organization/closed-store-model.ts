import { localDate } from "@polaris/domain/organization/closure-deadlines";
import type {
  DataExportItem,
  RequestRefusal,
} from "../data-export/data-export-model";
import {
  isLegalAcceptanceRefusal,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

export type ClosurePhase =
  | "closing"
  | "closed"
  | "deletion_scheduled"
  | "deletable"
  | "purged";

export type Renewal = "not_handled" | "pending" | "cancelled" | null;

export interface ClosedStore {
  canRecover: boolean;
  deletableFrom: string;
  deletionDate: string;
  exportOpenUntil: string;
  id: string;
  name: string;
  phase: ClosurePhase;
  recoverUntil: string;
  renewal: Renewal;
  requestedAt: string;
  timezone: string;
}

export const PANEL_LOADING_TEXT = "Carregando…";
export const PANEL_LOAD_FAILED_TEXT =
  "Não foi possível carregar os dados da loja. Verifique a conexão e tente de novo.";
export const PANEL_NOT_FOUND_TEXT =
  "Não encontramos uma loja encerrada nesta conta.";
export const PANEL_OFFLINE_TEXT =
  "Sem conexão. Para baixar seus dados, encerrar ou desfazer o encerramento é preciso internet. Nada fica guardado para depois.";
export const PANEL_CHOOSE_TEXT = "Você tem mais de uma loja encerrada.";
export const PANEL_BACK_HOME = "Voltar ao início";
export const DOWNLOAD_BUTTON = "Baixar meus dados";
export const UNDO_BUTTON = "Desfazer encerramento";
export const UNDO_UNAVAILABLE_TEXT =
  "Desfazer o encerramento por aqui ainda não está disponível.";
export const RENEWAL_TERM = "Renovação do plano";

const RENEWAL_TEXT: Readonly<Record<NonNullable<Renewal>, string>> = {
  cancelled: "A renovação do plano foi cancelada.",
  not_handled: "Cancele a renovação no provedor de pagamento.",
  pending: "A renovação do plano está sendo cancelada.",
};
export const RENEWAL_UNKNOWN_TEXT =
  "Não conseguimos confirmar agora a situação da renovação do plano.";

export function renewalText(renewal: Renewal): string {
  return renewal === null ? RENEWAL_UNKNOWN_TEXT : RENEWAL_TEXT[renewal];
}

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

const FIRST_OF_MONTH = /^1 de /;
const DAY_MS = 86_400_000;

function formatCalendarDate(date: string): string {
  return dateFormatter
    .format(new Date(`${date}T12:00:00.000Z`))
    .replace(FIRST_OF_MONTH, "1º de ");
}

function formatTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).format(new Date(instant));
}

function dateOf(instant: string, timeZone: string): string {
  return formatCalendarDate(localDate(new Date(instant), timeZone));
}

function daysUntil(date: string, now: number, timeZone: string): number {
  const today = localDate(new Date(now), timeZone);
  return Math.round(
    (Date.parse(`${date}T00:00:00.000Z`) -
      Date.parse(`${today}T00:00:00.000Z`)) /
      DAY_MS
  );
}

function daysLeftText(days: number): string | null {
  if (days < 0) {
    return null;
  }
  if (days === 0) {
    return "termina hoje";
  }
  return days === 1 ? "falta 1 dia" : `faltam ${days} dias`;
}

function copyLimitText(store: ClosedStore): string {
  return `${formatCalendarDate(store.deletionDate)}, ${formatTime(store.exportOpenUntil, store.timezone)} (horário da sua loja)`;
}

export function copyClosedText(store: ClosedStore): string {
  return `O prazo para pedir uma cópia dos dados terminou em ${copyLimitText(store)}. Depois de apagados, os dados não podem ser recuperados.`;
}

export function copyRequestOpen(store: ClosedStore, now: number): boolean {
  return (
    store.phase !== "purged" &&
    store.phase !== "deletable" &&
    now < Date.parse(store.exportOpenUntil)
  );
}

export function undoOpen(store: ClosedStore, now: number): boolean {
  return (
    store.phase === "closing" &&
    store.canRecover &&
    now < Date.parse(store.recoverUntil)
  );
}

export interface PanelDate {
  left: string;
  term: string;
  value: string;
}

export function panelDates(store: ClosedStore, now: number): PanelDate[] {
  const tz = store.timezone;
  const recoverDate = localDate(new Date(store.recoverUntil), tz);
  const recoverLeft = daysLeftText(
    Date.parse(store.recoverUntil) > now ? daysUntil(recoverDate, now, tz) : -1
  );
  const deletionLeft = daysLeftText(
    Date.parse(store.deletableFrom) > now
      ? daysUntil(store.deletionDate, now, tz)
      : -1
  );
  return [
    {
      left: "",
      term: "Encerrada em",
      value: dateOf(store.requestedAt, tz),
    },
    {
      left: recoverLeft ?? "prazo encerrado",
      term: "Desfazer até",
      value: `${dateOf(store.recoverUntil, tz)}, às ${formatTime(store.recoverUntil, tz)}`,
    },
    {
      left: deletionLeft ?? "já podem ser apagados",
      term: "Dados podem ser apagados a partir de",
      value: formatCalendarDate(store.deletionDate),
    },
  ];
}

export function panelTitle(store: ClosedStore): string {
  return `${store.name} está encerrada`;
}

/**
 * The sentences of the phase, in order. The days left come from the store's calendar against the clock of the device;
 * the dates are the server's. A phase the server still calls `closing` past `recoverUntil` reads as closed: the button
 * is gone too, and the server would refuse the undo.
 */
export function phaseLines(store: ClosedStore, now: number): string[] {
  const tz = store.timezone;
  const requested = dateOf(store.requestedAt, tz);
  const deletion = formatCalendarDate(store.deletionDate);
  const deletionDays = daysLeftText(daysUntil(store.deletionDate, now, tz));
  const deletionWithDays = deletionDays
    ? `${deletion} (${deletionDays})`
    : deletion;
  if (store.phase === "purged") {
    return [
      "Os dados desta loja foram apagados. Não é possível recuperar nem baixar.",
    ];
  }
  if (store.phase === "deletable" || !copyRequestOpen(store, now)) {
    return [
      `Os dados desta loja podem ser apagados a qualquer momento a partir de ${deletion}.`,
      copyClosedText(store),
    ];
  }
  if (store.phase === "deletion_scheduled") {
    return [
      "Os dados desta loja estão marcados para serem apagados em breve. Baixe agora o que precisar.",
      `A partir de ${deletionWithDays} os dados podem ser apagados. Baixe o que precisar antes dessa data.`,
    ];
  }
  if (undoOpen(store, now)) {
    const recover = `${dateOf(store.recoverUntil, tz)}, às ${formatTime(store.recoverUntil, tz)}`;
    const recoverDays = daysLeftText(
      daysUntil(localDate(new Date(store.recoverUntil), tz), now, tz)
    );
    return [
      `Você encerrou esta loja em ${requested}. Até ${recover}${recoverDays ? ` (${recoverDays})` : ""} você pode desfazer o encerramento. Depois disso não dá mais.`,
      `Seus dados ficam guardados. A partir de ${deletion} eles podem ser apagados. Baixe o que precisar antes dessa data.`,
    ];
  }
  return [
    "O prazo para desfazer acabou. Não dá mais para reabrir esta loja.",
    `A partir de ${deletionWithDays} os dados podem ser apagados. Baixe o que precisar antes dessa data.`,
  ];
}

export function justClosedText(store: ClosedStore): string {
  return `Loja encerrada. Você pode desfazer até ${dateOf(store.recoverUntil, store.timezone)}, às ${formatTime(store.recoverUntil, store.timezone)}. Seus dados ficam guardados e você pode baixá-los.`;
}

export function closedStoreExports(
  exports: readonly (DataExportItem & { mode: "active" | "closed" })[]
): DataExportItem[] {
  return exports
    .filter((item) => item.mode === "closed")
    .map(({ mode: _mode, ...item }) => item);
}

export function closedExportFileHref(
  exportId: string,
  ordinal: number
): string {
  return `/api/closed-exports/${encodeURIComponent(exportId)}/files/${ordinal}`;
}

export const FRESH_SESSION_TEXT =
  "Por segurança, para pedir a cópia é preciso ter entrado no Polaris há menos de 15 minutos. Saia, entre de novo e peça a cópia.";
export function closedRequestRefusal(
  error: unknown,
  store: ClosedStore
): RequestRefusal | null {
  const reason = rpcErrorReason(error);
  if (reason === "fresh_session_required") {
    return { repeatsNow: false, text: FRESH_SESSION_TEXT };
  }
  if (reason === "closed_export_unavailable") {
    return { repeatsNow: true, text: copyClosedText(store) };
  }
  return null;
}

export function panelLoadFailure(
  error: unknown
): "session" | "acceptance" | "error" {
  if (isLegalAcceptanceRefusal(error)) {
    return "acceptance";
  }
  return rpcErrorCode(error) === "UNAUTHORIZED" ? "session" : "error";
}
