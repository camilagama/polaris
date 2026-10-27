import type {
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import {
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";

/* What the variants panel decides without drawing: the option names, the values typed one per line, the
   validation of the combinations and the sentences of its errors. */

export const MAX_VARIANTS = 50;

export const optionChoices: ReadonlyArray<
  readonly [ProductVariantOptionName, string]
> = [
  ["model", "Modelo"],
  ["color", "Cor"],
  ["size", "Tamanho"],
];

export const emptyValueLines: Record<ProductVariantOptionName, string> = {
  color: "",
  model: "",
  size: "",
};

const optionValueLineBreak = /\r?\n/;

export interface VariantDraft {
  values: Partial<Record<ProductVariantOptionName, string | undefined>>;
}

/**
 * What was picked and typed in the first configuration of the options and not saved yet. The dialog's Esc, × and step
 * back keep it in memory for the next opening of the same product, as the data; "Cancelar" and the save drop it.
 */
export interface VariantConfigurationDraft {
  selectedOptions: ProductVariantOptionName[];
  valueLines: Record<ProductVariantOptionName, string>;
  variants: VariantDraft[];
}

export const emptyConfigurationDraft: VariantConfigurationDraft = {
  selectedOptions: [],
  valueLines: emptyValueLines,
  variants: [],
};

/** Whether anything was picked or typed: a draft with nothing in it is not work to keep. */
export function isConfigurationDraftEmpty(
  draft: VariantConfigurationDraft
): boolean {
  return (
    draft.selectedOptions.length === 0 &&
    draft.variants.length === 0 &&
    Object.values(draft.valueLines).every((lines) => lines === "")
  );
}

export type ProductVariantReadModel =
  ProductVariantConfigurationReadModel["variants"][number];

export function optionLabel(name: ProductVariantOptionName): string {
  return optionChoices.find(([optionName]) => optionName === name)?.[1] ?? name;
}

/** "Cor: Azul · Tamanho: M" for a configured variant; "Variante padrão" for the one every product starts with. */
export function variantLabel(
  variant: ProductVariantReadModel,
  index: number
): string {
  if (variant.isDefault && variant.values.length === 0) {
    return "Variante padrão";
  }
  return (
    variant.values
      .map(
        (value) => `${optionLabel(value.optionName)}: ${value.optionValueName}`
      )
      .join(" · ") || `Variante ${index + 1}`
  );
}

export function parseOptionValues(lines: string): string[] {
  return lines
    .split(optionValueLineBreak)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function optionValuesError(values: string[]): string | null {
  if (values.length === 0) {
    return "Informe ao menos um valor, um por linha.";
  }
  if (
    new Set(values.map((value) => value.toLowerCase())).size !== values.length
  ) {
    return "Remova valores repetidos nesta opção.";
  }
  return null;
}

export function selectedOptionNames(
  selectedOptions: ProductVariantOptionName[]
): ProductVariantOptionName[] {
  return optionChoices
    .map(([name]) => name)
    .filter((name) => selectedOptions.includes(name));
}

export function productOptionValues(
  valueLines: Record<ProductVariantOptionName, string>
): Record<ProductVariantOptionName, string[]> {
  return {
    color: parseOptionValues(valueLines.color),
    model: parseOptionValues(valueLines.model),
    size: parseOptionValues(valueLines.size),
  };
}

export function validateVariantDrafts(
  optionNames: ProductVariantOptionName[],
  optionValues: Record<ProductVariantOptionName, string[]>,
  variants: VariantDraft[]
) {
  const invalidOptions = optionNames.filter((name) =>
    optionValuesError(optionValues[name])
  );
  const completeVariants = variants.every((variant) => {
    const keys = Object.keys(variant.values).filter((name) =>
      optionNames.includes(name as ProductVariantOptionName)
    );
    return (
      keys.length === optionNames.length &&
      optionNames.every((name) => {
        const value = variant.values[name];
        return typeof value === "string" && optionValues[name].includes(value);
      })
    );
  });
  // a row still missing a value repeats nothing: only rows with every value chosen are compared
  const combinationKeys = variants.flatMap((variant) => {
    const chosen = optionNames.map((name) =>
      (variant.values[name] ?? "").trim().toLowerCase()
    );
    return chosen.every(Boolean) ? [JSON.stringify(chosen)] : [];
  });
  const combinationsAreUnique =
    new Set(combinationKeys).size === combinationKeys.length;

  return {
    canAdd:
      optionNames.length > 0 &&
      invalidOptions.length === 0 &&
      variants.length < MAX_VARIANTS,
    canSubmit:
      optionNames.length > 0 &&
      invalidOptions.length === 0 &&
      variants.length > 0 &&
      variants.length <= MAX_VARIANTS &&
      completeVariants &&
      combinationsAreUnique,
    combinationsAreUnique,
    invalidOptions,
  };
}

export function variantErrorMessage(error: unknown, subject?: string): string {
  const unaccepted = legalAcceptanceMessage(error, subject);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Não foi possível carregar ou salvar as variantes.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Revise os valores e as combinações informadas.";
  }
  if (code === "NOT_FOUND") {
    return "O produto não existe mais nesta loja.";
  }
  if (code === "CONFLICT") {
    return "O produto mudou ou as variantes já foram configuradas. Confira as variantes e tente novamente.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível carregar ou salvar as variantes. Tente novamente.";
}

/** The server's reason for a SKU that another variant of the organization already has (`duplicate_sku`). */
export function isDuplicateSkuError(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "duplicate_sku"
  );
}

/** Said at the field that was typed, naming the SKU (U-14): never mixed with "the product changed". */
export function duplicateSkuMessage(sku: string): string {
  return `O SKU ${sku.trim()} já está em uso por outra variante. Use outro código.`;
}

export function variantSkuErrorMessage(error: unknown): string {
  if (rpcErrorCode(error) === "CONFLICT") {
    return "O produto mudou. Atualize as variantes antes de tentar novamente.";
  }
  return variantErrorMessage(error);
}
