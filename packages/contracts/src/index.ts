import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import {
  MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS,
  WRITE_OFF_REASON_CODES,
} from "@polaris/domain/inventory/write-off-stock";
import {
  EXPENSE_GROUP_KEYS,
  MAX_EXPENSE_CATEGORY_NAME_LENGTH,
  MAX_EXPENSE_DESCRIPTION_LENGTH,
  MAX_EXPENSE_PAYEE_LENGTH,
} from "@polaris/domain/expenses/expense";
import { RECURRENCE_FREQUENCIES } from "@polaris/domain/expenses/recurrence";
import { PAYMENT_FEE_MODES } from "@polaris/domain/sales/payment-profile";
import { SALE_PAYMENT_METHODS } from "@polaris/domain/sales/sale-payment";
import { z } from "zod";

export function categoryNameCodePointLength(name: string): number {
  return [...name.trim()].length;
}

export const categoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => categoryNameCodePointLength(name) <= 100, {
    message: "invalid_category_name",
  });

export const productNameSchema = z.string().trim().min(1).max(200);

const category = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["active", "archived", "deleted"]),
  updatedAt: z.string(),
});

export type CategoryReadModel = z.infer<typeof category>;

const product = z.object({
  archivedAt: z.string().nullable(),
  categoryId: z.string().uuid().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  description: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["active", "archived", "deleted"]),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

export type ProductReadModel = z.infer<typeof product>;

const customerProfileFields = z.object({
  email: z
    .union([z.string().trim().email().max(254), z.string().trim().length(0)])
    .nullable(),
  name: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).nullable(),
  phone: z.string().trim().max(40).nullable(),
});

function requireCustomerContact(
  input: {
    email?: string | null | undefined;
    phone?: string | null | undefined;
  },
  ctx: z.RefinementCtx
) {
  if (!(input.phone || input.email)) {
    ctx.addIssue({
      code: "custom",
      message: "customer_contact_required",
      path: ["phone"],
    });
  }
}

const customer = z.object({
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  email: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  notes: z.string().nullable(),
  organizationId: z.string().min(1),
  phone: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type CustomerReadModel = z.infer<typeof customer>;

const customerDuplicateSearchFields = z
  .object({
    email: customerProfileFields.shape.email.optional(),
    phone: customerProfileFields.shape.phone.optional(),
  })
  .superRefine(requireCustomerContact);

const customerDuplicateMatch = z.object({
  customer,
  matchedBy: z.array(z.enum(["email", "phone"])).min(1),
});

export type CustomerDuplicateMatchReadModel = z.infer<
  typeof customerDuplicateMatch
>;

const expenseGroupKey = z.enum(EXPENSE_GROUP_KEYS);
const expenseCalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const expenseCategory = z.object({
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  groupKey: expenseGroupKey,
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["active", "archived"]),
  systemKey: z.string().nullable(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type ExpenseCategoryReadModel = z.infer<typeof expenseCategory>;

const expense = z.object({
  /** Exact BRL decimal with two places, as text. */
  amount: z.string(),
  categoryGroup: expenseGroupKey,
  categoryId: z.string().uuid(),
  categoryName: z.string().min(1),
  /** Calendar date (YYYY-MM-DD) of the organization: the period it belongs to. */
  competenceOn: z.string(),
  createdAt: z.string().datetime(),
  description: z.string().min(1),
  id: z.string().uuid(),
  organizationId: z.string().min(1),
  payee: z.string().nullable(),
  /** The recurring rule that generated this expense, if any. */
  recurringRuleId: z.string().uuid().nullable(),
  saleId: z.string().uuid().nullable(),
  status: z.enum(["active", "voided"]),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
  voidedAt: z.string().datetime().nullable(),
});

export type ExpenseReadModel = z.infer<typeof expense>;

const expenseRule = z.object({
  amount: z.string(),
  archivedAt: z.string().datetime().nullable(),
  categoryGroup: expenseGroupKey,
  categoryId: z.string().uuid(),
  categoryName: z.string().min(1),
  createdAt: z.string().datetime(),
  description: z.string().min(1),
  endsOn: z.string().nullable(),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  /** How many occurrences were generated so far. */
  generatedCount: z.number().int().nonnegative(),
  id: z.string().uuid(),
  /** Date of the next occurrence to generate, or null when the rule is over. */
  nextOccurrenceOn: z.string().nullable(),
  organizationId: z.string().min(1),
  payee: z.string().nullable(),
  startsOn: z.string(),
  /** Archived is paused: it generates nothing until restored. */
  status: z.enum(["active", "archived"]),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type ExpenseRuleReadModel = z.infer<typeof expenseRule>;

const expenseRuleFields = z.object({
  amount: z.string().trim().min(1).max(64),
  categoryId: z.string().uuid(),
  description: z
    .string()
    .trim()
    .min(1)
    .refine((text) => [...text].length <= MAX_EXPENSE_DESCRIPTION_LENGTH, {
      message: "invalid_expense_rule",
    }),
  endsOn: expenseCalendarDate.nullish(),
  payee: z
    .string()
    .trim()
    .refine((text) => [...text].length <= MAX_EXPENSE_PAYEE_LENGTH, {
      message: "invalid_expense_rule",
    })
    .nullish(),
});

const expenseFields = z.object({
  amount: z.string().trim().min(1).max(64),
  categoryId: z.string().uuid(),
  competenceOn: expenseCalendarDate,
  // limits in code points, like the domain and the database
  description: z
    .string()
    .trim()
    .min(1)
    .refine((text) => [...text].length <= MAX_EXPENSE_DESCRIPTION_LENGTH, {
      message: "invalid_expense",
    }),
  payee: z
    .string()
    .trim()
    .refine((text) => [...text].length <= MAX_EXPENSE_PAYEE_LENGTH, {
      message: "invalid_expense",
    })
    .nullish(),
  saleId: z.string().uuid().nullish(),
});

const expenseVersionTarget = z.object({
  expectedVersion: z.number().int().positive(),
  id: z.string().uuid(),
  organizationId: z.string().trim().min(1),
});

const expenseCategoryName = z
  .string()
  .trim()
  .min(1)
  .refine((name) => [...name].length <= MAX_EXPENSE_CATEGORY_NAME_LENGTH, {
    message: "invalid_expense_category",
  });

const paymentFeeConfiguration = z
  .object({
    fixedAmount: z.string().trim().min(1).max(64).nullable(),
    mode: z.enum(PAYMENT_FEE_MODES),
    percentage: z.string().trim().min(1).max(64).nullable(),
  })
  .superRefine((fee, ctx) => {
    const hasFixed = fee.fixedAmount !== null;
    const hasPercentage = fee.percentage !== null;
    const valid =
      ((fee.mode === "unknown" || fee.mode === "none") &&
        !hasFixed &&
        !hasPercentage) ||
      (fee.mode === "fixed" && hasFixed && !hasPercentage) ||
      (fee.mode === "percentage" && !hasFixed && hasPercentage) ||
      (fee.mode === "fixed_and_percentage" && hasFixed && hasPercentage);
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        message: "invalid_payment_fee_configuration",
      });
    }
  });

export type PaymentFeeConfigurationReadModel = z.infer<
  typeof paymentFeeConfiguration
>;

const paymentProfileRuleFields = z
  .object({
    anticipationFee: paymentFeeConfiguration,
    expectedSettlementDays: z
      .number()
      .int()
      .nonnegative()
      .max(2_147_483_647)
      .nullable(),
    installmentPlan: z.enum(["merchant", "issuer"]).nullable(),
    installments: z.number().int().positive().max(2_147_483_647).nullable(),
    method: z.enum(SALE_PAYMENT_METHODS),
    processingFee: paymentFeeConfiguration,
  })
  .superRefine((rule, ctx) => {
    const cardRuleValid =
      rule.installments !== null && rule.installmentPlan !== null;
    const nonCardRuleValid =
      rule.installments === null && rule.installmentPlan === null;
    if (
      (rule.method === "credit_card" && !cardRuleValid) ||
      (rule.method !== "credit_card" && !nonCardRuleValid)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "invalid_payment_profile_rule_installments",
        path: ["installments"],
      });
    }
  });

const paymentProfileRule = paymentProfileRuleFields.extend({
  id: z.string().uuid(),
});

export type PaymentProfileRuleReadModel = z.infer<typeof paymentProfileRule>;
export type PaymentProfileRuleInput = z.infer<typeof paymentProfileRuleFields>;

const paymentProfileFields = z.object({
  name: z.string().trim().min(1).max(100),
  rules: z.array(paymentProfileRuleFields).min(1),
});

const paymentProfile = z.object({
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  rules: z.array(paymentProfileRule),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type PaymentProfileReadModel = z.infer<typeof paymentProfile>;
export const paymentProfileReadModelSchema = paymentProfile;

export const productMediaAssetReadModelSchema = z.object({
  assetId: z.string().uuid(),
  byteSize: z.number().int().positive().max(20_000_000),
  contentType: z.literal("image/webp"),
  createdAt: z.string().datetime(),
  height: z.number().int().positive().max(1200),
  position: z.number().int().nonnegative(),
  variantIds: z.array(z.string().uuid()),
  width: z.number().int().positive().max(1200),
});

export type ProductMediaAssetReadModel = z.infer<
  typeof productMediaAssetReadModelSchema
>;

export const productMediaUploadResponseSchema = z.object({
  asset: productMediaAssetReadModelSchema,
  replayed: z.boolean(),
  requestId: z.string().uuid(),
});

export type ProductMediaUploadResponse = z.infer<
  typeof productMediaUploadResponseSchema
>;

export const productMediaListResponseSchema = z.object({
  media: z.array(productMediaAssetReadModelSchema),
  requestId: z.string().uuid(),
});

export type ProductMediaListResponse = z.infer<
  typeof productMediaListResponseSchema
>;

const productVariantOptionName = z.enum(["model", "color", "size"]);

const productVariantOptionValue = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
});

const productVariantOption = z.object({
  id: z.string().uuid(),
  name: productVariantOptionName,
  position: z.number().int().nonnegative(),
  values: z.array(productVariantOptionValue),
});

const productVariantOptionAssignment = z.object({
  optionName: productVariantOptionName,
  optionValueId: z.string().uuid(),
  optionValueName: z.string().min(1),
});

/** A BRL list price as the server writes it: whole reais and two decimals. */
const listPriceText = z.string().regex(/^\d{1,18}\.\d{2}$/);

const productVariant = z.object({
  id: z.string().uuid(),
  isDefault: z.boolean(),
  listPrice: listPriceText.nullable(),
  position: z.number().int().nonnegative().nullable(),
  sku: z.string().nullable(),
  values: z.array(productVariantOptionAssignment),
});

const productVariantConfiguration = z.object({
  configured: z.boolean(),
  options: z.array(productVariantOption),
  productVersion: z.number().int().positive(),
  variants: z.array(productVariant),
});

export type ProductVariantOptionName = z.infer<typeof productVariantOptionName>;
export type ProductVariantConfigurationReadModel = z.infer<
  typeof productVariantConfiguration
>;

const normalizedBrlCost = z.string().regex(/^\d{1,18}\.\d{6}$/);
const writeOffReasonNote = z
  .string()
  .trim()
  .min(1)
  .refine((note) => [...note].length <= MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS, {
    message: "invalid_write_off_reason_note",
  });

const inventoryBalance = z.object({
  movingAverageCost: normalizedBrlCost.nullable(),
  quantity: z.number().int().nonnegative().max(2_147_483_647),
  variantId: z.string().uuid(),
  version: z.number().int().nonnegative().max(2_147_483_647),
});

const stockReceiptMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  id: z.string().uuid(),
  movementType: z.literal("receipt"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().positive().max(2_147_483_647),
  unitCost: normalizedBrlCost,
  variantId: z.string().uuid(),
});

const stockWriteOffMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  id: z.string().uuid(),
  movementType: z.literal("write_off"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().negative().min(-2_147_483_647),
  reasonCode: z.enum(WRITE_OFF_REASON_CODES),
  reasonNote: writeOffReasonNote.nullable(),
  unitCost: normalizedBrlCost.nullable(),
  variantId: z.string().uuid(),
});

export type InventoryBalanceReadModel = z.infer<typeof inventoryBalance>;
export type StockReceiptMovementReadModel = z.infer<
  typeof stockReceiptMovement
>;
export type StockWriteOffMovementReadModel = z.infer<
  typeof stockWriteOffMovement
>;

const inventoryCountMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  id: z.string().uuid(),
  movementType: z.literal("inventory_count"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  physicalQuantity: z.number().int().nonnegative().max(2_147_483_647),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().min(-2_147_483_647).max(2_147_483_647),
  unitCost: normalizedBrlCost.nullable(),
  variantId: z.string().uuid(),
});

export type InventoryCountMovementReadModel = z.infer<
  typeof inventoryCountMovement
>;

const inventoryBalanceEntry = z.object({
  isDefaultVariant: z.boolean(),
  listPrice: listPriceText.nullable(),
  movingAverageCost: normalizedBrlCost.nullable(),
  productId: z.string().uuid(),
  productName: z.string().min(1),
  productStatus: z.enum(["active", "archived"]),
  quantity: z.number().int().nonnegative().max(2_147_483_647),
  sku: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
  values: z.array(
    z.object({
      optionName: productVariantOptionName,
      optionValueName: z.string().min(1),
    })
  ),
  variantId: z.string().uuid(),
  version: z.number().int().nonnegative().max(2_147_483_647),
});

export type InventoryBalanceEntryReadModel = z.infer<
  typeof inventoryBalanceEntry
>;

const calendarDateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().startsWith(`${value}T`)
      );
    },
    { message: "invalid_calendar_date" }
  );

const saleAdjustmentKinds = [
  "discount",
  "surcharge",
  "freight",
  "payment_surcharge",
] as const;

const saleAdjustmentInput = z.object({
  kind: z.enum(saleAdjustmentKinds),
  value: z.discriminatedUnion("type", [
    z.object({
      amount: z.string().trim().min(1).max(64),
      type: z.literal("fixed"),
    }),
    z.object({
      percentage: z.string().trim().min(1).max(64),
      type: z.literal("percentage"),
    }),
  ]),
});

const saleItemInput = z.object({
  chargedUnitPrice: z.string().trim().min(1).max(64),
  listedUnitPrice: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(2_147_483_647),
  variantId: z.string().uuid(),
});

/** The payment profile a sale was priced with, by the version the person saw. */
const salePaymentProfileSelection = z.object({
  // the database column is an integer: a bigger number is not a version, and must not reach it
  expectedVersion: z.number().int().positive().max(2_147_483_647),
  id: z.string().uuid(),
});

const salePaymentInput = z.object({
  anticipationRequested: z.boolean(),
  installmentPlan: z.enum(["merchant", "issuer"]).nullable(),
  installments: z.number().int().positive().max(2_147_483_647).nullable(),
  method: z.enum(SALE_PAYMENT_METHODS),
});

/**
 * The payload of the offline `sale.confirm` command (plan PR57): what a device
 * can state about a sale without the server. The command ID, the organization
 * and the command version come from the sync frame. The payment profile is
 * optional (absent or null: the plain payment method): a device that saw the
 * profile on its last connection names it by id and by the version it saw, and
 * the server refuses the sale if that version is not the current one (the fees
 * and the term the person was shown would not be the ones recorded).
 */
export const offlineSalePayloadSchema = z
  .object({
    adjustments: z.array(saleAdjustmentInput).max(20),
    items: z.array(saleItemInput).min(1).max(200),
    occurredAt: z.string().datetime({ offset: true }),
    payment: salePaymentInput,
    paymentProfile: salePaymentProfileSelection.nullable().optional(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type OfflineSalePayload = z.infer<typeof offlineSalePayloadSchema>;

const saleFeeSnapshot = z.object({
  amount: z.string().nullable(),
  fixedAmount: z.string().nullable(),
  mode: z.enum([...PAYMENT_FEE_MODES, "not_applicable"]),
  percentage: z.string().nullable(),
});

const confirmedSale = z.object({
  adjustments: z.array(
    z.object({
      amount: z.string(),
      kind: z.enum(saleAdjustmentKinds),
      percentage: z.string().nullable(),
      position: z.number().int().nonnegative(),
      valueType: z.enum(["fixed", "percentage"]),
    })
  ),
  items: z.array(
    z.object({
      chargedUnitPrice: z.string(),
      listedUnitPrice: z.string(),
      position: z.number().int().nonnegative(),
      productId: z.string().uuid(),
      productLabel: z.string().min(1),
      quantity: z.number().int().positive(),
      unitCost: z.string().nullable(),
      variantId: z.string().uuid(),
    })
  ),
  payment: z.object({
    amount: z.string(),
    anticipationFee: saleFeeSnapshot,
    anticipationRequested: z.boolean(),
    expectedSettlementDays: z.number().int().nonnegative().nullable(),
    installmentPlan: z.enum(["merchant", "issuer"]).nullable(),
    installments: z.number().int().positive().nullable(),
    method: z.enum(SALE_PAYMENT_METHODS),
    paymentProfileId: z.string().uuid().nullable(),
    paymentProfileName: z.string().nullable(),
    paymentProfileRuleId: z.string().uuid().nullable(),
    paymentProfileVersion: z.number().int().positive().nullable(),
    processingFee: saleFeeSnapshot,
  }),
  replayed: z.boolean(),
  sale: z.object({
    commandId: z.string().uuid(),
    confirmedAt: z.string().datetime(),
    currency: z.literal("BRL"),
    id: z.string().uuid(),
    occurredAt: z.string().datetime(),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    recordedAt: z.string().datetime().nullable(),
  }),
  totals: z.object({
    discountTotal: z.string(),
    freightTotal: z.string(),
    paymentSurchargeTotal: z.string(),
    subtotal: z.string(),
    surchargeTotal: z.string(),
    totalDue: z.string(),
  }),
});

export type ConfirmedSaleReadModel = z.infer<typeof confirmedSale>;

const cancellationReasonCodes = [
  "customer_request",
  "entry_error",
  "payment_issue",
  "other",
] as const;

const saleCancellation = z.object({
  cancelledAt: z.string().datetime(),
  cancelledBy: z.string().min(1),
  commandId: z.string().uuid(),
  id: z.string().uuid(),
  reasonCode: z.enum(cancellationReasonCodes).nullable(),
  reasonNote: z.string().nullable(),
  saleId: z.string().uuid(),
});

export type SaleCancellationReadModel = z.infer<typeof saleCancellation>;

const cancelledSaleResult = z.object({
  cancellation: saleCancellation,
  replayed: z.boolean(),
  restocked: z.array(
    z.object({
      position: z.number().int().nonnegative(),
      quantity: z.number().int().positive(),
      variantId: z.string().uuid(),
    })
  ),
});

const returnReasonCodes = [
  "customer_request",
  "defective",
  "wrong_item",
  "other",
] as const;

const saleReturnLine = z.object({
  position: z.number().int().nonnegative(),
  restockedQuantity: z.number().int().nonnegative(),
  returnedQuantity: z.number().int().positive(),
});

const saleReturn = z.object({
  commandId: z.string().uuid(),
  id: z.string().uuid(),
  items: z.array(saleReturnLine),
  reasonCode: z.enum(returnReasonCodes).nullable(),
  reasonNote: z.string().nullable(),
  returnedAt: z.string().datetime(),
  returnedBy: z.string().min(1),
  saleId: z.string().uuid(),
});

export type SaleReturnReadModel = z.infer<typeof saleReturn>;

const returnSummaryLine = z.object({
  availableToReturn: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  restockedQuantity: z.number().int().nonnegative(),
  returnedQuantity: z.number().int().nonnegative(),
  sold: z.number().int().positive(),
});

const returnedSaleResult = z.object({
  lines: z.array(saleReturnLine),
  replayed: z.boolean(),
  saleReturn: saleReturn.omit({ items: true }),
});

const saleListEntry = z.object({
  cancelledAt: z.string().datetime().nullable(),
  confirmedAt: z.string().datetime(),
  customerId: z.string().uuid().nullable(),
  // The current customer's name, so the history needs no customer list.
  customerName: z.string().nullable(),
  hasReturns: z.boolean(),
  id: z.string().uuid(),
  itemCount: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(SALE_PAYMENT_METHODS).nullable(),
  status: z.enum(["confirmed", "cancelled"]),
  totalDue: z.string(),
});

export type SaleListEntryReadModel = z.infer<typeof saleListEntry>;

const saleDetail = z.object({
  cancellation: saleCancellation.nullable(),
  customer: z.object({
    customerId: z.string().uuid().nullable(),
    version: z.number().int().nonnegative().max(2_147_483_647),
  }),
  returnSummary: z.array(returnSummaryLine),
  returns: z.array(saleReturn),
  sale: confirmedSale.omit({ replayed: true }),
});

export type SaleDetailReadModel = z.infer<typeof saleDetail>;
const saleCustomerLinkAction = z.enum(["assign", "reassign", "unassign"]);

const saleCustomerLink = z.object({
  current: z.object({
    customerId: z.string().uuid().nullable(),
    version: z.number().int().nonnegative().max(2_147_483_647),
  }),
  history: z.array(
    z.object({
      action: saleCustomerLinkAction,
      createdAt: z.string().datetime(),
      customerId: z.string().uuid().nullable(),
      version: z.number().int().positive().max(2_147_483_647),
    })
  ),
  saleId: z.string().uuid(),
});

export type SaleCustomerLinkReadModel = z.infer<typeof saleCustomerLink>;

const saleCustomerLinkTarget = z.object({
  expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  organizationId: z.string().trim().min(1),
  saleId: z.string().uuid(),
});

const saleCustomerLinkChange = z.object({
  changed: z.boolean(),
  link: saleCustomerLink,
});

const organization = z.object({
  currency: z.literal("BRL"),
  id: z.string().uuid(),
  name: z.string().min(1),
  status: z.enum(["active", "suspended", "closed"]),
  timezone: z.string().min(1),
});

const organizationMembership = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  role: z.string().min(1),
  timezone: z.string().min(1),
});

export type OrganizationMembershipReadModel = z.infer<
  typeof organizationMembership
>;

const deviceReadModel = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  label: z.string().nullable(),
  lastSeenAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

export type DeviceReadModel = z.infer<typeof deviceReadModel>;

/** One queued offline command as the outbox sends it (plan PR52/PR53). */
const pushCommand = z.object({
  baseVersion: z.number().int().nonnegative().nullable(),
  commandId: z.string().uuid(),
  createdAt: z.string().datetime(),
  deviceId: z.string().uuid(),
  lease: z.string().min(1).max(4096),
  payload: z.json(),
  type: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    .max(100),
});

const pushResult = z.object({
  code: z.string().nullable(),
  commandId: z.string().uuid(),
  replayed: z.boolean(),
  result: z.json().nullable(),
  status: z.enum(["accepted", "rejected", "not_processed"]),
});

export type PushCommandReadModel = z.infer<typeof pushCommand>;
export type PushResultReadModel = z.infer<typeof pushResult>;

/** A change-log sequence, as decimal text so it survives JSON unchanged. */
const syncCursorText = z.string().regex(/^\d{1,16}$/);

const syncChange = z.object({
  entityId: z.string().uuid(),
  entityType: z.enum([
    "category",
    "customer",
    "inventory_balance",
    "payment_profile",
    "product",
    "sale",
  ]),
  seq: z.number().int().positive(),
});

export type SyncChangeReadModel = z.infer<typeof syncChange>;

/**
 * The read models a device keeps locally (plan PR50): smaller than the online
 * ones, instants as ISO text, no costs and no audit data.
 */
const localCategory = z.object({
  archivedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  id: z.string().uuid(),
  name: z.string(),
  updatedAt: z.string().datetime(),
});
const localCustomer = z.object({
  archivedAt: z.string().datetime().nullable(),
  email: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string(),
  notes: z.string().nullable(),
  phone: z.string().nullable(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
const localProduct = z.object({
  archivedAt: z.string().datetime().nullable(),
  categoryId: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  description: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});
const localVariant = z.object({
  id: z.string().uuid(),
  isDefault: z.boolean(),
  listPrice: listPriceText.nullable(),
  position: z.number().int().nonnegative().nullable(),
  productId: z.string().uuid(),
  sku: z.string().nullable(),
  values: z.array(
    z.object({ optionName: z.string(), optionValueName: z.string() })
  ),
});
const localInventory = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  variantId: z.string().uuid(),
  version: z.number().int().nonnegative(),
});

export type LocalCategoryReadModel = z.infer<typeof localCategory>;
export type LocalCustomerReadModel = z.infer<typeof localCustomer>;
export type LocalProductReadModel = z.infer<typeof localProduct>;
export type LocalVariantReadModel = z.infer<typeof localVariant>;
export type LocalInventoryReadModel = z.infer<typeof localInventory>;

const bootstrapNextAfterId = z.string().uuid().nullable();
const bootstrapPageOutput = z.discriminatedUnion("collection", [
  z.object({
    collection: z.literal("categories"),
    nextAfterId: bootstrapNextAfterId,
    rows: z.array(localCategory),
  }),
  z.object({
    collection: z.literal("customers"),
    nextAfterId: bootstrapNextAfterId,
    rows: z.array(localCustomer),
  }),
  z.object({
    collection: z.literal("inventory"),
    nextAfterId: bootstrapNextAfterId,
    rows: z.array(localInventory),
  }),
  z.object({
    collection: z.literal("products"),
    nextAfterId: bootstrapNextAfterId,
    rows: z.array(localProduct),
  }),
  z.object({
    collection: z.literal("variants"),
    nextAfterId: bootstrapNextAfterId,
    rows: z.array(localVariant),
  }),
]);

export type BootstrapPageReadModel = z.infer<typeof bootstrapPageOutput>;

export const polarisContract = {
  category: {
    archive: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    create: oc
      .input(
        z.object({
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(category),
    delete: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ categories: z.array(category) })),
    rename: oc
      .input(
        z.object({
          id: z.string().uuid(),
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    restore: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
  },
  customer: {
    archive: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    create: oc
      .input(
        customerProfileFields
          .extend({ organizationId: z.string().trim().min(1) })
          .superRefine(requireCustomerContact)
      )
      .output(customer),
    findPossibleDuplicates: oc
      .input(
        customerDuplicateSearchFields.extend({
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ matches: z.array(customerDuplicateMatch) })),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ customers: z.array(customer) })),
    restore: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    update: oc
      .input(
        customerProfileFields
          .extend({
            expectedVersion: z.number().int().positive(),
            id: z.string().uuid(),
            organizationId: z.string().trim().min(1),
          })
          .superRefine(requireCustomerContact)
      )
      .output(z.object({ changed: z.boolean(), customer })),
  },
  expense: {
    archiveCategory: oc
      .input(expenseVersionTarget)
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    create: oc
      .input(expenseFields.extend({ organizationId: z.string().trim().min(1) }))
      .output(expense),
    createCategory: oc
      .input(
        z.object({
          group: expenseGroupKey,
          name: expenseCategoryName,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(expenseCategory),
    archiveRule: oc
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    createRule: oc
      .input(
        expenseRuleFields.extend({
          frequency: z.enum(RECURRENCE_FREQUENCIES),
          organizationId: z.string().trim().min(1),
          startsOn: expenseCalendarDate,
        })
      )
      .output(expenseRule),
    list: oc
      .input(
        z.object({
          categoryId: z.string().uuid().nullish(),
          cursor: z.string().max(64).nullish(),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullish(),
          limit: z.number().int().min(1).max(200).default(100),
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "voided", "all"]).default("active"),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullish(),
        })
      )
      .output(
        z.object({
          count: z.number().int().nonnegative(),
          expenses: z.array(expense),
          nextCursor: z.string().nullable(),
          /** Sum of every expense that matches the filter, not only this page. */
          total: z.string(),
        })
      ),
    listCategories: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ categories: z.array(expenseCategory) })),
    listRules: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ rules: z.array(expenseRule) })),
    renameCategory: oc
      .input(expenseVersionTarget.extend({ name: expenseCategoryName }))
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    restore: oc
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), expense })),
    restoreRule: oc
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    restoreCategory: oc
      .input(expenseVersionTarget)
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    update: oc
      .input(expenseFields.extend(expenseVersionTarget.shape))
      .output(z.object({ changed: z.boolean(), expense })),
    updateRule: oc
      .input(expenseRuleFields.extend(expenseVersionTarget.shape))
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    void: oc
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), expense })),
  },
  device: {
    // Devices belong to the signed-in user, never to an organization: no
    // organization or user field to trust, the server reads the session.
    list: oc.output(z.object({ devices: z.array(deviceReadModel) })),
    register: oc
      .input(z.object({ label: z.string().max(200).nullish() }))
      .output(z.object({ device: deviceReadModel })),
    revoke: oc.input(z.object({ deviceId: z.string().uuid() })).output(
      z.object({
        device: deviceReadModel,
        revokedGrantIds: z.array(z.string().uuid()),
      })
    ),
  },
  inventory: {
    getBalance: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          variantId: z.string().uuid(),
        })
      )
      .output(inventoryBalance),
    inventoryCount: oc
      .input(
        z
          .object({
            commandId: z.string().uuid(),
            commandVersion: z.literal(1),
            expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            organizationId: z.string().trim().min(1),
            physicalQuantity: z.number().int().nonnegative().max(2_147_483_647),
            valuationUnitCost: z.string().trim().min(1).max(64).optional(),
            variantId: z.string().uuid(),
          })
          .superRefine((input, ctx) => {
            if (
              input.physicalQuantity === 0 &&
              input.valuationUnitCost !== undefined
            ) {
              ctx.addIssue({
                code: "custom",
                message: "inventory_count_zero_cannot_set_unit_cost",
                path: ["valuationUnitCost"],
              });
            }
          })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: inventoryCountMovement,
          replayed: z.boolean(),
        })
      ),
    // One read for the stock screen and the sale picker: every sellable
    // variant of non-deleted products, with a zero balance when it has no
    // materialized row. Keyset-paginated; never one request per variant.
    listBalances: oc
      .input(
        z.object({
          cursor: z.string().min(1).max(512).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          organizationId: z.string().trim().min(1),
          productStatus: z.enum(["active", "all"]).default("active"),
          query: z.string().trim().max(100).optional(),
          stock: z.enum(["all", "with_stock", "without_stock"]).default("all"),
          // Re-reads exactly these variants (e.g. the lines of a sale in
          // progress) in one call, regardless of the other filters.
          variantIds: z.array(z.string().uuid()).min(1).max(100).optional(),
        })
      )
      .output(
        z.object({
          entries: z.array(inventoryBalanceEntry),
          nextCursor: z.string().nullable(),
        })
      ),
    receiveStock: oc
      .input(
        z.object({
          commandId: z.string().uuid(),
          commandVersion: z.literal(1),
          occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          organizationId: z.string().trim().min(1),
          quantity: z.number().int().positive().max(2_147_483_647),
          unitCost: z.string().trim().min(1).max(64),
          variantId: z.string().uuid(),
        })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: stockReceiptMovement,
          replayed: z.boolean(),
        })
      ),
    writeOffStock: oc
      .input(
        z
          .object({
            commandId: z.string().uuid(),
            commandVersion: z.literal(1),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            organizationId: z.string().trim().min(1),
            quantity: z.number().int().positive().max(2_147_483_647),
            reasonCode: z.enum(WRITE_OFF_REASON_CODES),
            reasonNote: writeOffReasonNote.nullable().optional(),
            variantId: z.string().uuid(),
          })
          .superRefine((input, ctx) => {
            if (input.reasonCode === "other" && !input.reasonNote) {
              ctx.addIssue({
                code: "custom",
                message: "write_off_reason_note_required",
                path: ["reasonNote"],
              });
            }
          })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: stockWriteOffMovement,
          replayed: z.boolean(),
        })
      ),
  },
  offline: {
    // Issues (or renews) the signed authorization lease of a device for one
    // organization: at most 72 hours, revalidated by the server at sync.
    issueLease: oc
      .input(
        z.object({
          deviceId: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(
        z.object({
          expiresAt: z.string().datetime(),
          grantId: z.string().uuid(),
          issuedAt: z.string().datetime(),
          lease: z.string().min(1),
        })
      ),
  },
  organization: {
    createInitial: oc
      .input(
        z.object({
          name: z.string().trim().min(1).max(128),
          timezone: z.string().trim().min(1).max(64),
        })
      )
      .output(z.object({ created: z.boolean(), organization })),
    // No organization ID on purpose: the server reads the authenticated
    // user's active memberships, so the client learns its organizations here
    // instead of remembering an ID.
    listMine: oc.output(
      z.object({ organizations: z.array(organizationMembership) })
    ),
  },
  paymentProfile: {
    archive: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), profile: paymentProfile })),
    create: oc
      .input(
        paymentProfileFields.extend({
          organizationId: z.string().trim().min(1),
        })
      )
      .output(paymentProfile),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ profiles: z.array(paymentProfile) })),
    restore: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), profile: paymentProfile })),
    update: oc
      .input(
        paymentProfileFields.extend({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), profile: paymentProfile })),
  },
  product: {
    archive: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    configureVariants: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          options: z
            .array(
              z.object({
                name: productVariantOptionName,
                values: z.array(z.string().trim().min(1)).min(1),
              })
            )
            .min(1)
            .max(3),
          organizationId: z.string().trim().min(1),
          variants: z
            .array(
              z.object({
                values: z
                  .object({
                    color: z.string().trim().min(1).optional(),
                    model: z.string().trim().min(1).optional(),
                    size: z.string().trim().min(1).optional(),
                  })
                  .strict(),
              })
            )
            .min(1)
            .max(50),
        })
      )
      .output(
        z.object({
          configuration: productVariantConfiguration,
          product,
        })
      ),
    create: oc
      .input(
        z.object({
          categoryId: z.string().uuid().nullable().optional(),
          description: z.string().max(5000).nullable().optional(),
          name: productNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(product),
    delete: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    getVariants: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(productVariantConfiguration),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ products: z.array(product) })),
    restore: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    setVariantListPrice: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          // A BRL amount with at most two decimals, or null to clear it.
          listPrice: z.string().max(64).nullable(),
          organizationId: z.string().trim().min(1),
          productId: z.string().uuid(),
          variantId: z.string().uuid(),
        })
      )
      .output(
        z.object({
          changed: z.boolean(),
          configuration: productVariantConfiguration,
          product,
        })
      ),
    setVariantSku: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          organizationId: z.string().trim().min(1),
          productId: z.string().uuid(),
          sku: z.string().nullable(),
          variantId: z.string().uuid(),
        })
      )
      .output(
        z.object({
          changed: z.boolean(),
          configuration: productVariantConfiguration,
          product,
        })
      ),
    update: oc
      .input(
        z.object({
          categoryId: z.string().uuid().nullable(),
          description: z.string().nullable(),
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          name: productNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
  },
  sale: {
    // Attribution is separate from the sale's economics: it never changes the
    // confirmed sale. Each change needs the version the operator saw.
    assignCustomer: oc
      .input(saleCustomerLinkTarget.extend({ customerId: z.string().uuid() }))
      .output(saleCustomerLinkChange),
    cancel: oc
      .input(
        z.object({
          commandId: z.string().uuid(),
          commandVersion: z.literal(1),
          organizationId: z.string().trim().min(1),
          reasonCode: z.enum(cancellationReasonCodes).nullable().optional(),
          reasonNote: z.string().max(2000).nullable().optional(),
          saleId: z.string().uuid(),
        })
      )
      .output(cancelledSaleResult),
    // One command confirms the whole sale. The payment profile is an explicit
    // choice: an id with the version the operator saw, or null for no profile.
    confirm: oc
      .input(
        z.object({
          adjustments: z.array(saleAdjustmentInput).max(20),
          commandId: z.string().uuid(),
          commandVersion: z.literal(1),
          items: z.array(saleItemInput).min(1).max(200),
          occurredAt: z.string().datetime({ offset: true }),
          organizationId: z.string().trim().min(1),
          payment: salePaymentInput,
          paymentProfile: salePaymentProfileSelection.nullable(),
          recordedAt: z.string().datetime({ offset: true }).optional(),
        })
      )
      .output(confirmedSale),
    get: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          saleId: z.string().uuid(),
        })
      )
      .output(saleDetail),
    getCustomerLink: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          saleId: z.string().uuid(),
        })
      )
      .output(saleCustomerLink),
    list: oc
      .input(
        z.object({
          // Optional, additive filters. Dates are commercial dates
          // (occurredOn), inclusive. "with_returns" is independent of
          // cancellation; "confirmed" means not cancelled.
          customerQuery: z.string().trim().max(100).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          occurredFrom: calendarDateText.optional(),
          occurredTo: calendarDateText.optional(),
          offset: z.number().int().min(0).max(1_000_000).default(0),
          organizationId: z.string().trim().min(1),
          query: z.string().trim().max(100).optional(),
          status: z.enum(["confirmed", "cancelled", "with_returns"]).optional(),
        })
      )
      .output(
        z.object({ hasMore: z.boolean(), sales: z.array(saleListEntry) })
      ),

    reassignCustomer: oc
      .input(saleCustomerLinkTarget.extend({ customerId: z.string().uuid() }))
      .output(saleCustomerLinkChange),
    // A partial return: per item the returned quantity and the quantity that
    // goes back to sellable stock (restocked <= returned <= still available).
    return: oc
      .input(
        z.object({
          commandId: z.string().uuid(),
          commandVersion: z.literal(1),
          items: z.array(saleReturnLine).min(1).max(200),
          organizationId: z.string().trim().min(1),
          reasonCode: z.enum(returnReasonCodes).nullable().optional(),
          reasonNote: z.string().max(2000).nullable().optional(),
          saleId: z.string().uuid(),
        })
      )
      .output(returnedSaleResult),
    unassignCustomer: oc
      .input(saleCustomerLinkTarget)
      .output(saleCustomerLinkChange),
  },
  sync: {
    // One page of one local collection, keyed by id, or specific entities
    // (`ids`) to re-read after a change. A device records the cursor first, reads
    // its snapshot page by page, then pulls from the cursor.
    bootstrapPage: oc
      .input(
        z.object({
          afterId: z.string().uuid().nullish(),
          collection: z.enum([
            "categories",
            "customers",
            "inventory",
            "products",
            "variants",
          ]),
          ids: z.array(z.string().uuid()).max(200).nullish(),
          limit: z.number().int().min(1).max(500).default(200),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(bootstrapPageOutput),
    // The latest committed change sequence of the organization. A device records
    // it before reading a snapshot and pulls from it afterwards.
    getCursor: oc
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ cursor: syncCursorText })),
    // The changes after a cursor, in commit order. Entities changed several
    // times in the page appear once, at their latest sequence.
    pull: oc
      .input(
        z.object({
          cursor: syncCursorText.nullish(),
          limit: z.number().int().min(1).max(500).default(200),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(
        z.object({
          changes: z.array(syncChange),
          hasMore: z.boolean(),
          nextCursor: syncCursorText,
        })
      ),
    // Sends queued offline commands, in order. Each carries its own ID (the
    // idempotency key), the lease it was made under and its payload. The server
    // revalidates everything per command and answers each one: accepted,
    // rejected with a stable code, or not processed because a command before it
    // was rejected. The same command again returns the same outcome.
    push: oc
      .input(
        z.object({
          commands: z.array(pushCommand).min(1).max(50),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ results: z.array(pushResult) })),
  },
  system: {
    ping: oc.output(z.object({ message: z.literal("pong") })),
  },
};

export type PolarisRpcClient = ContractRouterClient<typeof polarisContract>;
