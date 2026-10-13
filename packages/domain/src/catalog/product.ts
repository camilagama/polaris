export type ProductLifecycle = "active" | "archived" | "deleted";

export type ProductLifecycleAction = "archive" | "delete" | "restore";

export const PRODUCT_VARIANT_OPTION_NAMES = ["model", "color", "size"] as const;
export const MAX_PRODUCT_VARIANTS = 50;

export type ProductVariantOptionName =
  (typeof PRODUCT_VARIANT_OPTION_NAMES)[number];

export interface ProductVariantOptionInput {
  name: ProductVariantOptionName;
  values: readonly string[];
}

export type ProductVariantValues = Partial<
  Record<ProductVariantOptionName, string | undefined>
>;

export interface ProductVariantConfigurationInput {
  options: readonly ProductVariantOptionInput[];
  variants: readonly { values: ProductVariantValues }[];
}

export class ProductVariantConfigurationError extends Error {
  readonly code = "invalid_product_variant_configuration";

  constructor() {
    super("invalid_product_variant_configuration");
    this.name = "ProductVariantConfigurationError";
  }
}

export class ProductVariantsAlreadyConfiguredError extends Error {
  readonly code = "product_variants_already_configured";

  constructor() {
    super("product_variants_already_configured");
    this.name = "ProductVariantsAlreadyConfiguredError";
  }
}

export class ProductVariantNotFoundError extends Error {
  readonly code = "product_variant_not_found";

  constructor() {
    super("product_variant_not_found");
    this.name = "ProductVariantNotFoundError";
  }
}

export class ProductVariantSkuConflictError extends Error {
  readonly code = "duplicate_sku";

  constructor(options?: ErrorOptions) {
    super("duplicate_sku", options);
    this.name = "ProductVariantSkuConflictError";
  }
}

export class ProductDefaultVariantSkuConflictError extends Error {
  readonly code = "product_default_variant_sku_conflict";

  constructor() {
    super("product_default_variant_sku_conflict");
    this.name = "ProductDefaultVariantSkuConflictError";
  }
}

export class ProductDefaultVariantStockHistoryConflictError extends Error {
  readonly code = "product_default_variant_stock_history_conflict";

  constructor() {
    super("product_default_variant_stock_history_conflict");
    this.name = "ProductDefaultVariantStockHistoryConflictError";
  }
}

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

export class ProductDeletedError extends Error {
  readonly code = "product_deleted";

  constructor() {
    super("product_deleted");
    this.name = "ProductDeletedError";
  }
}

export class ProductStockNotEmptyError extends Error {
  readonly code = "product_stock_not_empty";

  constructor(options?: ErrorOptions) {
    super("product_stock_not_empty", options);
    this.name = "ProductStockNotEmptyError";
  }
}

export class ProductLifecycleError extends Error {
  readonly code = "product_lifecycle_conflict";

  constructor(action: ProductLifecycleAction, lifecycle: ProductLifecycle) {
    super("product_lifecycle_conflict");
    this.action = action;
    this.lifecycle = lifecycle;
    this.name = "ProductLifecycleError";
  }

  readonly action: ProductLifecycleAction;
  readonly lifecycle: ProductLifecycle;
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

export function normalizeProductVariantConfiguration(
  input: ProductVariantConfigurationInput
): ProductVariantConfigurationInput {
  if (
    input.options.length < 1 ||
    input.options.length > PRODUCT_VARIANT_OPTION_NAMES.length ||
    input.variants.length < 1 ||
    input.variants.length > MAX_PRODUCT_VARIANTS
  ) {
    throw new ProductVariantConfigurationError();
  }

  const optionValues = new Map<
    ProductVariantOptionName,
    { normalizedValues: Map<string, string>; values: string[] }
  >();

  for (const option of input.options) {
    if (
      !PRODUCT_VARIANT_OPTION_NAMES.includes(option.name) ||
      optionValues.has(option.name) ||
      option.values.length < 1
    ) {
      throw new ProductVariantConfigurationError();
    }

    const values: string[] = [];
    const normalizedValues = new Map<string, string>();
    for (const value of option.values) {
      const normalized = value.trim();
      const key = normalized.toLowerCase();
      if (!normalized || normalizedValues.has(key)) {
        throw new ProductVariantConfigurationError();
      }
      values.push(normalized);
      normalizedValues.set(key, normalized);
    }
    optionValues.set(option.name, { normalizedValues, values });
  }

  const selectedOptions = PRODUCT_VARIANT_OPTION_NAMES.filter((name) =>
    optionValues.has(name)
  );
  const combinations = new Set<string>();
  const variants = input.variants.map((variant) => {
    const valueNames = Object.keys(variant.values);
    if (
      valueNames.length !== selectedOptions.length ||
      valueNames.some(
        (name) =>
          !(
            PRODUCT_VARIANT_OPTION_NAMES.includes(
              name as ProductVariantOptionName
            ) && optionValues.has(name as ProductVariantOptionName)
          )
      )
    ) {
      throw new ProductVariantConfigurationError();
    }

    const values: ProductVariantValues = {};
    const combination: string[] = [];
    for (const name of selectedOptions) {
      const value = variant.values[name];
      if (typeof value !== "string") {
        throw new ProductVariantConfigurationError();
      }
      const normalized = value.trim().toLowerCase();
      const canonical = optionValues
        .get(name)
        ?.normalizedValues.get(normalized);
      if (!canonical) {
        throw new ProductVariantConfigurationError();
      }
      values[name] = canonical;
      combination.push(normalized);
    }

    const combinationKey = JSON.stringify(combination);
    if (combinations.has(combinationKey)) {
      throw new ProductVariantConfigurationError();
    }
    combinations.add(combinationKey);
    return { values };
  });

  return {
    options: input.options.map((option) => ({
      name: option.name,
      values: optionValues.get(option.name)?.values ?? [],
    })),
    variants,
  };
}

export const MAX_PRODUCT_NAME_LENGTH = 200;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 5000;

export class ProductDescriptionError extends Error {
  readonly code = "invalid_product_description";

  constructor() {
    super("invalid_product_description");
    this.name = "ProductDescriptionError";
  }
}

export function normalizeProductName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_PRODUCT_NAME_LENGTH) {
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
  const normalized = description.trim();
  if (normalized.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
    throw new ProductDescriptionError();
  }
  return normalized || null;
}

export function normalizeProductVariantSku(
  sku: string | null | undefined
): string | null {
  if (sku === null || sku === undefined) {
    return null;
  }
  return sku.trim() || null;
}

export function deriveProductLifecycle(
  archivedAt: Date | null,
  deletedAt: Date | null
): ProductLifecycle {
  if (deletedAt !== null) {
    return "deleted";
  }
  return archivedAt === null ? "active" : "archived";
}

export function transitionProductLifecycle(
  current: ProductLifecycle,
  action: ProductLifecycleAction
): ProductLifecycleTransition {
  if (current === "deleted") {
    if (action === "delete") {
      return { changed: false, lifecycle: current };
    }
    throw new ProductLifecycleError(action, current);
  }

  if (action === "delete") {
    return { changed: true, lifecycle: "deleted" };
  }

  if (action === "archive") {
    return current === "active"
      ? { changed: true, lifecycle: "archived" }
      : { changed: false, lifecycle: current };
  }

  return current === "archived"
    ? { changed: true, lifecycle: "active" }
    : { changed: false, lifecycle: current };
}
