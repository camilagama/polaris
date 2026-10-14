import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { categories } from "./schema/category";
import { customers } from "./schema/customer";
import { inventoryBalances } from "./schema/inventory";
import { products, productVariants } from "./schema/product";
import {
  productOptions,
  productOptionValues,
  variantOptionValues,
} from "./schema/product-variants";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * The read models a device keeps locally (plan PR50). They are deliberately
 * smaller than the online ones: only what working offline needs, with instants
 * as ISO text so they cross JSON unchanged. Costs and audit data never leave
 * the server.
 */
export const BOOTSTRAP_COLLECTIONS = [
  "categories",
  "customers",
  "inventory",
  "products",
  "variants",
] as const;
export type BootstrapCollection = (typeof BOOTSTRAP_COLLECTIONS)[number];

export const BOOTSTRAP_DEFAULT_LIMIT = 200;
export const BOOTSTRAP_MAX_LIMIT = 500;
export const BOOTSTRAP_MAX_IDS = 200;

export interface LocalCategoryRow {
  archivedAt: string | null;
  deletedAt: string | null;
  id: string;
  name: string;
  updatedAt: string;
}

export interface LocalProductRow {
  archivedAt: string | null;
  categoryId: string | null;
  deletedAt: string | null;
  description: string | null;
  id: string;
  name: string;
  updatedAt: string;
  version: number;
}

export interface LocalVariantRow {
  id: string;
  isDefault: boolean;
  listPrice: string | null;
  position: number | null;
  productId: string;
  sku: string | null;
  values: Array<{ optionName: string; optionValueName: string }>;
}

export interface LocalInventoryRow {
  productId: string;
  quantity: number;
  updatedAt: string;
  variantId: string;
  version: number;
}

export interface LocalCustomerRow {
  archivedAt: string | null;
  email: string | null;
  id: string;
  name: string;
  notes: string | null;
  phone: string | null;
  updatedAt: string;
  version: number;
}

export type BootstrapPage =
  | {
      collection: "categories";
      nextAfterId: string | null;
      rows: LocalCategoryRow[];
    }
  | {
      collection: "customers";
      nextAfterId: string | null;
      rows: LocalCustomerRow[];
    }
  | {
      collection: "inventory";
      nextAfterId: string | null;
      rows: LocalInventoryRow[];
    }
  | {
      collection: "products";
      nextAfterId: string | null;
      rows: LocalProductRow[];
    }
  | {
      collection: "variants";
      nextAfterId: string | null;
      rows: LocalVariantRow[];
    };

export interface BootstrapPageInput {
  /** Keyset position: the last id of the previous page. Ignored with `ids`. */
  afterId?: string | null;
  collection: BootstrapCollection;
  /**
   * Re-reads specific entities (after a change): category, customer and product
   * ids; variant ids for `inventory`; and PRODUCT ids for `variants`, because a
   * product change moves its variants too. Missing ids are simply absent.
   */
  ids?: readonly string[] | null;
  limit?: number;
}

interface PageRequest {
  afterId: string | null;
  ids: readonly string[] | null;
  /** Rows to fetch: the page size plus one to learn whether there is more. */
  limit: number;
  organizationId: string;
}

type Transaction = TenantRequestTransaction;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** Either the requested ids or the rows after the keyset position. */
function keyFilter(column: AnyPgColumn, request: PageRequest): SQL | undefined {
  if (request.ids) {
    return inArray(column, [...request.ids]);
  }
  return request.afterId ? gt(column, request.afterId) : undefined;
}

/** Splits the extra row off a page and derives the next keyset position. */
function pageOf<T>(
  rows: T[],
  request: PageRequest,
  keyOf: (row: T) => string
): { nextAfterId: string | null; page: T[] } {
  if (request.ids) {
    return { nextAfterId: null, page: rows };
  }
  const size = request.limit - 1;
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    nextAfterId: rows.length > size && last ? keyOf(last) : null,
    page,
  };
}

async function readCategories(
  transaction: Transaction,
  request: PageRequest
): Promise<BootstrapPage> {
  const rows = await transaction
    .select({
      archivedAt: categories.archivedAt,
      deletedAt: categories.deletedAt,
      id: categories.id,
      name: categories.name,
      updatedAt: categories.updatedAt,
    })
    .from(categories)
    .where(
      and(
        eq(categories.organizationId, request.organizationId),
        keyFilter(categories.id, request)
      )
    )
    .orderBy(asc(categories.id))
    .limit(request.limit);
  const { nextAfterId, page } = pageOf(rows, request, (row) => row.id);
  return {
    collection: "categories",
    nextAfterId,
    rows: page.map((row) => ({
      archivedAt: iso(row.archivedAt),
      deletedAt: iso(row.deletedAt),
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

async function readCustomers(
  transaction: Transaction,
  request: PageRequest
): Promise<BootstrapPage> {
  const rows = await transaction
    .select({
      archivedAt: customers.archivedAt,
      email: customers.email,
      id: customers.id,
      name: customers.name,
      notes: customers.notes,
      phone: customers.phone,
      updatedAt: customers.updatedAt,
      version: customers.version,
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, request.organizationId),
        keyFilter(customers.id, request)
      )
    )
    .orderBy(asc(customers.id))
    .limit(request.limit);
  const { nextAfterId, page } = pageOf(rows, request, (row) => row.id);
  return {
    collection: "customers",
    nextAfterId,
    rows: page.map((row) => ({
      archivedAt: iso(row.archivedAt),
      email: row.email,
      id: row.id,
      name: row.name,
      notes: row.notes,
      phone: row.phone,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    })),
  };
}

async function readProducts(
  transaction: Transaction,
  request: PageRequest
): Promise<BootstrapPage> {
  const rows = await transaction
    .select({
      archivedAt: products.archivedAt,
      categoryId: products.categoryId,
      deletedAt: products.deletedAt,
      description: products.description,
      id: products.id,
      name: products.name,
      updatedAt: products.updatedAt,
      version: products.version,
    })
    .from(products)
    .where(
      and(
        eq(products.organizationId, request.organizationId),
        keyFilter(products.id, request)
      )
    )
    .orderBy(asc(products.id))
    .limit(request.limit);
  const { nextAfterId, page } = pageOf(rows, request, (row) => row.id);
  return {
    collection: "products",
    nextAfterId,
    rows: page.map((row) => ({
      archivedAt: iso(row.archivedAt),
      categoryId: row.categoryId,
      deletedAt: iso(row.deletedAt),
      description: row.description,
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    })),
  };
}

async function readInventory(
  transaction: Transaction,
  request: PageRequest
): Promise<BootstrapPage> {
  const rows = await transaction
    .select({
      productId: inventoryBalances.productId,
      quantity: inventoryBalances.quantity,
      updatedAt: inventoryBalances.updatedAt,
      variantId: inventoryBalances.variantId,
      version: inventoryBalances.version,
    })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, request.organizationId),
        keyFilter(inventoryBalances.variantId, request)
      )
    )
    .orderBy(asc(inventoryBalances.variantId))
    .limit(request.limit);
  const { nextAfterId, page } = pageOf(rows, request, (row) => row.variantId);
  return {
    collection: "inventory",
    nextAfterId,
    rows: page.map((row) => ({
      productId: row.productId,
      quantity: row.quantity,
      updatedAt: row.updatedAt.toISOString(),
      variantId: row.variantId,
      version: row.version,
    })),
  };
}

async function variantValues(
  transaction: Transaction,
  organizationId: string,
  variantIds: string[]
): Promise<Map<string, LocalVariantRow["values"]>> {
  const byVariant = new Map<string, LocalVariantRow["values"]>();
  if (variantIds.length === 0) {
    return byVariant;
  }
  const valueRows = await transaction
    .select({
      optionName: productOptions.name,
      optionValueName: productOptionValues.name,
      variantId: variantOptionValues.variantId,
    })
    .from(variantOptionValues)
    .innerJoin(
      productOptions,
      and(
        eq(productOptions.organizationId, variantOptionValues.organizationId),
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
        eq(productOptionValues.id, variantOptionValues.optionValueId)
      )
    )
    .where(
      and(
        eq(variantOptionValues.organizationId, organizationId),
        inArray(variantOptionValues.variantId, variantIds)
      )
    )
    .orderBy(asc(productOptions.position));
  for (const row of valueRows) {
    const values = byVariant.get(row.variantId) ?? [];
    values.push({
      optionName: row.optionName,
      optionValueName: row.optionValueName,
    });
    byVariant.set(row.variantId, values);
  }
  return byVariant;
}

async function readVariants(
  transaction: Transaction,
  request: PageRequest
): Promise<BootstrapPage> {
  // With ids these are PRODUCT ids; a product has at most 50 variants.
  const rows = await transaction
    .select({
      id: productVariants.id,
      isDefault: productVariants.isDefault,
      listPrice: productVariants.listPrice,
      position: productVariants.position,
      productId: productVariants.productId,
      sku: productVariants.sku,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.organizationId, request.organizationId),
        request.ids
          ? inArray(productVariants.productId, [...request.ids])
          : keyFilter(productVariants.id, request)
      )
    )
    .orderBy(asc(productVariants.id))
    .limit(request.limit);
  const { nextAfterId, page } = pageOf(rows, request, (row) => row.id);
  const values = await variantValues(
    transaction,
    request.organizationId,
    page.map((row) => row.id)
  );
  return {
    collection: "variants",
    nextAfterId,
    rows: page.map((row) => ({
      id: row.id,
      isDefault: row.isDefault,
      listPrice: row.listPrice,
      position: row.position,
      productId: row.productId,
      sku: row.sku,
      values: values.get(row.id) ?? [],
    })),
  };
}

const readers: Record<
  BootstrapCollection,
  (transaction: Transaction, request: PageRequest) => Promise<BootstrapPage>
> = {
  categories: readCategories,
  customers: readCustomers,
  inventory: readInventory,
  products: readProducts,
  variants: readVariants,
};

/**
 * One page of one collection, ordered by id (UUIDv7, so roughly by creation).
 * Every read is scoped to the organization of the authorized transaction.
 */
export function readBootstrapPage(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: BootstrapPageInput
): Promise<BootstrapPage> {
  const pageSize = input.limit ?? BOOTSTRAP_DEFAULT_LIMIT;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > BOOTSTRAP_MAX_LIMIT ||
    (input.ids && input.ids.length > BOOTSTRAP_MAX_IDS)
  ) {
    return Promise.reject(new RangeError("invalid_bootstrap_request"));
  }
  const reader = Object.hasOwn(readers, input.collection)
    ? readers[input.collection]
    : undefined;
  if (!reader) {
    return Promise.reject(new RangeError("invalid_bootstrap_collection"));
  }
  return reader(transaction, {
    afterId: input.afterId ?? null,
    ids: input.ids ?? null,
    // One extra row tells whether another page follows; id lookups are bounded
    // by the number of ids (and by 50 variants per product).
    limit: input.ids ? BOOTSTRAP_MAX_LIMIT * 4 : pageSize + 1,
    organizationId: identity.organizationId,
  });
}
