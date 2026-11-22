/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** The viewports every form is proven at (the phone and the desktop of the plan). */
export const FORM_VIEWPORTS = [
  { height: 740, name: "360", width: 360 },
  { height: 800, name: "1280", width: 1280 },
] as const;

/** The button of a picker: its accessible name is the label, a comma and what the button shows. */
export const datePickerButton = (scope: Locator | Page, label: string) =>
  scope.getByRole("button", { name: `${label},` });

/** Opens the picker of `label` and waits for its calendar (the chunk comes on demand). */
export async function openDatePicker(scope: Locator | Page, label: string) {
  const page = "page" in scope ? scope.page() : scope;
  await datePickerButton(scope, label).click();
  const popup = page.getByRole("dialog", { name: label });
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

/**
 * Walks the calendar month by month until `iso` is in view, then touches it; `force` touches a day that is turned off
 * (aria-disabled), which Playwright otherwise waits on for good.
 */
export async function touchDay(
  popup: Locator,
  iso: string,
  options: { force?: boolean } = {}
) {
  const target = popup.locator(`button[data-day="${iso}"]`);
  // biome-ignore lint/performance/noAwaitInLoops: one month after the other, until the day is in view
  for (let step = 0; step < 48 && (await target.count()) === 0; step += 1) {
    const shown = await popup
      .locator("button[data-day]")
      .first()
      .getAttribute("data-day");
    const back = shown !== null && iso < shown;
    await popup
      .getByRole("button", { name: back ? "Mês anterior" : "Próximo mês" })
      .click();
  }
  await target.click(options);
}

/** Opens one date's picker, touches the day and waits for the popover to close. */
export async function pickDate(
  scope: Locator | Page,
  label: string,
  iso: string
) {
  const popup = await openDatePicker(scope, label);
  await touchDay(popup, iso);
  await expect(popup).toBeHidden();
}

/** Opens a period's picker and touches its two days (the popover closes on the second). */
export async function pickPeriod(
  scope: Locator | Page,
  label: string,
  first: string,
  second: string
) {
  const popup = await openDatePicker(scope, label);
  await touchDay(popup, first);
  await touchDay(popup, second);
  await expect(popup).toBeHidden();
}

const TYPE_DATES_BUTTON = /Digitar as datas/;

/** The panel of a period has no button to type the dates and no text field, whatever the width. */
export async function expectNoTypedDates(popup: Locator) {
  await expect(
    popup.getByRole("button", { name: TYPE_DATES_BUTTON })
  ).toHaveCount(0);
  await expect(popup.getByRole("textbox")).toHaveCount(0);
  await expect(popup.locator("[aria-expanded]")).toHaveCount(0);
}

/**
 * The height of what the period panel holds, from the top of the shortcuts to the bottom of the line under the month
 * (the panel itself is `display: contents` on a phone, and the Dialog around it has the height of the screen). Read from
 * the layout (offsets), which the scale of the entrance animation does not touch.
 */
export async function panelHeight(popup: Locator) {
  return await popup.evaluate((root) => {
    const shortcuts = root.querySelector<HTMLElement>(
      'fieldset[aria-label="Atalhos do período"]'
    );
    const footer = root.querySelector('p[aria-live="polite"]')?.parentElement
      ?.parentElement?.parentElement;
    if (!(shortcuts && footer instanceof HTMLElement)) {
      throw new Error("o painel do período não tem atalhos ou rodapé");
    }
    if (shortcuts.offsetParent !== footer.offsetParent) {
      throw new Error("atalhos e rodapé não medem do mesmo ponto");
    }
    return footer.offsetTop + footer.offsetHeight - shortcuts.offsetTop;
  });
}
