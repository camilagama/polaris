import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import { readPeriodResult } from "@polaris/db/economics-repository";
import {
  dashboardCards,
  resultQuality,
} from "@polaris/domain/economics/period-summary";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface ReportRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface ReportRpcDependencies {
  readPeriodResult: typeof readPeriodResult | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

/**
 * The period summary of the dashboard: the economics engine over the
 * organization's confirmed records, read in one repeatable-read snapshot, with
 * the cards and the account of how complete the estimate is.
 */
export function createReportRpcHandlers(dependencies: ReportRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<ReportRpcContext>();
  const read = dependencies.readPeriodResult ?? readPeriodResult;

  const periodSummary = implementContract.report.periodSummary.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "report:read",
          isolationLevel: "repeatable read",
          operation: async (transaction, identity) => {
            const result = await read(transaction, identity, {
              from: input.from,
              to: input.to,
            });
            return {
              cards: dashboardCards(result),
              chain: {
                anticipationFees: result.anticipationFees,
                cogs: result.cogs,
                commercialSurcharges: result.commercialSurcharges,
                contributionMargin: result.contributionMargin,
                discounts: result.discounts,
                estimatedOperatingResult: result.estimatedOperatingResult,
                grossProfit: result.grossProfit,
                grossSales: result.grossSales,
                linkedExpenses: result.linkedExpenses,
                netSales: result.netSales,
                operatingExpenses: result.operatingExpenses,
                processingFees: result.processingFees,
                returns: result.returns,
              },
              period: { from: input.from, to: input.to },
              quality: resultQuality(result),
            };
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { periodSummary };
}
