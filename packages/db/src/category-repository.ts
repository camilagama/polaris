import { randomUUID } from "node:crypto";
import { normalizeCategoryName } from "@polaris/domain/catalog/category";
import {
  CategoryDeletedError,
  CategoryInUseError,
  CategoryNameConflictError,
  CategoryNotFoundError,
  deriveCategoryLifecycle,
  transitionCategoryLifecycle,
  type CategoryLifecycleAction,
} from "@polaris/domain/catalog/category";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { categories } from "./schema/category";
import { products } from "./schema/product";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export interface CategoryListOptions {
  status?: "active" | "archived" | "deleted" | "all";
}

export interface CategoryMutationInput {
  id: string;
  requestId?: string | null;
}

export interface CreateCategoryInput {
  name: string;
  requestId?: string | null;
}

export interface RenameCategoryInput extends CategoryMutationInput {
  name: string;
}

const categoryColumns = {
  archivedAt: categories.archivedAt,
  createdAt: categories.createdAt,
  deletedAt: categories.deletedAt,
  id: categories.id,
  name: categories.name,
  organizationId: categories.organizationId,
  updatedAt: categories.updatedAt,
};

const categoryAuditEvent = {
  archive: "category.archived",
  delete: "category.deleted",
  restore: "category.restored",
} as const satisfies Record<CategoryLifecycleAction, string>;

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (typeof candidate.code === "string") {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function sqlConstraint(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; constraint?: unknown };
    if (typeof candidate.constraint === "string") {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return undefined;
}

export async function listCategories(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: CategoryListOptions = {}
) {
  const conditions = [eq(categories.organizationId, identity.organizationId)];
  switch (options.status ?? "active") {
    case "active":
      conditions.push(
        isNull(categories.archivedAt),
        isNull(categories.deletedAt)
      );
      break;
    case "archived":
      conditions.push(
        isNotNull(categories.archivedAt),
        isNull(categories.deletedAt)
      );
      break;
    case "deleted":
      conditions.push(isNotNull(categories.deletedAt));
      break;
    case "all":
      break;
    default:
      break;
  }

  return await transaction
    .select(categoryColumns)
    .from(categories)
    .where(and(...conditions))
    .orderBy(asc(categories.name), asc(categories.id));
}

export async function createCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateCategoryInput
) {
  const id = randomUUID();
  const name = normalizeCategoryName(input.name);
  let category: typeof categories.$inferSelect | undefined;

  try {
    [category] = await transaction
      .insert(categories)
      .values({
        id,
        name,
        organizationId: identity.organizationId,
      })
      .returning();
  } catch (error) {
    if (sqlState(error) === "23505") {
      // biome-ignore lint/style/useErrorCause: CategoryNameConflictError forwards this cause to Error.
      throw new CategoryNameConflictError({ cause: error });
    }
    throw error;
  }

  if (!category) {
    throw new Error("category_insert_failed");
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: id,
    entityType: "category",
    eventType: "category.created",
    requestId: input.requestId ?? null,
  });

  return category;
}

export async function renameCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RenameCategoryInput
) {
  const [existing] = await transaction
    .select(categoryColumns)
    .from(categories)
    .where(
      and(
        eq(categories.id, input.id),
        eq(categories.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new CategoryNotFoundError();
  }
  if (existing.deletedAt !== null) {
    throw new CategoryDeletedError();
  }

  const name = normalizeCategoryName(input.name);
  if (name === existing.name) {
    return { category: existing, changed: false };
  }

  let category: typeof categories.$inferSelect | undefined;
  try {
    [category] = await transaction
      .update(categories)
      .set({ name, updatedAt: new Date() })
      .where(
        and(
          eq(categories.id, input.id),
          eq(categories.organizationId, identity.organizationId)
        )
      )
      .returning();
  } catch (error) {
    if (sqlState(error) === "23505") {
      // biome-ignore lint/style/useErrorCause: CategoryNameConflictError forwards this cause to Error.
      throw new CategoryNameConflictError({ cause: error });
    }
    throw error;
  }

  if (!category) {
    throw new CategoryNotFoundError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: category.id,
    entityType: "category",
    eventType: "category.renamed",
    requestId: input.requestId ?? null,
  });

  return { category, changed: true };
}

async function changeCategoryLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CategoryMutationInput,
  action: CategoryLifecycleAction
) {
  const [existing] = await transaction
    .select(categoryColumns)
    .from(categories)
    .where(
      and(
        eq(categories.id, input.id),
        eq(categories.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!existing) {
    throw new CategoryNotFoundError();
  }

  const currentLifecycle = deriveCategoryLifecycle(
    existing.archivedAt,
    existing.deletedAt
  );
  const transition = transitionCategoryLifecycle(currentLifecycle, action);
  if (!transition.changed) {
    return { category: existing, changed: false };
  }

  if (action === "delete") {
    const [dependentProduct] = await transaction
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.categoryId, input.id),
          eq(products.organizationId, identity.organizationId)
        )
      )
      .limit(1);
    if (dependentProduct) {
      throw new CategoryInUseError();
    }
  }

  const { archivedAt: currentArchivedAt, deletedAt: currentDeletedAt } =
    existing;
  let archivedAt = currentArchivedAt;
  if (transition.lifecycle === "archived") {
    archivedAt ??= new Date();
  } else if (transition.lifecycle === "active") {
    archivedAt = null;
  }
  const deletedAt =
    transition.lifecycle === "deleted"
      ? (currentDeletedAt ?? new Date())
      : currentDeletedAt;

  let category: typeof categories.$inferSelect | undefined;
  try {
    [category] = await transaction
      .update(categories)
      .set({ archivedAt, deletedAt, updatedAt: new Date() })
      .where(
        and(
          eq(categories.id, input.id),
          eq(categories.organizationId, identity.organizationId)
        )
      )
      .returning(categoryColumns);
  } catch (error) {
    if (
      sqlState(error) === "23503" &&
      sqlConstraint(error) === "categories_products_tombstone_guard"
    ) {
      // biome-ignore lint/style/useErrorCause: CategoryInUseError forwards this cause to Error.
      throw new CategoryInUseError({ cause: error });
    }
    throw error;
  }

  if (!category) {
    throw new CategoryNotFoundError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: category.id,
    entityType: "category",
    eventType: categoryAuditEvent[action],
    requestId: input.requestId ?? null,
  });

  return { category, changed: true };
}

export async function archiveCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CategoryMutationInput
) {
  return await changeCategoryLifecycle(transaction, identity, input, "archive");
}

export async function restoreCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CategoryMutationInput
) {
  return await changeCategoryLifecycle(transaction, identity, input, "restore");
}

export async function deleteCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CategoryMutationInput
) {
  return await changeCategoryLifecycle(transaction, identity, input, "delete");
}
