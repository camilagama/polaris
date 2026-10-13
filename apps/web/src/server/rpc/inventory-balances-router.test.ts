import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { InvalidInventoryBalanceCursorError } from "@polaris/db/inventory-repository";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const identity = {
  capability: "inventory:read",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface TenantContextRequest {
  capability: string;
  operation: (
    transaction: unknown,
    authorizedIdentity: typeof identity
  ) => Promise<unknown>;
}

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

function createClient(overrides: Record<string, unknown>) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    inventory: {
      listBalances: (input: unknown) => Promise<{
        entries: Record<string, unknown>[];
        nextCursor: string | null;
      }>;
    };
  };
}

const entry = {
  isDefaultVariant: false,
  movingAverageCost: "12.340000",
  productId: "0199c2d0-0000-7000-8000-000000000001",
  productName: "Camiseta Polaris",
  productStatus: "active" as const,
  quantity: 3,
  sku: "CAM-AZ-M",
  updatedAt: new Date("2026-10-09T12:00:00.000Z"),
  values: [
    { optionName: "color" as const, optionValueName: "Azul" },
    { optionName: "size" as const, optionValueName: "M" },
  ],
  variantId: "0199c2d0-0000-7000-8000-000000000002",
  version: 2,
};

describe("inventory.listBalances", () => {
  it("reads with inventory:read, defaults the paging and serializes timestamps", async () => {
    const listInventoryBalances = vi.fn(
      async (
        _transaction: unknown,
        _identity: typeof identity,
        _options: unknown
      ) => ({
        entries: [
          entry,
          {
            ...entry,
            movingAverageCost: null,
            quantity: 0,
            updatedAt: null,
            variantId: "0199c2d0-0000-7000-8000-000000000003",
            version: 0,
          },
        ],
        nextCursor: "cursor-1",
      })
    );
    let observedCapability = "";
    const client = createClient({
      listInventoryBalances,
      withTenantRequestContext: (request: TenantContextRequest) => {
        observedCapability = request.capability;
        return request.operation({}, identity);
      },
    });

    const result = await client.inventory.listBalances({ organizationId });

    expect(observedCapability).toBe("inventory:read");
    expect(listInventoryBalances).toHaveBeenCalledWith({}, identity, {
      cursor: null,
      includeArchived: false,
      limit: 50,
      query: null,
      stock: "all",
    });
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.entries[0]).toMatchObject({
      movingAverageCost: "12.340000",
      productName: "Camiseta Polaris",
      quantity: 3,
      updatedAt: "2026-10-09T12:00:00.000Z",
    });
    expect(result.entries[1]).toMatchObject({
      movingAverageCost: null,
      quantity: 0,
      updatedAt: null,
      version: 0,
    });
  });

  it("forwards search, stock filter, archived scope, limit and cursor", async () => {
    const listInventoryBalances = vi.fn(async () => ({
      entries: [],
      nextCursor: null,
    }));
    const client = createClient({
      listInventoryBalances,
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    });

    await client.inventory.listBalances({
      cursor: "abc",
      limit: 20,
      organizationId,
      productStatus: "all",
      query: "  azul ",
      stock: "without_stock",
    });

    expect(listInventoryBalances).toHaveBeenCalledWith({}, identity, {
      cursor: "abc",
      includeArchived: true,
      limit: 20,
      query: "azul",
      stock: "without_stock",
    });
  });

  it("re-reads exactly the requested variants and rejects malformed ids", async () => {
    const listInventoryBalances = vi.fn(
      async (
        _transaction: unknown,
        _identity: typeof identity,
        _options: unknown
      ) => ({ entries: [], nextCursor: null })
    );
    const client = createClient({
      listInventoryBalances,
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    });
    const variantIds = [
      "0199c2d0-0000-7000-8000-000000000002",
      "0199c2d0-0000-7000-8000-000000000003",
    ];

    await client.inventory.listBalances({ organizationId, variantIds });
    expect(listInventoryBalances.mock.calls[0]?.[2]).toMatchObject({
      variantIds,
    });

    await expect(
      client.inventory.listBalances({
        organizationId,
        variantIds: ["not-a-uuid"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.inventory.listBalances({ organizationId, variantIds: [] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listInventoryBalances).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-range limit before reaching the repository", async () => {
    const listInventoryBalances = vi.fn();
    const client = createClient({
      listInventoryBalances,
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    });

    await expect(
      client.inventory.listBalances({ limit: 101, organizationId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listInventoryBalances).not.toHaveBeenCalled();
  });

  it("maps a malformed cursor to a 400 with a stable reason", async () => {
    const client = createClient({
      listInventoryBalances: () =>
        Promise.reject(new InvalidInventoryBalanceCursorError()),
      withTenantRequestContext: (request: TenantContextRequest) =>
        request.operation({}, identity),
    });

    await expect(
      client.inventory.listBalances({ cursor: "!!", organizationId })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "invalid_inventory_balance_cursor" },
    });
  });
});
