import type { PolarisRpcClient } from "@polaris/contracts";
import {
  CANCEL_SALE_COMMAND_VERSION,
  type CancellationReasonCode,
  MAX_CANCELLATION_NOTE_CODE_POINTS,
  normalizeCancelSaleCommand,
} from "@polaris/domain/sales/sale-cancellation";
import {
  isDefiniteRejection,
  rpcErrorCode,
  rpcErrorReason,
} from "./sale-form-model";

type CancelSaleRequest = Parameters<PolarisRpcClient["sale"]["cancel"]>[0];
export type CancelSaleResult = Awaited<
  ReturnType<PolarisRpcClient["sale"]["cancel"]>
>;

export const CANCELLATION_REASONS: ReadonlyArray<
  readonly [CancellationReasonCode, string]
> = [
  ["customer_request", "Cliente desistiu"],
  ["entry_error", "Erro de lançamento"],
  ["payment_issue", "Problema no pagamento"],
  ["other", "Outro"],
];

const reasonLabels = new Map<string, string>(CANCELLATION_REASONS);

/** A message for the page after the sale changed (or may have changed) on the server. */
export interface SaleNotice {
  message: string;
  ok: boolean;
}

export const CANCELLATION_EXPLANATION =
  "Cancelar registra um cancelamento: a venda confirmada e os dados dela são preservados, sem edição. O estoque volta item a item, pelo custo registrado em cada item. O cancelamento não pode ser desfeito.";

/** Label of a stored reason code; a missing code means none was informed. */
export function cancellationReasonLabel(code: string | null): string {
  return code === null
    ? "Sem motivo informado"
    : (reasonLabels.get(code) ?? "Motivo desconhecido");
}

/* -------------------------------------------------------------------------- */
/* Draft and validation                                                       */
/* -------------------------------------------------------------------------- */

export interface CancelDraft {
  reasonCode: CancellationReasonCode | "";
  reasonNote: string;
}

export interface CancelDraftErrors {
  note?: string;
  reason?: string;
}

interface CancelInput {
  reasonCode: CancellationReasonCode | null;
  reasonNote: string | null;
}

function noteLength(note: string): number {
  return [...note.trim()].length;
}

/** The note counter shown next to the field, in code points. */
export function noteCounterText(draft: CancelDraft): string {
  return `${noteLength(draft.reasonNote)}/${MAX_CANCELLATION_NOTE_CODE_POINTS}`;
}

/**
 * The reason is optional; the note is optional for classified reasons,
 * required for "Outro", and not allowed without a reason.
 */
export function validateCancelDraft(draft: CancelDraft): {
  errors: CancelDraftErrors;
  input: CancelInput | null;
} {
  const errors: CancelDraftErrors = {};
  const note = draft.reasonNote.trim();
  if (noteLength(note) > MAX_CANCELLATION_NOTE_CODE_POINTS) {
    errors.note = `A observação pode ter até ${MAX_CANCELLATION_NOTE_CODE_POINTS} caracteres.`;
  } else if (draft.reasonCode === "other" && note === "") {
    errors.note = "Descreva o motivo em “Outro”.";
  }
  if (draft.reasonCode === "" && note !== "") {
    errors.reason = "Escolha um motivo para registrar uma observação.";
  }
  if (errors.note || errors.reason) {
    return { errors, input: null };
  }
  return {
    errors,
    input: {
      reasonCode: draft.reasonCode === "" ? null : draft.reasonCode,
      reasonNote: note === "" ? null : note,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface OperationFailure {
  /** The attempt cannot be resent as is: the next confirm gets a fresh one. */
  discardAttempt: boolean;
  message: string;
  reason: string | null;
  /** The sale changed on the server: reload its detail. */
  reloadDetail: boolean;
  /** Network, 5xx or unknown error: the operation may already be registered. */
  unknownOutcome: boolean;
}

export interface ReasonOutcome {
  discardAttempt?: boolean;
  message: string;
  reloadDetail?: boolean;
}

const productGoneMessage =
  "Um produto desta venda foi removido; o estoque não pode ser devolvido. Nada foi alterado.";

const reasonOutcomes = new Map<string, ReasonOutcome>([
  [
    "sale_already_cancelled",
    {
      message:
        "Esta venda já foi cancelada. Recarregamos os dados para mostrar o cancelamento registrado.",
      reloadDetail: true,
    },
  ],
  [
    "sale_cancellation_command_conflict",
    {
      discardAttempt: true,
      message:
        "Esta tentativa já tinha sido usada com outro conteúdo. Uma nova tentativa será criada automaticamente; revise e confirme de novo.",
    },
  ],
  [
    "sale_has_returns",
    {
      message:
        "Esta venda já tem devoluções e não pode ser cancelada por inteiro. Recarregamos os dados para mostrar as devoluções.",
      reloadDetail: true,
    },
  ],
  ["sale_product_unavailable", { message: productGoneMessage }],
  ["product_deleted", { message: productGoneMessage }],
  [
    "sale_not_found",
    {
      message:
        "Esta venda não foi encontrada nesta organização. Confira o identificador da venda.",
    },
  ],
  [
    "invalid_sale_cancellation",
    {
      message:
        "O motivo ou a observação foram recusados. Revise: “Outro” exige uma observação, de até 500 caracteres.",
    },
  ],
]);

export function operationFailure(
  message: string,
  options: {
    discardAttempt?: boolean;
    reason?: string | null;
    reloadDetail?: boolean;
    unknownOutcome?: boolean;
  } = {}
): OperationFailure {
  return {
    discardAttempt: options.discardAttempt ?? false,
    message,
    reason: options.reason ?? null,
    reloadDetail: options.reloadDetail ?? false,
    unknownOutcome: options.unknownOutcome ?? false,
  };
}

function genericOperationFailure(code: string | undefined): OperationFailure {
  switch (code) {
    case "UNAUTHORIZED":
      return operationFailure(
        "Sua sessão não está ativa. Entre novamente para continuar; os dados continuam no formulário."
      );
    case "FORBIDDEN":
      return operationFailure(
        "Sua conta não tem acesso a esta organização ou ação."
      );
    case "BAD_REQUEST":
      return operationFailure(
        "O servidor recusou o pedido. Revise os dados e tente de novo."
      );
    case "NOT_FOUND":
      return operationFailure(
        "A venda não existe nesta organização. Atualize os dados e tente de novo.",
        { reloadDetail: true }
      );
    default:
      return operationFailure(
        "O estado da venda mudou. Recarregamos os dados; revise e tente de novo.",
        { reloadDetail: true }
      );
  }
}

/**
 * Maps an oRPC error. A 4xx answer is definite and keeps editing open; network,
 * 5xx and unknown errors may have taken effect and lock the attempt. A known
 * `data.reason` on a 400/404/409 refines the generic per-code message.
 */
export function mapOperationError(
  error: unknown,
  outcomes: ReadonlyMap<string, ReasonOutcome>,
  unknownMessage: string
): OperationFailure {
  if (!isDefiniteRejection(error)) {
    return operationFailure(unknownMessage, { unknownOutcome: true });
  }
  const code = rpcErrorCode(error);
  const refinable =
    code === "BAD_REQUEST" || code === "NOT_FOUND" || code === "CONFLICT";
  const reason = refinable ? (rpcErrorReason(error) ?? null) : null;
  const outcome = reason === null ? undefined : outcomes.get(reason);
  if (outcome) {
    return operationFailure(outcome.message, {
      discardAttempt: outcome.discardAttempt ?? false,
      reason,
      reloadDetail: outcome.reloadDetail ?? false,
    });
  }
  return { ...genericOperationFailure(code), reason };
}

export function mapCancelError(error: unknown): OperationFailure {
  return mapOperationError(
    error,
    reasonOutcomes,
    "Não foi possível confirmar se o cancelamento foi registrado. O cancelamento ficou bloqueado para edição. Use “Tentar novamente (seguro)”: o mesmo pedido é reenviado e o servidor não cancela nem devolve o estoque duas vezes."
  );
}

/* -------------------------------------------------------------------------- */
/* Flow state                                                                 */
/* -------------------------------------------------------------------------- */

type CancelStep = "closed" | "confirming" | "editing";

export interface OperationAttempt {
  commandId: string;
  signature: string;
}

export type OperationSubmission =
  | { phase: "idle" }
  | { phase: "submitting" }
  /** A definite failure: nothing was cancelled; editing stays open. */
  | { failure: OperationFailure; phase: "failed" }
  /** Unknown outcome: the form is locked on this attempt. */
  | { confirmingDiscard: boolean; failure: OperationFailure; phase: "locked" }
  | { message: string; phase: "success"; replayed: boolean };

export interface CancelState {
  attempt: OperationAttempt | null;
  draft: CancelDraft;
  showErrors: boolean;
  step: CancelStep;
  submission: OperationSubmission;
}

export function initialCancelState(): CancelState {
  return {
    attempt: null,
    draft: { reasonCode: "", reasonNote: "" },
    showErrors: false,
    step: "closed",
    submission: { phase: "idle" },
  };
}

function isCancelSubmitting(state: CancelState): boolean {
  return state.submission.phase === "submitting";
}

/** True while editing is not allowed: in flight, or an unknown outcome. */
export function isCancelLocked(state: CancelState): boolean {
  return (
    state.submission.phase === "submitting" ||
    state.submission.phase === "locked"
  );
}

export function openCancel(state: CancelState): CancelState {
  return isCancelLocked(state) || state.step !== "closed"
    ? state
    : { ...state, showErrors: false, step: "editing" };
}

/** Closing abandons the draft; it is not possible while locked. */
export function closeCancel(state: CancelState): CancelState {
  return isCancelLocked(state) ? state : initialCancelState();
}

/** Clearing the reason also clears the note, which is not allowed without it. */
export function editCancelReason(
  state: CancelState,
  reasonCode: CancellationReasonCode | ""
): CancelState {
  if (isCancelLocked(state) || state.step !== "editing") {
    return state;
  }
  return {
    ...state,
    draft: {
      reasonCode,
      reasonNote: reasonCode === "" ? "" : state.draft.reasonNote,
    },
  };
}

export function editCancelNote(
  state: CancelState,
  reasonNote: string
): CancelState {
  if (isCancelLocked(state) || state.step !== "editing") {
    return state;
  }
  return { ...state, draft: { ...state.draft, reasonNote } };
}

/** Field errors to show: format errors always, required ones after a review try. */
export function visibleCancelErrors(state: CancelState): CancelDraftErrors {
  const { errors } = validateCancelDraft(state.draft);
  if (state.showErrors) {
    return errors;
  }
  const tooLong =
    noteLength(state.draft.reasonNote) > MAX_CANCELLATION_NOTE_CODE_POINTS;
  return tooLong && errors.note ? { note: errors.note } : {};
}

/** First step: validates the draft and moves to the confirmation step. */
export function reviewCancel(state: CancelState): CancelState {
  if (isCancelLocked(state) || state.step !== "editing") {
    return state;
  }
  return validateCancelDraft(state.draft).input === null
    ? { ...state, showErrors: true }
    : { ...state, showErrors: false, step: "confirming" };
}

export function backToCancelEditing(state: CancelState): CancelState {
  return isCancelLocked(state) || state.step !== "confirming"
    ? state
    : { ...state, step: "editing" };
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A repeat of an identical payload keeps the command ID, so the server replays
 * it; any edit gives a fresh one.
 */
export function resolveOperationAttempt(
  previous: OperationAttempt | null,
  signature: string,
  createId: () => string
): OperationAttempt {
  return previous !== null && previous.signature === signature
    ? previous
    : { commandId: createId(), signature };
}

export type PreparedCancel =
  | { ok: true; request: CancelSaleRequest; state: CancelState }
  | { ok: false; state: CancelState };

function rejected(state: CancelState, message: string): PreparedCancel {
  return {
    ok: false,
    state: {
      ...state,
      submission: { failure: operationFailure(message), phase: "failed" },
    },
  };
}

/**
 * Builds the single cancel request and marks it in flight. It runs from the
 * confirmation step, or as a retry of a locked attempt. A second start while a
 * request is in flight is refused.
 */
export function prepareCancelSubmission(input: {
  createId: () => string;
  organizationId: string;
  saleId: string;
  state: CancelState;
}): PreparedCancel {
  const { state } = input;
  const retrying = state.submission.phase === "locked";
  if (isCancelSubmitting(state) || !(retrying || state.step === "confirming")) {
    return { ok: false, state };
  }
  const { input: draftInput } = validateCancelDraft(state.draft);
  if (draftInput === null) {
    return rejected(state, "Revise o motivo e a observação do cancelamento.");
  }
  const attempt = resolveOperationAttempt(
    state.attempt,
    JSON.stringify({
      organizationId: input.organizationId,
      reasonCode: draftInput.reasonCode,
      reasonNote: draftInput.reasonNote,
      saleId: input.saleId,
    }),
    input.createId
  );
  try {
    normalizeCancelSaleCommand({
      commandId: attempt.commandId,
      commandVersion: CANCEL_SALE_COMMAND_VERSION,
      reasonCode: draftInput.reasonCode,
      reasonNote: draftInput.reasonNote,
      saleId: input.saleId,
    });
  } catch {
    return rejected(
      state,
      "Os dados do cancelamento não passaram na validação final. Revise o motivo e a observação."
    );
  }
  return {
    ok: true,
    request: {
      commandId: attempt.commandId,
      commandVersion: CANCEL_SALE_COMMAND_VERSION,
      organizationId: input.organizationId,
      reasonCode: draftInput.reasonCode,
      reasonNote: draftInput.reasonNote,
      saleId: input.saleId,
    },
    state: { ...state, attempt, submission: { phase: "submitting" } },
  };
}

export function cancelSuccessMessage(result: CancelSaleResult): string {
  const count = result.restocked.length;
  return result.replayed
    ? "Esta venda já havia sido cancelada com este mesmo pedido. Nada foi duplicado."
    : `Venda cancelada. O estoque foi devolvido item a item (${count} ${count === 1 ? "item" : "itens"}).`;
}

export function cancelSucceeded(result: CancelSaleResult): CancelState {
  return {
    ...initialCancelState(),
    submission: {
      message: cancelSuccessMessage(result),
      phase: "success",
      replayed: result.replayed,
    },
  };
}

/** A definite failure reopens editing; an unknown outcome locks the attempt. */
export function cancelFailed(state: CancelState, error: unknown): CancelState {
  const failure = mapCancelError(error);
  if (failure.unknownOutcome) {
    return {
      ...state,
      submission: { confirmingDiscard: false, failure, phase: "locked" },
    };
  }
  return {
    ...state,
    attempt: failure.discardAttempt ? null : state.attempt,
    step: "editing",
    submission: { failure, phase: "failed" },
  };
}

/** First step of discarding a locked attempt: only asks for confirmation. */
export function requestDiscardCancel(state: CancelState): CancelState {
  return state.submission.phase === "locked"
    ? { ...state, submission: { ...state.submission, confirmingDiscard: true } }
    : state;
}

export function cancelDiscardCancel(state: CancelState): CancelState {
  return state.submission.phase === "locked"
    ? {
        ...state,
        submission: { ...state.submission, confirmingDiscard: false },
      }
    : state;
}

/**
 * Second step: abandons the locked attempt. Returns null unless the operator
 * already saw and accepted the confirmation step.
 */
export function discardLockedCancel(state: CancelState): CancelState | null {
  return state.submission.phase === "locked" &&
    state.submission.confirmingDiscard
    ? initialCancelState()
    : null;
}

export function cancelSubmitLabel(state: CancelState): string {
  if (isCancelSubmitting(state)) {
    return "Cancelando…";
  }
  return state.submission.phase === "locked"
    ? "Tentar novamente (seguro)"
    : "Confirmar cancelamento";
}
