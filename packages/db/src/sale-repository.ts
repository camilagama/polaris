import { InventoryVariantNotFoundError } from "@polaris/domain/inventory/inventory";
import { Money, Percentage } from "@polaris/domain/money/money";
import {
  calendarDateInTimeZone,
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
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordSaleStockMovement } from "./inventory-repository";
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
  payment: {
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
  };
  sale: {
    clientCreatedAt: Date | null;
    commandId: string;
    confirmedAt: Date;
    currency: string;
    id: string;
    occurredAt: Date;
  };
  totals: ConfirmedSaleTotals;
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

async function readConfirmedSale(
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
  const [payment] = await transaction
    .select()
    .from(salePayments)
    .where(
      and(
        eq(salePayments.organizationId, identity.organizationId),
        eq(salePayments.saleId, header.id)
      )
    )
    .limit(1);
  if (!payment) {
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
    payment: {
      amount: Money.from(payment.amount).toString(),
      anticipationFee: {
        amount: payment.anticipationFeeAmountSnapshot,
        fixedAmount: payment.anticipationFeeFixedAmountSnapshot,
        mode: payment.anticipationFeeModeSnapshot,
        percentage: payment.anticipationFeePercentageSnapshot,
      },
      anticipationRequested: payment.anticipationRequested,
      expectedSettlementDays: payment.expectedSettlementDaysSnapshot,
      installmentPlan: payment.installmentPlan,
      installments: payment.installments,
      method: payment.method,
      paymentProfileId: payment.paymentProfileId,
      paymentProfileName: payment.paymentProfileNameSnapshot,
      paymentProfileRuleId: payment.paymentProfileRuleIdSnapshot,
      paymentProfileVersion: payment.paymentProfileVersionSnapshot,
      processingFee: {
        amount: payment.processingFeeAmountSnapshot,
        fixedAmount: payment.processingFeeFixedAmountSnapshot,
        mode: payment.processingFeeModeSnapshot,
        percentage: payment.processingFeePercentageSnapshot,
      },
    },
    sale: {
      clientCreatedAt: header.clientCreatedAt,
      commandId: header.commandId,
      confirmedAt: header.confirmedAt,
      currency: header.currency,
      id: header.id,
      occurredAt: header.occurredAt,
    },
    totals: summarizeConfirmedSaleTotals(itemModels, adjustmentModels),
  };
}

/** A repeated command ID is a replay only when it carries the same payload. */
function replayMatchesCommand(
  saved: ConfirmedSaleReadModel,
  command: NormalizedConfirmSaleCommand
): boolean {
  const { payment } = saved;
  const selection = command.paymentProfile;
  return (
    saved.sale.commandId === command.commandId &&
    sameNullableInstant(saved.sale.occurredAt, command.occurredAt) &&
    sameNullableInstant(saved.sale.clientCreatedAt, command.clientCreatedAt) &&
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
    payment.method === command.payment.method &&
    payment.amount === command.payment.amount &&
    payment.installments === command.payment.installments &&
    payment.installmentPlan === command.payment.installmentPlan &&
    payment.anticipationRequested === command.payment.anticipationRequested &&
    payment.paymentProfileId === (selection?.id ?? null) &&
    payment.paymentProfileVersion === (selection?.expectedVersion ?? null)
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

async function loadPaymentProfileForSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  selection: { expectedVersion: number; id: string }
): Promise<PaymentProfileForSale> {
  // FOR SHARE keeps the profile from being edited until this sale commits, so
  // the snapshot matches the version the operator confirmed.
  const [profile] = await transaction
    .select({
      archivedAt: paymentProfiles.archivedAt,
      id: paymentProfiles.id,
      name: paymentProfiles.name,
      version: paymentProfiles.version,
    })
    .from(paymentProfiles)
    .where(
      and(
        eq(paymentProfiles.id, selection.id),
        eq(paymentProfiles.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("share");
  if (!profile) {
    throw new PaymentProfileNotFoundError();
  }
  if (profile.archivedAt !== null) {
    throw new PaymentProfileLifecycleError();
  }
  if (profile.version !== selection.expectedVersion) {
    throw new PaymentProfileVersionConflictError();
  }

  const rules = await transaction
    .select()
    .from(paymentProfileRules)
    .where(
      and(
        eq(paymentProfileRules.organizationId, identity.organizationId),
        eq(paymentProfileRules.paymentProfileId, profile.id),
        isNull(paymentProfileRules.archivedAt)
      )
    );

  return {
    id: profile.id,
    name: profile.name,
    rules: rules.map((rule) => ({
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
  const occurredOn = calendarDateInTimeZone(
    command.occurredAt,
    organization.timezone
  );

  // The unique (organization, command) index serializes a duplicate that races
  // this transaction: the loser waits for the winner, inserts nothing, and
  // replays the committed sale.
  const [header] = await transaction
    .insert(sales)
    .values({
      adjustmentCount: command.adjustments.length,
      clientCreatedAt: command.clientCreatedAt,
      commandId: command.commandId,
      itemCount: command.items.length,
      occurredAt: command.occurredAt,
      organizationId: identity.organizationId,
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

  const profile = command.paymentProfile
    ? await loadPaymentProfileForSale(
        transaction,
        identity,
        command.paymentProfile
      )
    : null;

  const catalog = await lockSaleCatalog(
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
  const composition = composeConfirmedSale(command, resolvedItems, profile);

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

  const { payment, paymentProfile } = composition;
  await transaction.insert(salePayments).values({
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
    processingFeeAmountSnapshot: paymentProfile.processingFee.amount,
    processingFeeFixedAmountSnapshot: paymentProfile.processingFee.fixedAmount,
    processingFeeModeSnapshot: paymentProfile.processingFee.mode,
    processingFeePercentageSnapshot: paymentProfile.processingFee.percentage,
    saleId: header.id,
  });

  await recordTenantAuditEvent(transaction, identity, {
    entityId: header.id,
    entityType: "sale",
    eventType: "sale.confirmed",
    requestId: rawInput.requestId ?? null,
  });

  const saved = await readConfirmedSale(transaction, identity, header);
  return { ...saved, replayed: false };
}
