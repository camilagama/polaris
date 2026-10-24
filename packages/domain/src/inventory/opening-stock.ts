import {
  InventoryQuantityLimitError,
  MAX_INVENTORY_QUANTITY,
} from "./inventory";
import { normalizeInventoryCountInput } from "./inventory-count";
import {
  InvalidReceiveStockInputError,
  normalizeReceiveStockInput,
} from "./receive-stock";

/**
 * The opening stock of a new product: the quantity the store has when the product is registered, with the cost of
 * each unit or, when the person does not know it, without one. With a cost it is a receipt; without, an inventory
 * count from zero, because a receipt always carries a cost (the ledger refuses one without it).
 */
export interface OpeningStockInput {
  commandId: string;
  /** Calendar date of the movement, `YYYY-MM-DD`. */
  occurredOn: string;
  quantity: number;
  /** BRL cost of each unit as decimal text; `null` when it is unknown. */
  unitCost: string | null;
  variantId: string;
}

/** The same fields, validated and in the form the ledger stores. */
export type NormalizedOpeningStock = OpeningStockInput;

/** Validates the opening stock before any write; throws the stock domain errors for what the ledger would refuse. */
export function normalizeOpeningStockInput(
  input: OpeningStockInput
): NormalizedOpeningStock {
  if (
    typeof input.quantity === "number" &&
    Number.isInteger(input.quantity) &&
    input.quantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InventoryQuantityLimitError();
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new InvalidReceiveStockInputError();
  }
  if (input.unitCost === null) {
    const counted = normalizeInventoryCountInput({
      commandId: input.commandId,
      commandVersion: 1,
      expectedVersion: 0,
      occurredOn: input.occurredOn,
      physicalQuantity: input.quantity,
      valuationUnitCost: null,
      variantId: input.variantId,
    });
    return {
      commandId: counted.commandId,
      occurredOn: counted.occurredOn,
      quantity: counted.physicalQuantity,
      unitCost: null,
      variantId: counted.variantId,
    };
  }
  const received = normalizeReceiveStockInput({
    commandId: input.commandId,
    commandVersion: 1,
    occurredOn: input.occurredOn,
    quantity: input.quantity,
    unitCost: input.unitCost,
    variantId: input.variantId,
  });
  return {
    commandId: received.commandId,
    occurredOn: received.occurredOn,
    quantity: received.quantity,
    unitCost: received.unitCost,
    variantId: received.variantId,
  };
}
