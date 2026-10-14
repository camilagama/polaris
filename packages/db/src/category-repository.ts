import { randomUUID } from "node:crypto";
import { normalizeCategoryName } from "@polaris/domain/catalog/category";
import { asc, eq } from "drizzle-orm";
import { categories } from "./schema/category";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export interface CreateCategoryInput {
  name: string;
  requestId?: string | null;
}

export async function listCategories(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
) {
  return await transaction
    .select({
      id: categories.id,
      name: categories.name,
      organizationId: categories.organizationId,
    })
    .from(categories)
    .where(eq(categories.organizationId, identity.organizationId))
    .orderBy(asc(categories.name), asc(categories.id));
}

export async function createCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateCategoryInput
) {
  const id = randomUUID();
  const name = normalizeCategoryName(input.name);
  const [category] = await transaction
    .insert(categories)
    .values({
      id,
      name,
      organizationId: identity.organizationId,
    })
    .returning({
      id: categories.id,
      name: categories.name,
      organizationId: categories.organizationId,
    });

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
