/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../../e2e-pwa/ui-guardrails/measures";
import {
  COMPLETE_MONTH,
  NO_COST_MONTH,
  FIXTURE,
  FakeReportServer,
  openDashboard,
  CARD,
  kpiCards,
  card,
  chartRegion,
  periodButton,
  YEAR_NAME,
  choosePreset,
  chooseRange,
  placeOf,
  settled,
  MonthlyReportServer,
  resultHeights,
  expectSameHeights,
  DRAWN_CHART,
  NOVEMBER_5,
  YEAR_AGO_TO_TODAY,
  CHART_BOX_FIXTURES,
} from "./shared";

const MAY_5_TO_6 = /05\/05 a 06\/05/;

const MAY_5_TO_7 = /05\/05 a 07\/05/;

const DAYS_NAME = /07\/10 a 05\/11/;

const BOX_SWEEP_WIDTHS = [
  320, 340, 360, 375, 399, 400, 412, 444, 456, 459, 460, 464, 480, 560, 640,
  720, 800, 1000, 1280, 1440,
] as const;

test.describe("o cartão do gráfico mantém a altura entre o mês, Este ano, 30 dias e 366 dias em cada largura de 320 a 1440 px", () => {
  for (const name of ["incompleto", "valores de seis dígitos"] as const) {
    test(name, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ height: 800, width: 1280 });
      const server = new MonthlyReportServer();
      server.now = NOVEMBER_5;
      server.fixture = CHART_BOX_FIXTURES[name];
      await openDashboard(page, server);
      const drawn = () =>
        chartRegion(page).getByRole("img", { name: DRAWN_CHART });
      const periods: [string, () => Promise<void>][] = [
        ["mês", async () => undefined],
        ["Este ano", () => choosePreset(page, "Este ano")],
        ["30 dias", () => choosePreset(page, "Últimos 30 dias")],
        ["366 dias", () => chooseRange(page, ...YEAR_AGO_TO_TODAY)],
      ];
      const heights = new Map<number, Record<string, number>>();
      for (const [period, act] of periods) {
        // biome-ignore lint/performance/noAwaitInLoops: one period at a time, on the same page
        await act();
        await expect(drawn()).toBeVisible();
        for (const width of BOX_SWEEP_WIDTHS) {
          // biome-ignore lint/performance/noAwaitInLoops: the widths are set one after the other on the same page
          await page.setViewportSize({ height: 800, width });
          await settled(page);
          heights.set(width, {
            ...heights.get(width),
            [period]: (await placeOf(chartRegion(page))).height,
          });
        }
      }
      for (const [width, byPeriod] of heights) {
        const values = Object.values(byPeriod);
        expect(
          Math.max(...values) - Math.min(...values),
          `${width} px: ${JSON.stringify(byPeriod)}`
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

const stripOf = (page: Page) => page.locator("[data-kpi-row]");

/** A box-shadow value that draws something: an offset, a blur or a spread above zero (the ring is a 1 px spread). */
const NON_ZERO_PIXELS = /[1-9]\d*(\.\d+)?px/;

const drawsShadow = (shadow: string) => NON_ZERO_PIXELS.test(shadow);

/** The lab has no shell: the room of the side menu (16 rem open, 3 rem folded) is taken from the left of the page. */
const SIDE_MENU = { aberta: 256, recolhida: 48 } as const;

async function withSideMenu(page: Page, side: keyof typeof SIDE_MENU) {
  await page.addInitScript((room) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `#root { box-sizing: border-box; padding-left: ${room}px; }`;
      document.head.append(style);
    });
  }, SIDE_MENU[side]);
}

const cardBoxes = (page: Page) =>
  kpiCards(page).evaluateAll((cards) =>
    cards.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        height: box.height,
        left: box.left,
        shadow: style.boxShadow,
        top: box.top + window.scrollY,
        width: box.width,
      };
    })
  );

test.describe("a faixa de KPIs do Resultado: uma peça a partir de 1280 px, cartões abaixo (AC-T1.1)", () => {
  for (const width of [1279, 1280]) {
    test(`${width} px, lateral recolhida`, async ({ page }) => {
      await page.setViewportSize({ height: 800, width });
      await withSideMenu(page, "recolhida");
      await openDashboard(page, new FakeReportServer());
      await expect(kpiCards(page)).toHaveCount(4);
      await settled(page);
      const boxes = await cardBoxes(page);
      const strip = await stripOf(page).evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      });
      if (width < 1280) {
        expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(2);
        for (const box of boxes) {
          expect(box.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(drawsShadow(box.shadow)).toBe(true);
        }
        expect(drawsShadow(strip.shadow)).toBe(false);
        return;
      }
      expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
      expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1);
      const lefts = boxes.map((box) => box.left);
      expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
      for (const box of boxes) {
        expect(box.background).toBe("rgba(0, 0, 0, 0)");
        expect(drawsShadow(box.shadow)).toBe(false);
      }
      expect(strip.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(drawsShadow(strip.shadow)).toBe(true);
      const lines = await kpiCards(page).evaluateAll((cards) =>
        cards.map((element) => getComputedStyle(element).borderRightWidth)
      );
      expect(lines).toEqual(["1px", "1px", "1px", "0px"]);
      const figures = await page
        .locator("[data-kpi-row] [data-kpi-value]")
        .evaluateAll((values) =>
          values.map((element) => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.fontWeight, style.fontVariantNumeric];
          })
        );
      expect(figures).toHaveLength(4);
      for (const figure of figures) {
        expect(figure).toEqual([figures[0]?.[0], "600", "tabular-nums"]);
      }
    });
  }
});

const STRIP_FIXTURES = {
  "Este ano": { fixture: CHART_BOX_FIXTURES.completo, preset: "Este ano" },
  "Este ano incompleto": {
    fixture: CHART_BOX_FIXTURES.incompleto,
    preset: "Este ano",
  },
  "últimos 30 dias": {
    fixture: { ...CHART_BOX_FIXTURES.completo, "2026-09": COMPLETE_MONTH },
    preset: "Últimos 30 dias",
  },
  "mês completo": { fixture: CHART_BOX_FIXTURES.completo, preset: null },
  "mês incompleto": { fixture: CHART_BOX_FIXTURES.incompleto, preset: null },
  "mês sem custo informado": {
    fixture: {
      "2025-11": NO_COST_MONTH,
      "2026-01": NO_COST_MONTH,
      "2026-10": NO_COST_MONTH,
      "2026-11": NO_COST_MONTH,
    },
    preset: null,
  },
  "mês sem comparação": {
    fixture: { "2026-11": COMPLETE_MONTH },
    preset: null,
  },
  "seis dígitos": {
    fixture: CHART_BOX_FIXTURES["valores de seis dígitos"],
    preset: "Este ano",
  },
} as const;

const HIDDEN_RUNS = ["mês completo", "mês incompleto", "seis dígitos"] as const;

const SWEEP_WIDTHS = [1024, 1150, 1280, 1300, 1440] as const;

async function measureStrip(page: Page) {
  await settled(page);
  return stripOf(page).evaluate((strip) => ({
    cards: [...strip.querySelectorAll("[data-kpi]")].map((cell) => {
      const box = cell.getBoundingClientRect();
      const row = cell.querySelector("[data-kpi-note-row]");
      return { note: row ? row.getBoundingClientRect().top - box.top : null };
    }),
    cut: [...strip.querySelectorAll("[data-kpi-value]")]
      .filter((value) => value.scrollWidth > value.clientWidth)
      .map((value) => value.textContent),
    height: strip.getBoundingClientRect().height,
    linkLine: (() => {
      const row = strip.querySelector("[data-kpi=sales] [data-kpi-note-row]");
      return row
        ? Math.max(
            0,
            row.getBoundingClientRect().height -
              Number.parseFloat(getComputedStyle(row).minHeight)
          )
        : 0;
    })(),
    warned: strip.querySelector("[data-kpi-notice]") !== null,
  }));
}

type StripState = Awaited<ReturnType<typeof measureStrip>>;

/** Opens a state of the strip once and measures it at every width of the sweep. */
async function sweepStrip(
  page: Page,
  name: keyof typeof STRIP_FIXTURES,
  hidden: boolean
) {
  const { fixture, preset: period } = STRIP_FIXTURES[name];
  if (hidden) {
    await page.addInitScript(() =>
      localStorage.setItem("polaris-valores", "escondidos")
    );
  }
  const server = new MonthlyReportServer();
  server.now = NOVEMBER_5;
  server.fixture = fixture;
  await openDashboard(page, server);
  await expect(kpiCards(page)).toHaveCount(4);
  if (period) {
    await choosePreset(page, period);
    await expect(periodButton(page)).toHaveAccessibleName(
      period === "Este ano" ? YEAR_NAME : DAYS_NAME
    );
  }
  const states: Record<number, StripState> = {};
  for (const width of SWEEP_WIDTHS) {
    // biome-ignore lint/performance/noAwaitInLoops: the widths are set one after the other on the same page
    await page.setViewportSize({ height: 800, width });
    states[width] = await measureStrip(page);
  }
  return {
    badge: await page.locator("[data-kpi-unknown]").count(),
    noCost: await page.locator("[data-kpi-no-cost]").count(),
    states,
  };
}

type Measured = Record<string, Awaited<ReturnType<typeof sweepStrip>>>;

function expectSameStripHeight(measured: Measured, width: number) {
  const heights = Object.fromEntries(
    Object.entries(measured)
      .filter(([, run]) => run.states[width]?.warned === false)
      .map(([name, run]) => [
        name,
        (run.states[width]?.height ?? 0) - (run.states[width]?.linkLine ?? 0),
      ])
  );
  const values = Object.values(heights);
  expect(values.length, `${width} px: estados sem aviso`).toBeGreaterThan(0);
  expect(
    Math.max(...values) - Math.min(...values),
    `${width} px: ${JSON.stringify(heights)}`
  ).toBeLessThanOrEqual(1);
  const rest = Math.max(...values);
  for (const [name, run] of Object.entries(measured)) {
    expect(
      run.states[width]?.linkLine ?? 0,
      `${name} a ${width} px: o cartão de vendas acrescenta no máximo uma linha de apoio sob o chip`
    ).toBeLessThanOrEqual(17);
  }
  for (const [name, run] of Object.entries(measured)) {
    const state = run.states[width];
    if (state?.warned) {
      expect(
        state.height,
        `${name} a ${width} px: só o aviso acrescenta altura`
      ).toBeGreaterThanOrEqual(rest - 1);
    }
  }
}

function expectNothingCut(measured: Measured, width: number) {
  for (const [name, run] of Object.entries(measured)) {
    expect(
      run.states[width]?.cut,
      `${name} a ${width} px: valor cortado`
    ).toEqual([]);
  }
}

function expectChipMovesNothing(measured: Measured, width: number) {
  const withChip = measured["mês completo"]?.states[width]?.cards ?? [];
  const withoutChip =
    measured["mês sem comparação"]?.states[width]?.cards ?? [];
  expect(withChip).toHaveLength(4);
  for (const [index, here] of withChip.entries()) {
    expect(
      Math.abs((here.note ?? 0) - (withoutChip[index]?.note ?? 0)),
      `${width} px, cartão ${index}: a linha de apoio com e sem comparação`
    ).toBeLessThanOrEqual(1);
  }
}

test.describe("a altura da faixa de KPIs só cresce pelo aviso de estimativa; o período, a comparação e Esconder valores não a mudam (AC-T1.3, AC-T1.5)", () => {
  for (const side of ["aberta", "recolhida"] as const) {
    test(`lateral ${side}, de 1024 a 1440 px`, async ({ baseURL, browser }) => {
      test.setTimeout(300_000);
      const runs = [
        ...(
          Object.keys(STRIP_FIXTURES) as Array<keyof typeof STRIP_FIXTURES>
        ).map((name) => ({ hidden: false, name })),
        ...HIDDEN_RUNS.map((name) => ({ hidden: true, name })),
      ];
      const measured: Record<
        string,
        Awaited<ReturnType<typeof sweepStrip>>
      > = {};
      for (const { hidden, name } of runs) {
        // biome-ignore lint/performance/noAwaitInLoops: one browser context at a time, the machine has two cores
        const context = await browser.newContext({
          ...(baseURL ? { baseURL } : {}),
          viewport: { height: 800, width: SWEEP_WIDTHS[0] },
        });
        const page = await context.newPage();
        await withSideMenu(page, side);
        measured[`${name}${hidden ? ", escondido" : ""}`] = await sweepStrip(
          page,
          name,
          hidden
        );
        await context.close();
      }
      expect(measured["mês incompleto"]?.badge).toBeGreaterThan(0);
      expect(measured["mês sem custo informado"]?.noCost).toBeGreaterThan(0);
      for (const width of SWEEP_WIDTHS) {
        expectSameStripHeight(measured, width);
        expectNothingCut(measured, width);
        expectChipMovesNothing(measured, width);
      }
    });
  }
});

test.describe("o delta fica sob o valor, na linha de apoio, com sinal e nome completo, e a faixa não tem violação de axe (AC-T1.2)", () => {
  const CASES = [
    { side: "aberta", width: 900 },
    { side: "recolhida", width: 1280 },
  ] as const;
  for (const { side, width } of CASES) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${width} px, lateral ${side}, tema ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ height: 800, width });
        await page.emulateMedia({ colorScheme: scheme });
        await withSideMenu(page, side);
        await openDashboard(page, new FakeReportServer());
        await expect(kpiCards(page)).toHaveCount(4);
        await settled(page);
        const sales = card(page, CARD.netSales);
        const chip = sales.locator("[data-kpi-delta]");
        await expect(chip).toContainText("+30,0%");
        await expect(chip).toContainText("vs. setembro");
        await expect(chip).toHaveAttribute(
          "aria-label",
          "subiu 30,0 por cento em relação a setembro (1 a 14/09)"
        );
        const value = await placeOf(sales.locator("[data-kpi-value]"));
        const chipPlace = await placeOf(chip);
        expect(chipPlace.top).toBeGreaterThanOrEqual(
          value.top + value.height - 1
        );
        const [chipRight, columnRight] = await Promise.all([
          chip.evaluate((element) => element.getBoundingClientRect().right),
          sales.evaluate((element) => element.getBoundingClientRect().right),
        ]);
        expect(chipRight, "o delta não passa do cartão").toBeLessThanOrEqual(
          columnRight
        );
        expect(await axeFaults(page, "[data-kpi-row]")).toEqual([]);
      });
    }
  }
});

test.describe("ler um dia no minigráfico do Resultado: a data toma o lugar do chip e nada se move; menos de três pontos não desenham", () => {
  test("a data do dia lido, em todos os cartões que leem, no lugar do chip, sem mudar altura nem posição", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await withSideMenu(page, "recolhida");
    await openDashboard(page, new FakeReportServer());
    await expect(kpiCards(page)).toHaveCount(4);
    const sales = card(page, CARD.netSales);
    await expect(sales.locator("[data-kpi-delta]")).toHaveCount(1);
    await expect(page.locator("[data-kpi-date]")).toHaveCount(0);
    const before = await resultHeights(page);
    const noteTop = await placeOf(sales.locator("[data-kpi-note-row]"));
    const slider = sales.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 01/10");
    await expect(card(page, CARD.ticket).locator("[data-kpi-date]")).toHaveText(
      "Até 01/10"
    );
    await expect(sales.locator("[data-kpi-delta]")).toHaveCount(0);
    expectSameHeights(await resultHeights(page), before);
    expect(
      Math.abs(
        (await placeOf(sales.locator("[data-kpi-note-row]"))).top - noteTop.top
      )
    ).toBeLessThanOrEqual(1);
    await slider.press("End");
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 14/10");
    await slider.blur();
    await expect(page.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(sales.locator("[data-kpi-delta]")).toHaveCount(1);
  });

  test("um dia lido antes da primeira venda de um mês com vendas diz só “Sem vendas”, no texto e na fala do minigráfico, e o link do Histórico sai (KPI-2)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await withSideMenu(page, "recolhida");
    const server = new FakeReportServer();
    server.fixture = {
      ...FIXTURE,
      "2026-10": { ...COMPLETE_MONTH, saleDay: 4 },
    };
    await openDashboard(page, server);
    await expect(kpiCards(page)).toHaveCount(4);
    const sales = card(page, CARD.netSales);
    const ticket = card(page, CARD.ticket);
    const link = sales.locator("[data-kpi-sales-link]");
    await expect(link).toHaveCount(1);
    const before = await resultHeights(page);
    const slider = sales.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 01/10");
    await expect(sales).toContainText("Sem vendas");
    await expect(sales).not.toContainText("no período");
    await expect(ticket).toContainText("Sem vendas");
    await expect(ticket).not.toContainText("no período");
    await expect(link).toHaveCount(0);
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 01/10: R$ 0,00. Sem vendas"
    );
    await expect(ticket.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Até 01/10: sem valor. Sem vendas"
    );
    expectSameHeights(await resultHeights(page), before);
    await slider.press("End");
    await expect(sales).not.toContainText("Sem vendas");
    await slider.blur();
    await expect(link).toHaveCount(1);
  });

  test("dois dias não desenham minigráfico em nenhum cartão; três desenham nos de valor, e a Margem nunca", async ({
    page,
  }) => {
    await openDashboard(page, new FakeReportServer());
    await chooseRange(page, "2026-05-05", "2026-05-06");
    await expect(periodButton(page)).toHaveAccessibleName(MAY_5_TO_6);
    await expect(page.locator("[data-stale]")).toHaveCount(0);
    await expect(kpiCards(page)).toHaveCount(4);
    await expect(page.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(stripOf(page).getByRole("slider")).toHaveCount(0);
    await expect(card(page, CARD.netSales)).toContainText("R$");
    await chooseRange(page, "2026-05-05", "2026-05-07");
    await expect(periodButton(page)).toHaveAccessibleName(MAY_5_TO_7);
    await expect(page.locator("[data-stale]")).toHaveCount(0);
    await expect(
      card(page, CARD.netSales).locator("[data-kpi-spark]")
    ).toHaveCount(1);
    await expect(
      card(page, CARD.ticket).locator("[data-kpi-spark]")
    ).toHaveCount(1);
    await expect(
      card(page, CARD.margin).locator("[data-kpi-spark]")
    ).toHaveCount(0);
  });
});
