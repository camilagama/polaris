import { Money } from "../money/money";
export type ProductLifecycle = "active" | "archived" | "deleted";

export type ProductLifecycleAction = "archive" | "delete" | "restore";

export const PRODUCT_VARIANT_OPTION_NAMES = ["model", "color", "size"] as const;
export const MAX_PRODUCT_VARIANTS = 50;
/** In code points, after the trim: a value is "GG", "Azul-marinho", "iPhone 15 Pro Max". */
export const MAX_PRODUCT_OPTION_VALUE_LENGTH = 80;
/** In code points, after the trim: the codes of an ERP or a marketplace (up to 50) and a GTIN-14 with a prefix. */
export const MAX_PRODUCT_VARIANT_SKU_LENGTH = 64;

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

export class ProductVariantSkuError extends Error {
  readonly code = "invalid_product_variant_sku";

  constructor() {
    super("invalid_product_variant_sku");
    this.name = "ProductVariantSkuError";
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

/** An ID the caller chose for a product or variant is not a UUID. */
export class InvalidProductIdError extends Error {
  readonly code = "invalid_product_id";

  constructor() {
    super("invalid_product_id");
    this.name = "InvalidProductIdError";
  }
}

/** A product or variant ID the caller chose (an offline device) is already taken. */
export class ProductIdConflictError extends Error {
  readonly code = "product_id_conflict";

  constructor(options?: ErrorOptions) {
    super("product_id_conflict", options);
    this.name = "ProductIdConflictError";
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
      if (
        !normalized ||
        [...normalized].length > MAX_PRODUCT_OPTION_VALUE_LENGTH ||
        normalizedValues.has(key)
      ) {
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

/**
 * Characters no product text may hold: the controls of U+0000 to U+001F and U+007F (U+0000 PostgreSQL refuses in
 * text, so the write would fail as a fault, not as a refusal), except the tab and the line breaks, which a
 * description keeps; and the controls of the direction of the text (`Bidi_Control`: U+061C, U+200E, U+200F,
 * U+202A to U+202E, U+2066 to U+2069), which make a name read differently on the list, the sale and the catalog
 * than it was typed.
 */
const FORBIDDEN_PRODUCT_TEXT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing the control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Bidi_Control}]/u;
/** A name is one line: a tab or a line break inside it is refused, never joined. */
const NAME_LINE_BREAKS = /[\t\n\r]/;
/**
 * The characters of zero width (U+200B to U+200D, U+2060, U+FEFF): kept inside a name (the joiner of an emoji), but a
 * name of nothing else shows empty on the list.
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;

/** Whether a text holds a character no product text may hold (a control character or a control of the direction). */
export function hasForbiddenProductText(text: string): boolean {
  return FORBIDDEN_PRODUCT_TEXT.test(text);
}

/** Whether a name shows nothing: empty, or only spaces and characters of zero width. */
export function isBlankProductName(name: string): boolean {
  return name.replace(ZERO_WIDTH, "").trim() === "";
}

export function normalizeProductName(name: string): string {
  const normalized = name.trim();
  if (
    isBlankProductName(normalized) ||
    normalized.length > MAX_PRODUCT_NAME_LENGTH ||
    hasForbiddenProductText(normalized) ||
    NAME_LINE_BREAKS.test(normalized)
  ) {
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
  if (
    normalized.length > MAX_PRODUCT_DESCRIPTION_LENGTH ||
    hasForbiddenProductText(normalized)
  ) {
    throw new ProductDescriptionError();
  }
  return normalized || null;
}

export class InvalidVariantListPriceError extends Error {
  constructor() {
    super("invalid_variant_list_price");
    this.name = "InvalidVariantListPriceError";
  }
}

const variantListPricePattern = /^\d{1,15}(?:\.\d{1,2})?$/;

/**
 * The list price of a variant is optional and, when present, a non-negative BRL
 * amount with at most two decimals. It only suggests the listed price of a sale
 * item; the price in the sale command remains the only economic fact.
 */
export function normalizeVariantListPrice(
  price: string | null | undefined
): string | null {
  if (price === null || price === undefined) {
    return null;
  }
  const trimmed = price.trim();
  if (!variantListPricePattern.test(trimmed)) {
    throw new InvalidVariantListPriceError();
  }
  return Money.from(trimmed).toString();
}

export function normalizeProductVariantSku(
  sku: string | null | undefined
): string | null {
  if (sku === null || sku === undefined) {
    return null;
  }
  const trimmed = sku.trim();
  if ([...trimmed].length > MAX_PRODUCT_VARIANT_SKU_LENGTH) {
    throw new ProductVariantSkuError();
  }
  return trimmed || null;
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
