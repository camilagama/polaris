import {
  deriveProductLifecycle,
  InvalidProductIdError,
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductVariantConfiguration,
  normalizeProductVariantSku,
  normalizeVariantListPrice,
  PRODUCT_VARIANT_OPTION_NAMES,
  ProductCategoryUnavailableError,
  ProductDefaultVariantSkuConflictError,
  ProductDefaultVariantStockHistoryConflictError,
  ProductDeletedError,
  ProductIdConflictError,
  type ProductLifecycleAction,
  ProductNotFoundError,
  ProductStockNotEmptyError,
  ProductVariantConfigurationError,
  type ProductVariantConfigurationInput,
  ProductVariantNotFoundError,
  type ProductVariantOptionName,
  ProductVariantSkuConflictError,
  ProductVariantsAlreadyConfiguredError,
  ProductVersionConflictError,
  transitionProductLifecycle,
} from "@polaris/domain/catalog/product";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { assertRoomFor } from "./entitlement-enforcement";
import { categories } from "./schema/category";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { products, productVariants } from "./schema/product";
import {
  productOptions,
  productOptionValues,
  variantOptionValues,
} from "./schema/product-variants";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export interface ProductListOptions {
  status?: "active" | "archived" | "deleted" | "all";
}

export interface ProductMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface CreateProductInput {
  categoryId?: string | null;
  /** The default variant's ID, chosen by an offline device; otherwise assigned. */
  defaultVariantId?: string;
  description?: string | null;
  /** A UUID the caller generated; without one the database assigns a UUIDv7. */
  id?: string;
  /** Optional BRL list price of the default variant. */
  listPrice?: string | null;
  name: string;
  requestId?: string | null;
  /** Optional SKU of the default variant. */
  sku?: string | null;
}

export interface UpdateProductInput extends ProductMutationInput {
  categoryId: string | null;
  description: string | null;
  name: string;
}

export interface ConfigureProductVariantsInput
  extends ProductMutationInput,
    ProductVariantConfigurationInput {}

export interface SetProductVariantListPriceInput extends ProductMutationInput {
  listPrice: string | null;
  variantId: string;
}

export interface SetProductVariantSkuInput extends ProductMutationInput {
  sku: string | null;
  variantId: string;
}

const productColumns = {
  archivedAt: products.archivedAt,
  categoryId: products.categoryId,
  createdAt: products.createdAt,
  deletedAt: products.deletedAt,
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

function isUniqueViolation(error: unknown, constraints: string[]): boolean {
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
      typeof candidate.constraint === "string" &&
      constraints.includes(candidate.constraint)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function isProductVariantSkuConflict(error: unknown): boolean {
  return isUniqueViolation(error, ["product_variants_organization_sku_unique"]);
}

const productIdConstraints = [
  "products_pkey",
  "product_variants_pkey",
  "product_variants_organization_product_id_unique",
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      conditions.push(isNull(products.archivedAt), isNull(products.deletedAt));
      break;
    case "archived":
      conditions.push(
        isNotNull(products.archivedAt),
        isNull(products.deletedAt)
      );
      break;
    case "deleted":
      conditions.push(isNotNull(products.deletedAt));
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

/**
 * Variants the organization holds against its plan: every variant of a product
 * that has not been deleted (an archived product still counts; deleting frees).
 */
export async function countOrganizationVariants(
  transaction: TenantRequestTransaction,
  organizationId: string
): Promise<number> {
  const [row] = await transaction
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.organizationId, productVariants.organizationId),
        eq(products.id, productVariants.productId)
      )
    )
    .where(
      and(
        eq(productVariants.organizationId, organizationId),
        isNull(products.deletedAt)
      )
    );
  return row?.total ?? 0;
}

/**
 * The key two product names share when they differ only by case and repeated spaces ("Camiseta  Azul" and
 * "camiseta azul"), computed by the database on both sides of every comparison so the import never holds a rule of
 * its own in JavaScript.
 */
function productNameKey(name: SQL | string): SQL {
  return sql`lower(btrim(regexp_replace((${name})::text, '[[:space:]]+', ' ', 'g')))`;
}

/**
 * The import of a spreadsheet (corte 2.5) skips a row whose name a product of the store already has. Inside the
 * transaction of the row, this takes the lock of the store and the name (two tabs importing the same name wait for
 * each other) and then reads the products of the store with that name: an archived one counts, a deleted one does
 * not. Returns their IDs, so the caller tells the repeat of its own row from a product that was already there.
 */
export async function lockProductNameAndFindProducts(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  name: string
): Promise<string[]> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polaris.product.name:${identity.organizationId}:`}::text || ${productNameKey(name)}, 0))`
  );
  const rows = await transaction
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.organizationId, identity.organizationId),
        isNull(products.deletedAt),
        sql`${productNameKey(sql`${products.name}`)} = ${productNameKey(name)}`
      )
    );
  return rows.map((row) => row.id);
}

/**
 * The names of a list that a product of the store already has (archived counts, deleted does not), compared as
 * `lockProductNameAndFindProducts` compares them; each name comes back as it was asked. Only information for the
 * preview of an import: the transaction of each row decides.
 */
export async function findExistingProductNames(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  names: readonly string[]
): Promise<string[]> {
  if (names.length === 0) {
    return [];
  }
  const result = await transaction.execute(sql`
    WITH asked AS (
      SELECT asked_name, ${productNameKey(sql`asked_name`)} AS name_key
      FROM unnest(ARRAY[${sql.join(
        names.map((name) => sql`${name}`),
        sql`, `
      )}]::text[]) AS asked(asked_name)
    ),
    held AS (
      SELECT DISTINCT ${productNameKey(sql`${products.name}`)} AS name_key
      FROM ${products}
      WHERE ${products.organizationId} = ${identity.organizationId}
        AND ${products.deletedAt} IS NULL
    )
    SELECT DISTINCT asked.asked_name FROM asked JOIN held USING (name_key)
  `);
  return (result.rows as { asked_name: string }[]).map((row) => row.asked_name);
}

/** What a product of this organization was created with: the product, its default variant and its first stock movement. */
export interface ProductCreationRecord {
  /** The first movement of the variant when it is a receipt or an inventory count; the opening stock, if any. */
  opening: { quantity: number; unitCost: string | null } | null;
  product: typeof products.$inferSelect;
  variant: { id: string; listPrice: string | null; sku: string | null };
}

/**
 * Reads back a product created earlier, by its ID, so a repeated creation can be told from a conflicting one.
 * `variantId` picks the variant when the caller named it; otherwise it is the default one. The product of
 * another organization is not found (the row is hidden by RLS and the organization is in the filter).
 */
export async function readProductCreation(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { productId: string; variantId?: string | undefined }
): Promise<ProductCreationRecord | null> {
  const [product] = await transaction
    .select(productColumns)
    .from(products)
    .where(
      and(
        eq(products.id, input.productId),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!product) {
    return null;
  }
  const [variant] = await transaction
    .select({
      id: productVariants.id,
      listPrice: productVariants.listPrice,
      sku: productVariants.sku,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, input.productId),
        input.variantId === undefined
          ? eq(productVariants.isDefault, true)
          : eq(productVariants.id, input.variantId)
      )
    )
    .limit(1);
  if (!variant) {
    return null;
  }
  const [first] = await transaction
    .select({
      movementType: stockMovements.movementType,
      quantityDelta: stockMovements.quantityDelta,
      unitCost: stockMovements.unitCost,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organizationId, identity.organizationId),
        eq(stockMovements.variantId, variant.id)
      )
    )
    .orderBy(asc(stockMovements.variantSequence))
    .limit(1);
  const isOpening =
    first !== undefined &&
    (first.movementType === "receipt" ||
      first.movementType === "inventory_count");
  return {
    opening:
      isOpening && first
        ? { quantity: first.quantityDelta, unitCost: first.unitCost }
        : null,
    product,
    variant,
  };
}

export async function createProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductInput
) {
  const name = normalizeProductName(input.name);
  const description = normalizeProductDescription(input.description);
  const sku = normalizeProductVariantSku(input.sku);
  const listPrice = normalizeVariantListPrice(input.listPrice);
  const categoryId = input.categoryId ?? null;
  for (const id of [input.id, input.defaultVariantId]) {
    if (id !== undefined && !uuidPattern.test(id)) {
      throw new InvalidProductIdError();
    }
  }
  if (categoryId) {
    await requireActiveCategory(
      transaction,
      identity.organizationId,
      categoryId
    );
  }

  // the default variant is a variant: the plan's limit applies to it too
  await assertRoomFor(transaction, identity, "variants.active.max", 1, () =>
    countOrganizationVariants(transaction, identity.organizationId)
  );

  let product: typeof products.$inferSelect | undefined;
  try {
    // The savepoint keeps a duplicate ID or SKU from aborting the caller's transaction.
    product = await transaction.transaction(async (savepoint) => {
      const [created] = await savepoint
        .insert(products)
        .values({
          categoryId,
          description,
          ...(input.id === undefined ? {} : { id: input.id }),
          name,
          organizationId: identity.organizationId,
        })
        .returning(productColumns);
      if (!created) {
        throw new Error("product_insert_failed");
      }
      await savepoint.insert(productVariants).values({
        ...(input.defaultVariantId === undefined
          ? {}
          : { id: input.defaultVariantId }),
        isDefault: true,
        listPrice,
        organizationId: identity.organizationId,
        productId: created.id,
        sku,
      });
      return created;
    });
  } catch (error) {
    if (isUnavailableCategoryConstraint(error)) {
      // biome-ignore lint/style/useErrorCause: ProductCategoryUnavailableError forwards this cause to Error.
      throw new ProductCategoryUnavailableError({ cause: error });
    }
    if (isProductVariantSkuConflict(error)) {
      // biome-ignore lint/style/useErrorCause: ProductVariantSkuConflictError forwards this cause to Error.
      throw new ProductVariantSkuConflictError({ cause: error });
    }
    if (isUniqueViolation(error, productIdConstraints)) {
      // biome-ignore lint/style/useErrorCause: ProductIdConflictError forwards this cause to Error.
      throw new ProductIdConflictError({ cause: error });
    }
    throw error;
  }

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
  if (existing.deletedAt) {
    throw new ProductDeletedError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  // a name kept as it is is not checked again: a product written before a rule of the name (a tab, a mark of the
  // direction) keeps its category and description editable, and only a new name has to follow the rule
  const name =
    input.name === existing.name
      ? existing.name
      : normalizeProductName(input.name);
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
    deriveProductLifecycle(existing.archivedAt, existing.deletedAt),
    action
  );
  if (!transition.changed) {
    return { changed: false, product: existing };
  }
  if (existing.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  if (action === "delete") {
    const [positiveBalance] = await transaction
      .select({ variantId: inventoryBalances.variantId })
      .from(inventoryBalances)
      .where(
        and(
          eq(inventoryBalances.organizationId, identity.organizationId),
          eq(inventoryBalances.productId, input.id),
          gt(inventoryBalances.quantity, 0)
        )
      )
      .limit(1);
    if (positiveBalance) {
      throw new ProductStockNotEmptyError();
    }
  }

  let { archivedAt } = existing;
  if (transition.lifecycle === "archived") {
    archivedAt ??= new Date();
  } else if (transition.lifecycle === "active") {
    archivedAt = null;
  }
  const deletedAt =
    transition.lifecycle === "deleted"
      ? (existing.deletedAt ?? new Date())
      : existing.deletedAt;
  const [product] = await transaction
    .update(products)
    .set({
      archivedAt,
      deletedAt,
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

  const productAuditEvent = (
    {
      archive: "product.archived",
      delete: "product.deleted",
      restore: "product.restored",
    } as const
  )[action];
  await recordTenantAuditEvent(transaction, identity, {
    entityId: product.id,
    entityType: "product",
    eventType: productAuditEvent,
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

export async function deleteProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ProductMutationInput
) {
  return await changeProductLifecycle(transaction, identity, input, "delete");
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
      deletedAt: products.deletedAt,
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
      listPrice: productVariants.listPrice,
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
      listPrice: normalizeVariantListPrice(variant.listPrice),
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
  if (product.deletedAt) {
    throw new ProductDeletedError();
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

/**
 * Sets or clears the list price of one variant. Like every catalog write it is
 * versioned (the product version moves) and audited.
 */
export async function setProductVariantListPrice(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SetProductVariantListPriceInput
) {
  const listPrice = normalizeVariantListPrice(input.listPrice);
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
  if (product.deletedAt) {
    throw new ProductDeletedError();
  }
  if (product.version !== input.expectedVersion) {
    throw new ProductVersionConflictError();
  }

  const [variant] = await transaction
    .select({ id: productVariants.id, listPrice: productVariants.listPrice })
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
  // numeric text keeps the scale it was written with, so compare as numbers.
  const unchanged =
    variant.listPrice === null || listPrice === null
      ? variant.listPrice === listPrice
      : Number(variant.listPrice) === Number(listPrice);
  if (unchanged) {
    return {
      changed: false,
      configuration: await getProductVariants(transaction, identity, input.id),
      product,
    };
  }

  const [updatedVariant] = await transaction
    .update(productVariants)
    .set({ listPrice })
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
    eventType: "product_variant.list_price_changed",
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
      deletedAt: products.deletedAt,
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
  if (existing.deletedAt) {
    throw new ProductDeletedError();
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

  // the default variant is replaced by the configured ones: the net addition counts
  const added = configuration.variants.length - 1;
  if (added > 0) {
    await assertRoomFor(
      transaction,
      identity,
      "variants.active.max",
      added,
      () => countOrganizationVariants(transaction, identity.organizationId)
    );
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
