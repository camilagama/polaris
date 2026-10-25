/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { axeFaults } from "./ui-guardrails";

/**
 * The date pickers of src/ui/ in the gallery (t363): the calendar chunk loads on demand; one date is chosen with a
 * touch, with "Hoje" and with the arrows; a disabled day is aria-disabled, says why and is not chosen; the period
 * keeps the popover open on the first touch and closes on the second, the shortcuts and "Limpar" work, and an
 * inverted range cannot be made. At 360 and 1280 px: the size of the days (36 px with a mouse, 44 with touch), one
 * month or two, nothing past the window, the focus of 3 px. The popover moves as Base UI's does, and the page that
 * asks for no motion stops it. axe finds nothing with each picker open, in both themes. "Hoje" is 24/10/2026 in the
 * gallery.
 */
// with or without the query of a second try (`?retry=1`)
const CALENDAR_CHUNK = /\/assets\/calendar-[\w-]+\.js(\?.*)?$/;
const CALENDAR_CHUNK_URL = /\/assets\/calendar-[\w-]+\.js$/;
const VIEWPORTS = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

async function openGallery(page: Page, theme: string | null = null) {
  if (theme) {
    await page.addInitScript((stored) => {
      window.localStorage.setItem("polaris-tema", stored);
    }, theme);
  }
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Calendário" }).getByRole("grid")
  ).toBeVisible();
}

const day = (scope: Locator | Page, iso: string) =>
  scope.locator(`button[data-day="${iso}"]`);

/** The button of a picker: its accessible name starts with the label and a comma. */
const trigger = (page: Page, name: string) =>
  page.getByRole("button", { name });

async function openPicker(page: Page, name: string, label: string) {
  await trigger(page, name).click();
  const popup = page.getByRole("dialog", { name: label });
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

async function expectDisabledDay(off: Locator) {
  await expect(off).toHaveAttribute("aria-disabled", "true");
  await expect(off).not.toHaveAttribute("disabled");
  await expect(off).toHaveAccessibleDescription("Só até hoje");
}

async function pickShortcut(page: Page, name: string) {
  const popup = await openPicker(page, "Período,", "Período");
  await popup
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name })
    .click();
  await expect(popup).toBeHidden();
}

/**
 * axe over one open picker, then closed with Escape. Over the popover only: on a phone it opens over the next field
 * of the gallery, and a target covered by an open popover is not a fault of either (the page with every picker
 * closed is checked whole).
 */
async function axeWithOpen(page: Page, label: string) {
  const popup = await openPicker(page, `${label},`, label);
  const faults = await axeFaults(page, '[data-slot="popover-content"]');
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  return faults;
}

/** Whether the page is in the touch sizes (the `touch` variant of theme.css). */
const isTouch = (page: Page) =>
  page.evaluate(
    () => window.matchMedia("(pointer: coarse), (max-width: 759.98px)").matches
  );

test("o calendário vem do seu próprio chunk, baixado quando a galeria pede um", async ({
  page,
}) => {
  const csp = await watchCspViolations(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    if (CALENDAR_CHUNK_URL.test(request.url())) {
      requested.push(request.url());
    }
  });
  await openGallery(page);
  expect(requested).toHaveLength(1);
  expect(csp.violations()).toEqual([]);
});

const FAILED_TEXT = "O calendário não abriu.";
const OFFLINE_TEXT = "Sem internet. O calendário abre quando a conexão voltar.";

/** The box of the calendar inside the section of the gallery that shows the month alone. */
const inlineBox = (page: Page) =>
  page.getByRole("region", { name: "Calendário" }).getByRole("alert");

test("sem o chunk do calendário, com rede: o seletor abre, diz que o calendário não abriu e oferece Tentar novamente; Hoje continua no rodapé", async ({
  page,
}) => {
  await page.route(CALENDAR_CHUNK, (route) => route.abort());
  await page.goto("/ui-galeria");
  await expect(inlineBox(page)).toHaveText(`${FAILED_TEXT}Tentar novamente`);
  await trigger(page, "Data da despesa,").click();
  const popup = page.getByRole("dialog", { name: "Data da despesa" });
  await expect(popup.getByRole("alert")).toContainText(FAILED_TEXT);
  await expect(
    popup.getByRole("button", { name: "Tentar novamente" })
  ).toBeVisible();
  await expect(popup.getByRole("button", { name: "Hoje" })).toBeVisible();
});

test("sem o chunk do calendário e sem internet: diz Sem internet, sem botão, Hoje continua e o calendário abre sozinho quando a conexão volta", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { offlineNow: boolean }).offlineNow = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => !(window as unknown as { offlineNow: boolean }).offlineNow,
    });
  });
  const connection: { blocked: boolean } = { blocked: true };
  await page.route(CALENDAR_CHUNK, (route) =>
    connection.blocked ? route.abort("internetdisconnected") : route.fallback()
  );
  await page.goto("/ui-galeria");
  await expect(inlineBox(page)).toHaveText(OFFLINE_TEXT);
  await expect(
    inlineBox(page).getByRole("button", { name: "Tentar novamente" })
  ).toHaveCount(0);
  await trigger(page, "Data da despesa,").click();
  const popup = page.getByRole("dialog", { name: "Data da despesa" });
  await expect(popup.getByRole("alert")).toHaveText(OFFLINE_TEXT);
  await expect(popup.getByRole("button", { name: "Hoje" })).toBeVisible();
  await page.keyboard.press("Escape");

  // the connection is back: the event makes the calendar ask again, with no click
  connection.blocked = false;
  await page.evaluate(() => {
    (window as unknown as { offlineNow: boolean }).offlineNow = false;
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    page.getByRole("region", { name: "Calendário" }).getByRole("grid")
  ).toBeVisible();
});

test("Tentar novamente refaz o pedido do chunk sem recarregar a página e o calendário abre", async ({
  page,
}) => {
  let asked = 0;
  await page.route(CALENDAR_CHUNK, (route) => {
    asked += 1;
    return asked === 1 ? route.abort("failed") : route.fallback();
  });
  await page.goto("/ui-galeria");
  await expect(inlineBox(page)).toContainText(FAILED_TEXT);
  await page.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });
  await inlineBox(page)
    .getByRole("button", { name: "Tentar novamente" })
    .click();
  await expect(
    page.getByRole("region", { name: "Calendário" }).getByRole("grid")
  ).toBeVisible();
  expect(asked).toBe(2);
  // the same page: nothing reloaded
  expect(
    await page.evaluate(
      () => (window as unknown as { stillHere?: boolean }).stillHere
    )
  ).toBe(true);
});

test("enquanto o chunk não chega a caixa de espera é um status que diz Abrindo o calendário… e tem o tamanho do mês", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(CALENDAR_CHUNK, async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto("/ui-galeria");
  const waiting = page
    .getByRole("region", { name: "Calendário" })
    .getByRole("status")
    .filter({ hasText: "Abrindo o calendário…" });
  await expect(waiting).toBeVisible();
  const before = await waiting.boundingBox();
  release();
  const grid = page
    .getByRole("region", { name: "Calendário" })
    .getByRole("grid");
  await expect(grid).toBeVisible();
  await expect(waiting).toHaveCount(0);
  // the box was the size of the month: the grid that came in its place has the same width and height
  const calendar = page
    .getByRole("region", { name: "Calendário" })
    .locator('[data-slot="calendar"]');
  const after = await calendar.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(
    1.5
  );
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(
    1.5
  );
});

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.width} px`, () => {
    test.use({ viewport });

    test("data única: o toque escolhe e fecha, Hoje escolhe hoje, o botão diz o rótulo e a data", async ({
      page,
    }) => {
      await openGallery(page);
      const button = trigger(page, "Data da despesa,");
      await expect(button).toHaveAccessibleName(
        "Data da despesa, Escolher data"
      );
      await expect(button).toHaveText("Escolher data");

      let popup = await openPicker(page, "Data da despesa,", "Data da despesa");
      await expect(popup.getByText("Outubro de 2026")).toBeVisible();
      await expect(
        popup.getByRole("button", { name: "Mês anterior" })
      ).toBeVisible();
      await expect(
        popup.getByRole("button", { name: "Próximo mês" })
      ).toBeVisible();
      await day(popup, "2026-10-15").click();
      await expect(popup).toBeHidden();
      await expect(button).toHaveAccessibleName("Data da despesa, 15/10/2026");
      await expect(button).toHaveText("15/10/2026");

      popup = await openPicker(page, "Data da despesa,", "Data da despesa");
      await expect(day(popup, "2026-10-15")).toHaveAttribute(
        "data-selected-single",
        "true"
      );
      await popup.getByRole("button", { exact: true, name: "Hoje" }).click();
      await expect(popup).toBeHidden();
      await expect(button).toHaveText("24/10/2026");
    });

    test("data única pelo teclado: o foco vai ao dia escolhido, as setas andam e Enter escolhe", async ({
      page,
    }) => {
      await openGallery(page);
      await trigger(page, "Data de competência,").focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog", { name: "Data de competência" });
      await expect(day(popup, "2026-10-24")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(day(popup, "2026-10-25")).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(day(popup, "2026-11-01")).toBeFocused();
      await expect(popup.getByText("Novembro de 2026")).toBeVisible();
      // the focus of the day is the 3 px outline of every control
      const outline = await day(popup, "2026-11-01").evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth };
      });
      expect(outline).toEqual({ style: "solid", width: "3px" });
      await page.keyboard.press("Enter");
      await expect(popup).toBeHidden();
      await expect(trigger(page, "Data de competência,")).toHaveAccessibleName(
        "Data de competência, 01/11/2026"
      );
      // closing gives the focus back to the button
      await expect(trigger(page, "Data de competência,")).toBeFocused();
    });

    test("dia fora do permitido: aria-disabled, diz o motivo e não é escolhido", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openPicker(
        page,
        "Data do pagamento,",
        "Data do pagamento"
      );
      await expectDisabledDay(day(popup, "2026-10-04"));
      await expectDisabledDay(day(popup, "2026-10-25"));
      await expect(day(popup, "2026-10-10")).not.toHaveAttribute(
        "aria-disabled"
      );
      // a real click event on the day (a pointer would stop at its pointer-events: none): DayPicker ignores it
      await day(popup, "2026-10-25").dispatchEvent("click");
      await expect(popup).toBeVisible();
      await expect(trigger(page, "Data do pagamento,")).toHaveText(
        "Escolher data"
      );
      // the inline calendar of the gallery: the same reason after today
      const inline = page.getByRole("region", { name: "Calendário" });
      await expect(day(inline, "2026-10-30")).toHaveAccessibleDescription(
        "Só até hoje"
      );
    });

    test("data obrigatória: o erro é Escolha uma data, ligado ao botão", async ({
      page,
    }) => {
      await openGallery(page);
      const button = trigger(page, "Vencimento,");
      await expect(button).toHaveAttribute("aria-invalid", "true");
      await expect(button).toHaveAccessibleDescription("Escolha uma data");
      const popup = await openPicker(page, "Vencimento,", "Vencimento");
      await day(popup, "2026-10-20").click();
      await expect(button).not.toHaveAttribute("aria-invalid");
      await expect(page.getByText("Escolha uma data")).toHaveCount(0);
    });

    test("período: o 1º toque marca o início sem fechar, o 2º fecha; antes do início vira o início", async ({
      page,
    }) => {
      const csp = await watchCspViolations(page);
      await openGallery(page);
      const button = trigger(page, "Período das vendas,");
      await expect(button).toHaveText("Escolher período");
      const popup = await openPicker(
        page,
        "Período das vendas,",
        "Período das vendas"
      );
      await day(popup, "2026-10-10").click();
      await expect(popup).toBeVisible();
      await expect(
        popup.getByText("Início 10/10/2026. Escolha o último dia.")
      ).toBeVisible();
      await expect(button).toHaveText("Escolher período");
      await day(popup, "2026-10-05").click();
      await expect(popup).toBeHidden();
      await expect(button).toHaveText("05/10 a 10/10");
      await expect(button).toHaveAccessibleName(
        "Período das vendas, 05/10 a 10/10"
      );

      // the same day twice is one day, written in full
      const again = await openPicker(
        page,
        "Período das vendas,",
        "Período das vendas"
      );
      await day(again, "2026-10-12").click();
      await day(again, "2026-10-12").click();
      await expect(again).toBeHidden();
      await expect(button).toHaveText("12/10/2026");

      // other months and a range across them: nothing the calendar draws needs a style the CSP refuses
      const across = await openPicker(
        page,
        "Período das vendas,",
        "Período das vendas"
      );
      await across.getByRole("button", { name: "Mês anterior" }).click();
      await expect(across.getByText("Setembro de 2026").first()).toBeVisible();
      await day(across, "2026-09-28").click();
      await across.getByRole("button", { name: "Próximo mês" }).click();
      await day(across, "2026-10-03").click();
      await expect(across).toBeHidden();
      await expect(button).toHaveText("28/09 a 03/10");
      expect(csp.violations()).toEqual([]);
    });

    test("período: os atalhos fecham com o intervalo e Limpar apaga", async ({
      page,
    }) => {
      await openGallery(page);
      const button = trigger(page, "Período,");
      await expect(button).toHaveText("01/10 a 24/10");
      let popup = await openPicker(page, "Período,", "Período");
      const shortcuts = popup.getByRole("group", {
        name: "Atalhos do período",
      });
      await expect(
        shortcuts.getByRole("button", { name: "Este mês" })
      ).toHaveAttribute("aria-pressed", "true");
      await shortcuts.getByRole("button", { name: "7 dias" }).click();
      await expect(popup).toBeHidden();
      await expect(button).toHaveText("18/10 a 24/10");

      await pickShortcut(page, "Mês passado");
      await expect(button).toHaveText("01/09 a 30/09");
      await pickShortcut(page, "Hoje");
      await expect(button).toHaveText("24/10/2026");
      await pickShortcut(page, "Este mês");
      await expect(button).toHaveText("01/10 a 24/10");

      popup = await openPicker(page, "Período,", "Período");
      await popup.getByRole("button", { name: "Limpar" }).click();
      await expect(popup).toBeHidden();
      await expect(button).toHaveText("Escolher período");
      await expect(button).toHaveAccessibleName("Período, Escolher período");
    });

    test("período: um mês abaixo de 1280 px e dois a partir dele, o dia com 36 px no mouse e 44 no toque, nada fora da janela", async ({
      page,
    }) => {
      await openGallery(page);
      const popup = await openPicker(page, "Período,", "Período");
      await expect(popup.getByRole("grid")).toHaveCount(
        viewport.width >= 1280 ? 2 : 1
      );
      const size = (await isTouch(page)) ? 44 : 36;
      const box = await day(popup, "2026-10-15").boundingBox();
      expect(box?.width).toBeCloseTo(size, 0);
      expect(box?.height).toBeCloseTo(size, 0);
      const popupBox = await popup.boundingBox();
      expect(popupBox?.x).toBeGreaterThanOrEqual(0);
      expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width
      );
      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      );
      expect(sideways).toBeLessThanOrEqual(0);
    });

    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      test(`o popover se move como o do Base UI e para com prefers-reduced-motion (${reducedMotion})`, async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion });
        await openGallery(page);
        const popup = await openPicker(page, "Período,", "Período");
        const duration = await popup.evaluate(
          (element) => getComputedStyle(element).animationDuration
        );
        const seconds = Number.parseFloat(duration);
        if (reducedMotion === "reduce") {
          expect(seconds).toBeLessThan(0.001);
        } else {
          expect(seconds).toBeCloseTo(0.1, 3);
        }
        await page.keyboard.press("Escape");
        await expect(popup).toBeHidden();
      });
    }
  });
}

test.describe("a 320 px, com toque", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 640, width: 320 },
  });

  test("o período cabe: atalhos sem texto cortado, a semana inteira e nada fora da janela", async ({
    page,
  }) => {
    await openGallery(page);
    const popup = await openPicker(page, "Período,", "Período");
    const cut = await popup
      .getByRole("group", { name: "Atalhos do período" })
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons
          // the text against the box inside the padding (scrollWidth would count the 48 px touch area around it)
          .filter((button) => {
            const text = document.createRange();
            text.selectNodeContents(button);
            const style = getComputedStyle(button);
            const inner =
              button.getBoundingClientRect().width -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight);
            return text.getBoundingClientRect().width > inner + 0.5;
          })
          .map((button) => button.textContent)
      );
    expect(cut).toEqual([]);
    const box = await popup.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    // the last day of the week (a Saturday) inside the window, across
    const saturday = await day(popup, "2026-10-31").boundingBox();
    expect((saturday?.x ?? 0) + (saturday?.width ?? 0)).toBeLessThanOrEqual(
      320
    );
    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(sideways).toBeLessThanOrEqual(0);
  });
});

for (const theme of ["claro", "escuro"] as const) {
  test(`axe não acha nada com cada seletor aberto (tema ${theme})`, async ({
    page,
  }) => {
    await openGallery(page, theme);
    expect(await axeFaults(page)).toEqual([]);
    expect(await axeWithOpen(page, "Data do pagamento")).toEqual([]);
    expect(await axeWithOpen(page, "Período")).toEqual([]);
  });
}
