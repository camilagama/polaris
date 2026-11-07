import type {
  ProductImportRowInput,
  ProductImportRowResult,
} from "@polaris/contracts";
import { organizationToday } from "@polaris/db/inventory-repository";
import { lockProductNameAndFindProducts } from "@polaris/db/product-repository";
import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import {
  InvalidVariantListPriceError,
  normalizeProductName,
  ProductCategoryUnavailableError,
  ProductDescriptionError,
  ProductIdConflictError,
  ProductNameError,
} from "@polaris/domain/catalog/product";
import {
  InventoryQuantityLimitError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidUnitCostError,
  InventoryCostLimitError,
} from "@polaris/domain/inventory/inventory-cost";
import { InvalidInventoryCountInputError } from "@polaris/domain/inventory/inventory-count";
import { InvalidReceiveStockInputError } from "@polaris/domain/inventory/receive-stock";
import type { TenantTransactionRunner } from "../tenant-request-context";
import {
  type CreateProductWithOpeningStockDependencies,
  createProductWithOpeningStock,
  ProductCreateConflictError,
} from "./create-product-with-opening-stock";

/**
 * A slice of a spreadsheet import (corte 2.5): each row in its own transaction, by the same use case as
 * `product.create`, so a row is created with its variant and its opening stock together or not at all, and a row
 * with an error never stops the others. Inside the transaction of a row, before any write, the lock of the store
 * and the name and one read say whether a product of that name is already there (an archived one too, or an earlier
 * row of the same file): if so, the row is skipped. The repeat of the row itself (the same IDs sent again after a
 * lost answer) is told first, so a row that entered never comes back as "already exists".
 *
 * A refusal of the plan stops the slice: that row and the rest are `limit_reached` and none of them is tried. Any
 * error that is not about the row (the session, the membership, the database) stops the slice and is the caller's
 * to answer; the client sends the same slice again, and the rows that entered come back as `repeated`.
 */

type RowRefusal = Exclude<
  ProductImportRowResult,
  { status: "created" | "exists_by_name" | "limit_reached" | "repeated" }
>;
type RowRefusalWithoutNumber = RowRefusal extends infer R
  ? R extends RowRefusal
    ? Omit<R, "rowNumber">
    : never
  : never;

interface RefusalRule {
  errors: readonly (abstract new (...args: never[]) => Error)[];
  refusal: RowRefusalWithoutNumber;
}

/** The errors that belong to one row, and what the answer says of each: a code, never the value. */
const ROW_REFUSALS: readonly RefusalRule[] = [
  {
    errors: [ProductNameError],
    refusal: {
      field: "name",
      reason: "invalid_product_name",
      status: "invalid",
    },
  },
  {
    errors: [ProductDescriptionError],
    refusal: {
      field: "description",
      reason: "invalid_product_description",
      status: "invalid",
    },
  },
  {
    errors: [InvalidVariantListPriceError],
    refusal: {
      field: "listPrice",
      reason: "invalid_variant_list_price",
      status: "invalid",
    },
  },
  {
    errors: [InvalidUnitCostError, InventoryCostLimitError],
    refusal: {
      field: "unitCost",
      reason: "invalid_unit_cost",
      status: "invalid",
    },
  },
  {
    errors: [
      InvalidReceiveStockInputError,
      InvalidInventoryCountInputError,
      InventoryQuantityLimitError,
    ],
    refusal: {
      field: "quantity",
      reason: "invalid_quantity",
      status: "invalid",
    },
  },
  {
    // the category was archived or deleted after the preview
    errors: [ProductCategoryUnavailableError],
    refusal: {
      field: "category",
      reason: "product_category_unavailable",
      status: "invalid",
    },
  },
  {
    errors: [
      ProductCreateConflictError,
      ProductIdConflictError,
      StockCommandConflictError,
    ],
    refusal: { reason: "product_create_conflict", status: "conflict" },
  },
];

function rowRefusal(error: unknown): RowRefusalWithoutNumber | null {
  for (const rule of ROW_REFUSALS) {
    if (rule.errors.some((ErrorType) => error instanceof ErrorType)) {
      return rule.refusal;
    }
  }
  return null;
}

export interface ImportProductBatchDependencies {
  createProductWithOpeningStock: typeof createProductWithOpeningStock;
  creation: CreateProductWithOpeningStockDependencies;
  lockProductNameAndFindProducts: typeof lockProductNameAndFindProducts;
  organizationToday: typeof organizationToday;
}

export interface ImportProductBatchResult {
  /** The organization the transactions authorized (for the log); absent when no row reached a transaction. */
  organizationId: string | undefined;
  results: ProductImportRowResult[];
}

type RowOutcome =
  | { kind: "limit" }
  | { kind: "result"; result: ProductImportRowResult };

async function importRow(
  inTransaction: TenantTransactionRunner,
  row: ProductImportRowInput,
  requestId: string | null,
  dependencies: ImportProductBatchDependencies,
  authorized: (organizationId: string) => void
): Promise<RowOutcome> {
  try {
    const result = await inTransaction(
      async (transaction, identity): Promise<ProductImportRowResult> => {
        authorized(identity.organizationId);
        // the name is checked before it reaches a query: a character the database refuses is a refused row, not a fault
        const name = normalizeProductName(row.name);
        const holders = await dependencies.lockProductNameAndFindProducts(
          transaction,
          identity,
          name
        );
        const ownId = row.productId.toLowerCase();
        if (
          holders.length > 0 &&
          !holders.some((id) => id.toLowerCase() === ownId)
        ) {
          return { rowNumber: row.rowNumber, status: "exists_by_name" };
        }
        const created = await dependencies.createProductWithOpeningStock(
          transaction,
          identity,
          {
            categoryId: row.categoryId,
            description: row.description,
            initialStock: row.initialStock
              ? {
                  ...row.initialStock,
                  // the opening stock is dated today in the store's time zone, as in `product.create`
                  occurredOn: await dependencies.organizationToday(
                    transaction,
                    identity
                  ),
                }
              : null,
            listPrice: row.listPrice,
            name,
            productId: row.productId,
            requestId,
            variantId: row.variantId,
          },
          dependencies.creation
        );
        return {
          productId: created.product.id,
          rowNumber: row.rowNumber,
          status: created.repeated ? "repeated" : "created",
        };
      }
    );
    return { kind: "result", result };
  } catch (error) {
    if (error instanceof EntitlementLimitReachedError) {
      return { kind: "limit" };
    }
    const refusal = rowRefusal(error);
    if (refusal) {
      return {
        kind: "result",
        result: { ...refusal, rowNumber: row.rowNumber },
      };
    }
    throw error;
  }
}

export async function importProductBatch(
  inTransaction: TenantTransactionRunner,
  rows: readonly ProductImportRowInput[],
  options: { requestId: string | null },
  dependencies: ImportProductBatchDependencies
): Promise<ImportProductBatchResult> {
  const results: ProductImportRowResult[] = [];
  let organizationId: string | undefined;
  const authorized = (id: string) => {
    organizationId = id;
  };
  for (const [index, row] of rows.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one row after another, each in its own transaction on the one connection
    const outcome = await importRow(
      inTransaction,
      row,
      options.requestId,
      dependencies,
      authorized
    );
    if (outcome.kind === "limit") {
      // no row past the limit is tried: the rest of the slice did not enter for the same reason
      for (const rest of rows.slice(index)) {
        results.push({ rowNumber: rest.rowNumber, status: "limit_reached" });
      }
      break;
    }
    results.push(outcome.result);
  }
  return { organizationId, results };
}

export const defaultImportProductBatchDependencies = {
  createProductWithOpeningStock,
  lockProductNameAndFindProducts,
  organizationToday,
} satisfies Omit<ImportProductBatchDependencies, "creation">;
