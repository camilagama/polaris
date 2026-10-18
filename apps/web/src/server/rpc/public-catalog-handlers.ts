import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  type PublicCatalogProfileRow,
  publishProducts,
  readPublicCatalogSetup,
  savePublicCatalogProfile,
  setPublicCatalogPublished,
  unpublishProducts,
} from "@polaris/db/public-catalog-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface PublicCatalogRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

const defaultPublicCatalogRepository = {
  publishProducts,
  readPublicCatalogSetup,
  savePublicCatalogProfile,
  setPublicCatalogPublished,
  unpublishProducts,
};

/** The repository functions the handlers call; tests replace any of them. */
export type PublicCatalogRepository = typeof defaultPublicCatalogRepository;

interface PublicCatalogRpcDependencies {
  publicCatalogRepository: Partial<PublicCatalogRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "catalog:publish";
const TRAILING_SLASHES = /\/+$/;

function profileReadModel(profile: PublicCatalogProfileRow) {
  return {
    description: profile.description,
    instagram: profile.instagram,
    publicName: profile.publicName,
    published: profile.published,
    slug: profile.slug,
    version: profile.version,
    whatsapp: profile.whatsapp,
  };
}

/** The configured public origin without a trailing slash, or null when it is not configured. */
function publicOrigin(bindings: WorkerBindings): string | null {
  const origin = bindings.CATALOG_ORIGIN?.trim().replace(TRAILING_SLASHES, "");
  return origin ? origin : null;
}

/**
 * The organization's side of the public catalog (ADR 0069): its profile, its
 * switch and the products it shows. Every operation needs `catalog:publish`,
 * and what makes something public needs the plan to include the public catalog
 * (the repository checks it; turning things off never needs it).
 */
export function createPublicCatalogRpcHandlers(
  dependencies: PublicCatalogRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<PublicCatalogRpcContext>();
  const repository = {
    ...defaultPublicCatalogRepository,
    ...dependencies.publicCatalogRepository,
  };

  const run = <T>(
    context: PublicCatalogRpcContext,
    organizationId: string,
    operation: Parameters<
      typeof dependencies.withTenantRequestContext<T>
    >[0]["operation"]
  ) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        operation,
        request: context.request,
        requestedOrganizationId: organizationId,
      })
      .catch(dependencies.toRpcError);

  const setup = implementContract.publicCatalog.setup.handler(
    async ({ context, input }) => {
      const result = await run(
        context,
        input.organizationId,
        (transaction, identity) =>
          repository.readPublicCatalogSetup(transaction, identity)
      );
      return {
        enabled: result.enabled,
        profile: result.profile ? profileReadModel(result.profile) : null,
        publicOrigin: publicOrigin(context.bindings),
        publishedProductIds: result.publishedProductIds,
      };
    }
  );

  const saveProfile = implementContract.publicCatalog.saveProfile.handler(
    async ({ context, input }) =>
      profileReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.savePublicCatalogProfile(transaction, identity, {
            description: input.description ?? null,
            expectedVersion: input.expectedVersion,
            instagram: input.instagram ?? null,
            publicName: input.publicName,
            requestId: dependencies.requestAuditId(context.requestId),
            slug: input.slug,
            whatsapp: input.whatsapp ?? null,
          })
        )
      )
  );

  const setPublished = implementContract.publicCatalog.setPublished.handler(
    async ({ context, input }) =>
      profileReadModel(
        await run(context, input.organizationId, (transaction, identity) =>
          repository.setPublicCatalogPublished(transaction, identity, {
            expectedVersion: input.expectedVersion,
            published: input.published,
            requestId: dependencies.requestAuditId(context.requestId),
          })
        )
      )
  );

  const publish = implementContract.publicCatalog.publishProducts.handler(
    ({ context, input }) =>
      run(context, input.organizationId, (transaction, identity) =>
        repository.publishProducts(transaction, identity, {
          productIds: input.productIds,
          requestId: dependencies.requestAuditId(context.requestId),
        })
      )
  );

  const unpublish = implementContract.publicCatalog.unpublishProducts.handler(
    ({ context, input }) =>
      run(context, input.organizationId, (transaction, identity) =>
        repository.unpublishProducts(transaction, identity, {
          productIds: input.productIds,
          requestId: dependencies.requestAuditId(context.requestId),
        })
      )
  );

  return {
    publishProducts: publish,
    saveProfile,
    setPublished,
    setup,
    unpublishProducts: unpublish,
  };
}
