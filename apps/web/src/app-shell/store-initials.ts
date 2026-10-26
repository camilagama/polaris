const EMAIL_DOMAIN = /@.*$/;
const WORD_BREAK = /[\s._-]+/;

/**
 * The letters of the tile: the first of the first and of the last word of the store ("Loja da Clara" is "LC", as in the
 * v7 mockup), or of the part of the e-mail before the @.
 */
export function storeInitials(name: string): string {
  const words = name
    .replace(EMAIL_DOMAIN, "")
    .split(WORD_BREAK)
    .filter((word) => word.length > 0);
  const ends = words.length > 1 ? [words[0], words.at(-1)] : words;
  return ends
    .map((word) => (word ?? "").charAt(0).toLocaleUpperCase("pt-BR"))
    .join("");
}
