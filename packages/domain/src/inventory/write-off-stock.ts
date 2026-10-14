import { isValidCalendarDate } from "./calendar-date";
import {
  InventoryQuantityLimitError,
  MAX_INVENTORY_QUANTITY,
} from "./inventory";

export const WRITE_OFF_REASON_CODES = Object.freeze([
  "damaged",
  "expired",
  "lost",
  "stolen",
  "internal_use",
  "other",
] as const);

export type WriteOffReasonCode = (typeof WRITE_OFF_REASON_CODES)[number];
export const MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS = 500;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WriteOffStockCommandInput {
  commandId: string;
  commandVersion: number;
  occurredOn: string;
  quantity: number;
  reasonCode: string;
  reasonNote?: string | null;
  variantId: string;
}

export interface NormalizedWriteOffStockCommandInput
  extends Omit<
    WriteOffStockCommandInput,
    "commandVersion" | "reasonCode" | "reasonNote"
  > {
  commandVersion: 1;
  reasonCode: WriteOffReasonCode;
  reasonNote: string | null;
}

export class InvalidWriteOffStockInputError extends Error {
  readonly code = "invalid_write_off_stock_input";

  constructor() {
    super("invalid_write_off_stock_input");
    this.name = "InvalidWriteOffStockInputError";
  }
}

export class UnsupportedWriteOffStockCommandVersionError extends Error {
  readonly code = "unsupported_write_off_stock_command_version";

  constructor() {
    super("unsupported_write_off_stock_command_version");
    this.name = "UnsupportedWriteOffStockCommandVersionError";
  }
}

export function isWriteOffReasonCode(
  value: string
): value is WriteOffReasonCode {
  return WRITE_OFF_REASON_CODES.some((reasonCode) => reasonCode === value);
}

/**
 * Validates a versioned write-off command before it enters a tenant transaction.
 * The reason is a stable code; a note is optional except for `other`.
 */
export function normalizeWriteOffStockInput(
  input: WriteOffStockCommandInput
): NormalizedWriteOffStockCommandInput {
  if (input.commandVersion !== 1) {
    throw new UnsupportedWriteOffStockCommandVersionError();
  }

  const hasValidCommandIdentity =
    uuidPattern.test(input.commandId) &&
    uuidPattern.test(input.variantId) &&
    Number.isInteger(input.quantity);
  if (
    !hasValidCommandIdentity ||
    input.quantity < 1 ||
    !isValidCalendarDate(input.occurredOn) ||
    !isWriteOffReasonCode(input.reasonCode)
  ) {
    throw new InvalidWriteOffStockInputError();
  }
  if (input.quantity > MAX_INVENTORY_QUANTITY) {
    throw new InventoryQuantityLimitError();
  }

  const reasonNote = input.reasonNote?.trim() || null;
  if (
    (input.reasonNote !== undefined &&
      input.reasonNote !== null &&
      reasonNote === null) ||
    (reasonNote !== null &&
      [...reasonNote].length > MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS) ||
    (input.reasonCode === "other" && reasonNote === null)
  ) {
    throw new InvalidWriteOffStockInputError();
  }

  return {
    commandId: input.commandId.toLowerCase(),
    commandVersion: 1,
    occurredOn: input.occurredOn,
    quantity: input.quantity,
    reasonCode: input.reasonCode,
    reasonNote,
    variantId: input.variantId.toLowerCase(),
  };
}
