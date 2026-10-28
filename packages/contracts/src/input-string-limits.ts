/**
 * The input strings of the contract that no `.max` or `.length` bounds yet, by procedure (`product/setVariantSku.sku`),
 * exact and sorted. The rule is that every input string has one; this list only shrinks, and
 * `input-string-limits.test.ts` holds it to a baseline frozen with the 133 paths it started from. The ceiling of the
 * body of `/rpc` counts each of these as a short string (`rpc-body-limit-derivation.test.ts` reads this same list).
 */
export const STRING_LIMIT_EXCEPTIONS: readonly string[] = [
  "product/configureVariants.options[].values[]",
  "product/configureVariants.variants[].values.color",
  "product/configureVariants.variants[].values.model",
  "product/configureVariants.variants[].values.size",
  "product/setVariantSku.sku",
];
