import {
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "@polaris/db/inventory-repository";
import { withCapability } from "@polaris/db/tenant-transaction";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import {
  InsufficientStockError,
  InventoryOccurredInFutureError,
  InventoryQuantityLimitError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidUnitCostError,
  InventoryCostLimitError,
  InventoryCostUnavailableError,
} from "@polaris/domain/inventory/inventory-cost";
import {
  InvalidInventoryCountInputError,
  normalizeInventoryCountInput,
  UnsupportedInventoryCountCommandVersionError,
} from "@polaris/domain/inventory/inventory-count";
import {
  InvalidReceiveStockInputError,
  normalizeReceiveStockInput,
} from "@polaris/domain/inventory/receive-stock";
import {
  InvalidWriteOffStockInputError,
  normalizeWriteOffStockInput,
} from "@polaris/domain/inventory/write-off-stock";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../push";

/**
 * The three offline stock commands (plan PR56): `stock.receive`,
 * `stock.write_off` and `stock.count`. Each is one ledger movement through the
 * same repository function the online screen uses, so the rules (no negative
 * stock, moving average cost, future dates, one movement per command ID) are the
 * ones already proven; this file only translates the payload and names the
 * refusals for the device.
 *
 * Stock is server-authoritative: a write-off that would take the balance below
 * zero is refused (`insufficient_stock`) and a count made against a balance that
 * moved since the device last saw it is refused (`inventory_version_conflict`).
 * The count carries the balance version the device counted against as the
 * command's `baseVersion`.
 */
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVENTORY_ADJUST = "inventory:adjust";

const STOCK_REFUSAL = {
  costUnavailable: "inventory_cost_unavailable",
  dateInFuture: "inventory_date_in_future",
  insufficientStock: "insufficient_stock",
  invalidPayload: "invalid_payload",
  productDeleted: "product_deleted",
  quantityLimit: "inventory_quantity_limit",
  variantNotFound: "variant_not_found",
  versionConflict: "inventory_version_conflict",
} as const;

const payloadErrors = [
  InvalidInventoryCountInputError,
  InvalidReceiveStockInputError,
  InvalidSyncPayloadError,
  InvalidUnitCostError,
  InvalidWriteOffStockInputError,
  InventoryCostLimitError,
  StockCommandConflictError,
  UnsupportedInventoryCountCommandVersionError,
];

function classifyStockError(error: unknown): string | null {
  if (error instanceof InsufficientStockError) {
    return STOCK_REFUSAL.insufficientStock;
  }
  if (error instanceof InventoryVersionConflictError) {
    return STOCK_REFUSAL.versionConflict;
  }
  if (error instanceof InventoryVariantNotFoundError) {
    return STOCK_REFUSAL.variantNotFound;
  }
  if (error instanceof ProductDeletedError) {
    return STOCK_REFUSAL.productDeleted;
  }
  if (error instanceof InventoryOccurredInFutureError) {
    return STOCK_REFUSAL.dateInFuture;
  }
  if (error instanceof InventoryQuantityLimitError) {
    return STOCK_REFUSAL.quantityLimit;
  }
  if (error instanceof InventoryCostUnavailableError) {
    return STOCK_REFUSAL.costUnavailable;
  }
  return payloadErrors.some((type) => error instanceof type)
    ? STOCK_REFUSAL.invalidPayload
    : null;
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidSyncPayloadError();
  }
  return payload as Record<string, unknown>;
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredString(value);
}

/** Runs the domain normalizer so a payload the repository would refuse is refused at parse. */
function validated<T>(parsed: T, check: (value: T) => void): T {
  try {
    check(parsed);
  } catch (error) {
    if (
      payloadErrors.some((type) => error instanceof type) ||
      error instanceof InventoryQuantityLimitError
    ) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new InvalidSyncPayloadError({ cause: error });
    }
    throw error;
  }
  return parsed;
}

interface ReceivePayload {
  occurredOn: string;
  quantity: number;
  unitCost: string;
  variantId: string;
}

export function createStockReceiveHandler(
  dependencies: { receiveStock: typeof receiveStock } = { receiveStock }
): SyncCommandHandler {
  return {
    capability: INVENTORY_ADJUST,
    classify: classifyStockError,
    async execute(transaction, identity, payload, context) {
      const input = payload as ReceivePayload;
      const result = await dependencies.receiveStock(
        transaction,
        withCapability(identity, INVENTORY_ADJUST),
        {
          commandId: context.commandId,
          commandVersion: 1,
          occurredOn: input.occurredOn,
          quantity: input.quantity,
          requestId: context.commandId,
          unitCost: input.unitCost,
          variantId: input.variantId,
        }
      );
      return {
        quantity: result.balance.quantity,
        variantId: input.variantId,
        version: result.balance.version,
      };
    },
    parse: (payload) => {
      const raw = asRecord(payload);
      const parsed: ReceivePayload = {
        occurredOn: requiredString(raw.occurredOn),
        quantity: requiredNumber(raw.quantity),
        unitCost: requiredString(raw.unitCost),
        variantId: requiredUuid(raw.variantId),
      };
      return validated(parsed, (value) =>
        normalizeReceiveStockInput({
          ...value,
          commandId: value.variantId,
          commandVersion: 1,
        })
      );
    },
    type: "stock.receive",
  };
}

interface WriteOffPayload {
  occurredOn: string;
  quantity: number;
  reasonCode: string;
  reasonNote: string | null;
  variantId: string;
}

export function createStockWriteOffHandler(
  dependencies: { writeOffStock: typeof writeOffStock } = { writeOffStock }
): SyncCommandHandler {
  return {
    capability: INVENTORY_ADJUST,
    classify: classifyStockError,
    async execute(transaction, identity, payload, context) {
      const input = payload as WriteOffPayload;
      const result = await dependencies.writeOffStock(
        transaction,
        withCapability(identity, INVENTORY_ADJUST),
        {
          commandId: context.commandId,
          commandVersion: 1,
          occurredOn: input.occurredOn,
          quantity: input.quantity,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote,
          requestId: context.commandId,
          variantId: input.variantId,
        }
      );
      return {
        quantity: result.balance.quantity,
        variantId: input.variantId,
        version: result.balance.version,
      };
    },
    parse: (payload) => {
      const raw = asRecord(payload);
      const parsed: WriteOffPayload = {
        occurredOn: requiredString(raw.occurredOn),
        quantity: requiredNumber(raw.quantity),
        reasonCode: requiredString(raw.reasonCode),
        reasonNote: optionalString(raw.reasonNote),
        variantId: requiredUuid(raw.variantId),
      };
      return validated(parsed, (value) =>
        normalizeWriteOffStockInput({
          ...value,
          commandId: value.variantId,
          commandVersion: 1,
        })
      );
    },
    type: "stock.write_off",
  };
}

interface CountPayload {
  occurredOn: string;
  physicalQuantity: number;
  valuationUnitCost: string | null;
  variantId: string;
}

export function createStockCountHandler(
  dependencies: { inventoryCount: typeof inventoryCount } = { inventoryCount }
): SyncCommandHandler {
  return {
    capability: INVENTORY_ADJUST,
    classify: classifyStockError,
    async execute(transaction, identity, payload, context) {
      const input = payload as CountPayload;
      if (
        context.baseVersion === null ||
        !Number.isInteger(context.baseVersion)
      ) {
        // a count is only meaningful against the balance version the device saw
        throw new InvalidSyncPayloadError();
      }
      const result = await dependencies.inventoryCount(
        transaction,
        withCapability(identity, INVENTORY_ADJUST),
        {
          commandId: context.commandId,
          commandVersion: 1,
          expectedVersion: context.baseVersion,
          occurredOn: input.occurredOn,
          physicalQuantity: input.physicalQuantity,
          requestId: context.commandId,
          valuationUnitCost: input.valuationUnitCost,
          variantId: input.variantId,
        }
      );
      return {
        quantity: result.balance.quantity,
        variantId: input.variantId,
        version: result.balance.version,
      };
    },
    parse: (payload) => {
      const raw = asRecord(payload);
      const parsed: CountPayload = {
        occurredOn: requiredString(raw.occurredOn),
        physicalQuantity: requiredNumber(raw.physicalQuantity),
        valuationUnitCost: optionalString(raw.valuationUnitCost),
        variantId: requiredUuid(raw.variantId),
      };
      return validated(parsed, (value) =>
        normalizeInventoryCountInput({
          ...value,
          commandId: value.variantId,
          commandVersion: 1,
          expectedVersion: 0,
        })
      );
    },
    type: "stock.count",
  };
}
