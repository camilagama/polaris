import type {
  CategoryReadModel,
  LocalCategoryReadModel,
  LocalProductReadModel,
  ProductReadModel,
} from "@polaris/contracts";

/**
 * The products screen reading this device's collections (plan PR64): the local
 * rows rebuilt into the shape the screen already renders, and the server's
 * product written back as a local row after an online change.
 */
function lifecycle(row: {
  archivedAt: string | null;
  deletedAt: string | null;
}): "active" | "archived" | "deleted" {
  if (row.deletedAt !== null) {
    return "deleted";
  }
  return row.archivedAt === null ? "active" : "archived";
}

export function toProductReadModel(
  row: LocalProductReadModel,
  organizationId: string
): ProductReadModel {
  return {
    archivedAt: row.archivedAt,
    categoryId: row.categoryId,
    // The device does not keep the creation date; the last change stands in for it.
    createdAt: row.updatedAt,
    deletedAt: row.deletedAt,
    description: row.description,
    id: row.id,
    name: row.name,
    organizationId,
    status: lifecycle(row),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toLocalProductRow(
  product: ProductReadModel
): LocalProductReadModel {
  return {
    archivedAt: product.archivedAt,
    categoryId: product.categoryId,
    deletedAt: product.deletedAt,
    description: product.description,
    id: product.id,
    name: product.name,
    updatedAt: product.updatedAt,
    version: product.version,
  };
}

function toCategoryReadModel(
  row: LocalCategoryReadModel,
  organizationId: string
): CategoryReadModel {
  return {
    archivedAt: row.archivedAt,
    createdAt: row.updatedAt,
    deletedAt: row.deletedAt,
    id: row.id,
    name: row.name,
    organizationId,
    status: lifecycle(row),
    updatedAt: row.updatedAt,
  };
}

/** The products of one state, by name (then ID); deleted ones never show. */
export function listLocalProducts(
  rows: LocalProductReadModel[],
  organizationId: string,
  status: "active" | "archived"
): ProductReadModel[] {
  return rows
    .map((row) => toProductReadModel(row, organizationId))
    .filter((product) => product.status === status)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id)
    );
}

/** Every category (the form hides the inactive ones, the list names them all). */
export function listLocalCategories(
  rows: LocalCategoryReadModel[],
  organizationId: string
): CategoryReadModel[] {
  return rows
    .map((row) => toCategoryReadModel(row, organizationId))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id)
    );
}
