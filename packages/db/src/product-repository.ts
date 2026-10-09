import {
  ProductDefaultVariantSkuConflictError,
  ProductDefaultVariantStockHistoryConflictError,
  deriveProductLifecycle,
  normalizeProductDescription,
  normalizeProductName,
  ProductCategoryUnavailableError,
  ProductNotFoundError,
  ProductVariantConfigurationError,
  ProductVariantNotFoundError,
  ProductVariantSkuConflictError,
  ProductVariantsAlreadyConfiguredError,
  ProductVersionConflictError,
  PRODUCT_VARIANT_OPTION_NAMES,
  normalizeProductVariantSku,
  normalizeProductVariantConfiguration,
  transitionProductLifecycle,
  type ProductLifecycleAction,
  type ProductVariantConfigurationInput,
  type ProductVariantOptionName,
} from "@polaris/domain/catalog/product";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { categories } from "./schema/category";
import { productVariants, products } from "./schema/product";
import {
  productOptionValues,
  productOptions,
  variantOptionValues,
} from "./schema/product-variants";
import { stockMovements } from "./schema/inventory";

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

export interface ConfigureProductVariantsInput
  extends ProductMutationInput,
    ProductVariantConfigurationInput {}

export interface SetProductVariantSkuInput extends ProductMutationInput {
  sku: string | null;
  variantId: string;
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
  variantsConfiguredAt: products.variantsConfiguredAt,
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

function isProductVariantSkuConflict(error: unknown): boolean {
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
      candidate.code === "23505" &&
      candidate.constraint === "product_variants_organization_sku_unique"
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

function productVariantOptionName(value: string): ProductVariantOptionName {
  if (value === "model" || value === "color" || value === "size") {
    return value;
  }
  throw new ProductVariantConfigurationError();
}

export async function getProductVariants(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  productId: string
) {
  const [product] = await transaction
    .select({
      variantsConfiguredAt: products.variantsConfiguredAt,
      version: products.version,
    })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("share");

  if (!product) {
    throw new ProductNotFoundError();
  }

  const optionRows = await transaction
    .select({
      id: productOptions.id,
      name: productOptions.name,
      position: productOptions.position,
    })
    .from(productOptions)
    .where(
      and(
        eq(productOptions.organizationId, identity.organizationId),
        eq(productOptions.productId, productId)
      )
    )
    .orderBy(asc(productOptions.position), asc(productOptions.id));

  const optionValueRows = await transaction
    .select({
      id: productOptionValues.id,
      name: productOptionValues.name,
      optionId: productOptionValues.optionId,
      position: productOptionValues.position,
    })
    .from(productOptionValues)
    .where(
      and(
        eq(productOptionValues.organizationId, identity.organizationId),
        eq(productOptionValues.productId, productId)
      )
    )
    .orderBy(
      asc(productOptionValues.optionId),
      asc(productOptionValues.position),
      asc(productOptionValues.id)
    );

  const variantRows = await transaction
    .select({
      id: productVariants.id,
      isDefault: productVariants.isDefault,
      position: productVariants.position,
      sku: productVariants.sku,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, productId)
      )
    )
    .orderBy(asc(productVariants.position), asc(productVariants.id));

  const optionValueRowsForVariants = await transaction
    .select({
      optionId: variantOptionValues.optionId,
      optionValueId: variantOptionValues.optionValueId,
      variantId: variantOptionValues.variantId,
    })
    .from(variantOptionValues)
    .where(
      and(
        eq(variantOptionValues.organizationId, identity.organizationId),
        eq(variantOptionValues.productId, productId)
      )
    );

  const optionsById = new Map(optionRows.map((option) => [option.id, option]));
  const valuesById = new Map(
    optionValueRows.map((optionValue) => [optionValue.id, optionValue])
  );
  const valuesByOptionId = new Map<string, typeof optionValueRows>();
  for (const optionValue of optionValueRows) {
    const values = valuesByOptionId.get(optionValue.optionId) ?? [];
    values.push(optionValue);
    valuesByOptionId.set(optionValue.optionId, values);
  }

  const assignmentsByVariantId = new Map<
    string,
    Array<{
      optionName: ProductVariantOptionName;
      optionPosition: number;
      optionValueId: string;
      optionValueName: string;
    }>
  >();
  for (const assignment of optionValueRowsForVariants) {
    const option = optionsById.get(assignment.optionId);
    const optionValue = valuesById.get(assignment.optionValueId);
    if (!(option && optionValue)) {
      throw new Error("product_variant_configuration_integrity_failed");
    }
    const assignments = assignmentsByVariantId.get(assignment.variantId) ?? [];
    assignments.push({
      optionName: productVariantOptionName(option.name),
      optionPosition: option.position,
      optionValueId: optionValue.id,
      optionValueName: optionValue.name,
    });
    assignmentsByVariantId.set(assignment.variantId, assignments);
  }

  return {
    configured: product.variantsConfiguredAt !== null,
    options: optionRows.map((option) => ({
      id: option.id,
      name: productVariantOptionName(option.name),
      position: option.position,
      values: (valuesByOptionId.get(option.id) ?? []).map((value) => ({
        id: value.id,
        name: value.name,
        position: value.position,
      })),
    })),
    productVersion: product.version,
    variants: variantRows.map((variant) => ({
      id: variant.id,
      isDefault: variant.isDefault,
      position: variant.position,
      sku: variant.sku,
      values: (assignmentsByVariantId.get(variant.id) ?? [])
        .sort((left, right) => left.optionPosition - right.optionPosition)
        .map(
          ({ optionPosition: _optionPosition, ...assignment }) => assignment
        ),
    })),
  };
}

export async function setProductVariantSku(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SetProductVariantSkuInput
) {
  const sku = normalizeProductVariantSku(input.sku);
  const [product] = await transaction
    .select(productColumns)
    .from(products)
    .where(
      and(
        eq(products.id, input.id),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .for("update");

  if (!product) {
    throw new ProductNotFoundError();
  }
  if (product.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  const [variant] = await transaction
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, input.variantId),
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, input.id)
      )
    )
    .limit(1);

  if (!variant) {
    throw new ProductVariantNotFoundError();
  }
  if (variant.sku === sku) {
    return {
      changed: false,
      configuration: await getProductVariants(transaction, identity, input.id),
      product,
    };
  }

  try {
    const [updatedVariant] = await transaction
      .update(productVariants)
      .set({ sku })
      .where(
        and(
          eq(productVariants.id, input.variantId),
          eq(productVariants.organizationId, identity.organizationId),
          eq(productVariants.productId, input.id)
        )
      )
      .returning({ id: productVariants.id });
    if (!updatedVariant) {
      throw new ProductVariantNotFoundError();
    }
  } catch (error) {
    if (isProductVariantSkuConflict(error)) {
      // biome-ignore lint/style/useErrorCause: ProductVariantSkuConflictError forwards this cause to Error.
      throw new ProductVariantSkuConflictError({ cause: error });
    }
    throw error;
  }

  const [updatedProduct] = await transaction
    .update(products)
    .set({
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

  if (!updatedProduct) {
    throw new ProductVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: variant.id,
    entityType: "product_variant",
    eventType: "product_variant.sku_changed",
    requestId: input.requestId ?? null,
  });

  return {
    changed: true,
    configuration: await getProductVariants(transaction, identity, input.id),
    product: updatedProduct,
  };
}

export async function configureProductVariants(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ConfigureProductVariantsInput
) {
  const configuration = normalizeProductVariantConfiguration(input);
  const [existing] = await transaction
    .select({
      variantsConfiguredAt: products.variantsConfiguredAt,
      version: products.version,
    })
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
  if (existing.variantsConfiguredAt) {
    throw new ProductVariantsAlreadyConfiguredError();
  }

  const [defaultVariant] = await transaction
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, input.id),
        eq(productVariants.isDefault, true)
      )
    );
  if (!defaultVariant) {
    throw new ProductVariantConfigurationError();
  }
  if (defaultVariant.sku !== null) {
    throw new ProductDefaultVariantSkuConflictError();
  }
  const [defaultVariantStockMovement] = await transaction
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organizationId, identity.organizationId),
        eq(stockMovements.productId, input.id),
        eq(stockMovements.variantId, defaultVariant.id)
      )
    )
    .limit(1);
  if (defaultVariantStockMovement) {
    throw new ProductDefaultVariantStockHistoryConflictError();
  }

  const optionRows = await transaction
    .insert(productOptions)
    .values(
      configuration.options.map((option) => ({
        name: option.name,
        organizationId: identity.organizationId,
        position: PRODUCT_VARIANT_OPTION_NAMES.indexOf(option.name),
        productId: input.id,
      }))
    )
    .returning({ id: productOptions.id, name: productOptions.name });
  const optionIdByName = new Map(
    optionRows.map((option) => [
      productVariantOptionName(option.name),
      option.id,
    ])
  );
  const optionNameById = new Map(
    optionRows.map((option) => [
      option.id,
      productVariantOptionName(option.name),
    ])
  );

  const valueRows = await transaction
    .insert(productOptionValues)
    .values(
      configuration.options.flatMap((option) => {
        const optionId = optionIdByName.get(option.name);
        if (!optionId) {
          throw new ProductVariantConfigurationError();
        }
        return option.values.map((name, position) => ({
          name,
          optionId,
          organizationId: identity.organizationId,
          position,
          productId: input.id,
        }));
      })
    )
    .returning({
      id: productOptionValues.id,
      name: productOptionValues.name,
      optionId: productOptionValues.optionId,
    });

  const valueIdByOption = new Map<
    ProductVariantOptionName,
    Map<string, string>
  >();
  for (const value of valueRows) {
    const optionName = optionNameById.get(value.optionId);
    if (!optionName) {
      throw new ProductVariantConfigurationError();
    }
    const optionValues = valueIdByOption.get(optionName) ?? new Map();
    optionValues.set(value.name.toLowerCase(), value.id);
    valueIdByOption.set(optionName, optionValues);
  }

  const variantRows = await transaction
    .insert(productVariants)
    .values(
      configuration.variants.map((_, position) => ({
        isDefault: false,
        organizationId: identity.organizationId,
        position,
        productId: input.id,
      }))
    )
    .returning({ id: productVariants.id, position: productVariants.position });
  const variantIdByPosition = new Map(
    variantRows.map((variant) => [variant.position, variant.id])
  );

  const assignmentRows = configuration.variants.flatMap((variant, position) => {
    const variantId = variantIdByPosition.get(position);
    if (!variantId) {
      throw new ProductVariantConfigurationError();
    }
    return Object.entries(variant.values).map(([name, value]) => {
      const optionName = productVariantOptionName(name);
      const optionId = optionIdByName.get(optionName);
      if (typeof value !== "string") {
        throw new ProductVariantConfigurationError();
      }
      const optionValueId = valueIdByOption
        .get(optionName)
        ?.get(value.toLowerCase());
      if (!(optionId && optionValueId)) {
        throw new ProductVariantConfigurationError();
      }
      return {
        optionId,
        optionValueId,
        organizationId: identity.organizationId,
        productId: input.id,
        variantId,
      };
    });
  });
  await transaction.insert(variantOptionValues).values(assignmentRows);

  const [removedDefault] = await transaction
    .delete(productVariants)
    .where(
      and(
        eq(productVariants.id, defaultVariant.id),
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, input.id),
        eq(productVariants.isDefault, true)
      )
    )
    .returning({ id: productVariants.id });
  if (!removedDefault) {
    throw new ProductVariantConfigurationError();
  }

  const configuredAt = new Date();
  const [product] = await transaction
    .update(products)
    .set({
      updatedAt: configuredAt,
      variantsConfiguredAt: configuredAt,
      version: sql`${products.version} + 1`,
    })
    .where(
      and(
        eq(products.id, input.id),
        eq(products.organizationId, identity.organizationId),
        eq(products.version, input.expectedVersion),
        isNull(products.variantsConfiguredAt)
      )
    )
    .returning(productColumns);
  if (!product) {
    throw new ProductVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: product.id,
    entityType: "product",
    eventType: "product.variants_configured",
    requestId: input.requestId ?? null,
  });

  return {
    configuration: await getProductVariants(transaction, identity, product.id),
    product,
  };
}
