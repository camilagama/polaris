/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The state filter of the project (`SegmentedFilter`), in the gallery: the appearance menu (`ThemeSwitch`) changes
 * the theme and keeps it after a reload, and the focus outline of the first and of the last segment of a strip that
 * scrolls stays inside the box that clips it, at 320 px and at 1280 px.
 */
const THEME_KEY = "polaris-tema";
const APPEARANCE_TRIGGER = /^Aparência: /;
const WIDTHS = [320, 1280] as const;
const TOLERANCE = 0.5;
const FILTERS = [
  { first: "Ativos", label: "Estado dos produtos", last: "Arquivados" },
  { first: "Ativas", label: "Situação", last: "Anuladas" },
  {
    first: "Todas (9)",
    label: "Linhas do arquivo",
    last: "Fora do limite (3)",
  },
] as const;

async function openGallery(page: Page) {
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

const storedTheme = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY);

test("clicar em Escuro e em Claro muda o tema, e a escolha fica guardada depois de recarregar", async ({
  page,
}) => {
  // every reading of the choice opens and closes the menu, and the test reloads twice
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.emulateMedia({ colorScheme: "light" });
  await openGallery(page);
  const trigger = page.getByRole("button", { name: APPEARANCE_TRIGGER });
  const choice = async (name: string) => {
    await trigger.click();
    return page.getByRole("menuitemradio", { exact: true, name });
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  };
  const pick = async (name: string) => {
    await (await choice(name)).click();
    await closeMenu();
  };
  const expectChecked = async (name: string, checked: boolean) => {
    const item = await choice(name);
    await expect(item).toHaveAttribute("aria-checked", String(checked));
    await closeMenu();
  };

  await expectChecked("Automático", true);
  expect(await isDark(page)).toBe(false);
  expect(await storedTheme(page)).toBeNull();

  await pick("Escuro");
  await expectChecked("Escuro", true);
  await expect.poll(() => isDark(page)).toBe(true);
  expect(await storedTheme(page)).toBe("escuro");

  await page.reload();
  await expect(trigger).toBeVisible();
  await expectChecked("Escuro", true);
  await expectChecked("Automático", false);
  await expect.poll(() => isDark(page)).toBe(true);

  // with the system dark, only a stored "Claro" keeps the page light
  await page.emulateMedia({ colorScheme: "dark" });
  await pick("Claro");
  await expectChecked("Claro", true);
  await expect.poll(() => isDark(page)).toBe(false);
  expect(await storedTheme(page)).toBe("claro");

  await page.reload();
  await expectChecked("Claro", true);
  await expect.poll(() => isDark(page)).toBe(false);

  await pick("Automático");
  await expect.poll(() => storedTheme(page)).toBeNull();
  await expect.poll(() => isDark(page)).toBe(true);
});

/**
 * Where the outline of the focused element is drawn, against the box that clips it: the nearest ancestor that scrolls
 * sideways. The outline reaches `outline-width + outline-offset` beyond the border box on every side.
 */
function outlineAgainstClip(segment: Locator) {
  return segment.evaluate((element) => {
    const clip = element.closest<HTMLElement>(".overflow-x-auto");
    if (!clip) {
      return null;
    }
    const style = getComputedStyle(element);
    const reach =
      Number.parseFloat(style.outlineWidth) +
      Number.parseFloat(style.outlineOffset);
    const box = element.getBoundingClientRect();
    const area = clip.getBoundingClientRect();
    return {
      bottom: area.bottom - (box.bottom + reach),
      left: box.left - reach - area.left,
      outlineStyle: style.outlineStyle,
      reach,
      right: area.right - (box.right + reach),
      top: box.top - reach - area.top,
    };
  });
}

/** The outline of the focused segment, drawn by the keyboard (`:focus-visible`), inside the box that clips it. */
async function expectRingInside(segment: Locator, which: string) {
  await expect(segment).toBeFocused();
  // the strip scrolls to the tab it chose on its own, after the key
  await expect
    .poll(async () => {
      const room = await outlineAgainstClip(segment);
      return room
        ? Math.min(room.bottom, room.left, room.right, room.top)
        : Number.NaN;
    }, `${which}: o contorno dentro da caixa`)
    .toBeGreaterThanOrEqual(-TOLERANCE);
  const room = await outlineAgainstClip(segment);
  expect(room?.outlineStyle).toBe("solid");
  expect(room?.reach).toBeGreaterThan(0);
}

for (const width of WIDTHS) {
  for (const filter of FILTERS) {
    test(`a ${width} px o contorno de foco de "${filter.first}" e de "${filter.last}" em "${filter.label}" cabe na caixa que rola`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      await openGallery(page);
      const list = page.getByRole("tablist", {
        exact: true,
        name: filter.label,
      });
      const first = list.getByRole("tab", { exact: true, name: filter.first });
      const last = list.getByRole("tab", { exact: true, name: filter.last });
      await first.scrollIntoViewIfNeeded();

      await first.focus();
      await page.keyboard.press("End");
      await expect(last).toHaveAttribute("aria-selected", "true");
      await expectRingInside(last, `o último segmento de ${filter.label}`);
      await page.keyboard.press("Home");
      await expect(first).toHaveAttribute("aria-selected", "true");
      await expectRingInside(first, `o primeiro segmento de ${filter.label}`);
    });
  }
}
