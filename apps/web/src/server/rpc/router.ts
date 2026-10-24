import {
  EntitlementDeniedError,
  EntitlementLimitReachedError,
} from "@polaris/domain/billing/entitlements";
import { implement, ORPCError } from "@orpc/server";
import {
  EntitlementVariantLockedError,
  OperationalSelectionError,
} from "@polaris/domain/billing/operational-selection";
import { InvalidOperationalSelectionError } from "@polaris/db/operational-selection-repository";
import {
  type CategoryReadModel,
  type CustomerReadModel,
  type PaymentProfileReadModel,
  type ProductReadModel,
  polarisContract,
} from "@polaris/contracts";
import { readBootstrapPage } from "@polaris/db/bootstrap-repository";
import {
  archiveCategory,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  restoreCategory,
} from "@polaris/db/category-repository";
import { createDatabase } from "@polaris/db/client";
import {
  anonymizeCustomerForPrivacy,
  archiveCustomer,
  createCustomer,
  findPossibleCustomerDuplicates,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from "@polaris/db/customer-repository";
import {
  DeviceLimitError,
  DeviceNotFoundError,
  DeviceNotOwnedError,
  DeviceRevokedError,
  DeviceSessionEndedError,
  FreshSessionRequiredError,
  listDevices,
  OfflineGrantNotFoundError,
  registerDevice,
  revokeDevice,
  revokeOwnDevice,
  touchDevice,
} from "@polaris/db/device-repository";
import {
  getInventoryBalance,
  InvalidInventoryBalanceCursorError,
  inventoryCount,
  listInventoryBalances,
  organizationToday,
  receiveStock,
  writeOffStock,
} from "@polaris/db/inventory-repository";
import { issueOfflineLeaseGrant } from "@polaris/db/offline-lease-repository";
import {
  getClosedOrganizationStatus,
  listClosedOrganizations,
} from "@polaris/db/closed-organization-repository";
import {
  listOrganizationsInClosure,
  recoverOrganizationClosure,
  requestOrganizationClosure,
} from "@polaris/db/organization-closure-repository";
import { listUserOrganizations } from "@polaris/db/organization-membership-query";
import {
  archivePaymentProfile,
  createPaymentProfile,
  listPaymentProfiles,
  paymentProfileStatus,
  restorePaymentProfile,
  updatePaymentProfile,
} from "@polaris/db/payment-profile-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  deleteProduct,
  getProductVariants,
  listProducts,
  readProductCreation,
  restoreProduct,
  setProductVariantListPrice,
  setProductVariantSku,
  updateProduct,
} from "@polaris/db/product-repository";
import { cancelSale } from "@polaris/db/sale-cancellation-repository";
import {
  changeSaleCustomerLink,
  getSaleCustomerLink,
} from "@polaris/db/sale-customer-link-repository";
import { getSale, listSales } from "@polaris/db/sale-query-repository";
import { confirmSale } from "@polaris/db/sale-repository";
import { createSaleReturn } from "@polaris/db/sale-return-repository";
import {
  getSyncCursor,
  InvalidSyncCursorError,
  pullSyncChanges,
} from "@polaris/db/sync-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  CategoryDeletedError,
  CategoryInUseError,
  CategoryLifecycleError,
  CategoryNameConflictError,
  CategoryNameError,
  CategoryNotFoundError,
  deriveCategoryLifecycle,
} from "@polaris/domain/catalog/category";
import {
  deriveProductLifecycle,
  InvalidVariantListPriceError,
  ProductCategoryUnavailableError,
  ProductDefaultVariantSkuConflictError,
  ProductDefaultVariantStockHistoryConflictError,
  ProductDeletedError,
  ProductDescriptionError,
  ProductIdConflictError,
  ProductLifecycleError,
  ProductNameError,
  ProductNotFoundError,
  ProductStockNotEmptyError,
  ProductVariantConfigurationError,
  ProductVariantNotFoundError,
  ProductVariantSkuConflictError,
  ProductVariantsAlreadyConfiguredError,
  type ProductVariantValues,
  ProductVersionConflictError,
} from "@polaris/domain/catalog/product";
import {
  CustomerAnonymizedError,
  CustomerNotFoundError,
  CustomerVersionConflictError,
  InvalidCustomerDuplicateSearchError,
  InvalidCustomerProfileError,
} from "@polaris/domain/customers/customer";
import {
  ExpenseCategoryNameConflictError,
  ExpenseCategoryNotFoundError,
  ExpenseCategoryUnavailableError,
  ExpenseCategoryVersionConflictError,
  ExpenseCompetenceOutOfRangeError,
  ExpenseNotFoundError,
  ExpenseSaleNotFoundError,
  ExpenseVersionConflictError,
  ExpenseVoidedError,
  InvalidExpenseCategoryError,
  InvalidExpenseError,
} from "@polaris/domain/expenses/expense";
import {
  InvalidPublicCatalogProfileError,
  PublicCatalogProductUnavailableError,
  PublicCatalogProfileMissingError,
  PublicCatalogSlugTakenError,
  PublicCatalogVersionConflictError,
} from "@polaris/domain/catalog/public-catalog";
import {
  GoalLimitReachedError,
  GoalNotActiveError,
  GoalPausedByPlanError,
  GoalPeriodEndedError,
  GoalNotFoundError,
  GoalVersionConflictError,
  InvalidGoalError,
} from "@polaris/domain/goals/goal";
import {
  ExpenseRuleNotFoundError,
  ExpenseRuleVersionConflictError,
  InvalidExpenseRuleError,
} from "@polaris/domain/expenses/recurrence";
import {
  InsufficientStockError,
  InvalidStockMovementError,
  InventoryOccurredInFutureError,
  InventoryQuantityLimitError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
  StockCommandConflictError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidUnitCostError,
  InventoryCostLimitError,
  InventoryCostUnavailableError,
} from "@polaris/domain/inventory/inventory-cost";
import {
  InvalidInventoryCountInputError,
  UnsupportedInventoryCountCommandVersionError,
} from "@polaris/domain/inventory/inventory-count";
import {
  InvalidReceiveStockInputError,
  UnsupportedReceiveStockCommandVersionError,
} from "@polaris/domain/inventory/receive-stock";
import {
  InvalidWriteOffStockInputError,
  isWriteOffReasonCode,
  UnsupportedWriteOffStockCommandVersionError,
} from "@polaris/domain/inventory/write-off-stock";
import {
  DecimalAmountScaleError,
  InvalidDecimalAmountError,
  InvalidFinancialQuantityError,
  InvalidMoneyError,
  InvalidPercentageError,
  MoneyLimitError,
} from "@polaris/domain/money/money";
import {
  InvalidDeviceLabelError,
  InvalidOfflineGrantRevokeReasonError,
  InvalidOfflineGrantWindowError,
} from "@polaris/domain/offline/offline-grant";
import { OfflineLeaseNotAvailableError } from "@polaris/domain/offline/offline-lease";
import {
  AnotherOrganizationActiveError,
  ClosureConfirmationError,
  ClosureNotRecoverableError,
  isOrganizationStatus,
  OrganizationNotActiveError,
  type OrganizationStatus,
} from "@polaris/domain/organization/closure";
import {
  DataExportUnavailableError,
  InvalidExportRequestError,
} from "@polaris/domain/privacy/data-export";
import {
  InvalidConfirmSaleCommandError,
  SaleCommandConflictError,
  SaleOccurredInFutureError,
  SaleProductUnavailableError,
  UnsupportedConfirmSaleCommandVersionError,
} from "@polaris/domain/sales/confirm-sale";
import {
  InvalidPaymentProfileError,
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
} from "@polaris/domain/sales/payment-profile";
import { InvalidSaleSnapshotError } from "@polaris/domain/sales/sale";
import {
  InvalidSaleAdjustmentError,
  SaleAdjustmentLimitError,
  SaleDiscountExceedsSubtotalError,
} from "@polaris/domain/sales/sale-adjustments";
import {
  InvalidSaleCancellationError,
  SaleAlreadyCancelledError,
  SaleCancellationCommandConflictError,
  UnsupportedSaleCancellationCommandVersionError,
} from "@polaris/domain/sales/sale-cancellation";
import {
  InvalidSaleCustomerLinkError,
  SaleCustomerArchivedError,
  SaleCustomerLinkStateError,
  SaleCustomerLinkVersionConflictError,
} from "@polaris/domain/sales/sale-customer-link";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { InvalidSalePaymentError } from "@polaris/domain/sales/sale-payment";
import {
  InvalidSaleReturnError,
  SaleHasReturnsError,
  SaleNotReturnableError,
  SaleReturnCommandConflictError,
  SaleReturnExceedsAvailableError,
  UnsupportedSaleReturnCommandVersionError,
} from "@polaris/domain/sales/sale-return";
import {
  type AuthenticatedRequestContextInput,
  withAuthenticatedRequestContext,
} from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import {
  InvalidEconomicsPeriodError,
  InvalidTopProductsError,
  type readPeriodSummary,
} from "@polaris/db/economics-repository";
import type { ExpenseRepository } from "./expense-handlers";
import type { DataExportRepository } from "./data-export-handlers";
import type { GoalRepository } from "./goal-handlers";
import type { PlanRepository } from "./plan-handlers";
import type { PublicCatalogRepository } from "./public-catalog-handlers";
import { OfflineLeaseUnavailableError } from "../offline-lease-service";
import {
  type AccessLogQueryable,
  type AccessLogWriter,
  createDatabaseAccessLogWriter,
  guardAccessLogWriter,
} from "../auth/access-log";
import { SyncPayloadHashUnavailableError } from "../sync/payload-hash";
import {
  exemptRpcRequest,
  type readAcceptedLegalVersions,
  type recordLegalAcceptance,
} from "../legal-acceptance";
import { TenantRequestContextError } from "../request-context-error";
import {
  type TenantRequestContextInput,
  withTenantRequestContext,
} from "../tenant-request-context";
import {
  CreateInitialOrganizationError,
  createInitialOrganization,
} from "../use-cases/create-initial-organization";
import {
  createProductWithOpeningStock,
  ProductCreateConflictError,
} from "../use-cases/create-product-with-opening-stock";
import { pingSystem } from "../use-cases/system-ping";
import {
  type BillingRpcOverrides,
  createBillingRpcHandlers,
} from "./billing-handlers";
import { createExpenseRpcHandlers } from "./expense-handlers";
import { createDataExportRpcHandlers } from "./data-export-handlers";
import { createGoalRpcHandlers } from "./goal-handlers";
import { createPlanRpcHandlers } from "./plan-handlers";
import { createPublicCatalogRpcHandlers } from "./public-catalog-handlers";
import { createInventoryRpcHandlers } from "./inventory-handlers";
import { createReportRpcHandlers } from "./report-handlers";
import { createAccountRpcHandlers } from "./account-handlers";
import { createOfflineRpcHandlers } from "./offline-handlers";
import {
  createRenewalStatusReader,
  type RenewalStatusReader,
} from "../billing/renewal-status";
import {
  type ClosureRepository,
  createOrganizationRpcHandlers,
} from "./organization-handlers";
import { createSaleRpcHandlers } from "./sale-handlers";
import { createSyncRpcHandlers } from "./sync-handlers";
import { runSyncCommand } from "@polaris/db/sync-command-repository";
import type { SyncCommandHandler } from "../sync/push";
import { syncCommandHandlers } from "../sync/registry";

export interface PolarisRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}
interface ProductLifecycleInput {
  expectedVersion: number;
  id: string;
  organizationId: string;
}

interface CustomerLifecycleInput {
  expectedVersion: number;
  id: string;
  organizationId: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RpcRouterDependencies {
  /** The writer of the record of access over the authentication connection; tests give a fake one. */
  accessLogWriter: (connection: AccessLogQueryable) => AccessLogWriter;
  archiveCategory: typeof archiveCategory;
  anonymizeCustomerForPrivacy: typeof anonymizeCustomerForPrivacy;
  archiveCustomer: typeof archiveCustomer;
  archivePaymentProfile: typeof archivePaymentProfile;
  archiveProduct: typeof archiveProduct;
  billing: BillingRpcOverrides;
  closureRepository: Partial<ClosureRepository>;
  /** The renewal of closed organizations (ADR 0074, L4); tests give a fake one. */
  readRenewalStatuses: RenewalStatusReader;
  cancelSale: typeof cancelSale;
  changeSaleCustomerLink: typeof changeSaleCustomerLink;
  configureProductVariants: typeof configureProductVariants;
  confirmSale: typeof confirmSale;
  createCategory: typeof createCategory;
  createCustomer: typeof createCustomer;
  createInitialOrganization: typeof createInitialOrganization;
  createOnboardingDatabase: typeof createDatabase;
  createPaymentProfile: typeof createPaymentProfile;
  createProduct: typeof createProduct;
  /** The one use case of `product.create` (the sync command runs it too); tests give a fake one. */
  createProductWithOpeningStock: typeof createProductWithOpeningStock;
  createSaleReturn: typeof createSaleReturn;
  expenseRepository: Partial<ExpenseRepository>;
  dataExportRepository: Partial<DataExportRepository>;
  goalRepository: Partial<GoalRepository>;
  planRepository: Partial<PlanRepository>;
  publicCatalogRepository: Partial<PublicCatalogRepository>;
  readPeriodSummary: typeof readPeriodSummary;
  readAcceptedLegalVersions: typeof readAcceptedLegalVersions;
  recordLegalAcceptance: typeof recordLegalAcceptance;
  deleteCategory: typeof deleteCategory;
  deleteProduct: typeof deleteProduct;
  findPossibleCustomerDuplicates: typeof findPossibleCustomerDuplicates;
  getInventoryBalance: typeof getInventoryBalance;
  getProductVariants: typeof getProductVariants;
  getSale: typeof getSale;
  getSaleCustomerLink: typeof getSaleCustomerLink;
  getSyncCursor: typeof getSyncCursor;
  inventoryCount: typeof inventoryCount;
  issueOfflineLeaseGrant: typeof issueOfflineLeaseGrant;
  listCategories: typeof listCategories;
  listCustomers: typeof listCustomers;
  listDevices: typeof listDevices;
  listInventoryBalances: typeof listInventoryBalances;
  listPaymentProfiles: typeof listPaymentProfiles;
  listProducts: typeof listProducts;
  listSales: typeof listSales;
  listUserOrganizations: typeof listUserOrganizations;
  /** Today's date in the store's time zone: the date of the opening stock the server records. */
  organizationToday: typeof organizationToday;
  pullSyncChanges: typeof pullSyncChanges;
  readBootstrapPage: typeof readBootstrapPage;
  receiveStock: typeof receiveStock;
  registerDevice: typeof registerDevice;
  renameCategory: typeof renameCategory;
  restoreCategory: typeof restoreCategory;
  restoreCustomer: typeof restoreCustomer;
  restorePaymentProfile: typeof restorePaymentProfile;
  restoreProduct: typeof restoreProduct;
  revokeDevice: typeof revokeDevice;
  revokeOwnDevice: typeof revokeOwnDevice;
  runSyncCommand: typeof runSyncCommand;
  touchDevice: typeof touchDevice;
  syncCommandHandlers: readonly SyncCommandHandler[];
  setProductVariantListPrice: typeof setProductVariantListPrice;
  setProductVariantSku: typeof setProductVariantSku;
  updateCustomer: typeof updateCustomer;
  updatePaymentProfile: typeof updatePaymentProfile;
  updateProduct: typeof updateProduct;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
  writeOffStock: typeof writeOffStock;
}

function organizationStatus(status: string): OrganizationStatus {
  if (isOrganizationStatus(status)) {
    return status;
  }
  throw new Error("invalid_organization_status");
}
function requestAuditId(requestId: string): string | null {
  return uuidPattern.test(requestId) ? requestId : null;
}

function categoryReadModel(category: {
  archivedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  id: string;
  name: string;
  organizationId: string;
  updatedAt: Date;
}): CategoryReadModel {
  return {
    archivedAt: category.archivedAt?.toISOString() ?? null,
    createdAt: category.createdAt.toISOString(),
    deletedAt: category.deletedAt?.toISOString() ?? null,
    id: category.id,
    name: category.name,
    organizationId: category.organizationId,
    status: deriveCategoryLifecycle(category.archivedAt, category.deletedAt),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function productReadModel(product: {
  archivedAt: Date | null;
  categoryId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  description: string | null;
  id: string;
  name: string;
  organizationId: string;
  updatedAt: Date;
  version: number;
}): ProductReadModel {
  return {
    archivedAt: product.archivedAt?.toISOString() ?? null,
    categoryId: product.categoryId,
    createdAt: product.createdAt.toISOString(),
    deletedAt: product.deletedAt?.toISOString() ?? null,
    description: product.description,
    id: product.id,
    name: product.name,
    organizationId: product.organizationId,
    status: deriveProductLifecycle(product.archivedAt, product.deletedAt),
    updatedAt: product.updatedAt.toISOString(),
    version: product.version,
  };
}

function customerReadModel(customer: {
  anonymizedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  email: string | null;
  id: string;
  name: string;
  notes: string | null;
  organizationId: string;
  phone: string | null;
  updatedAt: Date;
  version: number;
}): CustomerReadModel {
  return {
    anonymizedAt: customer.anonymizedAt?.toISOString() ?? null,
    archivedAt: customer.archivedAt?.toISOString() ?? null,
    createdAt: customer.createdAt.toISOString(),
    email: customer.email,
    id: customer.id,
    name: customer.name,
    notes: customer.notes,
    organizationId: customer.organizationId,
    phone: customer.phone,
    status: customer.archivedAt === null ? "active" : "archived",
    updatedAt: customer.updatedAt.toISOString(),
    version: customer.version,
  };
}

function paymentProfileReadModel(profile: {
  archivedAt: Date | null;
  createdAt: Date;
  id: string;
  name: string;
  organizationId: string;
  rules: Array<{
    anticipationFeeFixedAmount: string | null;
    anticipationFeeMode: string;
    anticipationFeePercentage: string | null;
    expectedSettlementDays: number | null;
    id: string;
    installmentPlan: string | null;
    installments: number | null;
    method: string;
    processingFeeFixedAmount: string | null;
    processingFeeMode: string;
    processingFeePercentage: string | null;
  }>;
  updatedAt: Date;
  version: number;
}): PaymentProfileReadModel {
  return {
    archivedAt: profile.archivedAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    id: profile.id,
    name: profile.name,
    organizationId: profile.organizationId,
    rules: profile.rules.map((rule) => ({
      anticipationFee: {
        fixedAmount: rule.anticipationFeeFixedAmount,
        mode: rule.anticipationFeeMode as PaymentProfileReadModel["rules"][number]["anticipationFee"]["mode"],
        percentage: rule.anticipationFeePercentage,
      },
      expectedSettlementDays: rule.expectedSettlementDays,
      id: rule.id,
      installmentPlan: rule.installmentPlan as
        | PaymentProfileReadModel["rules"][number]["installmentPlan"]
        | null,
      installments: rule.installments,
      method: rule.method as PaymentProfileReadModel["rules"][number]["method"],
      processingFee: {
        fixedAmount: rule.processingFeeFixedAmount,
        mode: rule.processingFeeMode as PaymentProfileReadModel["rules"][number]["processingFee"]["mode"],
        percentage: rule.processingFeePercentage,
      },
    })),
    status: paymentProfileStatus(profile),
    updatedAt: profile.updatedAt.toISOString(),
    version: profile.version,
  };
}

function productVariantValues(input: {
  color?: string | undefined;
  model?: string | undefined;
  size?: string | undefined;
}): ProductVariantValues {
  const values: ProductVariantValues = {};
  if (input.model !== undefined) {
    values.model = input.model;
  }
  if (input.color !== undefined) {
    values.color = input.color;
  }
  if (input.size !== undefined) {
    values.size = input.size;
  }
  return values;
}

function tenantContextErrorCode(
  code: TenantRequestContextError["code"]
): "UNAUTHORIZED" | "FORBIDDEN" | "SERVICE_UNAVAILABLE" | "BAD_REQUEST" {
  if (code === "session_required") {
    return "UNAUTHORIZED";
  }
  if (code === "legal_acceptance_required") {
    return "FORBIDDEN";
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
    case "organization_limit_reached":
      return "CONFLICT";
    case "invalid_user_id":
    case "invalid_organization_id":
    case "invalid_organization_name":
    case "invalid_timezone":
      return "BAD_REQUEST";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

/**
 * Domain failures that the caller can act on carry their stable snake_case
 * domain code as `data.reason`, so clients can explain a 400/404/409 without
 * parsing messages. The cause itself is never serialized. Authorization and
 * unexpected errors deliberately expose no reason.
 */
function clientRpcError(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
  error: unknown
): ORPCError<typeof code, { reason: string } | undefined> {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return new ORPCError(code, {
    cause: error,
    data: reason === undefined ? undefined : { reason },
  });
}

/**
 * The refusal for a missing legal acceptance says so, with what is pending: the client pauses the sync and
 * offers `/aceite`, and never takes it for a refused session (ADR 0100). The other codes carry no reason.
 */
function tenantContextRpcError(
  error: TenantRequestContextError
): ORPCError<ReturnType<typeof tenantContextErrorCode>, unknown> {
  return new ORPCError(tenantContextErrorCode(error.code), {
    cause: error,
    data:
      error.code === "legal_acceptance_required"
        ? { pending: error.pending, reason: error.code }
        : undefined,
  });
}

function toRpcError(error: unknown): never {
  if (error instanceof TenantRequestContextError) {
    throw tenantContextRpcError(error);
  }

  if (matchesRpcError(error, [TenantAuthorizationError])) {
    // a member of a closed organization is told so (the device keeps its queue and goes to the closed
    // organization's panel); every other refusal of authorization stays without a reason
    throw new ORPCError("FORBIDDEN", {
      cause: error,
      data:
        (error as TenantAuthorizationError).code === "organization_closed"
          ? { reason: "organization_closed" }
          : undefined,
    });
  }

  // the session was ended (a device revocation) while it was in use
  if (error instanceof DeviceSessionEndedError) {
    throw new ORPCError("UNAUTHORIZED", { cause: error });
  }

  if (error instanceof DeviceNotOwnedError) {
    // its own reason, before any generic refusal: the "Sair" goes on without revoking
    throw new ORPCError("FORBIDDEN", {
      cause: error,
      data: { reason: error.code },
    });
  }

  if (error instanceof FreshSessionRequiredError) {
    throw new ORPCError("FORBIDDEN", {
      cause: error,
      data: { reason: error.code },
    });
  }

  if (
    error instanceof OfflineLeaseUnavailableError ||
    error instanceof SyncPayloadHashUnavailableError
  ) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
  }

  if (error instanceof InvalidExportRequestError) {
    // a malformed request is the caller's to fix; the other refusals are the state of the organization's exports
    throw clientRpcError(
      error.code === "invalid_export_request" ? "BAD_REQUEST" : "CONFLICT",
      error
    );
  }

  if (isRpcErrorInGroup(error, badRequestRpcErrors)) {
    throw clientRpcError("BAD_REQUEST", error);
  }

  if (isRpcErrorInGroup(error, stockConflictRpcErrors)) {
    throw clientRpcError("CONFLICT", error);
  }

  if (matchesRpcError(error, [ProductVariantConfigurationError])) {
    throw clientRpcError("BAD_REQUEST", error);
  }

  if (isRpcErrorInGroup(error, conflictRpcErrors)) {
    throw clientRpcError("CONFLICT", error);
  }

  if (isRpcErrorInGroup(error, notFoundRpcErrors)) {
    throw clientRpcError("NOT_FOUND", error);
  }

  if (error instanceof CreateInitialOrganizationError) {
    throw new ORPCError(initialOrganizationErrorCode(error.code), {
      cause: error,
      // the ceiling has its own text on the screen (decision L6); the other codes stay without a reason
      data:
        error.code === "organization_limit_reached"
          ? { reason: error.code }
          : undefined,
    });
  }

  throw error;
}

interface RpcErrorConstructor {
  prototype: Error;
  new (...args: never[]): Error;
}

function matchesRpcError(
  error: unknown,
  constructors: readonly RpcErrorConstructor[]
) {
  return constructors.some((ErrorType) => error instanceof ErrorType);
}

function isRpcErrorInGroup(
  error: unknown,
  groups: readonly (readonly RpcErrorConstructor[])[]
) {
  return groups.some((constructors) => matchesRpcError(error, constructors));
}

const badRequestRpcErrors = [
  [
    CategoryNameError,
    ProductNameError,
    ProductDescriptionError,
    InvalidPaymentProfileError,
    ClosureConfirmationError,
  ],
  [
    InvalidCustomerProfileError,
    InvalidCustomerDuplicateSearchError,
    InvalidOperationalSelectionError,
    InvalidPublicCatalogProfileError,
  ],
  [
    InvalidExpenseError,
    InvalidExpenseCategoryError,
    ExpenseCompetenceOutOfRangeError,
    InvalidExpenseRuleError,
    InvalidGoalError,
    InvalidEconomicsPeriodError,
    InvalidTopProductsError,
  ],
  [
    InvalidDeviceLabelError,
    InvalidSyncCursorError,
    InvalidVariantListPriceError,
    InvalidOfflineGrantWindowError,
    InvalidOfflineGrantRevokeReasonError,
  ],
  [
    InvalidStockMovementError,
    InventoryOccurredInFutureError,
    InvalidUnitCostError,
    InventoryCostLimitError,
    InvalidReceiveStockInputError,
    UnsupportedReceiveStockCommandVersionError,
  ],
  [
    InvalidInventoryCountInputError,
    UnsupportedInventoryCountCommandVersionError,
    InvalidWriteOffStockInputError,
    UnsupportedWriteOffStockCommandVersionError,
    InvalidInventoryBalanceCursorError,
  ],
  [
    InvalidConfirmSaleCommandError,
    SaleOccurredInFutureError,
    InvalidSaleCustomerLinkError,
    InvalidSaleCancellationError,
    InvalidSaleReturnError,
    SaleOccurredTooOldError,
    UnsupportedSaleCancellationCommandVersionError,
    UnsupportedSaleReturnCommandVersionError,
    UnsupportedConfirmSaleCommandVersionError,
    InvalidSaleAdjustmentError,
    SaleAdjustmentLimitError,
    SaleDiscountExceedsSubtotalError,
    InvalidSalePaymentError,
    InvalidSaleSnapshotError,
  ],
  [
    InvalidMoneyError,
    InvalidPercentageError,
    InvalidDecimalAmountError,
    DecimalAmountScaleError,
    InvalidFinancialQuantityError,
    MoneyLimitError,
  ],
] as const;

const stockConflictRpcErrors = [
  [InsufficientStockError, InventoryQuantityLimitError],
  [
    InventoryCostUnavailableError,
    StockCommandConflictError,
    InventoryVersionConflictError,
  ],
] as const;

const conflictRpcErrors = [
  [
    CategoryDeletedError,
    CategoryInUseError,
    CategoryNameConflictError,
    CategoryLifecycleError,
    ProductCategoryUnavailableError,
    CustomerAnonymizedError,
  ],
  [
    ExpenseCategoryNameConflictError,
    ExpenseCategoryUnavailableError,
    ExpenseCategoryVersionConflictError,
    ExpenseVersionConflictError,
    ExpenseVoidedError,
    ExpenseRuleVersionConflictError,
    GoalLimitReachedError,
    GoalPausedByPlanError,
    EntitlementDeniedError,
    EntitlementLimitReachedError,
    EntitlementVariantLockedError,
    OperationalSelectionError,
    GoalNotActiveError,
    GoalPeriodEndedError,
    GoalVersionConflictError,
    PublicCatalogSlugTakenError,
    PublicCatalogVersionConflictError,
    PublicCatalogProfileMissingError,
    PublicCatalogProductUnavailableError,
    OrganizationNotActiveError,
    ClosureNotRecoverableError,
    AnotherOrganizationActiveError,
  ],
  [
    ProductDeletedError,
    ProductLifecycleError,
    ProductStockNotEmptyError,
    ProductDefaultVariantSkuConflictError,
    ProductDefaultVariantStockHistoryConflictError,
    ProductVariantSkuConflictError,
    ProductIdConflictError,
    ProductCreateConflictError,
  ],
  [
    ProductVariantsAlreadyConfiguredError,
    ProductVersionConflictError,
    CustomerVersionConflictError,
    PaymentProfileVersionConflictError,
    PaymentProfileLifecycleError,
  ],
  [SaleCommandConflictError, SaleProductUnavailableError],
  [DeviceRevokedError, DeviceLimitError, OfflineLeaseNotAvailableError],
  [SaleAlreadyCancelledError, SaleCancellationCommandConflictError],
  [
    SaleHasReturnsError,
    SaleNotReturnableError,
    SaleReturnCommandConflictError,
    SaleReturnExceedsAvailableError,
  ],
  [
    SaleCustomerArchivedError,
    SaleCustomerLinkStateError,
    SaleCustomerLinkVersionConflictError,
  ],
] as const;

const notFoundRpcErrors = [
  [DataExportUnavailableError],
  [CategoryNotFoundError, ProductNotFoundError, CustomerNotFoundError],
  [
    PaymentProfileNotFoundError,
    ProductVariantNotFoundError,
    InventoryVariantNotFoundError,
  ],
  [SaleNotFoundError],
  [
    ExpenseCategoryNotFoundError,
    ExpenseNotFoundError,
    ExpenseSaleNotFoundError,
    ExpenseRuleNotFoundError,
    GoalNotFoundError,
  ],
  [DeviceNotFoundError, OfflineGrantNotFoundError],
] as const;

async function productLifecycleCommand(
  context: PolarisRpcContext,
  input: ProductLifecycleInput,
  tenantRequest: RpcRouterDependencies["withTenantRequestContext"],
  mutateProduct?: RpcRouterDependencies["archiveProduct"]
) {
  const command = mutateProduct ?? deleteProduct;
  try {
    const result = await tenantRequest({
      bindings: context.bindings,
      capability: "product:update",
      operation: (transaction, identity) =>
        command(transaction, identity, {
          expectedVersion: input.expectedVersion,
          id: input.id,
          requestId: requestAuditId(context.requestId),
        }),
      request: context.request,
      requestedOrganizationId: input.organizationId,
    });
    return {
      changed: result.changed,
      product: productReadModel(result.product),
    };
  } catch (error) {
    return toRpcError(error);
  }
}

async function customerLifecycleCommand(
  context: PolarisRpcContext,
  input: CustomerLifecycleInput,
  tenantRequest: RpcRouterDependencies["withTenantRequestContext"],
  command: RpcRouterDependencies["archiveCustomer"]
) {
  try {
    const result = await tenantRequest({
      bindings: context.bindings,
      capability: "customer:update",
      operation: (transaction, identity) =>
        command(transaction, identity, {
          expectedVersion: input.expectedVersion,
          id: input.id,
          requestId: requestAuditId(context.requestId),
        }),
      request: context.request,
      requestedOrganizationId: input.organizationId,
    });
    return {
      changed: result.changed,
      customer: customerReadModel(result.customer),
    };
  } catch (error) {
    return toRpcError(error);
  }
}

function createCustomerRpcHandlers(
  dependencies: Partial<
    Pick<
      RpcRouterDependencies,
      | "anonymizeCustomerForPrivacy"
      | "archiveCustomer"
      | "createCustomer"
      | "findPossibleCustomerDuplicates"
      | "listCustomers"
      | "restoreCustomer"
      | "updateCustomer"
    >
  > &
    Pick<RpcRouterDependencies, "withTenantRequestContext">
) {
  const anonymizeTenantCustomer =
    dependencies.anonymizeCustomerForPrivacy ?? anonymizeCustomerForPrivacy;
  const archiveTenantCustomer = dependencies.archiveCustomer ?? archiveCustomer;
  const createTenantCustomer = dependencies.createCustomer ?? createCustomer;
  const findTenantCustomerDuplicates =
    dependencies.findPossibleCustomerDuplicates ??
    findPossibleCustomerDuplicates;
  const listTenantCustomers = dependencies.listCustomers ?? listCustomers;
  const restoreTenantCustomer = dependencies.restoreCustomer ?? restoreCustomer;
  const updateTenantCustomer = dependencies.updateCustomer ?? updateCustomer;
  const tenantRequest = dependencies.withTenantRequestContext;
  const implementContract =
    implement(polarisContract).$context<PolarisRpcContext>();

  const list = implementContract.customer.list.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "customer:update",
          operation: async (transaction, identity) => ({
            customers: await listTenantCustomers(transaction, identity, {
              status: input.status,
            }),
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return { customers: result.customers.map(customerReadModel) };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const create = implementContract.customer.create.handler(
    async ({ context, input }) => {
      try {
        const customer = await tenantRequest({
          bindings: context.bindings,
          capability: "customer:update",
          operation: (transaction, identity) =>
            createTenantCustomer(transaction, identity, {
              email: input.email,
              name: input.name,
              notes: input.notes,
              phone: input.phone,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return customerReadModel(customer);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const findPossibleDuplicates =
    implementContract.customer.findPossibleDuplicates.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "customer:update",
            operation: async (transaction, identity) => ({
              matches: await findTenantCustomerDuplicates(
                transaction,
                identity,
                {
                  email: input.email,
                  phone: input.phone,
                }
              ),
            }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            matches: result.matches.map(({ customer, matchedBy }) => ({
              customer: customerReadModel(customer),
              matchedBy,
            })),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const update = implementContract.customer.update.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "customer:update",
          operation: (transaction, identity) =>
            updateTenantCustomer(transaction, identity, {
              email: input.email,
              expectedVersion: input.expectedVersion,
              id: input.id,
              name: input.name,
              notes: input.notes,
              phone: input.phone,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          customer: customerReadModel(result.customer),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archive = implementContract.customer.archive.handler(
    ({ context, input }) =>
      customerLifecycleCommand(
        context,
        input,
        tenantRequest,
        archiveTenantCustomer
      )
  );

  const restore = implementContract.customer.restore.handler(
    ({ context, input }) =>
      customerLifecycleCommand(
        context,
        input,
        tenantRequest,
        restoreTenantCustomer
      )
  );

  const anonymizeForPrivacy =
    implementContract.customer.anonymizeForPrivacy.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "customer:anonymize",
            operation: (transaction, identity) =>
              anonymizeTenantCustomer(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.id,
                requestId: requestAuditId(context.requestId),
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            changed: result.changed,
            customer: customerReadModel(result.customer),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  return {
    anonymizeForPrivacy,
    archive,
    create,
    findPossibleDuplicates,
    list,
    restore,
    update,
  };
}

function createPaymentProfileRpcHandlers(
  dependencies: Partial<
    Pick<
      RpcRouterDependencies,
      | "archivePaymentProfile"
      | "createPaymentProfile"
      | "listPaymentProfiles"
      | "restorePaymentProfile"
      | "updatePaymentProfile"
    >
  > &
    Pick<RpcRouterDependencies, "withTenantRequestContext">
) {
  const archiveTenantProfile =
    dependencies.archivePaymentProfile ?? archivePaymentProfile;
  const createTenantProfile =
    dependencies.createPaymentProfile ?? createPaymentProfile;
  const listTenantProfiles =
    dependencies.listPaymentProfiles ?? listPaymentProfiles;
  const restoreTenantProfile =
    dependencies.restorePaymentProfile ?? restorePaymentProfile;
  const updateTenantProfile =
    dependencies.updatePaymentProfile ?? updatePaymentProfile;
  const tenantRequest = dependencies.withTenantRequestContext;
  const implementContract =
    implement(polarisContract).$context<PolarisRpcContext>();

  const list = implementContract.paymentProfile.list.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "organization:manage",
          operation: async (transaction, identity) => ({
            profiles: await listTenantProfiles(transaction, identity, {
              status: input.status,
            }),
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          profiles: result.profiles.map(paymentProfileReadModel),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const create = implementContract.paymentProfile.create.handler(
    async ({ context, input }) => {
      try {
        const profile = await tenantRequest({
          bindings: context.bindings,
          capability: "organization:manage",
          operation: (transaction, identity) =>
            createTenantProfile(transaction, identity, {
              name: input.name,
              requestId: requestAuditId(context.requestId),
              rules: input.rules,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return paymentProfileReadModel(profile);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const update = implementContract.paymentProfile.update.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "organization:manage",
          operation: (transaction, identity) =>
            updateTenantProfile(transaction, identity, {
              expectedVersion: input.expectedVersion,
              id: input.id,
              name: input.name,
              requestId: requestAuditId(context.requestId),
              rules: input.rules,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          profile: paymentProfileReadModel(result.profile),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archive = implementContract.paymentProfile.archive.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "organization:manage",
          operation: (transaction, identity) =>
            archiveTenantProfile(transaction, identity, {
              expectedVersion: input.expectedVersion,
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          profile: paymentProfileReadModel(result.profile),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const restore = implementContract.paymentProfile.restore.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "organization:manage",
          operation: (transaction, identity) =>
            restoreTenantProfile(transaction, identity, {
              expectedVersion: input.expectedVersion,
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          profile: paymentProfileReadModel(result.profile),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  return { archive, create, list, restore, update };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one `overrides.x ?? x` per dependency; splitting the router is tracked in the review backlog.
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
  const archiveTenantCategory = overrides.archiveCategory ?? archiveCategory;
  const restoreTenantCategory = overrides.restoreCategory ?? restoreCategory;
  const deleteTenantCategory = overrides.deleteCategory ?? deleteCategory;
  const renameTenantCategory = overrides.renameCategory ?? renameCategory;
  const listTenantProducts = overrides.listProducts ?? listProducts;
  const createTenantProduct = overrides.createProduct ?? createProduct;
  const createTenantProductWithOpeningStock =
    overrides.createProductWithOpeningStock ?? createProductWithOpeningStock;
  const tenantToday = overrides.organizationToday ?? organizationToday;
  const getTenantProductVariants =
    overrides.getProductVariants ?? getProductVariants;
  const configureTenantProductVariants =
    overrides.configureProductVariants ?? configureProductVariants;
  const setTenantProductVariantSku =
    overrides.setProductVariantSku ?? setProductVariantSku;
  const setTenantProductVariantListPrice =
    overrides.setProductVariantListPrice ?? setProductVariantListPrice;
  const updateTenantProduct = overrides.updateProduct ?? updateProduct;
  const archiveTenantProduct = overrides.archiveProduct ?? archiveProduct;

  const restoreTenantProduct = overrides.restoreProduct ?? restoreProduct;
  const receiveTenantStock = overrides.receiveStock ?? receiveStock;
  const writeOffTenantStock = overrides.writeOffStock ?? writeOffStock;
  const implementContract =
    implement(polarisContract).$context<PolarisRpcContext>();
  const inventoryHandlers = createInventoryRpcHandlers({
    defaultGetInventoryBalance: getInventoryBalance,
    defaultInventoryCount: inventoryCount,
    defaultListInventoryBalances: listInventoryBalances,
    getInventoryBalance: overrides.getInventoryBalance,
    inventoryCount: overrides.inventoryCount,
    listInventoryBalances: overrides.listInventoryBalances,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const offlineHandlers = createOfflineRpcHandlers({
    accessLogWriter: (connection) =>
      guardAccessLogWriter(
        (overrides.accessLogWriter ?? createDatabaseAccessLogWriter)(connection)
      ),
    defaultIssueOfflineLeaseGrant: issueOfflineLeaseGrant,
    defaultListDevices: listDevices,
    defaultRegisterDevice: registerDevice,
    defaultRevokeDevice: revokeDevice,
    defaultRevokeOwnDevice: revokeOwnDevice,
    defaultTouchDevice: touchDevice,
    issueOfflineLeaseGrant: overrides.issueOfflineLeaseGrant,
    listDevices: overrides.listDevices,
    registerDevice: overrides.registerDevice,
    requestAuditId,
    revokeDevice: overrides.revokeDevice,
    revokeOwnDevice: overrides.revokeOwnDevice,
    toRpcError,
    touchDevice: overrides.touchDevice,
    withAuthenticatedRequestContext: authenticatedRequest,
    withTenantRequestContext: tenantRequest,
  });
  const syncHandlers = createSyncRpcHandlers({
    commandHandlers: overrides.syncCommandHandlers ?? syncCommandHandlers,
    defaultRunSyncCommand: runSyncCommand,
    now: () => new Date(),
    runSyncCommand: overrides.runSyncCommand,
    defaultGetSyncCursor: getSyncCursor,
    defaultPullSyncChanges: pullSyncChanges,
    defaultReadBootstrapPage: readBootstrapPage,
    getSyncCursor: overrides.getSyncCursor,
    pullSyncChanges: overrides.pullSyncChanges,
    readBootstrapPage: overrides.readBootstrapPage,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const organizationHandlers = createOrganizationRpcHandlers({
    closureRepository: {
      getClosedOrganizationStatus,
      listClosedOrganizations,
      listOrganizationsInClosure,
      recoverOrganizationClosure,
      requestOrganizationClosure,
      ...overrides.closureRepository,
    },
    defaultListUserOrganizations: listUserOrganizations,
    listUserOrganizations: overrides.listUserOrganizations,
    readRenewalStatuses:
      overrides.readRenewalStatuses ?? createRenewalStatusReader(),
    toRpcError,
    withAuthenticatedRequestContext: authenticatedRequest,
    withTenantRequestContext: tenantRequest,
  });
  const customerHandlers = createCustomerRpcHandlers({
    ...overrides,
    withTenantRequestContext: tenantRequest,
  });
  const expenseHandlers = createExpenseRpcHandlers({
    expenseRepository: overrides.expenseRepository,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const dataExportHandlers = createDataExportRpcHandlers({
    dataExportRepository: overrides.dataExportRepository,
    requestAuditId,
    toRpcError,
    withAuthenticatedRequestContext: authenticatedRequest,
    withTenantRequestContext: tenantRequest,
  });
  const goalHandlers = createGoalRpcHandlers({
    goalRepository: overrides.goalRepository,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const billingHandlers = createBillingRpcHandlers({
    ...overrides.billing,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const planHandlers = createPlanRpcHandlers({
    planRepository: overrides.planRepository,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const publicCatalogHandlers = createPublicCatalogRpcHandlers({
    publicCatalogRepository: overrides.publicCatalogRepository,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const accountHandlers = createAccountRpcHandlers({
    readAcceptedLegalVersions: overrides.readAcceptedLegalVersions,
    recordLegalAcceptance: overrides.recordLegalAcceptance,
    toRpcError,
    withAuthenticatedRequestContext: authenticatedRequest,
  });
  const reportHandlers = createReportRpcHandlers({
    readPeriodSummary: overrides.readPeriodSummary,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });
  const paymentProfileHandlers = createPaymentProfileRpcHandlers({
    ...overrides,
    withTenantRequestContext: tenantRequest,
  });
  const saleHandlers = createSaleRpcHandlers({
    cancelSale: overrides.cancelSale,
    changeSaleCustomerLink: overrides.changeSaleCustomerLink,
    confirmSale: overrides.confirmSale,
    createSaleReturn: overrides.createSaleReturn,
    defaultCancelSale: cancelSale,
    defaultChangeSaleCustomerLink: changeSaleCustomerLink,
    defaultConfirmSale: confirmSale,
    defaultCreateSaleReturn: createSaleReturn,
    defaultGetSale: getSale,
    defaultGetSaleCustomerLink: getSaleCustomerLink,
    defaultListSales: listSales,
    getSale: overrides.getSale,
    getSaleCustomerLink: overrides.getSaleCustomerLink,
    listSales: overrides.listSales,
    requestAuditId,
    toRpcError,
    withTenantRequestContext: tenantRequest,
  });

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
          status: OrganizationStatus;
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
          categories: await listTenantCategories(transaction, identity, {
            status: input.status,
          }),
        }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      } satisfies TenantRequestContextInput<{
        categories: Awaited<ReturnType<typeof listTenantCategories>>;
      }>;

      try {
        const result = await tenantRequest(tenantInput);
        return { categories: result.categories.map(categoryReadModel) };
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
        return categoryReadModel(await tenantRequest(tenantInput));
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archive = implementContract.category.archive.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            archiveTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const restore = implementContract.category.restore.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            restoreTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const rename = implementContract.category.rename.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            renameTenantCategory(transaction, identity, {
              id: input.id,
              name: input.name,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const remove = implementContract.category.delete.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "category:manage",
          operation: (transaction, identity) =>
            deleteTenantCategory(transaction, identity, {
              id: input.id,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          category: categoryReadModel(result.category),
          changed: result.changed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const listProduct = implementContract.product.list.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "catalog:read",
          operation: async (transaction, identity) => ({
            products: await listTenantProducts(transaction, identity, {
              status: input.status,
            }),
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return { products: result.products.map(productReadModel) };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const createProductRecord = implementContract.product.create.handler(
    async ({ context, input }) => {
      try {
        const product = await tenantRequest({
          bindings: context.bindings,
          capability: "product:create",
          operation: async (transaction, identity) => {
            // the opening stock is dated today in the store's time zone, read here on the server
            const occurredOn = input.initialStock
              ? await tenantToday(transaction, identity)
              : "";
            const created = await createTenantProductWithOpeningStock(
              transaction,
              identity,
              {
                categoryId: input.categoryId ?? null,
                description: input.description ?? null,
                initialStock: input.initialStock ?? null,
                listPrice: input.listPrice ?? null,
                name: input.name,
                productId: input.productId,
                requestId: requestAuditId(context.requestId),
                variantId: input.variantId,
              },
              occurredOn,
              {
                createProduct: createTenantProduct,
                inventoryCount: overrides.inventoryCount ?? inventoryCount,
                readProductCreation,
                receiveStock: receiveTenantStock,
              }
            );
            return created.product;
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return productReadModel(product);
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const updateProductRecord = implementContract.product.update.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "product:update",
          operation: (transaction, identity) =>
            updateTenantProduct(transaction, identity, {
              categoryId: input.categoryId,
              description: input.description,
              expectedVersion: input.expectedVersion,
              id: input.id,
              name: input.name,
              requestId: requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        return {
          changed: result.changed,
          product: productReadModel(result.product),
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const archiveProductRecord = implementContract.product.archive.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        archiveTenantProduct
      )
  );

  const deleteProductRecord = implementContract.product.delete.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        overrides.deleteProduct
      )
  );

  const restoreProductRecord = implementContract.product.restore.handler(
    ({ context, input }) =>
      productLifecycleCommand(
        context,
        input,
        tenantRequest,
        restoreTenantProduct
      )
  );
  const getProductVariantsRecord =
    implementContract.product.getVariants.handler(
      async ({ context, input }) => {
        try {
          return await tenantRequest({
            bindings: context.bindings,
            capability: "catalog:read",
            operation: (transaction, identity) =>
              getTenantProductVariants(transaction, identity, input.id),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const configureProductVariantsRecord =
    implementContract.product.configureVariants.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "product:update",
            operation: (transaction, identity) =>
              configureTenantProductVariants(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.id,
                options: input.options,
                requestId: requestAuditId(context.requestId),
                variants: input.variants.map((variant) => ({
                  values: productVariantValues(variant.values),
                })),
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            configuration: result.configuration,
            product: productReadModel(result.product),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const setProductVariantSkuRecord =
    implementContract.product.setVariantSku.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "product:update",
            operation: (transaction, identity) =>
              setTenantProductVariantSku(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.productId,
                requestId: requestAuditId(context.requestId),
                sku: input.sku,
                variantId: input.variantId,
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            changed: result.changed,
            configuration: result.configuration,
            product: productReadModel(result.product),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const setProductVariantListPriceRecord =
    implementContract.product.setVariantListPrice.handler(
      async ({ context, input }) => {
        try {
          const result = await tenantRequest({
            bindings: context.bindings,
            capability: "product:update",
            operation: (transaction, identity) =>
              setTenantProductVariantListPrice(transaction, identity, {
                expectedVersion: input.expectedVersion,
                id: input.productId,
                listPrice: input.listPrice,
                requestId: requestAuditId(context.requestId),
                variantId: input.variantId,
              }),
            request: context.request,
            requestedOrganizationId: input.organizationId,
          });
          return {
            changed: result.changed,
            configuration: result.configuration,
            product: productReadModel(result.product),
          };
        } catch (error) {
          return toRpcError(error);
        }
      }
    );

  const receiveStockRecord = implementContract.inventory.receiveStock.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "inventory:adjust",
          operation: (transaction, identity) =>
            receiveTenantStock(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              occurredOn: input.occurredOn,
              quantity: input.quantity,
              requestId: requestAuditId(context.requestId),
              unitCost: input.unitCost,
              variantId: input.variantId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });

        const { movement } = result;
        if (
          movement.commandId === null ||
          movement.commandVersion === null ||
          movement.occurredOn === null ||
          movement.unitCost === null ||
          movement.movementType !== "receipt"
        ) {
          throw new Error("received_stock_movement_metadata_missing");
        }

        return {
          balance: result.balance,
          movement: {
            ...movement,
            // The guard above proves these receipt-only nullable DB columns.
            commandId: movement.commandId as string,
            commandVersion: movement.commandVersion as number,
            createdAt: movement.createdAt.toISOString(),
            movementType: "receipt" as const,
            occurredOn: movement.occurredOn as string,
            unitCost: movement.unitCost as string,
          },
          replayed: result.replayed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  const writeOffStockRecord = implementContract.inventory.writeOffStock.handler(
    async ({ context, input }) => {
      try {
        const result = await tenantRequest({
          bindings: context.bindings,
          capability: "inventory:adjust",
          operation: (transaction, identity) =>
            writeOffTenantStock(transaction, identity, {
              commandId: input.commandId,
              commandVersion: input.commandVersion,
              occurredOn: input.occurredOn,
              quantity: input.quantity,
              reasonCode: input.reasonCode,
              reasonNote: input.reasonNote ?? null,
              requestId: requestAuditId(context.requestId),
              variantId: input.variantId,
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });

        const { movement } = result;
        if (
          movement.commandId === null ||
          movement.commandVersion === null ||
          movement.occurredOn === null ||
          movement.reasonCode === null ||
          !isWriteOffReasonCode(movement.reasonCode) ||
          movement.movementType !== "write_off"
        ) {
          throw new Error("written_off_stock_movement_metadata_missing");
        }

        return {
          balance: result.balance,
          movement: {
            ...movement,
            commandId: movement.commandId,
            commandVersion: movement.commandVersion,
            createdAt: movement.createdAt.toISOString(),
            movementType: "write_off" as const,
            occurredOn: movement.occurredOn,
            reasonCode: movement.reasonCode,
          },
          replayed: result.replayed,
        };
      } catch (error) {
        return toRpcError(error);
      }
    }
  );

  // The exempt procedures of the legal acceptance control are marked by the path oRPC matched, so the
  // single control in the request context lets them through and nothing else (ADR 0100).
  return implementContract
    .use(({ context, next, path }) => {
      exemptRpcRequest(context.request, path);
      return next();
    })
    .router({
      account: accountHandlers,
      billing: billingHandlers,
      category: { archive, create, delete: remove, list, rename, restore },
      customer: customerHandlers,
      dataExport: dataExportHandlers,
      device: offlineHandlers.device,
      expense: expenseHandlers,
      goal: goalHandlers,
      inventory: {
        getBalance: inventoryHandlers.getBalance,
        inventoryCount: inventoryHandlers.count,
        listBalances: inventoryHandlers.listBalances,
        receiveStock: receiveStockRecord,
        writeOffStock: writeOffStockRecord,
      },
      offline: offlineHandlers.offline,
      organization: {
        createInitial,
        closedStatus: organizationHandlers.closedStatus,
        listClosed: organizationHandlers.listClosed,
        listClosing: organizationHandlers.listClosing,
        listMine: organizationHandlers.listMine,
        recoverClosure: organizationHandlers.recoverClosure,
        requestClosure: organizationHandlers.requestClosure,
      },
      plan: planHandlers,
      publicCatalog: publicCatalogHandlers,
      report: reportHandlers,
      paymentProfile: paymentProfileHandlers,
      product: {
        archive: archiveProductRecord,
        configureVariants: configureProductVariantsRecord,
        create: createProductRecord,
        delete: deleteProductRecord,
        getVariants: getProductVariantsRecord,
        list: listProduct,
        restore: restoreProductRecord,
        setVariantListPrice: setProductVariantListPriceRecord,
        setVariantSku: setProductVariantSkuRecord,
        update: updateProductRecord,
      },
      sale: {
        assignCustomer: saleHandlers.assignCustomer,
        cancel: saleHandlers.cancel,
        confirm: saleHandlers.confirm,
        get: saleHandlers.get,
        getCustomerLink: saleHandlers.getCustomerLink,
        list: saleHandlers.list,
        reassignCustomer: saleHandlers.reassignCustomer,
        return: saleHandlers.return,
        unassignCustomer: saleHandlers.unassignCustomer,
      },
      sync: syncHandlers,
      system: { ping },
    });
}

export const rpcRouter = createRpcRouter();
