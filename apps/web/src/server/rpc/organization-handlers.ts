import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type { listUserOrganizations } from "@polaris/db/organization-membership-query";
import type { WorkerBindings } from "../environment";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";

interface OrganizationRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface OrganizationRpcDependencies {
  defaultListUserOrganizations: typeof listUserOrganizations;
  listUserOrganizations: typeof listUserOrganizations | undefined;
  toRpcError: (error: unknown) => never;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
}

/**
 * Organization reads that need only the signed-in user, never a tenant
 * context: the caller has no organization yet, or is choosing one.
 */
export function createOrganizationRpcHandlers(
  dependencies: OrganizationRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<OrganizationRpcContext>();
  const listRepository =
    dependencies.listUserOrganizations ??
    dependencies.defaultListUserOrganizations;

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

  return { listMine };
}
