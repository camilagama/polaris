import {
  BILLING_STATES,
  type BillingState,
  type EffectiveEntitlements,
  type EntitlementGrant,
  isEntitlementKey,
  isLimitKey,
  LIMIT_KEYS,
  type LimitKey,
  planCatalogFromRows,
  resolveEntitlements,
} from "../billing/entitlements";

/**
 * What the Admin shows of an organization without any tenant access (plan PR95,
 * ADR 0071): its state, plan, entitlements, usage against the plan, devices, sync
 * health and billing summary. Everything here is a count, a date or a state: no
 * name of a person, no product, customer or sale, no amount, no e-mail. The
 * database returns the raw figures and this module turns them into the report,
 * with the same entitlement engine the product itself uses.
 */

export interface RawGrant {
  expiresAt: string;
  flagValue: boolean | null;
  key: string;
  limitValue: number | null;
  revokedAt: string | null;
  startsAt: string;
}

export interface RawDiagnostics {
  billing: {
    accessEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    cycleMonths: number | null;
    lastFactAt: string | null;
    overLimitSince: string | null;
    pendingCycleMonths: number | null;
    provider: string | null;
    revokedReason: string | null;
    revokedThrough: string | null;
    state: string;
    trialStartedAt: string | null;
    version: number;
  } | null;
  billingEvents: {
    byStatus: Record<string, number>;
    lastReceivedAt: string | null;
    maxAttempts: number;
    oldestUnprocessedAt: string | null;
  };
  grants: RawGrant[];
  now: string;
  offline: {
    activeGrants: number;
    devices: number;
    lastSeenAt: string | null;
  };
  organization: {
    authorizationEpoch: number;
    createdAt: string;
    currency: string;
    id: string;
    members: number;
    name: string;
    status: string;
    timezone: string;
  };
  planCatalog: {
    flagValue: boolean | null;
    key: string;
    limitValue: number | null;
    planId: string;
  }[];
  sync: {
    last7Days: Record<string, number>;
    lastReceivedAt: string | null;
    rejectedByCode: Record<string, number>;
  };
  usage: {
    activeGoals: number;
    archivedProducts: number;
    maxImagesPerProduct: number;
    /** Pictures linked to products that are not deleted: what the plan counts. */
    images: number;
    products: number;
    variants: number;
  };
}

export type QuotaStatus = "at_limit" | "ok" | "over";

export interface QuotaLine {
  key: LimitKey;
  limit: number;
  status: QuotaStatus;
  used: number;
}

export type AttentionCode =
  | "billing_events_failed"
  | "billing_events_stuck"
  | "billing_state_unknown"
  | "grant_ending_soon"
  | "organization_not_active"
  | "over_free_limit"
  | "sync_rejections";

export interface AttentionItem {
  code: AttentionCode;
}

export interface OrganizationDiagnostics {
  attention: AttentionItem[];
  billing: RawDiagnostics["billing"];
  billingEvents: RawDiagnostics["billingEvents"];
  entitlements: {
    accessEndsAt: string | null;
    flags: Record<string, boolean>;
    overLimit: boolean;
    plan: string;
    raisedByGrant: string[];
    state: string;
  };
  grants: RawGrant[];
  offline: RawDiagnostics["offline"];
  organization: RawDiagnostics["organization"];
  quotas: QuotaLine[];
  sync: RawDiagnostics["sync"];
  usage: RawDiagnostics["usage"];
}

const HOUR_MS = 3_600_000;
const GRANT_WARNING_MS = 7 * 24 * HOUR_MS;

const usageByLimit: Readonly<
  Record<LimitKey, (usage: RawDiagnostics["usage"]) => number>
> = {
  "goals.active.max": (usage) => usage.activeGoals,
  "images.active.max": (usage) => usage.images,
  "images.per_product.max": (usage) => usage.maxImagesPerProduct,
  "variants.active.max": (usage) => usage.variants,
};

function countOf(counts: Record<string, number>, key: string): number {
  return counts[key] ?? 0;
}

function quotaStatus(used: number, limit: number): QuotaStatus {
  if (used > limit) {
    return "over";
  }
  return used === limit ? "at_limit" : "ok";
}

function grantsInForce(grants: readonly RawGrant[]): EntitlementGrant[] {
  const result: EntitlementGrant[] = [];
  for (const grant of grants) {
    // one revoked before it started was never in force (the same rule as the product's)
    if (
      grant.revokedAt !== null &&
      new Date(grant.revokedAt).getTime() <= new Date(grant.startsAt).getTime()
    ) {
      continue;
    }
    if (!isEntitlementKey(grant.key)) {
      continue;
    }
    const value = isLimitKey(grant.key) ? grant.limitValue : grant.flagValue;
    if (value !== null) {
      result.push({
        expiresAt: new Date(grant.expiresAt),
        key: grant.key,
        startsAt: new Date(grant.startsAt),
        value,
      });
    }
  }
  return result;
}

function entitlementsOf(raw: RawDiagnostics): EffectiveEntitlements {
  const state: BillingState = (BILLING_STATES as readonly string[]).includes(
    raw.billing?.state ?? "free"
  )
    ? ((raw.billing?.state ?? "free") as BillingState)
    : "free";
  return resolveEntitlements({
    catalog: planCatalogFromRows(raw.planCatalog),
    facts: {
      accessEndsAt: raw.billing?.accessEndsAt
        ? new Date(raw.billing.accessEndsAt)
        : null,
      state,
    },
    grants: grantsInForce(raw.grants),
    now: new Date(raw.now),
  });
}

function attentionOf(
  raw: RawDiagnostics,
  entitlements: EffectiveEntitlements
): AttentionItem[] {
  const now = new Date(raw.now).getTime();
  const items: AttentionItem[] = [];
  if (raw.organization.status !== "active") {
    items.push({ code: "organization_not_active" });
  }
  if (
    raw.billing !== null &&
    !(BILLING_STATES as readonly string[]).includes(raw.billing.state)
  ) {
    items.push({ code: "billing_state_unknown" });
  }
  if (entitlements.overLimit) {
    items.push({ code: "over_free_limit" });
  }
  if (countOf(raw.billingEvents.byStatus, "failed") > 0) {
    items.push({ code: "billing_events_failed" });
  }
  const stuckSince = raw.billingEvents.oldestUnprocessedAt;
  if (stuckSince !== null && now - new Date(stuckSince).getTime() > HOUR_MS) {
    items.push({ code: "billing_events_stuck" });
  }
  if (countOf(raw.sync.last7Days, "rejected") > 0) {
    items.push({ code: "sync_rejections" });
  }
  const endingSoon = raw.grants.some((grant) => {
    const ends = new Date(grant.expiresAt).getTime();
    return (
      grant.revokedAt === null && ends > now && ends - now < GRANT_WARNING_MS
    );
  });
  if (endingSoon) {
    items.push({ code: "grant_ending_soon" });
  }
  return items;
}

/** The report for one organization from the raw figures the database returned. */
export function buildOrganizationDiagnostics(
  raw: RawDiagnostics
): OrganizationDiagnostics {
  const entitlements = entitlementsOf(raw);
  const quotas = LIMIT_KEYS.map((key): QuotaLine => {
    const limit = entitlements.values[key];
    const used = usageByLimit[key](raw.usage);
    return { key, limit, status: quotaStatus(used, limit), used };
  });
  return {
    attention: attentionOf(raw, entitlements),
    billing: raw.billing,
    billingEvents: raw.billingEvents,
    entitlements: {
      accessEndsAt: entitlements.accessEndsAt?.toISOString() ?? null,
      flags: {
        "offline.write": entitlements.values["offline.write"],
        public_catalog: entitlements.values.public_catalog,
      },
      overLimit: entitlements.overLimit,
      plan: entitlements.plan,
      raisedByGrant: [...entitlements.raisedByGrant],
      state: entitlements.state,
    },
    grants: raw.grants,
    offline: raw.offline,
    organization: raw.organization,
    quotas,
    sync: raw.sync,
    usage: raw.usage,
  };
}
