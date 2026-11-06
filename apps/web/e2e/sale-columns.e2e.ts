/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { measureItem, setBrowserFont } from "./sale-item-geometry";
import { serve } from "./shell-server";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The sale goes to two columns when its container, the parent of the form, measures 44 rem or more: not when the window
 * does, because the side column of the shell takes 16 rem of it and a big font takes more. `rem` is the real font size
 * of the page (`Page.setFontSizes`), as in `breakpoints-rem.e2e.ts`.
 */

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "`Page.setFontSizes` is a Chrome DevTools command"
);
test.skip(
  ({ isMobile }) => isMobile,
  "a coarse pointer is `touch` at any width: the lines are measured with a mouse"
);

const TWO_COLUMNS_FROM_REM = 44;
const MAIN_MINIMUM_REM = 24;
const SIDEBAR_KEY = "sidebar_state";
const LAB_PROFILE = /Maquininha do laboratório/;
const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const PROFILE = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** What the form shows: how many columns, and which of the bar, the summary button and the sticky summary are there. */
function saleLayout(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector("[data-sale-form]");
    const container = form?.parentElement;
    const bar = document.querySelector("[data-submit-bar]");
    const aside = form?.querySelector("aside");
    const confirm = aside?.querySelector('button[type="submit"]');
    const control = form?.querySelector("button");
    const shown = (element: Element | null | undefined) =>
      element ? getComputedStyle(element).display !== "none" : false;
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize
    );
    return {
      barShown: shown(bar),
      columns: form
        ? getComputedStyle(form).gridTemplateColumns.split(" ").length
        : 0,
      confirmShown: shown(confirm),
      containerRem: (container?.getBoundingClientRect().width ?? 0) / rem,
      controlMargin: control
        ? getComputedStyle(control).scrollMarginBottom
        : "",
      display: form ? getComputedStyle(form).display : "",
      sideScroll:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      summarySticky: aside ? getComputedStyle(aside).position : "",
    };
  });
}

const ONE_COLUMN = {
  barShown: true,
  columns: 1,
  confirmShown: false,
  display: "flex",
  summarySticky: "static",
};
const TWO_COLUMNS = {
  barShown: false,
  columns: 2,
  confirmShown: true,
  display: "grid",
  summarySticky: "sticky",
};

async function openShellSale(page: Page, pixels: number) {
  await page.setViewportSize({ height: 800, width: 1280 });
  await setBrowserFont(page, pixels);
  await serve(page);
  await page.goto("/sales");
  await expect(page.locator("[data-sale-form]")).toBeVisible({
    timeout: 20_000,
  });
}

for (const pixels of [16, 20]) {
  test.describe(`a Venda no app, letra de ${pixels} px`, () => {
    test("está em duas colunas se e somente se o contêiner mede 44 rem ou mais, com a lateral aberta e recolhida", async ({
      page,
    }) => {
      await openShellSale(page, pixels);
      const seen = new Set<number>();
      for (const open of [true, false]) {
        // biome-ignore lint/performance/noAwaitInLoops: the side column open and then folded, on the same page
        await page.evaluate(
          ([key, value]) => window.localStorage.setItem(key, value),
          [SIDEBAR_KEY, String(open)] as const
        );
        for (const width of [900, 1024, 1280]) {
          // biome-ignore lint/performance/noAwaitInLoops: one window after the other on the same page
          await page.setViewportSize({ height: 800, width });
          await page.reload();
          await expect(page.locator("[data-sale-form]")).toBeVisible({
            timeout: 20_000,
          });
          const layout = await saleLayout(page);
          const name = `${width} px, lateral ${open ? "aberta" : "recolhida"}: ${layout.containerRem.toFixed(2)} rem`;
          const two = layout.containerRem >= TWO_COLUMNS_FROM_REM;
          expect(layout, name).toMatchObject(two ? TWO_COLUMNS : ONE_COLUMN);
          expect(layout.sideScroll, name).toBe(false);
          seen.add(layout.columns);
        }
      }
      expect([...seen].sort()).toEqual([1, 2]);
    });
  });
}

/**
 * The windows where the window and the space disagree: with the side column open (16 rem), 900 px of 16 px is 56.25 rem
 * of window and 38 rem of sale, and 1200 px of 20 px is 60 rem of window and 42 rem of sale.
 */
for (const [pixels, width, columns] of [
  [16, 900, 1],
  [20, 1200, 1],
  [16, 1024, 2],
  [16, 1280, 2],
] as const) {
  test(`a ${width} px com letra de ${pixels} px e a lateral aberta a Venda tem ${columns === 1 ? "uma coluna" : "duas colunas"}`, async ({
    page,
  }) => {
    await openShellSale(page, pixels);
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [SIDEBAR_KEY, "true"] as const
    );
    await page.setViewportSize({ height: 800, width });
    await page.reload();
    await expect(page.locator("[data-sale-form]")).toBeVisible({
      timeout: 20_000,
    });
    expect((await saleLayout(page)).columns).toBe(columns);
  });
}

/** The lab of the offline screens has no shell: the sale is as wide as the window less the lab's own margin. */
async function openLabSale(page: Page, pixels: number, width: number) {
  await page.setViewportSize({ height: 640, width });
  await setBrowserFont(page, pixels);
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [PROFILE] }))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(page.locator("[data-sale-form]")).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize
    )
  ).toBe(`${pixels}px`);
}

async function pickShirt(page: Page): Promise<Locator> {
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Rede disponível").check();
  return item;
}

async function fillSale(page: Page): Promise<Locator> {
  const item = await pickShirt(page);
  await item.getByLabel("Quantidade").fill("1");
  await item.getByLabel("Preço cobrado").fill("99.999,99");
  await item.getByLabel("Preço de tabela").fill("99.999,99");
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Transferência" })
    .check();
  return item;
}

/** Sets the width of the container of the sale, the parent of the form, as the shell's column would. */
function setContainerWidth(page: Page, css: string) {
  return page.evaluate((width) => {
    const container = document.querySelector("[data-sale-form]")?.parentElement;
    if (container) {
      container.style.width = width;
      container.style.justifySelf = "start";
    }
  }, css);
}

/** Texts of the main column that leave their own box, scroll inside it, or end in an ellipsis. */
function cutTexts(page: Page) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: it runs in the page, so it cannot call a helper of this file
  return page.evaluate(() => {
    const main = document.querySelector("[data-sale-form] > div");
    const found: string[] = [];
    if (!main) {
      return ["sem coluna principal"];
    }
    for (const element of main.querySelectorAll("label, button, h2, p, span")) {
      if (
        element.getClientRects().length === 0 ||
        element.closest(".sr-only") ||
        element.getBoundingClientRect().width <= 2
      ) {
        continue;
      }
      const text = (element.textContent ?? "").trim();
      if (text === "" || element.querySelector("label, button, p")) {
        continue;
      }
      let textRight = Number.NEGATIVE_INFINITY;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(".sr-only")) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        textRight = Math.max(textRight, range.getBoundingClientRect().right);
      }
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const inner = box.right - Number.parseFloat(style.paddingRight) + 0.5;
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        textRight > inner ||
        style.textOverflow === "ellipsis"
      ) {
        found.push(text.slice(0, 40));
      }
    }
    return found;
  });
}

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

for (const pixels of [16, 20]) {
  test(`letra de ${pixels} px: no menor contêiner que dá duas colunas (44 rem) a principal tem 24 rem ou mais e nada se corta nem se sobrepõe; um pixel a menos é uma coluna`, async ({
    page,
  }) => {
    await openLabSale(page, pixels, 1280);
    const item = await fillSale(page);
    await setContainerWidth(page, `${TWO_COLUMNS_FROM_REM}rem`);
    await expect
      .poll(async () => (await saleLayout(page)).columns)
      .toBe(TWO_COLUMNS.columns);
    const layout = await saleLayout(page);
    expect(layout).toMatchObject(TWO_COLUMNS);
    expect(layout.controlMargin).toBe("0px");
    expect(layout.containerRem).toBeCloseTo(TWO_COLUMNS_FROM_REM, 2);
    const mainRem = await page.evaluate(
      () =>
        (document
          .querySelector("[data-sale-form] > div")
          ?.getBoundingClientRect().width ?? 0) /
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    );
    expect(mainRem).toBeGreaterThanOrEqual(MAIN_MINIMUM_REM);
    const geometry = await measureItem(item);
    expect([...geometry.clipped, ...geometry.overlaps]).toEqual([]);
    expect(await cutTexts(page)).toEqual([]);
    const refresh = await page
      .getByRole("button", { name: "Atualizar estoque e perfis" })
      .boundingBox();
    const count = await page.getByText("1 item", { exact: true }).boundingBox();
    expect(refresh).not.toBeNull();
    expect(count).not.toBeNull();
    expect(overlap(refresh as Box, count as Box)).toBe(false);
    const transfer = page
      .getByRole("radiogroup", { name: "Método de pagamento" })
      .getByText("Transferência", { exact: true });
    await expect(transfer).toBeVisible();

    await setContainerWidth(page, `calc(${TWO_COLUMNS_FROM_REM}rem - 1px)`);
    await expect
      .poll(async () => (await saleLayout(page)).columns)
      .toBe(ONE_COLUMN.columns);
    const narrower = await saleLayout(page);
    expect(narrower).toMatchObject(ONE_COLUMN);
    expect(narrower.controlMargin).toBe(`${7 * pixels}px`);
    expect(await cutTexts(page)).toEqual([]);
  });
}

const CARDS_TWO_FROM_REM = 18.5;
const CARDS_THREE_FROM_REM = 26.5;

for (const pixels of [16, 20]) {
  test(`letra de ${pixels} px: os cartões de método seguem a largura do grupo (uma, duas e três colunas) e "Transferência" cabe em todas`, async ({
    page,
  }) => {
    await openLabSale(page, pixels, 1280);
    const group = page.getByRole("radiogroup", { name: "Método de pagamento" });
    const seen = new Set<number>();
    for (let rem = 12; rem <= 40; rem += 0.5) {
      // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
      const read = await group.evaluate((node, width) => {
        const holder = node.parentElement as HTMLElement;
        holder.style.width = `${width}rem`;
        const labels = [...node.querySelectorAll("label")];
        const cut = labels.filter((label) => {
          const box = label.getBoundingClientRect();
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(text);
            const line = range.getBoundingClientRect();
            if (
              line.width > 0 &&
              (line.right > box.right - 1 || line.left < box.left)
            ) {
              return true;
            }
          }
          return label.scrollWidth > label.clientWidth;
        });
        return {
          columns: getComputedStyle(node).gridTemplateColumns.split(" ").length,
          cut: cut.map((label) => label.textContent?.trim()),
        };
      }, rem);
      expect(read.cut, `${rem} rem`).toEqual([]);
      let expected = 1;
      if (rem >= CARDS_THREE_FROM_REM) {
        expected = 3;
      } else if (rem >= CARDS_TWO_FROM_REM) {
        expected = 2;
      }
      expect(read.columns, `${rem} rem`).toBe(expected);
      seen.add(read.columns);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
}

const INSTALLMENTS_TWO_FROM_REM = 24.5;
const ADJUSTMENT_THREE_FROM_REM = 26.5;

for (const pixels of [16, 20]) {
  test(`letra de ${pixels} px: as parcelas e o ajuste seguem a largura do cartão e nenhum campo corta o valor`, async ({
    page,
  }) => {
    await openLabSale(page, pixels, 1280);
    await page.getByRole("radio", { name: "Crédito" }).check();
    await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
    await page.getByRole("button", { name: "Adicionar ajuste" }).click();
    await page
      .getByRole("combobox", { exact: true, name: "Tipo de ajuste" })
      .click();
    await page.getByRole("option", { exact: true, name: "Acréscimo" }).click();
    await page
      .getByRole("combobox", { exact: true, name: "Como informar" })
      .click();
    await page
      .getByRole("option", { exact: true, name: "Valor fixo (R$)" })
      .click();
    const grids = [
      { fields: 2, from: INSTALLMENTS_TWO_FROM_REM, id: "sale-installments" },
      { fields: 3, from: ADJUSTMENT_THREE_FROM_REM, id: "sale-adjustment-" },
    ];
    for (const grid of grids) {
      const seen = new Set<number>();
      for (let rem = 12; rem <= 40; rem += 0.5) {
        // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
        const read = await page.evaluate(
          ([id, width]) => {
            const field = document.querySelector(`[id^="${id}"]`);
            const columnsOf =
              field?.closest("[data-slot=field]")?.parentElement;
            const holder = columnsOf?.parentElement;
            if (!(columnsOf && holder)) {
              return null;
            }
            holder.style.width = `${width}rem`;
            const cut = [...columnsOf.querySelectorAll("*")].filter(
              (element) => {
                const box = element.getBoundingClientRect();
                return (
                  box.width >= 2 &&
                  !element.closest(".sr-only") &&
                  element.scrollWidth > element.clientWidth + 1 &&
                  getComputedStyle(element).overflowX !== "visible"
                );
              }
            );
            return {
              columns: new Set(
                [...columnsOf.children].map(
                  (child) => child.getBoundingClientRect().left
                )
              ).size,
              cut: cut.map((element) => element.textContent?.trim()),
            };
          },
          [grid.id, rem] as const
        );
        expect(read, `${grid.id} ${rem} rem`).not.toBeNull();
        expect(read?.cut, `${grid.id} ${rem} rem`).toEqual([]);
        expect(read?.columns, `${grid.id} ${rem} rem`).toBe(
          rem >= grid.from ? grid.fields : 1
        );
        seen.add(read?.columns ?? 0);
      }
      expect([...seen].sort(), grid.id).toEqual([1, grid.fields]);
    }
  });
}

/** Where the bar and a field are: the field must end above the top of the bar. */
function barAndField(field: Locator) {
  return field.evaluate((node) => {
    const bar = document.querySelector("[data-submit-bar]");
    return {
      bar: bar ? bar.getBoundingClientRect().top : null,
      barShown: bar ? getComputedStyle(bar).display !== "none" : false,
      bottom: node.getBoundingClientRect().bottom,
      margin: getComputedStyle(node).scrollMarginBottom,
    };
  });
}

for (const pixels of [16, 20]) {
  test(`letra de ${pixels} px: em uma coluna um campo focado fica acima da barra de total; em duas colunas não há barra nem margem de rolagem`, async ({
    page,
  }) => {
    await openLabSale(page, pixels, 520);
    await fillSale(page);
    const last = page.getByRole("button", { name: "Alterar data e ajustes" });
    expect((await saleLayout(page)).columns).toBe(1);
    // the field is left under the bar, still inside the window, where the browser would not move it without the margin
    await last.evaluate((node) => {
      node.scrollIntoView({ behavior: "instant", block: "center" });
      const { bottom } = node.getBoundingClientRect();
      window.scrollBy({
        behavior: "instant",
        top: bottom - (window.innerHeight - 8),
      });
    });
    expect((await barAndField(last)).bottom).toBeGreaterThan(
      (await barAndField(last)).bar ?? 0
    );
    await last.focus();
    await expect
      .poll(async () => {
        const state = await barAndField(last);
        return state.bar !== null && state.bottom <= state.bar;
      })
      .toBe(true);
    const oneColumn = await barAndField(last);
    expect(oneColumn.barShown).toBe(true);
    expect(oneColumn.margin).not.toBe("0px");

    await page.setViewportSize({ height: 640, width: 1280 });
    await expect
      .poll(async () => (await saleLayout(page)).columns)
      .toBe(TWO_COLUMNS.columns);
    const twoColumns = await barAndField(last);
    expect(twoColumns.barShown).toBe(false);
    expect(twoColumns.margin).toBe("0px");
    expect(await saleLayout(page)).toMatchObject(TWO_COLUMNS);
  });
}

/** The box of the element is inside the window and what is at its center is the element, not something over it. */
async function expectNotCut(target: Locator, name: string) {
  const state = await target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return {
      covered: !(hit && (node.contains(hit) || hit.contains(node))),
      height: box.height,
      inside:
        box.left >= -0.5 &&
        box.right <= document.documentElement.clientWidth + 0.5,
    };
  });
  expect(state.height, name).toBeGreaterThan(0);
  expect(state.inside, `${name} dentro da janela`).toBe(true);
  expect(state.covered, `${name} sem nada por cima`).toBe(false);
}

for (const [label, width, columns] of [
  ["uma coluna", 520, 1],
  ["duas colunas", 1280, 2],
] as const) {
  test(`${label}: a lista de produtos, o perfil, a data e o descartar abrem sem corte`, async ({
    page,
  }) => {
    await page.route("**/rpc/sale/confirm", (route) =>
      route.abort("connectionreset")
    );
    await openLabSale(page, 16, width);
    expect((await saleLayout(page)).columns).toBe(columns);

    await page.getByLabel("Rede disponível").uncheck();
    const item = page.getByRole("group", { exact: true, name: "Item 1" });
    await item.getByLabel("Produto ou variante").fill("camiseta azul");
    const option = page.getByRole("option", { name: SHIRT_OPTION });
    await expect(option).toBeVisible();
    await expectNotCut(option, "lista de produtos");
    await option.click();
    await page.getByLabel("Rede disponível").check();

    const profile = page.getByRole("combobox", {
      exact: true,
      name: "Perfil de pagamento",
    });
    await profile.click();
    const profileOption = page.getByRole("option", {
      name: LAB_PROFILE,
    });
    await expect(profileOption).toBeVisible();
    await expectNotCut(profileOption, "perfil de pagamento");
    await page
      .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
      .click();

    await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
    await page.getByRole("button", { name: "Dia, Escolher data" }).click();
    const today = page.getByRole("button", { exact: true, name: "Hoje" });
    await expect(today).toBeVisible();
    await expectNotCut(today, "seletor de data");
    await today.click();
    await page.getByRole("button", { name: "Usar agora" }).click();

    await item.getByLabel("Quantidade").fill("1");
    await item.getByLabel("Preço cobrado").fill("45,00");
    await page
      .getByRole("radiogroup", { name: "Método de pagamento" })
      .getByRole("radio", { name: "Pix" })
      .check();
    await page.getByRole("button", { name: "Confirmar venda" }).click();
    const discard = page.getByRole("button", {
      name: "Descartar esta venda e começar outra",
    });
    await expect(discard).toBeVisible();
    await discard.click();
    const confirmDiscard = page.getByRole("button", {
      name: "Sim, descartar e começar outra",
    });
    await expect(confirmDiscard).toBeVisible();
    await confirmDiscard.scrollIntoViewIfNeeded();
    await expectNotCut(confirmDiscard, "descartar");
  });
}
