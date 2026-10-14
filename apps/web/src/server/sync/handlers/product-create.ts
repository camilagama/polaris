import { receiveStock } from "@polaris/db/inventory-repository";
import { createProduct } from "@polaris/db/product-repository";
import {
  InvalidProductIdError,
  InvalidVariantListPriceError,
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductVariantSku,
  normalizeVariantListPrice,
  ProductCategoryUnavailableError,
  ProductDescriptionError,
  ProductIdConflictError,
  ProductNameError,
  ProductVariantSkuConflictError,
} from "@polaris/domain/catalog/product";
import {
  InventoryOccurredInFutureError,
  InventoryQuantityLimitError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidUnitCostError,
  InventoryCostLimitError,
} from "@polaris/domain/inventory/inventory-cost";
import {
  InvalidReceiveStockInputError,
  normalizeReceiveStockInput,
} from "@polaris/domain/inventory/receive-stock";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../push";

/**
 * `product.create` (plan PR55): a product with its default variant and, when the
 * device says so, the opening stock, all in the one transaction the sync frame
 * opens: either everything exists afterwards or nothing does. The device names
 * the product and the variant (UUIDs it generated), so sales and stock commands
 * queued behind this one can already refer to them.
 */
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface InitialStockPayload {
  occurredOn: string;
  quantity: number;
  unitCost: string;
}

interface ProductCreatePayload {
  categoryId: string | null;
  description: string | null;
  initialStock: InitialStockPayload | null;
  listPrice: string | null;
  name: string;
  productId: string;
  sku: string | null;
  variantId: string;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function parseInitialStock(value: unknown): InitialStockPayload | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSyncPayloadError();
  }
  const { occurredOn, quantity, unitCost } = value as Record<string, unknown>;
  if (
    typeof occurredOn !== "string" ||
    typeof quantity !== "number" ||
    typeof unitCost !== "string"
  ) {
    throw new InvalidSyncPayloadError();
  }
  return { occurredOn, quantity, unitCost };
}

const payloadErrors = [
  InvalidProductIdError,
  InvalidReceiveStockInputError,
  InvalidUnitCostError,
  InvalidVariantListPriceError,
  InventoryCostLimitError,
  InventoryQuantityLimitError,
  ProductDescriptionError,
  ProductNameError,
];

function isPayloadError(error: unknown): boolean {
  return payloadErrors.some((type) => error instanceof type);
}

function parsePayload(payload: unknown): ProductCreatePayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidSyncPayloadError();
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.name !== "string") {
    throw new InvalidSyncPayloadError();
  }
  const productId = requiredUuid(raw.productId);
  const variantId = requiredUuid(raw.variantId);
  const categoryId = optionalString(raw.categoryId);
  if (categoryId !== null) {
    requiredUuid(categoryId);
  }
  const parsed: ProductCreatePayload = {
    categoryId,
    description: optionalString(raw.description),
    initialStock: parseInitialStock(raw.initialStock),
    listPrice: optionalString(raw.listPrice),
    name: raw.name,
    productId,
    sku: optionalString(raw.sku),
    variantId,
  };
  try {
    normalizeProductName(parsed.name);
    normalizeProductDescription(parsed.description);
    normalizeProductVariantSku(parsed.sku);
    normalizeVariantListPrice(parsed.listPrice);
    if (parsed.initialStock) {
      normalizeReceiveStockInput({
        commandId: productId,
        commandVersion: 1,
        occurredOn: parsed.initialStock.occurredOn,
        quantity: parsed.initialStock.quantity,
        unitCost: parsed.initialStock.unitCost,
        variantId,
      });
    }
  } catch (error) {
    if (isPayloadError(error)) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new InvalidSyncPayloadError({ cause: error });
    }
    throw error;
  }
  return parsed;
}

const INVENTORY_ADJUST = "inventory:adjust";

const PRODUCT_CREATE_CODES = {
  categoryUnavailable: "category_unavailable",
  dateInFuture: "inventory_date_in_future",
  invalidPayload: "invalid_payload",
  productIdConflict: "product_id_conflict",
  skuConflict: "sku_conflict",
} as const;

export function createProductCreateHandler(
  dependencies: {
    createProduct: typeof createProduct;
    receiveStock: typeof receiveStock;
  } = { createProduct, receiveStock }
): SyncCommandHandler {
  return {
    capability: "product:create",
    classify: (error) => {
      if (error instanceof ProductIdConflictError) {
        return PRODUCT_CREATE_CODES.productIdConflict;
      }
      if (error instanceof ProductVariantSkuConflictError) {
        return PRODUCT_CREATE_CODES.skuConflict;
      }
      if (error instanceof ProductCategoryUnavailableError) {
        return PRODUCT_CREATE_CODES.categoryUnavailable;
      }
      if (error instanceof InventoryOccurredInFutureError) {
        return PRODUCT_CREATE_CODES.dateInFuture;
      }
      return isPayloadError(error) ? PRODUCT_CREATE_CODES.invalidPayload : null;
    },
    async execute(transaction, identity, payload, context) {
      const input = payload as ProductCreatePayload;
      const product = await dependencies.createProduct(transaction, identity, {
        categoryId: input.categoryId,
        defaultVariantId: input.variantId,
        description: input.description,
        id: input.productId,
        listPrice: input.listPrice,
        name: input.name,
        requestId: context.commandId,
        sku: input.sku,
      });
      if (input.initialStock) {
        // The lease and the role granted `inventory:adjust` (see `extraCapabilities`).
        await dependencies.receiveStock(
          transaction,
          { ...identity, capability: INVENTORY_ADJUST },
          {
            commandId: context.commandId,
            commandVersion: 1,
            occurredOn: input.initialStock.occurredOn,
            quantity: input.initialStock.quantity,
            requestId: context.commandId,
            unitCost: input.initialStock.unitCost,
            variantId: input.variantId,
          }
        );
      }
      return {
        initialQuantity: input.initialStock?.quantity ?? 0,
        productId: product.id,
        variantId: input.variantId,
        version: product.version,
      };
    },
    extraCapabilities: (payload) =>
      (payload as ProductCreatePayload).initialStock ? [INVENTORY_ADJUST] : [],
    parse: parsePayload,
    type: "product.create",
  };
}
