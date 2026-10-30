/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { applyEditor, onPhone } from "../e2e/filter-bar-editor";
import { expectMotionLevel } from "./motion-expect";
import { axeFaults, touchFaults } from "./ui-guardrails";

/**
 * The filter bar of src/ui/ in the gallery, at 360 and 1280 px and with the bar open (the menu and the
 * editors), as the review asks: the pills with their names, the menu with the fields used and the one that needs the
 * connection, adding, editing and taking out a filter, "Limpar tudo", the keyboard (Tab, Enter, Escape gives the focus
 * back to the pill), the sizes with a mouse and with touch, the row of pills that wraps into lines at every width (320, 360 and 1280 px), the
 * motion and its absence under `prefers-reduced-motion`, and axe with each part open in both themes. "Hoje" is
 * `24/10/2026` in the gallery and the bar starts with Período `01/10` a `24/10`, Situação Paga and Cliente Maria Souza.
 */
const REASON = /Só com conexão/;
const CLOSED_FAULT = /Filtrar|Tirar o filtro|editar|Limpar tudo/;
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
  await expect(bar(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas" });
const offlineBar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas sem conexão" });
const count = (page: Page) => page.getByTestId("filtros-contagem");
const addButton = (page: Page) =>
  bar(page).getByRole("button", { exact: true, name: "Filtrar" });
// by `aria-label`, not by role: under the form Dialog of a phone the page behind is `aria-hidden`, and a hidden element is not found by role and has no name
const pill = (page: Page, label: string) =>
  page.locator(
    `search[aria-label="Filtrar vendas"] button[aria-label^="${label}: "][aria-label$=", editar"]`
  );
const remover = (page: Page, label: string) =>
  bar(page).getByRole("button", {
    includeHidden: true,
    name: `Tirar o filtro ${label}`,
  });
const clearAll = (page: Page) =>
  bar(page).getByRole("button", { name: "Limpar tudo" });
const menu = (page: Page) => page.getByRole("menu", { name: "Filtrar por" });
const item = (page: Page, name: string) =>
  menu(page).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const editor = (page: Page, label: string) =>
  page.getByRole("dialog", { name: label });

/** Whether the page is in the touch sizes (the `touch` variant of theme.css). */
const isTouch = (page: Page) =>
  page.evaluate(
    () => window.matchMedia("(pointer: coarse), (max-width: 759.98px)").matches
  );

async function openMenu(page: Page) {
  await addButton(page).click();
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

/** The box of a locator, failing the test when it is not on the page. */
async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as { height: number; width: number; x: number; y: number };
}

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.width} px`, () => {
    test.use({ viewport });

    test("fechada: um <search> com o nome da tela, as pílulas com campo e valor, o X de cada uma e Limpar tudo; a contagem é da tela", async ({
      page,
    }) => {
      const csp = await watchCspViolations(page);
      await openGallery(page);
      await expect(pill(page, "Período")).toHaveAccessibleName(
        "Período: 01/10 a 24/10, editar"
      );
      await expect(pill(page, "Situação")).toHaveAccessibleName(
        "Situação: Paga, editar"
      );
      await expect(pill(page, "Cliente")).toHaveAccessibleName(
        "Cliente: Maria Souza, editar"
      );
      await Promise.all(
        ["Período", "Situação", "Cliente"].map((label) =>
          expect(remover(page, label)).toBeVisible()
        )
      );
      await expect(clearAll(page)).toBeVisible();
      await expect(count(page)).toHaveText("3 filtros ativos");
      await expect(count(page)).toHaveAttribute("role", "status");
      // the status line is inside the <search>
      await expect(bar(page).getByTestId("filtros-contagem")).toBeVisible();
      expect(csp.violations()).toEqual([]);
    });

    test("tamanhos: pílula de 36 px com mouse e de 44 px no toque, o X de 36 px com mouse e de 48 px no toque", async ({
      page,
    }) => {
      await openGallery(page);
      const size = (await isTouch(page)) ? 44 : 36;
      const outer = await box(
        bar(page).locator('[data-slot="filter-pill"]').first()
      );
      expect(outer.height).toBeCloseTo(size, 0);
      const x = await box(remover(page, "Período"));
      // 48 px wide with touch: its 48 px area then does not reach into the button of the pill
      expect(x.width).toBeCloseTo((await isTouch(page)) ? 48 : 36, 0);
      const filtrar = await box(addButton(page));
      expect(filtrar.height).toBeCloseTo((await isTouch(page)) ? 36 : 32, 0);
    });

    test("menu aberto: os campos usados em cinza com o valor ao lado, o que precisa de conexão aria-disabled com o motivo, tudo dentro da janela", async ({
      page,
    }) => {
      await openGallery(page);
      const open = await openMenu(page);
      await expect(item(page, "Período")).toContainText("01/10 a 24/10");
      await expect(item(page, "Situação")).toContainText("Paga");
      await expect(item(page, "Cliente")).toContainText("Maria Souza");
      await Promise.all(
        ["Período", "Situação", "Cliente"].map((used) =>
          expect(item(page, used)).toHaveAttribute("aria-disabled", "true")
        )
      );
      const offline = item(page, "Produto vendido");
      await expect(offline).toHaveAttribute("aria-disabled", "true");
      await expect(offline).toContainText("Só com conexão");
      // the reason is in the name the screen reader gets, and the item is still reachable by the keyboard
      await expect(offline).toHaveAccessibleName(REASON);
      await expect(offline).not.toHaveAttribute("data-disabled");

      const menuBox = await box(open);
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
      const minimum = (await isTouch(page)) ? 44 : 32;
      const heights = await open
        .getByRole("menuitem")
        .evaluateAll((rows) =>
          rows.map((row) => row.getBoundingClientRect().height)
        );
      expect(heights).toHaveLength(4);
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(minimum - 0.5);
      const sideways = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      );
      expect(sideways).toBeLessThanOrEqual(0);

      // touching a field that cannot be chosen neither chooses it nor closes the menu
      await offline.click({ force: true });
      await expect(menu(page)).toBeVisible();
      await item(page, "Cliente").click({ force: true });
      await expect(menu(page)).toBeVisible();
      await expect(count(page)).toHaveText("3 filtros ativos");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(addButton(page)).toBeFocused();
    });

    test("adicionar: o campo escolhido vira pílula com o editor aberto; Enter aplica e o foco volta à pílula", async ({
      page,
    }) => {
      await openGallery(page);
      await remover(page, "Cliente").click();
      await expect(pill(page, "Cliente")).toHaveCount(0);
      await expect(count(page)).toHaveText("2 filtros ativos");
      // the pill that went away gives the focus to Filtrar
      await expect(addButton(page)).toBeFocused();

      await openMenu(page);
      await item(page, "Cliente").click();
      await expect(menu(page)).toBeHidden();
      await expect(pill(page, "Cliente")).toHaveAttribute(
        "aria-label",
        "Cliente: Escolher, editar"
      );
      const open = editor(page, "Cliente");
      await expect(open).toBeVisible();
      const field = open.getByRole("textbox", { name: "Cliente" });
      await expect(field).toBeFocused();
      // the count is not the bar's: a field with no value is not a filter yet
      await expect(count(page)).toHaveText("2 filtros ativos");
      await field.fill("Ana Lima");
      await page.keyboard.press("Enter");
      await expect(open).toBeHidden();
      await expect(pill(page, "Cliente")).toHaveAccessibleName(
        "Cliente: Ana Lima, editar"
      );
      await expect(pill(page, "Cliente")).toBeFocused();
      await expect(count(page)).toHaveText("3 filtros ativos");
    });

    test("adicionar e desistir: Escape tira a pílula sem valor e o foco vai a Filtrar", async ({
      page,
    }) => {
      await openGallery(page);
      await remover(page, "Situação").click();
      await openMenu(page);
      await item(page, "Situação").click();
      const open = editor(page, "Situação");
      await expect(open).toBeVisible();
      await expect(
        open.getByRole("button", { name: "Cancelada" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(open).toBeHidden();
      await expect(pill(page, "Situação")).toHaveCount(0);
      await expect(count(page)).toHaveText("2 filtros ativos");
      await expect(addButton(page)).toBeFocused();
    });

    test("editar uma escolha: tocar na opção troca o valor e fecha; o foco volta à pílula", async ({
      page,
    }) => {
      await openGallery(page);
      await pill(page, "Situação").click();
      const open = editor(page, "Situação");
      await expect(open.getByRole("button", { name: "Paga" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await open.getByRole("button", { name: "Cancelada" }).click();
      await applyEditor(page, open);
      await expect(open).toBeHidden();
      await expect(pill(page, "Situação")).toHaveAccessibleName(
        "Situação: Cancelada, editar"
      );
      await expect(pill(page, "Situação")).toBeFocused();
      // the order of the pills did not change
      const order = await bar(page)
        .locator('[data-slot="filter-pill"]')
        .evaluateAll((pills) =>
          pills.map((element) => element.textContent?.slice(0, 7))
        );
      expect(order).toEqual(["Período", "Situaçã", "Cliente"]);
    });

    test("editar o texto: o editor traz o texto de agora, apagar tudo tira o filtro, e Escape deixa como estava e devolve o foco à pílula", async ({
      page,
    }) => {
      await openGallery(page);
      await pill(page, "Cliente").click();
      const open = editor(page, "Cliente");
      const field = open.getByRole("textbox", { name: "Cliente" });
      await expect(field).toHaveValue("Maria Souza");
      await field.fill("Outro nome");
      await page.keyboard.press("Escape");
      await expect(open).toBeHidden();
      await expect(pill(page, "Cliente")).toHaveAccessibleName(
        "Cliente: Maria Souza, editar"
      );
      await expect(pill(page, "Cliente")).toBeFocused();

      await pill(page, "Cliente").click();
      await editor(page, "Cliente")
        .getByRole("textbox", { name: "Cliente" })
        .fill("");
      await page.keyboard.press("Enter");
      await expect(pill(page, "Cliente")).toHaveCount(0);
      await expect(count(page)).toHaveText("2 filtros ativos");
      await expect(addButton(page)).toBeFocused();
    });

    test("editor do Período aberto: o seletor de período da galeria, com atalhos e Limpar, dentro da janela", async ({
      page,
    }) => {
      await openGallery(page);
      await pill(page, "Período").click();
      const open = editor(page, "Período");
      await expect(open.getByRole("grid").first()).toBeVisible();
      await expect(
        open
          .getByRole("group", { name: "Atalhos do período" })
          .getByRole("button", { name: "Este mês" })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(open.getByRole("grid")).toHaveCount(
        viewport.width >= 1280 ? 2 : 1
      );
      const editorBox = await box(open);
      expect(editorBox.x).toBeGreaterThanOrEqual(0);
      expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(viewport.width);
      await open
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { name: "7 dias" })
        .click();
      await applyEditor(page, open);
      await expect(open).toBeHidden();
      await expect(pill(page, "Período")).toHaveAccessibleName(
        "Período: 18/10 a 24/10, editar"
      );
      await expect(pill(page, "Período")).toBeFocused();

      // the first day marks the start and keeps the editor open; the second closes the range
      await pill(page, "Período").click();
      const again = editor(page, "Período");
      await again.locator('button[data-day="2026-10-05"]').click();
      await expect(again).toBeVisible();
      await again.locator('button[data-day="2026-10-09"]').click();
      await applyEditor(page, again);
      await expect(again).toBeHidden();
      await expect(pill(page, "Período")).toHaveAccessibleName(
        "Período: 05/10 a 09/10, editar"
      );

      // Limpar takes the filter out
      await pill(page, "Período").click();
      const clearing = editor(page, "Período");
      await clearing.getByRole("button", { name: "Limpar" }).click();
      await applyEditor(page, clearing);
      await expect(pill(page, "Período")).toHaveCount(0);
      await expect(count(page)).toHaveText("2 filtros ativos");
    });

    test("Limpar tudo tira todas as pílulas, some, e o foco vai a Filtrar; com uma pílula só ele não aparece", async ({
      page,
    }) => {
      await openGallery(page);
      await remover(page, "Período").click();
      await expect(clearAll(page)).toBeVisible();
      await remover(page, "Situação").click();
      await expect(clearAll(page)).toHaveCount(0);
      await expect(count(page)).toHaveText("1 filtro ativo");

      await openMenu(page);
      await item(page, "Período").click();
      await expect(editor(page, "Período")).toBeVisible();
      await page.keyboard.press("Escape");
      // Período never got a value: still one pill
      await expect(clearAll(page)).toHaveCount(0);

      await openMenu(page);
      await item(page, "Situação").click();
      const choosing = editor(page, "Situação");
      await choosing.getByRole("button", { name: "Paga" }).click();
      await applyEditor(page, choosing);
      await expect(clearAll(page)).toBeVisible();
      await clearAll(page).click();
      await expect(bar(page).locator('[data-slot="filter-pill"]')).toHaveCount(
        0
      );
      await expect(clearAll(page)).toHaveCount(0);
      await expect(count(page)).toHaveText("0 filtros ativos");
      await expect(addButton(page)).toBeFocused();
    });

    test("teclado: Tab chega a Filtrar, às pílulas e aos X na ordem; Enter abre o menu e o editor; Escape devolve o foco à pílula", async ({
      page,
    }) => {
      await openGallery(page);
      await addButton(page).focus();
      await page.keyboard.press("Tab");
      await expect(pill(page, "Período")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(remover(page, "Período")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(pill(page, "Situação")).toBeFocused();
      // the focus draws the 3 px ring of every control
      const outline = await pill(page, "Situação").evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth };
      });
      expect(outline).toEqual({ style: "solid", width: "3px" });

      await page.keyboard.press("Enter");
      const open = editor(page, "Situação");
      await expect(open).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(open).toBeHidden();
      await expect(pill(page, "Situação")).toBeFocused();

      // the menu by the keyboard: Enter opens it, Escape closes it and gives the focus back to Filtrar
      await addButton(page).focus();
      await page.keyboard.press("Enter");
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(addButton(page)).toBeFocused();
    });

    test("campo que precisa de conexão e já tem pílula: aria-disabled com o motivo à vista, não abre o editor e o X continua tirando", async ({
      page,
    }) => {
      await openGallery(page);
      const blocked = offlineBar(page).getByRole("button", {
        name: "Produto vendido: Camiseta",
      });
      await expect(blocked).toHaveAttribute("aria-disabled", "true");
      await expect(
        offlineBar(page).locator('[data-slot="filter-pill"]')
      ).toContainText("Só com conexão");
      await expect(blocked).toHaveAccessibleDescription("Só com conexão");
      // focusable (the reason is read), and neither a click nor Enter opens an editor
      await blocked.focus();
      await expect(blocked).toBeFocused();
      await blocked.click({ force: true });
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("dialog", { name: "Produto vendido" })
      ).toHaveCount(0);
      await offlineBar(page)
        .getByRole("button", { name: "Tirar o filtro Produto vendido" })
        .click();
      await expect(blocked).toHaveCount(0);
      await expect(page.getByTestId("filtros-contagem-sem-conexao")).toHaveText(
        "0 filtros ativos"
      );
    });
  });
}

/** Everything of the bar that is a control, with what "in the window" needs: none of it off the edge, at any width. */
async function insideWindow(page: Page, width: number) {
  const boxes = await bar(page)
    .locator(
      '[data-slot="filter-pill"], [data-slot="filter-add"], button:has-text("Limpar tudo")'
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right, top } = element.getBoundingClientRect();
        return { left, right, top: Math.round(top) };
      })
    );
  for (const found of boxes) {
    expect(found.left).toBeGreaterThanOrEqual(0);
    expect(found.right).toBeLessThanOrEqual(width);
  }
  return boxes;
}

test.describe("a linha de pílulas", () => {
  for (const width of [360, 320]) {
    test(`a ${width} px as três pílulas e "Limpar tudo" quebram em linhas, todas à vista, sem rolar de lado`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openGallery(page);
      await Promise.all(
        ["Período", "Situação", "Cliente"].map((field) =>
          expect(pill(page, field)).toBeVisible()
        )
      );
      const clearing = bar(page).getByRole("button", { name: "Limpar tudo" });
      await expect(clearing).toBeVisible();
      // nothing scrolls inside the bar and every control is inside the window, with no gesture
      await expect(
        bar(page).locator('[data-slot="scroll-area-viewport"]')
      ).toHaveCount(0);
      const boxes = await insideWindow(page, width);
      expect(boxes).toHaveLength(5);
      // the row wrapped: more than one line, and "Limpar tudo" is the last thing in it
      expect(new Set(boxes.map((found) => found.top)).size).toBeGreaterThan(1);
      // "Limpar tudo" is in the last line: no pill is below it
      const clearingTop = Math.round((await box(clearing)).y);
      expect(clearingTop).toBeGreaterThanOrEqual(
        Math.max(...boxes.map((found) => found.top))
      );
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(0);
    });
  }

  test("um valor comprido encurta a pílula em vez de sair da janela, e o editor abre dentro dela", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openGallery(page);
    await remover(page, "Cliente").click();
    await openMenu(page);
    await item(page, "Cliente").click();
    const open = editor(page, "Cliente");
    await open
      .getByRole("textbox", { name: "Cliente" })
      .fill("Maria Aparecida da Conceição Souza de Albuquerque");
    const editorBox = await box(open);
    expect(editorBox.x).toBeGreaterThanOrEqual(0);
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(360);
    await page.keyboard.press("Enter");
    await expect(open).toBeHidden();
    await insideWindow(page, 360);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(0);
  });

  test("a 1280 px as pílulas ficam à vista e nada rola", async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openGallery(page);
    await insideWindow(page, 1280);
    await expect(
      bar(page).locator('[data-slot="scroll-area-viewport"]')
    ).toHaveCount(0);
  });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`movimento: no nível full a pílula sai com animação e fica no lugar até acabar; no celular e com prefers-reduced-motion sai na hora (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await openGallery(page);
    // the level of the page: the Pixel 5 project at 360 px is a phone (`essential`), the reduce is `none`
    const level = await expectMotionLevel(page);
    const moves = level === "full";
    if (moves) {
      // the animated layer comes by import() after the first paint
      await expect
        .poll(() =>
          bar(page)
            .locator('[data-slot="filter-pill"]')
            .first()
            .evaluate((element) => element.getAttribute("style") ?? "")
        )
        .not.toBe("");
    }
    // click and look 40 ms later: an exit that animates is still in the page, one that is switched off is not
    const stillThere = await page.evaluate(async () => {
      const x = document.querySelector<HTMLButtonElement>(
        '[aria-label="Tirar o filtro Cliente"]'
      );
      x?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return document.querySelector('[aria-label^="Cliente: "]') !== null;
    });
    expect(stillThere).toBe(moves);
    await expect(pill(page, "Cliente")).toHaveCount(0);

    // adding: the pill enters from a lower opacity, or at once with no style at all when nothing moves
    await openMenu(page);
    await item(page, "Cliente").click();
    const style = await pill(page, "Cliente").evaluate(
      (element) =>
        element.closest('[data-slot="filter-pill"]')?.getAttribute("style") ??
        ""
    );
    if (moves) {
      expect(style).toContain("opacity");
    } else {
      expect(style).toBe("");
    }
  });
}

test.describe("a 360 px, com toque", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });

  test("a barra fechada não tem área de toque pequena nem sobreposta (os itens do menu aberto têm a altura medida no teste do menu: um controle debaixo de um popover aberto não é falha de nenhum dos dois)", async ({
    page,
  }) => {
    await openGallery(page);
    const closed = (
      await touchFaults(page, { exemptInlineLinks: true, minimum: 44 })
    ).filter((fault) => CLOSED_FAULT.test(fault));
    expect(closed).toEqual([]);
  });
});

for (const width of [360, 320]) {
  test.describe(`pílula bloqueada a ${width} px, com toque`, () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 740, width },
    });

    test("a pílula sem conexão já está à vista: o motivo e o X ficam dentro da largura, e o valor é o que encurta", async ({
      page,
    }) => {
      await openGallery(page);
      const blocked = offlineBar(page).getByRole("button", {
        name: "Produto vendido: Camiseta",
      });
      const reason = offlineBar(page).getByText(REASON);
      const remove = offlineBar(page).getByRole("button", {
        name: "Tirar o filtro Produto vendido",
      });
      const inWindow = async (locator: Locator) => {
        const found = await box(locator);
        return found.x >= 0 && found.x + found.width <= width;
      };
      // no touch, no scroll: the row wraps, so the pill, its reason and its X are in the window from the start
      expect(await inWindow(reason)).toBe(true);
      expect(await inWindow(remove)).toBe(true);
      // the label and the value gave way to the reason, not the other way round: the pill is not wider than the screen
      const pillBox = await box(
        offlineBar(page).locator('[data-slot="filter-pill"]')
      );
      expect(pillBox.width).toBeLessThanOrEqual(width);
      // the value is cut short but not gone (the name of the button holds all of it)
      const value = blocked.locator("span.truncate").last();
      expect((await box(value)).width).toBeGreaterThan(0);
      // and the page does not scroll sideways
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(0);
    });
  });
}

/** The animations of the page have ended (a menu or an editor still fading in has a color between two): axe reads it then. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );

/** axe over the editor of one pill, open, then closed with Escape (which gives the focus back to the pill). */
async function axeWithEditor(page: Page, label: string) {
  await pill(page, label).click();
  const open = editor(page, label);
  await expect(open).toBeVisible();
  await settled(page);
  expect(
    await axeFaults(
      page,
      onPhone(page)
        ? '[data-slot="dialog-content"]'
        : '[data-slot="popover-content"]'
    )
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(open).toBeHidden();
}

for (const theme of ["claro", "escuro"] as const) {
  test(`axe não acha nada com a barra fechada, com o menu aberto e com cada editor aberto (tema ${theme})`, async ({
    page,
  }) => {
    await openGallery(page, theme);
    await settled(page);
    expect(await axeFaults(page)).toEqual([]);

    await openMenu(page);
    await settled(page);
    expect(await axeFaults(page, '[role="menu"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();

    await axeWithEditor(page, "Período");
    await axeWithEditor(page, "Situação");
    await axeWithEditor(page, "Cliente");
  });
}
