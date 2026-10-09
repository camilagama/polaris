import {
  deriveProductLifecycle,
  normalizeProductDescription,
  normalizeProductName,
  ProductCategoryUnavailableError,
  ProductNotFoundError,
  ProductVersionConflictError,
  transitionProductLifecycle,
  type ProductLifecycleAction,
} from "@polaris/domain/catalog/product";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { categories } from "./schema/category";
import { productVariants, products } from "./schema/product";

export interface ProductListOptions {
  status?: "active" | "archived" | "all";
}

export interface ProductMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface CreateProductInput {
  categoryId?: string | null;
  description?: string | null;
  name: string;
  requestId?: string | null;
}

export interface UpdateProductInput extends ProductMutationInput {
  categoryId: string | null;
  description: string | null;
  name: string;
}

const productColumns = {
  archivedAt: products.archivedAt,
  categoryId: products.categoryId,
  createdAt: products.createdAt,
  description: products.description,
  id: products.id,
  name: products.name,
  organizationId: products.organizationId,
  updatedAt: products.updatedAt,
  version: products.version,
};

function isUnavailableCategoryConstraint(error: unknown): boolean {
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
      candidate.code === "23503" &&
      candidate.constraint === "products_active_category_guard"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function requireActiveCategory(
  transaction: TenantRequestTransaction,
  organizationId: string,
  categoryId: string
): Promise<void> {
  const [category] = await transaction
    .select({
      archivedAt: categories.archivedAt,
      deletedAt: categories.deletedAt,
      id: categories.id,
    })
    .from(categories)
    .where(
      and(
        eq(categories.id, categoryId),
        eq(categories.organizationId, organizationId)
      )
    )
    .for("update");

  if (!category || category.archivedAt || category.deletedAt) {
    throw new ProductCategoryUnavailableError();
  }
}

export async function listProducts(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: ProductListOptions = {}
) {
  const conditions = [eq(products.organizationId, identity.organizationId)];
  switch (options.status ?? "active") {
    case "active":
      conditions.push(isNull(products.archivedAt));
      break;
    case "archived":
      conditions.push(isNotNull(products.archivedAt));
      break;
    case "all":
      break;
    default:
      break;
  }

  return await transaction
    .select(productColumns)
    .from(products)
    .where(and(...conditions))
    .orderBy(asc(products.name), asc(products.id));
}

export async function createProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductInput
) {
  const name = normalizeProductName(input.name);
  const description = normalizeProductDescription(input.description);
  const categoryId = input.categoryId ?? null;
  if (categoryId) {
    await requireActiveCategory(
      transaction,
      identity.organizationId,
      categoryId
    );
  }

  let product: typeof products.$inferSelect | undefined;
  try {
    [product] = await transaction
      .insert(products)
      .values({
        categoryId,
        description,
        name,
        organizationId: identity.organizationId,
      })
      .returning(productColumns);
  } catch (error) {
    if (isUnavailableCategoryConstraint(error)) {
      // biome-ignore lint/style/useErrorCause: ProductCategoryUnavailableError forwards this cause to Error.
      throw new ProductCategoryUnavailableError({ cause: error });
    }
    throw error;
  }

  if (!product) {
    throw new Error("product_insert_failed");
  }

  await transaction.insert(productVariants).values({
    isDefault: true,
    organizationId: identity.organizationId,
    productId: product.id,
  });

  await recordTenantAuditEvent(transaction, identity, {
    entityId: product.id,
    entityType: "product",
    eventType: "product.created",
    requestId: input.requestId ?? null,
  });

  return product;
}

export async function updateProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdateProductInput
) {
  const [existing] = await transaction
    .select(productColumns)
    .from(products)
    .where(
      and(
        eq(products.id, input.id),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new ProductNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  const name = normalizeProductName(input.name);
  const description = normalizeProductDescription(input.description);
  if (input.categoryId !== existing.categoryId && input.categoryId) {
    await requireActiveCategory(
      transaction,
      identity.organizationId,
      input.categoryId
    );
  }
  const changed =
    name !== existing.name ||
    description !== existing.description ||
    input.categoryId !== existing.categoryId;
  if (!changed) {
    return { changed: false, product: existing };
  }

  let product: typeof products.$inferSelect | undefined;
  try {
    [product] = await transaction
      .update(products)
      .set({
        categoryId: input.categoryId,
        description,
        name,
        updatedAt: new Date(),
        version: sql`${products.version} + 1`,
      })
      .where(
        and(
          eq(products.id, input.id),
          eq(products.organizationId, identity.organizationId),
          eq(products.version, input.expectedVersion)
        )
      )
      .returning(productColumns);
  } catch (error) {
    if (isUnavailableCategoryConstraint(error)) {
      // biome-ignore lint/style/useErrorCause: ProductCategoryUnavailableError forwards this cause to Error.
      throw new ProductCategoryUnavailableError({ cause: error });
    }
    throw error;
  }

  if (!product) {
    throw new ProductVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: product.id,
    entityType: "product",
    eventType: "product.updated",
    requestId: input.requestId ?? null,
  });

  return { changed: true, product };
}

async function changeProductLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ProductMutationInput,
  action: ProductLifecycleAction
) {
  const [existing] = await transaction
    .select(productColumns)
    .from(products)
    .where(
      and(
        eq(products.id, input.id),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new ProductNotFoundError();
  }

  const transition = transitionProductLifecycle(
    deriveProductLifecycle(existing.archivedAt),
    action
  );
  if (!transition.changed) {
    return { changed: false, product: existing };
  }
  if (existing.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  const archivedAt =
    transition.lifecycle === "archived"
      ? (existing.archivedAt ?? new Date())
      : null;
  const [product] = await transaction
    .update(products)
    .set({
      archivedAt,
      updatedAt: new Date(),
      version: sql`${products.version} + 1`,
    })
    .where(
      and(
        eq(products.id, input.id),
        eq(products.organizationId, identity.organizationId),
        eq(products.version, input.expectedVersion)
      )
    )
    .returning(productColumns);

  if (!product) {
    throw new ProductVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: product.id,
    entityType: "product",
    eventType: action === "archive" ? "product.archived" : "product.restored",
    requestId: input.requestId ?? null,
  });

  return { changed: true, product };
}

export async function archiveProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ProductMutationInput
) {
  return await changeProductLifecycle(transaction, identity, input, "archive");
}

export async function restoreProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ProductMutationInput
) {
  return await changeProductLifecycle(transaction, identity, input, "restore");
}
