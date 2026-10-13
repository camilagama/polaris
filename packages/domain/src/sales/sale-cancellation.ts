const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CANCEL_SALE_COMMAND_VERSION = 1;
export const MAX_CANCELLATION_NOTE_CODE_POINTS = 500;

/**
 * Optional structured reason of a whole-sale cancellation. The plan asks for a
 * "structured/optional" reason without listing the values; this V1 list is a
 * project decision and a note is required only for `other`.
 */
export const CANCELLATION_REASON_CODES = Object.freeze([
  "customer_request",
  "entry_error",
  "payment_issue",
  "other",
] as const);

export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

export interface CancelSaleCommandInput {
  commandId: string;
  commandVersion: number;
  reasonCode?: string | null;
  reasonNote?: string | null;
  saleId: string;
}

export interface NormalizedCancelSaleCommand {
  commandId: string;
  reasonCode: CancellationReasonCode | null;
  reasonNote: string | null;
  saleId: string;
}

export class InvalidSaleCancellationError extends Error {
  readonly code = "invalid_sale_cancellation";

  constructor() {
    super("invalid_sale_cancellation");
    this.name = "InvalidSaleCancellationError";
  }
}

export class UnsupportedSaleCancellationCommandVersionError extends Error {
  readonly code = "unsupported_sale_cancellation_command_version";

  constructor() {
    super("unsupported_sale_cancellation_command_version");
    this.name = "UnsupportedSaleCancellationCommandVersionError";
  }
}

/** The sale already has a cancellation, from this or from another command. */
export class SaleAlreadyCancelledError extends Error {
  readonly code = "sale_already_cancelled";

  constructor() {
    super("sale_already_cancelled");
    this.name = "SaleAlreadyCancelledError";
  }
}

/** The same cancellation command ID was used with a different payload. */
export class SaleCancellationCommandConflictError extends Error {
  readonly code = "sale_cancellation_command_conflict";

  constructor() {
    super("sale_cancellation_command_conflict");
    this.name = "SaleCancellationCommandConflictError";
  }
}

export function isCancellationReasonCode(
  value: unknown
): value is CancellationReasonCode {
  return CANCELLATION_REASON_CODES.some((code) => code === value);
}

export function normalizeCancellationNote(
  value: string | null | undefined
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidSaleCancellationError();
  }
  const note = value.trim();
  if (note === "") {
    return null;
  }
  if ([...note].length > MAX_CANCELLATION_NOTE_CODE_POINTS) {
    throw new InvalidSaleCancellationError();
  }
  return note;
}

/**
 * Validates the whole-sale cancellation command. The note is optional for
 * classified reasons, required for `other`, and never allowed without a code.
 */
export function normalizeCancelSaleCommand(
  input: CancelSaleCommandInput
): NormalizedCancelSaleCommand {
  if (!input || typeof input !== "object") {
    throw new InvalidSaleCancellationError();
  }
  if (input.commandVersion !== CANCEL_SALE_COMMAND_VERSION) {
    throw new UnsupportedSaleCancellationCommandVersionError();
  }
  if (
    typeof input.commandId !== "string" ||
    !uuidPattern.test(input.commandId) ||
    typeof input.saleId !== "string" ||
    !uuidPattern.test(input.saleId)
  ) {
    throw new InvalidSaleCancellationError();
  }

  const reasonCode = input.reasonCode ?? null;
  if (reasonCode !== null && !isCancellationReasonCode(reasonCode)) {
    throw new InvalidSaleCancellationError();
  }
  const reasonNote = normalizeCancellationNote(input.reasonNote);
  if (
    (reasonCode === null && reasonNote !== null) ||
    (reasonCode === "other" && reasonNote === null)
  ) {
    throw new InvalidSaleCancellationError();
  }

  return {
    commandId: input.commandId.toLowerCase(),
    reasonCode,
    reasonNote,
    saleId: input.saleId.toLowerCase(),
  };
}

/** One inverse ledger movement per sale item, restoring its quantity at its snapshot cost. */
export interface CancellationRestockLine {
  position: number;
  productId: string;
  quantity: number;
  unitCost: string | null;
  variantId: string;
}

export function planCancellationRestock(
  items: readonly {
    position: number;
    productId: string;
    quantity: number;
    unitCost: string | null;
    variantId: string;
  }[]
): CancellationRestockLine[] {
  if (items.length === 0) {
    throw new InvalidSaleCancellationError();
  }
  return [...items]
    .sort((left, right) => left.position - right.position)
    .map((item) => ({
      position: item.position,
      productId: item.productId,
      quantity: item.quantity,
      unitCost: item.unitCost,
      variantId: item.variantId,
    }));
}
