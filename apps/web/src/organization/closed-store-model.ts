import { localDate } from "@polaris/domain/organization/closure-deadlines";
import {
  type DataExportItem,
  FRESH_SESSION_TEXT,
  type RequestRefusal,
} from "../data-export/data-export-model";
import type { SaleRefusal } from "../lib/organization-closed";
import {
  isDefiniteRpcRejection,
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
export const PANEL_REFRESH_FAILED_TEXT =
  "Não deu para atualizar. O que está na tela é da última leitura.";
export const PANEL_REFRESH_RETRY = "Tentar de novo";
export const PANEL_NOT_FOUND_TEXT =
  "Não encontramos uma loja encerrada nesta conta.";
export const PANEL_OFFLINE_TEXT =
  "Sem conexão. Para baixar seus dados, encerrar ou desfazer o encerramento é preciso internet. Nada fica guardado para depois.";
export const PANEL_CHOOSE_TEXT = "Você tem mais de uma loja encerrada.";
export const PANEL_BACK_HOME = "Voltar ao início";
export const DOWNLOAD_BUTTON = "Baixar meus dados";
export const UNDO_BUTTON = "Desfazer encerramento";
export const UNDO_TITLE = "Desfazer o encerramento?";
export const UNDO_EFFECTS_TEXT =
  "A loja volta a funcionar agora. Os aparelhos vão pedir de novo a permissão para usar sem internet quando abrirem com conexão. O que estava guardado neles e não foi enviado continua esperando.";
export const UNDO_CONFIRM = "Sim, desfazer";
export const UNDO_SENDING = "Desfazendo…";
export const UNDO_BACK = "Voltar";
export const REOPENED_TEXT = "Loja reaberta. Você já pode usar o Polaris.";
export const NEW_STORE_LINK = "Abrir outra loja";
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
  // only a store still closing counts down to the end of the undo: past it (by the server's word) the time is over
  const recoverLeft = daysLeftText(
    store.phase === "closing" && Date.parse(store.recoverUntil) > now
      ? daysUntil(recoverDate, now, tz)
      : -1
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

export type PanelLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "session" }
  | { status: "acceptance" }
  | {
      status: "loaded";
      refreshFailed: boolean;
      stores: readonly ClosedStore[];
    };

/** An Atualizar that fails keeps what was read before: only a failed first read replaces the panel with the error. */
export function loadAfterFailure(
  previous: PanelLoad,
  failure: ReturnType<typeof panelLoadFailure>
): PanelLoad {
  if (failure === "error" && previous.status === "loaded") {
    return { ...previous, refreshFailed: true };
  }
  return { status: failure };
}

/** A new read starts from the last one on screen, failure notice included, so the retry button keeps the focus. */
export function loadWhenReading(previous: PanelLoad, round: number): PanelLoad {
  return previous.status === "loaded" && round > 0
    ? previous
    : { status: "loading" };
}

export type UndoFailure =
  | { kind: "acceptance" }
  | { kind: "session" }
  | { kind: "not_recoverable" }
  | { kind: "said"; text: string };

export const UNDO_WINDOW_OVER_TEXT =
  "O prazo para desfazer acabou. O encerramento não foi desfeito.";
export const UNDO_ALREADY_REOPENED_TEXT =
  "A loja já foi reaberta em outro aparelho.";
export const UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT =
  "O prazo acabou ou a loja já foi reaberta. Toque em Atualizar para ver a situação da loja.";
export const UNDO_OTHER_ACTIVE_TEXT =
  "Não dá para reabrir: você já tem uma loja ativa. Só uma loja ativa por conta.";
export const UNDO_REFUSED_TEXT =
  "O encerramento não foi desfeito. Toque em Atualizar para ver a situação da loja.";
export const UNDO_FRESH_SESSION_TEXT =
  "Por segurança, para desfazer o encerramento é preciso ter entrado há menos de 15 minutos. Saia, entre de novo e desfaça o encerramento. Nada foi alterado.";
export const UNDO_UNKNOWN_TEXT =
  "Não deu para confirmar se o encerramento foi desfeito. Toque em Atualizar para conferir.";

/**
 * What the panel says of an undo that did not answer "recovered". Only a 4xx says nothing was done; any other failure
 * (no answer, a 5xx, a 429) may come after the reopening, so it never says "reaberta" nor "não foi desfeito".
 * `closure_not_recoverable` covers an ended window, a store already active and a store out of "closing": the panel
 * reads the store again and `notRecoverableOutcome` lets the server say which.
 */
export function undoFailure(error: unknown): UndoFailure {
  if (isLegalAcceptanceRefusal(error)) {
    return { kind: "acceptance" };
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return { kind: "session" };
  }
  if (!isDefiniteRpcRejection(error)) {
    return { kind: "said", text: UNDO_UNKNOWN_TEXT };
  }
  const reason = rpcErrorReason(error);
  if (code === "CONFLICT" && reason === "closure_not_recoverable") {
    return { kind: "not_recoverable" };
  }
  if (reason === "fresh_session_required") {
    return { kind: "said", text: UNDO_FRESH_SESSION_TEXT };
  }
  if (code === "CONFLICT" && reason === "another_organization_active") {
    return { kind: "said", text: UNDO_OTHER_ACTIVE_TEXT };
  }
  return { kind: "said", text: UNDO_REFUSED_TEXT };
}

export type NotRecoverableOutcome =
  | { kind: "reopened"; store: null; text: string }
  | { kind: "said"; store: ClosedStore | null; text: string };

/**
 * The phase of a refused undo, from the read made right after it: `undefined` when that read failed, `null` when the
 * server no longer lists the store as closed (it is active again), else the store as the server now describes it.
 */
export function notRecoverableOutcome(
  reread: ClosedStore | null | undefined,
  now: number
): NotRecoverableOutcome {
  if (reread === undefined) {
    return {
      kind: "said",
      store: null,
      text: UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT,
    };
  }
  if (reread === null) {
    return { kind: "reopened", store: null, text: UNDO_ALREADY_REOPENED_TEXT };
  }
  return {
    kind: "said",
    store: reread,
    text: undoOpen(reread, now) ? UNDO_REFUSED_TEXT : UNDO_WINDOW_OVER_TEXT,
  };
}

/** The notices that say the outcome is not known: a warning, not a refusal. */
export function undoOutcomeUnknown(text: string): boolean {
  return (
    text === UNDO_UNKNOWN_TEXT || text === UNDO_NOT_RECOVERABLE_UNKNOWN_TEXT
  );
}

export const DEVICE_CLOSED_LINK = "Ver a loja encerrada";
const DEVICE_CLOSED_REST =
  "A cópia deste aparelho foi apagada; o que não foi enviado continua guardado na fila.";

const DEVICE_COPY_KEPT_REST =
  "O que não foi enviado continua guardado na fila deste aparelho.";

const SALE_NOT_RECORDED =
  "A venda que você acabou de confirmar não foi registrada.";
const SALE_MAYBE_RECORDED =
  "Não deu para saber se a venda que você acabou de confirmar foi registrada. Se uma tentativa anterior chegou ao servidor, ela está na cópia dos seus dados.";
const SALE_QUEUE_REST =
  "A cópia deste aparelho foi apagada. O que já estava na fila continua guardado.";
const SALE_QUEUE_KEPT_REST =
  "O que já estava na fila deste aparelho continua guardado.";
const SALE_CART_KEPT =
  "O carrinho fica guardado aqui e volta em Vender se a loja reabrir. Se você fechar o Polaris, ele se perde.";

/**
 * The notice of a device whose store was closed; without the date while it is not known (or not the user's to read).
 * It says the copy was deleted only once the device confirmed it. When the refusal came back to a sale just confirmed
 * on the server, it says where its cart is and that the sale was not recorded, unless that command had already been
 * sent once with no answer: the refusal comes before the server's replay of a recorded command, so then it only says
 * it could not tell. The sale never entered the queue, which the queue sentence must not suggest.
 */
export function deviceClosedText(
  store: ClosedStore | null,
  copyDropped: boolean,
  saleRefusal: SaleRefusal | null = null
): string {
  const closed = store
    ? `Esta loja foi encerrada em ${dateOf(store.requestedAt, store.timezone)}.`
    : "Esta loja foi encerrada.";
  if (saleRefusal) {
    const queue = copyDropped ? SALE_QUEUE_REST : SALE_QUEUE_KEPT_REST;
    const sale =
      saleRefusal === "maybe_recorded"
        ? SALE_MAYBE_RECORDED
        : SALE_NOT_RECORDED;
    return `${closed} ${sale} ${queue} ${SALE_CART_KEPT}`;
  }
  return `${closed} ${copyDropped ? DEVICE_CLOSED_REST : DEVICE_COPY_KEPT_REST}`;
}
