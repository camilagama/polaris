/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * What the date pickers tell a screen reader, read from the accessibility tree of the gallery (roles, states and
 * accessible names, never classes). The names of the buttons and the error tied to the button are in
 * ui-date-pickers.e2e.ts; here: the button announces a dialog and its open state, opening moves the focus inside,
 * Escape closes and gives it back, the chosen day and today are announced, and the days of a period are checked
 * as selected, and the name of a day says its role before the state: "início do período", "fim do período" or
 * "início e fim do período" (one day, or only the start marked); a day in the middle has no role. "Hoje" is `24/10/2026` in the
 * gallery.
 */
const SELECTED = /, selecionado$/;
const TODAY_PREFIX = /^Hoje, /;
const ROLE_IN_PERIOD = /(início|fim) do período/;
const ICON_HIDDEN = "true";

async function openGallery(page: Page) {
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("region", { name: "Calendário" }).getByRole("grid")
  ).toBeVisible();
}

/** The name starts the button's: a day of a period also says "período," in its name. */
const trigger = (page: Page, name: string) =>
  page.getByRole("button", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });

const day = (scope: Locator | Page, iso: string) =>
  scope.locator(`button[data-day="${iso}"]`);

const cellOf = (button: Locator) => button.locator("xpath=..");

async function openWithKeyboard(page: Page, name: string, label: string) {
  await trigger(page, name).focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", { name: label });
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

const focusIsInside = (popup: Locator) =>
  popup.evaluate((dialog) => dialog.contains(document.activeElement));

const PICKERS = [
  { button: "Data de competência,", label: "Data de competência" },
  { button: "Data da despesa,", label: "Data da despesa" },
  { button: "Período,", label: "Período" },
  { button: "Período das vendas,", label: "Período das vendas" },
] as const;

for (const picker of PICKERS) {
  test.describe(picker.label, () => {
    test("o botão anuncia um diálogo e se está aberto, e o ícone não fala", async ({
      page,
    }) => {
      await openGallery(page);
      const button = trigger(page, picker.button);
      await expect(button).toHaveAttribute("aria-haspopup", "dialog");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(button.locator("svg")).toHaveAttribute(
        "aria-hidden",
        ICON_HIDDEN
      );
      await openWithKeyboard(page, picker.button, picker.label);
      await expect(button).toHaveAttribute("aria-expanded", "true");
    });

    test("ao abrir, o foco vai para dentro do diálogo; Esc fecha e devolve o foco ao botão", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openWithKeyboard(page, picker.button, picker.label);
      await expect.poll(() => focusIsInside(popup)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(trigger(page, picker.button)).toBeFocused();
      await expect(trigger(page, picker.button)).toHaveAttribute(
        "aria-expanded",
        "false"
      );
    });
  });
}

test.describe("DatePicker, o dia no calendário", () => {
  test("o dia escolhido é selecionado na célula e no nome, e hoje diz Hoje no nome", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Data de competência,",
      "Data de competência"
    );
    await expect(day(popup, "2026-10-24")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(popup).toBeHidden();
    const again = await openWithKeyboard(
      page,
      "Data de competência,",
      "Data de competência"
    );
    const chosen = day(again, "2026-10-23");
    await expect(cellOf(chosen)).toHaveAttribute("aria-selected", "true");
    await expect(chosen).toHaveAccessibleName(SELECTED);
    const today = day(again, "2026-10-24");
    await expect(cellOf(today)).not.toHaveAttribute("aria-selected", "true");
    await expect(today).toHaveAccessibleName(TODAY_PREFIX);
    await expect(today).not.toHaveAccessibleName(SELECTED);
    const other = day(again, "2026-10-22");
    await expect(cellOf(other)).not.toHaveAttribute("aria-selected", "true");
    await expect(other).toHaveAccessibleName(
      "quinta-feira, 22 de outubro de 2026"
    );
  });

  test("hoje escolhido: o nome diz Hoje e selecionado", async ({ page }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Data da despesa,",
      "Data da despesa"
    );
    await day(popup, "2026-10-24").click();
    await expect(popup).toBeHidden();
    const again = await openWithKeyboard(
      page,
      "Data da despesa,",
      "Data da despesa"
    );
    await expect(day(again, "2026-10-24")).toHaveAccessibleName(
      "Hoje, sábado, 24 de outubro de 2026, selecionado"
    );
  });
});

test.describe("DateRangePicker, os dias do período", () => {
  test("as pontas dizem o papel no período e os dias do período são selecionados", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(page, "Período,", "Período");
    const start = day(popup, "2026-10-01");
    const middle = day(popup, "2026-10-10");
    const end = day(popup, "2026-10-24");
    await expect(start).toHaveAccessibleName(
      "quinta-feira, 1 de outubro de 2026, início do período, selecionado"
    );
    await expect(end).toHaveAccessibleName(
      "Hoje, sábado, 24 de outubro de 2026, fim do período, selecionado"
    );
    await Promise.all(
      [start, middle, end].map((edge) =>
        expect(cellOf(edge)).toHaveAttribute("aria-selected", "true")
      )
    );
    await expect(cellOf(day(popup, "2026-10-25"))).not.toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  test("um dia do meio do período não diz papel: só a data e selecionado", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(page, "Período,", "Período");
    const middle = day(popup, "2026-10-10");
    await expect(middle).toHaveAccessibleName(
      "sábado, 10 de outubro de 2026, selecionado"
    );
    await expect(middle).not.toHaveAccessibleName(ROLE_IN_PERIOD);
  });

  test("período de um dia, pelos dois toques no mesmo dia: início e fim do período", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await day(popup, "2026-10-10").click();
    await day(popup, "2026-10-10").click();
    await expect(popup).toBeHidden();
    const again = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await expect(day(again, "2026-10-10")).toHaveAccessibleName(
      "sábado, 10 de outubro de 2026, início e fim do período, selecionado"
    );
  });

  test("período de um dia, pelo atalho Hoje: Hoje, início e fim do período", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await popup.getByRole("button", { exact: true, name: "Hoje" }).click();
    await expect(popup).toBeHidden();
    const again = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await expect(day(again, "2026-10-24")).toHaveAccessibleName(
      "Hoje, sábado, 24 de outubro de 2026, início e fim do período, selecionado"
    );
  });

  test("com só o início marcado, o dia diz início do período e nunca fim", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await day(popup, "2026-10-10").click();
    await expect(day(popup, "2026-10-10")).toHaveAccessibleName(
      "sábado, 10 de outubro de 2026, início do período, selecionado"
    );
  });

  test("com só o início marcado, a linha de status é uma região viva que diz o início", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openWithKeyboard(
      page,
      "Período das vendas,",
      "Período das vendas"
    );
    await day(popup, "2026-10-10").click();
    const status = popup.getByText("Início 10/10/2026. Escolha o último dia.");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(cellOf(day(popup, "2026-10-10"))).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
