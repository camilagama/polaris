import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ProductReadModel } from "@polaris/contracts";
import { CategoryInUseError } from "@polaris/domain/catalog/category";
import { ProductVersionConflictError } from "@polaris/domain/catalog/product";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

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

const requestIdPattern = /^[0-9a-f-]{36}$/i;

const identity = {
  capability: "product:create",
  organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
  role: "owner",
  userId: "verified-session-user",
};

const productRow = {
  archivedAt: null,
  categoryId: null,
  createdAt: new Date("2026-10-08T12:00:00.000Z"),
  description: "Lona resistente",
  id: "0199c2d0-0000-7000-8000-000000000001",
  name: "Bolsa",
  organizationId: identity.organizationId,
  updatedAt: new Date("2026-10-08T12:00:00.000Z"),
  version: 1,
};

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    category: {
      delete: (input: unknown) => Promise<unknown>;
    };
    product: {
      archive: (input: unknown) => Promise<{
        changed: boolean;
        product: ProductReadModel;
      }>;
      create: (input: unknown) => Promise<ProductReadModel>;
      list: (input: unknown) => Promise<{
        products: ProductReadModel[];
      }>;
      restore: (input: unknown) => Promise<{
        changed: boolean;
        product: ProductReadModel;
      }>;
      update: (input: unknown) => Promise<{
        changed: boolean;
        product: ProductReadModel;
      }>;
    };
  };
}

function tenantContext(dependencies: {
  capability?: string;
  operation: (
    transaction: unknown,
    authorizedIdentity: typeof identity
  ) => Promise<unknown>;
}) {
  return dependencies.operation({}, identity);
}

describe("product RPCs", () => {
  it("creates products with product:create and preserves duplicate names", async () => {
    const createProduct = vi.fn(
      async (
        _transaction: unknown,
        authorizedIdentity: typeof identity,
        input: { name: string; categoryId: string | null }
      ) => ({
        ...productRow,
        categoryId: input.categoryId,
        name: input.name,
        organizationId: authorizedIdentity.organizationId,
      })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      createProduct,
      withTenantRequestContext: (input: {
        capability: string;
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => {
        observedCapability = input.capability;
        return tenantContext(input);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    const first = await client.product.create({
      name: "Bolsa",
      organizationId: identity.organizationId,
    });
    const second = await client.product.create({
      name: "Bolsa",
      organizationId: identity.organizationId,
    });

    expect(first).toMatchObject({
      name: "Bolsa",
      organizationId: identity.organizationId,
      status: "active",
      version: 1,
    });
    expect(second.name).toBe(first.name);
    expect(observedCapability).toBe("product:create");
    expect(createProduct).toHaveBeenCalledTimes(2);
  });

  it("requires product:update and forwards the optimistic version", async () => {
    const updateProduct = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        input: { expectedVersion: number; name: string }
      ) => ({
        changed: true,
        product: { ...productRow, name: input.name, version: 2 },
      })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      updateProduct,
      withTenantRequestContext: (input: {
        capability: string;
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => {
        observedCapability = input.capability;
        return tenantContext(input);
      },
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    const result = await client.product.update({
      categoryId: null,
      description: null,
      expectedVersion: 1,
      id: productRow.id,
      name: "Bolsa nova",
      organizationId: identity.organizationId,
    });

    expect(result).toMatchObject({
      changed: true,
      product: { name: "Bolsa nova", version: 2 },
    });
    expect(observedCapability).toBe("product:update");
    expect(updateProduct).toHaveBeenCalledWith({}, identity, {
      categoryId: null,
      description: null,
      expectedVersion: 1,
      id: productRow.id,
      name: "Bolsa nova",
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("maps stale product updates to a conflict response", async () => {
    const router = createRpcRouter({
      updateProduct: () => Promise.reject(new ProductVersionConflictError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.update({
        categoryId: null,
        description: null,
        expectedVersion: 1,
        id: productRow.id,
        name: "Bolsa",
        organizationId: identity.organizationId,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps a category tombstone blocked by products to a conflict", async () => {
    const router = createRpcRouter({
      deleteCategory: () => Promise.reject(new CategoryInUseError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.category.delete({
        id: productRow.id,
        organizationId: identity.organizationId,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
