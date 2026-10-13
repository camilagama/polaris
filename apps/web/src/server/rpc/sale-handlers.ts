import { implement } from "@orpc/server";
import {
  type ConfirmedSaleReadModel,
  polarisContract,
} from "@polaris/contracts";
import type {
  ConfirmSaleResult,
  confirmSale,
} from "@polaris/db/sale-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface SaleRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface SaleRpcDependencies {
  confirmSale: typeof confirmSale | undefined;
  defaultConfirmSale: typeof confirmSale;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

type FeeMode = ConfirmedSaleReadModel["payment"]["processingFee"]["mode"];
type AdjustmentKind = ConfirmedSaleReadModel["adjustments"][number]["kind"];
type AdjustmentValueType =
  ConfirmedSaleReadModel["adjustments"][number]["valueType"];
type PaymentMethod = ConfirmedSaleReadModel["payment"]["method"];
type InstallmentPlan = ConfirmedSaleReadModel["payment"]["installmentPlan"];

function confirmedSaleReadModel(
  result: ConfirmSaleResult
): ConfirmedSaleReadModel {
  const { payment } = result;
  return {
    adjustments: result.adjustments.map((adjustment) => ({
      amount: adjustment.amount,
      kind: adjustment.kind as AdjustmentKind,
      percentage: adjustment.percentage,
      position: adjustment.position,
      valueType: adjustment.valueType as AdjustmentValueType,
    })),
    items: result.items,
    payment: {
      amount: payment.amount,
      anticipationFee: {
        ...payment.anticipationFee,
        mode: payment.anticipationFee.mode as FeeMode,
      },
      anticipationRequested: payment.anticipationRequested,
      expectedSettlementDays: payment.expectedSettlementDays,
      installmentPlan: payment.installmentPlan as InstallmentPlan,
      installments: payment.installments,
      method: payment.method as PaymentMethod,
      paymentProfileId: payment.paymentProfileId,
      paymentProfileName: payment.paymentProfileName,
      paymentProfileRuleId: payment.paymentProfileRuleId,
      paymentProfileVersion: payment.paymentProfileVersion,
      processingFee: {
        ...payment.processingFee,
        mode: payment.processingFee.mode as FeeMode,
      },
    },
    replayed: result.replayed,
    sale: {
      clientCreatedAt: result.sale.clientCreatedAt?.toISOString() ?? null,
      commandId: result.sale.commandId,
      confirmedAt: result.sale.confirmedAt.toISOString(),
      currency: "BRL",
      id: result.sale.id,
      occurredAt: result.sale.occurredAt.toISOString(),
    },
    totals: result.totals,
  };
}

export function createSaleRpcHandlers(dependencies: SaleRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<SaleRpcContext>();
  const confirmSaleRepository =
    dependencies.confirmSale ?? dependencies.defaultConfirmSale;

  const confirm = implementContract.sale.confirm.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sale:create",
        operation: (transaction, identity) =>
          confirmSaleRepository(transaction, identity, {
            adjustments: input.adjustments,
            clientCreatedAt: input.clientCreatedAt ?? null,
            commandId: input.commandId,
            commandVersion: input.commandVersion,
            items: input.items,
            occurredAt: input.occurredAt,
            payment: input.payment,
            paymentProfile: input.paymentProfile,
            requestId: dependencies.requestAuditId(context.requestId),
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then(confirmedSaleReadModel)
      .catch(dependencies.toRpcError)
  );

  return { confirm };
}
