import { isValidCalendarDate } from "./calendar-date";
import {
  InventoryQuantityLimitError,
  MAX_INVENTORY_QUANTITY,
} from "./inventory";
import { normalizeUnitCost } from "./inventory-cost";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InventoryCountCommandInput {
  commandId: string;
  commandVersion: number;
  expectedVersion: number;
  occurredOn: string;
  physicalQuantity: number;
  valuationUnitCost?: string | null;
  variantId: string;
}

export interface NormalizedInventoryCountCommandInput
  extends Omit<
    InventoryCountCommandInput,
    "commandVersion" | "valuationUnitCost"
  > {
  commandVersion: 1;
  valuationUnitCost: string | null;
}

export class InvalidInventoryCountInputError extends Error {
  readonly code = "invalid_inventory_count_input";

  constructor() {
    super("invalid_inventory_count_input");
    this.name = "InvalidInventoryCountInputError";
  }
}

export class UnsupportedInventoryCountCommandVersionError extends Error {
  readonly code = "unsupported_inventory_count_command_version";

  constructor() {
    super("unsupported_inventory_count_command_version");
    this.name = "UnsupportedInventoryCountCommandVersionError";
  }
}

/** Validates and normalizes an immutable, versioned physical inventory count. */
export function normalizeInventoryCountInput(
  input: InventoryCountCommandInput
): NormalizedInventoryCountCommandInput {
  if (input.commandVersion !== 1) {
    throw new UnsupportedInventoryCountCommandVersionError();
  }

  const hasValidIdentity =
    uuidPattern.test(input.commandId) && uuidPattern.test(input.variantId);
  if (
    Number.isInteger(input.physicalQuantity) &&
    input.physicalQuantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InventoryQuantityLimitError();
  }
  if (
    !(hasValidIdentity && Number.isInteger(input.expectedVersion)) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > MAX_INVENTORY_QUANTITY ||
    !Number.isInteger(input.physicalQuantity) ||
    input.physicalQuantity < 0 ||
    !isValidCalendarDate(input.occurredOn) ||
    ((input.valuationUnitCost ?? null) !== null && input.physicalQuantity === 0)
  ) {
    throw new InvalidInventoryCountInputError();
  }
  return {
    commandId: input.commandId.toLowerCase(),
    commandVersion: 1,
    expectedVersion: input.expectedVersion,
    occurredOn: input.occurredOn,
    physicalQuantity: input.physicalQuantity,
    valuationUnitCost:
      input.valuationUnitCost === undefined || input.valuationUnitCost === null
        ? null
        : normalizeUnitCost(input.valuationUnitCost),
    variantId: input.variantId.toLowerCase(),
  };
}
