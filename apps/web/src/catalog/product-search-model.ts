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

const NAME_SPACES = /[ \t\n\v\f\r]+/g;
const NAME_EDGE_SPACE = /^ | $/g;

/**
 * The name as the unique-name rule of the catalog compares it: no difference of case or of repeated spaces, none at
 * the ends (the database collapses the ASCII spaces, so a no-break space is a character of the name).
 */
export function deleteNameKey(name: string): string {
  return name
    .replace(NAME_SPACES, " ")
    .replace(NAME_EDGE_SPACE, "")
    .toLowerCase();
}

/** Whether what was typed names the product: only then the button works. */
export function typedNameMatches(typed: string, name: string): boolean {
  const key = deleteNameKey(typed);
  return key !== "" && key === deleteNameKey(name);
}
