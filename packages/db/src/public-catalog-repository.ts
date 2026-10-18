import { randomUUID } from "node:crypto";
import { assertFlag } from "@polaris/domain/billing/entitlements";
import {
  normalizePublicProfile,
  PublicCatalogProductUnavailableError,
  PublicCatalogProfileMissingError,
  PublicCatalogSlugTakenError,
  PublicCatalogVersionConflictError,
  type PublicProfileInput,
} from "@polaris/domain/catalog/public-catalog";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getEffectiveEntitlements } from "./billing-repository";
import { products } from "./schema/product";
import {
  productPublications,
  publicCatalogProfiles,
} from "./schema/public-catalog";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * The organization's side of the public catalog (plan PR87 and PR88, ADR 0069):
 * its profile, its switch, and which products it shows. The public never reads
 * these tables; it reads four functions that look at the plan on every call, so
 * what is written here only counts while the plan in force includes the public
 * catalog. Writing that makes something public needs the plan to include it;
 * turning something off never does.
 */

const CAPABILITY = "catalog:publish";
/** One call names at most this many products. */
const MAX_PRODUCTS_PER_CALL = 200;
const UNIQUE_VIOLATION = "23505";
const SLUG_UNIQUE_INDEX = "public_catalog_profiles_slug_unique";
const PROFILE_PRIMARY_KEY = "public_catalog_profiles_pkey";

function requireCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

const profileColumns = {
  createdAt: publicCatalogProfiles.createdAt,
  description: publicCatalogProfiles.description,
  instagram: publicCatalogProfiles.instagram,
  organizationId: publicCatalogProfiles.organizationId,
  publicName: publicCatalogProfiles.publicName,
  published: publicCatalogProfiles.published,
  publishedAt: publicCatalogProfiles.publishedAt,
  slug: publicCatalogProfiles.slug,
  updatedAt: publicCatalogProfiles.updatedAt,
  version: publicCatalogProfiles.version,
  whatsapp: publicCatalogProfiles.whatsapp,
};

export type PublicCatalogProfileRow =
  Awaited<ReturnType<typeof readProfile>> extends infer Row
    ? NonNullable<Row>
    : never;

async function readProfile(
  transaction: TenantRequestTransaction,
  organizationId: string,
  lock = true
) {
  const query = transaction
    .select(profileColumns)
    .from(publicCatalogProfiles)
    .where(eq(publicCatalogProfiles.organizationId, organizationId))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

async function requirePlan(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<void> {
  assertFlag(
    await getEffectiveEntitlements(transaction, identity),
    "public_catalog"
  );
}

/** The driver's unique violation on this constraint (the error may be wrapped: it is somewhere down the cause chain). */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === UNIQUE_VIOLATION &&
      candidate.constraint === constraint
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export interface PublicCatalogSetup {
  /** The plan in force includes the public catalog right now. */
  enabled: boolean;
  profile: PublicCatalogProfileRow | null;
  /** The products chosen to be shown (whether or not the plan, or the product's own state, lets them be shown now). */
  publishedProductIds: string[];
}

export async function readPublicCatalogSetup(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<PublicCatalogSetup> {
  requireCapability(identity);
  const entitlements = await getEffectiveEntitlements(transaction, identity);
  const profile = await readProfile(
    transaction,
    identity.organizationId,
    false
  );
  const rows = await transaction
    .select({ productId: productPublications.productId })
    .from(productPublications)
    .where(
      and(
        eq(productPublications.organizationId, identity.organizationId),
        isNull(productPublications.unpublishedAt)
      )
    )
    .orderBy(asc(productPublications.productId));
  return {
    enabled: entitlements.values.public_catalog,
    profile,
    publishedProductIds: rows.map((row) => row.productId),
  };
}

export interface SavePublicCatalogProfileInput extends PublicProfileInput {
  /** The version being edited; absent when creating the profile. */
  expectedVersion?: number | undefined;
  requestId?: string | null;
}

/**
 * Creates or edits the public profile. Needs the plan to include the public
 * catalog (so an address is not reserved by an organization that cannot use it).
 * An edit names the version it started from; the address is unique across every
 * organization.
 */
export async function savePublicCatalogProfile(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SavePublicCatalogProfileInput
): Promise<PublicCatalogProfileRow> {
  requireCapability(identity);
  const profile = normalizePublicProfile(input);
  await requirePlan(transaction, identity);
  const existing = await readProfile(transaction, identity.organizationId);
  if (existing && existing.version !== input.expectedVersion) {
    throw new PublicCatalogVersionConflictError();
  }
  if (!existing && input.expectedVersion !== undefined) {
    throw new PublicCatalogVersionConflictError();
  }
  try {
    // the savepoint keeps a taken address from aborting the caller's transaction
    const saved = await transaction.transaction(async (savepoint) => {
      if (!existing) {
        const [created] = await savepoint
          .insert(publicCatalogProfiles)
          .values({
            description: profile.description,
            instagram: profile.instagram,
            organizationId: identity.organizationId,
            publicName: profile.publicName,
            slug: profile.slug,
            whatsapp: profile.whatsapp,
          })
          .returning(profileColumns);
        return created;
      }
      const [updated] = await savepoint
        .update(publicCatalogProfiles)
        .set({
          description: profile.description,
          instagram: profile.instagram,
          publicName: profile.publicName,
          slug: profile.slug,
          updatedAt: sql`now()`,
          version: existing.version + 1,
          whatsapp: profile.whatsapp,
        })
        .where(
          and(
            eq(publicCatalogProfiles.organizationId, identity.organizationId),
            eq(publicCatalogProfiles.version, existing.version)
          )
        )
        .returning(profileColumns);
      return updated;
    });
    if (!saved) {
      throw new PublicCatalogVersionConflictError();
    }
    await recordTenantAuditEvent(transaction, identity, {
      entityId: randomUUID(),
      entityType: "public_catalog",
      eventType: existing
        ? "public_catalog.profile_updated"
        : "public_catalog.profile_created",
      requestId: input.requestId ?? null,
    });
    return saved;
  } catch (error: unknown) {
    if (isUniqueViolationOn(error, SLUG_UNIQUE_INDEX)) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own, and the cause is a driver error.
      throw new PublicCatalogSlugTakenError();
    }
    if (isUniqueViolationOn(error, PROFILE_PRIMARY_KEY)) {
      // another save created the profile first: this one started from a state that no longer exists
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own, and the cause is a driver error.
      throw new PublicCatalogVersionConflictError();
    }
    throw error;
  }
}

export interface SetPublicCatalogPublishedInput {
  expectedVersion: number;
  published: boolean;
  requestId?: string | null;
}

/**
 * The organization's own switch. Turning it on needs the plan to include the
 * public catalog and a profile to show; turning it off is always allowed.
 */
export async function setPublicCatalogPublished(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SetPublicCatalogPublishedInput
): Promise<PublicCatalogProfileRow> {
  requireCapability(identity);
  const existing = await readProfile(transaction, identity.organizationId);
  if (!existing) {
    throw new PublicCatalogProfileMissingError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new PublicCatalogVersionConflictError();
  }
  if (input.published) {
    await requirePlan(transaction, identity);
  }
  if (existing.published === input.published) {
    return existing;
  }
  const [updated] = await transaction
    .update(publicCatalogProfiles)
    .set({
      published: input.published,
      publishedAt: input.published ? sql`now()` : existing.publishedAt,
      updatedAt: sql`now()`,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(publicCatalogProfiles.organizationId, identity.organizationId),
        eq(publicCatalogProfiles.version, existing.version)
      )
    )
    .returning(profileColumns);
  if (!updated) {
    throw new PublicCatalogVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: randomUUID(),
    entityType: "public_catalog",
    eventType: input.published
      ? "public_catalog.published"
      : "public_catalog.unpublished",
    requestId: input.requestId ?? null,
  });
  return updated;
}

export interface PublicationInput {
  productIds: readonly string[];
  requestId?: string | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function distinctIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (
    unique.length === 0 ||
    unique.length > MAX_PRODUCTS_PER_CALL ||
    !unique.every((id) => uuidPattern.test(id))
  ) {
    throw new PublicCatalogProductUnavailableError();
  }
  return unique;
}

/**
 * Chooses products to show. Needs the plan to include the public catalog, and
 * every product must exist in the organization and be neither archived nor
 * deleted. Choosing one again after it was taken down shows it again.
 */
export async function publishProducts(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: PublicationInput
): Promise<{ published: number }> {
  requireCapability(identity);
  const ids = distinctIds(input.productIds);
  await requirePlan(transaction, identity);
  const live = await transaction
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.organizationId, identity.organizationId),
        inArray(products.id, ids),
        isNull(products.archivedAt),
        isNull(products.deletedAt)
      )
    );
  if (live.length !== ids.length) {
    throw new PublicCatalogProductUnavailableError();
  }
  const changed = await transaction
    .insert(productPublications)
    .values(
      ids.map((productId) => ({
        organizationId: identity.organizationId,
        productId,
        publishedBy: identity.userId,
      }))
    )
    .onConflictDoUpdate({
      set: {
        publishedAt: sql`now()`,
        publishedBy: identity.userId,
        unpublishedAt: null,
      },
      // a product that is already shown keeps the moment it was first shown
      setWhere: sql`${productPublications.unpublishedAt} IS NOT NULL`,
      target: [
        productPublications.organizationId,
        productPublications.productId,
      ],
    })
    .returning({ productId: productPublications.productId });
  for (const { productId } of changed) {
    // biome-ignore lint/performance/noAwaitInLoops: Audit rows are appended in order inside one transaction.
    await recordTenantAuditEvent(transaction, identity, {
      entityId: productId,
      entityType: "product",
      eventType: "product.published_to_catalog",
      requestId: input.requestId ?? null,
    });
  }
  return { published: changed.length };
}

/** Takes products out of the public catalog. Always allowed; one that is not shown is left as it is (and records nothing). */
export async function unpublishProducts(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: PublicationInput
): Promise<{ unpublished: number }> {
  requireCapability(identity);
  const ids = distinctIds(input.productIds);
  const taken = await transaction
    .update(productPublications)
    .set({
      unpublishedAt: sql`GREATEST(now(), ${productPublications.publishedAt})`,
    })
    .where(
      and(
        eq(productPublications.organizationId, identity.organizationId),
        inArray(productPublications.productId, ids),
        isNull(productPublications.unpublishedAt)
      )
    )
    .returning({ productId: productPublications.productId });
  for (const { productId } of taken) {
    // biome-ignore lint/performance/noAwaitInLoops: Audit rows are appended in order inside one transaction.
    await recordTenantAuditEvent(transaction, identity, {
      entityId: productId,
      entityType: "product",
      eventType: "product.unpublished_from_catalog",
      requestId: input.requestId ?? null,
    });
  }
  return { unpublished: taken.length };
}
