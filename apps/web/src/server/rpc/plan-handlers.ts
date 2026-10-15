import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  readOperationalSelection,
  selectOperationalVariants,
} from "@polaris/db/operational-selection-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface PlanRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

const defaultPlanRepository = {
  readOperationalSelection,
  selectOperationalVariants,
};

/** The repository functions the handlers call; tests replace any of them. */
export type PlanRepository = typeof defaultPlanRepository;

interface PlanRpcDependencies {
  planRepository: Partial<PlanRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "product:update";

function readModel(
  selection: Awaited<ReturnType<PlanRepository["readOperationalSelection"]>>
) {
  return {
    limit: selection.limit,
    liveVariants: selection.liveVariants,
    phase: selection.phase,
    selectedVariantIds: selection.selectedVariantIds,
    windowEndsAt: selection.windowEndsAt?.toISOString() ?? null,
  };
}

/**
 * The plan's effect on the catalog (Free Over Limit, ADR 0064): where the
 * organization stands against the Free variant limit, and the choice of which
 * variants stay operational. Both need the capability to manage products.
 */
export function createPlanRpcHandlers(dependencies: PlanRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<PlanRpcContext>();
  const repository = {
    ...defaultPlanRepository,
    ...dependencies.planRepository,
  };

  const run = <T>(
    context: PlanRpcContext,
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

  const operationalSelection =
    implementContract.plan.operationalSelection.handler(
      async ({ context, input }) =>
        readModel(
          await run(context, input.organizationId, (transaction, identity) =>
            repository.readOperationalSelection(transaction, identity)
          )
        )
    );

  const selectVariants =
    implementContract.plan.selectOperationalVariants.handler(
      async ({ context, input }) =>
        readModel(
          await run(context, input.organizationId, (transaction, identity) =>
            repository.selectOperationalVariants(transaction, identity, {
              requestId: dependencies.requestAuditId(context.requestId),
              variantIds: input.variantIds,
            })
          )
        )
    );

  return {
    operationalSelection,
    selectOperationalVariants: selectVariants,
  };
}
