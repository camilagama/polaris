import type { Locator, Page } from "@playwright/test";

/**
 * The editor of a pill of the filter bar is the form Dialog of the whole screen below 760 px (`PHONE_QUERY` of
 * `src/ui/dialog-history.ts`) and a Popover from there: the tests that edit a pill by touch say so here, once.
 */
const PHONE_WIDTH = 760;

export const onPhone = (page: Page) =>
  (page.viewportSize()?.width ?? PHONE_WIDTH) < PHONE_WIDTH;

/** Applies what was touched in the Dialog of a phone; the Popover applied by the touch itself, so there is nothing to do. */
export async function applyEditor(page: Page, editor: Locator) {
  if (onPhone(page)) {
    await editor.getByRole("button", { exact: true, name: "Aplicar" }).click();
  }
}
