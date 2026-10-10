import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { StockCommandConflictError } from "@polaris/domain/inventory/inventory";
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
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
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
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    inventory: {
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

describe("inventory RPCs", () => {
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
});
