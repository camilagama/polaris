import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type {
  getInventoryBalance,
  InventoryBalanceEntry,
  inventoryCount,
  listInventoryBalances,
} from "@polaris/db/inventory-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface InventoryRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface InventoryRpcDependencies {
  getInventoryBalance: typeof getInventoryBalance | undefined;
  defaultGetInventoryBalance: typeof getInventoryBalance;
  inventoryCount: typeof inventoryCount | undefined;
  defaultInventoryCount: typeof inventoryCount;
  defaultListInventoryBalances: typeof listInventoryBalances;
  listInventoryBalances: typeof listInventoryBalances | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

function balanceEntryReadModel(entry: InventoryBalanceEntry) {
  return { ...entry, updatedAt: entry.updatedAt?.toISOString() ?? null };
}

function inventoryCountReadModel(
  result: Awaited<ReturnType<typeof inventoryCount>>
) {
  const { movement } = result;
  if (
    movement.commandId === null ||
    movement.commandVersion === null ||
    movement.expectedVersion === null ||
    movement.occurredOn === null ||
    movement.physicalQuantity === null ||
    movement.movementType !== "inventory_count"
  ) {
    throw new Error("inventory_count_movement_metadata_missing");
  }

  return {
    balance: result.balance,
    movement: {
      commandId: movement.commandId,
      commandIndex: movement.commandIndex,
      commandVersion: movement.commandVersion,
      createdAt: movement.createdAt.toISOString(),
      expectedVersion: movement.expectedVersion,
      id: movement.id,
      movementType: "inventory_count" as const,
      occurredOn: movement.occurredOn,
      organizationId: movement.organizationId,
      physicalQuantity: movement.physicalQuantity,
      productId: movement.productId,
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
      variantId: movement.variantId,
    },
    replayed: result.replayed,
  };
}

export function createInventoryRpcHandlers(
  dependencies: InventoryRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<InventoryRpcContext>();
  const getBalanceRepository =
    dependencies.getInventoryBalance ?? dependencies.defaultGetInventoryBalance;
  const countInventoryRepository =
    dependencies.inventoryCount ?? dependencies.defaultInventoryCount;
  const listBalancesRepository =
    dependencies.listInventoryBalances ??
    dependencies.defaultListInventoryBalances;

  const getBalance = implementContract.inventory.getBalance.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "inventory:read",
          operation: (transaction, identity) =>
            getBalanceRepository(transaction, identity, input.variantId),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  const count = implementContract.inventory.inventoryCount.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "inventory:adjust",
          operation: (transaction, identity) =>
            countInventoryRepository(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              expectedVersion: input.expectedVersion,
              occurredOn: input.occurredOn,
              physicalQuantity: input.physicalQuantity,
              requestId: dependencies.requestAuditId(context.requestId),
              valuationUnitCost: input.valuationUnitCost ?? null,
              variantId: input.variantId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .then(inventoryCountReadModel)
        .catch(dependencies.toRpcError)
  );

  const listBalances = implementContract.inventory.listBalances.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "inventory:read",
          operation: (transaction, identity) =>
            listBalancesRepository(transaction, identity, {
              cost: input.cost,
              cursor: input.cursor ?? null,
              includeArchived: input.productStatus === "all",
              limit: input.limit,
              query: input.query ?? null,
              stock: input.stock,
              variantIds: input.variantIds,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .then((result) => ({
          entries: result.entries.map(balanceEntryReadModel),
          nextCursor: result.nextCursor,
        }))
        .catch(dependencies.toRpcError)
  );

  return { count, getBalance, listBalances };
}
