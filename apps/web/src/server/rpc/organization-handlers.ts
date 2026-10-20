import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type {
  ClosedOrganizationView,
  getClosedOrganizationStatus,
  listClosedOrganizations,
} from "@polaris/db/closed-organization-repository";
import type {
  listOrganizationsInClosure,
  recoverOrganizationClosure,
  requestOrganizationClosure,
} from "@polaris/db/organization-closure-repository";
import type { listUserOrganizations } from "@polaris/db/organization-membership-query";
import type { RenewalCancellationStatus } from "@polaris/domain/billing/renewal-cancellation";
import type { RenewalStatusReader } from "../billing/renewal-status";
import type { WorkerBindings } from "../environment";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { withTenantRequestContext } from "../tenant-request-context";

interface OrganizationRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

/** The closure functions the handlers call; tests replace any of them. */
export interface ClosureRepository {
  getClosedOrganizationStatus: typeof getClosedOrganizationStatus;
  listClosedOrganizations: typeof listClosedOrganizations;
  listOrganizationsInClosure: typeof listOrganizationsInClosure;
  recoverOrganizationClosure: typeof recoverOrganizationClosure;
  requestOrganizationClosure: typeof requestOrganizationClosure;
}

interface OrganizationRpcDependencies {
  closureRepository: ClosureRepository;
  defaultListUserOrganizations: typeof listUserOrganizations;
  listUserOrganizations: typeof listUserOrganizations | undefined;
  /** The renewal of each closed organization, read on the billing role after the ownership check. */
  readRenewalStatuses: RenewalStatusReader;
  toRpcError: (error: unknown) => never;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
}

/** What the owner reads of a closed organization: dates as ISO instants, D as a calendar date. */
function closedOrganizationReadModel(
  organization: ClosedOrganizationView,
  renewal: RenewalCancellationStatus
) {
  return {
    canRecover: organization.canRecover,
    deletableFrom: organization.deletableFrom.toISOString(),
    deletionDate: organization.deletionDate,
    exportOpenUntil: organization.exportOpenUntil.toISOString(),
    id: organization.id,
    milestones: {
      closure: organization.milestones.closure.toISOString(),
      d30: organization.milestones.d30.toISOString(),
      d7: organization.milestones.d7.toISOString(),
      deletionDay: organization.milestones.deletionDay.toISOString(),
    },
    name: organization.name,
    phase: organization.phase,
    recoverUntil: organization.recoverUntil.toISOString(),
    renewal,
    requestedAt: organization.requestedAt.toISOString(),
    timezone: organization.timezone,
  };
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

  /** The read models, with the renewal read after the database proved the user owns each organization. */
  const withRenewal = async (
    bindings: WorkerBindings,
    organizations: readonly ClosedOrganizationView[]
  ) => {
    const renewals = await dependencies.readRenewalStatuses(
      bindings,
      organizations.map((organization) => organization.id)
    );
    return organizations.map((organization) =>
      closedOrganizationReadModel(
        organization,
        renewals.get(organization.id) ?? "not_handled"
      )
    );
  };

  const listClosed = implementContract.organization.listClosed.handler(
    async ({ context }) => {
      try {
        const organizations =
          await dependencies.withAuthenticatedRequestContext({
            bindings: context.bindings,
            // the user comes from the verified session: the database lists only what they own
            operation: (database, session) =>
              closure.listClosedOrganizations(database, session.user.id),
            request: context.request,
          });
        return {
          organizations: await withRenewal(context.bindings, organizations),
        };
      } catch (error: unknown) {
        return dependencies.toRpcError(error);
      }
    }
  );

  const closedStatus = implementContract.organization.closedStatus.handler(
    async ({ context, input }) => {
      try {
        const organization = await dependencies.withAuthenticatedRequestContext(
          {
            bindings: context.bindings,
            operation: (database, session) =>
              closure.getClosedOrganizationStatus(
                database,
                session.user.id,
                input.organizationId
              ),
            request: context.request,
          }
        );
        if (!organization) {
          return { organization: null };
        }
        const [model] = await withRenewal(context.bindings, [organization]);
        return { organization: model ?? null };
      } catch (error: unknown) {
        return dependencies.toRpcError(error);
      }
    }
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

  return {
    closedStatus,
    listClosed,
    listClosing,
    listMine,
    recoverClosure,
    requestClosure,
  };
}
