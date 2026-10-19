import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type {
  listOrganizationsInClosure,
  recoverOrganizationClosure,
  requestOrganizationClosure,
} from "@polaris/db/organization-closure-repository";
import type { listUserOrganizations } from "@polaris/db/organization-membership-query";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface OrganizationRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

/** The closure functions the handlers call; tests replace any of them. */
export interface ClosureRepository {
  listOrganizationsInClosure: typeof listOrganizationsInClosure;
  recoverOrganizationClosure: typeof recoverOrganizationClosure;
  requestOrganizationClosure: typeof requestOrganizationClosure;
}

interface OrganizationRpcDependencies {
  closureRepository: ClosureRepository;
  defaultListUserOrganizations: typeof listUserOrganizations;
  listUserOrganizations: typeof listUserOrganizations | undefined;
  toRpcError: (error: unknown) => never;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
}

/**
 * Organization operations that need only the signed-in user, never a tenant
 * context (the caller has no organization yet, is choosing one, or its
 * organization is closing and no longer opens), and the closure request, which
 * does run in the tenant context of the organization being closed.
 */
export function createOrganizationRpcHandlers(
  dependencies: OrganizationRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<OrganizationRpcContext>();
  const listRepository =
    dependencies.listUserOrganizations ??
    dependencies.defaultListUserOrganizations;
  const closure = dependencies.closureRepository;

  const listMine = implementContract.organization.listMine.handler(
    ({ context }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          // The user comes from the verified session; the input has no
          // organization or user field to trust.
          operation: async (database, session) => ({
            organizations: await listRepository(database, session.user.id),
          }),
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const listClosing = implementContract.organization.listClosing.handler(
    ({ context }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (database, session) => ({
            organizations: (
              await closure.listOrganizationsInClosure(
                database,
                session.user.id
              )
            ).map((organization) => ({
              id: organization.id,
              name: organization.name,
              recoverUntil: organization.recoverUntil.toISOString(),
            })),
          }),
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const recoverClosure = implementContract.organization.recoverClosure.handler(
    ({ context, input }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (database, session) => {
            await closure.recoverOrganizationClosure(
              database,
              session.user.id,
              input.organizationId
            );
            return { recovered: true as const };
          },
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const requestClosure = implementContract.organization.requestClosure.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "organization:close",
          operation: async (transaction, identity) => {
            const requested = await closure.requestOrganizationClosure(
              transaction,
              identity,
              { confirmation: input.confirmation }
            );
            return {
              recoverUntil: requested.recoverUntil.toISOString(),
              revokedLeases: requested.revokedLeases,
            };
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { listClosing, listMine, recoverClosure, requestClosure };
}
