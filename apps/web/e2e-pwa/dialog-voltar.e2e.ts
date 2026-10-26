/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The step back of a phone closes the form dialog (DESIGN.md, "Diálogo de formulário"), in the gallery: one dialog,
 * one opened over another, the ways a dialog closes by itself (which take its entry out, so no step back that does
 * nothing is left), and what does not change (the small dialog, the desktop). Run by the `chromium-celular` project:
 * a phone of 360×740. The same on a real screen, with its draft, the fresh tab, the reload and the dialog opened by the
 * address: `e2e/goals.e2e.ts`. The stack itself: `src/ui/dialog-history.test.ts`.
 */
const FORM = { name: "Novo cadastro" };
const OTHER = { name: "Outro cadastro" };
const GALLERY = /\/ui-galeria$/;

/** The gallery, opened after another page: a step back that leaves the screen lands there. */
async function openGallery(page: Page) {
  await page.goto("/termos");
  await page.goto("/ui-galeria");
  await page.evaluate(() => document.fonts.ready);
}

const historyLength = (page: Page) => page.evaluate(() => history.length);

async function openForm(page: Page) {
  await page.getByRole("button", { name: "Abrir formulário" }).click();
  const dialog = page.getByRole("dialog", FORM);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The step back after the dialogs closed leaves the gallery for the page before it. */
async function expectNextStepBackLeaves(page: Page) {
  await page.goBack();
  await expect(page).not.toHaveURL(GALLERY);
}

test("um Dialog: o voltar fecha, guarda o que foi digitado, devolve o foco e o voltar seguinte sai", async ({
  page,
}) => {
  await openGallery(page);
  const before = await historyLength(page);
  const dialog = await openForm(page);
  // the entry of the dialog, at the same address
  expect(await historyLength(page)).toBe(before + 1);
  await expect(page).toHaveURL(GALLERY);
  await dialog.getByLabel("Campo 1").fill("Camiseta azul");

  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(GALLERY);
  await expect(
    page.getByRole("button", { name: "Abrir formulário" })
  ).toBeFocused();

  // the draft is there when it opens again
  await openForm(page);
  await expect(page.getByLabel("Campo 1")).toHaveValue("Camiseta azul");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNextStepBackLeaves(page);
});

for (const close of ["Esc", "×", "Cancelar"] as const) {
  test(`${close} fecha o Dialog e retira a entrada: o voltar seguinte sai da tela`, async ({
    page,
  }) => {
    await openGallery(page);
    const dialog = await openForm(page);
    if (close === "Esc") {
      await page.keyboard.press("Escape");
    } else {
      await dialog
        .getByRole("button", {
          exact: true,
          name: close === "×" ? "Fechar" : "Cancelar",
        })
        .click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Abrir formulário" })
    ).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => history.state?.polarisDialog ?? null))
      .toBeNull();
    await expectNextStepBackLeaves(page);
  });
}

test("dois Dialogs: o voltar fecha só o de cima, o de baixo fica com o rascunho, e o segundo voltar fecha o de baixo", async ({
  page,
}) => {
  await openGallery(page);
  const before = await historyLength(page);
  const form = await openForm(page);
  await form.getByLabel("Campo 1").fill("Camiseta azul");
  const openOther = form.getByRole("button", {
    name: "Abrir outro formulário",
  });
  await openOther.click();
  const other = page.getByRole("dialog", OTHER);
  await expect(other).toBeVisible();
  expect(await historyLength(page)).toBe(before + 2);
  await other.getByLabel("Observação").fill("Entregar sexta");

  await page.goBack();
  await expect(other).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Campo 1")).toHaveValue("Camiseta azul");
  await expect(openOther).toBeFocused();

  // the one on top opens again with its draft, and Esc closes it alone
  await openOther.click();
  await expect(other.getByLabel("Observação")).toHaveValue("Entregar sexta");
  await page.keyboard.press("Escape");
  await expect(other).toHaveCount(0);
  await expect(form).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(GALLERY);
  await expect(
    page.getByRole("button", { name: "Abrir formulário" })
  ).toBeFocused();
  await openForm(page);
  await expect(page.getByLabel("Campo 1")).toHaveValue("Camiseta azul");
  await page.keyboard.press("Escape");
  await expectNextStepBackLeaves(page);
});

test("o diálogo pequeno (uma confirmação) não mexe no histórico", async ({
  page,
}) => {
  await openGallery(page);
  const before = await historyLength(page);
  await page.getByRole("button", { name: "Abrir diálogo" }).click();
  await expect(
    page.getByRole("dialog", { name: "Cancelar a venda?" })
  ).toBeVisible();
  expect(await historyLength(page)).toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await historyLength(page)).toBe(before);
});

test("a partir de 760 px o Dialog de formulário não mexe no histórico", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await openGallery(page);
  const before = await historyLength(page);
  await openForm(page);
  expect(await historyLength(page)).toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await historyLength(page)).toBe(before);
});
