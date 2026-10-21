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

export const systemDarkQuery = () => window.matchMedia(DARK_QUERY);

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    "dark",
    themeIsDark(theme, systemDarkQuery().matches)
  );
}
