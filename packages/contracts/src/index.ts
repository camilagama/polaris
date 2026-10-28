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
import { GOAL_KINDS } from "@polaris/domain/goals/goal";
import { LEGAL_DOCUMENT_IDS } from "@polaris/domain/legal/legal-documents";
import { PAYMENT_FEE_MODES } from "@polaris/domain/sales/payment-profile";
import { SALE_PAYMENT_METHODS } from "@polaris/domain/sales/sale-payment";
import { z } from "zod";

// The pages run under a CSP without 'unsafe-eval'. By default zod probes `new Function("")` to compile its
// parsers, and a browser reports that probe as a violation (found by the real-Turnstile e2e). The Worker
// never allowed it either (the probe returns false there), so nothing is lost.
z.config({ jitless: true });

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

/**
 * The import of a spreadsheet (corte 2.5): the browser reads the file and sends only the rows it accepted, a slice at
 * a time; the file never reaches the server. One call carries at most `PRODUCT_IMPORT_BATCH_MAX_ROWS` rows (a call
 * with more is refused whole, never cut; one row keeps each call inside the CPU of the Free plan and makes the bulk
 * bucket count rows, not slices), each row is created in its own transaction by the same use case as
 * `product.create`, and the answer says what happened to each row.
 */
export const PRODUCT_IMPORT_BATCH_MAX_ROWS = 1;
/** The names one `product.namesExisting` asks about: the rows of one file. */
export const PRODUCT_IMPORT_MAX_NAMES = 500;

const productImportRowNumber = z.number().int().positive().max(1_000_000);

const productImportRow = z
  .object({
    categoryId: z.string().uuid().nullable(),
    description: z.string().max(5000).nullable(),
    // the IDs are born once per import, so sending the slice again repeats it instead of duplicating it
    initialStock: z
      .object({
        commandId: z.string().uuid(),
        quantity: z.number().int().positive().max(2_147_483_647),
        unitCost: z.string().trim().min(1).max(64).nullable(),
      })
      .strict()
      .nullable(),
    listPrice: z.string().trim().min(1).max(64).nullable(),
    name: productNameSchema,
    productId: z.string().uuid(),
    // the row of the file, as the person sees it in the spreadsheet: the answer names it back
    rowNumber: productImportRowNumber,
    variantId: z.string().uuid(),
  })
  .strict();

export type ProductImportRowInput = z.infer<typeof productImportRow>;

/** The fields a row of the import can be refused by: the columns of the spreadsheet. */
export const PRODUCT_IMPORT_FIELDS = [
  "name",
  "listPrice",
  "quantity",
  "unitCost",
  "category",
  "description",
] as const;

/** A refusal said as a code, never an echo of the value (AC-7). */
const productImportReason = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);

const productImportRowResult = z.discriminatedUnion("status", [
  // created now, or already created by an earlier send of the same row: both are rows that entered
  z.object({
    productId: z.string().uuid(),
    rowNumber: productImportRowNumber,
    status: z.literal("created"),
  }),
  z.object({
    productId: z.string().uuid(),
    rowNumber: productImportRowNumber,
    status: z.literal("repeated"),
  }),
  // a product of the same name exists in the store (an archived one too, or an earlier row of the file): skipped
  z.object({
    rowNumber: productImportRowNumber,
    status: z.literal("exists_by_name"),
  }),
  // the plan has no room: this row and the rest of the slice were not tried
  z.object({
    rowNumber: productImportRowNumber,
    status: z.literal("limit_reached"),
  }),
  z.object({
    field: z.enum(PRODUCT_IMPORT_FIELDS),
    reason: productImportReason,
    rowNumber: productImportRowNumber,
    status: z.literal("invalid"),
  }),
  // the IDs of the row were already used with other data: the send is not a repeat
  z.object({
    reason: productImportReason,
    rowNumber: productImportRowNumber,
    status: z.literal("conflict"),
  }),
]);

export type ProductImportRowResult = z.infer<typeof productImportRowResult>;
export type ProductImportRowStatus = ProductImportRowResult["status"];

/** No two rows of a slice share a row number or an ID: a repeat inside one call would be a conflict with itself. */
function distinctImportRows(
  rows: readonly ProductImportRowInput[],
  context: z.RefinementCtx
): void {
  const rowNumbers = new Set<number>();
  const ids = new Set<string>();
  for (const row of rows) {
    const rowIds = [row.productId, row.variantId];
    if (row.initialStock) {
      rowIds.push(row.initialStock.commandId);
    }
    if (
      rowNumbers.has(row.rowNumber) ||
      rowIds.some((id) => ids.has(id.toLowerCase())) ||
      new Set(rowIds.map((id) => id.toLowerCase())).size !== rowIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "duplicate_import_row",
      });
      return;
    }
    rowNumbers.add(row.rowNumber);
    for (const id of rowIds) {
      ids.add(id.toLowerCase());
    }
  }
}

const publicCatalogProfile = z.object({
  description: z.string().nullable(),
  /** The Instagram name without the @. */
  instagram: z.string().nullable(),
  publicName: z.string().min(1),
  /** The organization's own switch (what is shown also depends on the plan). */
  published: z.boolean(),
  slug: z.string().min(1),
  version: z.number().int().positive(),
  /** Digits only, country code included. */
  whatsapp: z.string().nullable(),
});

export type PublicCatalogProfileReadModel = z.infer<
  typeof publicCatalogProfile
>;

const publicCatalogSetup = z.object({
  /** The plan in force includes the public catalog right now. */
  enabled: z.boolean(),
  profile: publicCatalogProfile.nullable(),
  /** The origin the public catalog is served from, when known. */
  publicOrigin: z.string().nullable(),
  /** The products chosen to be shown (the plan and each product's own state still decide). */
  publishedProductIds: z.array(z.string().uuid()),
});

export type PublicCatalogSetupReadModel = z.infer<typeof publicCatalogSetup>;

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
  // Set once the customer was anonymized for privacy: the record holds no personal data and cannot change.
  anonymizedAt: z.string().datetime().nullable(),
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

const goalKind = z.enum(GOAL_KINDS);

const goal = z.object({
  /** The measure when the goal settled (completed or missed). */
  achievedValue: z.string().nullable(),
  createdAt: z.string().datetime(),
  endsOn: z.string(),
  id: z.string().uuid(),
  kind: goalKind,
  name: z.string().nullable(),
  organizationId: z.string().min(1),
  /**
   * The plan pauses the goal (the organization has more active goals than its
   * plan allows): it is not measured and can only be cancelled until the plan
   * allows it again. Derived, never stored.
   */
  paused: z.boolean(),
  /** Progress so far, for an active goal only (derived from the period result). */
  progress: z
    .object({
      /** True when the last day of the period is before today. */
      periodEnded: z.boolean(),
      /** Percent of the target with one place, or null when the progress is not positive. */
      percent: z.string().nullable(),
      reached: z.boolean(),
      /** BRL decimal text, or a whole number for a sale-count goal. */
      value: z.string(),
    })
    .nullable(),
  settledAt: z.string().datetime().nullable(),
  startsOn: z.string(),
  status: z.enum(["active", "cancelled", "completed", "missed"]),
  /** BRL decimal text for money goals, a whole number for a sale-count goal. */
  target: z.string(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type GoalReadModel = z.infer<typeof goal>;

const operationalSelection = z.object({
  /** The variants limit in force. */
  limit: z.number().int().nonnegative(),
  /** Variants of products that were not deleted (archived ones count). */
  liveVariants: z.number().int().nonnegative(),
  /** `unrestricted`, `adapting` (the window is open) or `frozen`. */
  phase: z.enum(["adapting", "frozen", "unrestricted"]),
  /** The variants chosen; while adapting, none means the default applies when the window ends. */
  selectedVariantIds: z.array(z.string().uuid()),
  /** The end of the adaptation window; null when nothing is restricted. */
  windowEndsAt: z.string().datetime().nullable(),
});
export type OperationalSelectionReadModel = z.infer<
  typeof operationalSelection
>;
/** The longest period a summary reads: one year, leap year included (the same limit as `readPeriodFacts`). */
const MAX_PERIOD_SUMMARY_DAYS = 366;

const DAY_MS = 86_400_000;

function periodSummaryDays(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS +
    1
  );
}

const periodSummary = z.object({
  /** The server clock when this retrieval of the confirmed records was made ("updated until"). */
  generatedAt: z.string().datetime(),
  cards: z.object({
    /** Units sold, net of returns. */
    items: z.number().int().nonnegative(),
    /** Percent with two places, or null when net sales are not positive. */
    marginPercent: z.string().nullable(),
    netSales: z.string(),
    /** Estimated operating result: an estimate, never net profit or settled cash. */
    operatingResult: z.string(),
    salesCount: z.number().int().nonnegative(),
    ticket: z.string().nullable(),
  }),
  /** The chain from gross sales to the estimated result, as exact BRL text. */
  chain: z.object({
    anticipationFees: z.string(),
    cogs: z.string(),
    commercialSurcharges: z.string(),
    contributionMargin: z.string(),
    discounts: z.string(),
    estimatedOperatingResult: z.string(),
    grossProfit: z.string(),
    grossSales: z.string(),
    linkedExpenses: z.string(),
    netSales: z.string(),
    operatingExpenses: z.string(),
    processingFees: z.string(),
    returns: z.string(),
  }),
  /**
   * Every date of the period, in order, also those after today, with the net
   * sales and the count of the sales of that commercial date, and the costs and
   * the estimated result of the day (ADR 0056, D2). A day without sales is
   * "0.00" and 0; the series adds up to `cards.netSales` and `cards.salesCount`.
   * `costs` is the sum of the parts (cost of goods, fees, linked expenses and
   * the expenses with no sale of that competence date), never negative;
   * `operatingResult` is the day's estimate. Both are null, never zero, when a
   * cost or a fee of a sale of the day is unknown. `operatingExpenses` is the
   * part of `costs` with no sale (the expenses of that competence date), always
   * present and never null: "0.00" on a day without expenses, and filled even
   * when `costs` is null. When no day is null, the
   * costs add up to the chain's cogs, fees and expenses and the results to
   * `chain.estimatedOperatingResult`.
   */
  daily: z.array(
    z.object({
      costs: z.string().nullable(),
      date: z.string(),
      netSales: z.string(),
      operatingExpenses: z.string(),
      operatingResult: z.string().nullable(),
      salesCount: z.number().int().nonnegative(),
    })
  ),
  period: z.object({ from: z.string(), to: z.string() }),
  /**
   * The most sold products of the period, by units net of returns, only when
   * asked for (`topProducts` in the input). The name is the product's current
   * one; a deleted product says so.
   */
  topProducts: z
    .array(
      z.object({
        deleted: z.boolean(),
        name: z.string(),
        netSales: z.string(),
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      })
    )
    .optional(),
  /** How complete the estimate is: what was left out is never counted as zero. */
  quality: z.object({
    anticipationFeesUnknown: z.number().int().nonnegative(),
    /**
     * The coverage of the cost of the goods (the item lines) only: an unknown
     * fee does not count here. "full" when no item line has an unknown cost
     * (none at all included), "none" when there are item lines and none has a
     * known cost, "partial" otherwise; always the one derived from
     * `itemLines` and `itemLinesWithUnknownCost`. With "none",
     * `cards.operatingResult` and `cards.marginPercent` are still numbers, but
     * they are not an estimate: they are the sales minus what is known.
     * The goals stay as they are at this stage.
     */
    cogsCoverage: z.enum(["full", "none", "partial"]),
    itemLines: z.number().int().nonnegative(),
    itemLinesWithUnknownCost: z.number().int().nonnegative(),
    level: z.enum(["complete", "no_data", "partial"]),
    linkedExpenses: z.number().int().nonnegative(),
    missing: z.array(
      z.enum([
        "no_expenses",
        "no_sales",
        "unknown_anticipation_fee",
        "unknown_cost",
        "unknown_processing_fee",
      ])
    ),
    operatingExpenses: z.number().int().nonnegative(),
    processingFeesUnknown: z.number().int().nonnegative(),
    salesCount: z.number().int().nonnegative(),
  }),
});

export type PeriodSummaryReadModel = z.infer<typeof periodSummary>;

/** The longest daily sales series: 182 dates, `to` at most 181 days after `from` (the same limit as `readDailySales`). */
const MAX_DAILY_SALES_DAYS = 182;

/**
 * Net sales and the count of sales of each date, compact for the Início's map:
 * the first date and two positional arrays, one entry per date from `from`, in
 * order, a date without sales "0.00" and 0. The same rule as
 * `periodSummary.daily[].netSales` and `salesCount`, aggregated by the database.
 */
export const dailySales = z
  .object({
    count: z.array(z.number().int().nonnegative()).max(MAX_DAILY_SALES_DAYS),
    from: expenseCalendarDate,
    net: z.array(z.string()).max(MAX_DAILY_SALES_DAYS),
  })
  .refine(({ count, net }) => count.length === net.length, {
    message: "series_length_mismatch",
    path: ["count"],
  });

export type DailySalesReadModel = z.infer<typeof dailySales>;

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
  // one rule per method, plan and installment count (the domain refuses repeats): the card
  // alone is 2 plans x the installments a terminal offers, so 100 leaves room and bounds the work
  rules: z.array(paymentProfileRuleFields).min(1).max(100),
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

export const productMediaRemoveResponseSchema = z.object({
  removed: z.boolean(),
  requestId: z.string().uuid(),
});

export type ProductMediaRemoveResponse = z.infer<
  typeof productMediaRemoveResponseSchema
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
  status: z.enum([
    "active",
    "suspended",
    "closing",
    "closed",
    "purge_pending",
    "purged",
  ]),
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

// A closed organization as its owner reads it (ADR 0081): the phase and every date come from the server, by date
// only, so they are the same with or without a legal hold or a scheduled purge.
const closedOrganization = z.object({
  canRecover: z.boolean(),
  deletableFrom: z.string().datetime(),
  deletionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exportOpenUntil: z.string().datetime(),
  id: z.string().uuid(),
  milestones: z.object({
    closure: z.string().datetime(),
    d30: z.string().datetime(),
    d7: z.string().datetime(),
    deletionDay: z.string().datetime(),
  }),
  name: z.string().min(1),
  phase: z.enum([
    "closing",
    "closed",
    "deletion_scheduled",
    "deletable",
    "purged",
  ]),
  recoverUntil: z.string().datetime(),
  // the renewal of the subscription, derived by the server from the billing record (ADR 0074, L4):
  // not_handled (no provider, or one Polaris does not cancel through), pending or cancelled; null when the
  // billing record cannot be read now (the screen says nothing rather than guess)
  renewal: z.enum(["not_handled", "pending", "cancelled"]).nullable(),
  requestedAt: z.string().datetime(),
  timezone: z.string().min(1),
});

export type ClosedOrganizationReadModel = z.infer<typeof closedOrganization>;

const closedDataExport = z.object({
  errorCode: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  files: z.array(
    z.object({
      name: z.string().min(1),
      ordinal: z.number().int().positive(),
      sizeBytes: z.number().int().positive(),
    })
  ),
  formats: z.array(z.enum(["json", "csv", "images"])),
  id: z.string().uuid(),
  // an export asked for before the closure (`active`) is listed too; only a `closed` one is downloaded here
  mode: z.enum(["active", "closed"]),
  readyAt: z.string().datetime().nullable(),
  requestedAt: z.string().datetime(),
  status: z.enum(["requested", "running", "ready", "failed", "expired"]),
  totalBytes: z.number().int().nonnegative().nullable(),
});

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

/** The check digits of a CPF (11 digits) or a CNPJ (14 digits), digits only. */
function hasTaxIdCheckDigits(value: string): boolean {
  const digits = [...value].map(Number);
  if (new Set(digits).size === 1) {
    // 000.000.000-00 and the like pass the arithmetic and are not documents
    return false;
  }
  const checkDigit = (body: number[], weights: number[]) => {
    const sum = body.reduce(
      (total, digit, index) => total + digit * (weights[index] ?? 0),
      0
    );
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  if (digits.length === 11) {
    const first = checkDigit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const second = checkDigit(
      digits.slice(0, 10),
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
    );
    return digits[9] === first && digits[10] === second;
  }
  const first = checkDigit(
    digits.slice(0, 12),
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  const second = checkDigit(
    digits.slice(0, 13),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  );
  return digits[12] === first && digits[13] === second;
}

const billingCheckoutCycle = z.union([
  z.literal(1),
  z.literal(6),
  z.literal(12),
]);

const billingAmount = z.string().regex(/^\d+\.\d{2}$/);
const billingMethod = z.enum(["card", "pix_automatic"]);
const planCount = z.number().int().nonnegative();

/**
 * The owner's read of the plan (ADR 0104, decision 2). Every object is strict, so a key the
 * server adds by mistake (a provider reference, a payer, a payload) fails the answer instead of reaching the client
 * (AS-2). The amounts are text with two decimals (money.md); the days are São Paulo's.
 */
export const billingPlanView = z
  .object({
    // the end of the paid access or of the grace; in a trial the screen shows only `nextCharge`
    accessEndsAt: z.string().datetime().nullable(),
    cycleMonths: billingCheckoutCycle.nullable(),
    kept: z
      .object({
        historyMonths: planCount,
        products: planCount,
        sales: planCount,
      })
      .strict(),
    limits: z
      .object({
        goals: planCount.nullable(),
        images: planCount.nullable(),
        variants: planCount.nullable(),
      })
      .strict(),
    method: billingMethod.nullable(),
    nextCharge: z
      .object({
        amount: billingAmount,
        on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .nullable(),
    offer: z
      .object({
        methods: z.array(billingMethod),
        prices: z.array(
          z
            .object({
              amount: billingAmount,
              cycleMonths: billingCheckoutCycle,
            })
            .strict()
        ),
      })
      .strict(),
    // "provider_retries" enters by amendment, once the Gate 7 proves Woovi's calendar
    recovery: z.literal("provider_page").nullable(),
    refund: z
      .object({
        amount: billingAmount,
        until: z.string().datetime(),
        via: z.enum(["app", "suporte"]),
      })
      .strict()
      .nullable(),
    refundPending: z.boolean(),
    // the São Paulo day the window of the right of withdrawal ended, once the 7th day passed after a first charge
    // paid and neither refunded nor charged back; null otherwise
    refundWindowEndedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    renewalCancelled: z.boolean(),
    resubscribeFrom: z.string().datetime().nullable(),
    state: z.enum([
      "free",
      "free_over_limit",
      "trial_setup",
      "trialing",
      "active",
      "grace",
    ]),
    trialAvailable: z.boolean(),
    usage: z
      .object({ goals: planCount, images: planCount, variants: planCount })
      .strict(),
  })
  .strict();

export type BillingPlanView = z.infer<typeof billingPlanView>;

/**
 * The ID the client gives each gesture of the owner's billing commands (ADR 0104, decision 3): a UUID (versions 1 to
 * 8, as the audit and the billing store read it), the same on a repeat of the same gesture and a new one for a new
 * gesture. It identifies the request in the audit and in the command's own facts; it never authorizes anything.
 */
const billingRequestId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

const billingCancelRenewalInput = z
  .object({
    organizationId: z.string().trim().min(1),
    // optional; kept with no store and no person, never logged (the screen asks for no personal data); no control,
    // format (bidirectional, zero-width) or unassigned characters but line breaks and tabs
    reason: z
      .string()
      .trim()
      .max(500)
      .regex(/^(?:[^\p{C}]|[\n\t])*$/u)
      .optional(),
    requestId: billingRequestId,
  })
  .strict();

const billingCancelRenewalOutput = z
  .object({
    accessEndsAt: z.string().datetime().nullable(),
    result: z.enum(["cancelled", "already_cancelled"]),
  })
  .strict();

const billingRequestRefundInput = z
  .object({
    organizationId: z.string().trim().min(1),
    requestId: billingRequestId,
  })
  .strict();

const billingRequestRefundOutput = z
  .object({
    amount: billingAmount,
    // `refund_pending` (AS-42): the renewal is cancelled and the refund is not done; asking again finishes it
    result: z.enum(["refund_requested", "refund_pending"]),
    until: z.string().datetime(),
  })
  .strict();

const billingOpenOverduePaymentInput = billingRequestRefundInput;

const billingOpenOverduePaymentOutput = z
  .object({
    handoff: z
      .object({ kind: z.literal("redirect"), url: z.string().url() })
      .strict(),
  })
  .strict();

/** No control, format (zero-width, bidirectional) or unassigned characters: the name shows in the payer's bank. */
const payerNamePattern = /^[^\p{C}]+$/u;

/**
 * The Pro cycles the checkout may offer; a cycle with no active price is
 * refused by the server. The card sends nothing of the payer (it is typed on
 * the provider's page); Pix Automático needs the payer's name, CPF or CNPJ
 * (digits only) and e-mail, which go to Woovi and are never stored by Polaris.
 */
export const billingStartCheckoutInput = z.discriminatedUnion("method", [
  z
    .object({
      cycleMonths: billingCheckoutCycle,
      method: z.literal("card"),
      organizationId: z.string().trim().min(1),
      trial: z.boolean(),
    })
    .strict(),
  z
    .object({
      cycleMonths: billingCheckoutCycle,
      method: z.literal("pix_automatic"),
      organizationId: z.string().trim().min(1),
      payer: z
        .object({
          email: z.string().trim().email().max(254),
          name: z
            .string()
            .trim()
            .normalize("NFC")
            .min(2)
            .max(120)
            .regex(payerNamePattern),
          taxId: z
            .string()
            .regex(/^(?:\d{11}|\d{14})$/)
            .refine(hasTaxIdCheckDigits),
        })
        .strict(),
      trial: z.boolean(),
    })
    .strict(),
]);

const legalDocumentId = z.enum(LEGAL_DOCUMENT_IDS);
const legalAcceptanceStatus = z.object({
  pending: z.array(
    z.object({
      changes: z.string().nullable(),
      document: legalDocumentId,
      effectiveFrom: z.string().nullable(),
      version: z.number().int().positive(),
    })
  ),
});

/**
 * Whether a procedure only reads (`read`) or changes state (`write`), declared on each one. The Worker's
 * rate limit picks its bucket by it, never by the name: a write with a name like a read still counts as a
 * write. A command (a sale, a stock movement, a send of the queue, a lease, a billing step) is always a
 * write, and so is `device.check`: it promotes the session's link to the device (ADR 0048), and once per
 * page load fits the write bucket. `read` = no effect asked for by the user; it may do idempotent, bounded
 * maintenance, proven by a gate (today only `goal.list`, which settles the goals whose period ended;
 * `verify-home-writes-gate`). `bulk` = the import of a spreadsheet, one row per call (today only `product.importBatch`): it
 * counts in a bucket of its own, so a long import neither spends the write quota the sales share nor is held to it;
 * the rows per minute are the bucket's calls times the cap of rows per call.
 */
export type ProcedureKind = "bulk" | "read" | "write";

export interface ProcedureMeta {
  kind?: ProcedureKind;
}

const procedure = oc.$meta<ProcedureMeta>({});
const readProcedure = procedure.meta({ kind: "read" });
const writeProcedure = procedure.meta({ kind: "write" });
const bulkProcedure = procedure.meta({ kind: "bulk" });

export const polarisContract = {
  // The acceptance of the Terms of Use and of the Privacy Policy (ADR 0100). Per user, never per
  // organization: the server reads the session. Both are exempt from the acceptance control, so
  // that a user who still has to accept can read and accept.
  account: {
    // Records the acceptance of the versions in force (origin `reaceite`); the text hash and the
    // instant are the server's. A version that is not the one in force is a CONFLICT with reason
    // `legal_version_mismatch`: the screen reads the status again. Accepting again is idempotent.
    acceptLegal: writeProcedure
      .input(
        z
          .object({
            documents: z
              .array(
                z
                  .object({
                    document: legalDocumentId,
                    version: z.number().int().positive().max(1000),
                  })
                  .strict()
              )
              .min(1)
              .max(LEGAL_DOCUMENT_IDS.length)
              .refine(
                (items) =>
                  new Set(items.map((item) => item.document)).size ===
                  items.length,
                { message: "duplicate_legal_document" }
              ),
          })
          .strict()
      )
      .output(legalAcceptanceStatus),
    // The documents still to accept: those whose highest accepted version is below the floor of the
    // server's constant, each with the version in force and what changed from the previous one.
    legalStatus: readProcedure.output(legalAcceptanceStatus),
  },
  category: {
    archive: writeProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    create: writeProcedure
      .input(
        z.object({
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(category),
    delete: writeProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    list: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ categories: z.array(category) })),
    rename: writeProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    restore: writeProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
  },
  customer: {
    // Irreversible: replaces the name and removes phone, e-mail and notes; sales keep their economic facts.
    anonymizeForPrivacy: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    archive: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    create: writeProcedure
      .input(
        customerProfileFields
          .extend({ organizationId: z.string().trim().min(1) })
          .superRefine(requireCustomerContact)
      )
      .output(customer),
    findPossibleDuplicates: readProcedure
      .input(
        customerDuplicateSearchFields.extend({
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ matches: z.array(customerDuplicateMatch) })),
    list: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ customers: z.array(customer) })),
    restore: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    update: writeProcedure
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
    archiveCategory: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    create: writeProcedure
      .input(expenseFields.extend({ organizationId: z.string().trim().min(1) }))
      .output(expense),
    createCategory: writeProcedure
      .input(
        z.object({
          group: expenseGroupKey,
          name: expenseCategoryName,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(expenseCategory),
    archiveRule: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    createRule: writeProcedure
      .input(
        expenseRuleFields.extend({
          frequency: z.enum(RECURRENCE_FREQUENCIES),
          organizationId: z.string().trim().min(1),
          startsOn: expenseCalendarDate,
        })
      )
      .output(expenseRule),
    list: readProcedure
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
    listCategories: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ categories: z.array(expenseCategory) })),
    listRules: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ rules: z.array(expenseRule) })),
    renameCategory: writeProcedure
      .input(expenseVersionTarget.extend({ name: expenseCategoryName }))
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    restore: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), expense })),
    restoreRule: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    restoreCategory: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ category: expenseCategory, changed: z.boolean() })),
    update: writeProcedure
      .input(expenseFields.extend(expenseVersionTarget.shape))
      .output(z.object({ changed: z.boolean(), expense })),
    updateRule: writeProcedure
      .input(expenseRuleFields.extend(expenseVersionTarget.shape))
      .output(z.object({ changed: z.boolean(), rule: expenseRule })),
    void: writeProcedure
      .input(expenseVersionTarget)
      .output(z.object({ changed: z.boolean(), expense })),
  },
  goal: {
    cancel: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), goal })),
    create: writeProcedure
      .input(
        z.object({
          endsOn: expenseCalendarDate,
          kind: goalKind,
          name: z.string().trim().max(100).nullish(),
          organizationId: z.string().trim().min(1),
          startsOn: expenseCalendarDate,
          target: z.string().trim().min(1).max(64),
        })
      )
      .output(goal),
    // Reading goals also settles them: a goal whose target was reached becomes
    // completed (and stays so), one whose period ended without it is missed.
    list: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "all", "cancelled", "completed", "missed"])
            .default("all"),
        })
      )
      .output(z.object({ goals: z.array(goal) })),
    targetChanges: readProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(
        z.object({
          changes: z.array(
            z.object({
              changedAt: z.string().datetime(),
              newTarget: z.string(),
              previousTarget: z.string(),
            })
          ),
        })
      ),
    update: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          name: z.string().trim().max(100).nullish(),
          organizationId: z.string().trim().min(1),
          target: z.string().trim().min(1).max(64).optional(),
        })
      )
      .output(z.object({ changed: z.boolean(), goal })),
  },
  publicCatalog: {
    // Choose which products the public catalog shows. Needs the plan to include it.
    publishProducts: writeProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          productIds: z.array(z.string().uuid()).min(1).max(200),
        })
      )
      .output(z.object({ published: z.number().int().nonnegative() })),
    // Create or edit the public profile. The address is unique across every
    // organization; an edit names the version it started from.
    saveProfile: writeProcedure
      .input(
        z.object({
          description: z.string().max(2000).nullable().optional(),
          expectedVersion: z.number().int().positive().optional(),
          instagram: z.string().max(100).nullable().optional(),
          organizationId: z.string().trim().min(1),
          publicName: z.string().max(500),
          slug: z.string().max(200),
          whatsapp: z.string().max(100).nullable().optional(),
        })
      )
      .output(publicCatalogProfile),
    // The organization's own switch; turning it off never needs the plan.
    setPublished: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          organizationId: z.string().trim().min(1),
          published: z.boolean(),
        })
      )
      .output(publicCatalogProfile),
    // Only reads the profile, the plan's entitlement and the published products: a read, which the public
    // catalog screen repeats once on a transient failure (`readWithRetry`, which the contract's kind guards).
    setup: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(publicCatalogSetup),
    // Taking products out is always allowed.
    unpublishProducts: writeProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          productIds: z.array(z.string().uuid()).min(1).max(200),
        })
      )
      .output(z.object({ unpublished: z.number().int().nonnegative() })),
  },
  billing: {
    // The owner's billing commands (ADR 0104, decision 3), only with `billing:manage`, behind
    // BILLING_SELF_SERVICE_ENABLED, under the store's command lock and its limit. Cancel the renewal: access already
    // paid for runs to its end, and it cannot be undone.
    cancelRenewal: writeProcedure
      .input(billingCancelRenewalInput)
      .output(billingCancelRenewalOutput),
    // The provider's page of the charge that failed (grace, card): it pays that charge and does not change the card.
    // The address is the payer's: never logged.
    openOverduePayment: writeProcedure
      .input(billingOpenOverduePaymentInput)
      .output(billingOpenOverduePaymentOutput),
    // The plan as its owner reads it (ADR 0104, decision 2): only with `billing:manage`, behind
    // BILLING_SELF_SERVICE_ENABLED. The output is strict and closed: nothing personal and nothing of the provider.
    readPlan: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(billingPlanView),
    // The refund of the right of withdrawal: the renewal is cancelled first, then the first charge is refunded.
    requestRefund: writeProcedure
      .input(billingRequestRefundInput)
      .output(billingRequestRefundOutput),
    // Starts the Pro subscription at the payment provider (ADR 0101): the
    // provider's hosted page, where the payer types the card, or the Pix
    // Automático authorization at Woovi. Only the owner (`billing:manage`); the
    // organization is the server's. The input is strict: a card number, or a
    // tax ID or payer on the card, is refused, because the card path sends
    // Polaris nothing of the payer. The price, the dates and the return URLs are
    // the server's. The link and the Pix payload are the payer's alone and are
    // never logged.
    startCheckout: writeProcedure.input(billingStartCheckoutInput).output(
      z.object({
        handoff: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("redirect"),
            url: z.string().url(),
          }),
          // Pix Automático: the "copia e cola" of the authorization and Woovi's page, when it gave one;
          // no QR is drawn by Polaris (a QR library is a decision of its own, plan PR80)
          z.object({
            emv: z.string().min(1).max(1024),
            kind: z.literal("pix_authorization"),
            url: z.string().url().nullable(),
          }),
        ]),
      })
    ),
  },
  plan: {
    // Where the organization stands against the Free variant limit and which
    // variants it keeps operational (Free Over Limit, ADR 0064).
    operationalSelection: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(operationalSelection),
    // The complete choice. While the adaptation window is open it replaces the
    // previous one; after it, it must keep what is held and may only grow.
    selectOperationalVariants: writeProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          variantIds: z.array(z.string().uuid()).max(5000),
        })
      )
      .output(operationalSelection),
  },
  report: {
    // Server-computed and online only: the figures come from the confirmed
    // records of the organization, never from the device's pending work.
    periodSummary: readProcedure
      .input(
        z
          .object({
            from: expenseCalendarDate,
            organizationId: z.string().trim().min(1),
            to: expenseCalendarDate,
            /** Also rank this many most sold products (the same read of the period). */
            topProducts: z.number().int().min(1).max(10).optional(),
          })
          .refine(
            ({ from, to }) =>
              // an inverted or impossible date is the read's own refusal (NaN passes here)
              !(periodSummaryDays(from, to) > MAX_PERIOD_SUMMARY_DAYS),
            { message: "period_too_long", path: ["to"] }
          )
      )
      .output(periodSummary),
    // Only net sales and the count of sales of each date, aggregated by the
    // database (no sale goes through the engine in the Worker): the Início's map.
    dailySales: readProcedure
      .input(
        z
          .object({
            from: expenseCalendarDate,
            organizationId: z.string().trim().min(1),
            to: expenseCalendarDate,
          })
          .refine(
            ({ from, to }) =>
              // an inverted or impossible date is the read's own refusal (NaN passes here)
              !(periodSummaryDays(from, to) > MAX_DAILY_SALES_DAYS),
            { message: "period_too_long", path: ["to"] }
          )
      )
      .output(dailySales),
  },
  // A copy of the organization's data, built in the background and kept for a short time
  // (ADR 0078). Asking is a tenant operation of the owner; the file itself is downloaded from
  // /api/data-exports/{id}/files/{ordinal}, not through RPC.
  dataExport: {
    // A closed organization's copy (ADR 0081): the owner of an organization in closure asks for it outside the
    // tenant (which no longer opens), until the day its data may be deleted, with a session signed in within 15
    // minutes. Downloaded from /api/closed-exports/{id}/files/{ordinal}.
    listClosed: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ exports: z.array(closedDataExport) })),
    requestClosed: writeProcedure
      .input(
        z.object({
          formats: z
            .array(z.enum(["json", "csv", "images"]))
            .min(1)
            .max(3),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ id: z.string().uuid() })),
    list: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(
        z.object({
          exports: z.array(
            z.object({
              errorCode: z.string().nullable(),
              expiresAt: z.string().datetime().nullable(),
              files: z.array(
                z.object({
                  name: z.string().min(1),
                  ordinal: z.number().int().positive(),
                  sizeBytes: z.number().int().positive(),
                })
              ),
              formats: z.array(z.enum(["json", "csv", "images"])),
              id: z.string().uuid(),
              readyAt: z.string().datetime().nullable(),
              requestedAt: z.string().datetime(),
              status: z.enum([
                "requested",
                "running",
                "ready",
                "failed",
                "expired",
              ]),
              totalBytes: z.number().int().nonnegative().nullable(),
            })
          ),
        })
      ),
    request: writeProcedure
      .input(
        z.object({
          formats: z
            .array(z.enum(["json", "csv", "images"]))
            .min(1)
            .max(3),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ id: z.string().uuid() })),
  },
  device: {
    // Devices belong to the signed-in user, never to an organization: no
    // organization or user field to trust, the server reads the session.
    list: readProcedure.output(z.object({ devices: z.array(deviceReadModel) })),
    // Confirms a live device of the user and links this session to it; the
    // offline runtime calls it at every online start. A revoked device is a
    // CONFLICT, an unknown one NOT_FOUND.
    // A write for the rate limit: it promotes the link of this session to the device (ADR 0048, under a
    // lock) and records the device's last seen. Once per page load fits the write bucket.
    check: writeProcedure
      .input(z.object({ deviceId: z.string().uuid() }))
      .output(z.object({ device: deviceReadModel })),
    register: writeProcedure
      .input(z.object({ label: z.string().max(200).nullish() }))
      .output(z.object({ device: deviceReadModel })),
    // Ends the sessions linked to the device; `endOtherSessions` (off unless
    // the user ticks it) ends every other session of the user too, but never
    // this one. Revoking another device, or ending the other sessions, needs a
    // session signed in within 15 minutes: otherwise FORBIDDEN with reason
    // `fresh_session_required`. `endedCurrentSession` tells the screen this
    // browser is signed out as well.
    revoke: writeProcedure
      .input(
        z.object({
          deviceId: z.string().uuid(),
          endOtherSessions: z.boolean().default(false),
        })
      )
      .output(
        z.object({
          device: deviceReadModel,
          endedCurrentSession: z.boolean(),
          endedSessionCount: z.number().int().nonnegative(),
          revokedGrantIds: z.array(z.string().uuid()),
        })
      ),
    // "Sair" revokes this installation (ADR 0048): only the
    // device this session owns (it registered it, or confirmed it first while
    // signed in within 15 minutes), only the sessions linked to it, and without
    // a fresh session. Another device of the user is FORBIDDEN with reason
    // `not_current_device`, even for a recent session; an unknown one (or
    // another user's) NOT_FOUND. Repeating it is harmless (`alreadyRevoked`).
    revokeCurrent: writeProcedure
      .input(z.object({ deviceId: z.string().uuid() }))
      .output(
        z.object({
          alreadyRevoked: z.boolean(),
          endedCurrentSession: z.boolean(),
          revokedGrantCount: z.number().int().nonnegative(),
        })
      ),
  },
  inventory: {
    getBalance: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          variantId: z.string().uuid(),
        })
      )
      .output(inventoryBalance),
    inventoryCount: writeProcedure
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
    listBalances: readProcedure
      .input(
        z.object({
          // "unknown" keeps the variants whose average cost is not known,
          // including those with no balance row yet.
          cost: z.enum(["all", "unknown"]).default("all"),
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
    receiveStock: writeProcedure
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
    writeOffStock: writeProcedure
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
    issueLease: writeProcedure
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
    createInitial: writeProcedure
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
    // `billingSelfService`: BILLING_SELF_SERVICE_ENABLED is on (ADR 0104), so the owner's "Assinatura" may show.
    listMine: readProcedure.output(
      z.object({
        billingSelfService: z.boolean(),
        organizations: z.array(organizationMembership),
      })
    ),
    // The owner's own organizations whose closure can still be undone. Not tenant-scoped:
    // an organization in closure no longer opens as a tenant.
    listClosing: readProcedure.output(
      z.object({
        organizations: z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string().min(1),
            recoverUntil: z.string().datetime(),
          })
        ),
      })
    ),
    // The owner's closed organizations (closing, closed or with the purge scheduled) and their dates, computed by the
    // server in the organization's time zone; never a legal hold nor the status of a purge. Replaces listClosing.
    listClosed: readProcedure.output(
      z.object({ organizations: z.array(closedOrganization) })
    ),
    // One of them; null for an organization that is not the user's or does not exist, alike.
    closedStatus: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ organization: closedOrganization.nullable() })),
    // Undo a closure while its recovery window is open. The leases revoked at the request stay revoked.
    recoverClosure: writeProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ recovered: z.literal(true) })),
    // Closing revokes access at once. The owner types the organization's name to confirm.
    requestClosure: writeProcedure
      .input(
        z.object({
          confirmation: z.string().min(1).max(256),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(
        z.object({
          recoverUntil: z.string().datetime(),
          revokedLeases: z.number().int().nonnegative(),
        })
      ),
  },
  paymentProfile: {
    archive: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), profile: paymentProfile })),
    create: writeProcedure
      .input(
        paymentProfileFields.extend({
          organizationId: z.string().trim().min(1),
        })
      )
      .output(paymentProfile),
    list: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ profiles: z.array(paymentProfile) })),
    restore: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), profile: paymentProfile })),
    update: writeProcedure
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
    archive: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    configureVariants: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          options: z
            .array(
              z.object({
                name: productVariantOptionName,
                // a product has at most 50 variants, so more values than that for one option cannot be used
                values: z.array(z.string().trim().min(1)).min(1).max(50),
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
    create: writeProcedure
      .input(
        z.object({
          categoryId: z.string().uuid().nullable().optional(),
          description: z.string().max(5000).nullable().optional(),
          // The opening stock of the product, if the person says how many they have. The commandId is born once
          // per opening of the form, as the product and variant IDs: the retry of a try whose answer was lost names
          // them again and is told from a conflicting one on the server. A null cost is "cost unknown".
          initialStock: z
            .object({
              commandId: z.string().uuid(),
              quantity: z.number().int().positive().max(2_147_483_647),
              unitCost: z.string().trim().min(1).max(64).nullable(),
            })
            .nullable()
            .optional(),
          // The BRL list price of the default variant, with at most two decimals.
          listPrice: z.string().trim().min(1).max(64).nullable().optional(),
          name: productNameSchema,
          organizationId: z.string().trim().min(1),
          productId: z.string().uuid().optional(),
          variantId: z.string().uuid().optional(),
        })
      )
      .output(product),
    delete: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    getVariants: readProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(productVariantConfiguration),
    // One row of a spreadsheet import: its own rate-limit bucket (`bulk`), never the one of the writes, so a
    // sale made during the import keeps the whole write quota.
    importBatch: bulkProcedure
      .input(
        z
          .object({
            importId: z.string().uuid(),
            organizationId: z.string().trim().min(1),
            rows: z
              .array(productImportRow)
              .min(1)
              .max(PRODUCT_IMPORT_BATCH_MAX_ROWS)
              .superRefine(distinctImportRows),
          })
          .strict()
      )
      .output(z.object({ results: z.array(productImportRowResult) })),
    list: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ products: z.array(product) })),
    // The names of a file that a product of the store already has (an archived one too), for the preview of an
    // import: only information, the transaction of each row decides. Compared without case and repeated spaces.
    namesExisting: readProcedure
      .input(
        z
          .object({
            names: z.array(z.string().max(200)).max(PRODUCT_IMPORT_MAX_NAMES),
            organizationId: z.string().trim().min(1),
          })
          .strict()
      )
      .output(z.object({ names: z.array(z.string()) })),
    restore: writeProcedure
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    setVariantListPrice: writeProcedure
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
    setVariantSku: writeProcedure
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
    update: writeProcedure
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
    assignCustomer: writeProcedure
      .input(saleCustomerLinkTarget.extend({ customerId: z.string().uuid() }))
      .output(saleCustomerLinkChange),
    cancel: writeProcedure
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
    confirm: writeProcedure
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
    get: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          saleId: z.string().uuid(),
        })
      )
      .output(saleDetail),
    getCustomerLink: readProcedure
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          saleId: z.string().uuid(),
        })
      )
      .output(saleCustomerLink),
    list: readProcedure
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

    reassignCustomer: writeProcedure
      .input(saleCustomerLinkTarget.extend({ customerId: z.string().uuid() }))
      .output(saleCustomerLinkChange),
    // A partial return: per item the returned quantity and the quantity that
    // goes back to sellable stock (restocked <= returned <= still available).
    return: writeProcedure
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
    unassignCustomer: writeProcedure
      .input(saleCustomerLinkTarget)
      .output(saleCustomerLinkChange),
  },
  sync: {
    // One page of one local collection, keyed by id, or specific entities
    // (`ids`) to re-read after a change. A device records the cursor first, reads
    // its snapshot page by page, then pulls from the cursor.
    bootstrapPage: readProcedure
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
    getCursor: readProcedure
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ cursor: syncCursorText })),
    // The changes after a cursor, in commit order. Entities changed several
    // times in the page appear once, at their latest sequence.
    pull: readProcedure
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
    push: writeProcedure
      .input(
        z.object({
          commands: z.array(pushCommand).min(1).max(50),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ results: z.array(pushResult) })),
  },
  system: {
    ping: readProcedure.output(z.object({ message: z.literal("pong") })),
  },
};

export type PolarisRpcClient = ContractRouterClient<typeof polarisContract>;
