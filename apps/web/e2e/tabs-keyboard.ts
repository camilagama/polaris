import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * What the Tabs of a list screen promise to the keyboard and to the screen reader (t300): a `tablist` with a name,
 * `tab`s with the chosen one `aria-selected`, Tab stops only on the chosen one, the arrows move to the neighbour
 * and choose it, and Tab leaves the group. `first` is the tab the screen opens on, `second` the one next to it.
 */
export async function expectTabsKeyboard(
  page: Page,
  listName: string,
  [first, second]: readonly [string, string]
) {
  const list = page.getByRole("tablist", { name: listName });
  const one = list.getByRole("tab", { exact: true, name: first });
  const two = list.getByRole("tab", { exact: true, name: second });

  // read as "aba, selecionada": the role and the state, and no leftover of the toggle buttons
  await expect(one).toHaveAttribute("aria-selected", "true");
  await expect(two).toHaveAttribute("aria-selected", "false");
  await expect(list.locator("[aria-pressed]")).toHaveCount(0);
  // only the chosen tab is a stop of Tab
  await expect(one).toHaveAttribute("tabindex", "0");
  await expect(two).toHaveAttribute("tabindex", "-1");

  await one.focus();
  await page.keyboard.press("ArrowRight");
  await expect(two).toBeFocused();
  await expect(two).toHaveAttribute("aria-selected", "true");
  await expect(one).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("ArrowLeft");
  await expect(one).toBeFocused();
  await expect(one).toHaveAttribute("aria-selected", "true");

  // Tab leaves the group, it does not walk through the tabs
  await page.keyboard.press("Tab");
  await expect(list.locator(":focus")).toHaveCount(0);
}
