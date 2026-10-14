import type {
  InventoryBalanceReadModel,
  PolarisRpcClient,
} from "@polaris/contracts";
import { MAX_INVENTORY_QUANTITY } from "@polaris/domain/inventory/inventory";
import { calculateMovingAverageCost } from "@polaris/domain/inventory/inventory-cost";
import { normalizeInventoryCountInput } from "@polaris/domain/inventory/inventory-count";
import { normalizeReceiveStockInput } from "@polaris/domain/inventory/receive-stock";
import {
  MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS,
  normalizeWriteOffStockInput,
  type WriteOffReasonCode,
} from "@polaris/domain/inventory/write-off-stock";
import { isCalendarDate } from "../lib/dates";
import {
  formatBrlAmount,
  formatCalendarDate,
  formatQuantity,
} from "../lib/format";
import {
  isDefiniteRpcRejection,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import {
  costText,
  retarget,
  type StockTarget,
  unitsText,
} from "./stock-target";

type ReceiveInput = Parameters<
  PolarisRpcClient["inventory"]["receiveStock"]
>[0];
type CountInput = Parameters<
  PolarisRpcClient["inventory"]["inventoryCount"]
>[0];
type WriteOffInput = Parameters<
  PolarisRpcClient["inventory"]["writeOffStock"]
>[0];

/** Every stock command answers with the authoritative balance. */
export interface StockResult {
  balance: InventoryBalanceReadModel;
  replayed: boolean;
}

export type StockAction = "count" | "receive" | "write_off";

export const STOCK_ACTIONS: readonly StockAction[] = [
  "receive",
  "count",
  "write_off",
];

interface ActionLabels {
  confirm: string;
  noun: string;
  title: string;
  /** The short button label on a row. */
  trigger: string;
}

export const STOCK_ACTION_LABELS: Readonly<Record<StockAction, ActionLabels>> =
  {
    count: {
      confirm: "Confirmar contagem",
      noun: "a contagem",
      title: "Contar estoque",
      trigger: "Contar",
    },
    receive: {
      confirm: "Confirmar recebimento",
      noun: "o recebimento",
      title: "Receber estoque",
      trigger: "Receber",
    },
    write_off: {
      confirm: "Confirmar baixa",
      noun: "a baixa",
      title: "Baixar estoque",
      trigger: "Baixar",
    },
  };

export const WRITE_OFF_REASONS: ReadonlyArray<
  readonly [WriteOffReasonCode, string]
> = [
  ["damaged", "Avariado"],
  ["expired", "Vencido"],
  ["lost", "Perdido ou extraviado"],
  ["stolen", "Furtado ou roubado"],
  ["internal_use", "Uso interno"],
  ["other", "Outro (descreva)"],
];

const reasonLabels = new Map<string, string>(WRITE_OFF_REASONS);

export function writeOffReasonLabel(code: string): string {
  return reasonLabels.get(code) ?? "Motivo desconhecido";
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                     */
/* -------------------------------------------------------------------------- */

export type StockFieldName =
  | "occurredOn"
  | "physicalQuantity"
  | "quantity"
  | "reasonCode"
  | "reasonNote"
  | "unitCost"
  | "valuationUnitCost";

export type StockDraft =
  | {
      action: "count";
      occurredOn: string;
      physicalQuantity: string;
      valuationUnitCost: string;
    }
  | {
      action: "receive";
      occurredOn: string;
      quantity: string;
      unitCost: string;
    }
  | {
      action: "write_off";
      occurredOn: string;
      quantity: string;
      reasonCode: WriteOffReasonCode | "";
      reasonNote: string;
    };

/** The order the form shows fields in; the first invalid one gets focus. */
export const STOCK_FIELD_ORDER: Readonly<
  Record<StockAction, readonly StockFieldName[]>
> = {
  count: ["physicalQuantity", "valuationUnitCost", "occurredOn"],
  receive: ["quantity", "unitCost", "occurredOn"],
  write_off: ["quantity", "reasonCode", "reasonNote", "occurredOn"],
};

function initialStockDraft(action: StockAction, today: string): StockDraft {
  switch (action) {
    case "receive":
      return { action, occurredOn: today, quantity: "", unitCost: "" };
    case "count":
      return {
        action,
        occurredOn: today,
        physicalQuantity: "",
        valuationUnitCost: "",
      };
    default:
      return {
        action,
        occurredOn: today,
        quantity: "",
        reasonCode: "",
        reasonNote: "",
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Field parsing                                                              */
/* -------------------------------------------------------------------------- */

type FieldParse<T> =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too_large" }
  | { kind: "ok"; value: T };

const wholeNumberPattern = /^\d{1,10}$/;
const unitCostPattern = /^(\d+)(?:\.(\d{1,6}))?$/;
const leadingZerosPattern = /^0+(?=\d)/;
const MAX_COST_WHOLE_DIGITS = 18;

function parseWholeNumber(text: string, minimum: number): FieldParse<number> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (!wholeNumberPattern.test(trimmed)) {
    return { kind: "invalid" };
  }
  const value = Number(trimmed);
  if (value < minimum) {
    return { kind: "invalid" };
  }
  return value > MAX_INVENTORY_QUANTITY
    ? { kind: "too_large" }
    : { kind: "ok", value };
}

/** A BRL unit cost with up to six decimals; a comma or a dot is the separator. */
export function parseUnitCost(text: string): FieldParse<string> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  const normalized =
    trimmed.includes(",") && trimmed.includes(".")
      ? trimmed
      : trimmed.replace(",", ".");
  const match = unitCostPattern.exec(normalized);
  if (!match) {
    return { kind: "invalid" };
  }
  const whole = (match[1] ?? "0").replace(leadingZerosPattern, "");
  if (whole.length > MAX_COST_WHOLE_DIGITS) {
    return { kind: "too_large" };
  }
  return { kind: "ok", value: match[2] ? `${whole}.${match[2]}` : whole };
}

function codePointCount(text: string): number {
  return [...text.trim()].length;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type StockCall =
  | { action: "count"; input: CountInput }
  | { action: "receive"; input: ReceiveInput }
  | { action: "write_off"; input: WriteOffInput };

/** What a valid draft would send, before ids are attached. */
type StockBody =
  | {
      action: "count";
      expectedVersion: number;
      occurredOn: string;
      physicalQuantity: number;
      valuationUnitCost: string | null;
    }
  | {
      action: "receive";
      occurredOn: string;
      quantity: number;
      unitCost: string;
    }
  | {
      action: "write_off";
      occurredOn: string;
      quantity: number;
      reasonCode: WriteOffReasonCode;
      reasonNote: string | null;
    };

export interface StockIssue {
  /** True when the field is simply not filled in yet. */
  empty: boolean;
  field: StockFieldName;
  message: string;
}

export interface StockValidation {
  body: StockBody | null;
  issues: StockIssue[];
}

const MAX_QUANTITY_TEXT = formatQuantity(MAX_INVENTORY_QUANTITY);

/** Why the action cannot be started on this variant, or null when it can. */
export function stockActionBlock(
  action: StockAction,
  target: StockTarget
): string | null {
  if (
    action === "receive" &&
    target.quantity > 0 &&
    target.movingAverageCost === null &&
    !target.costUnavailable
  ) {
    return "O recebimento está bloqueado: este saldo não tem custo conhecido, e o servidor não inventa um. Faça antes uma contagem informando o custo unitário (valoração).";
  }
  if (action === "write_off" && target.quantity === 0) {
    return "Não há saldo para baixar: esta variante está com saldo 0.";
  }
  return null;
}

/** The valuation field exists only while the average cost is unknown. */
export function valuationApplies(target: StockTarget): boolean {
  return target.movingAverageCost === null && !target.costUnavailable;
}

function issue(
  issues: StockIssue[],
  field: StockFieldName,
  message: string,
  empty = false
): void {
  issues.push({ empty, field, message });
}

function validateDate(
  text: string,
  today: string,
  issues: StockIssue[]
): string | null {
  if (text.trim() === "") {
    issue(issues, "occurredOn", "Informe a data.", true);
    return null;
  }
  if (!isCalendarDate(text)) {
    issue(issues, "occurredOn", "Use uma data válida.");
    return null;
  }
  if (text > today) {
    issue(issues, "occurredOn", "A data não pode ser futura.");
    return null;
  }
  return text;
}

function quantityIssue(
  parse: FieldParse<number>,
  field: StockFieldName,
  issues: StockIssue[],
  labels: { empty: string; invalid: string }
): number | null {
  if (parse.kind === "ok") {
    return parse.value;
  }
  if (parse.kind === "empty") {
    issue(issues, field, labels.empty, true);
  } else if (parse.kind === "too_large") {
    issue(issues, field, `O limite é ${MAX_QUANTITY_TEXT} unidades.`);
  } else {
    issue(issues, field, labels.invalid);
  }
  return null;
}

function costIssue(
  parse: FieldParse<string>,
  field: StockFieldName,
  issues: StockIssue[],
  emptyMessage: string
): string | null {
  if (parse.kind === "ok") {
    return parse.value;
  }
  if (parse.kind === "empty") {
    issue(issues, field, emptyMessage, true);
  } else if (parse.kind === "too_large") {
    issue(issues, field, "O custo excede 18 dígitos inteiros.");
  } else {
    issue(
      issues,
      field,
      "Use um valor em reais, com até 6 casas decimais. Ex.: 12,34."
    );
  }
  return null;
}

function validateReceive(
  draft: Extract<StockDraft, { action: "receive" }>,
  target: StockTarget,
  today: string,
  issues: StockIssue[]
): StockBody | null {
  const quantity = quantityIssue(
    parseWholeNumber(draft.quantity, 1),
    "quantity",
    issues,
    {
      empty: "Informe a quantidade recebida.",
      invalid: "Use um número inteiro maior que zero.",
    }
  );
  if (
    quantity !== null &&
    target.quantity + quantity > MAX_INVENTORY_QUANTITY
  ) {
    issue(
      issues,
      "quantity",
      `O saldo não pode passar de ${MAX_QUANTITY_TEXT} unidades. O saldo atual é ${formatQuantity(target.quantity)}.`
    );
  }
  const unitCost = costIssue(
    parseUnitCost(draft.unitCost),
    "unitCost",
    issues,
    "Informe o custo unitário: ele é obrigatório em todo recebimento."
  );
  const occurredOn = validateDate(draft.occurredOn, today, issues);
  return issues.length === 0 &&
    quantity !== null &&
    unitCost !== null &&
    occurredOn !== null
    ? { action: "receive", occurredOn, quantity, unitCost }
    : null;
}

function validateCount(
  draft: Extract<StockDraft, { action: "count" }>,
  target: StockTarget,
  today: string,
  issues: StockIssue[]
): StockBody | null {
  const physical = quantityIssue(
    parseWholeNumber(draft.physicalQuantity, 0),
    "physicalQuantity",
    issues,
    {
      empty: "Informe a quantidade contada (use 0 se não há nada).",
      invalid: "Use um número inteiro, 0 ou mais.",
    }
  );
  let valuation: string | null = null;
  const valuationText = draft.valuationUnitCost.trim();
  if (valuationApplies(target) && valuationText !== "") {
    valuation = costIssue(
      parseUnitCost(draft.valuationUnitCost),
      "valuationUnitCost",
      issues,
      ""
    );
    if (valuation !== null && physical === 0) {
      issue(
        issues,
        "valuationUnitCost",
        "A valoração só vale quando a quantidade contada é maior que zero."
      );
      valuation = null;
    }
  }
  const occurredOn = validateDate(draft.occurredOn, today, issues);
  return issues.length === 0 && physical !== null && occurredOn !== null
    ? {
        action: "count",
        expectedVersion: target.version,
        occurredOn,
        physicalQuantity: physical,
        valuationUnitCost: valuation,
      }
    : null;
}

function validateWriteOff(
  draft: Extract<StockDraft, { action: "write_off" }>,
  target: StockTarget,
  today: string,
  issues: StockIssue[]
): StockBody | null {
  const quantity = quantityIssue(
    parseWholeNumber(draft.quantity, 1),
    "quantity",
    issues,
    {
      empty: "Informe a quantidade a baixar.",
      invalid: "Use um número inteiro maior que zero.",
    }
  );
  if (quantity !== null && quantity > target.quantity) {
    issue(
      issues,
      "quantity",
      `A baixa não pode ser maior que o saldo exibido (${formatQuantity(target.quantity)}). Se o saldo mudou, atualize a lista.`
    );
  }
  if (draft.reasonCode === "") {
    issue(issues, "reasonCode", "Escolha o motivo da baixa.", true);
  }
  const note = draft.reasonNote.trim();
  if (codePointCount(note) > MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS) {
    issue(
      issues,
      "reasonNote",
      `A observação pode ter até ${MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS} caracteres.`
    );
  } else if (draft.reasonCode === "other" && note === "") {
    issue(issues, "reasonNote", "Descreva o motivo em “Outro”.", true);
  }
  const occurredOn = validateDate(draft.occurredOn, today, issues);
  return issues.length === 0 &&
    quantity !== null &&
    draft.reasonCode !== "" &&
    occurredOn !== null
    ? {
        action: "write_off",
        occurredOn,
        quantity,
        reasonCode: draft.reasonCode,
        reasonNote: note === "" ? null : note,
      }
    : null;
}

export function validateStockDraft(
  draft: StockDraft,
  target: StockTarget,
  today: string
): StockValidation {
  const issues: StockIssue[] = [];
  let body: StockBody | null;
  if (draft.action === "receive") {
    body = validateReceive(draft, target, today, issues);
  } else if (draft.action === "count") {
    body = validateCount(draft, target, today, issues);
  } else {
    body = validateWriteOff(draft, target, today, issues);
  }
  return { body: issues.length === 0 ? body : null, issues };
}

/** The first field with an issue, in the order the form shows them. */
export function firstInvalidStockField(
  action: StockAction,
  issues: readonly StockIssue[]
): StockFieldName | null {
  return (
    STOCK_FIELD_ORDER[action].find((field) =>
      issues.some((found) => found.field === field)
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Summary of the confirmation step                                           */
/* -------------------------------------------------------------------------- */

export interface SummaryLine {
  label: string;
  value: string;
}

function signedUnits(delta: number): string {
  if (delta === 0) {
    return "sem diferença";
  }
  return `${delta > 0 ? "+" : "−"}${unitsText(Math.abs(delta))}`;
}

function receiveCostLine(
  body: Extract<StockBody, { action: "receive" }>,
  target: StockTarget
): SummaryLine | null {
  if (target.costUnavailable) {
    return null;
  }
  try {
    const average = calculateMovingAverageCost({
      currentAverageCost: target.movingAverageCost,
      currentQuantity: target.quantity,
      receivedQuantity: body.quantity,
      unitCost: body.unitCost,
    });
    return {
      label: "Custo médio previsto",
      value: `${formatBrlAmount(average)} (o servidor recalcula)`,
    };
  } catch {
    return null;
  }
}

/** What the operator is about to register, in plain terms. */
export function stockSummary(
  body: StockBody,
  target: StockTarget
): SummaryLine[] {
  const lines: SummaryLine[] = [
    {
      label: "Variante",
      value: `${target.productName} — ${target.variantText}`,
    },
  ];
  if (body.action === "receive") {
    lines.push(
      { label: "Quantidade recebida", value: signedUnits(body.quantity) },
      { label: "Custo unitário", value: formatBrlAmount(body.unitCost) },
      {
        label: "Data do recebimento",
        value: formatCalendarDate(body.occurredOn),
      },
      {
        label: "Saldo depois",
        value: `${unitsText(target.quantity + body.quantity)} (hoje ${formatQuantity(target.quantity)})`,
      }
    );
    const cost = receiveCostLine(body, target);
    if (cost) {
      lines.push(cost);
    }
    return lines;
  }
  if (body.action === "count") {
    lines.push(
      { label: "Quantidade contada", value: unitsText(body.physicalQuantity) },
      { label: "Saldo no sistema", value: unitsText(target.quantity) },
      {
        label: "Diferença",
        value: signedUnits(body.physicalQuantity - target.quantity),
      },
      { label: "Data da contagem", value: formatCalendarDate(body.occurredOn) }
    );
    if (body.valuationUnitCost !== null) {
      lines.push({
        label: "Custo unitário informado",
        value: formatBrlAmount(body.valuationUnitCost),
      });
    } else if (
      target.movingAverageCost === null &&
      !target.costUnavailable &&
      body.physicalQuantity > 0
    ) {
      lines.push({
        label: "Custo",
        value: "continua desconhecido (nenhum custo informado)",
      });
    }
    return lines;
  }
  lines.push(
    { label: "Quantidade baixada", value: signedUnits(-body.quantity) },
    { label: "Motivo", value: writeOffReasonLabel(body.reasonCode) }
  );
  if (body.reasonNote !== null) {
    lines.push({ label: "Observação", value: body.reasonNote });
  }
  lines.push(
    { label: "Data da baixa", value: formatCalendarDate(body.occurredOn) },
    {
      label: "Saldo depois",
      value: `${unitsText(target.quantity - body.quantity)} (hoje ${formatQuantity(target.quantity)})`,
    }
  );
  return lines;
}

/** The consequence the operator must accept before confirming. */
export function stockConsequence(action: StockAction): string {
  switch (action) {
    case "receive":
      return "O recebimento entra no histórico e muda o custo médio do saldo. Ele não pode ser editado depois; um erro se corrige com uma contagem ou uma baixa.";
    case "count":
      return "A contagem substitui o saldo pela quantidade contada e fica no histórico, inclusive quando não há diferença. Ela falha se o saldo mudar enquanto você confirma.";
    default:
      return "A baixa tira as unidades do saldo e fica no histórico com o motivo. Ela não muda o custo médio do saldo restante nem cria despesa.";
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface StockFailure {
  /** The attempt cannot be resent as is: the next confirm gets a fresh one. */
  discardAttempt: boolean;
  message: string;
  reason: string | null;
  /** The balance moved or was read stale: read it again. */
  refreshBalance: boolean;
  /** The variant or product changed under the screen: reload the list. */
  reloadList: boolean;
  /** Network, 5xx or unknown error: the command may already be registered. */
  unknownOutcome: boolean;
}

interface ReasonOutcome {
  discardAttempt?: boolean;
  message: string;
  refreshBalance?: boolean;
  reloadList?: boolean;
}

const variantGoneMessage =
  "Esta variante não existe mais nesta organização. Atualizamos a lista.";
const invalidDataMessage =
  "O servidor recusou os dados na validação. Revise quantidade, data e demais campos.";
const incompatibleMessage =
  "Esta versão da tela não é compatível com o servidor. Recarregue a página.";

const reasonOutcomes = new Map<string, ReasonOutcome>([
  [
    "insufficient_stock",
    {
      message:
        "Estoque insuficiente: a baixa deixaria o saldo abaixo de zero. Atualizamos o saldo; reduza a quantidade.",
      refreshBalance: true,
    },
  ],
  [
    "inventory_quantity_limit",
    {
      message: `A quantidade ultrapassa o limite de ${MAX_QUANTITY_TEXT} unidades por variante. Reduza a quantidade.`,
    },
  ],
  [
    "inventory_cost_unavailable",
    {
      message:
        "Este saldo não tem custo conhecido, então o recebimento está bloqueado. Faça uma contagem informando o custo unitário (valoração) e tente de novo.",
      refreshBalance: true,
    },
  ],
  [
    "stock_command_conflict",
    {
      discardAttempt: true,
      message:
        "Esta tentativa já tinha sido usada com outro conteúdo. Uma nova tentativa será criada automaticamente; revise e confirme de novo.",
    },
  ],
  [
    "inventory_version_conflict",
    {
      discardAttempt: true,
      message:
        "O saldo mudou depois que você abriu a contagem (uma venda, um recebimento ou outra contagem). Atualizamos o saldo: revise a quantidade contada e confirme de novo.",
      refreshBalance: true,
    },
  ],
  [
    "product_deleted",
    {
      message:
        "O produto desta variante foi removido; o estoque não pode mais ser alterado. Atualizamos a lista.",
      reloadList: true,
    },
  ],
  [
    "inventory_variant_not_found",
    { message: variantGoneMessage, reloadList: true },
  ],
  [
    "product_variant_not_found",
    { message: variantGoneMessage, reloadList: true },
  ],
  ["product_not_found", { message: variantGoneMessage, reloadList: true }],
  [
    "invalid_unit_cost",
    { message: "Informe o custo unitário em reais, com até 6 casas decimais." },
  ],
  [
    "inventory_cost_limit",
    { message: "O custo unitário excede o limite de 18 dígitos inteiros." },
  ],
  [
    "invalid_inventory_count_input",
    {
      message:
        "A contagem foi recusada. A valoração só vale com saldo sem custo conhecido e quantidade contada maior que zero.",
    },
  ],
  ["invalid_receive_stock_input", { message: invalidDataMessage }],
  ["invalid_write_off_stock_input", { message: invalidDataMessage }],
  ["invalid_stock_movement", { message: invalidDataMessage }],
  [
    "unsupported_receive_stock_command_version",
    { message: incompatibleMessage },
  ],
  [
    "unsupported_inventory_count_command_version",
    { message: incompatibleMessage },
  ],
  [
    "unsupported_write_off_stock_command_version",
    { message: incompatibleMessage },
  ],
]);

function stockFailure(
  message: string,
  options: {
    discardAttempt?: boolean;
    reason?: string | null;
    refreshBalance?: boolean;
    reloadList?: boolean;
    unknownOutcome?: boolean;
  } = {}
): StockFailure {
  return {
    discardAttempt: options.discardAttempt ?? false,
    message,
    reason: options.reason ?? null,
    refreshBalance: options.refreshBalance ?? false,
    reloadList: options.reloadList ?? false,
    unknownOutcome: options.unknownOutcome ?? false,
  };
}

function genericFailure(code: string | undefined): StockFailure {
  switch (code) {
    case "UNAUTHORIZED":
      return stockFailure(
        "Sua sessão não está ativa. Entre novamente para continuar; os dados continuam no formulário."
      );
    case "FORBIDDEN":
      return stockFailure(
        "Sua conta não tem permissão para alterar o estoque nesta organização."
      );
    case "BAD_REQUEST":
      return stockFailure(invalidDataMessage);
    case "NOT_FOUND":
      return stockFailure(variantGoneMessage, { reloadList: true });
    default:
      return stockFailure(
        "O estado do estoque mudou. Atualizamos o saldo; revise e tente de novo.",
        { refreshBalance: true }
      );
  }
}

/**
 * Maps an oRPC error. A 4xx answer is definite (nothing was recorded) and
 * keeps editing open; network, 5xx and unknown errors may have taken effect and
 * lock the attempt. A known `data.reason` refines the per-code message.
 */
export function mapStockError(
  action: StockAction,
  error: unknown
): StockFailure {
  if (!isDefiniteRpcRejection(error)) {
    return stockFailure(
      `Não foi possível confirmar se ${STOCK_ACTION_LABELS[action].noun} foi registrad${action === "count" ? "a" : "o"}. A tentativa ficou bloqueada para edição. Use “Tentar novamente (seguro)”: o mesmo pedido é reenviado e o servidor não duplica o movimento.`,
      { unknownOutcome: true }
    );
  }
  const code = rpcErrorCode(error);
  const refinable =
    code === "BAD_REQUEST" || code === "NOT_FOUND" || code === "CONFLICT";
  const reason = refinable ? (rpcErrorReason(error) ?? null) : null;
  const outcome = reason === null ? undefined : reasonOutcomes.get(reason);
  if (outcome) {
    return stockFailure(outcome.message, {
      discardAttempt: outcome.discardAttempt ?? false,
      reason,
      refreshBalance: outcome.refreshBalance ?? false,
      reloadList: outcome.reloadList ?? false,
    });
  }
  return { ...genericFailure(code), reason };
}

/* -------------------------------------------------------------------------- */
/* Flow state                                                                 */
/* -------------------------------------------------------------------------- */

interface StockAttempt {
  commandId: string;
  signature: string;
}

type StockSubmission =
  | { phase: "idle" }
  | { phase: "submitting" }
  /** A definite failure: nothing was recorded; editing stays open. */
  | { failure: StockFailure; phase: "failed" }
  /** Unknown outcome: the form is locked on this attempt. */
  | { confirmingDiscard: boolean; failure: StockFailure; phase: "locked" }
  | {
      balance: InventoryBalanceReadModel;
      message: string;
      phase: "success";
      /** Kept on this device until the server confirms it (no connection). */
      queued: boolean;
      replayed: boolean;
    };

export interface StockCommandState {
  action: StockAction;
  attempt: StockAttempt | null;
  draft: StockDraft;
  showErrors: boolean;
  step: "confirming" | "editing";
  submission: StockSubmission;
  target: StockTarget;
  today: string;
}

export function startStockCommand(
  action: StockAction,
  target: StockTarget,
  today: string
): StockCommandState {
  return {
    action,
    attempt: null,
    draft: initialStockDraft(action, today),
    showErrors: false,
    step: "editing",
    submission: { phase: "idle" },
    target,
    today,
  };
}

function isStockSubmitting(state: StockCommandState): boolean {
  return state.submission.phase === "submitting";
}

/** True while editing is not allowed: in flight, an unknown outcome, or done. */
export function isStockLocked(state: StockCommandState): boolean {
  return (
    state.submission.phase === "submitting" ||
    state.submission.phase === "locked" ||
    state.submission.phase === "success"
  );
}

/** The panel can be closed unless a request is in flight or its outcome unknown. */
export function canCloseStock(state: StockCommandState): boolean {
  return (
    state.submission.phase !== "submitting" &&
    state.submission.phase !== "locked"
  );
}

export function editStockField(
  state: StockCommandState,
  field: StockFieldName,
  value: string
): StockCommandState {
  if (isStockLocked(state) || state.step !== "editing") {
    return state;
  }
  if (!STOCK_FIELD_ORDER[state.action].includes(field)) {
    return state;
  }
  const draft = { ...state.draft, [field]: value } as StockDraft;
  return { ...state, draft };
}

/** Format errors always show; "not filled in yet" ones only after a review try. */
export function visibleStockIssues(state: StockCommandState): StockIssue[] {
  const { issues } = validateStockDraft(state.draft, state.target, state.today);
  return state.showErrors ? issues : issues.filter((found) => !found.empty);
}

/** First step: validates the draft and moves to the confirmation step. */
export function reviewStock(state: StockCommandState): StockCommandState {
  if (isStockLocked(state) || state.step !== "editing") {
    return state;
  }
  if (stockActionBlock(state.action, state.target) !== null) {
    return state;
  }
  return validateStockDraft(state.draft, state.target, state.today).body ===
    null
    ? { ...state, showErrors: true }
    : { ...state, showErrors: false, step: "confirming" };
}

export function backToStockEditing(
  state: StockCommandState
): StockCommandState {
  return isStockLocked(state) || state.step !== "confirming"
    ? state
    : { ...state, step: "editing" };
}

/** A fresher balance replaces the target; the draft is kept for revision. */
export function retargetStock(
  state: StockCommandState,
  balance: InventoryBalanceReadModel
): StockCommandState {
  if (balance.variantId !== state.target.variantId) {
    return state;
  }
  return {
    ...state,
    step: state.submission.phase === "locked" ? state.step : "editing",
    target: retarget(state.target, balance),
  };
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A repeat of an identical payload keeps the command ID, so the server replays
 * it; any edit gives a fresh one.
 */
function resolveStockAttempt(
  previous: StockAttempt | null,
  signature: string,
  createId: () => string
): StockAttempt {
  return previous !== null && previous.signature === signature
    ? previous
    : { commandId: createId(), signature };
}

export type PreparedStock =
  | { call: StockCall; ok: true; state: StockCommandState }
  | { ok: false; state: StockCommandState };

function rejected(state: StockCommandState, message: string): PreparedStock {
  return {
    ok: false,
    state: {
      ...state,
      step: "editing",
      submission: { failure: stockFailure(message), phase: "failed" },
    },
  };
}

function buildCall(
  body: StockBody,
  ids: { commandId: string; organizationId: string; variantId: string }
): StockCall {
  const base = {
    ...ids,
    commandVersion: 1 as const,
    occurredOn: body.occurredOn,
  };
  if (body.action === "receive") {
    return {
      action: "receive",
      input: { ...base, quantity: body.quantity, unitCost: body.unitCost },
    };
  }
  if (body.action === "count") {
    return {
      action: "count",
      input: {
        ...base,
        expectedVersion: body.expectedVersion,
        physicalQuantity: body.physicalQuantity,
        ...(body.valuationUnitCost === null
          ? {}
          : { valuationUnitCost: body.valuationUnitCost }),
      },
    };
  }
  return {
    action: "write_off",
    input: {
      ...base,
      quantity: body.quantity,
      reasonCode: body.reasonCode,
      ...(body.reasonNote === null ? {} : { reasonNote: body.reasonNote }),
    },
  };
}

/** The same domain normalizers the server runs, as a last local check. */
function passesDomainCheck(call: StockCall): boolean {
  try {
    if (call.action === "receive") {
      normalizeReceiveStockInput(call.input);
    } else if (call.action === "count") {
      normalizeInventoryCountInput({
        ...call.input,
        valuationUnitCost: call.input.valuationUnitCost ?? null,
      });
    } else {
      normalizeWriteOffStockInput({
        ...call.input,
        reasonNote: call.input.reasonNote ?? null,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the single command and marks it in flight. It runs from the
 * confirmation step, or as a retry of a locked attempt. A second start while a
 * request is in flight is refused.
 */
export function prepareStockSubmission(input: {
  createId: () => string;
  organizationId: string;
  state: StockCommandState;
}): PreparedStock {
  const { state } = input;
  const retrying = state.submission.phase === "locked";
  if (
    isStockSubmitting(state) ||
    state.submission.phase === "success" ||
    !(retrying || state.step === "confirming")
  ) {
    return { ok: false, state };
  }
  const { body } = validateStockDraft(state.draft, state.target, state.today);
  if (body === null) {
    return rejected(
      state,
      "Revise os campos do formulário antes de confirmar."
    );
  }
  const attempt = resolveStockAttempt(
    state.attempt,
    JSON.stringify({
      body,
      organizationId: input.organizationId,
      variantId: state.target.variantId,
    }),
    input.createId
  );
  const call = buildCall(body, {
    commandId: attempt.commandId,
    organizationId: input.organizationId,
    variantId: state.target.variantId,
  });
  if (!passesDomainCheck(call)) {
    return rejected(
      state,
      "Os dados não passaram na validação final. Revise quantidade, custo e data."
    );
  }
  return {
    call,
    ok: true,
    state: { ...state, attempt, submission: { phase: "submitting" } },
  };
}

function queuedStockMessage(
  action: StockAction,
  result: StockResult,
  before: StockTarget
): string {
  const balanceText = `Saldo no aparelho: ${unitsText(result.balance.quantity)}.`;
  const { noun } = STOCK_ACTION_LABELS[action];
  const delta =
    action === "count"
      ? ` (${signedUnits(result.balance.quantity - before.quantity)})`
      : "";
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} guardad${noun.startsWith("a ") ? "a" : "o"} neste aparelho${delta}. ${balanceText} Só vale quando o servidor confirmar, assim que houver conexão (acompanhe em Pendências).`;
}

function stockSuccessMessage(
  action: StockAction,
  result: StockResult,
  before: StockTarget,
  queued: boolean
): string {
  if (queued) {
    return queuedStockMessage(action, result, before);
  }
  const balanceText = `Saldo atual: ${unitsText(result.balance.quantity)}.`;
  if (result.replayed) {
    return `Este mesmo pedido já tinha sido registrado. Nada foi duplicado. ${balanceText}`;
  }
  if (action === "receive") {
    return `Recebimento registrado. ${balanceText} Custo médio: ${costText(result.balance.movingAverageCost)}.`;
  }
  if (action === "count") {
    const delta = result.balance.quantity - before.quantity;
    return delta === 0
      ? `Contagem registrada, sem diferença. ${balanceText}`
      : `Contagem registrada (${signedUnits(delta)}). ${balanceText}`;
  }
  return `Baixa registrada. ${balanceText}`;
}

export function stockSucceeded(
  state: StockCommandState,
  result: StockResult,
  queued = false
): StockCommandState {
  return {
    ...state,
    attempt: null,
    submission: {
      balance: result.balance,
      message: stockSuccessMessage(state.action, result, state.target, queued),
      phase: "success",
      queued,
      replayed: result.replayed,
    },
    target: retarget(state.target, result.balance),
  };
}

/** A definite failure reopens editing; an unknown outcome locks the attempt. */
export function stockFailed(
  state: StockCommandState,
  error: unknown
): StockCommandState {
  const failure = mapStockError(state.action, error);
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

/**
 * Nothing could be kept on the device (not enough stock there, an expired
 * authorization, no room): a definite failure, editing reopens and the same
 * attempt can be tried again.
 */
export function stockQueueFailed(
  state: StockCommandState,
  error: unknown
): StockCommandState {
  const name = error instanceof Error ? error.name : "";
  let message =
    "Não foi possível guardar neste aparelho. Confira a validade da autorização offline e o espaço do aparelho, e tente de novo. Nada foi guardado.";
  if (name === "InsufficientLocalStockError") {
    message =
      "Estoque insuficiente neste aparelho: a baixa deixaria o saldo abaixo de zero. Reduza a quantidade.";
  } else if (name === "StaleLocalCountError") {
    message =
      "O saldo deste aparelho mudou depois que você abriu a contagem (uma venda ou um movimento guardado, ou uma atualização). Feche e abra a contagem de novo para revisar a quantidade.";
  }
  return {
    ...state,
    step: "editing",
    submission: { failure: stockFailure(message), phase: "failed" },
  };
}

/** First step of discarding a locked attempt: only asks for confirmation. */
export function requestDiscardStock(
  state: StockCommandState
): StockCommandState {
  return state.submission.phase === "locked"
    ? { ...state, submission: { ...state.submission, confirmingDiscard: true } }
    : state;
}

export function cancelDiscardStock(
  state: StockCommandState
): StockCommandState {
  return state.submission.phase === "locked"
    ? {
        ...state,
        submission: { ...state.submission, confirmingDiscard: false },
      }
    : state;
}

/**
 * Second step: abandons the locked attempt and starts the form over. Returns
 * null unless the operator already saw and accepted the confirmation step.
 */
export function discardLockedStock(
  state: StockCommandState
): StockCommandState | null {
  return state.submission.phase === "locked" &&
    state.submission.confirmingDiscard
    ? startStockCommand(state.action, state.target, state.today)
    : null;
}

export function stockSubmitLabel(state: StockCommandState): string {
  if (isStockSubmitting(state)) {
    return "Registrando…";
  }
  return state.submission.phase === "locked"
    ? "Tentar novamente (seguro)"
    : STOCK_ACTION_LABELS[state.action].confirm;
}
