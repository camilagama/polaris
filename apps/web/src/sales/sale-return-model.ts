import type { PolarisRpcClient, SaleDetailReadModel } from "@polaris/contracts";
import {
  MAX_RETURN_NOTE_CODE_POINTS,
  normalizeReturnSaleCommand,
  RETURN_SALE_COMMAND_VERSION,
  type ReturnReasonCode,
} from "@polaris/domain/sales/sale-return";
import {
  mapOperationError,
  type OperationAttempt,
  type OperationFailure,
  type OperationSubmission,
  operationFailure,
  type ReasonOutcome,
  resolveOperationAttempt,
} from "./sale-cancellation-model";

type ReturnSaleRequest = Parameters<PolarisRpcClient["sale"]["return"]>[0];
export type ReturnSaleResult = Awaited<
  ReturnType<PolarisRpcClient["sale"]["return"]>
>;
type ReturnSummaryLine = SaleDetailReadModel["returnSummary"][number];

export const RETURN_REASONS: ReadonlyArray<
  readonly [ReturnReasonCode, string]
> = [
  ["customer_request", "Cliente desistiu"],
  ["defective", "Item com defeito"],
  ["wrong_item", "Item errado"],
  ["other", "Outro"],
];

const reasonLabels = new Map<string, string>(RETURN_REASONS);

export const RETURN_EXPLANATION =
  "Uma devolução é um registro à parte: a venda confirmada não é alterada. O estoque volta apenas nas quantidades de “Volta ao estoque”, pelo custo registrado em cada item. O Polaris não processa reembolsos nem registra valores devolvidos; o valor das devoluções é tratado depois.";

export function returnReasonLabel(code: string | null): string {
  return code === null
    ? "Sem motivo informado"
    : (reasonLabels.get(code) ?? "Motivo desconhecido");
}

/* -------------------------------------------------------------------------- */
/* Table of what can still be returned                                        */
/* -------------------------------------------------------------------------- */

export interface ReturnTableRow {
  available: number;
  label: string;
  position: number;
  restocked: number;
  returned: number;
  sold: number;
}

/** One row per sold item, with what was returned and what can still be. */
export function returnTableRows(
  summary: readonly ReturnSummaryLine[],
  labels: ReadonlyMap<number, string>
): ReturnTableRow[] {
  return [...summary]
    .sort((left, right) => left.position - right.position)
    .map((line) => ({
      available: line.availableToReturn,
      label: labels.get(line.position) ?? `Item ${line.position + 1}`,
      position: line.position,
      restocked: line.restockedQuantity,
      returned: line.returnedQuantity,
      sold: line.sold,
    }));
}

export function totalAvailable(rows: readonly ReturnTableRow[]): number {
  return rows.reduce((total, row) => total + row.available, 0);
}

/** Changes whenever what is available changes, so a stale draft is not kept. */
export function returnPanelKey(rows: readonly ReturnTableRow[]): string {
  return rows.map((row) => `${row.position}:${row.available}`).join("|");
}

/* -------------------------------------------------------------------------- */
/* Draft and validation                                                       */
/* -------------------------------------------------------------------------- */

export interface ReturnLineDraft {
  available: number;
  label: string;
  position: number;
  restocked: string;
  /** Once the operator edits it, it no longer follows the returned quantity. */
  restockedTouched: boolean;
  returned: string;
}

export interface ReturnDraft {
  lines: ReturnLineDraft[];
  reasonCode: ReturnReasonCode | "";
  reasonNote: string;
}

interface ReturnLineErrors {
  restocked?: string;
  returned?: string;
}

export interface ReturnDraftErrors {
  items?: string;
  lines: Record<number, ReturnLineErrors>;
  note?: string;
  reason?: string;
}

export interface ReturnInput {
  items: Array<{
    position: number;
    restockedQuantity: number;
    returnedQuantity: number;
  }>;
  reasonCode: ReturnReasonCode | null;
  reasonNote: string | null;
}

const countPattern = /^\d{1,10}$/;

function parseCount(text: string): number | null {
  const trimmed = text.trim();
  return countPattern.test(trimmed) ? Number(trimmed) : null;
}

function noteLength(note: string): number {
  return [...note.trim()].length;
}

export function returnNoteCounterText(draft: ReturnDraft): string {
  return `${noteLength(draft.reasonNote)}/${MAX_RETURN_NOTE_CODE_POINTS}`;
}

function validateLine(line: ReturnLineDraft): {
  errors: ReturnLineErrors;
  item: ReturnInput["items"][number] | null;
  skipped: boolean;
} {
  const returnedText = line.returned.trim();
  const restockedText = line.restocked.trim();
  if (returnedText === "" && !(line.restockedTouched && restockedText !== "")) {
    return { errors: {}, item: null, skipped: true };
  }
  const errors: ReturnLineErrors = {};
  const returned = returnedText === "" ? null : parseCount(returnedText);
  if (returned === null || returned < 1 || returned > line.available) {
    errors.returned =
      returnedText === ""
        ? "Informe quantos foram devolvidos."
        : `Use um número inteiro de 1 a ${line.available}.`;
  }
  const restocked = restockedText === "" ? null : parseCount(restockedText);
  if (restocked === null || (returned !== null && restocked > returned)) {
    errors.restocked =
      restockedText === ""
        ? "Informe quantos voltam ao estoque (0 se nenhum)."
        : "Use um número inteiro de 0 até a quantidade devolvida.";
  }
  if (
    errors.returned ||
    errors.restocked ||
    returned === null ||
    restocked === null
  ) {
    return { errors, item: null, skipped: false };
  }
  return {
    errors,
    item: {
      position: line.position,
      restockedQuantity: restocked,
      returnedQuantity: returned,
    },
    skipped: false,
  };
}

/**
 * Per line, the returned quantity runs from 1 to what is still available and
 * the restocked one from 0 to the returned quantity. A line left blank is not
 * part of the return; at least one line is needed. The reason is optional, the
 * note is required only for "Outro" and not allowed without a reason.
 */
export function validateReturnDraft(draft: ReturnDraft): {
  errors: ReturnDraftErrors;
  input: ReturnInput | null;
} {
  const errors: ReturnDraftErrors = { lines: {} };
  const items: ReturnInput["items"] = [];
  let anyInvalid = false;
  for (const line of draft.lines) {
    const result = validateLine(line);
    if (result.item) {
      items.push(result.item);
    } else if (!result.skipped) {
      errors.lines[line.position] = result.errors;
      anyInvalid = true;
    }
  }
  if (items.length === 0 && !anyInvalid) {
    errors.items = "Informe a quantidade devolvida de pelo menos um item.";
  }
  const note = draft.reasonNote.trim();
  if (noteLength(note) > MAX_RETURN_NOTE_CODE_POINTS) {
    errors.note = `A observação pode ter até ${MAX_RETURN_NOTE_CODE_POINTS} caracteres.`;
  } else if (draft.reasonCode === "other" && note === "") {
    errors.note = "Descreva o motivo em “Outro”.";
  }
  if (draft.reasonCode === "" && note !== "") {
    errors.reason = "Escolha um motivo para registrar uma observação.";
  }
  const valid =
    !(anyInvalid || errors.items || errors.note || errors.reason) &&
    items.length > 0;
  return {
    errors,
    input: valid
      ? {
          items,
          reasonCode: draft.reasonCode === "" ? null : draft.reasonCode,
          reasonNote: note === "" ? null : note,
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

const returnProductGoneMessage =
  "Um produto desta venda foi removido; as unidades devolvidas dele não podem voltar ao estoque. Registre 0 em “Volta ao estoque” para esse item e tente de novo.";

const reasonOutcomes = new Map<string, ReasonOutcome>([
  [
    "sale_return_exceeds_available",
    {
      message:
        "Uma das quantidades está acima do disponível para devolução. Recarregamos os dados; ajuste as quantidades e tente de novo.",
      reloadDetail: true,
    },
  ],
  [
    "sale_not_returnable",
    {
      message:
        "Esta venda foi cancelada e não pode receber devoluções. Recarregamos os dados.",
      reloadDetail: true,
    },
  ],
  [
    "sale_return_command_conflict",
    {
      discardAttempt: true,
      message:
        "Esta tentativa já tinha sido usada com outro conteúdo. Uma nova tentativa será criada automaticamente; revise e confirme de novo.",
    },
  ],
  [
    "stock_command_conflict",
    {
      discardAttempt: true,
      message:
        "Este identificador de tentativa já foi usado em outra operação de estoque. Uma nova tentativa será criada automaticamente; revise e confirme de novo.",
    },
  ],
  [
    "inventory_quantity_limit",
    {
      message:
        "O estoque deste item chegaria acima do limite permitido. Registre uma volta ao estoque menor (ou 0) para esse item e tente de novo.",
    },
  ],
  ["sale_product_unavailable", { message: returnProductGoneMessage }],
  ["product_deleted", { message: returnProductGoneMessage }],
  [
    "invalid_sale_return",
    {
      message:
        "A devolução foi recusada. Confira as quantidades (devolvido de 1 até o disponível; volta ao estoque de 0 até o devolvido), o motivo e a observação.",
    },
  ],
  [
    "sale_not_found",
    {
      message:
        "Esta venda não foi encontrada nesta loja. Confira o identificador da venda.",
    },
  ],
]);

/** Network, 5xx and unknown errors lock the attempt; 4xx keep editing open. */
export function mapReturnError(error: unknown): OperationFailure {
  return mapOperationError(
    error,
    reasonOutcomes,
    "Não foi possível confirmar se a devolução foi registrada. A devolução ficou bloqueada para edição. Use “Tentar novamente (seguro)”: o mesmo pedido é reenviado e o servidor não registra nem devolve o estoque duas vezes."
  );
}

/* -------------------------------------------------------------------------- */
/* Flow state                                                                 */
/* -------------------------------------------------------------------------- */

type ReturnStep = "closed" | "confirming" | "editing";

export interface ReturnState {
  attempt: OperationAttempt | null;
  draft: ReturnDraft;
  showErrors: boolean;
  step: ReturnStep;
  submission: OperationSubmission;
}

export function initialReturnState(): ReturnState {
  return {
    attempt: null,
    draft: { lines: [], reasonCode: "", reasonNote: "" },
    showErrors: false,
    step: "closed",
    submission: { phase: "idle" },
  };
}

export function isReturnLocked(state: ReturnState): boolean {
  return (
    state.submission.phase === "submitting" ||
    state.submission.phase === "locked"
  );
}

/** Opens the form with one blank line for each item that can still be returned. */
export function openReturn(
  state: ReturnState,
  rows: readonly ReturnTableRow[]
): ReturnState {
  if (isReturnLocked(state) || state.step !== "closed") {
    return state;
  }
  return {
    ...state,
    draft: {
      lines: rows
        .filter((row) => row.available > 0)
        .map((row) => ({
          available: row.available,
          label: row.label,
          position: row.position,
          restocked: "",
          restockedTouched: false,
          returned: "",
        })),
      reasonCode: "",
      reasonNote: "",
    },
    showErrors: false,
    step: "editing",
  };
}

/** Whether a quantity, a reason or a note was put in the open panel and not sent. */
export function isReturnDraftChanged(state: ReturnState): boolean {
  const { lines, reasonCode, reasonNote } = state.draft;
  return (
    state.step !== "closed" &&
    (reasonCode !== "" ||
      reasonNote.trim() !== "" ||
      lines.some((line) => line.returned !== "" || line.restockedTouched))
  );
}

export function closeReturn(state: ReturnState): ReturnState {
  return isReturnLocked(state) ? state : initialReturnState();
}

function editable(state: ReturnState): boolean {
  return !isReturnLocked(state) && state.step === "editing";
}

function updateLine(
  state: ReturnState,
  position: number,
  change: (line: ReturnLineDraft) => ReturnLineDraft
): ReturnState {
  if (!editable(state)) {
    return state;
  }
  return {
    ...state,
    draft: {
      ...state.draft,
      lines: state.draft.lines.map((line) =>
        line.position === position ? change(line) : line
      ),
    },
  };
}

/** While untouched, "volta ao estoque" follows the returned quantity (visible). */
export function editReturned(
  state: ReturnState,
  position: number,
  text: string
): ReturnState {
  return updateLine(state, position, (line) => ({
    ...line,
    restocked: line.restockedTouched ? line.restocked : text,
    returned: text,
  }));
}

export function editRestocked(
  state: ReturnState,
  position: number,
  text: string
): ReturnState {
  return updateLine(state, position, (line) => ({
    ...line,
    restocked: text,
    restockedTouched: true,
  }));
}

export function editReturnReason(
  state: ReturnState,
  reasonCode: ReturnReasonCode | ""
): ReturnState {
  if (!editable(state)) {
    return state;
  }
  return {
    ...state,
    draft: {
      ...state.draft,
      reasonCode,
      reasonNote: reasonCode === "" ? "" : state.draft.reasonNote,
    },
  };
}

export function editReturnNote(
  state: ReturnState,
  reasonNote: string
): ReturnState {
  return editable(state)
    ? { ...state, draft: { ...state.draft, reasonNote } }
    : state;
}

/** Errors to show: all after a review try, otherwise only a too-long note. */
export function visibleReturnErrors(state: ReturnState): ReturnDraftErrors {
  const { errors } = validateReturnDraft(state.draft);
  if (state.showErrors) {
    return errors;
  }
  return noteLength(state.draft.reasonNote) > MAX_RETURN_NOTE_CODE_POINTS &&
    errors.note
    ? { lines: {}, note: errors.note }
    : { lines: {} };
}

export function reviewReturn(state: ReturnState): ReturnState {
  if (!editable(state)) {
    return state;
  }
  return validateReturnDraft(state.draft).input === null
    ? { ...state, showErrors: true }
    : { ...state, showErrors: false, step: "confirming" };
}

export function backToReturnEditing(state: ReturnState): ReturnState {
  return isReturnLocked(state) || state.step !== "confirming"
    ? state
    : { ...state, step: "editing" };
}

export interface ReturnReview {
  lines: Array<{ key: string; text: string }>;
  reasonText: string;
  totalsText: string;
}

function units(count: number): string {
  return `${count} ${count === 1 ? "unidade" : "unidades"}`;
}

/** What the confirmation step shows: per item, and the stock effect. */
export function returnReview(state: ReturnState): ReturnReview | null {
  const { input } = validateReturnDraft(state.draft);
  if (input === null) {
    return null;
  }
  const labels = new Map(
    state.draft.lines.map((line) => [line.position, line.label])
  );
  const returned = input.items.reduce(
    (total, item) => total + item.returnedQuantity,
    0
  );
  const restocked = input.items.reduce(
    (total, item) => total + item.restockedQuantity,
    0
  );
  return {
    lines: input.items.map((item) => ({
      key: `p${item.position}`,
      text: `${labels.get(item.position) ?? `Item ${item.position + 1}`}: devolvidas ${item.returnedQuantity}, voltam ao estoque ${item.restockedQuantity}`,
    })),
    reasonText: returnReasonLabel(input.reasonCode),
    totalsText: `Total: ${returned} devolvidas · ${restocked} voltam ao estoque · ${returned - restocked} não voltam (por exemplo, com defeito). Nenhum reembolso é processado pelo Polaris.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

export type PreparedReturn =
  | { ok: true; request: ReturnSaleRequest; state: ReturnState }
  | { ok: false; state: ReturnState };

function rejected(state: ReturnState, message: string): PreparedReturn {
  return {
    ok: false,
    state: {
      ...state,
      submission: { failure: operationFailure(message), phase: "failed" },
    },
  };
}

/**
 * Builds the single return request and marks it in flight. It runs from the
 * confirmation step, or as a retry of a locked attempt; a second start while a
 * request is in flight is refused. An identical payload keeps its command ID.
 */
export function prepareReturnSubmission(input: {
  createId: () => string;
  organizationId: string;
  saleId: string;
  state: ReturnState;
}): PreparedReturn {
  const { state } = input;
  const retrying = state.submission.phase === "locked";
  if (
    state.submission.phase === "submitting" ||
    !(retrying || state.step === "confirming")
  ) {
    return { ok: false, state };
  }
  const { input: draftInput } = validateReturnDraft(state.draft);
  if (draftInput === null) {
    return rejected(state, "Revise as quantidades, o motivo e a observação.");
  }
  const attempt = resolveOperationAttempt(
    state.attempt,
    JSON.stringify({
      organizationId: input.organizationId,
      saleId: input.saleId,
      ...draftInput,
    }),
    input.createId
  );
  try {
    normalizeReturnSaleCommand({
      commandId: attempt.commandId,
      commandVersion: RETURN_SALE_COMMAND_VERSION,
      items: draftInput.items,
      reasonCode: draftInput.reasonCode,
      reasonNote: draftInput.reasonNote,
      saleId: input.saleId,
    });
  } catch {
    return rejected(
      state,
      "Os dados da devolução não passaram na validação final. Revise as quantidades, o motivo e a observação."
    );
  }
  return {
    ok: true,
    request: {
      commandId: attempt.commandId,
      commandVersion: RETURN_SALE_COMMAND_VERSION,
      items: draftInput.items,
      organizationId: input.organizationId,
      reasonCode: draftInput.reasonCode,
      reasonNote: draftInput.reasonNote,
      saleId: input.saleId,
    },
    state: { ...state, attempt, submission: { phase: "submitting" } },
  };
}

export function returnSuccessMessage(result: ReturnSaleResult): string {
  if (result.replayed) {
    return "Esta devolução já havia sido registrada com este mesmo pedido. Nada foi duplicado.";
  }
  const returned = result.lines.reduce(
    (total, line) => total + line.returnedQuantity,
    0
  );
  const restocked = result.lines.reduce(
    (total, line) => total + line.restockedQuantity,
    0
  );
  return `Devolução registrada: ${units(returned)} no total; ${restocked} voltaram ao estoque. O Polaris não processou nenhum reembolso.`;
}

export function returnSucceeded(result: ReturnSaleResult): ReturnState {
  return {
    ...initialReturnState(),
    submission: {
      message: returnSuccessMessage(result),
      phase: "success",
      replayed: result.replayed,
    },
  };
}

/** A definite failure reopens editing; an unknown outcome locks the attempt. */
export function returnFailed(state: ReturnState, error: unknown): ReturnState {
  const failure = mapReturnError(error);
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

export function requestDiscardReturn(state: ReturnState): ReturnState {
  return state.submission.phase === "locked"
    ? { ...state, submission: { ...state.submission, confirmingDiscard: true } }
    : state;
}

export function cancelDiscardReturn(state: ReturnState): ReturnState {
  return state.submission.phase === "locked"
    ? {
        ...state,
        submission: { ...state.submission, confirmingDiscard: false },
      }
    : state;
}

/** Second step: abandons the locked attempt; null unless it was confirmed. */
export function discardLockedReturn(state: ReturnState): ReturnState | null {
  return state.submission.phase === "locked" &&
    state.submission.confirmingDiscard
    ? initialReturnState()
    : null;
}

export function returnSubmitLabel(state: ReturnState): string {
  if (state.submission.phase === "submitting") {
    return "Registrando devolução…";
  }
  return state.submission.phase === "locked"
    ? "Tentar novamente (seguro)"
    : "Confirmar devolução";
}
