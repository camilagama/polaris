/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import {
  expectGeist,
  expectMono,
  familiesOf,
  fontsLoaded,
  holdMonoFont,
  MONO,
  shiftsSoFar,
  watchShifts,
} from "../mono-face";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
} from "../reflow";
import {
  alone,
  FakeServer,
  goal,
  openHome,
  region,
  SOLD,
  settled,
} from "./shared";

const PHONE_WIDTH = 760;
const LONG = 123_456_789;
const NEGATIVE = -9_964_035;
const WIDTHS = [
  { fontPixels: 20, height: 740, width: 320 },
  { fontPixels: 16, height: 740, width: 360 },
  { fontPixels: 16, height: 800, width: 760 },
  { fontPixels: 16, height: 800, width: 1280 },
] as const;

test.describe("o visor em Geist Mono no Início (AC-1)", () => {
  for (const { width, height } of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`o número dos cartões, o percentual do chip e o da meta ficam em Geist Mono, e o resto em Geist, a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      await openHome(page, new FakeServer({ ...SOLD, goals: [goal({})] }));
      const values = page.locator("[data-kpi-value]");
      await expect(values).toHaveCount(4);
      expect(await familiesOf(values), "o número dos quatro cartões").toEqual([
        MONO,
        MONO,
        MONO,
        MONO,
      ]);
      await expectMono(
        page.locator("[data-kpi-delta=up] [data-kpi-delta-text]"),
        "o percentual do chip"
      );
      await expectMono(
        page
          .locator("[data-goal-ring] > span[aria-hidden=true] > span")
          .first(),
        "o percentual da meta"
      );
      await expectGeist(
        region(page, "Vendas hoje").locator("h2"),
        "o nome do cartão"
      );
      await expectGeist(
        region(page, "Mais vendidos do mês")
          .locator("li")
          .filter({ hasText: "R$" }),
        "um valor de lista"
      );
      await expectGeist(
        region(page, "Vendas hoje").locator("[data-kpi-note-row]"),
        "a linha de apoio"
      );
    });
  }

  test("com os valores escondidos o número segue em Geist Mono", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await page.getByRole("button", { name: "Esconder valores" }).click();
    const principal = region(page, "Vendas hoje");
    await expect(principal.locator("[data-masked-money]")).toBeVisible();
    await expectMono(
      principal.locator("[data-kpi-value]"),
      "o número escondido"
    );
  });
});

test.describe("o visor cabe em todas as larguras (AC-2, AC-5)", () => {
  for (const { fontPixels, height, width } of WIDTHS) {
    for (const [cents, text] of [
      [LONG, "R$ 1.234.567,89"],
      [NEGATIVE, "-R$ 99.640,35"],
    ] as const) {
      reflowTest(
        `${text} cabe no cartão a ${width} px com a letra em ${fontPixels} px, sem cortar, sem rolar e acima do piso`,
        async ({ page }) => {
          await openReflowViewport(page, {
            fontPixels,
            height,
            width,
          });
          await openHome(page, new FakeServer(alone(cents)));
          await expectReflowFont(page, fontPixels);
          const principal = region(page, "Vendas hoje");
          await expect(principal.locator("[data-kpi-value]")).toHaveText(text, {
            timeout: 20_000,
          });
          await settled(page);
          await assertNothingClipped(principal);
          const reads = await page
            .locator("[data-kpi-value]")
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const area = node.closest("[data-kpi-headline]");
                return {
                  areaWidth: area?.getBoundingClientRect().width ?? 0,
                  scrollWidth: area?.scrollWidth ?? 0,
                  size: Number.parseFloat(getComputedStyle(node).fontSize),
                  text: node.textContent?.trim() ?? "",
                  width:
                    node.firstElementChild?.getBoundingClientRect().width ?? 0,
                };
              })
            );
          const floor = 0.875 * fontPixels;
          for (const read of reads) {
            expect(
              read.size,
              `${read.text}: abaixo do piso`
            ).toBeGreaterThanOrEqual(floor - 0.01);
            expect(
              read.scrollWidth,
              `${read.text}: passa da área do número`
            ).toBeLessThanOrEqual(Math.ceil(read.areaWidth));
          }
          await assertNoPageScroll(page);
        },
        { coarse: width < PHONE_WIDTH }
      );
    }
  }

  reflowTest(
    "um valor curto mantém o text-value-lg a 320 px com a letra em 20 px",
    async ({ page }) => {
      await openReflowViewport(page, {
        fontPixels: 20,
        height: 740,
        width: 320,
      });
      await openHome(page, new FakeServer(alone(12_990)));
      const principal = region(page, "Vendas hoje");
      await expect(principal.locator("[data-kpi-value]")).toHaveText(
        "R$ 129,90",
        {
          timeout: 20_000,
        }
      );
      const size = await principal
        .locator("[data-kpi-value]")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      expect(size).toBeCloseTo(1.5 * 20, 1);
    }
  );

  test("a linha de apoio (chip e texto) cabe numa linha a 360 px, e o chip não quebra nem passa do cartão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    await expect(page.locator("[data-kpi-delta]").first()).toBeVisible();
    const rows = await page.locator("[data-kpi]").evaluateAll((cards) =>
      cards.map((card) => {
        const row = card.querySelector("[data-kpi-note-row]");
        const chip = card.querySelector("[data-kpi-delta]");
        const rowBox = row?.getBoundingClientRect();
        const chipBox = chip?.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        return {
          chipHeight: chipBox?.height ?? 0,
          chipInside: chipBox ? chipBox.right <= cardBox.right + 0.5 : true,
          name: card.getAttribute("aria-labelledby"),
          rowHeight: rowBox?.height ?? 0,
        };
      })
    );
    for (const row of rows) {
      expect(
        row.rowHeight,
        `${row.name}: a linha de apoio quebrou`
      ).toBeLessThanOrEqual(20.5);
      expect(row.chipInside, `${row.name}: o chip passa do cartão`).toBe(true);
      if (row.chipHeight > 0) {
        expect(
          row.chipHeight,
          `${row.name}: o chip quebrou`
        ).toBeLessThanOrEqual(20.5);
      }
    }
  });
});

test.describe("a chegada tardia da Geist Mono não move nada (AC-4)", () => {
  for (const { height, width } of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`a troca da face de reserva para a Geist Mono muda o número em até 2% e o CLS fica em 0,01, a ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height, width });
      const mono = await holdMonoFont(page);
      await page.addInitScript(() => {
        (window as unknown as { __early: boolean }).__early = true;
      });
      await openHome(page, new FakeServer(alone(9_964_035)));
      const principal = region(page, "Vendas hoje");
      await expect(principal.locator("[data-kpi-value]")).toHaveText(
        "R$ 99.640,35",
        { timeout: 20_000 }
      );
      await settled(page);
      expect(mono.held, "a fonte foi retida").toBeGreaterThan(0);
      const measure = () =>
        page.locator("[data-kpi-value]").evaluateAll((nodes) =>
          nodes.map((node) => ({
            height: node.getBoundingClientRect().height,
            top: node.getBoundingClientRect().top + window.scrollY,
            width: (node.firstElementChild ?? node).getBoundingClientRect()
              .width,
          }))
        );
      const before = await measure();
      await watchShifts(page);
      mono.release();
      await expect
        .poll(async () =>
          (await fontsLoaded(page)).every((s) => s === "loaded")
        )
        .toBe(true);
      await settled(page);
      const after = await measure();
      expect(await shiftsSoFar(page)).toBeLessThanOrEqual(0.01);
      expect(after.length).toBe(before.length);
      for (const [index, then] of before.entries()) {
        const now = after[index];
        expect(
          Math.abs((now?.width ?? 0) - then.width) / then.width,
          `a largura do número ${index + 1} mudou mais de 2%`
        ).toBeLessThanOrEqual(0.02);
        expect(Math.abs((now?.top ?? 0) - then.top)).toBeLessThanOrEqual(1);
        expect(Math.abs((now?.height ?? 0) - then.height)).toBeLessThanOrEqual(
          1
        );
      }
    });
  }
});
