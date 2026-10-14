import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { CategoryInUseError } from "@polaris/domain/catalog/category";
import {
  InvalidVariantListPriceError,
  ProductDefaultVariantSkuConflictError,
  ProductDefaultVariantStockHistoryConflictError,
  ProductStockNotEmptyError,
  ProductVariantConfigurationError,
  ProductVariantSkuConflictError,
  ProductVersionConflictError,
} from "@polaris/domain/catalog/product";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
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
  deletedAt: null,
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
    headers: { origin: "https://polaris.example.invalid" },
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
      delete: (input: unknown) => Promise<{
        changed: boolean;
        product: ProductReadModel;
      }>;
      create: (input: unknown) => Promise<ProductReadModel>;
      configureVariants: (input: unknown) => Promise<{
        configuration: ProductVariantConfigurationReadModel;
        product: ProductReadModel;
      }>;
      getVariants: (
        input: unknown
      ) => Promise<ProductVariantConfigurationReadModel>;
      setVariantSku: (input: unknown) => Promise<{
        changed: boolean;
        configuration: ProductVariantConfigurationReadModel;
        product: ProductReadModel;
      }>;
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
  it("reads product variants with catalog:read", async () => {
    const configuration: ProductVariantConfigurationReadModel = {
      configured: false,
      options: [],
      productVersion: 1,
      variants: [
        {
          id: "0199c2d0-0000-7000-8000-000000000002",
          isDefault: true,
          listPrice: null,
          position: null,
          sku: null,
          values: [],
        },
      ],
    };
    const getProductVariants = vi.fn(
      (_transaction: unknown, _identity: typeof identity, id: string) => {
        expect(id).toBe(productRow.id);
        return Promise.resolve(configuration);
      }
    );
    let observedCapability = "";
    const router = createRpcRouter({
      getProductVariants,
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

    await expect(
      client.product.getVariants({
        id: productRow.id,
        organizationId: identity.organizationId,
      })
    ).resolves.toEqual(configuration);
    expect(observedCapability).toBe("catalog:read");
    expect(getProductVariants).toHaveBeenCalledTimes(1);
  });

  it("configures variants with product:update and the optimistic version", async () => {
    const configuration: ProductVariantConfigurationReadModel = {
      configured: true,
      options: [
        {
          id: "0199c2d0-0000-7000-8000-000000000003",
          name: "model",
          position: 0,
          values: [
            {
              id: "0199c2d0-0000-7000-8000-000000000004",
              name: "Classic",
              position: 0,
            },
          ],
        },
      ],
      productVersion: 2,
      variants: [
        {
          id: "0199c2d0-0000-7000-8000-000000000005",
          isDefault: false,
          listPrice: null,
          position: 0,
          sku: null,
          values: [
            {
              optionName: "model",
              optionValueId: "0199c2d0-0000-7000-8000-000000000004",
              optionValueName: "Classic",
            },
          ],
        },
      ],
    };
    const configureProductVariants = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        repositoryInput: {
          expectedVersion: number;
          id: string;
          options: Array<{ name: string; values: string[] }>;
          requestId: string | null;
          variants: Array<{ values: { model?: string } }>;
        }
      ) => ({
        configuration,
        product: {
          ...productRow,
          version: repositoryInput.expectedVersion + 1,
        },
      })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      configureProductVariants,
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
    const configureInput = {
      expectedVersion: 1,
      id: productRow.id,
      options: [{ name: "model" as const, values: ["Classic"] }],
      organizationId: identity.organizationId,
      variants: [{ values: { model: "Classic" } }],
    };

    const result = await client.product.configureVariants(configureInput);

    expect(result).toMatchObject({
      configuration,
      product: { version: 2 },
    });
    expect(observedCapability).toBe("product:update");
    expect(configureProductVariants).toHaveBeenCalledWith({}, identity, {
      expectedVersion: configureInput.expectedVersion,
      id: configureInput.id,
      options: configureInput.options,
      requestId: expect.stringMatching(requestIdPattern),
      variants: configureInput.variants,
    });
  });

  it("maps invalid variant combinations to a bad request", async () => {
    const router = createRpcRouter({
      configureProductVariants: () =>
        Promise.reject(new ProductVariantConfigurationError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.configureVariants({
        expectedVersion: 1,
        id: productRow.id,
        options: [{ name: "model", values: ["Classic"] }],
        organizationId: identity.organizationId,
        variants: [{ values: { model: "Missing" } }],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps a SKU on the default variant to a configuration conflict", async () => {
    const router = createRpcRouter({
      configureProductVariants: () =>
        Promise.reject(new ProductDefaultVariantSkuConflictError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.configureVariants({
        expectedVersion: 1,
        id: productRow.id,
        options: [{ name: "model", values: ["Classic"] }],
        organizationId: identity.organizationId,
        variants: [{ values: { model: "Classic" } }],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps a default variant with stock history to a configuration conflict with its reason", async () => {
    const router = createRpcRouter({
      configureProductVariants: () =>
        Promise.reject(new ProductDefaultVariantStockHistoryConflictError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.configureVariants({
        expectedVersion: 1,
        id: productRow.id,
        options: [{ name: "model", values: ["Classic"] }],
        organizationId: identity.organizationId,
        variants: [{ values: { model: "Classic" } }],
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "product_default_variant_stock_history_conflict" },
    });
  });

  it("sets a variant SKU with product:update and the optimistic version", async () => {
    const configuration: ProductVariantConfigurationReadModel = {
      configured: false,
      options: [],
      productVersion: 2,
      variants: [
        {
          id: "0199c2d0-0000-7000-8000-000000000002",
          isDefault: true,
          listPrice: null,
          position: null,
          sku: "Sku-A1",
          values: [],
        },
      ],
    };
    const setProductVariantSku = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        input: {
          expectedVersion: number;
          id: string;
          requestId: string | null;
          sku: string | null;
          variantId: string;
        }
      ) => ({
        changed: true,
        configuration,
        product: { ...productRow, version: input.expectedVersion + 1 },
      })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      setProductVariantSku,
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

    const result = await client.product.setVariantSku({
      expectedVersion: 1,
      organizationId: identity.organizationId,
      productId: productRow.id,
      sku: "  Sku-A1  ",
      variantId: "0199c2d0-0000-7000-8000-000000000002",
    });

    expect(result).toMatchObject({
      changed: true,
      configuration,
      product: { version: 2 },
    });
    expect(observedCapability).toBe("product:update");
    expect(setProductVariantSku).toHaveBeenCalledWith({}, identity, {
      expectedVersion: 1,
      id: productRow.id,
      requestId: expect.stringMatching(requestIdPattern),
      sku: "  Sku-A1  ",
      variantId: "0199c2d0-0000-7000-8000-000000000002",
    });
  });

  it("maps a duplicate variant SKU to a conflict response", async () => {
    const router = createRpcRouter({
      setProductVariantSku: () =>
        Promise.reject(new ProductVariantSkuConflictError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.setVariantSku({
        expectedVersion: 1,
        organizationId: identity.organizationId,
        productId: productRow.id,
        sku: "SKU-1",
        variantId: "0199c2d0-0000-7000-8000-000000000002",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

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

  it("tombstones a product with product:update and expectedVersion", async () => {
    const deleteProduct = vi.fn(
      async (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        input: { expectedVersion: number }
      ) => ({
        changed: true,
        product: {
          ...productRow,
          deletedAt: new Date("2026-10-10T12:00:00.000Z"),
          version: input.expectedVersion + 1,
        },
      })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      deleteProduct,
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

    const result = await client.product.delete({
      expectedVersion: 1,
      id: productRow.id,
      organizationId: identity.organizationId,
    });

    expect(result).toMatchObject({
      changed: true,
      product: { status: "deleted", version: 2 },
    });
    expect(observedCapability).toBe("product:update");
    expect(deleteProduct).toHaveBeenCalledWith({}, identity, {
      expectedVersion: 1,
      id: productRow.id,
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("maps blocked product tombstones to a conflict", async () => {
    const router = createRpcRouter({
      deleteProduct: () => Promise.reject(new ProductStockNotEmptyError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router);

    await expect(
      client.product.delete({
        expectedVersion: 1,
        id: productRow.id,
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

describe("product variant list price RPC", () => {
  const variantId = "0199c2d0-0000-7000-8000-000000000002";
  const configuration: ProductVariantConfigurationReadModel = {
    configured: false,
    options: [],
    productVersion: 2,
    variants: [
      {
        id: variantId,
        isDefault: true,
        listPrice: "49.90",
        position: null,
        sku: null,
        values: [],
      },
    ],
  };

  it("sets the list price with product:update and returns the new configuration", async () => {
    const setProductVariantListPrice = vi.fn(
      (
        _transaction: unknown,
        _authorizedIdentity: typeof identity,
        input: { expectedVersion: number }
      ) =>
        Promise.resolve({
          changed: true,
          configuration,
          product: { ...productRow, version: input.expectedVersion + 1 },
        })
    );
    let observedCapability = "";
    const router = createRpcRouter({
      setProductVariantListPrice,
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
    const client = createRpcClient(router) as unknown as {
      product: {
        setVariantListPrice: (input: unknown) => Promise<{
          changed: boolean;
          configuration: ProductVariantConfigurationReadModel;
          product: ProductReadModel;
        }>;
      };
    };

    const result = await client.product.setVariantListPrice({
      expectedVersion: 1,
      listPrice: "49.9",
      organizationId: identity.organizationId,
      productId: productRow.id,
      variantId,
    });

    expect(result).toMatchObject({
      changed: true,
      configuration,
      product: { version: 2 },
    });
    expect(observedCapability).toBe("product:update");
    expect(setProductVariantListPrice).toHaveBeenCalledWith({}, identity, {
      expectedVersion: 1,
      id: productRow.id,
      listPrice: "49.9",
      requestId: expect.stringMatching(requestIdPattern),
      variantId,
    });
  });

  it("maps an invalid price to a bad request", async () => {
    const router = createRpcRouter({
      setProductVariantListPrice: () =>
        Promise.reject(new InvalidVariantListPriceError()),
      withTenantRequestContext: (input: {
        operation: (
          transaction: unknown,
          authorizedIdentity: typeof identity
        ) => Promise<unknown>;
      }) => tenantContext(input),
    } as unknown as Parameters<typeof createRpcRouter>[0]);
    const client = createRpcClient(router) as unknown as {
      product: { setVariantListPrice: (input: unknown) => Promise<unknown> };
    };
    await expect(
      client.product.setVariantListPrice({
        expectedVersion: 1,
        listPrice: "-5",
        organizationId: identity.organizationId,
        productId: productRow.id,
        variantId,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
