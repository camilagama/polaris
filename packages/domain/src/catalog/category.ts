export class CategoryNameError extends Error {
  readonly code = "invalid_category_name";

  constructor() {
    super("invalid_category_name");
    this.name = "CategoryNameError";
  }
}

export function normalizeCategoryName(name: string): string {
  const normalized = name.trim();

  if (!normalized || [...normalized].length > 100) {
    throw new CategoryNameError();
  }

  return normalized;
}
