import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  InventoryVersionConflictError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const variantId = "0199c2d0-0000-7000-8000-000000000002";
const commandId = "0199c2d0-0000-7000-8000-000000000003";
const requestIdPattern = /^[0-9a-f-]{36}$/i;
const identity = {
  capability: "inventory:adjust",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
interface TenantContextRequest {
  capability: string;
  operation: (
    transaction: unknown,
    authorizedIdentity: typeof identity
  ) => Promise<unknown>;
}
const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

function createInventoryClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    headers: { origin: "https://polaris.example.invalid" },
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    inventory: {
      getBalance: (input: unknown) => Promise<{
        movingAverageCost: string | null;
        quantity: number;
        variantId: string;
        version: number;
      }>;
      inventoryCount: (input: unknown) => Promise<{
        balance: {
          movingAverageCost: string | null;
          quantity: number;
          variantId: string;
          version: number;
        };
        movement: {
          commandId: string;
          commandIndex: number;
          commandVersion: number;
          createdAt: string;
          expectedVersion: number;
          id: string;
          movementType: "inventory_count";
          occurredOn: string;
          organizationId: string;
          physicalQuantity: number;
          productId: string;
          quantityDelta: number;
          unitCost: string | null;
          variantId: string;
        };
        replayed: boolean;
      }>;
      receiveStock: (input: unknown) => Promise<{
        balance: {
          movingAverageCost: string | null;
          quantity: number;
          variantId: string;
          version: number;
        };
        movement: {
          commandId: string;
          commandIndex: number;
          commandVersion: number;
          createdAt: string;
          id: string;
          movementType: "receipt";
          occurredOn: string;
          organizationId: string;
          productId: string;
          quantityDelta: number;
          unitCost: string;
          variantId: string;
        };
        replayed: boolean;
      }>;
      writeOffStock: (input: unknown) => Promise<{
        balance: {
          movingAverageCost: string | null;
          quantity: number;
          variantId: string;
          version: number;
        };
        movement: {
          commandId: string;
          commandIndex: number;
          commandVersion: number;
          createdAt: string;
          id: string;
          movementType: "write_off";
          occurredOn: string;
          organizationId: string;
          productId: string;
          quantityDelta: number;
          reasonCode:
            | "damaged"
            | "expired"
            | "lost"
            | "stolen"
            | "internal_use"
            | "other";
          reasonNote: string | null;
          unitCost: string | null;
          variantId: string;
        };
        replayed: boolean;
      }>;
    };
  };
}

const input = {
  commandId,
  commandVersion: 1,
  occurredOn: "2026-10-09",
  organizationId,
  quantity: 3,
  unitCost: "12.345678",
  variantId,
};

const writeOffInput = {
  commandId: "0199c2d0-0000-7000-8000-000000000005",
  commandVersion: 1,
  occurredOn: "2026-10-09",
  organizationId,
  quantity: 2,
  reasonCode: "damaged" as const,
  reasonNote: "embalagem rasgada",
  variantId,
};

const inventoryCountInput = {
  commandId: "0199c2d0-0000-7000-8000-000000000007",
  commandVersion: 1,
  expectedVersion: 1,
  occurredOn: "2026-10-09",
  organizationId,
  physicalQuantity: 4,
  variantId,
};

describe("inventory RPCs", () => {
  it("reads a balance through inventory:read and returns the optimistic version", async () => {
    const balance = {
      movingAverageCost: null,
      quantity: 0,
      variantId,
      version: 0,
    };
    const getInventoryBalance = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        _variantId: string
      ) => balance
    );
    let observedCapability = "";
    const router = createRpcRouter({
      getInventoryBalance,
      withTenantRequestContext: (request: TenantContextRequest) => {
        observedCapability = request.capability;
        return request.operation({}, identity);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    await expect(
      client.inventory.getBalance({ organizationId, variantId })
    ).resolves.toEqual(balance);
    expect(observedCapability).toBe("inventory:read");
    expect(getInventoryBalance).toHaveBeenCalledWith({}, identity, variantId);
  });

  it("receives stock with inventory:adjust and forwards the audit request ID", async () => {
    const movement = {
      commandId,
      commandIndex: 0,
      commandVersion: 1,
      createdAt: new Date("2026-10-09T12:00:00.000Z"),
      id: "0199c2d0-0000-7000-8000-000000000004",
      movementType: "receipt" as const,
      occurredOn: "2026-10-09",
      organizationId,
      productId: "0199c2d0-0000-7000-8000-000000000001",
      quantityDelta: 3,
      unitCost: "12.345678",
      variantId,
    };
    const balance = {
      movingAverageCost: "12.345678",
      quantity: 3,
      variantId,
      version: 1,
    };
    const receiveStock = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        _input: {
          commandId: string;
          commandVersion: number;
          occurredOn: string;
          quantity: number;
          requestId: string | null;
          unitCost: string;
          variantId: string;
        }
      ) => ({ balance, movement, replayed: false })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      receiveStock,
      withTenantRequestContext: (request: TenantContextRequest) => {
        observedCapability = request.capability;
        return request.operation({}, identity);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    const result = await client.inventory.receiveStock(input);

    expect(result).toMatchObject({
      balance,
      movement: {
        commandId,
        commandIndex: 0,
        commandVersion: 1,
        createdAt: "2026-10-09T12:00:00.000Z",
        unitCost: "12.345678",
      },
      replayed: false,
    });
    expect(observedCapability).toBe("inventory:adjust");
    expect(receiveStock).toHaveBeenCalledWith({}, identity, {
      commandId: input.commandId,
      commandVersion: input.commandVersion,
      occurredOn: input.occurredOn,
      quantity: input.quantity,
      requestId: expect.stringMatching(requestIdPattern),
      unitCost: input.unitCost,
      variantId: input.variantId,
    });
  });

  it("maps reuse of a command ID with another payload to a conflict", async () => {
    const router = createRpcRouter({
      receiveStock: () => Promise.reject(new StockCommandConflictError()),
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    await expect(client.inventory.receiveStock(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("writes off stock with a structured reason and forwards the audit ID", async () => {
    const movement = {
      commandId: writeOffInput.commandId,
      commandIndex: 0,
      commandVersion: 1,
      createdAt: new Date("2026-10-09T12:00:00.000Z"),
      id: "0199c2d0-0000-7000-8000-000000000006",
      movementType: "write_off" as const,
      occurredOn: writeOffInput.occurredOn,
      organizationId,
      productId: "0199c2d0-0000-7000-8000-000000000001",
      quantityDelta: -2,
      reasonCode: writeOffInput.reasonCode,
      reasonNote: writeOffInput.reasonNote,
      unitCost: "12.345678",
      variantId,
    };
    const balance = {
      movingAverageCost: "12.345678",
      quantity: 1,
      variantId,
      version: 2,
    };
    const writeOffStock = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        _input: {
          commandId: string;
          commandVersion: number;
          occurredOn: string;
          quantity: number;
          reasonCode: string;
          reasonNote: string | null;
          requestId: string | null;
          variantId: string;
        }
      ) => ({ balance, movement, replayed: false })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      writeOffStock,
      withTenantRequestContext: (request: TenantContextRequest) => {
        observedCapability = request.capability;
        return request.operation({}, identity);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    const result = await client.inventory.writeOffStock(writeOffInput);

    expect(result).toMatchObject({
      balance,
      movement: {
        commandId: writeOffInput.commandId,
        commandIndex: 0,
        commandVersion: 1,
        createdAt: "2026-10-09T12:00:00.000Z",
        movementType: "write_off",
        quantityDelta: -2,
        reasonCode: "damaged",
        reasonNote: "embalagem rasgada",
        unitCost: "12.345678",
      },
      replayed: false,
    });
    expect(observedCapability).toBe("inventory:adjust");
    expect(writeOffStock).toHaveBeenCalledWith({}, identity, {
      commandId: writeOffInput.commandId,
      commandVersion: writeOffInput.commandVersion,
      occurredOn: writeOffInput.occurredOn,
      quantity: writeOffInput.quantity,
      reasonCode: writeOffInput.reasonCode,
      reasonNote: writeOffInput.reasonNote,
      requestId: expect.stringMatching(requestIdPattern),
      variantId: writeOffInput.variantId,
    });
  });

  it("requires a note when the structured reason is other", async () => {
    const client = createInventoryClient();

    await expect(
      client.inventory.writeOffStock({
        ...writeOffInput,
        reasonCode: "other",
        reasonNote: null,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects notes longer than 500 Unicode code points at the contract boundary", async () => {
    const client = createInventoryClient();

    await expect(
      client.inventory.writeOffStock({
        ...writeOffInput,
        reasonNote: "🙂".repeat(501),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("records an absolute count with its expected version and adjustment cost", async () => {
    const movement = {
      commandId: inventoryCountInput.commandId,
      commandIndex: 0,
      commandVersion: 1,
      createdAt: new Date("2026-10-09T12:00:00.000Z"),
      expectedVersion: inventoryCountInput.expectedVersion,
      id: "0199c2d0-0000-7000-8000-000000000008",
      movementType: "inventory_count" as const,
      occurredOn: inventoryCountInput.occurredOn,
      organizationId,
      physicalQuantity: inventoryCountInput.physicalQuantity,
      productId: "0199c2d0-0000-7000-8000-000000000001",
      quantityDelta: 1,
      unitCost: "12.345678",
      variantId,
    };
    const balance = {
      movingAverageCost: "12.345678",
      quantity: 4,
      variantId,
      version: 2,
    };
    const inventoryCount = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        _input: {
          commandId: string;
          commandVersion: number;
          expectedVersion: number;
          occurredOn: string;
          physicalQuantity: number;
          requestId: string | null;
          valuationUnitCost: string | null;
          variantId: string;
        }
      ) => ({ balance, movement, replayed: false })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      inventoryCount,
      withTenantRequestContext: (request: TenantContextRequest) => {
        observedCapability = request.capability;
        return request.operation({}, identity);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    await expect(
      client.inventory.inventoryCount(inventoryCountInput)
    ).resolves.toMatchObject({
      balance,
      movement: {
        commandId: inventoryCountInput.commandId,
        expectedVersion: inventoryCountInput.expectedVersion,
        movementType: "inventory_count",
        physicalQuantity: inventoryCountInput.physicalQuantity,
        quantityDelta: 1,
        unitCost: "12.345678",
      },
      replayed: false,
    });
    expect(observedCapability).toBe("inventory:adjust");
    expect(inventoryCount).toHaveBeenCalledWith({}, identity, {
      commandId: inventoryCountInput.commandId,
      commandVersion: 1,
      expectedVersion: inventoryCountInput.expectedVersion,
      occurredOn: inventoryCountInput.occurredOn,
      physicalQuantity: inventoryCountInput.physicalQuantity,
      requestId: expect.stringMatching(requestIdPattern),
      valuationUnitCost: null,
      variantId: inventoryCountInput.variantId,
    });
  });

  it("maps stale inventory count versions to a conflict", async () => {
    const router = createRpcRouter({
      inventoryCount: () => Promise.reject(new InventoryVersionConflictError()),
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createInventoryClient(router);

    await expect(
      client.inventory.inventoryCount(inventoryCountInput)
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects setting valuation for an empty physical count at the contract boundary", async () => {
    const client = createInventoryClient();

    await expect(
      client.inventory.inventoryCount({
        ...inventoryCountInput,
        physicalQuantity: 0,
        valuationUnitCost: "12.34",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
