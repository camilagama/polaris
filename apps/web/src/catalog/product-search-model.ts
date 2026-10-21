const COMBINING_MARKS = /\p{M}/gu;

/** Lower case and without accents: "Calça" is found by "calca" and by "CALÇ". */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .trim();
}

/** The products whose name has the typed text (an empty text keeps them all), in the order they came. */
export function filterByName<T extends { name: string }>(
  products: readonly T[],
  query: string
): T[] {
  const key = searchKey(query);
  if (key === "") {
    return [...products];
  }
  return products.filter((product) => searchKey(product.name).includes(key));
}

/** The two letters of the circle of a product: the first two of its name ("Calça jeans" → "CA"). */
export function productInitials(name: string): string {
  return Array.from(name.trim())
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase("pt-BR");
}
