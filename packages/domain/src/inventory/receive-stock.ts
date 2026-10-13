import { isValidCalendarDate } from "./calendar-date";
import {
  InventoryQuantityLimitError,
  MAX_INVENTORY_QUANTITY,
} from "./inventory";
import { normalizeUnitCost } from "./inventory-cost";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReceiveStockCommandInput {
  commandId: string;
  commandVersion: number;
  occurredOn: string;
  quantity: number;
  unitCost: string;
  variantId: string;
}

export interface NormalizedReceiveStockCommandInput
  extends Omit<ReceiveStockCommandInput, "commandVersion" | "unitCost"> {
  commandVersion: 1;
  unitCost: string;
}

export class InvalidReceiveStockInputError extends Error {
  readonly code = "invalid_receive_stock_input";

  constructor() {
    super("invalid_receive_stock_input");
    this.name = "InvalidReceiveStockInputError";
  }
}

export class UnsupportedReceiveStockCommandVersionError extends Error {
  readonly code = "unsupported_receive_stock_command_version";

  constructor() {
    super("unsupported_receive_stock_command_version");
    this.name = "UnsupportedReceiveStockCommandVersionError";
  }
}

/**
 * Validates the immutable, versioned receiveStock command before it enters a
 * tenant transaction. occurredOn is a calendar date and is not timezone-shifted.
 */
export function normalizeReceiveStockInput(
  input: ReceiveStockCommandInput
): NormalizedReceiveStockCommandInput {
  if (input.commandVersion !== 1) {
    throw new UnsupportedReceiveStockCommandVersionError();
  }
  if (
    !(
      uuidPattern.test(input.commandId) &&
      uuidPattern.test(input.variantId) &&
      Number.isInteger(input.quantity)
    ) ||
    input.quantity < 1 ||
    !isValidCalendarDate(input.occurredOn)
  ) {
    throw new InvalidReceiveStockInputError();
  }
  if (input.quantity > MAX_INVENTORY_QUANTITY) {
    throw new InventoryQuantityLimitError();
  }

  return {
    commandId: input.commandId.toLowerCase(),
    commandVersion: 1,
    occurredOn: input.occurredOn,
    quantity: input.quantity,
    unitCost: normalizeUnitCost(input.unitCost),
    variantId: input.variantId.toLowerCase(),
  };
}
