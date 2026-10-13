import { implement } from "@orpc/server";
import {
  type ConfirmedSaleReadModel,
  polarisContract,
  type SaleCustomerLinkReadModel,
} from "@polaris/contracts";
import type {
  changeSaleCustomerLink,
  getSaleCustomerLink,
  SaleCustomerLinkReadModel as SaleCustomerLinkRecord,
} from "@polaris/db/sale-customer-link-repository";
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
  changeSaleCustomerLink: typeof changeSaleCustomerLink | undefined;
  confirmSale: typeof confirmSale | undefined;
  defaultChangeSaleCustomerLink: typeof changeSaleCustomerLink;
  defaultConfirmSale: typeof confirmSale;
  defaultGetSaleCustomerLink: typeof getSaleCustomerLink;
  getSaleCustomerLink: typeof getSaleCustomerLink | undefined;
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
    confirm,
    getCustomerLink,
    reassignCustomer,
    unassignCustomer,
  };
}
