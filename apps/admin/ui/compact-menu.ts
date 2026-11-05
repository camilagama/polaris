/**
 * The ☰ of a narrow screen is a native `<details>` (the page has no framework and its policy no inline style), which
 * closes only by the same tap. A menu that covers the page also closes with Esc, giving the focus back to the ☰ unless it
 * is on a control outside the menu, and by a tap anywhere outside it (the focus stays where the person tapped).
 */

const COMPACT_MENU_SELECTOR = "details.compact-menu";

function openMenus(page: Document): HTMLDetailsElement[] {
  return [
    ...page.querySelectorAll<HTMLDetailsElement>(COMPACT_MENU_SELECTOR),
  ].filter((menu) => menu.open);
}

export function closeCompactMenuOnEscapeAndOutsideTap(page: Document): void {
  page.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    const focused = page.activeElement;
    for (const menu of openMenus(page)) {
      menu.open = false;
      const elsewhere =
        focused !== null && focused !== page.body && !menu.contains(focused);
      if (!elsewhere) {
        menu.querySelector("summary")?.focus();
      }
    }
  });
  page.addEventListener("pointerdown", (event) => {
    for (const menu of openMenus(page)) {
      if (!menu.contains(event.target as Node | null)) {
        menu.open = false;
      }
    }
  });
}
