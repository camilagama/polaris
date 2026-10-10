import { implement, ORPCError } from "@orpc/server";
import {
  type CategoryReadModel,
  type ProductReadModel,
  polarisContract,
} from "@polaris/contracts";
import {
  archiveCategory,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  restoreCategory,
} from "@polaris/db/category-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  deleteProduct,
  getProductVariants,
  listProducts,
  restoreProduct,
  setProductVariantSku,
  updateProduct,
} from "@polaris/db/product-repository";
import {
  getInventoryBalance,
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "@polaris/db/inventory-repository";
import { createDatabase } from "@polaris/db/client";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  CategoryDeletedError,
  CategoryInUseError,
  CategoryLifecycleError,
  CategoryNameConflictError,
  CategoryNameError,
  CategoryNotFoundError,
  deriveCategoryLifecycle,
} from "@polaris/domain/catalog/category";
import {
  ProductCategoryUnavailableError,
  ProductDeletedError,
  ProductDefaultVariantSkuConflictError,
  ProductLifecycleError,
  ProductNameError,
  ProductStockNotEmptyError,
  ProductNotFoundError,
  ProductVariantConfigurationError,
  ProductVariantNotFoundError,
  ProductVariantSkuConflictError,
  ProductVariantsAlreadyConfiguredError,
  ProductVersionConflictError,
  deriveProductLifecycle,
  type ProductVariantValues,
} from "@polaris/domain/catalog/product";
import {
  InsufficientStockError,
  InventoryQuantityLimitError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
  InvalidStockMovementError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidInventoryCountInputError,
  UnsupportedInventoryCountCommandVersionError,
} from "@polaris/domain/inventory/inventory-count";
import {
  InventoryCostLimitError,
  InventoryCostUnavailableError,
  InvalidUnitCostError,
} from "@polaris/domain/inventory/inventory-cost";
import {
  InvalidReceiveStockInputError,
  UnsupportedReceiveStockCommandVersionError,
} from "@polaris/domain/inventory/receive-stock";
import {
  InvalidWriteOffStockInputError,
  isWriteOffReasonCode,
  UnsupportedWriteOffStockCommandVersionError,
} from "@polaris/domain/inventory/write-off-stock";
import {
  type AuthenticatedRequestContextInput,
  withAuthenticatedRequestContext,
} from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import { createInventoryRpcHandlers } from "./inventory-handlers";
import { TenantRequestContextError } from "../request-context-error";
import {
  type TenantRequestContextInput,
  withTenantRequestContext,
} from "../tenant-request-context";
import {
  CreateInitialOrganizationError,
  createInitialOrganization,
} from "../use-cases/create-initial-organization";
import { pingSystem } from "../use-cases/system-ping";

export interface PolarisRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}
interface ProductLifecycleInput {
  expectedVersion: number;
  id: string;
  organizationId: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RpcRouterDependencies {
  archiveCategory: typeof archiveCategory;
  createCategory: typeof createCategory;
  createInitialOrganization: typeof createInitialOrganization;
  createOnboardingDatabase: typeof createDatabase;
  deleteCategory: typeof deleteCategory;
  archiveProduct: typeof archiveProduct;
  deleteProduct: typeof deleteProduct;
  configureProductVariants: typeof configureProductVariants;
  createProduct: typeof createProduct;
  getProductVariants: typeof getProductVariants;
  listProducts: typeof listProducts;
  restoreProduct: typeof restoreProduct;
  receiveStock: typeof receiveStock;
  getInventoryBalance: typeof getInventoryBalance;
  inventoryCount: typeof inventoryCount;
  writeOffStock: typeof writeOffStock;
  setProductVariantSku: typeof setProductVariantSku;
  updateProduct: typeof updateProduct;
  listCategories: typeof listCategories;
  renameCategory: typeof renameCategory;
  restoreCategory: typeof restoreCategory;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
}

function organizationStatus(status: string): "active" | "suspended" | "closed" {
  if (status === "active" || status === "suspended" || status === "closed") {
    return status;
  }
  throw new Error("invalid_organization_status");
}
function requestAuditId(requestId: string): string | null {
  return uuidPattern.test(requestId) ? requestId : null;
}

function categoryReadModel(category: {
  archivedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  id: string;
  name: string;
  organizationId: string;
  updatedAt: Date;
}): CategoryReadModel {
  return {
    archivedAt: category.archivedAt?.toISOString() ?? null,
    createdAt: category.createdAt.toISOString(),
    deletedAt: category.deletedAt?.toISOString() ?? null,
    id: category.id,
    name: category.name,
    organizationId: category.organizationId,
    status: deriveCategoryLifecycle(category.archivedAt, category.deletedAt),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function productReadModel(product: {
  archivedAt: Date | null;
  categoryId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  description: string | null;
  id: string;
  name: string;
  organizationId: string;
  updatedAt: Date;
  version: number;
}): ProductReadModel {
  return {
    archivedAt: product.archivedAt?.toISOString() ?? null,
    categoryId: product.categoryId,
    createdAt: product.createdAt.toISOString(),
    deletedAt: product.deletedAt?.toISOString() ?? null,
    description: product.description,
    id: product.id,
    name: product.name,
    organizationId: product.organizationId,
    status: deriveProductLifecycle(product.archivedAt, product.deletedAt),
    updatedAt: product.updatedAt.toISOString(),
    version: product.version,
  };
}

function productVariantValues(input: {
  color?: string | undefined;
  model?: string | undefined;
  size?: string | undefined;
}): ProductVariantValues {
  const values: ProductVariantValues = {};
  if (input.model !== undefined) {
    values.model = input.model;
  }
  if (input.color !== undefined) {
    values.color = input.color;
  }
  if (input.size !== undefined) {
    values.size = input.size;
  }
  return values;
}

function tenantContextErrorCode(
  code: TenantRequestContextError["code"]
): "UNAUTHORIZED" | "SERVICE_UNAVAILABLE" | "BAD_REQUEST" {
  if (code === "session_required") {
    return "UNAUTHORIZED";
  }
  if (code === "authentication_unavailable") {
    return "SERVICE_UNAVAILABLE";
  }
  return "BAD_REQUEST";
}
function initialOrganizationErrorCode(
  code: CreateInitialOrganizationError["code"]
):
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "INTERNAL_SERVER_ERROR" {
  switch (code) {
    case "email_not_verified":
      return "FORBIDDEN";
    case "user_not_found":
      return "UNAUTHORIZED";
    case "multiple_existing_organizations":
    case "organization_not_available":
      return "CONFLICT";
    case "invalid_user_id":
    case "invalid_organization_name":
    case "invalid_timezone":
      return "BAD_REQUEST";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

function toRpcError(error: unknown): never {
  if (error instanceof TenantRequestContextError) {
    throw new ORPCError(tenantContextErrorCode(error.code), { cause: error });
  }

  if (error instanceof TenantAuthorizationError) {
    throw new ORPCError("FORBIDDEN", { cause: error });
  }

  if (error instanceof CategoryNameError) {
    throw new ORPCError("BAD_REQUEST", { cause: error });
  }

  if (error instanceof ProductNameError) {
    throw new ORPCError("BAD_REQUEST", { cause: error });
  }

  if (
    error instanceof InvalidStockMovementError ||
    error instanceof InvalidUnitCostError ||
    error instanceof InventoryCostLimitError ||
    error instanceof InvalidReceiveStockInputError ||
    error instanceof UnsupportedReceiveStockCommandVersionError ||
    error instanceof InvalidInventoryCountInputError ||
    error instanceof UnsupportedInventoryCountCommandVersionError ||
    error instanceof InvalidWriteOffStockInputError ||
    error instanceof UnsupportedWriteOffStockCommandVersionError
  ) {
    throw new ORPCError("BAD_REQUEST", { cause: error });
  }

  if (
    error instanceof InsufficientStockError ||
    error instanceof InventoryQuantityLimitError ||
    error instanceof InventoryCostUnavailableError ||
    error instanceof StockCommandConflictError ||
    error instanceof InventoryVersionConflictError
  ) {
    throw new ORPCError("CONFLICT", { cause: error });
  }

  if (error instanceof ProductVariantConfigurationError) {
    throw new ORPCError("BAD_REQUEST", { cause: error });
  }

  if (
    error instanceof CategoryDeletedError ||
    error instanceof CategoryInUseError ||
    error instanceof CategoryNameConflictError ||
    error instanceof CategoryLifecycleError ||
    error instanceof ProductCategoryUnavailableError ||
    error instanceof ProductDeletedError ||
    error instanceof ProductLifecycleError ||
    error instanceof ProductStockNotEmptyError ||
    error instanceof ProductDefaultVariantSkuConflictError ||
    error instanceof ProductVariantSkuConflictError ||
    error instanceof ProductVariantsAlreadyConfiguredError ||
    error instanceof ProductVersionConflictError
  ) {
    throw new ORPCError("CONFLICT", { cause: error });
  }

  if (error instanceof CategoryNotFoundError) {
    throw new ORPCError("NOT_FOUND", { cause: error });
  }

  if (error instanceof ProductNotFoundError) {
    throw new ORPCError("NOT_FOUND", { cause: error });
  }

  if (error instanceof ProductVariantNotFoundError) {
    throw new ORPCError("NOT_FOUND", { cause: error });
  }

  if (error instanceof InventoryVariantNotFoundError) {
    throw new ORPCError("NOT_FOUND", { cause: error });
  }

  if (error instanceof CreateInitialOrganizationError) {
    throw new ORPCError(initialOrganizationErrorCode(error.code), {
      cause: error,
    });
  }

  throw error;
}
async function productLifecycleCommand(
  context: PolarisRpcContext,
  input: ProductLifecycleInput,
  tenantRequest: RpcRouterDependencies["withTenantRequestContext"],
  mutateProduct?: RpcRouterDependencies["archiveProduct"]
) {
  const command = mutateProduct ?? deleteProduct;
  try {
    const result = await tenantRequest({
      bindings: context.bindings,
      capability: "product:update",
      operation: (transaction, identity) =>
        command(transaction, identity, {
          expectedVersion: input.expectedVersion,
          id: input.id,
          requestId: requestAuditId(context.requestId),
        }),
      request: context.request,
      requestedOrganizationId: input.organizationId,
    });
    return {
      changed: result.changed,
      product: productReadModel(result.product),
    };
  } catch (error) {
    return toRpcError(error);
  }
}
export function createRpcRouter(
  overrides: Partial<RpcRouterDependencies> = {}
) {
  const authenticatedRequest =
    overrides.withAuthenticatedRequestContext ??
    withAuthenticatedRequestContext;
  const tenantRequest =
    overrides.withTenantRequestContext ?? withTenantRequestContext;
  const createOrganization =
    overrides.createInitialOrganization ?? createInitialOrganization;
  const createOnboardingDatabase =
    overrides.createOnboardingDatabase ?? createDatabase;
  const listTenantCategories = overrides.listCategories ?? listCategories;
  const createTenantCategory = overrides.createCategory ?? createCategory;
  const archiveTenantCategory = overrides.archiveCategory ?? archiveCategory;
  const restoreTenantCategory = overrides.restoreCategory ?? restoreCategory;
  const deleteTenantCategory = overrides.deleteCategory ?? deleteCategory;
  const renameTenantCategory = overrides.renameCategory ?? renameCategory;
  const listTenantProducts = overrides.listProducts ?? listProducts;
  const createTenantProduct = overrides.createProduct ?? createProduct;
  const getTenantProductVariants =
    overrides.getProductVariants ?? getProductVariants;
  const configureTenantProductVariants =
    overrides.configureProductVariants ?? configureProductVariants;
  const setTenantProductVariantSku =
    overrides.setProductVariantSku ?? setProductVariantSku;
  const updateTenantProduct = overrides.updateProduct ?? updateProduct;
  const archiveTenantProduct = overrides.archiveProduct ?? archiveProduct;

  const restoreTenantProduct = overrides.restoreProduct ?? restoreProduct;
  const receiveTenantStock = overrides.receiveStock ?? receiveStock;
  const writeOffTenantStock = overrides.writeOffStock ?? writeOffStock;
  const implementContract =
    implement(polarisContract).$context<PolarisRpcContext>();
  const inventoryHandlers = createInventoryRpcHandlers({
    defaultGetInventoryBalance: getInventoryBalance,
    defaultInventoryCount: inventoryCount,
    getInventoryBalance: overrides.getInventoryBalance,
    inventoryCount: overrides.inventoryCount,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });

  const ping = implementContract.system.ping.handler(() => pingSystem());

  const createInitial = implementContract.organization.createInitial.handler(
    async ({ context, input }) => {
      const authenticatedInput = {
        bindings: context.bindings,
        operation: async (_sessionDatabase, session) => {
          if (session.user.emailVerified !== true) {
            throw new CreateInitialOrganizationError("email_not_verified");
          }

          const connectionString =
            context.bindings.ONBOARDING_HYPERDRIVE?.connectionString;
          if (!connectionString) {
            throw new ORPCError("SERVICE_UNAVAILABLE");
          }

          const { db: onboardingDatabase, pool } = createOnboardingDatabase(
            connectionString,
            { maxConnections: 1 }
          );
          try {
            const { created, organization } = await createOrganization(
              onboardingDatabase,
              {
                authenticatedUserId: session.user.id,
                name: input.name,
                requestId: requestAuditId(context.requestId),
                timezone: input.timezone,
              }
            );

            return {
              created,
              organization: {
                currency: "BRL" as const,
                id: organization.id,
                name: organization.name,
                status: organizationStatus(organization.status),
                timezone: organization.timezone,
              },
            };
          } finally {
            await pool.end();
          }
        },
        request: context.request,
      } satisfies AuthenticatedRequestContextInput<{
        created: boolean;
        organization: {
          id: string;
          name: string;
          timezone: string;
          currency: "BRL";
          status: "active" | "suspended" | "closed";
        };
      }>;

      try {
        return await authenticatedRequest(authenticatedInput);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const list = implementContract.category.list.handler(
    async ({ context, input }) => {
      const tenantInput = {
        bindings: context.bindings,
        capability: "catalog:read",
        operation: async (transaction, identity) => ({
          categories: await listTenantCategories(transaction, identity, {
            status: input.status,
          }),
        }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      } satisfies TenantRequestContextInput<{
        categories: Awaited<ReturnType<typeof listTenantCategories>>;
      }>;

      try {
        const result = await tenantRequest(tenantInput);
        return { categories: result.categories.map(categoryReadModel) };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const create = implementContract.category.create.handler(
    async ({ context, input }) => {
      const tenantInput = {
        bindings: context.bindings,
        capability: "category:create",
        operation: async (transaction, identity) =>
          createTenantCategory(transaction, identity, {
            name: input.name,
            requestId: requestAuditId(context.requestId),
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      } satisfies TenantRequestContextInput<
        Awaited<ReturnType<typeof createTenantCategory>>
      >;

      try {
        return categoryReadModel(await tenantRequest(tenantInput));
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archive = implementContract.category.archive.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            archiveTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const restore = implementContract.category.restore.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            restoreTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const rename = implementContract.category.rename.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            renameTenantCategory(transaction, identity, {
              id: input.id,
              name: input.name,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const remove = implementContract.category.delete.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            deleteTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const listProduct = implementContract.product.list.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "catalog:read",
          operation: async (transaction, identity) => ({
            products: await listTenantProducts(transaction, identity, {
              status: input.status,
            }),
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return { products: result.products.map(productReadModel) };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const createProductRecord = implementContract.product.create.handler(
    async ({ context, input }) => {
      try {
        const product = await tenantRequest({
          bindings: context.bindings,
          capability: "product:create",
          operation: (transaction, identity) =>
            createTenantProduct(transaction, identity, {
              categoryId: input.categoryId ?? null,
              description: input.description ?? null,
              name: input.name,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return productReadModel(product);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const updateProductRecord = implementContract.product.update.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "product:update",
          operation: (transaction, identity) =>
            updateTenantProduct(transaction, identity, {
              categoryId: input.categoryId,
              description: input.description,
              expectedVersion: input.expectedVersion,
              id: input.id,
              name: input.name,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          product: productReadModel(result.product),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archiveProductRecord = implementContract.product.archive.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        archiveTenantProduct
      )
  );

  const deleteProductRecord = implementContract.product.delete.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        overrides.deleteProduct
      )
  );

  const restoreProductRecord = implementContract.product.restore.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        restoreTenantProduct
      )
  );
  const getProductVariantsRecord =
    implementContract.product.getVariants.handler(
      async ({ context, input }) => {
        try {
          return await tenantRequest({
            bindings: context.bindings,
            capability: "catalog:read",
            operation: (transaction, identity) =>
              getTenantProductVariants(transaction, identity, input.id),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const configureProductVariantsRecord =
    implementContract.product.configureVariants.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "product:update",
            operation: (transaction, identity) =>
              configureTenantProductVariants(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.id,
                options: input.options,
                requestId: requestAuditId(context.requestId),
                variants: input.variants.map((variant) => ({
                  values: productVariantValues(variant.values),
                })),
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            configuration: result.configuration,
            product: productReadModel(result.product),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const setProductVariantSkuRecord =
    implementContract.product.setVariantSku.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "product:update",
            operation: (transaction, identity) =>
              setTenantProductVariantSku(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.productId,
                requestId: requestAuditId(context.requestId),
                sku: input.sku,
                variantId: input.variantId,
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            changed: result.changed,
            configuration: result.configuration,
            product: productReadModel(result.product),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const receiveStockRecord = implementContract.inventory.receiveStock.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "inventory:adjust",
          operation: (transaction, identity) =>
            receiveTenantStock(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              occurredOn: input.occurredOn,
              quantity: input.quantity,
              requestId: requestAuditId(context.requestId),
              unitCost: input.unitCost,
              variantId: input.variantId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });

        const { movement } = result;
        if (
          movement.commandId === null ||
          movement.commandVersion === null ||
          movement.occurredOn === null ||
          movement.unitCost === null ||
          movement.movementType !== "receipt"
        ) {
          throw new Error("received_stock_movement_metadata_missing");
        }

        return {
          balance: result.balance,
          movement: {
            ...movement,
            // The guard above proves these receipt-only nullable DB columns.
            commandId: movement.commandId as string,
            commandVersion: movement.commandVersion as number,
            createdAt: movement.createdAt.toISOString(),
            movementType: "receipt" as const,
            occurredOn: movement.occurredOn as string,
            unitCost: movement.unitCost as string,
          },
          replayed: result.replayed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const writeOffStockRecord = implementContract.inventory.writeOffStock.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "inventory:adjust",
          operation: (transaction, identity) =>
            writeOffTenantStock(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              occurredOn: input.occurredOn,
              quantity: input.quantity,
              reasonCode: input.reasonCode,
              reasonNote: input.reasonNote ?? null,
              requestId: requestAuditId(context.requestId),
              variantId: input.variantId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });

        const { movement } = result;
        if (
          movement.commandId === null ||
          movement.commandVersion === null ||
          movement.occurredOn === null ||
          movement.reasonCode === null ||
          !isWriteOffReasonCode(movement.reasonCode) ||
          movement.movementType !== "write_off"
        ) {
          throw new Error("written_off_stock_movement_metadata_missing");
        }

        return {
          balance: result.balance,
          movement: {
            ...movement,
            commandId: movement.commandId,
            commandVersion: movement.commandVersion,
            createdAt: movement.createdAt.toISOString(),
            movementType: "write_off" as const,
            occurredOn: movement.occurredOn,
            reasonCode: movement.reasonCode,
          },
          replayed: result.replayed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  return implementContract.router({
    category: { archive, create, delete: remove, list, rename, restore },
    inventory: {
      getBalance: inventoryHandlers.getBalance,
      inventoryCount: inventoryHandlers.count,
      receiveStock: receiveStockRecord,
      writeOffStock: writeOffStockRecord,
    },
    organization: { createInitial },
    product: {
      archive: archiveProductRecord,
      configureVariants: configureProductVariantsRecord,
      create: createProductRecord,
      delete: deleteProductRecord,
      getVariants: getProductVariantsRecord,
      list: listProduct,
      restore: restoreProductRecord,
      setVariantSku: setProductVariantSkuRecord,
      update: updateProductRecord,
    },
    system: { ping },
  });
}

export const rpcRouter = createRpcRouter();
