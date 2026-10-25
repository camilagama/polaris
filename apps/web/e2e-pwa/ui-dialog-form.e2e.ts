/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The form layout of the Dialog (DESIGN.md, "Diálogo de formulário"), in the gallery: what the primitive promises to
 * every form that uses it. Below 760 px it is the whole screen with the header and the footer fixed and only the body
 * scrolling; from 760 px it is the centred dialog. Focus is trapped, Esc closes, the focus goes back to the trigger,
 * and the title is the name of the dialog. The class contract is in `scripts/ui-dialog-layout.test.ts`.
 */
const TRIGGER = { name: "Abrir formulário" };
const DIALOG = { name: "Novo cadastro" };

async function openForm(page: Page) {
  await page.goto("/ui-galeria");
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", TRIGGER).click();
  const dialog = page.getByRole("dialog", DIALOG);
  await expect(dialog).toBeVisible();
  return dialog;
}

const focusIsInDialog = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest("[role=dialog]") !== null
  );

/** The box of an element, in the viewport. */
async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  if (!found) {
    throw new Error(`${selector} has no box`);
  }
  return found;
}

for (const width of [360, 1280]) {
  test(`${width} px: papel, título, foco preso, Esc e retorno do foco`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width });
    const dialog = await openForm(page);

    // a modal dialog, named by its title and described by the line under it
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAccessibleName("Novo cadastro");
    await expect(dialog).toHaveAccessibleDescription(
      "No celular ocupa a tela inteira; só o meio rola."
    );
    // the focus went in: the first field, before the "Fechar" that sits last in the order
    await expect(dialog.getByLabel("Campo 1")).toBeFocused();

    // Tab never leaves the dialog, forwards or backwards (Base UI's focus guards hand the focus back at once)
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let step = 0; step < 14; step += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one key after the other, the focus is read after each
        await page.keyboard.press(key);
        await expect.poll(() => focusIsInDialog(page)).toBe(true);
      }
    }

    // Esc closes and the focus goes back to what opened it
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", TRIGGER)).toBeFocused();
  });
}

test("o clique no véu não fecha o formulário", async ({ page }) => {
  await page.setViewportSize({ height: 740, width: 1280 });
  const dialog = await openForm(page);
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
});

test("360 px: tela inteira, cabeçalho e rodapé presos, só o meio rola", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  const dialog = await openForm(page);
  const popup = await dialog.boundingBox();
  expect(popup).toMatchObject({ height: 740, width: 360, x: 0, y: 0 });

  const body = page.locator("[data-slot=dialog-body]");
  const scrolls = await body.evaluate(
    (element) => element.scrollHeight > element.clientHeight
  );
  expect(scrolls).toBe(true);

  const header = await box(page, "[data-slot=dialog-header]");
  const footer = await box(page, "[data-slot=dialog-footer]");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // the header and the footer did not move with the scroll
  expect(await box(page, "[data-slot=dialog-header]")).toEqual(header);
  expect(await box(page, "[data-slot=dialog-footer]")).toEqual(footer);
  expect(footer.y + footer.height).toBeCloseTo(740, 0);
  // nothing scrolls but the body: the page under the veil and the dialog itself stay
  expect(
    await dialog.evaluate(
      (element) => element.scrollHeight - element.clientHeight
    )
  ).toBeLessThanOrEqual(0);

  // the main button is last in the order and on top in the column: the way out is under it
  const save = await box(page, "[data-slot=dialog-footer] button[type=submit]");
  const cancel = await dialog
    .getByRole("button", { name: "Cancelar" })
    .boundingBox();
  expect(cancel?.y ?? 0).toBeGreaterThan(save.y);
});

test("360 px com o teclado aberto (viewport baixo): o botão principal continua à vista e o meio rola", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  const dialog = await openForm(page);
  // the keyboard of a phone takes about half of the height: the window gets that much shorter
  await page.setViewportSize({ height: 380, width: 360 });

  const save = dialog.getByRole("button", { name: "Salvar" });
  await expect(save).toBeInViewport({ ratio: 1 });
  // the dialog follows the visual viewport: its height is the one the browser reports, set as a custom property
  await expect
    .poll(() =>
      dialog.evaluate((element) => ({
        height: element.style.getPropertyValue("--dialog-height"),
        top: element.style.getPropertyValue("--dialog-top"),
      }))
    )
    .toEqual({ height: "380px", top: "0px" });
  // the box follows the visible part of the window once the browser says it shrank
  await expect
    .poll(async () => {
      const footer = await box(page, "[data-slot=dialog-footer]");
      return footer.y + footer.height;
    })
    .toBeLessThanOrEqual(380);

  // the field in the middle is reached by scrolling the body, and the footer stays
  const last = dialog.getByLabel("Campo 8");
  await last.focus();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
});

test("1280 px: diálogo central e largo, com rodapé à direita", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  const dialog = await openForm(page);
  const popup = await dialog.boundingBox();
  expect(popup?.width).toBe(704);
  expect(popup?.x).toBeCloseTo((1280 - 704) / 2, 0);
  // the veil is still there and the dialog is not the whole screen
  expect(popup?.height ?? 0).toBeLessThan(800);

  const cancel = await dialog
    .getByRole("button", { name: "Cancelar" })
    .boundingBox();
  const save = await dialog
    .getByRole("button", { name: "Salvar" })
    .boundingBox();
  // side by side, "Cancelar" first and "Salvar" at the right end
  expect(cancel?.y).toBeCloseTo(save?.y ?? 0, 0);
  expect(cancel?.x ?? 0).toBeLessThan(save?.x ?? 0);
  expect((save?.x ?? 0) + (save?.width ?? 0)).toBeCloseTo(
    (popup?.x ?? 0) + (popup?.width ?? 0) - 16,
    0
  );
});
