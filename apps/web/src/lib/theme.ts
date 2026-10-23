/**
 * Light, dark or automatic (ADR 0103, "Tema e CSP"): the only effect is the `dark` class on `<html>`,
 * never an injected `<style>`. The choice is a word of a closed list in localStorage (`polaris-tema`),
 * read against that list; anything else, or no storage at all, means following the system. The same
 * rule runs before the first paint in `public/theme-init.js` (no inline script under the CSP), and
 * theme.test.ts runs that file against this one.
 */
export const THEME_STORAGE_KEY = "polaris-tema";
export const THEMES = ["sistema", "claro", "escuro"] as const;
export type Theme = (typeof THEMES)[number];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseTheme(value: string | null | undefined): Theme {
  return THEMES.find((theme) => theme === value) ?? "sistema";
}

export function themeIsDark(theme: Theme, systemPrefersDark: boolean) {
  return theme === "escuro" || (theme === "sistema" && systemPrefersDark);
}

export function readTheme(storage: Pick<Storage, "getItem"> | undefined) {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    // storage refused (private mode, policy): follow the system
    return "sistema";
  }
}

export function saveTheme(
  storage: Pick<Storage, "removeItem" | "setItem"> | undefined,
  theme: Theme
) {
  try {
    if (theme === "sistema") {
      storage?.removeItem(THEME_STORAGE_KEY);
    } else {
      storage?.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // the choice lasts until the page closes
  }
}

/** `window.localStorage`, or nothing where even reaching it throws (storage blocked by the browser). */
export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const systemDarkQuery = () => window.matchMedia(DARK_QUERY);

const SYSTEM_MEDIA = {
  claro: "(prefers-color-scheme: light)",
  escuro: DARK_QUERY,
} as const;

/**
 * The media of each `theme-color` meta of index.html (`data-tema`): with the system, each follows its scheme; with a
 * theme chosen, only its own applies, so the bar of the browser has the color of the page.
 */
export function themeColorMedia(theme: Theme, meta: "claro" | "escuro") {
  if (theme === "sistema") {
    return SYSTEM_MEDIA[meta];
  }
  return theme === meta ? "all" : "not all";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    "dark",
    themeIsDark(theme, systemDarkQuery().matches)
  );
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"][data-tema]'
  )) {
    const own = meta.dataset.tema === "escuro" ? "escuro" : "claro";
    meta.media = themeColorMedia(theme, own);
  }
}

/** The part of a `MediaQueryList` that follows the system; a test gives its own. */
interface SystemQuery {
  addEventListener: (type: "change", listener: () => void) => void;
  matches: boolean;
  removeEventListener: (type: "change", listener: () => void) => void;
}

/**
 * Keeps the `dark` class in step with the system while the page is open (U-40): `theme-init.js` reads the
 * system once, at load, so a system that went back to light would leave the class on and the screen half
 * dark. Reads the stored choice again at each change, so "claro" and "escuro" stay as chosen. Returns
 * the function that stops listening.
 */
export function followSystemTheme(
  query: SystemQuery = systemDarkQuery(),
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
  root: Pick<Element, "classList"> = document.documentElement
): () => void {
  const follow = () =>
    root.classList.toggle(
      "dark",
      themeIsDark(readTheme(storage), query.matches)
    );
  query.addEventListener("change", follow);
  return () => query.removeEventListener("change", follow);
}
