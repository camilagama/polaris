import { MAX_INVENTORY_QUANTITY } from "../inventory/inventory";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RETURN_SALE_COMMAND_VERSION = 1;
export const MAX_RETURN_NOTE_CODE_POINTS = 500;

/**
 * Optional structured reason of a partial return. The plan names no values;
 * this V1 list is a project decision and a note is required only for `other`.
 */
export const RETURN_REASON_CODES = Object.freeze([
  "customer_request",
  "defective",
  "wrong_item",
  "other",
] as const);

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export interface ReturnLineInput {
  /** Position of the sale item (0-based), the stable identity of an item. */
  position: number;
  restockedQuantity: number;
  returnedQuantity: number;
}

export interface ReturnSaleCommandInput {
  commandId: string;
  commandVersion: number;
  items: readonly ReturnLineInput[];
  reasonCode?: string | null;
  reasonNote?: string | null;
  saleId: string;
}

export interface NormalizedReturnSaleCommand {
  commandId: string;
  items: readonly ReturnLineInput[];
  reasonCode: ReturnReasonCode | null;
  reasonNote: string | null;
  saleId: string;
}

export class InvalidSaleReturnError extends Error {
  readonly code = "invalid_sale_return";

  constructor() {
    super("invalid_sale_return");
    this.name = "InvalidSaleReturnError";
  }
}

export class UnsupportedSaleReturnCommandVersionError extends Error {
  readonly code = "unsupported_sale_return_command_version";

  constructor() {
    super("unsupported_sale_return_command_version");
    this.name = "UnsupportedSaleReturnCommandVersionError";
  }
}

/** A line returns more than what was sold and not yet returned. */
export class SaleReturnExceedsAvailableError extends Error {
  readonly code = "sale_return_exceeds_available";

  constructor() {
    super("sale_return_exceeds_available");
    this.name = "SaleReturnExceedsAvailableError";
  }
}

/** The same return command ID was used with a different payload. */
export class SaleReturnCommandConflictError extends Error {
  readonly code = "sale_return_command_conflict";

  constructor() {
    super("sale_return_command_conflict");
    this.name = "SaleReturnCommandConflictError";
  }
}

/** A cancelled sale cannot receive returns. */
export class SaleNotReturnableError extends Error {
  readonly code = "sale_not_returnable";

  constructor() {
    super("sale_not_returnable");
    this.name = "SaleNotReturnableError";
  }
}

/** A sale with returns cannot be cancelled as a whole. */
export class SaleHasReturnsError extends Error {
  readonly code = "sale_has_returns";

  constructor() {
    super("sale_has_returns");
    this.name = "SaleHasReturnsError";
  }
}

export function isReturnReasonCode(value: unknown): value is ReturnReasonCode {
  return RETURN_REASON_CODES.some((code) => code === value);
}

/**
 * PostgreSQL text cannot hold NUL, and a lone surrogate is silently replaced
 * on write, which would make a replay of the same note look like a different
 * payload. Reject both up front.
 */
function isStorableText(value: string): boolean {
  if (value.includes("\u0000")) {
    return false;
  }
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidSaleReturnError();
  }
  // Bound the work before spreading: a note can never be longer than this many UTF-16 units.
  if (value.length > MAX_RETURN_NOTE_CODE_POINTS * 2) {
    throw new InvalidSaleReturnError();
  }
  const note = value.trim();
  if (note === "") {
    return null;
  }
  if ([...note].length > MAX_RETURN_NOTE_CODE_POINTS || !isStorableText(note)) {
    throw new InvalidSaleReturnError();
  }
  return note;
}

function isQuantity(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= MAX_INVENTORY_QUANTITY
  );
}

/**
 * Validates the shape of the return command: at least one line, each sale item
 * at most once, a positive returned quantity and a restocked quantity between
 * zero and the returned one. Availability depends on the sale and is checked
 * by `planSaleReturn`.
 */
export function normalizeReturnSaleCommand(
  input: ReturnSaleCommandInput
): NormalizedReturnSaleCommand {
  if (!input || typeof input !== "object") {
    throw new InvalidSaleReturnError();
  }
  if (input.commandVersion !== RETURN_SALE_COMMAND_VERSION) {
    throw new UnsupportedSaleReturnCommandVersionError();
  }
  if (
    typeof input.commandId !== "string" ||
    !uuidPattern.test(input.commandId) ||
    typeof input.saleId !== "string" ||
    !uuidPattern.test(input.saleId) ||
    !Array.isArray(input.items) ||
    input.items.length === 0
  ) {
    throw new InvalidSaleReturnError();
  }

  const seen = new Set<number>();
  const items = input.items.map((line) => {
    if (
      !line ||
      typeof line !== "object" ||
      !isQuantity(line.position, 0) ||
      !isQuantity(line.returnedQuantity, 1) ||
      !isQuantity(line.restockedQuantity, 0) ||
      line.restockedQuantity > line.returnedQuantity ||
      seen.has(line.position)
    ) {
      throw new InvalidSaleReturnError();
    }
    seen.add(line.position);
    return {
      position: line.position,
      restockedQuantity: line.restockedQuantity,
      returnedQuantity: line.returnedQuantity,
    };
  });

  const reasonCode = input.reasonCode ?? null;
  if (reasonCode !== null && !isReturnReasonCode(reasonCode)) {
    throw new InvalidSaleReturnError();
  }
  const reasonNote = normalizeNote(input.reasonNote);
  if (
    (reasonCode === null && reasonNote !== null) ||
    (reasonCode === "other" && reasonNote === null)
  ) {
    throw new InvalidSaleReturnError();
  }

  return {
    commandId: input.commandId.toLowerCase(),
    items: [...items].sort((left, right) => left.position - right.position),
    reasonCode,
    reasonNote,
    saleId: input.saleId.toLowerCase(),
  };
}

export interface SaleReturnItemFacts {
  position: number;
  productId: string;
  /** Units sold in the confirmed sale. */
  quantity: number;
  /** Units already returned by earlier returns of this sale. */
  returnedSoFar: number;
  unitCost: string | null;
  variantId: string;
}

export interface PlannedReturnLine {
  /** Units that were available to return before this return. */
  availableBefore: number;
  position: number;
  productId: string;
  restockedQuantity: number;
  returnedQuantity: number;
  unitCost: string | null;
  variantId: string;
}

/**
 * Applies the return rules to the sale's facts:
 * `returned <= available_to_return` and `restocked <= returned`, where
 * `available_to_return = sold - already returned`. Returns the planned lines in
 * item position order, or throws without side effects.
 */
export function planSaleReturn(
  items: readonly SaleReturnItemFacts[],
  lines: readonly ReturnLineInput[]
): PlannedReturnLine[] {
  const byPosition = new Map(items.map((item) => [item.position, item]));
  if (new Set(lines.map((line) => line.position)).size !== lines.length) {
    throw new InvalidSaleReturnError();
  }
  return [...lines]
    .sort((left, right) => left.position - right.position)
    .map((line) => {
      const item = byPosition.get(line.position);
      if (!item) {
        throw new InvalidSaleReturnError();
      }
      if (
        !(
          isQuantity(line.returnedQuantity, 1) &&
          isQuantity(line.restockedQuantity, 0)
        ) ||
        line.restockedQuantity > line.returnedQuantity
      ) {
        throw new InvalidSaleReturnError();
      }
      const available = item.quantity - item.returnedSoFar;
      if (available < 0 || line.returnedQuantity > available) {
        throw new SaleReturnExceedsAvailableError();
      }
      return {
        availableBefore: available,
        position: line.position,
        productId: item.productId,
        restockedQuantity: line.restockedQuantity,
        returnedQuantity: line.returnedQuantity,
        unitCost: item.unitCost,
        variantId: item.variantId,
      };
    });
}
