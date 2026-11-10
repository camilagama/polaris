/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "../e2e/reflow";
import { expectWholeMonthWhileTyping } from "../e2e/date-pickers";
import { axeFaults } from "./ui-guardrails";

/**
 * "Digitar as datas" in the panel of the period picker, in the gallery ("hoje" is `24/10/2026`): the two fields take
 * `dd/mm/aaaa` from the keyboard with the bars put by the mask, the period they make is the one the calendar makes
 * from the same two days, a day touched in the calendar is written in the fields and a day typed is marked in the
 * calendar, a day that does not exist, an unfinished one, an empty field and an inverted range each say what is wrong
 * under the field, take the focus there and leave "Aplicar" `aria-disabled` with the same sentence as description. Fields
 * with a name, 44 px with touch, axe clean, and at 320 px with the font at 20 px the two fields stack, nothing is cut.
 */
const VIEWPORTS = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

const EMPTY_PERIOD = "Período das vendas";
const FILLED_PERIOD = "Período";
const NOT_A_DAY = "Essa data não existe. Confira dia, mês e ano.";
const YEAR_OUT = "O ano precisa estar entre 2000 e 2099.";

async function openGallery(page: Page) {
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("region", { name: "Calendário" }).getByRole("grid")
  ).toBeVisible();
}

const trigger = (page: Page, label: string) =>
  page.getByRole("button", { exact: false, name: `${label},` });

async function openPanel(page: Page, label: string) {
  await trigger(page, label).first().click();
  const popup = page.getByRole("dialog", { name: label, exact: true });
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

/** Opens "Digitar as datas": the focus goes to "Início". */
async function openTyping(page: Page, label: string) {
  const popup = await openPanel(page, label);
  const toggle = popup.getByRole("button", { name: "Digitar as datas" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(popup.getByRole("textbox", { name: "Início" })).toBeFocused();
  return popup;
}

const from = (popup: Locator) => popup.getByRole("textbox", { name: "Início" });
const to = (popup: Locator) => popup.getByRole("textbox", { name: "Fim" });
const apply = (popup: Locator) =>
  popup.getByRole("button", { exact: true, name: "Aplicar" });
const day = (popup: Locator, iso: string) =>
  popup.locator(`button[data-day="${iso}"]`);

async function typeRange(popup: Locator, start: string, end: string) {
  await from(popup).fill("");
  await from(popup).pressSequentially(start);
  await to(popup).fill("");
  await to(popup).pressSequentially(end);
}

interface Spot {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface Layout {
  apply: Spot;
  panel: { height: number; width: number };
  shortcuts: Spot;
}

/** Where the shortcuts and "Aplicar" sit inside the popup, and the popup's own size. */
function layoutOf(popup: Locator): Promise<Layout> {
  return popup.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const spot = (node: Element | undefined) => {
      if (!node) {
        throw new Error("the panel has no such part");
      }
      const rect = node.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x - box.x,
        y: rect.y - box.y,
      };
    };
    return {
      apply: spot(
        [...element.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Aplicar"
        )
      ),
      panel: { height: box.height, width: box.width },
      shortcuts: spot(
        element.querySelector('[aria-label="Atalhos do período"]') ?? undefined
      ),
    };
  });
}

const SAME_PIXEL = 1;

function expectSameColumns(base: Layout, other: Layout) {
  expect(Math.abs(other.panel.width - base.panel.width)).toBeLessThanOrEqual(
    SAME_PIXEL
  );
  for (const part of ["apply", "shortcuts"] as const) {
    expect(Math.abs(other[part].x - base[part].x)).toBeLessThanOrEqual(
      SAME_PIXEL
    );
    expect(Math.abs(other[part].width - base[part].width)).toBeLessThanOrEqual(
      SAME_PIXEL
    );
  }
  expect(Math.abs(other.shortcuts.y - base.shortcuts.y)).toBeLessThanOrEqual(
    SAME_PIXEL
  );
  expect(
    Math.abs(other.shortcuts.height - base.shortcuts.height)
  ).toBeLessThanOrEqual(SAME_PIXEL);
}

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.width} px`, () => {
    test.use({ viewport });

    test("AC-2.1: digitar 01/10/2026 e 14/10/2026 e aplicar faz o mesmo período que marcar os dois dias", async ({
      page,
    }) => {
      await openGallery(page);

      const popup = await openTyping(page, EMPTY_PERIOD);
      await typeRange(popup, "01102026", "14102026");
      await expect(from(popup)).toHaveValue("01/10/2026");
      await expect(to(popup)).toHaveValue("14/10/2026");
      await expect(apply(popup)).not.toHaveAttribute("aria-disabled", "true");
      await apply(popup).click();
      await expect(popup).toBeHidden();
      const typed = trigger(page, EMPTY_PERIOD);
      await expect(typed).toHaveAccessibleName(
        `${EMPTY_PERIOD}, 01/10 a 14/10`
      );

      const touched = await openPanel(page, FILLED_PERIOD);
      await day(touched, "2026-10-01").click();
      await day(touched, "2026-10-14").click();
      await expect(touched).toBeHidden();
      await expect(trigger(page, FILLED_PERIOD).first()).toHaveAccessibleName(
        `${FILLED_PERIOD}, 01/10 a 14/10`
      );
    });

    test("AC-2.1: Enter no campo aplica quando as duas datas estão boas", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);
      await typeRange(popup, "05102026", "09102026");
      await to(popup).press("Enter");
      await expect(popup).toBeHidden();
      await expect(trigger(page, EMPTY_PERIOD)).toHaveAccessibleName(
        `${EMPTY_PERIOD}, 05/10 a 09/10`
      );
    });

    test("AC-2.4: o calendário e os campos se espelham", async ({ page }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);

      await typeRange(popup, "05102026", "09102026");
      await expect(day(popup, "2026-10-05")).toHaveAttribute(
        "data-range-start",
        "true"
      );
      await expect(day(popup, "2026-10-09")).toHaveAttribute(
        "data-range-end",
        "true"
      );

      // a day touched starts again: the start is written, the end is empty
      await day(popup, "2026-10-20").click();
      await expect(popup).toBeVisible();
      await expect(from(popup)).toHaveValue("20/10/2026");
      await expect(to(popup)).toHaveValue("");
      await day(popup, "2026-10-22").click();
      await expect(popup).toBeHidden();

      // a shortcut is written too
      const again = await openTyping(page, EMPTY_PERIOD);
      await expect(from(again)).toHaveValue("20/10/2026");
      await expect(to(again)).toHaveValue("22/10/2026");
      await again
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name: "7 dias" })
        .click();
      await expect(again).toBeHidden();
      await expect(trigger(page, EMPTY_PERIOD)).toHaveAccessibleName(
        `${EMPTY_PERIOD}, 18/10 a 24/10`
      );
    });

    test("AC-2.2: o que não é um dia diz o motivo sob o campo, leva o foco e deixa Aplicar aria-disabled com a frase", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);

      // nothing typed: "Aplicar" says what is missing
      await expect(apply(popup)).toHaveAttribute("aria-disabled", "true");
      await expect(apply(popup)).toHaveAccessibleDescription(
        "Digite a data de início, como 01/10/2026."
      );
      await apply(popup).focus();
      await page.keyboard.press("Enter");
      await expect(popup).toBeVisible();
      await expect(from(popup)).toBeFocused();
      await expect(from(popup)).toHaveAttribute("aria-invalid", "true");
      await expect(popup.getByRole("alert")).toHaveText([
        "Digite a data de início, como 01/10/2026.",
        "Digite a data final, como 14/10/2026.",
      ]);

      // a day that does not exist
      await typeRange(popup, "31022026", "14102026");
      await to(popup).press("Enter");
      await expect(from(popup)).toBeFocused();
      await expect(popup.getByRole("alert")).toHaveText(NOT_A_DAY);
      await expect(apply(popup)).toHaveAttribute("aria-disabled", "true");
      await expect(apply(popup)).toHaveAccessibleDescription(NOT_A_DAY);
      await expect(trigger(page, EMPTY_PERIOD)).toHaveAccessibleName(
        `${EMPTY_PERIOD}, Escolher período`
      );

      // an unfinished one in the end
      await typeRange(popup, "01102026", "141");
      await to(popup).press("Enter");
      await expect(to(popup)).toBeFocused();
      await expect(popup.getByRole("alert")).toHaveText(
        "Faltam números. Escreva dia, mês e ano, como 14/10/2026."
      );
      await expect(popup).toBeVisible();

      // the error goes when the day is right
      await to(popup).pressSequentially("0/2026");
      await expect(to(popup)).toHaveValue("14/10/2026");
      await expect(popup.getByRole("alert")).toHaveCount(0);
      await apply(popup).click();
      await expect(popup).toBeHidden();
    });

    test("AC-2.2: ano fora de 2000 a 2099 tem frase própria, nos dois campos", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);
      await typeRange(popup, "01101999", "01100026");
      await to(popup).press("Enter");
      await expect(from(popup)).toBeFocused();
      await expect(popup.getByRole("alert")).toHaveText([YEAR_OUT, YEAR_OUT]);
      await expect(apply(popup)).toHaveAttribute("aria-disabled", "true");
      await expect(apply(popup)).toHaveAccessibleDescription(YEAR_OUT);

      await typeRange(popup, "01102026", "01102100");
      await to(popup).press("Enter");
      await expect(popup.getByRole("alert")).toHaveText(YEAR_OUT);
    });

    test("o painel tem a largura do calendário: atalhos e Aplicar não se mexem entre vazio, preenchido e erro", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openPanel(page, EMPTY_PERIOD);
      const closedWidth = (await popup.boundingBox())?.width ?? 0;
      await popup.getByRole("button", { name: "Digitar as datas" }).click();
      await expect(from(popup)).toBeFocused();

      const empty = await layoutOf(popup);
      expect(Math.abs(empty.panel.width - closedWidth)).toBeLessThanOrEqual(
        SAME_PIXEL
      );
      await typeRange(popup, "01102026", "14102026");
      await expect(apply(popup)).not.toHaveAttribute("aria-disabled", "true");
      const filled = await layoutOf(popup);
      expectSameColumns(empty, filled);
      expect(Math.abs(filled.apply.y - empty.apply.y)).toBeLessThanOrEqual(
        SAME_PIXEL
      );

      // the longest sentences there are, one in each field
      await typeRange(popup, "31022026", "14");
      await to(popup).press("Enter");
      await expect(popup.getByRole("alert")).toHaveText([
        NOT_A_DAY,
        "Faltam números. Escreva dia, mês e ano, como 14/10/2026.",
      ]);
      expectSameColumns(empty, await layoutOf(popup));

      await typeRange(popup, "14102026", "01102026");
      await to(popup).press("Enter");
      await expect(popup.getByRole("alert")).toHaveText(
        "A data final vem antes da inicial."
      );
      expectSameColumns(empty, await layoutOf(popup));
    });

    test("com pouca altura o mês guarda as seis semanas e o painel inteiro rola", async ({
      page,
    }) => {
      await page.setViewportSize({ height: 480, width: viewport.width });
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);
      await expectWholeMonthWhileTyping(popup);
      const { clientHeight, scrollHeight } = await popup.evaluate(
        (element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        })
      );
      expect(scrollHeight).toBeGreaterThan(clientHeight);
      await typeRange(popup, "31022026", "14102026");
      await to(popup).press("Enter");
      await expect(popup.getByRole("alert")).toHaveText(NOT_A_DAY);
      await expect(from(popup)).toBeInViewport({ ratio: 1 });
      await expect(popup.getByRole("alert")).toBeInViewport({ ratio: 1 });
    });

    test("AC-2.3: período invertido não existe: diz que a data final vem antes da inicial e não aplica", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);
      await typeRange(popup, "14102026", "01102026");
      await to(popup).press("Enter");
      await expect(popup).toBeVisible();
      await expect(to(popup)).toBeFocused();
      await expect(popup.getByRole("alert")).toHaveText(
        "A data final vem antes da inicial."
      );
      await expect(apply(popup)).toHaveAccessibleDescription(
        "A data final vem antes da inicial."
      );
      await expect(trigger(page, EMPTY_PERIOD)).toHaveAccessibleName(
        `${EMPTY_PERIOD}, Escolher período`
      );
    });

    test("AC-2.5: sem digitar nada muda: os dois toques fecham, e as datas escritas ficam fechadas", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openPanel(page, EMPTY_PERIOD);
      await expect(popup.getByRole("textbox")).toHaveCount(0);
      await day(popup, "2026-10-12").click();
      await expect(popup).toBeVisible();
      await expect(
        popup.getByText("Início 12/10/2026. Escolha o último dia.")
      ).toBeVisible();
      await day(popup, "2026-10-15").click();
      await expect(popup).toBeHidden();
      await expect(trigger(page, EMPTY_PERIOD)).toHaveAccessibleName(
        `${EMPTY_PERIOD}, 12/10 a 15/10`
      );
    });

    test("AC-2.6: campos com rótulo e nome, 44 px no toque, axe limpo, foco devolvido ao fechar", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openTyping(page, EMPTY_PERIOD);
      await expect(from(popup)).toHaveAttribute("inputmode", "numeric");
      await expect(to(popup)).toHaveAttribute("inputmode", "numeric");
      await expect(from(popup)).not.toHaveAttribute("type", "date");
      const touch = await page.evaluate(
        () =>
          window.matchMedia(
            "(pointer: coarse), not all and (min-width: 47.5rem)"
          ).matches
      );
      const box = await popup
        .locator('[data-slot="input-group"]')
        .first()
        .boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(touch ? 43.5 : 31.5);
      expect(await axeFaults(page, '[data-slot="popover-content"]')).toEqual(
        []
      );

      await from(popup).press("Tab");
      await expect(to(popup)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
    });
  });
}

const SHORTCUT_ROW = '[aria-label="Atalhos do período"]';

test.describe("a 320 px com a letra de 20 px", () => {
  skipOutsideChromium();

  async function expectPanelFits(popup: Locator) {
    const shown = await popup.boundingBox();
    expect(shown && shown.x >= 0 && shown.x + shown.width <= 320.5).toBe(true);
    const { clientWidth, scrollWidth } = await popup.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await assertNothingClipped(popup, { allowScroll: [SHORTCUT_ROW] });
  }

  test("AC-2.6: o painel aberto cabe, com e sem os campos: atalhos numa fileira que rola de lado, campos empilhados, nada é cortado", async ({
    page,
  }) => {
    await openReflowViewport(page);
    await openGallery(page);
    await expectReflowFont(page);
    const popup = await openPanel(page, EMPTY_PERIOD);
    await expectPanelFits(popup);
    const shortcuts = popup
      .getByRole("group", { name: "Atalhos do período" })
      .getByRole("button");
    await expect(shortcuts).toHaveCount(4);
    const rows = await shortcuts.evaluateAll((buttons) => [
      ...new Set(buttons.map((button) => button.getBoundingClientRect().y)),
    ]);
    expect(rows).toHaveLength(1);
    const row = popup.getByRole("group", { name: "Atalhos do período" });
    const reach = await row.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(reach.scroll).toBeGreaterThan(reach.client);
    await shortcuts.last().scrollIntoViewIfNeeded();
    await expect
      .poll(() => row.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(shortcuts.last()).toBeInViewport({ ratio: 1 });

    await popup.getByRole("button", { name: "Digitar as datas" }).click();
    await expect(from(popup)).toBeFocused();
    await typeRange(popup, "31022026", "14102026");
    await to(popup).press("Enter");
    await expect(popup.getByRole("alert")).toHaveText(NOT_A_DAY);

    const first = await from(popup).boundingBox();
    const second = await to(popup).boundingBox();
    expect(first && second && second.y >= first.y + first.height).toBe(true);
    await expectPanelFits(popup);
    await assertNothingClipped(popup.locator('[id$="-region"]'));

    await typeRange(popup, "01102026", "14102026");
    await expectPanelFits(popup);
  });
});
