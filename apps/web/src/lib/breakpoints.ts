/**
 * The lines where the app changes layout, in `rem` like the CSS (`--breakpoint-md` of `theme.css`, `lg:` of Tailwind).
 * In a media query `rem` is the browser's default font size, not the `font-size` of `<html>`: with the text size of
 * the system raised, the CSS and these queries cross the line at the same width, which a `px` query would not.
 * With the default 16 px the lines are 760 and 1024 px.
 */

/** 760 px, `md` of Tailwind and the `touch` variant: the exact complement of `md:`, so no width is in neither. */
export const PHONE_QUERY = "not all and (min-width: 47.5rem)";

/** 1024 px: from here the sidebar may fold to its icons (map of navigation, § 5). */
export const COLLAPSIBLE_QUERY = "(min-width: 64rem)";
