import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * What the Tabs of a list screen promise to the keyboard and to the screen reader: a `tablist` with a name,
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

/**
 * The same promise for the tabs of a screen (the `ScreenTabList`): the arrows and Home/End move the focus among the
 * tabs and Enter or Space opens the one in focus, because the panel of a tab is a screen that loads when it opens.
 * `names` is every tab of the list, in order, the first one open.
 */
export async function expectScreenTabsKeyboard(
  page: Page,
  listName: string,
  names: readonly string[]
) {
  const list = page.getByRole("tablist", { name: listName });
  const tab = (name: string) => list.getByRole("tab", { exact: true, name });
  const first = names[0] ?? "";
  const last = names.at(-1) ?? "";
  const second = names[1] ?? "";

  await expect(tab(first)).toHaveAttribute("aria-selected", "true");
  await expect(tab(first)).toHaveAttribute("tabindex", "0");
  await expect(tab(second)).toHaveAttribute("tabindex", "-1");

  await tab(first).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(second)).toBeFocused();
  await expect(tab(second), "a seta só move o foco").toHaveAttribute(
    "aria-selected",
    "false"
  );
  await page.keyboard.press("Enter");
  await expect(tab(second)).toHaveAttribute("aria-selected", "true");
  await expect(tab(first)).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("End");
  await expect(tab(last)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(first)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(first)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tab(last), "a seta volta ao fim da lista").toBeFocused();
  await page.keyboard.press("Space");
  await expect(tab(last)).toHaveAttribute("aria-selected", "true");
}
