import { implement } from "@orpc/server";
import {
  type ProductImportRowStatus,
  polarisContract,
} from "@polaris/contracts";
import { findExistingProductNames } from "@polaris/db/product-repository";
import { hasForbiddenProductText } from "@polaris/domain/catalog/product";
import { logger, opaqueId } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import type {
  withTenantRequestContext,
  withTenantRequestSequence,
} from "../tenant-request-context";
import type { CreateProductWithOpeningStockDependencies } from "../use-cases/create-product-with-opening-stock";
import {
  defaultImportProductBatchDependencies,
  type ImportProductBatchDependencies,
  importProductBatch,
} from "../use-cases/import-product-batch";

interface ProductImportRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface ProductImportRpcDependencies {
  /** The repositories of the creation of each row: the same ones `product.create` uses (tests give fakes). */
  creation: CreateProductWithOpeningStockDependencies;
  findExistingProductNames: typeof findExistingProductNames | undefined;
  importProductBatch:
    | Partial<Omit<ImportProductBatchDependencies, "creation">>
    | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
  withTenantRequestSequence: typeof withTenantRequestSequence;
}

const STATUSES: readonly ProductImportRowStatus[] = [
  "created",
  "repeated",
  "exists_by_name",
  "limit_reached",
  "invalid",
  "conflict",
];

/** How many rows of the slice ended in each status: the only thing of an import the log says (AC-7). */
function statusCounts(
  results: readonly { status: ProductImportRowStatus }[]
): Record<ProductImportRowStatus, number> {
  const counts = Object.fromEntries(
    STATUSES.map((status) => [status, 0])
  ) as Record<ProductImportRowStatus, number>;
  for (const { status } of results) {
    counts[status] += 1;
  }
  return counts;
}

/**
 * The import of a spreadsheet (corte 2.5): `importBatch` creates a slice of rows the browser read, each in its own
 * transaction under `product:create`, and `namesExisting` tells the preview which names the store already has.
 * The file never reaches the server; the log of a slice has the counts, the import, the request and the opaque
 * organization, never a name, a value or a description.
 */
export function createProductImportRpcHandlers(
  dependencies: ProductImportRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<ProductImportRpcContext>();
  const batchDependencies: ImportProductBatchDependencies = {
    ...defaultImportProductBatchDependencies,
    ...dependencies.importProductBatch,
    creation: dependencies.creation,
  };
  const findNames =
    dependencies.findExistingProductNames ?? findExistingProductNames;

  const importBatch = implementContract.product.importBatch.handler(
    async ({ context, input }) => {
      try {
        const { organizationId, results } =
          await dependencies.withTenantRequestSequence({
            bindings: context.bindings,
            capability: "product:create",
            operation: (inTransaction) =>
              importProductBatch(
                inTransaction,
                input.rows,
                { requestId: dependencies.requestAuditId(context.requestId) },
                batchDependencies
              ),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
        logger.info("product_import_batch", {
          ...statusCounts(results),
          importId: input.importId,
          organizationId: opaqueId(organizationId),
          requestId: context.requestId,
          rows: input.rows.length,
        });
        return { results };
      } catch (error) {
        return dependencies.toRpcError(error);
      }
    }
  );

  const namesExisting = implementContract.product.namesExisting.handler(
    async ({ context, input }) => {
      // a name no product can hold is never asked: it cannot exist, and it never reaches a query
      const names = [...new Set(input.names.map((name) => name.trim()))].filter(
        (name) => name !== "" && !hasForbiddenProductText(name)
      );
      try {
        return {
          names: await dependencies.withTenantRequestContext({
            bindings: context.bindings,
            capability: "catalog:read",
            operation: (transaction, identity) =>
              findNames(transaction, identity, names),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          }),
        };
      } catch (error) {
        return dependencies.toRpcError(error);
      }
    }
  );

  return { importBatch, namesExisting };
}
