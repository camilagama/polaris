import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  PublicCatalogProfileReadModel,
  PublicCatalogSetupReadModel,
} from "@polaris/contracts";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { EntitlementDeniedError } from "@polaris/domain/billing/entitlements";
import {
  InvalidPublicCatalogProfileError,
  PublicCatalogProductUnavailableError,
  PublicCatalogSlugTakenError,
  PublicCatalogVersionConflictError,
} from "@polaris/domain/catalog/public-catalog";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const productA = "0199c2d0-0000-7000-8000-0000000000a1";
const productB = "0199c2d0-0000-7000-8000-0000000000a2";
const identity: TenantRequestIdentity = {
  capability: "catalog:publish",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const profileRow = {
  createdAt: new Date("2026-10-16T12:00:00.000Z"),
  description: "Roupas feitas à mão",
  instagram: "loja.ana",
  organizationId,
  publicName: "Loja da Ana",
  published: true,
  publishedAt: new Date("2026-10-16T12:00:00.000Z"),
  slug: "loja-da-ana",
  updatedAt: new Date("2026-10-16T12:00:00.000Z"),
  version: 3,
  whatsapp: "5511912345678",
};
const profileModel: PublicCatalogProfileReadModel = {
  description: "Roupas feitas à mão",
  instagram: "loja.ana",
  publicName: "Loja da Ana",
  published: true,
  slug: "loja-da-ana",
  version: 3,
  whatsapp: "5511912345678",
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  CATALOG_ORIGIN: "https://catalogo.example/",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface CatalogClient {
  publicCatalog: {
    publishProducts: (input: unknown) => Promise<{ published: number }>;
    saveProfile: (input: unknown) => Promise<PublicCatalogProfileReadModel>;
    setPublished: (input: unknown) => Promise<PublicCatalogProfileReadModel>;
    setup: (input: unknown) => Promise<PublicCatalogSetupReadModel>;
    unpublishProducts: (input: unknown) => Promise<{ unpublished: number }>;
  };
}

function client(router: ReturnType<typeof createRpcRouter>) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as CatalogClient;
}

function tenantStub(onCall?: (capability: string) => void) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.(input.capability);
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

describe("public catalog RPCs", () => {
  it("reads the setup under its own capability, with the link the public catalog is served from", async () => {
    const capabilities: string[] = [];
    const result = await client(
      createRpcRouter({
        publicCatalogRepository: {
          readPublicCatalogSetup: () =>
            Promise.resolve({
              enabled: true,
              profile: profileRow,
              publishedProductIds: [productA],
            }),
        },
        withTenantRequestContext: tenantStub((capability) =>
          capabilities.push(capability)
        ),
      })
    ).publicCatalog.setup({ organizationId });

    expect(capabilities).toEqual(["catalog:publish"]);
    expect(result).toEqual({
      enabled: true,
      profile: profileModel,
      publicOrigin: "https://catalogo.example",
      publishedProductIds: [productA],
    });
    // nothing the organization did not type, and never its own ID
    expect(JSON.stringify(result)).not.toContain(organizationId);
  });

  it("says there is no profile yet", async () => {
    const result = await client(
      createRpcRouter({
        publicCatalogRepository: {
          readPublicCatalogSetup: () =>
            Promise.resolve({
              enabled: false,
              profile: null,
              publishedProductIds: [],
            }),
        },
        withTenantRequestContext: tenantStub(),
      })
    ).publicCatalog.setup({ organizationId });
    expect(result).toMatchObject({ enabled: false, profile: null });
  });

  it("saves the profile with the identity from the session and an audit request ID", async () => {
    const savePublicCatalogProfile = vi.fn(() => Promise.resolve(profileRow));
    const result = await client(
      createRpcRouter({
        publicCatalogRepository: { savePublicCatalogProfile },
        withTenantRequestContext: tenantStub(),
      })
    ).publicCatalog.saveProfile({
      description: "Roupas feitas à mão",
      expectedVersion: 2,
      organizationId: "requested-org",
      publicName: "Loja da Ana",
      slug: "loja-da-ana",
      whatsapp: "+55 (11) 91234-5678",
    });

    expect(savePublicCatalogProfile).toHaveBeenCalledWith({}, identity, {
      description: "Roupas feitas à mão",
      expectedVersion: 2,
      instagram: null,
      publicName: "Loja da Ana",
      requestId: expect.stringMatching(requestIdPattern),
      slug: "loja-da-ana",
      whatsapp: "+55 (11) 91234-5678",
    });
    expect(result).toEqual(profileModel);
  });

  it("turns the catalog on and off by version", async () => {
    const setPublicCatalogPublished = vi.fn(() => Promise.resolve(profileRow));
    await client(
      createRpcRouter({
        publicCatalogRepository: { setPublicCatalogPublished },
        withTenantRequestContext: tenantStub(),
      })
    ).publicCatalog.setPublished({
      expectedVersion: 3,
      organizationId,
      published: false,
    });
    expect(setPublicCatalogPublished).toHaveBeenCalledWith({}, identity, {
      expectedVersion: 3,
      published: false,
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("publishes and unpublishes products", async () => {
    const publishProducts = vi.fn(() => Promise.resolve({ published: 2 }));
    const unpublishProducts = vi.fn(() => Promise.resolve({ unpublished: 1 }));
    const api = client(
      createRpcRouter({
        publicCatalogRepository: { publishProducts, unpublishProducts },
        withTenantRequestContext: tenantStub(),
      })
    ).publicCatalog;

    expect(
      await api.publishProducts({
        organizationId,
        productIds: [productA, productB],
      })
    ).toEqual({ published: 2 });
    expect(
      await api.unpublishProducts({ organizationId, productIds: [productA] })
    ).toEqual({
      unpublished: 1,
    });
    expect(publishProducts).toHaveBeenCalledWith({}, identity, {
      productIds: [productA, productB],
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("refuses a malformed request before touching anything", async () => {
    const withTenantRequestContext = vi.fn();
    const api = client(
      createRpcRouter({
        publicCatalogRepository: {},
        withTenantRequestContext:
          withTenantRequestContext as unknown as ReturnType<typeof tenantStub>,
      })
    ).publicCatalog;

    for (const productIds of [
      [],
      ["not-a-uuid"],
      Array.from({ length: 201 }, () => productA),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(
        api.publishProducts({ organizationId, productIds })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(
      api.setPublished({ expectedVersion: 0, organizationId, published: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an address that is not allowed",
      new InvalidPublicCatalogProfileError("reserved_slug"),
      "BAD_REQUEST",
      "reserved_slug",
    ],
    [
      "an address that is taken",
      new PublicCatalogSlugTakenError(),
      "CONFLICT",
      "public_catalog_slug_taken",
    ],
    [
      "a stale version",
      new PublicCatalogVersionConflictError(),
      "CONFLICT",
      "public_catalog_version_conflict",
    ],
    [
      "a product that cannot be shown",
      new PublicCatalogProductUnavailableError(),
      "CONFLICT",
      "public_catalog_product_unavailable",
    ],
  ])(
    "maps %s to a stable code the screen can read",
    async (_label, error, code, reason) => {
      await expect(
        client(
          createRpcRouter({
            publicCatalogRepository: {
              savePublicCatalogProfile: () => Promise.reject(error),
            },
            withTenantRequestContext: tenantStub(),
          })
        ).publicCatalog.saveProfile({
          organizationId,
          publicName: "Loja",
          slug: "loja",
        })
      ).rejects.toMatchObject({ code, data: { reason } });
    }
  );

  it("maps a plan that does not include the public catalog to a conflict", async () => {
    await expect(
      client(
        createRpcRouter({
          publicCatalogRepository: {
            publishProducts: () =>
              Promise.reject(new EntitlementDeniedError("public_catalog")),
          },
          withTenantRequestContext: tenantStub(),
        })
      ).publicCatalog.publishProducts({
        organizationId,
        productIds: [productA],
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
