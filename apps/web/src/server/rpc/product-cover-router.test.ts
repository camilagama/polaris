import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ProductReadModel } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const bindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const at = new Date("2026-10-14T12:00:00.000Z");
const COVER = "0199c2d0-0000-7000-8000-000000000101";
const row = (n: number, extra: { coverAssetId?: string | null } = {}) => ({
  archivedAt: null,
  categoryId: null,
  createdAt: at,
  deletedAt: null,
  description: null,
  id: `0199c2d0-0000-7000-8000-00000000000${n}`,
  name: `Produto ${n}`,
  organizationId,
  updatedAt: at,
  variantsConfiguredAt: null,
  version: 1,
  ...extra,
});

function listWith(rows: ReturnType<typeof row>[]) {
  const listProducts = vi.fn(() => Promise.resolve(rows));
  const withTenantRequestContext = vi.fn(
    (input: {
      operation: (transaction: never, identity: unknown) => Promise<unknown>;
    }) =>
      input.operation({} as never, {
        capability: "catalog:read",
        organizationId,
        role: "owner",
        userId: "session-user",
      })
  );
  const app = createServerApp({
    rpcRouter: createRpcRouter({
      listProducts,
      withTenantRequestContext,
    } as unknown as Overrides),
  });
  const client = createORPCClient(
    new RPCLink({
      fetch: (request) => Promise.resolve(app.fetch(request, bindings)),
      headers: { origin: "https://polaris.example.invalid" },
      method: "POST",
      url: new URL("/rpc", "https://polaris.example.invalid"),
    })
  ) as unknown as {
    product: {
      list: (input: unknown) => Promise<{ products: ProductReadModel[] }>;
    };
  };
  return { client, listProducts };
}

describe("product.list and the cover", () => {
  it("answers each product's cover from the one read of the list", async () => {
    const { client, listProducts } = listWith([
      row(1, { coverAssetId: COVER }),
      row(2, { coverAssetId: null }),
    ]);
    const { products } = await client.product.list({
      organizationId,
      status: "all",
    });
    expect(products.map((product) => product.coverAssetId)).toEqual([
      COVER,
      null,
    ]);
    expect(listProducts).toHaveBeenCalledTimes(1);
  });

  it("leaves the field out when the read does not carry it, never as no image", async () => {
    const { client } = listWith([row(1)]);
    const { products } = await client.product.list({
      organizationId,
      status: "active",
    });
    expect(products[0]).not.toHaveProperty("coverAssetId");
  });
});
