import { implement, ORPCError } from "@orpc/server";
import { type CategoryReadModel, polarisContract } from "@polaris/contracts";
import {
  archiveCategory,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  restoreCategory,
} from "@polaris/db/category-repository";
import { createDatabase } from "@polaris/db/client";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  CategoryDeletedError,
  CategoryLifecycleError,
  CategoryNameConflictError,
  CategoryNameError,
  CategoryNotFoundError,
  deriveCategoryLifecycle,
} from "@polaris/domain/catalog/category";
import {
  type AuthenticatedRequestContextInput,
  withAuthenticatedRequestContext,
} from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RpcRouterDependencies {
  archiveCategory: typeof archiveCategory;
  createCategory: typeof createCategory;
  createInitialOrganization: typeof createInitialOrganization;
  createOnboardingDatabase: typeof createDatabase;
  deleteCategory: typeof deleteCategory;
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

  if (
    error instanceof CategoryDeletedError ||
    error instanceof CategoryNameConflictError ||
    error instanceof CategoryLifecycleError
  ) {
    throw new ORPCError("CONFLICT", { cause: error });
  }

  if (error instanceof CategoryNotFoundError) {
    throw new ORPCError("NOT_FOUND", { cause: error });
  }

  if (error instanceof CreateInitialOrganizationError) {
    throw new ORPCError(initialOrganizationErrorCode(error.code), {
      cause: error,
    });
  }

  throw error;
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
  const implementContract =
    implement(polarisContract).$context<PolarisRpcContext>();

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

  return implementContract.router({
    category: { archive, create, delete: remove, list, rename, restore },
    organization: { createInitial },
    system: { ping },
  });
}

export const rpcRouter = createRpcRouter();
