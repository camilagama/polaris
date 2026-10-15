import { randomUUID } from "node:crypto";
import {
  type BillingState,
  grantsPro,
} from "@polaris/domain/billing/entitlements";
import {
  type DefaultCandidate,
  defaultSelection,
  EntitlementVariantLockedError,
  episodeStart,
  OperationalSelectionError,
  type OperationalPhase,
  type OperationalState,
  operationalState,
  planSelectionChange,
} from "@polaris/domain/billing/operational-selection";
import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  getEffectiveEntitlements,
  type OrganizationScope,
} from "./billing-repository";
import { countOrganizationVariants } from "./product-repository";
import {
  operationalVariantSelections,
  organizationBilling,
} from "./schema/billing";
import { productVariants, products } from "./schema/product";
import { saleItems, sales } from "./schema/sale";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * Free Over Limit, where the data is written (plan PR82, ADR 0064). An
 * organization that left Pro holding more variants than Free allows keeps them
 * all, visible and with their history, but only the limit's worth stay
 * operational: the others cannot receive new commercial activity (a sale, a stock
 * receipt). The choice is the organization's, kept in its own table; it is open
 * while a short adaptation window runs and frozen after it, so it can only grow.
 */

const SELECTION_CAPABILITY = "product:update";
/** The most variants one request may name: the largest limit a plan has, with room for a grant. */
const MAX_REQUESTED_VARIANTS = 5000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Stands for "no start recorded": the window is then over, and the choice is keyed by this. */
const UNKNOWN_EPISODE = new Date(0);

/** The request names something that is not a list of variant IDs. */
export class InvalidOperationalSelectionError extends Error {
  readonly code = "invalid_operational_selection";

  constructor() {
    super("invalid_operational_selection");
    this.name = "InvalidOperationalSelectionError";
  }
}

interface Episode {
  /** The database clock for this transaction. */
  now: Date;
  /**
   * The record can restrict at all: it is in an episode of leaving Pro (over the
   * limit, setting up a trial, or a Pro access that lapsed and was not swept yet).
   * Pro in force and a plain Free record never restrict, so the common path is
   * this one query. A plain Free record that holds more than the limit (a grant
   * that expired) is not restricted until the record says so; the grants work
   * (PR85) moves it into an episode.
   */
  restrictable: boolean;
  /** When the free episode began, if the record says. */
  since: Date | null;
}

/** One query on the common path: the billing record and the database clock. */
async function readEpisode(
  transaction: TenantRequestTransaction,
  organizationId: string
): Promise<Episode> {
  const [row] = await transaction
    .select({
      accessEndsAt: organizationBilling.accessEndsAt,
      now: sql<Date>`now()`,
      overLimitSince: organizationBilling.overLimitSince,
      state: organizationBilling.state,
    })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, organizationId));
  if (!row) {
    const clock = await transaction.execute<{ now: Date }>(
      sql`SELECT now() AS now`
    );
    const now = clock.rows[0]?.now;
    if (!now) {
      throw new Error("database_clock_unavailable");
    }
    return { now: new Date(now), restrictable: false, since: null };
  }
  const now = new Date(row.now);
  const state = row.state as BillingState;
  const proInForce =
    grantsPro(state) &&
    row.accessEndsAt !== null &&
    now.getTime() < row.accessEndsAt.getTime();
  return {
    now,
    restrictable: state !== "free" && !proInForce,
    since: episodeStart({
      accessEndsAt: row.accessEndsAt,
      overLimitSince: row.overLimitSince,
      state,
    }),
  };
}

interface Resolved {
  limit: number;
  liveVariants: number;
  state: OperationalState;
}

async function resolve(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  episode: Episode
): Promise<Resolved> {
  const entitlements = await getEffectiveEntitlements(transaction, scope);
  const limit = entitlements.values["variants.active.max"];
  const liveVariants = await countOrganizationVariants(
    transaction,
    scope.organizationId
  );
  return {
    limit,
    liveVariants,
    state: operationalState({
      limit,
      liveVariants,
      now: episode.now,
      plan: entitlements.plan,
      since: episode.since,
    }),
  };
}

/** Serializes the changes of one organization's choice, for the rest of the transaction. */
async function lockSelection(
  transaction: TenantRequestTransaction,
  organizationId: string
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polaris.operational-selection:${organizationId}`}, 0))`
  );
}

interface HeldSelection {
  /** Rows beyond the limit (a grant that raised it has expired): ignored, and dropped on the next change. */
  excess: string[];
  /** The choice in force: at most `limit` variants, the earliest chosen first. */
  kept: Set<string>;
}

async function currentSelection(
  transaction: TenantRequestTransaction,
  organizationId: string,
  episodeKey: Date,
  limit: number
): Promise<HeldSelection> {
  const rows = await transaction
    .select({ variantId: operationalVariantSelections.variantId })
    .from(operationalVariantSelections)
    .where(
      and(
        eq(operationalVariantSelections.organizationId, organizationId),
        eq(operationalVariantSelections.episodeStartedAt, episodeKey)
      )
    )
    .orderBy(
      asc(operationalVariantSelections.selectedAt),
      asc(operationalVariantSelections.variantId)
    );
  const ids = rows.map((row) => row.variantId);
  return {
    excess: ids.slice(Math.max(0, limit)),
    kept: new Set(ids.slice(0, Math.max(0, limit))),
  };
}

/** Rows written together keep their order: one millisecond apart, so the earliest chosen survives a smaller limit. */
function inChosenOrder(count: number): Date[] {
  const base = Date.now();
  return Array.from({ length: count }, (_, index) => new Date(base + index));
}

/** What each live variant sold last, counting only sales confirmed before `before` when given. */
async function readCandidates(
  transaction: TenantRequestTransaction,
  organizationId: string,
  before: Date | null
): Promise<(DefaultCandidate & { productId: string })[]> {
  const rows = await transaction
    .select({
      archived: sql<boolean>`(${products.archivedAt} IS NOT NULL)`,
      createdAt: productVariants.createdAt,
      lastSoldAt: sql<Date | null>`max(${sales.confirmedAt})`,
      productId: productVariants.productId,
      variantId: productVariants.id,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.organizationId, productVariants.organizationId),
        eq(products.id, productVariants.productId),
        isNull(products.deletedAt)
      )
    )
    .leftJoin(
      saleItems,
      and(
        eq(saleItems.organizationId, productVariants.organizationId),
        eq(saleItems.variantId, productVariants.id)
      )
    )
    .leftJoin(
      sales,
      and(
        eq(sales.organizationId, saleItems.organizationId),
        eq(sales.id, saleItems.saleId),
        before ? lt(sales.confirmedAt, before) : undefined
      )
    )
    .where(eq(productVariants.organizationId, organizationId))
    .groupBy(
      productVariants.id,
      productVariants.productId,
      productVariants.createdAt,
      products.archivedAt
    );
  return rows.map((row) => ({
    archived: row.archived,
    createdAt: row.createdAt,
    lastSoldAt: row.lastSoldAt === null ? null : new Date(row.lastSoldAt),
    productId: row.productId,
    variantId: row.variantId,
  }));
}

/**
 * The choice once the window is over. An organization that chose nothing gets the
 * default (what sold most recently up to the end of the window), written once
 * under the lock, so every later read agrees; rows of an earlier episode are
 * dropped.
 */
async function frozenSelection(
  transaction: TenantRequestTransaction,
  organizationId: string,
  episode: Episode,
  state: OperationalState,
  limit: number
): Promise<Set<string>> {
  const key = episode.since ?? UNKNOWN_EPISODE;
  const held = await currentSelection(transaction, organizationId, key, limit);
  if (held.kept.size > 0) {
    return held.kept;
  }
  await lockSelection(transaction, organizationId);
  const again = await currentSelection(transaction, organizationId, key, limit);
  if (again.kept.size > 0) {
    return again.kept;
  }
  await transaction
    .delete(operationalVariantSelections)
    .where(
      and(
        eq(operationalVariantSelections.organizationId, organizationId),
        ne(operationalVariantSelections.episodeStartedAt, key)
      )
    );
  const candidates = await readCandidates(
    transaction,
    organizationId,
    state.windowEndsAt
  );
  const ranked = defaultSelection(candidates, limit);
  const productById = new Map(
    candidates.map((candidate) => [candidate.variantId, candidate.productId])
  );
  const stamps = inChosenOrder(ranked.length);
  if (ranked.length > 0) {
    await transaction.insert(operationalVariantSelections).values(
      ranked.map((variantId, index) => ({
        episodeStartedAt: key,
        organizationId,
        productId: productById.get(variantId) as string,
        selectedAt: stamps[index] as Date,
        source: "default" as const,
        variantId,
      }))
    );
  }
  return new Set(ranked);
}

/**
 * Refuses new commercial activity on a variant the plan no longer keeps
 * operational. Pro, an organization within the limit and one still inside the
 * adaptation window are never refused; after the window only the chosen variants
 * pass. The caller names the variants it is about to sell or receive; undoing
 * activity (a cancellation, a return) and correcting stock never go through here.
 */
export async function assertVariantsOperational(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  variantIds: readonly string[]
): Promise<void> {
  if (variantIds.length === 0) {
    return;
  }
  const episode = await readEpisode(transaction, scope.organizationId);
  if (!episode.restrictable) {
    return;
  }
  const { limit, state } = await resolve(transaction, scope, episode);
  if (state.phase !== "frozen") {
    return;
  }
  const selected = await frozenSelection(
    transaction,
    scope.organizationId,
    episode,
    state,
    limit
  );
  for (const variantId of variantIds) {
    if (!selected.has(variantId)) {
      throw new EntitlementVariantLockedError(variantId);
    }
  }
}

export interface OperationalSelectionReadModel {
  limit: number;
  liveVariants: number;
  phase: OperationalPhase;
  /** The variants chosen: while adapting, what was picked so far (none means the default applies at the end). */
  selectedVariantIds: string[];
  /** The end of the adaptation window; null when nothing is restricted. */
  windowEndsAt: Date | null;
}

async function readModel(
  transaction: TenantRequestTransaction,
  scope: OrganizationScope,
  episode: Episode,
  resolved: Resolved
): Promise<OperationalSelectionReadModel> {
  const key = episode.since ?? UNKNOWN_EPISODE;
  let selected: Set<string>;
  if (resolved.state.phase === "unrestricted") {
    selected = new Set();
  } else if (resolved.state.phase === "frozen") {
    selected = await frozenSelection(
      transaction,
      scope.organizationId,
      episode,
      resolved.state,
      resolved.limit
    );
  } else {
    selected = (
      await currentSelection(
        transaction,
        scope.organizationId,
        key,
        resolved.limit
      )
    ).kept;
  }
  return {
    limit: resolved.limit,
    liveVariants: resolved.liveVariants,
    phase: resolved.state.phase,
    selectedVariantIds: [...selected].sort(),
    windowEndsAt: resolved.state.windowEndsAt,
  };
}

function requireSelectionCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== SELECTION_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

/** Where the organization stands against the Free variant limit, and what it has chosen. */
export async function readOperationalSelection(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<OperationalSelectionReadModel> {
  requireSelectionCapability(identity);
  const episode = await readEpisode(transaction, identity.organizationId);
  const resolved = await resolve(transaction, identity, episode);
  return await readModel(transaction, identity, episode, resolved);
}

export interface SelectOperationalVariantsInput {
  requestId?: string | null;
  /** The complete choice: while adapting it replaces the previous one; once frozen it must keep what is held. */
  variantIds: readonly string[];
}

/**
 * Chooses which variants stay operational (the complete set, not a change).
 * Refused when nothing is restricted, when the choice is larger than the limit,
 * when it names a variant that is not live, and, after the adaptation window,
 * when it leaves out a variant the choice already holds (so a variant cannot be
 * swapped for another to work around the plan).
 */
export async function selectOperationalVariants(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SelectOperationalVariantsInput
): Promise<OperationalSelectionReadModel> {
  requireSelectionCapability(identity);
  if (
    input.variantIds.length > MAX_REQUESTED_VARIANTS ||
    input.variantIds.some((id) => !uuidPattern.test(id))
  ) {
    throw new InvalidOperationalSelectionError();
  }
  const { organizationId } = identity;
  await lockSelection(transaction, organizationId);

  const episode = await readEpisode(transaction, organizationId);
  const resolved = await resolve(transaction, identity, episode);
  const key = episode.since ?? UNKNOWN_EPISODE;
  // the choice of an earlier episode is not this one's
  await transaction
    .delete(operationalVariantSelections)
    .where(
      and(
        eq(operationalVariantSelections.organizationId, organizationId),
        ne(operationalVariantSelections.episodeStartedAt, key)
      )
    );
  // once frozen, "nothing chosen" has already become the default
  const held =
    resolved.state.phase === "frozen"
      ? await frozenSelection(
          transaction,
          organizationId,
          episode,
          resolved.state,
          resolved.limit
        )
      : (
          await currentSelection(
            transaction,
            organizationId,
            key,
            resolved.limit
          )
        ).kept;
  // rows beyond a limit that shrank (an expired grant) are not part of the choice any more
  const { excess } = await currentSelection(
    transaction,
    organizationId,
    key,
    resolved.limit
  );
  if (excess.length > 0) {
    await transaction
      .delete(operationalVariantSelections)
      .where(
        and(
          eq(operationalVariantSelections.organizationId, organizationId),
          inArray(operationalVariantSelections.variantId, excess)
        )
      );
  }

  const wanted = [...new Set(input.variantIds)];
  const relevant = [...new Set([...wanted, ...held])];
  const liveRows =
    relevant.length === 0
      ? []
      : await transaction
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
          })
          .from(productVariants)
          .innerJoin(
            products,
            and(
              eq(products.organizationId, productVariants.organizationId),
              eq(products.id, productVariants.productId),
              isNull(products.deletedAt)
            )
          )
          .where(
            and(
              eq(productVariants.organizationId, organizationId),
              inArray(productVariants.id, relevant)
            )
          );
  const productByVariant = new Map(
    liveRows.map((row) => [row.id, row.productId])
  );

  const change = planSelectionChange({
    current: held,
    limit: resolved.limit,
    live: new Set(productByVariant.keys()),
    phase: resolved.state.phase,
    requested: wanted,
  });
  if (change.remove.length > 0) {
    await transaction
      .delete(operationalVariantSelections)
      .where(
        and(
          eq(operationalVariantSelections.organizationId, organizationId),
          inArray(operationalVariantSelections.variantId, change.remove)
        )
      );
  }
  if (change.add.length > 0) {
    const stamps = inChosenOrder(change.add.length);
    try {
      await transaction.insert(operationalVariantSelections).values(
        change.add.map((variantId, index) => ({
          episodeStartedAt: key,
          organizationId,
          productId: productByVariant.get(variantId) as string,
          selectedAt: stamps[index] as Date,
          source: "user" as const,
          variantId,
        }))
      );
    } catch (error: unknown) {
      // a variant removed between the read and the write (a product reconfigured) is no longer live
      if (error instanceof Error && Reflect.get(error, "code") === "23503") {
        // biome-ignore lint/style/useErrorCause: The refusal is the domain's own, and the cause is a driver error.
        throw new OperationalSelectionError("variant_unavailable");
      }
      throw error;
    }
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: randomUUID(),
    entityType: "operational_selection",
    eventType: "operational_selection.changed",
    requestId: input.requestId ?? null,
  });
  return await readModel(transaction, identity, episode, resolved);
}
