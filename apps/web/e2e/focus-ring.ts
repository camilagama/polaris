import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * The focus of the keyboard (t439, DESIGN.md "Acessibilidade"): the 3 px outline in `--ring`. The elements that take
 * the focus by code (a heading after a removal, the notice of a result, the confirmation of a row) are not stops of
 * Tab, so the test gets there the way a person does: it activates the control with the keyboard (Enter on the focused
 * button), and the browser then draws `:focus-visible` on what the code focuses next.
 */
export async function activateByKeyboard(page: Page, control: Locator) {
  await control.focus();
  await page.keyboard.press("Enter");
}

/** What the page draws on the element that has the focus now: a solid outline of 3 px, in a color that shows. */
export async function expectFocusRing(target: Locator) {
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS("outline-style", "solid");
  await expect(target).toHaveCSS("outline-width", "3px");
  await expect(target).not.toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
  expect(
    await target.evaluate((element) => element.matches(":focus-visible"))
  ).toBe(true);
}

/** The same, for the element that holds the focus, when the test knows it by what it contains (the dialog of the sidebar). */
export async function expectActiveElementRing(page: Page) {
  const ring = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return null;
    }
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      focusVisible: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
  expect(ring).toMatchObject({
    focusVisible: true,
    style: "solid",
    width: "3px",
  });
  expect(ring?.color).not.toBe("rgba(0, 0, 0, 0)");
}
