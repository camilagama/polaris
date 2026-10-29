import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  readDailySales,
  readPeriodSummary,
} from "@polaris/db/economics-repository";
import {
  dashboardCards,
  resultQuality,
} from "@polaris/domain/economics/period-summary";
import { logger, opaqueId } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface ReportRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface ReportRpcDependencies {
  readDailySales: typeof readDailySales | undefined;
  readPeriodSummary: typeof readPeriodSummary | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const encoder = new TextEncoder();

/**
 * The period summary of the dashboard: the organization's confirmed records
 * aggregated by the database in one statement, with the rules of the economics
 * engine (ADR 0054), giving the cards, the daily series, the most sold products
 * when asked and the account of how complete the estimate is.
 *
 * Each read leaves one record with counts only (the rows the database sent,
 * one per date and one per ranked product, the days, the size of the answer and
 * the time it took) and the organization's opaque ID:
 * never an amount or a name. The CPU time is the invocation's own, in the
 * Workers Logs of the same `requestId`.
 */
export function createReportRpcHandlers(dependencies: ReportRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<ReportRpcContext>();
  const read = dependencies.readPeriodSummary ?? readPeriodSummary;

  const periodSummary = implementContract.report.periodSummary.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "report:read",
          isolationLevel: "repeatable read",
          operation: async (transaction, identity) => {
            const started = Date.now();
            // taken before the read: nothing committed after it can be claimed as covered
            const generatedAt = new Date().toISOString();
            const summary = await read(
              transaction,
              identity,
              { from: input.from, to: input.to },
              { topProducts: input.topProducts }
            );
            const { result } = summary;
            const output = {
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
              daily: summary.daily,
              generatedAt,
              period: { from: input.from, to: input.to },
              quality: resultQuality(result),
              ...(summary.topProducts
                ? {
                    topProducts: summary.topProducts.map((entry) => ({
                      deleted: entry.deleted,
                      name: entry.name,
                      netSales: entry.netSales,
                      productId: entry.productId,
                      quantity: entry.quantity,
                    })),
                  }
                : {}),
            };
            // logged before the commit: a failed commit leaves a record of a read with no answer (it only overcounts)
            logger.info("report_period_summary_read", {
              days: summary.daily.length,
              durationMs: Date.now() - started,
              organizationId: opaqueId(identity.organizationId),
              reads: { ...summary.reads },
              requestId: context.requestId,
              responseBytes: encoder.encode(JSON.stringify(output)).byteLength,
              topProducts: input.topProducts ?? 0,
            });
            return output;
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  const readSeries = dependencies.readDailySales ?? readDailySales;

  /**
   * Net sales and the count of sales of each date of up to 182 days, for the
   * Início's map: the database aggregates them in one statement, so the CPU of
   * the Worker does not grow with the number of sales. The same context,
   * organization and permission as the period summary; the record says counts
   * and sizes only.
   */
  const dailySales = implementContract.report.dailySales.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "report:read",
          operation: async (transaction, identity) => {
            const started = Date.now();
            const output = await readSeries(transaction, identity, {
              from: input.from,
              to: input.to,
            });
            logger.info("report_daily_sales_read", {
              days: output.net.length,
              durationMs: Date.now() - started,
              organizationId: opaqueId(identity.organizationId),
              requestId: context.requestId,
              responseBytes: encoder.encode(JSON.stringify(output)).byteLength,
            });
            return output;
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { dailySales, periodSummary };
}
