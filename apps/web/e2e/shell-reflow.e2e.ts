/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serve } from "./shell-server";

skipOutsideChromium();

const BAR_LABELS = ["Início", "Histórico", "Vender", "Estoque", "Mais"];
const FLOOR_PIXELS = 13.75;
const NORMAL_LABEL_PIXELS = 12;
const SLACK = 1;
const ANY_ID = /.+/;
const EXPENSES_CHUNK = /expenses-page[^/]*\.js/;
const EXPENSE_TABS = "Lançamentos, recorrentes e categorias";
const SEARCHES = [
  { hint: "Produto, variante ou SKU", narrowBelowRem: 14, path: "/inventory" },
  { hint: "Nome, telefone ou e-mail", narrowBelowRem: 15, path: "/customers" },
  { hint: "Nome do produto", narrowBelowRem: 14, path: "/products" },
] as const;

const bar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Destinos" });

async function open(
  page: Page,
  path: string,
  { fontPixels, width }: { fontPixels: number; width: number }
) {
  await openReflowViewport(page, { fontPixels, width });
  await serve(page);
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectReflowFont(page, fontPixels);
}

interface LabelBox {
  clientWidth: number;
  fontPixels: number;
  letterSpacing: string;
  lineTexts: string[];
  lines: number;
  name: string;
  scrollWidth: number;
}

function labelBoxes(navigation: Locator) {
  return navigation.evaluate((nav) => {
    const linesOf = (target: HTMLElement) => {
      const lines: string[] = [];
      let lastTop = Number.NaN;
      let current = "";
      const texts = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      for (let part = texts.nextNode(); part; part = texts.nextNode()) {
        const content = part.textContent ?? "";
        for (let index = 0; index < content.length; index += 1) {
          const letter = document.createRange();
          letter.setStart(part, index);
          letter.setEnd(part, index + 1);
          const { top } = letter.getBoundingClientRect();
          if (Number.isNaN(lastTop) || Math.abs(top - lastTop) > 1) {
            current = "";
            lines.push(current);
            lastTop = top;
          }
          current += content[index];
          lines[lines.length - 1] = current;
        }
      }
      return lines;
    };
    return [...nav.querySelectorAll("a, button")].map((cell): LabelBox => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && (node.textContent ?? "").trim() === "") {
        node = walker.nextNode();
      }
      const target = node?.parentElement ?? (cell as HTMLElement);
      const style = getComputedStyle(target);
      const line = Number.parseFloat(style.lineHeight);
      const range = document.createRange();
      range.selectNodeContents(target);
      const lineTexts = linesOf(target);
      return {
        clientWidth: target.clientWidth,
        fontPixels: Number.parseFloat(style.fontSize),
        letterSpacing: style.letterSpacing,
        lineTexts,
        lines: Math.round(range.getBoundingClientRect().height / line),
        name: (target.textContent ?? "").trim(),
        scrollWidth: target.scrollWidth,
      };
    });
  });
}

for (const path of ["/", "/sales/history", "/inventory"]) {
  reflowTest(
    `a 320 px com letra de 20 px os cinco rótulos da barra leem inteiros em ${path}`,
    async ({ page }) => {
      await open(page, path, { fontPixels: 20, width: 320 });
      const navigation = bar(page);
      await expect(navigation).toBeVisible();
      const boxes = await labelBoxes(navigation);
      expect(boxes.map((box) => box.name)).toEqual(BAR_LABELS);
      for (const box of boxes) {
        expect(box.lines, `${box.name} em uma linha`).toBe(1);
        expect(box.scrollWidth, box.name).toBeLessThanOrEqual(
          box.clientWidth + SLACK
        );
        expect(box.fontPixels, box.name).toBeGreaterThanOrEqual(FLOOR_PIXELS);
      }
      const history = boxes.find((box) => box.name === "Histórico");
      expect(history?.fontPixels).toBe(FLOOR_PIXELS);
      expect(history?.letterSpacing).not.toBe("normal");
      await assertNothingClipped(navigation);
      await assertNoEllipsis(navigation);
      await assertNoPageScroll(page);
    }
  );
}

reflowTest(
  "a barra mantém os nomes, os destinos e a marca da tela atual",
  async ({ page }) => {
    await open(page, "/sales/history", { fontPixels: 20, width: 320 });
    const navigation = bar(page);
    const links = navigation.getByRole("link");
    await expect(links).toHaveText([
      "Início",
      "Histórico",
      "Vender",
      "Estoque",
    ]);
    await expect(
      links.evaluateAll((items) =>
        items.map((item) => item.getAttribute("href"))
      )
    ).resolves.toEqual(["/", "/sales/history", "/sales", "/inventory"]);
    await expect(
      navigation.getByRole("link", { exact: true, name: "Histórico" })
    ).toHaveAttribute("aria-current", "page");
    await expect(
      navigation.getByRole("button", { exact: true, name: "Mais" })
    ).toBeVisible();
  }
);

reflowTest(
  "a 320 px com letra de 24 px os rótulos quebram em duas linhas, inteiros, e a barra reserva a altura",
  async ({ page }) => {
    await open(page, "/inventory", { fontPixels: 24, width: 320 });
    const navigation = bar(page);
    const boxes = await labelBoxes(navigation);
    for (const box of boxes) {
      expect(box.scrollWidth, box.name).toBeLessThanOrEqual(
        box.clientWidth + SLACK
      );
    }
    expect(boxes.find((box) => box.name === "Histórico")?.lines).toBe(2);
    await assertNoEllipsis(navigation);
    const heights = await page.evaluate(() => {
      const nav = document.querySelector("[data-bottom-bar]");
      const inset = nav
        ?.closest("body")
        ?.querySelector("[data-slot=sidebar-inset]");
      return {
        bar: nav?.getBoundingClientRect().height ?? 0,
        reserved: inset
          ? Number.parseFloat(getComputedStyle(inset).paddingBottom)
          : 0,
      };
    });
    expect(
      heights.reserved,
      "o conteúdo termina acima da barra"
    ).toBeGreaterThanOrEqual(heights.bar - SLACK);
  },
  { coarse: false }
);

for (const [fontPixels, historyLines] of [
  [20, 1],
  [21, 2],
  [22, 2],
  [23, 2],
  [24, 2],
] as const) {
  reflowTest(
    `a 320 px com letra de ${fontPixels} px nenhum rótulo da barra deixa uma letra sozinha numa linha e Histórico e Estoque, quando quebram, quebram numa sílaba`,
    async ({ page }) => {
      await open(page, "/inventory", { fontPixels, width: 320 });
      const boxes = await labelBoxes(bar(page));
      for (const box of boxes) {
        for (const line of box.lineTexts) {
          expect(
            line.length,
            `${box.name}: linhas ${JSON.stringify(box.lineTexts)}`
          ).toBeGreaterThan(1);
        }
      }
      const history = boxes.find((box) => box.name === "Histórico");
      expect(history?.lineTexts.join("")).toBe("Histórico");
      expect(history?.lineTexts).toEqual(
        historyLines === 1 ? ["Histórico"] : ["Histó", "rico"]
      );
      const inventory = boxes.find((box) => box.name === "Estoque");
      expect(inventory?.lineTexts.join("")).toBe("Estoque");
      expect([["Estoque"], ["Esto", "que"]]).toContainEqual(
        inventory?.lineTexts
      );
    }
  );
}

reflowTest(
  "a 360 px com letra de 16 px a reserva da barra de uma linha é a altura medida da barra",
  async ({ page }) => {
    await open(page, "/inventory", { fontPixels: 16, width: 360 });
    const measured = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;height:var(--app-bottom-bar)";
      document.body.append(probe);
      const reserve = probe.getBoundingClientRect().height;
      probe.remove();
      const nav = document.querySelector("[data-bottom-bar]");
      const inset = document.querySelector("[data-slot=sidebar-inset]");
      return {
        barHeight: nav?.getBoundingClientRect().height ?? 0,
        insetPadding: inset
          ? Number.parseFloat(getComputedStyle(inset).paddingBottom)
          : 0,
        reserve,
      };
    });
    expect(measured.barHeight).toBeGreaterThan(0);
    expect(Math.abs(measured.reserve - measured.barHeight)).toBeLessThanOrEqual(
      0.5
    );
    expect(
      Math.abs(measured.insetPadding - measured.barHeight)
    ).toBeLessThanOrEqual(0.5);
  }
);

// The emulated window is never narrower than 320 px, so the reserve is read at the narrowest real window with fonts
// that put it clear of the 15.95 rem limit; at 20 px it sits 0.05 rem above it and the line count of the label depends
// on the font the machine renders, so only the geometry is asserted there (`null`).
for (const [width, fontPixels, labelLines] of [
  [320, 22, 2],
  [320, 21, 2],
  [320, 20, null],
] as const) {
  reflowTest(
    `a ${width} px com letra de ${fontPixels} px a altura da barra é a reserva e o fim da página fica acima dela`,
    async ({ page }) => {
      await open(page, "/inventory", { fontPixels, width });
      const boxes = await labelBoxes(bar(page));
      if (labelLines !== null) {
        expect(boxes.find((box) => box.name === "Histórico")?.lines).toBe(
          labelLines
        );
      }
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight)
      );
      const measured = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;height:var(--app-bottom-bar)";
        document.body.append(probe);
        const reserve = probe.getBoundingClientRect().height;
        probe.remove();
        const nav = document.querySelector("[data-bottom-bar]");
        const last = document.querySelector("main")?.lastElementChild;
        const inset = document.querySelector("[data-slot=sidebar-inset]");
        return {
          insetPadding: inset
            ? Number.parseFloat(getComputedStyle(inset).paddingBottom)
            : 0,
          barHeight: nav?.getBoundingClientRect().height ?? 0,
          barTop: nav?.getBoundingClientRect().top ?? 0,
          lastBottom: last?.getBoundingClientRect().bottom ?? Number.NaN,
          reserve,
        };
      });
      expect(
        measured.reserve,
        "a reserva é a altura real da barra"
      ).toBeCloseTo(measured.barHeight, 0);
      expect(
        measured.insetPadding,
        "o conteúdo reserva a altura da barra"
      ).toBeGreaterThanOrEqual(measured.barHeight - SLACK);
      expect(
        measured.lastBottom,
        "o último elemento da página termina acima da barra"
      ).toBeLessThanOrEqual(measured.barTop + SLACK);
    }
  );
}

for (const [width, height] of [
  [360, 740],
  [390, 844],
] as const) {
  reflowTest(
    `a ${width} px com letra de 16 px a barra é a de sempre: 12 px, uma linha, sem espaçamento apertado`,
    async ({ page }) => {
      await open(page, "/", { fontPixels: 16, width });
      await page.setViewportSize({ height, width });
      const boxes = await labelBoxes(bar(page));
      expect(boxes.map((box) => box.name)).toEqual(BAR_LABELS);
      for (const box of boxes) {
        expect(box.fontPixels, box.name).toBe(NORMAL_LABEL_PIXELS);
        expect(box.letterSpacing, box.name).toBe("normal");
        expect(box.lines, box.name).toBe(1);
      }
    }
  );
}

interface Margins {
  left: number;
  name: string;
  right: number;
}

function pageMargins(page: Page, panel: string) {
  return page.evaluate((selector) => {
    const width = document.documentElement.clientWidth;
    const margins: Margins[] = [];
    const take = (name: string, item: Element | null | undefined) => {
      if (!item) {
        return;
      }
      const { left, right } = item.getBoundingClientRect();
      margins.push({ left, name, right: width - right });
    };
    const list = document.querySelector('[role="tablist"]');
    take("faixa de abas", list?.parentElement?.parentElement);
    const shown = document.querySelector(selector);
    take("painel", shown);
    for (const child of shown?.children ?? []) {
      take(`filho ${child.tagName.toLowerCase()}`, child);
    }
    return margins;
  }, panel);
}

for (const [path, tab, screen] of [
  ["/dashboard", "Resultado", "Resultado"],
  ["/expenses", "Lançamentos", "Despesas"],
] as const) {
  reflowTest(
    `a 320 px com letra de 20 px a página de ${screen} não rola na horizontal e a margem direita é a da esquerda`,
    async ({ page }) => {
      await open(page, path, { fontPixels: 20, width: 320 });
      await expect(
        page.getByRole("tab", { exact: true, name: tab })
      ).toHaveAttribute("aria-selected", "true");
      await assertNoPageScroll(page);
      const margins = await pageMargins(
        page,
        '[role="tabpanel"]:not([hidden])'
      );
      expect(margins.length).toBeGreaterThan(2);
      for (const margin of margins) {
        expect(
          Math.abs(margin.right - margin.left),
          `${margin.name}: ${margin.left} px à esquerda, ${margin.right} px à direita`
        ).toBeLessThanOrEqual(SLACK);
      }
    }
  );
}

reflowTest(
  "a 320 px com letra de 20 px a página não rola na horizontal nem enquanto o esqueleto de Despesas espera o código da tela",
  async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(EXPENSES_CHUNK, async (route) => {
      await held;
      await route.continue();
    });
    await openReflowViewport(page, { fontPixels: 20, width: 320 });
    await serve(page);
    await page.goto("/expenses");
    await expect(page.getByText("Carregando as despesas…")).toBeAttached();
    await assertNoPageScroll(page);
    release();
    await expect(
      page.getByRole("tablist", { name: EXPENSE_TABS })
    ).toBeVisible();
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "a 320 px com letra de 20 px a faixa de Despesas mostra o degradê do fim, que some quando se chega às Categorias",
  async ({ page }) => {
    await open(page, "/expenses", { fontPixels: 20, width: 320 });
    const strip = page.getByRole("tablist", { name: EXPENSE_TABS });
    const scroller = strip.locator("xpath=..");
    const frame = scroller.locator("xpath=..");
    const end = frame.locator('[data-tabs-edge="end"]');
    const categories = strip.getByRole("tab", {
      exact: true,
      name: "Categorias",
    });
    await expect(end).toHaveCount(1);
    const geometry = await frame.evaluate((element) => {
      const fade = element.querySelector('[data-tabs-edge="end"]');
      const tab = element.querySelector('[data-value="categorias"]');
      const box = element.getBoundingClientRect();
      return {
        fadeOpacity: fade ? Number(getComputedStyle(fade).opacity) : 0,
        fadeRight: fade?.getBoundingClientRect().right ?? 0,
        frameRight: box.right,
        tabRight: tab?.getBoundingClientRect().right ?? 0,
        window: document.documentElement.clientWidth,
      };
    });
    expect(geometry.fadeOpacity).toBeGreaterThan(0);
    expect(
      geometry.tabRight,
      "Categorias começa fora da vista"
    ).toBeGreaterThan(geometry.frameRight);
    expect(
      geometry.fadeRight,
      "o degradê fica dentro da janela"
    ).toBeLessThanOrEqual(geometry.window);
    expect(geometry.fadeRight).toBeLessThanOrEqual(geometry.frameRight + SLACK);
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(end).toHaveCount(0);
    await expect(frame.locator('[data-tabs-edge="start"]')).toHaveCount(1);
    await expect(categories).toBeInViewport();
  }
);

for (const { hint, narrowBelowRem, path } of SEARCHES) {
  reflowTest(
    `a 320 px com letra de 20 px a dica de ${path} lê inteira: no campo ou na linha de baixo`,
    async ({ page }) => {
      await open(page, path, { fontPixels: 20, width: 320 });
      const field = page.getByRole("searchbox");
      await expect(field).toHaveCount(1);
      const state = await field.evaluate((input: HTMLInputElement, text) => {
        const group = input.parentElement as HTMLElement;
        const style = getComputedStyle(input);
        const probe = document.createElement("span");
        probe.style.cssText =
          "position:absolute;visibility:hidden;white-space:nowrap;";
        probe.style.font = style.font;
        probe.style.fontFamily = style.fontFamily;
        probe.style.fontSize = style.fontSize;
        probe.style.fontWeight = style.fontWeight;
        probe.style.letterSpacing = style.letterSpacing;
        probe.textContent = input.placeholder;
        document.body.append(probe);
        const placeholderWidth = probe.getBoundingClientRect().width;
        probe.remove();
        const room =
          input.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        const describedBy = input.getAttribute("aria-describedby");
        const note = describedBy ? document.getElementById(describedBy) : null;
        return {
          fieldBottom: group.getBoundingClientRect().bottom,
          groupRem:
            group.getBoundingClientRect().width /
            Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize
            ),
          noteBottomOfField: note ? note.getBoundingClientRect().top : null,
          noteClient: note?.clientWidth ?? 0,
          noteScroll: note?.scrollWidth ?? 0,
          noteText: note?.textContent ?? null,
          placeholder: input.placeholder,
          placeholderWidth,
          room,
          text,
        };
      }, hint);
      if (state.noteText === null) {
        expect(state.placeholder).toBe(hint);
        expect(state.placeholderWidth).toBeLessThanOrEqual(state.room);
        expect(state.groupRem).toBeGreaterThanOrEqual(narrowBelowRem);
      } else {
        expect(state.groupRem).toBeLessThan(narrowBelowRem);
        expect(state.placeholder).toBe("Buscar");
        expect(state.noteText).toBe(hint);
        expect(state.noteScroll).toBeLessThanOrEqual(state.noteClient + SLACK);
        expect(state.noteBottomOfField).toBeGreaterThanOrEqual(
          state.fieldBottom
        );
      }
      await assertNoPageScroll(page);
    }
  );
}

reflowTest(
  "a 320 px com letra de 20 px a dica do Estoque desce para uma linha sua, ligada ao campo, com os textos de hoje",
  async ({ page }) => {
    await open(page, "/inventory", { fontPixels: 20, width: 320 });
    const field = page.getByRole("searchbox", { name: "Buscar no estoque" });
    await expect(field).toHaveAttribute("placeholder", "Buscar");
    await expect(field).toHaveAccessibleDescription("Produto, variante ou SKU");
    const hint = page.getByText("Produto, variante ou SKU", { exact: true });
    await expect(hint).toBeVisible();
    const [fieldBox, hintBox, filtersBox] = await Promise.all([
      field.locator("xpath=..").boundingBox(),
      hint.boundingBox(),
      page
        .getByRole("search", { exact: true, name: "Filtrar estoque" })
        .getByRole("button", { exact: true, name: "Filtrar" })
        .boundingBox(),
    ]);
    expect(hintBox?.y ?? 0).toBeGreaterThanOrEqual(
      (fieldBox?.y ?? 0) + (fieldBox?.height ?? 0)
    );
    expect(
      Math.abs((filtersBox?.y ?? 0) - (fieldBox?.y ?? 99)),
      "o botão Filtrar fica na linha do campo"
    ).toBeLessThanOrEqual(8);
    await field.fill("camiseta");
    await expect(field).toHaveValue("camiseta");
    await expect(hint).toBeVisible();
    await assertNothingClipped(page.locator("main"));
  }
);

const WIDE_WINDOW = 1280;

for (const [width, fontPixels] of [
  [360, 16],
  [WIDE_WINDOW, 16],
] as const) {
  for (const { hint, path } of SEARCHES) {
    reflowTest(
      `a ${width} px com letra de ${fontPixels} px a busca de ${path} é a de sempre: a dica no campo e nenhuma linha embaixo`,
      async ({ page }) => {
        await open(page, path, { fontPixels, width });
        const field = page.getByRole("searchbox");
        await expect(field).toHaveAttribute("placeholder", hint);
        await expect(field).not.toHaveAttribute("aria-describedby", ANY_ID);
        await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
      },
      { coarse: width < WIDE_WINDOW }
    );
  }
}

/** The header at its tightest: the eye, the chip and the account side by side, the chip giving way before anything is cut. */
for (const [width, fontPixels] of [
  [320, 20],
  [360, 16],
] as const) {
  reflowTest(
    `a ${width} px com letra de ${fontPixels} px o olho, o chip e a conta cabem no cabeçalho, nessa ordem, sem corte`,
    async ({ page }) => {
      await open(page, "/", { fontPixels, width });
      const header = page.locator("[data-app-header]");
      const chip = header.locator(".sync-status");
      await expect(chip).toBeVisible({ timeout: 20_000 });
      const eye = header.getByRole("button", {
        exact: true,
        name: "Esconder valores",
      });
      const account = header.locator("[data-store-menu]");
      const [chipBox, eyeBox, accountBox] = await Promise.all(
        [chip, eye, account].map((part) => part.boundingBox())
      );
      expect(chipBox && eyeBox && accountBox).toBeTruthy();
      const right = (box: typeof chipBox) => (box ? box.x + box.width : 0);
      expect(right(chipBox)).toBeLessThanOrEqual((eyeBox?.x ?? 0) + SLACK);
      expect(right(eyeBox)).toBeLessThanOrEqual((accountBox?.x ?? 0) + SLACK);
      expect(right(accountBox)).toBeLessThanOrEqual(width);
      expect(eyeBox?.width).toBeGreaterThanOrEqual(36);
      await assertNothingClipped(header, {
        allowScroll: [".sync-status-short"],
      });
      await assertNoPageScroll(page);
    }
  );
}
