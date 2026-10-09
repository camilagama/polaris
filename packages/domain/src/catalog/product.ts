export type ProductLifecycle = "active" | "archived";

export type ProductLifecycleAction = "archive" | "restore";

export interface ProductLifecycleTransition {
  changed: boolean;
  lifecycle: ProductLifecycle;
}

export class ProductNameError extends Error {
  readonly code = "invalid_product_name";

  constructor() {
    super("invalid_product_name");
    this.name = "ProductNameError";
  }
}

export class ProductNotFoundError extends Error {
  readonly code = "product_not_found";

  constructor() {
    super("product_not_found");
    this.name = "ProductNotFoundError";
  }
}

export class ProductVersionConflictError extends Error {
  readonly code = "product_version_conflict";

  constructor() {
    super("product_version_conflict");
    this.name = "ProductVersionConflictError";
  }
}

export class ProductCategoryUnavailableError extends Error {
  readonly code = "product_category_unavailable";

  constructor(options?: ErrorOptions) {
    super("product_category_unavailable", options);
    this.name = "ProductCategoryUnavailableError";
  }
}

export function normalizeProductName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new ProductNameError();
  }
  return normalized;
}

export function normalizeProductDescription(
  description: string | null | undefined
): string | null {
  if (description === null || description === undefined) {
    return null;
  }
  return description.trim() || null;
}

export function deriveProductLifecycle(
  archivedAt: Date | null
): ProductLifecycle {
  return archivedAt === null ? "active" : "archived";
}

export function transitionProductLifecycle(
  current: ProductLifecycle,
  action: ProductLifecycleAction
): ProductLifecycleTransition {
  if (action === "archive") {
    return current === "archived"
      ? { changed: false, lifecycle: current }
      : { changed: true, lifecycle: "archived" };
  }

  return current === "active"
    ? { changed: false, lifecycle: current }
    : { changed: true, lifecycle: "active" };
}
