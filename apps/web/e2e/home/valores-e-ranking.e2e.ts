/// <reference lib="dom" />

import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  findClipped,
  openReflowViewport,
  reflowTest,
} from "../reflow";
import {
  addDays,
  alone,
  choosePeriod,
  DELETED,
  FakeServer,
  NOON,
  openHome,
  PRODUCT,
  periodButton,
  periodCalls,
  region,
  type Scenario,
  SOBRE,
  SOLD,
  settled,
  TYPE_DATES,
  tileAreas,
} from "./shared";

/** Names of 30, 45 and 60 characters. */
const LONG_NAMES = [
  "Camiseta de algodão manga lisa",
  "Calça jeans masculina slim fit azul escuro 44",
  "Tênis esportivo de corrida leve com amortecedor duplo, preto",
];

function rankingOf(names: readonly string[], scale = 1) {
  const ids = [
    PRODUCT,
    DELETED,
    "0199c2d0-0000-7000-8000-0000000000b3",
    "0199c2d0-0000-7000-8000-0000000000b4",
    "0199c2d0-0000-7000-8000-0000000000b5",
  ];
  return names.map((name, index) => ({
    deleted: index === 1,
    name,
    netSales: `${Math.max(900 - index * 300, 100) * scale}.00`,
    productId: ids[index] ?? PRODUCT,
    quantity: Math.max(12 - index * 4, 1) * scale,
  }));
}

const NOVEMBER = Date.parse("2026-11-05T15:00:00.000Z");

const SOLD_IN_NOVEMBER: Scenario = {
  ...SOLD,
  days: { ...SOLD.days, "2026-11-03": [30_000, 2] },
};

interface RankingRow {
  bottom: number;
  clipped: boolean;
  figuresTop: number;
  fitsOnOneLine: boolean;
  height: number;
  nameBottom: number;
  nameLines: number;
  nameText: string;
  top: number;
  visibleCharacters: number;
}

/** Each line of the ranking as laid out, and how many characters of the name are drawn inside its box. */
async function rankingRows(page: Page): Promise<RankingRow[]> {
  await settled(page);
  return region(page, "Mais vendidos do mês")
    .locator("ol > li")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const name = row.querySelector("[data-top-name]") as HTMLElement;
        const figures = row.querySelector("[data-top-figures]") as HTMLElement;
        const box = row.getBoundingClientRect();
        const origin = (
          row.parentElement as HTMLElement
        ).getBoundingClientRect().top;
        const nameBox = name.getBoundingClientRect();
        const nameStyle = getComputedStyle(name);
        const parsedLine = Number.parseFloat(nameStyle.lineHeight);
        const lineHeight = Number.isNaN(parsedLine)
          ? Number.parseFloat(nameStyle.fontSize) * 1.2
          : parsedLine;
        const probe = name.cloneNode(true) as HTMLElement;
        probe.style.cssText =
          "position:absolute;visibility:hidden;width:max-content;white-space:nowrap;display:block;overflow:visible;-webkit-line-clamp:none";
        name.parentElement?.appendChild(probe);
        const naturalWidth = probe.getBoundingClientRect().width;
        probe.remove();
        const text = name.firstChild as Text;
        let visible = 0;
        for (let at = 0; at < text.length; at += 1) {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          const rect = range.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.bottom <= nameBox.bottom + 1 &&
            rect.right <= nameBox.right + 1
          ) {
            visible += 1;
          }
        }
        const value = figures.firstElementChild as HTMLElement;
        return {
          bottom: box.bottom - origin,
          clipped:
            name.scrollWidth > name.clientWidth + 1 ||
            name.scrollHeight > name.clientHeight + 1,
          figuresTop: value.getBoundingClientRect().top - origin,
          fitsOnOneLine: naturalWidth <= nameBox.width + 1,
          height: box.height,
          nameBottom: nameBox.bottom - origin,
          nameLines: Math.round(nameBox.height / lineHeight),
          nameText: name.textContent ?? "",
          top: box.top - origin,
          visibleCharacters: visible,
        };
      })
    );
}

const BIG_SALE = 9_964_035;
const NINE_DIGITS = 123_456_789;

/** Below 760 px, or with a finger, the scale of money comes down a step (theme.css, "Touch … or a narrow screen"). */
const PHONE_WIDTH = 760;

interface KnownFinding {
  clientWidth: number;
  reason: string;
  scrollWidth: number;
  selector: string;
}

/** What is cut at 320 px with the font at 24 px and not at 20 px: a report to read, never a promise (20 px is the guaranteed floor). */
const KNOWN_FINDINGS_24: readonly KnownFinding[] = [
  {
    clientWidth: 145,
    reason: "valor em mono: 165 px em 145 px",
    scrollWidth: 165,
    selector: 'div[data-slot="card"] > div',
  },
];

const KPI_IDS = ["home-today", "home-month", "home-result", "home-ticket"];

interface HeroRead {
  card: string | null;
  currency: number;
  currencyWeight: string;
  size: number;
  weight: string;
}

/** The size and the weight each number of the four cards is drawn with. */
const readHeroes = (page: Page): Promise<HeroRead[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-kpi-value]")].map((value) => {
      const style = getComputedStyle(value);
      const currency = value.querySelector("[data-money-currency]");
      const currencyStyle = currency ? getComputedStyle(currency) : null;
      return {
        card:
          value.closest("[data-kpi]")?.getAttribute("aria-labelledby") ?? null,
        currency: Number.parseFloat(currencyStyle?.fontSize ?? "NaN"),
        currencyWeight: currencyStyle?.fontWeight ?? "",
        size: Number.parseFloat(style.fontSize),
        weight: style.fontWeight,
      };
    })
  );

const heightOf = async (target: Locator) =>
  (await target.boundingBox())?.height ?? Number.NaN;

test.describe("o padrão único dos valores nos cartões do Início (AC-3.1, AC-3.2, AC-3.6, AC-3.7)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` is a Chrome DevTools command"
  );

  const SMALL: Scenario = {
    ...SOLD,
    days: Object.fromEntries(
      Object.entries(SOLD.days).map(([day, [cents, count]]) => [
        day,
        [Math.round(cents / 10), count],
      ])
    ),
  };

  for (const [width, scenario, today] of [
    [360, SOLD, "R$ 320,10"],
    [760, SMALL, "R$ 32,01"],
    [1024, SMALL, "R$ 32,01"],
    [1280, SMALL, "R$ 32,01"],
  ] as const) {
    test(`os quatro cartões medem text-value-lg, o R$ igual nos quatro, em peso 600, a ${width} px`, async ({
      page,
    }) => {
      await openReflowViewport(page, { fontPixels: 16, height: 800, width });
      await openHome(page, new FakeServer(scenario));
      await expect(region(page, "Vendas hoje")).toContainText(today);
      const reads = await readHeroes(page);
      expect(
        reads.map((read) => read.card),
        "quatro cartões, nesta ordem"
      ).toEqual(KPI_IDS);
      const coarse = await page.evaluate(
        () => matchMedia("(pointer: coarse)").matches
      );
      const touch = width < PHONE_WIDTH || coarse;
      const lg = touch ? 24 : 26;
      expect(
        reads.map((read) => read.size),
        "o valor dos quatro: text-value-lg, todos iguais"
      ).toEqual([lg, lg, lg, lg]);
      expect(
        new Set(reads.map((read) => read.currency)).size,
        "o R$ tem um tamanho só nos quatro"
      ).toBe(1);
      expect(reads[0]?.currency).toBeLessThan(lg);
      expect(new Set(reads.map((read) => read.currencyWeight)).size).toBe(1);
      expect(reads.map((read) => read.weight)).toEqual([
        "600",
        "600",
        "600",
        "600",
      ]);
    });
  }

  test("a 1280 px a área do número de um cartão é estreita: um valor de quatro dígitos de milhar desce até caber, na conta do ajuste, e não corta, e Vendas hoje mantém o lg", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "chromium-mobile-emulated",
      "with a finger text-value-lg is 24 px and the amount may still fit the area: the step-down is the mouse case"
    );
    await openReflowViewport(page, {
      fontPixels: 16,
      height: 800,
      width: 1280,
    });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const reads = await page.locator("[data-kpi-value]").evaluateAll((nodes) =>
      nodes.map((node) => {
        const area = node.closest("[data-kpi-headline]");
        const size = Number.parseFloat(getComputedStyle(node).fontSize);
        const width =
          node.firstElementChild?.getBoundingClientRect().width ?? 0;
        return {
          area: area?.getBoundingClientRect().width ?? 0,
          atLarge: (width / size) * 26,
          size,
          text: node.textContent?.trim() ?? "",
        };
      })
    );
    const [today, month] = reads;
    expect(today?.size, `${today?.text} cabe e mantém o lg`).toBe(26);
    expect(month?.text).toBe("R$ 2.660,60");
    expect(
      month?.atLarge,
      "o valor do mês não cabe na área em 26 px"
    ).toBeGreaterThan(month?.area ?? 0);
    expect(month?.size).toBeLessThan(26);
    expect(month?.size).toBeGreaterThanOrEqual(0.875 * 16);
  });

  for (const [width, fontPixels] of [
    [360, 16],
    [375, 16],
    [320, 20],
    [320, 24],
  ] as const) {
    const amounts = [BIG_SALE, -BIG_SALE];
    if (width === 320 && fontPixels === 20) {
      amounts.push(NINE_DIGITS);
    }
    for (const cents of amounts) {
      const text =
        cents === NINE_DIGITS
          ? "R$ 1.234.567,89"
          : `${cents < 0 ? "-" : ""}R$ 99.640,35`;
      test(`${text} em Vendas hoje não corta nem quebra a ${width} px com a letra em ${fontPixels} px`, async ({
        page,
      }, testInfo) => {
        await openReflowViewport(page, { fontPixels, width });
        await openHome(page, new FakeServer(alone(cents)));
        await expectReflowFont(page, fontPixels);
        const principal = region(page, "Vendas hoje");
        await expect(principal.locator("[data-kpi-value]")).toHaveText(text, {
          timeout: 20_000,
        });
        await assertNothingClipped(principal);
        const [today, ...rest] = await readHeroes(page);
        const lg = 1.5 * fontPixels;
        const floor = 0.875 * fontPixels;
        for (const read of [today, ...rest]) {
          expect(
            read?.size,
            "o valor desce só até caber na área dele, nunca abaixo do piso"
          ).toBeLessThanOrEqual(lg + 0.01);
          expect(read?.size).toBeGreaterThanOrEqual(floor - 0.01);
        }
        const [figure, spark] = await principal.evaluate((card) => {
          const right = (selector: string) =>
            card.querySelector(selector)?.getBoundingClientRect();
          const number = right("[data-money-number]");
          const drawing = right("[data-kpi-spark]");
          const box = card.getBoundingClientRect();
          return [
            number ? number.right : Number.NaN,
            drawing ? drawing.left : box.right,
          ];
        });
        expect(
          figure,
          "o número termina antes de a sparkline começar"
        ).toBeLessThanOrEqual((spark ?? 0) + 0.5);
        testInfo.annotations.push({
          description: `Vendas hoje ${today?.size} px, KPIs ${rest[0]?.size} px`,
          type: "medida",
        });
        const sameLine = await principal.evaluate((card) => {
          const currency = card
            .querySelector("[data-money-currency]")
            ?.getBoundingClientRect();
          const number = card
            .querySelector("[data-money-number]")
            ?.getBoundingClientRect();
          return Boolean(
            currency &&
              number &&
              number.top < currency.bottom &&
              currency.top < number.bottom
          );
        });
        expect(sameLine, "o R$ e o número na mesma linha").toBe(true);
        await assertNoPageScroll(page);
      });
    }
  }

  test("R$ 1.234.567,89 em Vendas hoje a 320 px com a letra em 24 px: o corte medido é o da lista, nem mais nem menos", async ({
    page,
  }) => {
    await openReflowViewport(page, { fontPixels: 24, width: 320 });
    await openHome(page, new FakeServer(alone(NINE_DIGITS)));
    await expectReflowFont(page, 24);
    const principal = region(page, "Vendas hoje");
    await expect(principal.locator("[data-kpi-value]")).toHaveText(
      "R$ 1.234.567,89",
      { timeout: 20_000 }
    );
    const { measured, offenders } = await findClipped(principal);
    expect(measured, "no element with text was measured").toBeGreaterThan(0);
    expect(
      offenders.map(({ clientWidth, scrollWidth, selector }) => ({
        clientWidth,
        scrollWidth,
        selector,
      })),
      `cut at 320 px with 24 px: a new cut fails, and a known one that no longer shows up has to leave KNOWN_FINDINGS_24 (${KNOWN_FINDINGS_24.map(({ reason }) => reason).join("; ")})`
    ).toEqual(
      KNOWN_FINDINGS_24.map(({ clientWidth, scrollWidth, selector }) => ({
        clientWidth,
        scrollWidth,
        selector,
      }))
    );
    await assertNoPageScroll(page);
  });

  for (const fontPixels of [20, 24]) {
    test(`o cartão de Vendas hoje tem a mesma altura com um valor curto, um longo, um negativo e com os valores escondidos, na largura mínima com a letra em ${fontPixels} px`, async ({
      page,
    }) => {
      await openReflowViewport(page, { fontPixels, width: 320 });
      const server = new FakeServer(alone(100));
      await openHome(page, server);
      const principal = region(page, "Vendas hoje");
      await expect(principal.locator("[data-kpi-value]")).toHaveText(
        "R$ 1,00",
        {
          timeout: 20_000,
        }
      );
      const short = await heightOf(principal);
      const hiddenKeepsTheBox = async (cents: number, text: string) => {
        server.scenario = alone(cents);
        await page.reload();
        await expect(principal.locator("[data-kpi-value]")).toHaveText(text, {
          timeout: 20_000,
        });
        expect(
          Math.abs((await heightOf(principal)) - short)
        ).toBeLessThanOrEqual(1);
        const before = await tileAreas(page);
        await page.getByRole("button", { name: "Esconder valores" }).click();
        await expect(principal.locator("[data-masked-money]")).toBeVisible();
        expect(
          Math.abs((await heightOf(principal)) - short)
        ).toBeLessThanOrEqual(1);
        expect(await tileAreas(page)).toEqual(before);
        await page.getByRole("button", { name: "Esconder valores" }).click();
      };
      await hiddenKeepsTheBox(BIG_SALE, "R$ 99.640,35");
      await hiddenKeepsTheBox(-BIG_SALE, "-R$ 99.640,35");
    });
  }
});

async function openRanking(
  page: Page,
  server: FakeServer,
  { at = NOON, fontPixels = 20, width = 320 } = {}
) {
  await openReflowViewport(page, { fontPixels, width });
  await openHome(page, server, at);
  await expect(region(page, "Mais vendidos do mês")).toContainText("un.");
  await expectReflowFont(page, fontPixels);
}

test.describe("Mais vendidos do mês a 320 px com a letra do navegador em 20 px", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` is a Chrome DevTools command"
  );

  reflowTest(
    "o nome tem a sua linha, o valor e as unidades ficam inteiros na de baixo e nada rola de lado",
    async ({ page }) => {
      const server = new FakeServer(SOLD);
      server.top = rankingOf(LONG_NAMES);
      await openRanking(page, server);
      const rows = await rankingRows(page);
      expect(LONG_NAMES.map((name) => name.length)).toEqual([30, 45, 60]);
      expect(rows).toHaveLength(3);
      for (const [index, row] of rows.entries()) {
        expect(row.nameText).toBe(LONG_NAMES[index]);
        expect(
          row.visibleCharacters,
          `caracteres do nome ${index + 1} dentro da caixa`
        ).toBeGreaterThanOrEqual(20);
        expect(
          row.figuresTop,
          `valor ${index + 1} abaixo do nome`
        ).toBeGreaterThanOrEqual(row.nameBottom - 1);
        expect(
          row.fitsOnOneLine,
          `o nome ${index + 1} não cabe em 1 linha a 320 px com letra de 20 px`
        ).toBe(false);
        expect(
          row.nameLines,
          `o nome ${index + 1} quebra em 2 linhas, sem cortar em 1`
        ).toBe(2);
      }
      const block = region(page, "Mais vendidos do mês");
      await assertNothingClipped(block);
      await assertNoEllipsis(block.locator("[data-top-figures]"));
      await assertNoPageScroll(page);
      await expect(block.locator("[data-top-figures]")).toHaveText([
        "R$ 900,0012 un.",
        "R$ 600,008 un.",
        "R$ 300,004 un.",
      ]);
      await expect(block.getByRole("link")).toHaveCount(2);
      await expect(block.getByRole("link").first()).toHaveAttribute(
        "href",
        `/products?produto=${PRODUCT}`
      );
    }
  );

  test("a altura de cada linha não depende do estado: Esconder valores, o 3º produto ausente e outro mês", async ({
    browser,
    page,
  }) => {
    const server = new FakeServer(SOLD_IN_NOVEMBER);
    server.top = rankingOf(LONG_NAMES);
    await openRanking(page, server);
    const full = await rankingRows(page);

    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(region(page, "Mais vendidos do mês")).toContainText("R$ ••••");
    expectSameRows(await rankingRows(page), full, "Esconder valores");

    const fewer = new FakeServer(SOLD_IN_NOVEMBER);
    fewer.top = rankingOf(LONG_NAMES.slice(0, 2));
    await inFreshPage(browser, async (other) => {
      await openRanking(other, fewer);
      expectSameRows(
        await rankingRows(other),
        full.slice(0, 2),
        "sem o 3º produto"
      );
    });

    const later = new FakeServer(SOLD_IN_NOVEMBER);
    later.top = rankingOf(LONG_NAMES, 2);
    await inFreshPage(browser, async (other) => {
      await openRanking(other, later, { at: NOVEMBER });
      await expect(region(other, "Mais vendidos do mês")).toContainText(
        "R$ 1.800,00"
      );
      expectSameRows(
        await rankingRows(other),
        full,
        "outro mês, com outros valores"
      );
    });
  });
});

async function inFreshPage(
  browser: Browser,
  use: (page: Page) => Promise<void>
) {
  const context = await browser.newContext();
  try {
    await use(await context.newPage());
  } finally {
    await context.close();
  }
}

function expectSameRows(
  after: readonly RankingRow[],
  before: readonly RankingRow[],
  when: string
) {
  expect(after.length, when).toBe(before.length);
  for (const [index, row] of after.entries()) {
    const rest = before[index];
    for (const key of ["height", "top"] as const) {
      expect(
        Math.abs(row[key] - (rest?.[key] ?? Number.NaN)),
        `${when}: ${key} da linha ${index + 1}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

const WIDE_WINDOW = 1440;

reflowTest(
  "Mais vendidos do mês: com vendas e nenhum produto restante depois das devoluções, a caixa diz que foram devolvidas",
  async ({ page }) => {
    const server = new FakeServer(SOLD);
    server.top = [];
    await openHome(page, server);
    const block = region(page, "Mais vendidos do mês");
    await expect(block).toContainText("As vendas do período foram devolvidas.");
    await expect(block).not.toContainText("Sem vendas no período.");
    await expect(block.locator("ol")).toHaveCount(0);
  }
);

test.describe("Mais vendidos do mês: cinco linhas com a miniatura de 32 px", () => {
  for (const [width, height] of [[360, 740]] as const) {
    reflowTest(
      `a ${width} px as cinco linhas têm a caixa de 32 px com as iniciais, na ordem, sem rolar de lado`,
      async ({ page }) => {
        await page.setViewportSize({ height, width });
        const server = new FakeServer(SOLD);
        server.top = rankingOf([
          "Camiseta lisa",
          "Boné antigo",
          "Calça jeans",
          "Tênis de corrida",
          "Meia esportiva",
        ]);
        await openHome(page, server);
        const block = region(page, "Mais vendidos do mês");
        await expect(block).toContainText("un.");
        const boxes = block.locator("[data-thumbnail]");
        await expect(boxes).toHaveCount(5);
        expect(
          await boxes.evaluateAll((nodes) =>
            nodes.map((node) => {
              const box = node.getBoundingClientRect();
              return [Math.round(box.width), Math.round(box.height)];
            })
          )
        ).toEqual(new Array(5).fill([32, 32]));
        await expect(boxes).toHaveText(["CA", "BO", "CA", "TÊ", "ME"]);
        expect(
          periodCalls(server).some((call) => call.input.topProducts === 5)
        ).toBe(true);
        await assertNoPageScroll(page);
      }
    );
  }
});

test.describe("Mais vendidos do mês com a letra de 16 px: a linha de cada largura", () => {
  for (const [label, width, height, oneLine] of [
    ["360", 360, 740, false],
    ["1280", 1280, 800, true],
    ["1440", 1440, 900, true],
  ] as const) {
    reflowTest(
      oneLine
        ? `a ${label} px, nome, valor e unidades ficam numa linha só${width >= WIDE_WINDOW ? ", com a lateral recolhida" : ""}`
        : `a ${label} px o nome tem a sua linha, o valor e as unidades a de baixo, e a miniatura de 32 px fica ao lado das duas`,
      async ({ page }) => {
        await page.setViewportSize({ height, width });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(LONG_NAMES);
        await openHome(page, server);
        if (width >= WIDE_WINDOW) {
          await foldSideMenu(page);
        }
        await expect(region(page, "Mais vendidos do mês")).toContainText("un.");
        const rows = await rankingRows(page);
        for (const [index, row] of rows.entries()) {
          if (oneLine) {
            expect(
              row.nameBottom,
              `valor na linha do nome ${index + 1}`
            ).toBeGreaterThan(row.figuresTop);
          } else {
            expect(
              row.figuresTop,
              `valor ${index + 1} sob o nome`
            ).toBeGreaterThanOrEqual(row.nameBottom - 1);
          }
        }
        const line = region(page, "Mais vendidos do mês").locator(
          "[data-top-line]"
        );
        expect(
          await line.evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node).display)
          )
        ).toEqual(new Array(3).fill(oneLine ? "flex" : "grid"));
        if (oneLine) {
          const cut = await region(page, "Mais vendidos do mês")
            .locator("[data-top-name]")
            .last()
            .evaluate((name) => {
              const style = getComputedStyle(name);
              return {
                cut: name.scrollWidth > name.clientWidth,
                ellipsis: style.textOverflow,
                overflow: style.overflowX,
                wrap: style.whiteSpace,
              };
            });
          expect(cut).toEqual({
            cut: width < WIDE_WINDOW,
            ellipsis: "ellipsis",
            overflow: "hidden",
            wrap: "nowrap",
          });
        }
        await assertNoPageScroll(page);
      },
      { coarse: width < WIDE_WINDOW }
    );
  }
});

async function foldSideMenu(page: Page) {
  await page
    .getByRole("button", { exact: true, name: "Recolher menu" })
    .click();
  await expect(
    page.getByRole("button", { exact: true, name: "Expandir menu" })
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().length))
    .toBe(0);
}

/** Names that fit in one line at the 9 rem or so the row keeps for the name, with a value of up to four digits, when the column is 20.75 rem wide. */
const SHORT_NAMES = ["Camiseta lisa", "Calça jeans slim", "Tênis de corrida"];

/** The line is one row only when its box is 20.75 rem or wider (the miniature takes 2.75 rem of the name); under it the name has its own line. */
const ONE_LINE_REM = 20.75;

function columnRem(block: Locator) {
  return block
    .locator("ol > li")
    .first()
    .evaluate((row) => row.getBoundingClientRect().width / 16);
}

function expectNameReads(
  row: RankingRow,
  name: string,
  stacked: boolean,
  when: string
) {
  expect(row.nameText, when).toBe(name);
  expect(row.clipped, `${when}: cortado`).toBe(false);
  expect(
    row.visibleCharacters,
    `${when}: letras à vista`
  ).toBeGreaterThanOrEqual(name.length - 1);
  if (stacked) {
    expect(row.figuresTop, `${when}: valor sob o nome`).toBeGreaterThanOrEqual(
      row.nameBottom - 1
    );
  } else {
    expect(row.nameBottom, `${when}: valor na linha do nome`).toBeGreaterThan(
      row.figuresTop
    );
  }
}

test.describe("Mais vendidos do mês: a linha por largura da coluna (uma linha só a partir de 20,75 rem, empilhada abaixo)", () => {
  const ONE_LINE_NAMES = SHORT_NAMES;

  for (const side of ["aberta", "recolhida"] as const) {
    reflowTest(
      `de 1024 a 1300 px, lateral ${side}: o cartão tem a largura da área e cada linha é uma só, com o nome inteiro`,
      async ({ page }) => {
        await page.setViewportSize({ height: 800, width: 1150 });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(ONE_LINE_NAMES);
        await openHome(page, server);
        if (side === "recolhida") {
          await foldSideMenu(page);
        }
        for (const width of [1024, 1150, 1200, 1280, 1300]) {
          // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other on the same page
          await page.setViewportSize({ height: 800, width });
          const block = region(page, "Mais vendidos do mês");
          await expect(block).toContainText("un.");
          const rows = await rankingRows(page);
          const rem = await columnRem(block);
          expect(rem, `${side} ${width} px`).toBeGreaterThanOrEqual(
            ONE_LINE_REM
          );
          expect(rows, `${side} ${width} px`).toHaveLength(3);
          rows.forEach((row, index) => {
            expectNameReads(
              row,
              ONE_LINE_NAMES[index] ?? "",
              false,
              `${side} ${width} px (${rem} rem), nome ${index + 1}`
            );
          });
          await assertNoPageScroll(page);
        }
      },
      { coarse: false }
    );
  }

  // on a phone the card is the width of the screen less the page's and the card's own padding: 20,75 rem of line at 388 px
  const PHONE_EDGES = [
    { stacked: true, width: 387 },
    { stacked: false, width: 388 },
  ] as const;

  for (const edge of PHONE_EDGES) {
    reflowTest(
      `a ${edge.width} px o nome ${edge.stacked ? "empilha" : "fica numa linha só"}`,
      async ({ page }) => {
        await page.setViewportSize({ height: 800, width: edge.width });
        const server = new FakeServer(SOLD);
        server.top = rankingOf(SHORT_NAMES);
        await openHome(page, server);
        const block = region(page, "Mais vendidos do mês");
        await expect(block).toContainText("un.");
        const rows = await rankingRows(page);
        const rem = await columnRem(block);
        const when = `${edge.width} px (${rem} rem)`;
        if (edge.stacked) {
          expect(rem, `${when}: coluna abaixo de 20,75 rem`).toBeLessThan(
            ONE_LINE_REM
          );
        } else {
          expect(
            rem,
            `${when}: coluna a partir de 20,75 rem`
          ).toBeGreaterThanOrEqual(ONE_LINE_REM);
        }
        expect(rows, when).toHaveLength(3);
        rows.forEach((row, index) => {
          expectNameReads(
            row,
            SHORT_NAMES[index] ?? "",
            edge.stacked,
            `${when}, nome ${index + 1}`
          );
        });
        await assertNoPageScroll(page);
      },
      { coarse: false }
    );
  }

  reflowTest(
    "a 1024 px com a lateral aberta o nome fica numa linha, e a 360 px tem a sua linha",
    async ({ page }) => {
      const server = new FakeServer(SOLD);
      server.top = rankingOf(SHORT_NAMES);
      await page.setViewportSize({ height: 800, width: 1024 });
      await openHome(page, server);
      const open = await rankingRows(page);
      expect(open).toHaveLength(3);
      open.forEach((row, index) => {
        expectNameReads(
          row,
          SHORT_NAMES[index] ?? "",
          false,
          `1024 px, nome ${index + 1}`
        );
      });
      await page.setViewportSize({ height: 740, width: 360 });
      const phone = await rankingRows(page);
      expect(phone).toHaveLength(3);
      for (const row of phone) {
        expect(row.figuresTop).toBeGreaterThanOrEqual(row.nameBottom - 1);
      }
    },
    { coarse: false }
  );
});

test.describe("os dias sem custo de um mês de outro ano, no período digitado do Início", () => {
  const SALE = "2025-05-31";
  const SOLD_IN_MAY: Scenario = {
    ...SOLD,
    days: { ...SOLD.days, [SALE]: [5000, 1], "2025-06-10": [7000, 1] },
    results: { "2025-05-30": 0, [SALE]: null },
  };
  const typeAndApply = async (page: Page, from: string, to: string) => {
    await periodButton(page).click();
    await page.getByRole("button", { name: TYPE_DATES }).click();
    await page.getByRole("textbox", { exact: true, name: "Início" }).fill(from);
    await page.getByRole("textbox", { exact: true, name: "Fim" }).fill(to);
    await page.getByRole("button", { name: "Aplicar" }).click();
  };

  for (const size of [
    { fontPixels: 20, height: 740, width: 320 },
    { fontPixels: 16, height: 740, width: 360 },
  ]) {
    reflowTest(
      `a ${size.width} px com a letra em ${size.fontPixels} px: a contagem no teto está na linha (inteira a 360 px), e a acima do teto só está no (i)`,
      async ({ page }) => {
        await openReflowViewport(page, size);
        await openHome(page, new FakeServer(SOLD_IN_MAY));
        await expectReflowFont(page, size.fontPixels);

        await typeAndApply(page, "31/05/2025", "31/08/2025");
        const result = region(page, "Resultado estimado");
        const unknown = result.locator("[data-kpi-unknown]");
        await expect(unknown).toHaveText("maio de 2025: 1 de 1 dia sem custo");
        if (size.width === 320) {
          await expect(unknown, "não cabe: só no (i)").toBeHidden();
        } else {
          await expect(unknown).toBeVisible();
          expect(
            await unknown.evaluate((node) => {
              const row = node.closest("[data-kpi-warning-detail]");
              return row ? row.scrollWidth > row.clientWidth : null;
            }),
            "a contagem no teto não é cortada pelo reticências"
          ).toBe(false);
        }
        await result.getByRole("button", { name: SOBRE }).click();
        await expect(
          page.getByRole("dialog").or(page.getByRole("tooltip")).first()
        ).toContainText("Maio de 2025: 1 de 1 dia ainda sem custo informado.");
        await page.keyboard.press("Escape");
        await assertNoPageScroll(page);

        await typeAndApply(page, "30/05/2025", "31/08/2025");
        await expect(periodButton(page)).toContainText("30/05/2025");
        await expect(result.locator("[data-kpi-incomplete]")).toContainText(
          "Incompleta"
        );
        await expect(unknown).toHaveCount(0);
        await result.getByRole("button", { name: SOBRE }).click();
        await expect(
          page.getByRole("dialog").or(page.getByRole("tooltip")).first()
        ).toContainText("Maio de 2025: 1 de 2 dias ainda sem custo informado.");
        await assertNoPageScroll(page);
      }
    );
  }
});

test.describe("a contagem dos dias sem custo no cartão do Resultado do Início só aparece inteira", () => {
  const THIRTY_DAYS_AGO = addDays(
    new Date(NOON).toISOString().slice(0, 10),
    -29
  );
  const SIXTEEN_DAYS_OF_THIRTY: Record<string, null> = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      addDays(THIRTY_DAYS_AGO, index),
      null,
    ])
  );
  const SIXTEEN_UNKNOWN: Scenario = {
    ...SOLD,
    results: SIXTEEN_DAYS_OF_THIRTY,
  };
  const PERIODS = [
    { count: "9 de 23 dias sem custo", shortcut: "Este mês" },
    { count: "16 de 30 dias sem custo", shortcut: "Últimos 30 dias" },
  ] as const;

  const readDetail = (result: Locator) =>
    result.evaluate((card) => {
      const row = card.querySelector("[data-kpi-note-row]");
      const sign = card.querySelector("[data-kpi-incomplete]");
      const detail = card.querySelector("[data-kpi-warning-detail]");
      if (!(row && sign && detail)) {
        return null;
      }
      const rowBox = row.getBoundingClientRect();
      const signBox = sign.getBoundingClientRect();
      return {
        detailAriaHidden: detail.getAttribute("aria-hidden") === "true",
        signInsideRow:
          signBox.left >= rowBox.left - 0.5 &&
          signBox.right <= rowBox.right + 0.5,
        signWhole: sign.scrollWidth <= sign.clientWidth + 1,
      };
    });

  for (const size of [
    { fontPixels: 20, height: 740, whole: false, width: 320 },
    { fontPixels: 16, height: 740, whole: true, width: 360 },
  ]) {
    reflowTest(
      `a ${size.width} px com a letra em ${size.fontPixels} px: ${size.whole ? "a contagem cabe e aparece inteira" : "a contagem não cabe e vai só ao (i), sem reticências"}`,
      async ({ page }) => {
        await openReflowViewport(page, size);
        await openHome(page, new FakeServer(SIXTEEN_UNKNOWN));
        await expectReflowFont(page, size.fontPixels);
        const result = region(page, "Resultado estimado");
        for (const period of PERIODS) {
          // biome-ignore lint/performance/noAwaitInLoops: one period at a time, on the same page
          await choosePeriod(page, period.shortcut);
          await expect(result.locator("[data-kpi-incomplete]")).toHaveText(
            "Incompleta"
          );
          const unknown = result.locator("[data-kpi-unknown]");
          await expect(unknown).toHaveText(period.count);
          if (size.whole) {
            await expect(unknown, `${period.shortcut}: inteira`).toBeVisible();
          } else {
            await expect(
              unknown,
              `${period.shortcut}: fora da linha, sem corte`
            ).toBeHidden();
          }
          await expect
            .poll(async () => (await readDetail(result))?.detailAriaHidden)
            .toBe(!size.whole);
          const read = await readDetail(result);
          await assertNoEllipsis(result.locator("[data-kpi-note-row]"));
          expect(read?.signInsideRow, "o selo está na linha").toBe(true);
          expect(read?.signWhole, "o selo não é cortado").toBe(true);
          await result.getByRole("button", { name: SOBRE }).click();
          await expect(
            page.getByRole("dialog").or(page.getByRole("tooltip")).first()
          ).toContainText(period.count.replace(" sem ", " ainda sem "));
          await page.keyboard.press("Escape");
        }
        if (!size.whole) {
          await page.setViewportSize({ height: 740, width: 360 });
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "16px";
          });
          await expect(
            result.locator("[data-kpi-unknown]"),
            "com espaço de novo, a contagem volta"
          ).toBeVisible();
          await expect(
            result.locator("[data-kpi-warning-detail]")
          ).not.toHaveAttribute("aria-hidden", "true");
        }
        await assertNoPageScroll(page);
      }
    );
  }

  reflowTest(
    "a 320 px com a letra em 20 px: sem custo conhecido, “Sem custo informado” não é cortada e o (i) diz que não dá para estimar",
    async ({ page }) => {
      await openReflowViewport(page, {
        fontPixels: 20,
        height: 740,
        width: 320,
      });
      await openHome(
        page,
        new FakeServer({
          ...SOLD,
          results: {
            "2026-10-02": null,
            "2026-10-18": null,
            "2026-10-20": null,
            "2026-10-23": null,
          },
          soldWithoutCost: 12,
        })
      );
      await expectReflowFont(page, 20);
      const result = region(page, "Resultado estimado");
      await expect(result.locator("[data-kpi-no-cost]")).toContainText(
        "Sem custo informado"
      );
      await expect(result.locator("[data-kpi-no-cost]")).toBeHidden();
      await expect(result.locator("[data-kpi-incomplete]")).toBeVisible();
      await assertNoEllipsis(result.locator("[data-kpi-note-row]"));
      const read = await readDetail(result);
      expect(read?.signWhole, "o selo não é cortado").toBe(true);
      await result.getByRole("button", { name: SOBRE }).click();
      await expect(
        page.getByRole("dialog").or(page.getByRole("tooltip")).first()
      ).toContainText("Sem custo informado: não dá para estimar.");
    }
  );
});
