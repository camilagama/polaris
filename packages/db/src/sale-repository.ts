import { InventoryVariantNotFoundError } from "@polaris/domain/inventory/inventory";
import { Money, Percentage } from "@polaris/domain/money/money";
import {
  type ConfirmSaleCommandInput,
  type ConfirmedSaleTotals,
  composeConfirmedSale,
  type NormalizedConfirmSaleCommand,
  normalizeConfirmSaleCommand,
  type ResolvedConfirmSaleItem,
  SaleCommandConflictError,
  SaleProductUnavailableError,
  summarizeConfirmedSaleTotals,
} from "@polaris/domain/sales/confirm-sale";
import {
  type PaymentFeeMode,
  type PaymentProfileForSale,
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
} from "@polaris/domain/sales/payment-profile";
import { normalizeBrlAmount } from "@polaris/domain/sales/sale";
import {
  assertSaleOccurredWithinWindow,
  retroactiveLimitDaysForRole,
} from "@polaris/domain/sales/sale-dates";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordSaleStockMovement } from "./inventory-repository";
import { assertVariantsOperational } from "./operational-selection-repository";
import { organizations } from "./schema/organization";
import { paymentProfileRules, paymentProfiles } from "./schema/payment-profile";
import {
  productOptionValues,
  productOptions,
  variantOptionValues,
} from "./schema/product-variants";
import { productVariants, products } from "./schema/product";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export interface ConfirmSaleRepositoryInput extends ConfirmSaleCommandInput {
  requestId?: string | null;
}

export interface ConfirmedSaleReadModel {
  adjustments: Array<{
    amount: string;
    kind: string;
    percentage: string | null;
    position: number;
    valueType: string;
  }>;
  items: Array<{
    chargedUnitPrice: string;
    listedUnitPrice: string;
    position: number;
    productId: string;
    productLabel: string;
    quantity: number;
    unitCost: string | null;
    variantId: string;
  }>;
  /** The part at position 0, for readers that still handle one payment. */
  payment: ConfirmedSalePaymentReadModel;
  /** Every part, by position. */
  payments: Array<ConfirmedSalePaymentReadModel & { position: number }>;
  sale: {
    recordedAt: Date | null;
    commandId: string;
    confirmedAt: Date;
    currency: string;
    id: string;
    occurredAt: Date;
    occurredOn: string;
  };
  totals: ConfirmedSaleTotals;
}

export interface ConfirmedSalePaymentReadModel {
  amount: string;
  anticipationFee: {
    amount: string | null;
    fixedAmount: string | null;
    mode: string;
    percentage: string | null;
  };
  anticipationRequested: boolean;
  expectedSettlementDays: number | null;
  installmentPlan: string | null;
  installments: number | null;
  method: string;
  paymentProfileId: string | null;
  paymentProfileName: string | null;
  paymentProfileRuleId: string | null;
  paymentProfileVersion: number | null;
  processingFee: {
    amount: string | null;
    fixedAmount: string | null;
    mode: string;
    percentage: string | null;
  };
}

export interface ConfirmSaleResult extends ConfirmedSaleReadModel {
  replayed: boolean;
}

function requireSaleCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== "sale:create") {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function sameNullableInstant(left: Date | null, right: Date | null): boolean {
  return left === null || right === null
    ? left === right
    : left.getTime() === right.getTime();
}

function samePercentage(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : Percentage.from(left).toString() === Percentage.from(right).toString();
}

type SalePaymentRow = typeof salePayments.$inferSelect;

function paymentReadModel(row: SalePaymentRow): ConfirmedSalePaymentReadModel {
  return {
    amount: Money.from(row.amount).toString(),
    anticipationFee: {
      amount: row.anticipationFeeAmountSnapshot,
      fixedAmount: row.anticipationFeeFixedAmountSnapshot,
      mode: row.anticipationFeeModeSnapshot,
      percentage: row.anticipationFeePercentageSnapshot,
    },
    anticipationRequested: row.anticipationRequested,
    expectedSettlementDays: row.expectedSettlementDaysSnapshot,
    installmentPlan: row.installmentPlan,
    installments: row.installments,
    method: row.method,
    paymentProfileId: row.paymentProfileId,
    paymentProfileName: row.paymentProfileNameSnapshot,
    paymentProfileRuleId: row.paymentProfileRuleIdSnapshot,
    paymentProfileVersion: row.paymentProfileVersionSnapshot,
    processingFee: {
      amount: row.processingFeeAmountSnapshot,
      fixedAmount: row.processingFeeFixedAmountSnapshot,
      mode: row.processingFeeModeSnapshot,
      percentage: row.processingFeePercentageSnapshot,
    },
  };
}

export async function readConfirmedSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  header: typeof sales.$inferSelect
): Promise<ConfirmedSaleReadModel> {
  const items = await transaction
    .select()
    .from(saleItems)
    .where(
      and(
        eq(saleItems.organizationId, identity.organizationId),
        eq(saleItems.saleId, header.id)
      )
    )
    .orderBy(asc(saleItems.position));
  const adjustments = await transaction
    .select()
    .from(saleAdjustments)
    .where(
      and(
        eq(saleAdjustments.organizationId, identity.organizationId),
        eq(saleAdjustments.saleId, header.id)
      )
    )
    .orderBy(asc(saleAdjustments.position));
  const paymentRows = await transaction
    .select()
    .from(salePayments)
    .where(
      and(
        eq(salePayments.organizationId, identity.organizationId),
        eq(salePayments.saleId, header.id)
      )
    )
    .orderBy(asc(salePayments.position), asc(salePayments.id));
  // Every row of the sale is read, whatever their number: the part at the
  // lowest position is the sale's `payment`.
  const payments = paymentRows.map((row) => ({
    ...paymentReadModel(row),
    position: row.position,
  }));
  const [firstRow] = paymentRows;
  if (!firstRow) {
    throw new Error("confirmed_sale_payment_missing");
  }

  const itemModels = items.map((item) => ({
    chargedUnitPrice: Money.from(item.chargedUnitPrice).toString(),
    listedUnitPrice: Money.from(item.listedUnitPrice).toString(),
    position: item.position,
    productId: item.productId,
    productLabel: item.productLabel,
    quantity: item.quantity,
    unitCost: item.unitCost,
    variantId: item.variantId,
  }));
  const adjustmentModels = adjustments.map((adjustment) => ({
    amount: Money.from(adjustment.amount).toString(),
    kind: adjustment.kind,
    percentage:
      adjustment.percentage === null
        ? null
        : Percentage.from(adjustment.percentage).toString(),
    position: adjustment.position,
    valueType: adjustment.valueType,
  }));

  return {
    adjustments: adjustmentModels,
    items: itemModels,
    payment: paymentReadModel(firstRow),
    payments,
    sale: {
      recordedAt: header.recordedAt,
      commandId: header.commandId,
      confirmedAt: header.confirmedAt,
      currency: header.currency,
      id: header.id,
      occurredAt: header.occurredAt,
      occurredOn: header.occurredOn,
    },
    totals: summarizeConfirmedSaleTotals(itemModels, adjustmentModels),
  };
}

/** A repeated command ID is a replay only when it carries the same payload. */
function replayMatchesCommand(
  saved: ConfirmedSaleReadModel,
  command: NormalizedConfirmSaleCommand
): boolean {
  return (
    saved.sale.commandId === command.commandId &&
    sameNullableInstant(saved.sale.occurredAt, command.occurredAt) &&
    sameNullableInstant(saved.sale.recordedAt, command.recordedAt) &&
    saved.items.length === command.items.length &&
    command.items.every((item) => {
      const savedItem = saved.items[item.position];
      return (
        savedItem !== undefined &&
        savedItem.variantId === item.variantId &&
        savedItem.quantity === item.quantity &&
        normalizeBrlAmount(savedItem.listedUnitPrice) ===
          item.listedUnitPrice &&
        normalizeBrlAmount(savedItem.chargedUnitPrice) === item.chargedUnitPrice
      );
    }) &&
    saved.adjustments.length === command.adjustments.length &&
    command.adjustments.every((adjustment) => {
      const savedAdjustment = saved.adjustments[adjustment.position];
      return (
        savedAdjustment !== undefined &&
        savedAdjustment.kind === adjustment.kind &&
        savedAdjustment.valueType === adjustment.valueType &&
        savedAdjustment.amount === adjustment.amount &&
        samePercentage(savedAdjustment.percentage, adjustment.percentage)
      );
    }) &&
    paymentsMatchCommand(saved.payments, command.payments)
  );
}

/**
 * The saved parts and the command's parts are compared position by position:
 * the same parts in another order, or another amount, are another sale.
 */
function paymentsMatchCommand(
  saved: ConfirmedSaleReadModel["payments"],
  parts: NormalizedConfirmSaleCommand["payments"]
): boolean {
  return (
    saved.length === parts.length &&
    parts.every(({ payment, paymentProfile }, index) => {
      const savedPart = saved[index];
      return (
        savedPart !== undefined &&
        savedPart.position === index &&
        savedPart.method === payment.method &&
        savedPart.amount === payment.amount &&
        savedPart.installments === payment.installments &&
        savedPart.installmentPlan === payment.installmentPlan &&
        savedPart.anticipationRequested === payment.anticipationRequested &&
        savedPart.paymentProfileId === (paymentProfile?.id ?? null) &&
        savedPart.paymentProfileVersion ===
          (paymentProfile?.expectedVersion ?? null)
      );
    })
  );
}

async function replayExistingSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  command: NormalizedConfirmSaleCommand
): Promise<ConfirmSaleResult | null> {
  const [header] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, identity.organizationId),
        eq(sales.commandId, command.commandId)
      )
    )
    .limit(1);
  if (!header) {
    return null;
  }
  const saved = await readConfirmedSale(transaction, identity, header);
  if (!replayMatchesCommand(saved, command)) {
    throw new SaleCommandConflictError();
  }
  return { ...saved, replayed: true };
}

/**
 * The profile of each part, in part order (null for a part without one). Every
 * profile and every rule of the sale comes from the same two reads, whatever
 * the number of parts. A part whose profile is missing, archived or at another
 * version refuses the whole sale, naming that part.
 */
async function loadPaymentProfilesForSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  selections: readonly ({ expectedVersion: number; id: string } | null)[]
): Promise<(PaymentProfileForSale | null)[]> {
  const ids = [
    ...new Set(
      selections.flatMap((selection) => (selection ? [selection.id] : []))
    ),
  ];
  if (ids.length === 0) {
    return selections.map(() => null);
  }
  // FOR SHARE keeps the profiles from being edited until this sale commits, so
  // the snapshot matches the version the operator confirmed; the id order keeps
  // two sales that name the same profiles from deadlocking.
  const profiles = await transaction
    .select({
      archivedAt: paymentProfiles.archivedAt,
      id: paymentProfiles.id,
      name: paymentProfiles.name,
      version: paymentProfiles.version,
    })
    .from(paymentProfiles)
    .where(
      and(
        inArray(paymentProfiles.id, ids),
        eq(paymentProfiles.organizationId, identity.organizationId)
      )
    )
    .orderBy(asc(paymentProfiles.id))
    .for("share");
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const [part, selection] of selections.entries()) {
    if (!selection) {
      continue;
    }
    const profile = profileById.get(selection.id);
    if (!profile) {
      throw new PaymentProfileNotFoundError(part);
    }
    if (profile.archivedAt !== null) {
      throw new PaymentProfileLifecycleError(part);
    }
    if (profile.version !== selection.expectedVersion) {
      throw new PaymentProfileVersionConflictError(part);
    }
  }

  const rules = await transaction
    .select()
    .from(paymentProfileRules)
    .where(
      and(
        eq(paymentProfileRules.organizationId, identity.organizationId),
        inArray(paymentProfileRules.paymentProfileId, ids),
        isNull(paymentProfileRules.archivedAt)
      )
    );

  return selections.map((selection) => {
    const profile = selection ? profileById.get(selection.id) : undefined;
    if (!profile) {
      return null;
    }
    return {
      id: profile.id,
      name: profile.name,
      rules: rules
        .filter((rule) => rule.paymentProfileId === profile.id)
        .map((rule) => ({
          anticipationFee: {
            fixedAmount: rule.anticipationFeeFixedAmount,
            mode: rule.anticipationFeeMode as PaymentFeeMode,
            percentage: rule.anticipationFeePercentage,
          },
          expectedSettlementDays: rule.expectedSettlementDays,
          id: rule.id,
          installmentPlan:
            rule.installmentPlan === null
              ? null
              : (rule.installmentPlan as "merchant" | "issuer"),
          installments: rule.installments,
          method: rule.method,
          processingFee: {
            fixedAmount: rule.processingFeeFixedAmount,
            mode: rule.processingFeeMode as PaymentFeeMode,
            percentage: rule.processingFeePercentage,
          },
        })),
      version: profile.version,
    };
  });
}

interface SaleCatalogFacts {
  productIdByVariantId: Map<string, string>;
  productLabelByVariantId: Map<string, string>;
}

/**
 * Locks every product of the sale in id order, then reads names and lifecycle
 * under that lock. A consistent order keeps concurrent sales from deadlocking
 * and an archive/delete committed first is seen before any stock is touched.
 */
async function lockSaleCatalog(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  variantIds: readonly string[]
): Promise<SaleCatalogFacts> {
  const variants = await transaction
    .select({
      id: productVariants.id,
      isDefault: productVariants.isDefault,
      productId: productVariants.productId,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.organizationId, identity.organizationId),
        inArray(productVariants.id, [...variantIds])
      )
    );
  if (variants.length !== new Set(variantIds).size) {
    throw new InventoryVariantNotFoundError();
  }

  const productIds = [...new Set(variants.map((variant) => variant.productId))];
  const lockedProducts = await transaction
    .select({
      archivedAt: products.archivedAt,
      deletedAt: products.deletedAt,
      id: products.id,
      name: products.name,
    })
    .from(products)
    .where(
      and(
        eq(products.organizationId, identity.organizationId),
        inArray(products.id, productIds)
      )
    )
    .orderBy(asc(products.id))
    .for("update");
  if (lockedProducts.length !== productIds.length) {
    throw new InventoryVariantNotFoundError();
  }
  if (
    lockedProducts.some(
      (product) => product.archivedAt !== null || product.deletedAt !== null
    )
  ) {
    throw new SaleProductUnavailableError();
  }
  const productNameById = new Map(
    lockedProducts.map((product) => [product.id, product.name])
  );

  const optionValueRows = await transaction
    .select({
      optionPosition: productOptions.position,
      valueName: productOptionValues.name,
      variantId: variantOptionValues.variantId,
    })
    .from(variantOptionValues)
    .innerJoin(
      productOptions,
      and(
        eq(productOptions.organizationId, variantOptionValues.organizationId),
        eq(productOptions.productId, variantOptionValues.productId),
        eq(productOptions.id, variantOptionValues.optionId)
      )
    )
    .innerJoin(
      productOptionValues,
      and(
        eq(
          productOptionValues.organizationId,
          variantOptionValues.organizationId
        ),
        eq(productOptionValues.productId, variantOptionValues.productId),
        eq(productOptionValues.id, variantOptionValues.optionValueId)
      )
    )
    .where(
      and(
        eq(variantOptionValues.organizationId, identity.organizationId),
        inArray(variantOptionValues.variantId, [...variantIds])
      )
    )
    .orderBy(asc(productOptions.position));
  const valuesByVariantId = new Map<string, string[]>();
  for (const row of optionValueRows) {
    const values = valuesByVariantId.get(row.variantId) ?? [];
    values.push(row.valueName);
    valuesByVariantId.set(row.variantId, values);
  }

  const productIdByVariantId = new Map<string, string>();
  const productLabelByVariantId = new Map<string, string>();
  for (const variant of variants) {
    const name = productNameById.get(variant.productId);
    if (name === undefined) {
      throw new InventoryVariantNotFoundError();
    }
    const values = valuesByVariantId.get(variant.id) ?? [];
    productIdByVariantId.set(variant.id, variant.productId);
    productLabelByVariantId.set(
      variant.id,
      variant.isDefault || values.length === 0
        ? name
        : `${name} — ${values.join(" / ")}`
    );
  }
  return { productIdByVariantId, productLabelByVariantId };
}

/**
 * Confirms a complete sale in the caller's tenant transaction: header, items,
 * adjustments, payment, stock movements and balances, and the audit event
 * commit or roll back together. There is no draft state and no partial sale.
 * The caller must run this inside withAuthorizedTenantTransaction with the
 * sale:create capability; the organization comes from that identity, never
 * from the command payload.
 */
export async function confirmSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: ConfirmSaleRepositoryInput
): Promise<ConfirmSaleResult> {
  requireSaleCapability(identity);
  const command = normalizeConfirmSaleCommand(rawInput);

  const replay = await replayExistingSale(transaction, identity, command);
  if (replay) {
    return replay;
  }

  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  // The commercial date is the organization's calendar date; the retroactive
  // window is counted in that calendar and follows the actor's role. Replays
  // were answered above, so an old sale already confirmed still replays.
  const occurredOn = assertSaleOccurredWithinWindow({
    maxRetroactiveDays: retroactiveLimitDaysForRole(identity.role),
    now: new Date(),
    occurredAt: command.occurredAt,
    timeZone: organization.timezone,
  });

  // The unique (organization, command) index serializes a duplicate that races
  // this transaction: the loser waits for the winner, inserts nothing, and
  // replays the committed sale.
  const [header] = await transaction
    .insert(sales)
    .values({
      adjustmentCount: command.adjustments.length,
      recordedAt: command.recordedAt,
      commandId: command.commandId,
      itemCount: command.items.length,
      occurredAt: command.occurredAt,
      occurredOn,
      organizationId: identity.organizationId,
      paymentCount: command.payments.length,
    })
    .onConflictDoNothing({ target: [sales.organizationId, sales.commandId] })
    .returning();
  if (!header) {
    const concurrentReplay = await replayExistingSale(
      transaction,
      identity,
      command
    );
    if (!concurrentReplay) {
      throw new Error("sale_insert_failed");
    }
    return concurrentReplay;
  }

  const profiles = await loadPaymentProfilesForSale(
    transaction,
    identity,
    command.payments.map((part) => part.paymentProfile)
  );

  const catalog = await lockSaleCatalog(
    transaction,
    identity,
    command.items.map((item) => item.variantId)
  );
  // an organization over the Free limit sells only the variants it kept operational (ADR 0064)
  await assertVariantsOperational(
    transaction,
    identity,
    command.items.map((item) => item.variantId)
  );

  const unitCostByPosition = new Map<number, string | null>();
  const itemsInLockOrder = [...command.items].sort((left, right) => {
    const leftProduct = catalog.productIdByVariantId.get(left.variantId) ?? "";
    const rightProduct =
      catalog.productIdByVariantId.get(right.variantId) ?? "";
    return (
      leftProduct.localeCompare(rightProduct) ||
      left.variantId.localeCompare(right.variantId) ||
      left.position - right.position
    );
  });
  for (const item of itemsInLockOrder) {
    // Movements must run one at a time: each locks its balance row in product
    // order, and repeated lines of one variant see the previous balance.
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const { movement } = await recordSaleStockMovement(transaction, identity, {
      commandId: command.commandId,
      commandIndex: item.position,
      occurredOn,
      quantity: item.quantity,
      requestId: rawInput.requestId ?? null,
      variantId: item.variantId,
    });
    unitCostByPosition.set(item.position, movement.unitCost);
  }

  const resolvedItems: ResolvedConfirmSaleItem[] = command.items.map((item) => {
    const productId = catalog.productIdByVariantId.get(item.variantId);
    const productLabel = catalog.productLabelByVariantId.get(item.variantId);
    if (!(productId && productLabel)) {
      throw new InventoryVariantNotFoundError();
    }
    return {
      position: item.position,
      productId,
      productLabel,
      unitCost: unitCostByPosition.get(item.position) ?? null,
    };
  });
  const composition = composeConfirmedSale(command, resolvedItems, profiles);

  await transaction.insert(saleItems).values(
    composition.sale.items.map((item) => ({
      chargedUnitPrice: item.chargedUnitPrice,
      listedUnitPrice: item.listedUnitPrice,
      organizationId: identity.organizationId,
      position: item.position,
      productId: item.productId,
      productLabel: item.productLabel,
      quantity: item.quantity,
      saleId: header.id,
      unitCost: item.unitCost,
      variantId: item.variantId,
    }))
  );
  if (composition.calculation.adjustments.length > 0) {
    await transaction.insert(saleAdjustments).values(
      composition.calculation.adjustments.map((adjustment) => ({
        amount: adjustment.amount,
        kind: adjustment.kind,
        organizationId: identity.organizationId,
        percentage: adjustment.percentage,
        position: adjustment.position,
        saleId: header.id,
        valueType: adjustment.valueType,
      }))
    );
  }

  // One statement for every part, so a split sale costs what a single one does.
  await transaction.insert(salePayments).values(
    composition.payments.map(({ payment, paymentProfile }, position) => ({
      amount: payment.amount,
      anticipationFeeAmountSnapshot: paymentProfile.anticipationFee.amount,
      anticipationFeeFixedAmountSnapshot:
        paymentProfile.anticipationFee.fixedAmount,
      anticipationFeeModeSnapshot: paymentProfile.anticipationFee.mode,
      anticipationFeePercentageSnapshot:
        paymentProfile.anticipationFee.percentage,
      anticipationRequested: payment.anticipationRequested,
      expectedSettlementDaysSnapshot: paymentProfile.expectedSettlementDays,
      installmentPlan: payment.installmentPlan,
      installmentPlanUnknown: payment.installmentPlanUnknown,
      installments: payment.installments,
      method: payment.method,
      organizationId: identity.organizationId,
      paymentProfileId: paymentProfile.paymentProfileId,
      paymentProfileNameSnapshot: paymentProfile.paymentProfileName,
      paymentProfileRuleIdSnapshot: paymentProfile.paymentProfileRuleId,
      paymentProfileVersionSnapshot: paymentProfile.paymentProfileVersion,
      position,
      processingFeeAmountSnapshot: paymentProfile.processingFee.amount,
      processingFeeFixedAmountSnapshot:
        paymentProfile.processingFee.fixedAmount,
      processingFeeModeSnapshot: paymentProfile.processingFee.mode,
      processingFeePercentageSnapshot: paymentProfile.processingFee.percentage,
      saleId: header.id,
    }))
  );

  await recordTenantAuditEvent(transaction, identity, {
    entityId: header.id,
    entityType: "sale",
    eventType: "sale.confirmed",
    requestId: rawInput.requestId ?? null,
  });

  const saved = await readConfirmedSale(transaction, identity, header);
  return { ...saved, replayed: false };
}
