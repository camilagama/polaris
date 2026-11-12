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

/** Walks the calendar month by month until `iso` is in view, then touches it. */
export async function touchDay(popup: Locator, iso: string) {
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
  await target.click();
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

/**
 * With "Digitar as datas" open the month keeps its six weeks and no box of its own scrolls: what does not fit is
 * reached by scrolling the panel as a whole, and the last week can be brought into view.
 */
export async function expectWholeMonthWhileTyping(popup: Locator) {
  const month = popup.locator("[data-range-month]");
  const { clientHeight, scrollHeight } = await month.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);
  const rows = popup.getByRole("grid").first().getByRole("row");
  await expect(rows).toHaveCount(6);
  const lastWeek = rows.last();
  await lastWeek.scrollIntoViewIfNeeded();
  await expect(lastWeek).toBeInViewport({ ratio: 1 });
}
