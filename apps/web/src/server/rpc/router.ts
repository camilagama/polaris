import { implement, ORPCError } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  createCategory,
  listCategories,
} from "@polaris/db/category-repository";
import { createDatabase } from "@polaris/db/client";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { CategoryNameError } from "@polaris/domain/catalog/category";
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
  createCategory: typeof createCategory;
  createInitialOrganization: typeof createInitialOrganization;
  createOnboardingDatabase: typeof createDatabase;
  listCategories: typeof listCategories;
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
          categories: await listTenantCategories(transaction, identity),
        }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      } satisfies TenantRequestContextInput<{
        categories: Awaited<ReturnType<typeof listTenantCategories>>;
      }>;

      try {
        return await tenantRequest(tenantInput);
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
        return await tenantRequest(tenantInput);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  return implementContract.router({
    category: { create, list },
    organization: { createInitial },
    system: { ping },
  });
}

export const rpcRouter = createRpcRouter();
