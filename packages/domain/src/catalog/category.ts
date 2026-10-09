export class CategoryNameError extends Error {
  readonly code = "invalid_category_name";

  constructor() {
    super("invalid_category_name");
    this.name = "CategoryNameError";
  }
}

export class CategoryNameConflictError extends Error {
  readonly code = "category_name_conflict";

  constructor(options?: ErrorOptions) {
    super("category_name_conflict", options);
    this.name = "CategoryNameConflictError";
  }
}

export class CategoryNotFoundError extends Error {
  readonly code = "category_not_found";

  constructor() {
    super("category_not_found");
    this.name = "CategoryNotFoundError";
  }
}

export class CategoryDeletedError extends Error {
  readonly code = "category_deleted";

  constructor() {
    super("category_deleted");
    this.name = "CategoryDeletedError";
  }
}

export type CategoryLifecycle = "active" | "archived" | "deleted";
export type CategoryLifecycleAction = "archive" | "delete" | "restore";

export class CategoryLifecycleError extends Error {
  readonly code = "category_lifecycle_conflict";

  constructor(action: CategoryLifecycleAction, lifecycle: CategoryLifecycle) {
    super("category_lifecycle_conflict");
    this.action = action;
    this.lifecycle = lifecycle;
    this.name = "CategoryLifecycleError";
  }

  readonly action: CategoryLifecycleAction;
  readonly lifecycle: CategoryLifecycle;
}

export interface CategoryLifecycleTransition {
  changed: boolean;
  lifecycle: CategoryLifecycle;
}

export function deriveCategoryLifecycle(
  archivedAt: Date | null,
  deletedAt: Date | null
): CategoryLifecycle {
  if (deletedAt !== null) {
    return "deleted";
  }
  return archivedAt === null ? "active" : "archived";
}

export function transitionCategoryLifecycle(
  lifecycle: CategoryLifecycle,
  action: CategoryLifecycleAction
): CategoryLifecycleTransition {
  if (lifecycle === "deleted") {
    if (action === "delete") {
      return { changed: false, lifecycle };
    }
    throw new CategoryLifecycleError(action, lifecycle);
  }

  if (action === "delete") {
    return { changed: true, lifecycle: "deleted" };
  }

  if (action === "archive") {
    return lifecycle === "active"
      ? { changed: true, lifecycle: "archived" }
      : { changed: false, lifecycle };
  }

  return lifecycle === "archived"
    ? { changed: true, lifecycle: "active" }
    : { changed: false, lifecycle };
}

export function normalizeCategoryName(name: string): string {
  const normalized = name.trim();

  if (!normalized || [...normalized].length > 100) {
    throw new CategoryNameError();
  }

  return normalized;
}
