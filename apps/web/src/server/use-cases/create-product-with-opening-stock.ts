import { inventoryCount, receiveStock } from "@polaris/db/inventory-repository";
import {
  createProduct,
  type ProductCreationRecord,
  readProductCreation,
} from "@polaris/db/product-repository";
import {
  requireCapabilityInTransaction,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withCapability,
} from "@polaris/db/tenant-transaction";
import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import {
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductVariantSku,
  normalizeVariantListPrice,
  ProductIdConflictError,
} from "@polaris/domain/catalog/product";
import { normalizeUnitCost } from "@polaris/domain/inventory/inventory-cost";
import { normalizeOpeningStockInput } from "@polaris/domain/inventory/opening-stock";

/**
 * A product with its default variant and, when the person says how many they have, the opening stock: ONE use case
 * for the RPC `product.create` and for the `product.create` command of the sync, so the two cannot drift apart. The
 * caller's transaction is the unit of atomicity (ADR 0035): any error rolls back the product, the variant, the
 * balance, the movement and the audit events together.
 *
 * The product, the variant and the stock command are named by the caller once per opening of the form, so a retry
 * after a network failure (the first try committed, the answer was lost) names them again: the repeat is told
 * from a conflicting one by reading what was stored, and nothing is written twice.
 */

const PRODUCT_CREATE = "product:create";
const INVENTORY_ADJUST = "inventory:adjust";
const VALIDATION_VARIANT_ID = "00000000-0000-7000-8000-000000000000";

interface OpeningStockRequest {
  /** The ledger command the movement is recorded under; the retry of one form sends the same. */
  commandId: string;
  /**
   * The date of the opening stock: the RPC passes today in the store's time zone (read on the server), the sync
   * passes the date the device wrote in the command.
   */
  occurredOn: string;
  quantity: number;
  /** BRL cost of each unit as decimal text; `null` when the person does not know it. */
  unitCost: string | null;
}

export interface CreateProductWithOpeningStockInput {
  categoryId?: string | null | undefined;
  description?: string | null | undefined;
  initialStock?: OpeningStockRequest | null | undefined;
  listPrice?: string | null | undefined;
  name: string;
  productId?: string | undefined;
  requestId?: string | null | undefined;
  sku?: string | null | undefined;
  variantId?: string | undefined;
}

export interface CreateProductWithOpeningStockResult {
  initialQuantity: number;
  product: ProductCreationRecord["product"];
  /** The same product was already created with the same data: nothing was written now. */
  repeated: boolean;
  /** `null` only when the caller did not name the variant and no stock needed it. */
  variantId: string | null;
}

/** The same `productId` came with other data than the one stored: the retry is not a retry. */
export class ProductCreateConflictError extends Error {
  readonly code = "product_create_conflict";

  constructor() {
    super("product_create_conflict");
    this.name = "ProductCreateConflictError";
  }
}

export interface CreateProductWithOpeningStockDependencies {
  createProduct: typeof createProduct;
  inventoryCount: typeof inventoryCount;
  readProductCreation: typeof readProductCreation;
  receiveStock: typeof receiveStock;
}

const defaultDependencies: CreateProductWithOpeningStockDependencies = {
  createProduct,
  inventoryCount,
  readProductCreation,
  receiveStock,
};

interface WantedCreation {
  categoryId: string | null;
  description: string | null;
  listPrice: string | null;
  name: string;
  opening: { quantity: number; unitCost: string | null } | null;
  sku: string | null;
  variantId: string | undefined;
}

function sameCost(stored: string | null, wanted: string | null): boolean {
  if (stored === null || wanted === null) {
    return stored === wanted;
  }
  return normalizeUnitCost(stored) === normalizeUnitCost(wanted);
}

function samePrice(stored: string | null, wanted: string | null): boolean {
  if (stored === null || wanted === null) {
    return stored === wanted;
  }
  return normalizeVariantListPrice(stored) === wanted;
}

function sameCreation(
  record: ProductCreationRecord,
  wanted: WantedCreation
): boolean {
  const { opening, product, variant } = record;
  if (
    product.name !== wanted.name ||
    (product.description ?? null) !== wanted.description ||
    (product.categoryId ?? null) !== wanted.categoryId ||
    (variant.sku ?? null) !== wanted.sku ||
    !samePrice(variant.listPrice, wanted.listPrice) ||
    (wanted.variantId !== undefined && variant.id !== wanted.variantId)
  ) {
    return false;
  }
  if (opening === null || wanted.opening === null) {
    return opening === wanted.opening;
  }
  return (
    opening.quantity === wanted.opening.quantity &&
    sameCost(opening.unitCost, wanted.opening.unitCost)
  );
}

function repeatedResult(
  record: ProductCreationRecord,
  wanted: WantedCreation
): CreateProductWithOpeningStockResult {
  if (!sameCreation(record, wanted)) {
    throw new ProductCreateConflictError();
  }
  return {
    initialQuantity: wanted.opening?.quantity ?? 0,
    product: record.product,
    repeated: true,
    variantId: record.variant.id,
  };
}

type Stock = NonNullable<ReturnType<typeof normalizeOpeningStockInput>>;

/** What the caller wants, validated before the first write (the stock with the variant it will be recorded on). */
function wantedCreation(input: CreateProductWithOpeningStockInput): {
  stock: Stock | null;
  wanted: WantedCreation;
} {
  const { initialStock: request } = input;
  // a variant the database will name is stood in for by a valid ID, only to validate the rest of the stock
  const stock = request
    ? normalizeOpeningStockInput({
        commandId: request.commandId,
        occurredOn: request.occurredOn,
        quantity: request.quantity,
        unitCost: request.unitCost,
        variantId: input.variantId ?? VALIDATION_VARIANT_ID,
      })
    : null;
  return {
    stock,
    wanted: {
      categoryId: input.categoryId ?? null,
      description: normalizeProductDescription(input.description),
      listPrice: normalizeVariantListPrice(input.listPrice),
      name: normalizeProductName(input.name),
      opening: stock
        ? { quantity: stock.quantity, unitCost: stock.unitCost }
        : null,
      sku: normalizeProductVariantSku(input.sku),
      variantId: input.variantId,
    },
  };
}

/** Whether a refusal of the creation may be the answer to a retry whose first try was saved. */
function mayBeRepeat(
  input: CreateProductWithOpeningStockInput,
  error: unknown
): input is CreateProductWithOpeningStockInput & { productId: string } {
  return (
    input.productId !== undefined &&
    (error instanceof ProductIdConflictError ||
      // a plan at its limit refuses the new variant before it meets the ID, and the product of this very retry is the one that filled it
      error instanceof EntitlementLimitReachedError)
  );
}

type Created =
  | { kind: "created"; product: ProductCreationRecord["product"] }
  | { kind: "repeated"; result: CreateProductWithOpeningStockResult };

async function createOrRepeat(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductWithOpeningStockInput,
  wanted: WantedCreation,
  dependencies: CreateProductWithOpeningStockDependencies
): Promise<Created> {
  try {
    const product = await dependencies.createProduct(transaction, identity, {
      categoryId: wanted.categoryId,
      ...(input.variantId === undefined
        ? {}
        : { defaultVariantId: input.variantId }),
      description: wanted.description,
      ...(input.productId === undefined ? {} : { id: input.productId }),
      listPrice: wanted.listPrice,
      name: wanted.name,
      requestId: input.requestId ?? null,
      sku: wanted.sku,
    });
    return { kind: "created", product };
  } catch (error) {
    if (mayBeRepeat(input, error)) {
      const stored = await dependencies.readProductCreation(
        transaction,
        identity,
        { productId: input.productId, variantId: input.variantId }
      );
      if (stored) {
        // never the stock commands here: the stock of the first try is the one recorded
        return { kind: "repeated", result: repeatedResult(stored, wanted) };
      }
    }
    throw error;
  }
}

/** The stock of a product just created: a receipt with a cost, or a count from zero when the cost is unknown. */
async function recordOpeningStock(
  transaction: TenantRequestTransaction,
  stockIdentity: TenantRequestIdentity,
  stock: Stock,
  names: { requestId: string | null; variantId: string },
  dependencies: CreateProductWithOpeningStockDependencies
): Promise<void> {
  const { requestId, variantId } = names;
  if (stock.unitCost === null) {
    // a receipt always carries a cost; without one the stock opens as a count from zero, with the cost unknown
    await dependencies.inventoryCount(transaction, stockIdentity, {
      commandId: stock.commandId,
      commandVersion: 1,
      expectedVersion: 0,
      occurredOn: stock.occurredOn,
      physicalQuantity: stock.quantity,
      requestId,
      valuationUnitCost: null,
      variantId,
    });
    return;
  }
  await dependencies.receiveStock(transaction, stockIdentity, {
    commandId: stock.commandId,
    commandVersion: 1,
    occurredOn: stock.occurredOn,
    quantity: stock.quantity,
    requestId,
    unitCost: stock.unitCost,
    variantId,
  });
}

/** The ID of the default variant the database named, when the caller did not. */
async function namedVariantId(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  productId: string,
  dependencies: CreateProductWithOpeningStockDependencies
): Promise<string> {
  const created = await dependencies.readProductCreation(
    transaction,
    identity,
    { productId }
  );
  if (!created) {
    throw new Error("product_variant_missing_after_create");
  }
  return created.variant.id;
}

/**
 * The creation, in this order (§3.1 of the design): both capabilities are checked BEFORE any write, so a role
 * that cannot adjust stock leaves no orphan product; then the product with its variant and price; then the
 * stock. `occurredOn` is the date of the opening stock: the RPC passes today in the store's time zone (read on
 * the server), the sync passes the date the device wrote in the command.
 */
export async function createProductWithOpeningStock(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductWithOpeningStockInput,
  dependencies: CreateProductWithOpeningStockDependencies = defaultDependencies
): Promise<CreateProductWithOpeningStockResult> {
  requireCapabilityInTransaction(identity, PRODUCT_CREATE);
  if (input.initialStock) {
    requireCapabilityInTransaction(identity, INVENTORY_ADJUST);
  }
  const { stock, wanted } = wantedCreation(input);

  const created = await createOrRepeat(
    transaction,
    identity,
    input,
    wanted,
    dependencies
  );
  if (created.kind === "repeated") {
    return created.result;
  }
  const { product } = created;
  if (!stock) {
    return {
      initialQuantity: 0,
      product,
      repeated: false,
      variantId: input.variantId ?? null,
    };
  }
  const variantId =
    input.variantId ??
    (await namedVariantId(transaction, identity, product.id, dependencies));
  // the stock repositories keep their own capability check, which the role answered above
  await recordOpeningStock(
    transaction,
    withCapability(identity, INVENTORY_ADJUST),
    stock,
    { requestId: input.requestId ?? null, variantId },
    dependencies
  );
  return {
    initialQuantity: stock.quantity,
    product,
    repeated: false,
    variantId,
  };
}
