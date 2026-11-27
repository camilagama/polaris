/// <reference lib="dom" />
import type { Page } from "@playwright/test";
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
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The stock list read at 320 px with the browser font at 20 px (`./reflow`): the three buttons of every row and the
 * cost figure are whole and can be touched. With the default font (16 px) the row is the one it always was: the
 * three buttons side by side on the phone and on the desktop.
 */
skipOutsideChromium();

const NOW = new Date("2026-10-14T12:00:00-03:00");
const TOUCH = 44;
const ACTIONS = '[data-slot="button-group"] [data-stock-action]';

const BASE = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: "62.400000",
  productStatus: "active",
  quantity: 3,
  sku: null,
  updatedAt: NOW.toISOString(),
  values: [{ optionName: "tamanho", optionValueName: "42" }],
  version: 1,
};
const id = (suffix: number) => `0199c2d0-0000-7000-8000-0000000001${suffix}`;
const ENTRIES = [
  {
    ...BASE,
    productId: id(10),
    productName: "Calça jeans",
    variantId: id(11),
  },
  {
    ...BASE,
    movingAverageCost: null,
    productId: id(20),
    productName: "Camiseta do teste",
    quantity: 5,
    sku: "CAM-AZ-M",
    values: [{ optionName: "cor", optionValueName: "Azul" }],
    variantId: id(21),
  },
  {
    ...BASE,
    productId: id(30),
    productName: "Meia esportiva de algodão com nome bem comprido",
    quantity: 0,
    variantId: id(31),
  },
  {
    ...BASE,
    movingAverageCost: null,
    productId: id(40),
    productName: "Caneca esmaltada",
    productStatus: "archived",
    quantity: 0,
    values: [],
    variantId: id(41),
  },
  {
    ...BASE,
    productId: id(50),
    productName: "Tênis",
    quantity: 1234,
    variantId: id(51),
  },
];

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openStock(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.route("**/rpc/inventory/listBalances", (route) =>
    route.fulfill(rpc({ entries: ENTRIES, nextCursor: null }))
  );
  await serveLabWorker(page);
  await page.clock.setFixedTime(NOW);
  await page.goto("/offline-screens-lab?screen=stock");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Estoque" })
  ).toBeVisible();
  await expect(page.getByRole("listitem").first()).toBeVisible();
  await expect(page.locator(ACTIONS)).toHaveCount(ENTRIES.length * 3);
  await expectReflowFont(page, fontPixels);
}

interface Box {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

/** The buttons whose center is not the element on top at that point, once the button is scrolled into view. */
function untouchable(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-stock-action]")]
      .filter((button) => {
        button.scrollIntoView({ block: "center" });
        const { height, left, top, width } = button.getBoundingClientRect();
        const x = left + width / 2;
        const y = top + height / 2;
        const onTop = document.elementFromPoint(x, y);
        const inside =
          x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
        return !(inside && onTop !== null && button.contains(onTop));
      })
      .map((button) => button.getAttribute("aria-label"))
  );
}

/** Per row: the box of the card, of the group and of each button, in the order of the screen. */
function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element): Box => {
      const { bottom, height, left, right, top, width } =
        element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    const card = document.querySelector(
      "[data-list-block] ul[aria-labelledby]"
    );
    if (card === null) {
      throw new Error("the list is not on the screen");
    }
    return [...card.children].map((row) => {
      const group = row.querySelector('[data-slot="button-group"]');
      if (group === null) {
        throw new Error("a row has no group of buttons");
      }
      return {
        buttons: [...group.querySelectorAll("[data-stock-action]")].map(
          (button) => ({
            ...box(button),
            clientWidth: button.clientWidth,
            label: button.textContent ?? "",
            scrollWidth: button.scrollWidth,
          })
        ),
        card: box(card),
        group: box(group),
        groupName: group.getAttribute("aria-label"),
        row: box(row),
      };
    });
  });
}

/** Per row: the box of the name link and of the card it sits in. */
function nameLinks(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector(
      "[data-list-block] ul[aria-labelledby]"
    );
    if (card === null) {
      throw new Error("the list is not on the screen");
    }
    const cardBox = card.getBoundingClientRect();
    return [...card.querySelectorAll("li")].map((row) => {
      const link = row.querySelector<HTMLAnchorElement>('a[href^="/products"]');
      if (link === null) {
        throw new Error("a row has no link on its name");
      }
      const { left, right } = link.getBoundingClientRect();
      return {
        cardLeft: cardBox.left,
        cardRight: cardBox.right,
        left,
        name: link.textContent ?? "",
        right,
      };
    });
  });
}

for (const [width, fontPixels] of [
  [320, 20],
  [360, 16],
] as const) {
  reflowTest(
    `a ${width} px com letra de ${fontPixels} px o nome do produto na linha fica dentro do cartão`,
    async ({ page }) => {
      await openStock(page, width, fontPixels);
      const links = await nameLinks(page);
      expect(links).toHaveLength(ENTRIES.length);
      for (const link of links) {
        expect(
          link.left,
          `${link.name} dentro do cartão`
        ).toBeGreaterThanOrEqual(link.cardLeft - 0.5);
        expect(link.right).toBeLessThanOrEqual(link.cardRight + 0.5);
        expect(link.right).toBeLessThanOrEqual(width);
      }
    }
  );
}

reflowTest(
  "a 320 px com letra de 20 px os três botões de cada linha empilham, inteiros, dentro do cartão e com 44 px",
  async ({ page }) => {
    await openStock(page, 320, 20);
    const rows = await geometry(page);
    expect(rows).toHaveLength(ENTRIES.length);
    for (const row of rows) {
      expect(row.buttons.map((button) => button.label)).toHaveLength(3);
      const lefts = new Set(
        row.buttons.map((button) => Math.round(button.left))
      );
      expect(lefts.size, `${row.groupName}: os botões alinham à esquerda`).toBe(
        1
      );
      let previousBottom = Number.NEGATIVE_INFINITY;
      for (const button of row.buttons) {
        const name = `${row.groupName}: ${button.label}`;
        expect(button.scrollWidth, `${name} inteiro`).toBeLessThanOrEqual(
          button.clientWidth + 1
        );
        expect(
          button.width,
          `${name} com 44 px de largura`
        ).toBeGreaterThanOrEqual(TOUCH);
        expect(
          button.height,
          `${name} com 44 px de altura`
        ).toBeGreaterThanOrEqual(TOUCH);
        expect(button.right, `${name} dentro do cartão`).toBeLessThanOrEqual(
          row.card.right + 0.5
        );
        expect(button.left).toBeGreaterThanOrEqual(row.card.left - 0.5);
        expect(button.top, `${name} abaixo do anterior`).toBeGreaterThanOrEqual(
          previousBottom - 0.5
        );
        expect(button.right).toBeLessThanOrEqual(320);
        previousBottom = button.bottom;
      }
      expect(row.group.right).toBeLessThanOrEqual(row.card.right + 0.5);
    }
    expect(await untouchable(page), "botões que não recebem o toque").toEqual(
      []
    );
    expect(
      rows.map((row) => row.buttons.map((button) => button.label))
    ).toEqual([
      ["Receber", "Contar", "Baixar"],
      ["Receber", "Informar custo", "Baixar"],
      ["Receber", "Contar", "Baixar"],
      ["Dar entrada", "Contar", "Baixar"],
      ["Receber", "Contar", "Baixar"],
    ]);
    const list = page.getByRole("list", { name: "Saldos em estoque" });
    await assertNothingClipped(list);
    await assertNoEllipsis(list.locator(`${ACTIONS}, dd`));
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "a 320 px com letra de 20 px o Custo médio e o Saldo leem inteiros, e Custo desconhecido quebra em vez de cortar",
  async ({ page }) => {
    await openStock(page, 320, 20);
    const unknown = page.getByText("Custo desconhecido", { exact: true });
    await expect(unknown).toHaveCount(2);
    const fits = await unknown.evaluateAll((elements) =>
      elements.map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.top))
        );
        const figure = element.closest("dd");
        const row = element.closest("li");
        const rowStyle = row ? getComputedStyle(row) : null;
        return {
          contentRight:
            (row?.getBoundingClientRect().right ?? 0) -
            Number.parseFloat(rowStyle?.paddingRight ?? "0"),
          figureClient: figure?.clientWidth ?? 0,
          figureScroll: figure?.scrollWidth ?? 0,
          lines: lines.size,
          right: range.getBoundingClientRect().right,
        };
      })
    );
    for (const fit of fits) {
      expect(fit.figureScroll).toBeLessThanOrEqual(fit.figureClient + 1);
      expect(fit.right).toBeLessThanOrEqual(fit.contentRight + 0.5);
      // a word broken in the middle would make a third line
      expect(fit.lines).toBeLessThanOrEqual(2);
    }
    const columns = await page
      .locator("li dl")
      .evaluateAll((lists) =>
        lists.map(
          (figures) =>
            getComputedStyle(figures).gridTemplateColumns.split(" ").length
        )
      );
    expect(columns, "Saldo e Custo médio numa coluna só").toEqual(
      ENTRIES.map(() => 1)
    );
    const list = page.getByRole("list", { name: "Saldos em estoque" });
    await assertNoEllipsis(list.locator("dl, dt, dd"));
    await assertNothingClipped(list);
  }
);

reflowTest(
  "a 320 px com letra de 20 px, com o painel aberto, os botões ficam desligados e empilhados e nada passa da janela",
  async ({ page }) => {
    await openStock(page, 320, 20);
    await page
      .getByRole("button", { name: "Baixar estoque de Calça jeans, 42" })
      .click();
    await expect(page.getByLabel("Quantidade a baixar")).toBeVisible();
    await expect(page.locator(`${ACTIONS}[aria-disabled="true"]`)).toHaveCount(
      ENTRIES.length * 3
    );
    const rows = await geometry(page);
    for (const row of rows) {
      const lefts = new Set(
        row.buttons.map((button) => Math.round(button.left))
      );
      expect(lefts.size, `${row.groupName}: empilhados`).toBe(1);
    }
    await assertNoPageScroll(page);
    await assertNothingClipped(
      page.getByRole("list", { name: "Saldos em estoque" })
    );
  }
);

reflowTest(
  "o grupo continua um controle só, com o mesmo nome acessível, e os botões mantêm o nome de cada um",
  async ({ page }) => {
    await openStock(page, 320, 20);
    const group = page.getByRole("group", {
      name: "Movimentos de Calça jeans, 42",
    });
    await expect(group.getByRole("button")).toHaveCount(3);
    await expect(
      group.getByRole("button", { name: "Baixar estoque de Calça jeans, 42" })
    ).toBeVisible();
  }
);

const WIDE_WINDOW = 1280;

for (const width of [360, WIDE_WINDOW]) {
  reflowTest(
    `a ${width} px com letra de 16 px os três botões ficam lado a lado, como sempre`,
    async ({ page }) => {
      await openStock(page, width, 16);
      for (const row of await geometry(page)) {
        const [first, second, third] = row.buttons;
        for (const button of row.buttons) {
          expect(
            Math.abs(button.top - (first?.top ?? 0)),
            `${row.groupName}: ${button.label} na mesma linha`
          ).toBeLessThanOrEqual(1);
          expect(button.right).toBeLessThanOrEqual(row.card.right + 0.5);
        }
        expect(second?.left).toBeGreaterThanOrEqual((first?.right ?? 0) - 1);
        expect(third?.left).toBeGreaterThanOrEqual((second?.right ?? 0) - 1);
        expect(row.group.height).toBeLessThan(TOUCH);
      }
      const columns = await page
        .locator("li dl")
        .evaluateAll((lists) =>
          lists.map(
            (figures) =>
              getComputedStyle(figures).gridTemplateColumns.split(" ").length
          )
        );
      expect(columns, "Saldo e Custo médio lado a lado").toEqual(
        ENTRIES.map(() => 2)
      );
    },
    { coarse: width !== WIDE_WINDOW }
  );
}

/** The x where "Saldo" and "Custo médio" start in each row, read from the labels of the rows as the screen shows them. */
function figureColumns(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("li")]
      .filter((row) => row.querySelector("[data-stock-action]") !== null)
      .map((row) => {
        const left = (label: string) =>
          [...row.querySelectorAll("dt")]
            .find((term) => term.textContent === label)
            ?.getBoundingClientRect().left ?? Number.NaN;
        const buttons = [...row.querySelectorAll("[data-stock-action]")];
        return {
          balance: left("Saldo"),
          cost: left("Custo médio"),
          last: buttons.at(-1)?.getBoundingClientRect().right ?? Number.NaN,
        };
      })
  );
}

for (const width of [WIDE_WINDOW, 1024]) {
  reflowTest(
    `a ${width} px Saldo e Custo médio começam no mesmo x em todas as linhas, qualquer que seja o grupo de botões`,
    async ({ page }) => {
      await openStock(page, width, 16);
      const labels = await page
        .locator(ACTIONS)
        .evaluateAll((buttons) =>
          buttons.map((button) => button.textContent?.trim())
        );
      expect(labels).toContain("Informar custo");
      expect(labels).toContain("Dar entrada");
      expect(labels).toContain("Contar");
      const widest = await page
        .locator('[data-slot="button-group"]')
        .evaluateAll((groups) =>
          Math.max(
            ...groups.map((group) => group.getBoundingClientRect().width)
          )
        );
      const rem = await page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      );
      expect(
        widest,
        "o grupo mais largo cabe na coluna de 18,5 rem"
      ).toBeLessThanOrEqual(18.5 * rem);
      const rows = await figureColumns(page);
      expect(rows).toHaveLength(ENTRIES.length);
      for (const row of rows) {
        expect(Math.abs(row.balance - (rows[0]?.balance ?? 0))).toBeLessThan(1);
        expect(Math.abs(row.cost - (rows[0]?.cost ?? 0))).toBeLessThan(1);
        expect(Math.abs(row.last - (rows[0]?.last ?? 0))).toBeLessThan(1);
      }
      await assertNoPageScroll(page);
    },
    { coarse: false }
  );
}

/** Per row, as the screen shows it: where the figures block (`dl`) ends and where the button group starts. */
function rowPlacement(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("li")]
      .filter((row) => row.querySelector("[data-stock-action]") !== null)
      .map((row) => {
        const figures = row.querySelector("dl")?.getBoundingClientRect();
        const group = row
          .querySelector('[data-slot="button-group"]')
          ?.getBoundingClientRect();
        return {
          contentWidth: Number.parseFloat(getComputedStyle(row).width),
          figuresBottom: figures?.bottom ?? Number.NaN,
          figuresRight: figures?.right ?? Number.NaN,
          groupLeft: group?.left ?? Number.NaN,
          groupTop: group?.top ?? Number.NaN,
        };
      })
  );
}

/** The width, in rem, at which the row's container query changes from stacked to three columns, read from the rule the page loaded. */
function containerLineRem(page: Page) {
  return page.evaluate(() => {
    const lines = new Set<number>();
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (
          rule instanceof CSSContainerRule &&
          [...rule.cssRules].some(
            (inner) =>
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes("_18\\.5rem")
          )
        ) {
          const [, minimum = ""] = rule.conditionText.split(">=");
          if (minimum.includes("rem")) {
            lines.add(Number.parseFloat(minimum));
          }
        }
        if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      visit(sheet.cssRules);
    }
    return [...lines];
  });
}

for (const width of [WIDE_WINDOW, 1024]) {
  reflowTest(
    `a ${width} px cada linha tem três colunas: o grupo de botões fica à direita dos valores, sem descer`,
    async ({ page }) => {
      await openStock(page, width, 16);
      const rows = await rowPlacement(page);
      expect(rows).toHaveLength(ENTRIES.length);
      for (const row of rows) {
        expect(
          row.groupTop,
          "o topo do grupo fica acima do fim dos valores"
        ).toBeLessThan(row.figuresBottom);
        expect(
          row.groupLeft,
          "o grupo começa depois do fim dos valores"
        ).toBeGreaterThanOrEqual(row.figuresRight);
      }
    },
    { coarse: false }
  );
}

const LINE_OFFSET_PIXELS = 1;

const CONTAINER_LINE_REM = 42;

reflowTest(
  "a linha de contêiner das três colunas é de 42 rem, como o DESIGN.md diz",
  async ({ page }) => {
    await openStock(page, WIDE_WINDOW, 16);
    expect(
      await containerLineRem(page),
      `a regra das três colunas (o md:@2xl: da linha, em inventory-page.tsx) não está em ${CONTAINER_LINE_REM} rem (ou o seletor _18.5rem deixou de achá-la); se a linha mudou de propósito, mude o DESIGN.md (Estoque), o nome dos testes de fronteira e CONTAINER_LINE_REM juntos`
    ).toEqual([CONTAINER_LINE_REM]);
  },
  { coarse: false }
);

for (const [side, sign] of [
  ["acima", 1],
  ["abaixo", -1],
] as const) {
  reflowTest(
    `a linha de contêiner de 42 rem é medida pela largura da linha: logo ${side} dela as colunas ${sign > 0 ? "ficam lado a lado" : "empilham"}, com a janela de 1280 px`,
    async ({ page }) => {
      await openStock(page, WIDE_WINDOW, 16);
      const [lineRem, ...others] = await containerLineRem(page);
      expect(others, "uma só linha de contêiner na regra das colunas").toEqual(
        []
      );
      expect(lineRem, "a regra das três colunas foi lida do CSS").toBeDefined();
      const line = (lineRem ?? 0) * 16;
      await page.addStyleTag({
        content: `[data-list-block] ul[aria-labelledby] > li { box-sizing: content-box; max-width: none; width: calc(${lineRem}rem + ${sign * LINE_OFFSET_PIXELS}px); }`,
      });
      const rows = await rowPlacement(page);
      expect(rows).toHaveLength(ENTRIES.length);
      for (const row of rows) {
        expect(
          sign * (row.contentWidth - line),
          "a largura do contêiner da linha"
        ).toBeGreaterThan(0);
        if (sign > 0) {
          expect(row.groupTop).toBeLessThan(row.figuresBottom);
          expect(row.groupLeft).toBeGreaterThanOrEqual(row.figuresRight);
        } else {
          expect(row.groupTop).toBeGreaterThanOrEqual(row.figuresBottom);
        }
      }
    },
    { coarse: false }
  );
}

reflowTest(
  "numa linha de menos de 42 rem (a lateral aberta) o grupo desce para baixo dos valores, sem rolagem lateral",
  async ({ page }) => {
    await openStock(page, 900, 16);
    await page.addStyleTag({
      content: "body { box-sizing: border-box; padding-left: 16rem; }",
    });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("li")]
        .filter((row) => row.querySelector("[data-stock-action]") !== null)
        .map((row) => ({
          figuresBottom: row.querySelector("dl")?.getBoundingClientRect()
            .bottom,
          groupTop: row
            .querySelector('[data-slot="button-group"]')
            ?.getBoundingClientRect().top,
          rowWidth: row.getBoundingClientRect().width,
        }))
    );
    expect(rows).toHaveLength(ENTRIES.length);
    const [lineRem] = await containerLineRem(page);
    for (const row of rows) {
      expect(row.rowWidth).toBeLessThan((lineRem ?? 0) * 16);
      expect(row.groupTop).toBeGreaterThanOrEqual(row.figuresBottom ?? 0);
    }
    await assertNoPageScroll(page);
  },
  { coarse: false }
);

const BAR = "Filtrar estoque";

/** Turns a yes-or-no filter on from its own item in the "Filtrar" menu: two touches, no second panel; the menu closes and the focus goes back to "Filtrar". */
async function toggleFilter(page: Page, name: string) {
  const open = page
    .getByRole("search", { exact: true, name: BAR })
    .getByRole("button", { exact: true, name: "Filtrar" });
  await open.click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitemcheckbox", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByRole("menu", { name: "Filtrar por" })).toHaveCount(0);
  await expect(open).toBeFocused();
}

/** Chooses a field in the "Filtrar" menu and the option in its editor (the Popover applies at once, the phone's Dialog at "Aplicar"). */
async function addFilter(page: Page, field: string, option: string) {
  const bar = page.getByRole("search", { exact: true, name: BAR });
  await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: new RegExp(`^${field}`) })
    .click();
  const editor = page.getByRole("dialog", { name: field });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { exact: true, name: option }).click();
  const apply = editor.getByRole("button", { exact: true, name: "Aplicar" });
  if ((await apply.count()) > 0) {
    await apply.click();
  }
  await expect(editor).toHaveCount(0);
}

reflowTest(
  "a 320 px com letra de 20 px a barra Filtrar estoque, com as três pílulas e o menu aberto, cabe inteira e nada é cortado",
  async ({ page }) => {
    await openStock(page, 320, 20);
    const bar = page.getByRole("search", { exact: true, name: BAR });
    await addFilter(page, "Saldo", "Sem saldo");
    await toggleFilter(page, "Custo desconhecido");
    await toggleFilter(page, "Incluir arquivados");
    await expect(bar.locator('[data-slot="filter-pill"]')).toHaveCount(3);
    await expect(
      bar.getByRole("button", { name: "Limpar tudo" })
    ).toBeVisible();
    await assertNothingClipped(bar);
    await assertNoEllipsis(bar.locator('[data-slot="filter-pill"] button'));
    await assertNoPageScroll(page);
    const overflowing = await bar.evaluate(
      (root) =>
        [...root.querySelectorAll("button")].filter(
          (button) => button.getBoundingClientRect().right > 320.5
        ).length
    );
    expect(overflowing, "botões da barra além da janela").toBe(0);
    await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
    const menu = await page
      .getByRole("menu", { name: "Filtrar por" })
      .boundingBox();
    expect(
      (menu?.x ?? 0) + (menu?.width ?? Number.POSITIVE_INFINITY)
    ).toBeLessThanOrEqual(320);
    expect(menu?.x ?? -1).toBeGreaterThanOrEqual(0);
  }
);
