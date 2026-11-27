/** The h1 of a screen: one wrap rule for every title, so a long word breaks with a hyphen (`lang` of the page is pt-BR) before it breaks by letter. Kept in `ui/` so the gallery, which cannot import a screen, writes the same title. */
export const H1_CLASS =
  "min-w-0 text-title [overflow-wrap:anywhere] hyphens-auto";

/** The h2 of a screen drawn as a tab: same wrap rule as the title. */
export const H2_CLASS =
  "min-w-0 text-section [overflow-wrap:anywhere] hyphens-auto";
