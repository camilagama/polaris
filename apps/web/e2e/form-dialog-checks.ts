/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * What every form that opens in the form dialog promises (DESIGN.md, "Diálogo de formulário"), measured the same way
 * for each of them at the two widths of the task: 360 px, where the dialog is the whole screen with the header and the
 * footer fixed, and 1280 px, where it is the centred dialog of 704 px. The primitive itself is proved in
 * `e2e-pwa/ui-dialog-form.e2e.ts`; here is what each screen made of it.
 */
export const FORM_WIDTHS = [360, 1280] as const;
const PHONE_HEIGHT = 740;
const DESKTOP_HEIGHT = 800;
/** The window with the keyboard of a phone open: about half of the height is left. */
const KEYBOARD_HEIGHT = 380;
const DIALOG_WIDTH = 704;

const heightFor = (width: number) =>
  width < 760 ? PHONE_HEIGHT : DESKTOP_HEIGHT;

/** The size of the window the test opens the screen in. */
export const sizeFor = (width: number) => ({
  height: heightFor(width),
  width,
});

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) {
    throw new Error("the element has no box");
  }
  return found;
}

/**
 * The dialog is where the width says: the whole screen at 360 px, 704 px wide and centred at 1280 px. It has a header
 * with the title, a footer with the main button, and a body between them; the footer is at the bottom edge on the
 * phone and the main button is the last of the footer.
 */
export async function expectFormDialogLayout(dialog: Locator, width: number) {
  const popup = await box(dialog);
  const height = heightFor(width);
  if (width < 760) {
    expect(popup).toMatchObject({ height, width, x: 0, y: 0 });
  } else {
    expect(popup.width).toBe(DIALOG_WIDTH);
    expect(popup.x).toBeCloseTo((width - DIALOG_WIDTH) / 2, 0);
    expect(popup.height).toBeLessThan(height);
  }
  const header = await box(dialog.locator("[data-slot=dialog-header]"));
  const footer = await box(dialog.locator("[data-slot=dialog-footer]"));
  const body = await box(dialog.locator("[data-slot=dialog-body]"));
  expect(header.y).toBeLessThan(body.y);
  expect(body.y + body.height).toBeLessThanOrEqual(footer.y + 1);
  if (width < 760) {
    expect(footer.y + footer.height).toBeCloseTo(height, 0);
  }
  await expect(dialog).toHaveAttribute("aria-modal", "true");
}

/**
 * With the keyboard of a phone open (a window about half as tall) the main button is still on the screen, and the
 * middle is what scrolls: the footer does not move when the body is scrolled to its end. Back to the height it had
 * when it is done.
 */
export async function expectKeyboardKeepsMainButton(
  page: Page,
  dialog: Locator,
  main: Locator
) {
  await page.setViewportSize({ height: KEYBOARD_HEIGHT, width: 360 });
  await expect
    .poll(async () => {
      const footer = await box(dialog.locator("[data-slot=dialog-footer]"));
      return footer.y + footer.height;
    })
    .toBeLessThanOrEqual(KEYBOARD_HEIGHT);
  await expect(main).toBeInViewport({ ratio: 1 });

  const body = dialog.locator("[data-slot=dialog-body]");
  const footerBefore = await box(dialog.locator("[data-slot=dialog-footer]"));
  const scrolled = await body.evaluate((element) => {
    const overflows = element.scrollHeight > element.clientHeight;
    element.scrollTop = element.scrollHeight;
    return { overflows, top: element.scrollTop };
  });
  // a form taller than the window scrolls in its body; one that fits has nothing to scroll
  if (scrolled.overflows) {
    expect(scrolled.top).toBeGreaterThan(0);
  }
  expect(await box(dialog.locator("[data-slot=dialog-footer]"))).toEqual(
    footerBefore
  );
  await expect(main).toBeInViewport({ ratio: 1 });
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.setViewportSize({ height: PHONE_HEIGHT, width: 360 });
}
