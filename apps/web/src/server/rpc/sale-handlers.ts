import { implement } from "@orpc/server";
import {
  type ConfirmedSaleReadModel,
  polarisContract,
  type SaleCancellationReadModel,
  type SaleCustomerLinkReadModel,
  type SaleDetailReadModel,
  type SaleListEntryReadModel,
  type SaleReturnReadModel,
} from "@polaris/contracts";
import type {
  CancelSaleResult,
  cancelSale,
  SaleCancellationRecord,
} from "@polaris/db/sale-cancellation-repository";
import type {
  changeSaleCustomerLink,
  getSaleCustomerLink,
  SaleCustomerLinkReadModel as SaleCustomerLinkRecord,
} from "@polaris/db/sale-customer-link-repository";
import type {
  getSale,
  listSales,
  SaleListEntry,
} from "@polaris/db/sale-query-repository";
import type {
  ConfirmSaleResult,
  confirmSale,
} from "@polaris/db/sale-repository";
import type {
  CreateSaleReturnResult,
  createSaleReturn,
} from "@polaris/db/sale-return-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface SaleRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface SaleRpcDependencies {
  cancelSale: typeof cancelSale | undefined;
  changeSaleCustomerLink: typeof changeSaleCustomerLink | undefined;
  confirmSale: typeof confirmSale | undefined;
  createSaleReturn: typeof createSaleReturn | undefined;
  defaultCancelSale: typeof cancelSale;
  defaultChangeSaleCustomerLink: typeof changeSaleCustomerLink;
  defaultConfirmSale: typeof confirmSale;
  defaultCreateSaleReturn: typeof createSaleReturn;
  defaultGetSale: typeof getSale;
  defaultGetSaleCustomerLink: typeof getSaleCustomerLink;
  defaultListSales: typeof listSales;
  getSale: typeof getSale | undefined;
  getSaleCustomerLink: typeof getSaleCustomerLink | undefined;
  listSales: typeof listSales | undefined;
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
      commandId: result.sale.commandId,
      confirmedAt: result.sale.confirmedAt.toISOString(),
      currency: "BRL",
      id: result.sale.id,
      occurredAt: result.sale.occurredAt.toISOString(),
      occurredOn: result.sale.occurredOn,
      recordedAt: result.sale.recordedAt?.toISOString() ?? null,
    },
    totals: result.totals,
  };
}

function saleCancellationReadModel(
  cancellation: SaleCancellationRecord
): SaleCancellationReadModel {
  return {
    cancelledAt: cancellation.cancelledAt.toISOString(),
    cancelledBy: cancellation.cancelledBy,
    commandId: cancellation.commandId,
    id: cancellation.id,
    reasonCode:
      cancellation.reasonCode as SaleCancellationReadModel["reasonCode"],
    reasonNote: cancellation.reasonNote,
    saleId: cancellation.saleId,
  };
}

function saleListEntryReadModel(entry: SaleListEntry): SaleListEntryReadModel {
  return {
    cancelledAt: entry.cancelledAt?.toISOString() ?? null,
    confirmedAt: entry.confirmedAt.toISOString(),
    customerId: entry.customerId,
    hasReturns: entry.hasReturns,
    id: entry.id,
    itemCount: entry.itemCount,
    occurredAt: entry.occurredAt.toISOString(),
    paymentMethod: entry.paymentMethod as PaymentMethod | null,
    status: entry.status,
    totalDue: entry.totalDue,
  };
}

function saleDetailReadModel(
  detail: Awaited<ReturnType<typeof getSale>>
): SaleDetailReadModel {
  const { replayed: _replayed, ...sale } = confirmedSaleReadModel({
    ...detail.sale,
    replayed: false,
  });
  return {
    cancellation: detail.cancellation
      ? saleCancellationReadModel(detail.cancellation)
      : null,
    customer: detail.customer,
    returnSummary: detail.returnSummary,
    returns: detail.returns.map((saleReturn) => ({
      ...saleReturn,
      reasonCode: saleReturn.reasonCode as SaleReturnReadModel["reasonCode"],
      returnedAt: saleReturn.returnedAt.toISOString(),
    })),
    sale,
  };
}

function returnResultReadModel(result: CreateSaleReturnResult) {
  const { saleReturn } = result;
  return {
    lines: result.lines,
    replayed: result.replayed,
    saleReturn: {
      commandId: saleReturn.commandId,
      id: saleReturn.id,
      reasonCode: saleReturn.reasonCode as SaleReturnReadModel["reasonCode"],
      reasonNote: saleReturn.reasonNote,
      returnedAt: saleReturn.returnedAt.toISOString(),
      returnedBy: saleReturn.returnedBy,
      saleId: saleReturn.saleId,
    },
  };
}

function cancelResultReadModel(result: CancelSaleResult) {
  return {
    cancellation: saleCancellationReadModel(result.cancellation),
    replayed: result.replayed,
    restocked: result.restocked,
  };
}
function saleCustomerLinkReadModel(
  link: SaleCustomerLinkRecord
): SaleCustomerLinkReadModel {
  return {
    current: link.current,
    history: link.history.map((entry) => ({
      action: entry.action,
      createdAt: entry.createdAt.toISOString(),
      customerId: entry.customerId,
      version: entry.version,
    })),
    saleId: link.saleId,
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
            commandId: input.commandId,
            commandVersion: input.commandVersion,
            items: input.items,
            occurredAt: input.occurredAt,
            payment: input.payment,
            paymentProfile: input.paymentProfile,
            recordedAt: input.recordedAt ?? null,
            requestId: dependencies.requestAuditId(context.requestId),
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then(confirmedSaleReadModel)
      .catch(dependencies.toRpcError)
  );

  const cancelRepository =
    dependencies.cancelSale ?? dependencies.defaultCancelSale;
  const returnRepository =
    dependencies.createSaleReturn ?? dependencies.defaultCreateSaleReturn;
  const listRepository =
    dependencies.listSales ?? dependencies.defaultListSales;
  const getRepository = dependencies.getSale ?? dependencies.defaultGetSale;

  const cancel = implementContract.sale.cancel.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sale:cancel",
        operation: (transaction, identity) =>
          cancelRepository(transaction, identity, {
            commandId: input.commandId,
            commandVersion: input.commandVersion,
            reasonCode: input.reasonCode ?? null,
            reasonNote: input.reasonNote ?? null,
            requestId: dependencies.requestAuditId(context.requestId),
            saleId: input.saleId,
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then(cancelResultReadModel)
      .catch(dependencies.toRpcError)
  );

  const returnSale = implementContract.sale.return.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "sale:return",
          operation: (transaction, identity) =>
            returnRepository(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              items: input.items,
              reasonCode: input.reasonCode ?? null,
              reasonNote: input.reasonNote ?? null,
              requestId: dependencies.requestAuditId(context.requestId),
              saleId: input.saleId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .then(returnResultReadModel)
        .catch(dependencies.toRpcError)
  );

  const list = implementContract.sale.list.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sale:read",
        operation: (transaction, identity) =>
          listRepository(transaction, identity, {
            limit: input.limit,
            offset: input.offset,
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then((result) => ({
        hasMore: result.hasMore,
        sales: result.sales.map(saleListEntryReadModel),
      }))
      .catch(dependencies.toRpcError)
  );

  const get = implementContract.sale.get.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sale:read",
        operation: (transaction, identity) =>
          getRepository(transaction, identity, input.saleId),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then(saleDetailReadModel)
      .catch(dependencies.toRpcError)
  );
  const changeLink =
    dependencies.changeSaleCustomerLink ??
    dependencies.defaultChangeSaleCustomerLink;
  const getLink =
    dependencies.getSaleCustomerLink ?? dependencies.defaultGetSaleCustomerLink;

  const linkCommand = (
    action: "assign" | "reassign" | "unassign",
    context: SaleRpcContext,
    input: {
      customerId?: string;
      expectedVersion: number;
      organizationId: string;
      saleId: string;
    }
  ) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sale:assign_customer",
        operation: (transaction, identity) =>
          changeLink(transaction, identity, {
            action,
            customerId: input.customerId ?? null,
            expectedVersion: input.expectedVersion,
            requestId: dependencies.requestAuditId(context.requestId),
            saleId: input.saleId,
          }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .then((result) => ({
        changed: result.changed,
        link: saleCustomerLinkReadModel(result.link),
      }))
      .catch(dependencies.toRpcError);

  const assignCustomer = implementContract.sale.assignCustomer.handler(
    ({ context, input }) => linkCommand("assign", context, input)
  );
  const reassignCustomer = implementContract.sale.reassignCustomer.handler(
    ({ context, input }) => linkCommand("reassign", context, input)
  );
  const unassignCustomer = implementContract.sale.unassignCustomer.handler(
    ({ context, input }) => linkCommand("unassign", context, input)
  );
  const getCustomerLink = implementContract.sale.getCustomerLink.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "sale:assign_customer",
          operation: (transaction, identity) =>
            getLink(transaction, identity, input.saleId),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .then(saleCustomerLinkReadModel)
        .catch(dependencies.toRpcError)
  );

  return {
    assignCustomer,
    cancel,
    confirm,
    get,
    getCustomerLink,
    list,
    reassignCustomer,
    return: returnSale,
    unassignCustomer,
  };
}
