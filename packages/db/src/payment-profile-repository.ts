import {
  derivePaymentProfileLifecycle,
  InvalidPaymentProfileError,
  type NormalizedPaymentProfileRule,
  normalizePaymentProfile,
  type PaymentProfileInput,
  type PaymentProfileLifecycleAction,
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
  transitionPaymentProfileLifecycle,
} from "@polaris/domain/sales/payment-profile";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { paymentProfileRules, paymentProfiles } from "./schema/payment-profile";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export interface PaymentProfileListOptions {
  status?: "active" | "archived" | "all";
}

export interface PaymentProfileMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface CreatePaymentProfileInput extends PaymentProfileInput {
  requestId?: string | null;
}

export interface UpdatePaymentProfileInput
  extends PaymentProfileMutationInput,
    PaymentProfileInput {}

const profileColumns = {
  archivedAt: paymentProfiles.archivedAt,
  createdAt: paymentProfiles.createdAt,
  id: paymentProfiles.id,
  name: paymentProfiles.name,
  organizationId: paymentProfiles.organizationId,
  updatedAt: paymentProfiles.updatedAt,
  version: paymentProfiles.version,
};

const ruleColumns = {
  anticipationFeeFixedAmount: paymentProfileRules.anticipationFeeFixedAmount,
  anticipationFeeMode: paymentProfileRules.anticipationFeeMode,
  anticipationFeePercentage: paymentProfileRules.anticipationFeePercentage,
  archivedAt: paymentProfileRules.archivedAt,
  createdAt: paymentProfileRules.createdAt,
  expectedSettlementDays: paymentProfileRules.expectedSettlementDays,
  id: paymentProfileRules.id,
  installmentPlan: paymentProfileRules.installmentPlan,
  installments: paymentProfileRules.installments,
  method: paymentProfileRules.method,
  organizationId: paymentProfileRules.organizationId,
  paymentProfileId: paymentProfileRules.paymentProfileId,
  processingFeeFixedAmount: paymentProfileRules.processingFeeFixedAmount,
  processingFeeMode: paymentProfileRules.processingFeeMode,
  processingFeePercentage: paymentProfileRules.processingFeePercentage,
  updatedAt: paymentProfileRules.updatedAt,
};

function ruleKey(rule: {
  installmentPlan: string | null;
  installments: number | null;
  method: string;
}) {
  return [
    rule.method,
    rule.installmentPlan ?? "",
    rule.installments ?? "",
  ].join("|");
}

function sameFeeConfiguration(
  existing: {
    fixedAmount: string | null;
    mode: string;
    percentage: string | null;
  },
  desired: NormalizedPaymentProfileRule["processingFee"]
) {
  return (
    existing.mode === desired.mode &&
    existing.fixedAmount === desired.fixedAmount &&
    existing.percentage === desired.percentage
  );
}

function sameProfileRule(
  existing: typeof paymentProfileRules.$inferSelect,
  desired: NormalizedPaymentProfileRule
) {
  return (
    existing.expectedSettlementDays === desired.expectedSettlementDays &&
    existing.installmentPlan === desired.installmentPlan &&
    existing.installments === desired.installments &&
    existing.method === desired.method &&
    sameFeeConfiguration(
      {
        fixedAmount: existing.processingFeeFixedAmount,
        mode: existing.processingFeeMode,
        percentage: existing.processingFeePercentage,
      },
      desired.processingFee
    ) &&
    sameFeeConfiguration(
      {
        fixedAmount: existing.anticipationFeeFixedAmount,
        mode: existing.anticipationFeeMode,
        percentage: existing.anticipationFeePercentage,
      },
      desired.anticipationFee
    )
  );
}

function ruleValues(
  organizationId: string,
  paymentProfileId: string,
  rule: NormalizedPaymentProfileRule
) {
  return {
    anticipationFeeFixedAmount: rule.anticipationFee.fixedAmount,
    anticipationFeeMode: rule.anticipationFee.mode,
    anticipationFeePercentage: rule.anticipationFee.percentage,
    expectedSettlementDays: rule.expectedSettlementDays,
    installmentPlan: rule.installmentPlan,
    installments: rule.installments,
    method: rule.method,
    organizationId,
    paymentProfileId,
    processingFeeFixedAmount: rule.processingFee.fixedAmount,
    processingFeeMode: rule.processingFee.mode,
    processingFeePercentage: rule.processingFee.percentage,
  };
}

function planRuleChanges(
  activeRules: (typeof paymentProfileRules.$inferSelect)[],
  desiredRules: NormalizedPaymentProfileRule[]
) {
  const existingByKey = new Map(
    activeRules.map((rule) => [ruleKey(rule), rule])
  );
  const desiredByKey = new Map(
    desiredRules.map((rule) => [ruleKey(rule), rule])
  );
  const rulesToInsert: NormalizedPaymentProfileRule[] = [];
  const ruleIdsToArchive: string[] = [];

  for (const [key, desired] of desiredByKey) {
    const current = existingByKey.get(key);
    if (current && sameProfileRule(current, desired)) {
      continue;
    }
    if (current) {
      ruleIdsToArchive.push(current.id);
    }
    rulesToInsert.push(desired);
  }

  for (const [key, current] of existingByKey) {
    if (!desiredByKey.has(key)) {
      ruleIdsToArchive.push(current.id);
    }
  }

  return { ruleIdsToArchive, rulesToInsert };
}

async function listRulesForProfiles(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  profileIds: string[]
) {
  if (profileIds.length === 0) {
    return [];
  }
  return await transaction
    .select(ruleColumns)
    .from(paymentProfileRules)
    .where(
      and(
        eq(paymentProfileRules.organizationId, identity.organizationId),
        inArray(paymentProfileRules.paymentProfileId, profileIds),
        isNull(paymentProfileRules.archivedAt)
      )
    )
    .orderBy(
      asc(paymentProfileRules.paymentProfileId),
      asc(paymentProfileRules.method),
      asc(paymentProfileRules.installments),
      asc(paymentProfileRules.installmentPlan)
    );
}

async function readProfileWithRules(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  profile: typeof paymentProfiles.$inferSelect
) {
  const rules = await listRulesForProfiles(transaction, identity, [profile.id]);
  return { ...profile, rules };
}

export async function listPaymentProfiles(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: PaymentProfileListOptions = {}
) {
  const conditions = [
    eq(paymentProfiles.organizationId, identity.organizationId),
  ];
  switch (options.status ?? "active") {
    case "active":
      conditions.push(isNull(paymentProfiles.archivedAt));
      break;
    case "archived":
      conditions.push(isNotNull(paymentProfiles.archivedAt));
      break;
    case "all":
      break;
    default:
      break;
  }

  const profiles = await transaction
    .select(profileColumns)
    .from(paymentProfiles)
    .where(and(...conditions))
    .orderBy(
      asc(paymentProfiles.name),
      asc(paymentProfiles.createdAt),
      asc(paymentProfiles.id)
    );
  const rules = await listRulesForProfiles(
    transaction,
    identity,
    profiles.map((profile) => profile.id)
  );
  const rulesByProfile = new Map<string, typeof rules>();
  for (const rule of rules) {
    const current = rulesByProfile.get(rule.paymentProfileId) ?? [];
    current.push(rule);
    rulesByProfile.set(rule.paymentProfileId, current);
  }

  return profiles.map((profile) => ({
    ...profile,
    rules: rulesByProfile.get(profile.id) ?? [],
  }));
}

export async function createPaymentProfile(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreatePaymentProfileInput
) {
  const normalized = normalizePaymentProfile(input);
  const [profile] = await transaction
    .insert(paymentProfiles)
    .values({ name: normalized.name, organizationId: identity.organizationId })
    .returning(profileColumns);

  if (!profile) {
    throw new Error("payment_profile_insert_failed");
  }

  const rules = await transaction
    .insert(paymentProfileRules)
    .values(
      normalized.rules.map((rule) =>
        ruleValues(identity.organizationId, profile.id, rule)
      )
    )
    .returning(ruleColumns);

  await recordTenantAuditEvent(transaction, identity, {
    entityId: profile.id,
    entityType: "payment_profile",
    eventType: "payment_profile.created",
    requestId: input.requestId ?? null,
  });

  return { ...profile, rules };
}

export async function updatePaymentProfile(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdatePaymentProfileInput
) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new InvalidPaymentProfileError();
  }
  const normalized = normalizePaymentProfile(input);
  const [existing] = await transaction
    .select(profileColumns)
    .from(paymentProfiles)
    .where(
      and(
        eq(paymentProfiles.id, input.id),
        eq(paymentProfiles.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new PaymentProfileNotFoundError();
  }
  if (existing.archivedAt !== null) {
    throw new PaymentProfileLifecycleError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new PaymentProfileVersionConflictError();
  }

  const activeRules = await transaction
    .select()
    .from(paymentProfileRules)
    .where(
      and(
        eq(paymentProfileRules.organizationId, identity.organizationId),
        eq(paymentProfileRules.paymentProfileId, existing.id),
        isNull(paymentProfileRules.archivedAt)
      )
    );
  const ruleChanges = planRuleChanges(activeRules, normalized.rules);
  const now = new Date();
  const changed =
    normalized.name !== existing.name ||
    ruleChanges.rulesToInsert.length > 0 ||
    ruleChanges.ruleIdsToArchive.length > 0;

  if (!changed) {
    return {
      changed: false,
      profile: await readProfileWithRules(transaction, identity, existing),
    };
  }

  if (ruleChanges.ruleIdsToArchive.length > 0) {
    await transaction
      .update(paymentProfileRules)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(paymentProfileRules.organizationId, identity.organizationId),
          eq(paymentProfileRules.paymentProfileId, existing.id),
          inArray(paymentProfileRules.id, ruleChanges.ruleIdsToArchive),
          isNull(paymentProfileRules.archivedAt)
        )
      );
  }

  if (ruleChanges.rulesToInsert.length > 0) {
    await transaction
      .insert(paymentProfileRules)
      .values(
        ruleChanges.rulesToInsert.map((rule) =>
          ruleValues(identity.organizationId, existing.id, rule)
        )
      );
  }

  const [profile] = await transaction
    .update(paymentProfiles)
    .set({
      name: normalized.name,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(paymentProfiles.id, existing.id),
        eq(paymentProfiles.organizationId, identity.organizationId),
        eq(paymentProfiles.version, input.expectedVersion),
        isNull(paymentProfiles.archivedAt)
      )
    )
    .returning(profileColumns);

  if (!profile) {
    throw new PaymentProfileVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: profile.id,
    entityType: "payment_profile",
    eventType: "payment_profile.updated",
    requestId: input.requestId ?? null,
  });

  return {
    changed: true,
    profile: await readProfileWithRules(transaction, identity, profile),
  };
}

async function changePaymentProfileLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: PaymentProfileMutationInput,
  action: PaymentProfileLifecycleAction
) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new InvalidPaymentProfileError();
  }
  const [existing] = await transaction
    .select(profileColumns)
    .from(paymentProfiles)
    .where(
      and(
        eq(paymentProfiles.id, input.id),
        eq(paymentProfiles.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new PaymentProfileNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new PaymentProfileVersionConflictError();
  }

  const transition = transitionPaymentProfileLifecycle(
    existing.archivedAt,
    action
  );
  if (!transition.changed) {
    return {
      changed: false,
      profile: await readProfileWithRules(transaction, identity, existing),
    };
  }

  const [profile] = await transaction
    .update(paymentProfiles)
    .set({
      archivedAt: transition.archivedAt,
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(paymentProfiles.id, existing.id),
        eq(paymentProfiles.organizationId, identity.organizationId),
        eq(paymentProfiles.version, input.expectedVersion)
      )
    )
    .returning(profileColumns);

  if (!profile) {
    throw new PaymentProfileVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: profile.id,
    entityType: "payment_profile",
    eventType:
      action === "archive"
        ? "payment_profile.archived"
        : "payment_profile.restored",
    requestId: input.requestId ?? null,
  });

  return {
    changed: true,
    profile: await readProfileWithRules(transaction, identity, profile),
  };
}

export async function archivePaymentProfile(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: PaymentProfileMutationInput
) {
  return await changePaymentProfileLifecycle(
    transaction,
    identity,
    input,
    "archive"
  );
}

export async function restorePaymentProfile(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: PaymentProfileMutationInput
) {
  return await changePaymentProfileLifecycle(
    transaction,
    identity,
    input,
    "restore"
  );
}

export function paymentProfileStatus(
  profile: Pick<typeof paymentProfiles.$inferSelect, "archivedAt">
) {
  return derivePaymentProfileLifecycle(profile.archivedAt);
}
