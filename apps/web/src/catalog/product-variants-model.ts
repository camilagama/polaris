import type {
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import {
  MAX_PRODUCT_OPTION_VALUE_LENGTH,
  MAX_PRODUCT_VARIANT_SKU_LENGTH,
} from "@polaris/domain/catalog/product";
import {
  CHANGE_FAULT_UNKNOWN,
  commonFailureMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import { isLimitReached } from "../subscription/limit-help-model";

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

const emptyValueLines: Record<ProductVariantOptionName, string> = {
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

/** Counted in code points, like the domain: an emoji is one character, not the two UTF-16 units of `.length`. */
function characterCount(text: string): number {
  return [...text].length;
}

/** The SKU over its limit, said at the field with the count of now; `null` within it. The domain trims it first. */
export function skuLengthError(sku: string): string | null {
  const count = characterCount(sku.trim());
  return count > MAX_PRODUCT_VARIANT_SKU_LENGTH
    ? `Use até ${MAX_PRODUCT_VARIANT_SKU_LENGTH} caracteres. Agora são ${count}.`
    : null;
}

function hasTooLongOptionValue(values: string[]): boolean {
  return values.some(
    (value) => characterCount(value) > MAX_PRODUCT_OPTION_VALUE_LENGTH
  );
}

const SHOWN_LONG_LINES = 3;

function listedLines(lines: number[]): string {
  const shown = lines.slice(0, SHOWN_LONG_LINES);
  const rest = lines.length - shown.length;
  if (rest > 0) {
    return `${shown.join(", ")} e mais ${rest}`;
  }
  return shown.length > 1
    ? `${shown.slice(0, -1).join(", ")} e ${shown.at(-1)}`
    : `${shown[0]}`;
}

/** The lines of the textarea over the limit, by the number the person sees (blank lines count); `null` within it. */
export function optionValueLengthError(lines: string): string | null {
  const counts = lines
    .split(optionValueLineBreak)
    .map((line) => characterCount(line.trim()));
  const tooLong = counts.flatMap((count, index) =>
    count > MAX_PRODUCT_OPTION_VALUE_LENGTH ? [index + 1] : []
  );
  const [only] = tooLong;
  if (only === undefined) {
    return null;
  }
  const prefix = `Use até ${MAX_PRODUCT_OPTION_VALUE_LENGTH} caracteres por valor.`;
  return tooLong.length === 1
    ? `${prefix} A linha ${only} tem ${counts[only - 1]}.`
    : `${prefix} As linhas ${listedLines(tooLong)} passam de ${MAX_PRODUCT_OPTION_VALUE_LENGTH}.`;
}

function hasRepeatedOptionValue(values: string[]): boolean {
  return (
    new Set(values.map((value) => value.toLowerCase())).size !== values.length
  );
}

export function optionValuesError(lines: string): string | null {
  const values = parseOptionValues(lines);
  if (values.length === 0) {
    return "Informe ao menos um valor, um por linha.";
  }
  const tooLong = optionValueLengthError(lines);
  if (tooLong) {
    return tooLong;
  }
  return hasRepeatedOptionValue(values)
    ? "Remova valores repetidos nesta opção."
    : null;
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
  const invalidOptions = optionNames.filter(
    (name) =>
      optionValues[name].length === 0 ||
      hasTooLongOptionValue(optionValues[name]) ||
      hasRepeatedOptionValue(optionValues[name])
  );
  const optionsAreReady = optionNames.length > 0 && invalidOptions.length === 0;
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
    const key = combinationKey(optionNames, variant.values);
    return key === null ? [] : [key];
  });
  const combinationsAreUnique =
    new Set(combinationKeys).size === combinationKeys.length;

  return {
    // the values over their limit: the save stays off and says why, at those fields
    tooLongOptions: optionNames.filter((name) =>
      hasTooLongOptionValue(optionValues[name])
    ),
    canAdd: optionsAreReady && variants.length < MAX_VARIANTS,
    canGenerate: optionsAreReady,
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

function combinationKey(
  optionNames: ProductVariantOptionName[],
  values: VariantDraft["values"]
): string | null {
  const chosen = optionNames.map((name) =>
    (values[name] ?? "").trim().toLowerCase()
  );
  return chosen.every(Boolean) ? JSON.stringify(chosen) : null;
}

/**
 * Every combination of the typed values (the cartesian product, in the order of the options and of the lines) that the
 * list does not have yet: a row with the same values, in any case, is not repeated.
 */
export function missingCombinations(
  optionNames: ProductVariantOptionName[],
  optionValues: Record<ProductVariantOptionName, string[]>,
  variants: VariantDraft[]
): VariantDraft[] {
  if (optionNames.length === 0) {
    return [];
  }
  let combinations: VariantDraft["values"][] = [{}];
  for (const name of optionNames) {
    combinations = combinations.flatMap((values) =>
      optionValues[name].map((value) => ({ ...values, [name]: value }))
    );
  }
  const present = new Set(
    variants.flatMap((variant) => {
      const key = combinationKey(optionNames, variant.values);
      return key === null ? [] : [key];
    })
  );
  return combinations
    .filter((values) => !present.has(combinationKey(optionNames, values) ?? ""))
    .map((values) => ({ values }));
}

export interface CombinationCap {
  max: number;
  source: "plan" | "product";
}

/** The configuration replaces the default variant, which the plan's usage already counts. */
const REPLACED_DEFAULT_VARIANT = 1;

export function combinationCap(planRoom: number | null): CombinationCap {
  if (
    planRoom === null ||
    planRoom + REPLACED_DEFAULT_VARIANT >= MAX_VARIANTS
  ) {
    return { max: MAX_VARIANTS, source: "product" };
  }
  return { max: planRoom + REPLACED_DEFAULT_VARIANT, source: "plan" };
}

export type AllCombinationsResult =
  | { kind: "added"; variants: VariantDraft[] }
  | { kind: "nothing_new" }
  | { cap: CombinationCap; kind: "over_cap"; total: number };

export function addAllCombinations(
  optionNames: ProductVariantOptionName[],
  optionValues: Record<ProductVariantOptionName, string[]>,
  variants: VariantDraft[],
  cap: CombinationCap
): AllCombinationsResult {
  const missing = missingCombinations(optionNames, optionValues, variants);
  if (missing.length === 0) {
    return { kind: "nothing_new" };
  }
  const total = variants.length + missing.length;
  if (total > cap.max) {
    return { cap, kind: "over_cap", total };
  }
  return { kind: "added", variants: [...variants, ...missing] };
}

export const ALL_COMBINATIONS_PRESENT =
  "Todas as combinações já estão na lista.";

export function overCapMessage(total: number, cap: CombinationCap): string {
  const limit =
    cap.source === "product"
      ? `o limite é ${cap.max} por produto`
      : `seu plano deixa este produto com até ${cap.max}`;
  return `Seriam ${total} combinações e ${limit}. Nenhuma foi adicionada.`;
}

export function addAllCombinationsLabel(missing: number): string {
  return missing > 0
    ? `Adicionar todas as combinações (${missing})`
    : "Adicionar todas as combinações";
}

/** The plan's active-variant limit refused the configuration (L1 of the corte 1.6): the limit, never "the product changed". */
export const VARIANT_LIMIT_REACHED =
  "Seu plano chegou ao limite de variantes. Nada foi alterado.";

export function variantErrorMessage(error: unknown, subject?: string): string {
  const common = commonFailureMessage(error, subject, {
    directWrite: subject === undefined,
  });
  if (common !== undefined) {
    return common;
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
  if (isLimitReached(error)) {
    return VARIANT_LIMIT_REACHED;
  }
  if (code === "CONFLICT") {
    return "O produto mudou ou as variantes já foram configuradas. Confira as variantes e tente novamente.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return subject === undefined
      ? CHANGE_FAULT_UNKNOWN
      : "O catálogo está temporariamente indisponível. Tente novamente.";
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

/** The button of the warning names the SKU it erases, so nobody clears a code without seeing which. */
export function clearDefaultSkuLabel(sku: string): string {
  return `Limpar SKU "${sku}" da variante padrão`;
}

/** Said after the button: the code that is gone (the field of the variant is empty and has the focus). */
export function clearedDefaultSkuNotice(sku: string): string {
  return `SKU "${sku}" apagado da variante padrão.`;
}

export function variantSkuErrorMessage(error: unknown): string {
  if (rpcErrorCode(error) === "CONFLICT") {
    return "O produto mudou. Atualize as variantes antes de tentar novamente.";
  }
  return variantErrorMessage(error);
}
