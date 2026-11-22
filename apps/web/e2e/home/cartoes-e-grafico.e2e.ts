/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  AN_AMOUNT,
  choosePeriod,
  expectInvisibleTable,
  FakeServer,
  goal,
  kpiGrid,
  openHome,
  periodButton,
  placeOf,
  region,
  type Scenario,
  SIZES,
  SOBRE,
  SOLD,
  settled,
  tileAreas,
} from "./shared";

const READING_TITLE = /^Vendas em \d\d\/\d\d$/;

test.describe("cartões de KPI (revisão de UI v7, § 3 e § 6)", () => {
  /** The results of the days that sold: 30 % of the net sales, known on every day of both months. */
  const KNOWN: Record<string, number> = {
    "2026-09-20": 1500,
    "2026-09-21": 3600,
    "2026-10-02": 2400,
    "2026-10-18": 55_200,
    "2026-10-20": 12_615,
    "2026-10-23": 9603,
  };
  test("o dedo ou o mouse numa sparkline do mês lê o mesmo dia nos três cartões; Vendas hoje lê sozinho; ao sair, volta para hoje", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const sales = region(page, "Vendas em outubro");
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-spark] svg")).toBeVisible();
    // the result's chip is in reais: 1 to 23 October against 1 to 23 September (R$ 798,18 − R$ 51,00)
    await expect(result.locator("[data-kpi-delta=up]")).toHaveText(
      "+R$ 747,18"
    );
    const strip = await sales.locator("[data-kpi-spark] svg").boundingBox();
    if (!strip) {
      throw new Error("a sparkline das vendas do mês não apareceu");
    }
    // the 18th of 23 days: the cards read the 1st to the 18th together
    const x = strip.x + 4 + ((strip.width - 8) * 17) / 22;
    await page.mouse.move(x, strip.y + strip.height / 2);
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 18/10");
    await expect(result.locator("[data-kpi-date]")).toHaveText("Até 18/10");
    await expect(sales.locator("[data-kpi-value]")).toHaveText("R$ 1.920,00");
    await expect(sales).toContainText("7 vendas");
    await expect(result.locator("[data-kpi-value]")).toHaveText("R$ 576,00");
    // Vendas hoje reads alone: it has no date at rest and the strip of the month does not move it
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-date]")
    ).toHaveCount(0);

    await page.mouse.move(10, 10);
    await expect(sales.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(sales.locator("[data-kpi-value]")).toHaveText("R$ 2.660,60");
  });

  test("pelo teclado: as setas andam pelos dias, o aria-valuetext diz o dia e o valor, e ao sair tudo volta para hoje", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const sales = region(page, "Vendas em outubro");
    const slider = sales.getByRole("slider");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 23/10: R$ 2.660,60"
    );
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 22/10: R$ 2.340,50"
    );
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 22/10");
    // the outline of the keyboard focus goes round the strip, inside it
    expect(
      await slider.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.outlineWidth, style.outlineOffset];
      })
    ).toEqual(["3px", "-3px"]);

    const today = page
      .locator('[aria-labelledby="home-today"]')
      .getByRole("slider");
    await today.focus();
    await expect(sales.locator("[data-kpi-date]")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(today).toHaveAttribute(
      "aria-valuetext",
      "qui, 22/10: R$ 0,00"
    );
    await expect(
      region(page, "Vendas em 22/10").locator("[data-kpi-date]")
    ).toHaveText("qui, 22/10");
    await expect(region(page, "Vendas em 22/10")).toContainText(
      "Nenhuma venda"
    );
  });

  test("Vendas hoje acompanha o dia lido: o título vira “Vendas em DD/MM”, o leitor de tela é avisado e, ao soltar, volta a “Vendas hoje” sem mover nada", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const today = region(page, "Vendas hoje");
    const title = today.getByRole("heading", { level: 2 });
    await expect(title).toHaveText("Vendas hoje");
    await expect(title).toHaveAttribute("aria-live", "polite");
    await expect(today.locator("[data-kpi-spark] svg")).toBeVisible();
    const strip = await today.locator("[data-kpi-spark] svg").boundingBox();
    if (!strip) {
      throw new Error("a sparkline de Vendas hoje não apareceu");
    }
    const still = await today.boundingBox();
    const titleStill = await title.boundingBox();
    await page.mouse.move(strip.x + 4, strip.y + strip.height / 2);
    const read = page.getByRole("region", { name: READING_TITLE });
    await expect(read).toHaveCount(1);
    const heading = (await read.getByRole("heading").textContent()) ?? "";
    const date = (await read.locator("[data-kpi-date]").textContent()) ?? "";
    expect(date.endsWith(heading.replace("Vendas em ", ""))).toBe(true);
    const reading = await read.boundingBox();
    expect(reading?.height).toBeCloseTo(still?.height ?? Number.NaN, 0);
    expect(reading?.y).toBeCloseTo(still?.y ?? Number.NaN, 0);
    const titleReading = await read.getByRole("heading").boundingBox();
    expect(titleReading?.y).toBeCloseTo(titleStill?.y ?? Number.NaN, 0);
    expect(titleReading?.height).toBeCloseTo(
      titleStill?.height ?? Number.NaN,
      0
    );

    await page.mouse.move(10, 10);
    await expect(region(page, "Vendas hoje")).toHaveCount(1);
    await expect(region(page, "Vendas hoje").getByRole("heading")).toHaveText(
      "Vendas hoje"
    );
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-date]")
    ).toHaveCount(0);
  });

  test("um dia lido antes da primeira venda de um mês com vendas diz só “Sem vendas”, no texto e na fala do minigráfico, nas Vendas e no Ticket (KPI-2)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const sales = region(page, "Vendas em outubro");
    const ticket = region(page, "Ticket médio");
    const slider = sales.getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(sales.locator("[data-kpi-date]")).toHaveText("Até 01/10");
    await expect(sales).toContainText("Sem vendas");
    await expect(sales).not.toContainText("no período");
    await expect(ticket).toContainText("Sem vendas");
    await expect(ticket).not.toContainText("no período");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Até 01/10: R$ 0,00. Sem vendas"
    );
    await expect(ticket.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Até 01/10: sem valor. Sem vendas"
    );
    await slider.press("End");
    await expect(sales).not.toContainText("Sem vendas");
    await expect(sales).toContainText("12 vendas");
  });

  test("Esconder valores: todo valor em reais vira R$ ••••, as porcentagens e as contagens ficam, e a escolha fica no aparelho", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer({ ...SOLD, results: KNOWN }));
    const main = page.locator("main");
    const toggle = page.getByRole("button", { name: "Esconder valores" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(main).toContainText("R$ 320,10");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(main).not.toContainText("R$ 320,10");
    await expect(main).not.toContainText("R$ 2.660,60");
    await expect(main).not.toContainText("R$ 747,18");
    await expect(main).not.toContainText("R$ 1.840,00");
    // no amount anywhere in the page, the chip in reais of the result included, nor in what a slider says
    await expect(main).not.toContainText(AN_AMOUNT);
    await expect(region(page, "Resultado estimado")).toContainText("R$ ••••");
    // the sign of the chip in reais stays with the hidden amount, in one box: "+R$ ••••", no gap after the sign
    const resultChip = region(page, "Resultado estimado").locator(
      "[data-kpi-delta=up]"
    );
    await expect(resultChip.locator(":scope > span")).toHaveCount(1);
    await expect(resultChip.locator(":scope > span")).toHaveText(
      "+R$ ••••valor escondido"
    );
    const spoken = await main
      .getByRole("slider")
      .evaluateAll((sliders) =>
        sliders.map((slider) => slider.getAttribute("aria-valuetext") ?? "")
      );
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.filter((text) => AN_AMOUNT.test(text))).toEqual([]);
    await expect(
      region(page, "Vendas hoje").locator("[data-kpi-value]")
    ).toHaveText("R$ ••••valor escondido");
    // the percents, the counts and the shape stay
    await expect(region(page, "Vendas hoje")).toContainText("16,0×");
    await expect(region(page, "Vendas em outubro")).toContainText("12 vendas");
    await expect(region(page, "Mais vendidos do mês")).toContainText("9 un.");
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas líquidas por dia, de 1 a 23/10: valor escondido no total. A tabela dia a dia está no fim deste bloco."
    );
    await expect(chart.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "23/10: valor escondido"
    );

    // kept on the device, like the theme: the next opening still hides
    expect(
      await page.evaluate(() => localStorage.getItem("polaris-valores"))
    ).toBe("escondidos");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Esconder valores" })
    ).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).not.toContainText("R$ 320,10");

    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(
      await page.evaluate(() => localStorage.getItem("polaris-valores"))
    ).toBeNull();
  });

  test("um dia sem custo no mês: o resultado diz quantos, com o selo, sem sparkline e sem chip (AC-9)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(
      page,
      new FakeServer({
        ...SOLD,
        results: { ...KNOWN, "2026-10-20": null },
      })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result.locator("[data-kpi-unknown]")).toHaveText(
      "1 de 23 dias sem custo"
    );
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("slider")).toHaveCount(0);
    // the other cards still read and compare
    await expect(
      region(page, "Vendas em outubro").locator("[data-kpi-spark] svg")
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("nenhum custo de mercadoria conhecido no mês: o resultado é “—” com o selo e a frase, sem sparkline e sem chip, e os outros cartões ficam (T399-3)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    // the 12 item lines sold in October have no cost: every day with a sale has a null result
    await openHome(
      page,
      new FakeServer({
        ...SOLD,
        results: {
          ...KNOWN,
          "2026-10-02": null,
          "2026-10-18": null,
          "2026-10-20": null,
          "2026-10-23": null,
        },
        soldWithoutCost: 12,
      })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result).toContainText(
      "Sem custo informado: não dá para estimar."
    );
    await expect(result).toContainText("—");
    await expect(result).not.toContainText("R$");
    await expect(result).not.toContainText("dias sem custo");
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("slider")).toHaveCount(0);
    await expect(
      region(page, "Vendas em outubro").locator("[data-kpi-spark] svg")
    ).toBeVisible();
    await expect(region(page, "Vendas em outubro")).toContainText("R$");
  });

  test("Vendas por dia: o anel do melhor dia e o de hoje, só o pico escrito (com a data), sem legenda nem linha de leitura em repouso", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    // the best day and today: the month to today sold on the 18th and on the 23rd
    await expect(chart.locator("[data-chart-mark]")).toHaveCount(2);
    await expect(chart.locator("[data-chart-mark=sold]")).toHaveCount(2);
    await expect(chart.locator("[data-chart-best]")).toHaveAttribute(
      "r",
      "5.5"
    );
    // only the peak is written, with its date: today's value is in its card
    await expect(chart.locator("[data-chart-value-label]")).toHaveText([
      "18/10 · R$ 1.840,00",
    ]);
    // no legend, and nothing above the drawing at rest
    await expect(chart.locator("[data-chart-legend]")).toHaveCount(0);
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);
  });

  for (const width of [360, 320]) {
    test(`Vendas por dia: o rótulo do pico não encosta no eixo nem sai do gráfico (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      const label = chart.locator("[data-chart-value-label]");
      await expect(label).toHaveText("18/10 · R$ 1.840,00");
      const boxes = await chart
        .locator("[data-chart-area] svg text")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return {
              bottom: box.bottom,
              isLabel: node.hasAttribute("data-chart-value-label"),
              left: box.left,
              right: box.right,
              text: node.textContent ?? "",
              top: box.top,
            };
          })
        );
      const peak = boxes.find((box) => box.isLabel);
      expect(peak).toBeDefined();
      for (const other of boxes.filter((box) => !box.isLabel)) {
        const apart =
          (peak?.right ?? 0) <= other.left ||
          other.right <= (peak?.left ?? 0) ||
          (peak?.bottom ?? 0) <= other.top ||
          other.bottom <= (peak?.top ?? 0);
        expect(apart, `o rótulo do pico sobre "${other.text}"`).toBe(true);
      }
      expect(peak?.left ?? 0).toBeGreaterThanOrEqual(0);
      expect(peak?.right ?? 0).toBeLessThanOrEqual(width);
    });
  }

  test("Vendas por dia: o melhor dia tem anel cheio, hoje sem venda tem anel vazado e sem rótulo, e os outros dias não têm anel", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    // the month of the chart sold on the 2nd, the 18th and the 20th; today (`23/10`) sold nothing
    const { "2026-10-23": _today, ...noSaleToday } = SOLD.days;
    await openHome(page, new FakeServer({ ...SOLD, days: noSaleToday }));
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-mark]")).toHaveCount(2);
    const best = chart.locator("[data-chart-best]");
    await expect(best).toHaveAttribute("data-chart-mark", "sold");
    await expect(best).toHaveAttribute("r", "5.5");
    await expect(chart.locator("[data-chart-mark=sold]")).toHaveCount(1);
    // the ring of today is hollow (a card-colored fill, the stroke in the color of the series) and smaller than the best's
    const hollow = chart.locator("[data-chart-mark=none]");
    await expect(hollow).toHaveCount(1);
    await expect(hollow).toHaveAttribute("fill", "var(--card)");
    await expect(hollow).toHaveAttribute("r", "3.5");
    // only the peak is written: the hollow ring of today carries no label, and its value (zero) is not written anywhere
    await expect(chart.locator("[data-chart-value-label]")).toHaveText([
      "18/10 · R$ 1.840,00",
    ]);
    const labelX = await chart
      .locator("[data-chart-value-label]")
      .getAttribute("x");
    const hollowX = await hollow.getAttribute("cx");
    expect(Number(labelX)).not.toBe(Number(hollowX));
    await expect(chart.locator("[data-chart-marks] text")).toHaveCount(1);
    // the best day comes first on the axis, today last: no other day has a ring
    const xs = await chart
      .locator("[data-chart-mark]")
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute("cx")))
      );
    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
  });

  test("Vendas por dia: a leitura de um dia pelo teclado aparece só enquanto dura, com o valor do dia, e a ajuda abre pelo teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    const slider = chart.getByRole("slider");
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuetext", "22/10: R$ 0,00");
    await expect(chart.locator("[data-chart-reading]")).toContainText(
      "22/10 R$ 0,00"
    );
    await slider.blur();
    await expect(chart.locator("[data-chart-reading]")).toHaveCount(0);

    const help = chart.getByRole("button", { name: "Sobre Vendas por dia" });
    await help.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(
        "Vendas líquidas de cada dia do período. Toque num dia para ver o valor."
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
  });

  for (const viewport of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`Vendas por dia: ler um dia pelo teclado não move o gráfico nem o que vem depois (${viewport.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      const area = chart.locator("[data-chart-area]");
      const total = chart.locator("p.grid > span").first();
      const box = async (locator: Locator) => {
        const found = await locator.boundingBox();
        if (!found) {
          throw new Error("elemento sem caixa");
        }
        return found;
      };
      const at = async () => ({
        area: await box(area),
        region: await box(chart),
        total: await box(total),
      });
      await expect(area).toBeVisible();
      await chart.getByRole("slider").focus();
      const before = await at();
      await page.keyboard.press("ArrowLeft");
      const reading = chart.locator("[data-chart-reading]");
      await expect(reading).toContainText("22/10 R$ 0,00");
      await expect(reading).toBeVisible();
      const tooltipRows = chart.locator("[data-chart-tooltip-row]");
      await expect(tooltipRows).toHaveCount(0);
      const during = await at();
      expect(during).toEqual(before);

      const read = await box(reading);
      const frame = await box(area.locator(".."));
      expect(read.x).toBeGreaterThanOrEqual(frame.x);
      expect(read.y).toBeGreaterThanOrEqual(frame.y);
      expect(read.x + read.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(read.y + read.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(read.x - frame.x).toBeLessThan(frame.width / 4);
      expect(read.y - frame.y).toBeLessThan(frame.height / 4);

      await page.keyboard.press("ArrowLeft");
      await expect(reading).toContainText("21/10");
      await expect(tooltipRows).toHaveCount(0);
      expect(await at()).toEqual(before);

      const frameKeys = await box(area);
      await page.mouse.move(
        frameKeys.x + frameKeys.width / 2,
        frameKeys.y + frameKeys.height / 2
      );
      await expect(tooltipRows.first()).toBeVisible();
      await expect(reading).toHaveCount(0);
      await page.keyboard.press("ArrowLeft");
      await expect(reading).toContainText("20/10");
      await expect(tooltipRows).toHaveCount(0);
      expect(await at()).toEqual(before);

      await chart.getByRole("slider").blur();
      await expect(reading).toHaveCount(0);
      expect(await at()).toEqual(before);

      const frameNow = await box(area);
      await page.mouse.move(
        frameNow.x + frameNow.width / 3,
        frameNow.y + frameNow.height / 2
      );
      await expect(tooltipRows.first()).toBeVisible();
      await expect(reading).toHaveCount(0);
      expect(await at()).toEqual(before);
    });
  }

  test("Vendas por dia: o toque (só o pointerdown, sem movimento) devolve o gráfico ao dedo depois de ler um dia pelo teclado", async ({
    page,
  }) => {
    await openHome(page, new FakeServer(SOLD));
    const chart = region(page, "Vendas por dia");
    const area = chart.locator("[data-chart-area]");
    await expect(area).toBeVisible();
    await chart.getByRole("slider").focus();
    await page.keyboard.press("ArrowLeft");
    const reading = chart.locator("[data-chart-reading]");
    await expect(reading).toContainText("22/10");

    await area.dispatchEvent("pointerdown", {
      isPrimary: true,
      pointerType: "touch",
    });
    await expect(reading).toHaveCount(0);
  });
});

const SALE_OUTSIDE_THE_MONTH: Scenario = {
  ...SOLD,
  days: { "2026-09-25": [12_000, 2] },
};

const NO_SALE_AT_ALL: Scenario = { ...SOLD, days: {} };

const NO_COST_HELP =
  /não é lucro líquido nem caixa\. Sem custo informado: não dá para estimar\./;

const CHARTS_CHUNK = "**/assets/charts-*.js";

/** The block "Vendas por dia" and what sits under it, as the page lays them out now. */
async function chartPlaces(page: Page) {
  await settled(page);
  const chart = region(page, "Vendas por dia");
  return {
    card: await placeOf(chart),
    next: await placeOf(region(page, "Ritmo de vendas")),
    total: await placeOf(chart.locator("p.grid > span").first()),
  };
}

type ChartPlaces = Awaited<ReturnType<typeof chartPlaces>>;

/**
 * The block of the chart within a pixel of the one before: its height, and where the total and the block below sit from
 * its top. The block's own top is not compared: the cards above it have another shape when the month sold nothing.
 */
function expectSamePlaces(after: ChartPlaces, before: ChartPlaces) {
  const from = (places: ChartPlaces) => ({
    card: places.card.height,
    next: places.next.top - places.card.top,
    nextHeight: places.next.height,
    total: places.total.top - places.card.top,
    totalHeight: places.total.height,
  });
  const [now, then] = [from(after), from(before)];
  for (const key of Object.keys(now) as (keyof typeof now)[]) {
    expect(Math.abs(now[key] - then[key]), key).toBeLessThanOrEqual(1);
  }
}

const MONTHS = {
  last: { range: "01/09 a 30/09", shortcut: "Mês passado" },
  this: { range: "01/10 a 31/10", shortcut: "Este mês" },
} as const;

/** One of the two months through the picker of the Início, once the block has the period asked. */
async function chooseMonth(page: Page, month: keyof typeof MONTHS) {
  await choosePeriod(page, MONTHS[month].shortcut);
  await expect(periodButton(page)).toContainText(MONTHS[month].range);
}

/** The block of one period has either the drawing or the sentence; waits for the one the scenario gives it. */
async function expectPeriodShown(page: Page, empty: boolean) {
  const chart = region(page, "Vendas por dia");
  if (empty) {
    await expect(chart).toContainText("Sem vendas no período.");
  } else {
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart).not.toContainText("Sem vendas no período.");
  }
}

test.describe("Vendas por dia: trocar de período não muda a altura do bloco nem o que vem depois", () => {
  const cases = [
    {
      empty: { last: false, this: false },
      name: "dados e dados (este mês e o passado com venda)",
      scenario: SOLD,
    },
    {
      empty: { last: false, this: true },
      name: "vazio e dados (este mês sem venda, o passado com)",
      scenario: SALE_OUTSIDE_THE_MONTH,
    },
    {
      empty: { last: true, this: true },
      name: "vazio e vazio (a loja que não vendeu nos dois meses)",
      scenario: NO_SALE_AT_ALL,
    },
  ] as const;

  for (const size of SIZES) {
    for (const { empty, name, scenario } of cases) {
      test(`${name} (${size.width} px)`, async ({ page }) => {
        await page.setViewportSize(size);
        await openHome(page, new FakeServer(scenario));
        await expectPeriodShown(page, empty.this);
        const thisMonth = await chartPlaces(page);

        await chooseMonth(page, "last");
        await expectPeriodShown(page, empty.last);
        expectSamePlaces(await chartPlaces(page), thisMonth);

        await chooseMonth(page, "this");
        await expectPeriodShown(page, empty.this);
        expectSamePlaces(await chartPlaces(page), thisMonth);
      });
    }

    test(`carregando e pronto: a caixa que guarda o lugar do gráfico tem a altura do gráfico (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(CHARTS_CHUNK, async (route) => {
        await held;
        await route.continue();
      });
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      await expect(chart.locator("[data-chart-loading]")).toBeVisible();
      const loading = await chartPlaces(page);

      release();
      await expect(
        chart.locator("[data-chart-area] svg").first()
      ).toBeVisible();
      expectSamePlaces(await chartPlaces(page), loading);
    });
  }

  test("o período sem venda mostra o chão do zero e a frase no meio da área do gráfico, não no lugar dela", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SALE_OUTSIDE_THE_MONTH));
    await expectPeriodShown(page, true);
    const chart = region(page, "Vendas por dia");
    // the chart of the chunk (the box that held its place has no `data-chart`)
    const drawn = chart.locator("[data-chart][data-chart-empty]");
    await expect(drawn).toBeVisible();
    const floor = drawn.locator("[data-chart-floor]");
    const plot = floor.locator("xpath=..");
    const sentence = plot.getByText("Sem vendas no período.");
    const [plotBox, floorBox, sentenceBox] = await Promise.all([
      plot.boundingBox(),
      floor.boundingBox(),
      sentence.boundingBox(),
    ]);
    if (!(plotBox && floorBox && sentenceBox)) {
      throw new Error("faltou uma caixa do estado vazio");
    }
    expect(plotBox.height).toBe(240);
    // the floor is the zero, 32 px over the bottom of the plot where the dates of the axis go
    expect(floorBox.y + floorBox.height).toBeCloseTo(
      plotBox.y + plotBox.height - 32,
      0
    );
    expect(sentenceBox.y + sentenceBox.height).toBeLessThanOrEqual(
      floorBox.y + floorBox.height
    );
    expect(sentenceBox.y).toBeGreaterThanOrEqual(plotBox.y);
    expect(
      Math.abs(
        sentenceBox.x + sentenceBox.width / 2 - (plotBox.x + plotBox.width / 2)
      )
    ).toBeLessThanOrEqual(1);
  });
});

const HIDE_VALUES = { name: "Esconder valores" } as const;

test.describe("Vendas por dia: só o gráfico, com os números numa tabela invisível (L2-6)", () => {
  test("a tabela invisível está ligada ao gráfico e troca com o período; o botão não existe", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0]);
    await openHome(page, new FakeServer(SOLD));
    await expectPeriodShown(page, false);
    const chart = region(page, "Vendas por dia");
    await expect(
      chart.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expect(chart).not.toContainText("Os números estão abaixo");
    await expectInvisibleTable(chart, 2);
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("row").nth(1)).toContainText(
      "01/10/2026R$ 0,00"
    );
    await expect(chart.getByRole("row").nth(2)).toContainText(
      "02/10/2026R$ 80,00"
    );
    await expect(chart.getByRole("row").nth(18)).toContainText(
      "18/10/2026R$ 1.840,00"
    );
    await expect(chart.getByRole("row").nth(23)).toContainText(
      "23/10/2026R$ 320,10"
    );
    await expect(chart.getByRole("slider")).toHaveAttribute("max", "22");

    await chooseMonth(page, "last");
    await expectPeriodShown(page, false);
    await expectInvisibleTable(chart, 2);
    await expect(chart.getByRole("row")).toHaveCount(31);
    await expect(chart.getByRole("row").nth(1)).toContainText("01/09/2026");
    await expect(chart.getByRole("row").nth(20)).toContainText(
      "20/09/2026R$ 50,00"
    );
    await expect(chart.getByRole("slider")).toHaveAttribute("max", "29");
    // the keyboard control and the summary of the image stay
    await expect(chart.getByRole("slider")).toBeVisible();
    await expect(chart.locator('[role="img"][aria-label]')).toHaveCount(1);
    await chart.getByRole("slider").focus();
    await page.keyboard.press("Tab");
    await expect(chart.getByRole("table").locator(":focus")).toHaveCount(0);
  });

  for (const size of SIZES) {
    test(`com Esconder valores a tabela invisível também mascara, e a altura do cartão não muda entre os dois meses (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(SOLD));
      await expectPeriodShown(page, false);
      const chart = region(page, "Vendas por dia");
      const visible = await chartPlaces(page);

      await page.getByRole("button", HIDE_VALUES).click();
      await expect(chart).not.toContainText(AN_AMOUNT);
      for (const month of ["last", "this"] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one period after the other
        await chooseMonth(page, month);
        await expectPeriodShown(page, false);
        const table = chart.getByRole("table");
        expect(await table.evaluate((node) => node.textContent)).not.toMatch(
          AN_AMOUNT
        );
        expect(
          await table.evaluate((node) => (node as HTMLElement).innerText)
        ).not.toMatch(AN_AMOUNT);
        await expect(table.getByText("R$ ••••").first()).toBeAttached();
        expect(
          await chart.evaluate((node) =>
            [...node.querySelectorAll("[aria-label],[aria-valuetext]")].map(
              (element) =>
                `${element.getAttribute("aria-label")} ${element.getAttribute("aria-valuetext")}`
            )
          )
        ).not.toContainEqual(expect.stringMatching(AN_AMOUNT));
        expectSamePlaces(await chartPlaces(page), visible);
      }
    });
  }

  for (const size of SIZES) {
    test(`o gráfico não abriu: a tabela aparece à vista, com o erro e Tentar novamente (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.route(CHARTS_CHUNK, (route) => route.abort());
      await openHome(page, new FakeServer(SOLD));
      const chart = region(page, "Vendas por dia");
      await expect(chart.getByText("O gráfico não abriu.")).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        chart.getByRole("button", { name: "Tentar novamente" })
      ).toBeVisible();
      await expect(chart.getByRole("table")).toBeVisible();
      await expect(chart.locator("[data-chart-data-table]")).toHaveAttribute(
        "data-chart-data-table",
        "visible"
      );
      await expect(chart.getByRole("row")).toHaveCount(24);
      await expect(chart.getByRole("row").nth(18)).toContainText(
        "18/10/2026R$ 1.840,00"
      );
      await expect(
        chart.getByRole("button", { name: "Ver os números" })
      ).toHaveCount(0);
      await chooseMonth(page, "last");
      await expect(chart.getByRole("row")).toHaveCount(31);
      await page.getByRole("button", HIDE_VALUES).click();
      await expect(chart.getByRole("table")).not.toContainText(AN_AMOUNT);
    });
  }

  test("o gráfico não abriu e o período não tem venda: a frase de sem vendas, e a tabela de zeros continua invisível", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await page.route(CHARTS_CHUNK, (route) => route.abort());
    await openHome(page, new FakeServer(SALE_OUTSIDE_THE_MONTH));
    const chart = region(page, "Vendas por dia");
    await expect(chart).toContainText("Sem vendas no período.", {
      timeout: 20_000,
    });
    await expect(chart.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "hidden"
    );
    await expect(chart).not.toContainText("O gráfico não abriu.");
  });
});

/** What each KPI card lays out, in document coordinates: the card, its support text and its sparkline. */
async function kpiPlaces(page: Page) {
  await settled(page);
  return page.locator("[data-kpi-row] [data-kpi]").evaluateAll((cards) =>
    cards.map((card) => {
      const top = (element: Element | null) =>
        element
          ? element.getBoundingClientRect().top + window.scrollY
          : Number.NaN;
      const box = card.getBoundingClientRect();
      return {
        chip: card.querySelector("[data-kpi-delta]") !== null,
        height: box.height,
        note: top(card.querySelector("[data-kpi-note-row]")),
        spark: top(card.querySelector("[data-kpi-spark]")),
        top: top(card),
      };
    })
  );
}

type KpiPlaces = Awaited<ReturnType<typeof kpiPlaces>>;

function expectSameKpiPlaces(
  after: KpiPlaces,
  before: KpiPlaces,
  when: string
) {
  expect(after.length, when).toBe(before.length);
  for (const [index, place] of after.entries()) {
    const rest = before[index];
    for (const key of ["height", "note", "spark", "top"] as const) {
      expect(
        Math.abs(place[key] - (rest?.[key] ?? Number.NaN)),
        `${when}: ${key} do cartão ${index}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

/** Reads, by the arrows, each of the 29 days before today on the sparkline of a card, and the same places as at rest at each stop. */
async function walkDays(
  page: Page,
  name: string,
  rest: KpiPlaces,
  chips: Set<boolean>
) {
  const slider = region(page, name).getByRole("slider");
  await slider.focus();
  for (let step = 1; step <= 29; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one key, then one measure
    await page.keyboard.press("ArrowLeft");
    const read = await kpiPlaces(page);
    for (const place of read) {
      chips.add(place.chip);
    }
    expectSameKpiPlaces(read, rest, `${name}, ${step} dias antes`);
  }
  await slider.blur();
  expectSameKpiPlaces(await kpiPlaces(page), rest, `${name}, solto`);
}

test.describe("cartões de KPI: escolher ou soltar um dia não move nada no cartão", () => {
  const RESULTS: Record<string, number> = {
    "2026-09-20": 1500,
    "2026-09-21": 3600,
    "2026-10-02": 2400,
    "2026-10-18": 55_200,
    "2026-10-20": 12_615,
    "2026-10-23": 9603,
  };

  for (const size of SIZES) {
    test(`o texto de apoio, a sparkline e a altura de cada cartão ficam onde estavam em todos os dias lidos, com e sem o chip (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer({ ...SOLD, results: RESULTS }));
      await expect(
        region(page, "Resultado estimado").locator("[data-kpi-spark] svg")
      ).toBeVisible();
      const rest = await kpiPlaces(page);
      const chips = new Set<boolean>(rest.map((place) => place.chip));

      for (const name of ["Vendas hoje", "Vendas em outubro"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one card at a time, the keyboard is one
        await walkDays(page, name, rest, chips);
      }
      // the walk did cross days with a chip and days without one: the proof is not of a screen that never had it
      expect([...chips].sort()).toEqual([false, true]);
    });

    test(`sem venda no mês: a linha de apoio continua nos quatro cartões, sem chip (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(NO_SALE_AT_ALL));
      await expect(region(page, "Vendas hoje")).toContainText("R$ 0,00");
      const notes = page.locator(
        "[data-kpi-row] [data-kpi] [data-kpi-note-row]"
      );
      await expect(notes).toHaveCount(4);
      const heights = await notes.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      for (const height of heights) {
        expect(height).toBeGreaterThanOrEqual(20);
      }
      await expect(
        page.locator("[data-kpi-row] [data-kpi] [data-kpi-delta]")
      ).toHaveCount(0);
    });
  }

  test("carregando e pronto: a 360 px, o esqueleto de cada cartão tem a altura do cartão e fica a mesma distância do primeiro", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0]);
    const server = new FakeServer(SOLD);
    let answer: () => void = () => undefined;
    server.held.set(
      "report/periodSummary",
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await openHome(page, server);
    const skeletons = page.locator("[data-kpi-row] [data-kpi-skeleton]");
    await expect(skeletons).toHaveCount(4);
    await settled(page);
    const loading = await skeletons.evaluateAll((cards) =>
      cards.map((card) => {
        const box = card.getBoundingClientRect();
        return { height: box.height, top: box.top + window.scrollY };
      })
    );

    answer();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const loaded = await kpiPlaces(page);
    // the result's foot has the lines its sentence takes, which the skeleton does not know: the other three are exact
    for (const index of [0, 1, 3]) {
      expect(
        Math.abs((loaded[index]?.height ?? 0) - (loading[index]?.height ?? 0)),
        `altura do cartão ${index}`
      ).toBeLessThanOrEqual(1);
    }
    // the card of the month under Hoje is as far from it as its skeleton was
    expect(
      Math.abs(
        (loaded[1]?.top ?? 0) -
          (loaded[0]?.top ?? 0) -
          ((loading[1]?.top ?? 0) - (loading[0]?.top ?? 0))
      )
    ).toBeLessThanOrEqual(1);
  });

  test("metas ainda sem resposta: um esqueleto anunciado na largura toda no lugar dos blocos, que aparecem quando elas respondem", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    let answer: () => void = () => undefined;
    server.held.set(
      "goal/list",
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const waiting = page
      .getByRole("status")
      .filter({ hasText: "Carregando a meta…" });
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveAttribute("aria-busy", "true");
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(region(page, "Mais vendidos do mês")).toHaveCount(0);
    const [skeleton, content] = await Promise.all([
      waiting.boundingBox(),
      page.locator("[data-kpi-row]").boundingBox(),
    ]);
    expect(skeleton?.width ?? 0).toBeGreaterThanOrEqual(
      (content?.width ?? 1) - 1
    );

    answer();
    await expect(region(page, "Meta")).toContainText("da meta");
    await expect(region(page, "Vendas por dia")).toBeVisible();
    await expect(waiting).toHaveCount(0);
  });
});

type TileAreas = Awaited<ReturnType<typeof tileAreas>>[number];

function expectSameAreas(tile: TileAreas, rest: TileAreas | undefined) {
  const when = `${tile.name}`;
  const same = (what: string, now?: number, before?: number) =>
    expect(now, `${when}: ${what}`).toBeCloseTo(before ?? Number.NaN, 0);
  same("altura", tile.tile?.height, rest?.tile?.height);
  same("largura", tile.tile?.width, rest?.tile?.width);
  same("área do número", tile.figure?.width, rest?.figure?.width);
  if (tile.spark && rest?.spark) {
    same("minigráfico", tile.spark.width, rest.spark.width);
    same("altura do minigráfico", tile.spark.height, rest.spark.height);
  }
}

test.describe("cartões de KPI: o valor e o minigráfico têm áreas que o número não muda", () => {
  const SHORT: Scenario = {
    ...SOLD,
    results: {
      "2026-10-18": 55_200,
      "2026-10-20": 12_615,
      "2026-10-23": 9603,
    },
  };
  const LONG: Scenario = {
    ...SOLD,
    days: {
      "2026-10-02": [8000, 1],
      "2026-10-18": [99_964_035, 6],
      "2026-10-23": [32_010, 2],
    },
    results: {
      "2026-10-02": 100,
      "2026-10-18": -9_964_035,
      "2026-10-23": 100,
    },
  };
  const INCOMPLETE: Scenario = {
    ...SHORT,
    results: { ...SHORT.results, "2026-10-20": null },
  };

  for (const size of SIZES) {
    test(`valor curto, valor longo e estimativa incompleta: o cartão, o minigráfico e a área do número ficam do mesmo tamanho, e os três do mês têm a mesma altura (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const reads: Awaited<ReturnType<typeof tileAreas>>[] = [];
      for (const scenario of [SHORT, LONG, INCOMPLETE]) {
        // biome-ignore lint/performance/noAwaitInLoops: one store at a time, one page
        await openHome(page, new FakeServer(scenario));
        await expect(region(page, "Resultado estimado")).toContainText(
          scenario === INCOMPLETE ? "Incompleta" : "R$"
        );
        reads.push(await tileAreas(page));
      }
      const [short, long, incomplete] = reads;
      expect(short?.length).toBe(4);
      for (const read of [short, long, incomplete]) {
        const heights = (read ?? [])
          .slice(1)
          .map((tile) => tile.tile?.height ?? 0);
        expect(
          Math.max(...heights) - Math.min(...heights),
          "os três cartões do mês têm a mesma altura"
        ).toBeLessThanOrEqual(1);
      }
      for (const read of [long, incomplete]) {
        for (const [index, tile] of (read ?? []).entries()) {
          expectSameAreas(tile, short?.[index]);
        }
      }
    });
  }

  const NO_COST: Scenario = {
    ...SOLD,
    results: {
      "2026-10-02": null,
      "2026-10-18": null,
      "2026-10-20": null,
      "2026-10-23": null,
    },
    soldWithoutCost: 12,
  };

  async function detailInsideRow(result: Locator, detail: string) {
    return await result.evaluate((card, selector) => {
      const row = card
        .querySelector("[data-kpi-note-row]")
        ?.getBoundingClientRect();
      const box = card.querySelector(selector)?.getBoundingClientRect();
      return Boolean(
        row &&
          box &&
          box.width > 0 &&
          box.left >= row.left - 0.5 &&
          box.right <= row.right + 0.5 &&
          box.top >= row.top - 0.5 &&
          box.bottom <= row.bottom + 0.5
      );
    }, detail);
  }

  test("com a lateral aberta a 1280 px, os dias sem custo ficam à vista na linha de apoio e o (i) diz a contagem", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(INCOMPLETE));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-unknown]")).toContainText(
      "de 23 dias sem custo"
    );
    expect(
      await detailInsideRow(result, "[data-kpi-warning-detail]"),
      "o detalhe está dentro da linha de apoio, não escondido"
    ).toBe(true);
    await result.getByRole("button", { name: SOBRE }).click();
    await expect(
      page.getByText("1 de 23 dias ainda sem custo informado.")
    ).toBeVisible();
  });

  test("sem custo conhecido, com a lateral aberta a 1280 px: “Sem custo informado” à vista e o (i) diz que não dá para estimar", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(NO_COST));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-no-cost]")).toContainText(
      "Sem custo informado"
    );
    expect(
      await detailInsideRow(result, "[data-kpi-warning-detail]"),
      "o detalhe está dentro da linha de apoio, não escondido"
    ).toBe(true);
    await result.getByRole("button", { name: SOBRE }).click();
    await expect(page.getByText(NO_COST_HELP)).toBeVisible();
  });

  test("a estimativa incompleta é uma linha só, com o sinal à vista, e a data de um dia lido vem antes dele (1280 px)", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(INCOMPLETE));
    const result = region(page, "Resultado estimado");
    await expect(result.locator("[data-kpi-incomplete]")).toHaveText(
      "Incompleta"
    );
    await expect(result.locator("[data-kpi-incomplete]")).toBeVisible();
    await expect(result.locator("[data-kpi-note-row]")).toHaveCount(1);
    await expect(result.locator("[data-kpi-warning]")).toHaveCount(1);
    const rest = await tileAreas(page);
    const slider = region(page, "Vendas em outubro").getByRole("slider");
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(result.locator("[data-kpi-date]")).toBeVisible();
    await expect(result.locator("[data-kpi-incomplete]")).toBeVisible();
    const inside = await result.evaluate((card) => {
      const row = card
        .querySelector("[data-kpi-note-row]")
        ?.getBoundingClientRect();
      const sign = card
        .querySelector("[data-kpi-incomplete]")
        ?.getBoundingClientRect();
      return Boolean(
        row &&
          sign &&
          sign.right <= row.right + 0.5 &&
          sign.bottom <= row.bottom + 0.5
      );
    });
    expect(inside, "o sinal de incompleta cabe inteiro na linha de apoio").toBe(
      true
    );
    const read = await tileAreas(page);
    for (const [index, tile] of read.entries()) {
      expect(tile.tile?.height).toBeCloseTo(rest[index]?.tile?.height ?? 0, 0);
    }
  });
});

test.describe("Vendas hoje é um dos quatro cartões da grade, com a mesma caixa em todo estado", () => {
  const [first, second, today] = Object.keys(SOLD.days).slice(-3);
  const HERO_LONG: Scenario = {
    ...SOLD,
    days: {
      ...SOLD.days,
      [first ?? ""]: [8000, 1],
      [second ?? ""]: [99_964_035, 6],
      [today ?? ""]: [123_456_789, 2],
    },
  };

  for (const size of SIZES) {
    test(`valor, valor longo, valores escondidos, esqueleto e outro período: o primeiro cartão tem a mesma altura e o mesmo lugar (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const server = new FakeServer(SOLD);
      await openHome(page, server);
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
      const [base] = (await kpiGrid(page)).cells;
      expect(base?.height ?? 0).toBeGreaterThan(0);
      const same = async (when: string, place = true) => {
        const [hero] = (await kpiGrid(page)).cells;
        expect(hero?.height, `${when}: altura`).toBeCloseTo(
          base?.height ?? Number.NaN,
          0
        );
        if (place) {
          expect(hero?.top, `${when}: lugar`).toBeCloseTo(
            base?.top ?? Number.NaN,
            0
          );
        }
        expect(hero?.width, `${when}: largura`).toBeCloseTo(
          base?.width ?? Number.NaN,
          0
        );
      };

      await page.getByRole("button", { name: "Esconder valores" }).click();
      await expect(
        region(page, "Vendas hoje").locator("[data-masked-money]")
      ).toBeVisible();
      await same("valores escondidos");
      await page.getByRole("button", { name: "Esconder valores" }).click();

      await choosePeriod(page, "Mês passado");
      await expect(periodButton(page)).toContainText("01/09 a 30/09");
      await expect(region(page, "Vendas em setembro")).toBeVisible();
      await same("outro período");

      server.scenario = HERO_LONG;
      await page.reload();
      await expect(
        region(page, "Vendas hoje").locator("[data-kpi-value]")
      ).toHaveText("R$ 1.234.567,89", { timeout: 20_000 });
      await same("valor de nove dígitos");

      let answer: () => void = () => undefined;
      server.held.set(
        "report/periodSummary",
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      await page.reload();
      await expect(
        page.locator("[data-kpi-row] [data-kpi-skeleton]")
      ).toHaveCount(4);
      await same("esqueleto", false);
      answer();
    });
  }
});

test.describe("os quatro cartões: uma coluna até 759 px, duas a partir de 760 e uma faixa de quatro a partir de 1280", () => {
  const INCOMPLETE_MONTH: Scenario = {
    ...SOLD,
    results: Object.fromEntries(
      Object.keys(SOLD.days)
        .slice(-3)
        .map((day, index) => [day, index === 1 ? null : 9603])
    ),
  };

  const STATES = [
    ["com valores", SOLD],
    ["com estimativa incompleta", INCOMPLETE_MONTH],
  ] as const;

  for (const [name, scenario] of STATES) {
    test(`a faixa só existe a partir de 1280 px: quatro cartões na mesma linha, da mesma largura e altura (${name})`, async ({
      page,
    }) => {
      const at = async (width: number) => {
        await page.setViewportSize({ height: 800, width });
        await openHome(page, new FakeServer(scenario));
        await expect(region(page, "Resultado estimado")).toContainText("R$");
        return kpiGrid(page);
      };
      const narrow = await at(1279);
      const wide = await at(1280);
      expect(narrow.cells).toHaveLength(4);
      expect(wide.cells).toHaveLength(4);
      const row = wide.cells;
      for (const cell of row) {
        expect(cell.top).toBeCloseTo(row[0]?.top ?? Number.NaN, 0);
      }
      for (const [index, cell] of row.entries()) {
        if (index > 0) {
          expect(cell.left).toBeGreaterThan(row[index - 1]?.left ?? Number.NaN);
        }
      }
      const widths = row.map((cell) => cell.width);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      const heights = row.map((cell) => cell.height);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
        1
      );
      const gap = (layout: typeof narrow) =>
        (layout.cells[1]?.left ?? 0) -
        ((layout.cells[0]?.left ?? 0) + (layout.cells[0]?.width ?? 0));
      expect(gap(narrow), "1279 px: cartões soltos").toBeGreaterThanOrEqual(11);
      expect(
        narrow.cells.every((cell) => Number.parseFloat(cell.radius) > 0)
      ).toBe(true);
      expect(
        Math.abs(gap(wide)),
        "1280 px: células coladas"
      ).toBeLessThanOrEqual(1);
      expect(wide.cells.every((cell) => cell.radius === "0px")).toBe(true);
      expect(wide.strip.width).toBeCloseTo(
        (row.at(-1)?.left ?? 0) +
          (row.at(-1)?.width ?? 0) -
          (row[0]?.left ?? 0),
        0
      );
    });
  }

  for (const [width, columns] of [
    [320, 1],
    [360, 1],
    [759, 1],
    [760, 2],
    [1279, 2],
  ] as const) {
    test(`a ${width} px os quatro cartões estão em ${columns} ${columns === 1 ? "coluna" : "colunas"}, na ordem Hoje, Vendas, Resultado, Ticket, sem rolagem lateral`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      await openHome(page, new FakeServer(SOLD));
      await expect(region(page, "Resultado estimado")).toContainText("R$");
      const { cells } = await kpiGrid(page);
      expect(cells).toHaveLength(4);
      const lefts = new Set(cells.map((cell) => Math.round(cell.left)));
      expect(lefts.size).toBe(columns);
      expect(cells.every((cell) => Number.parseFloat(cell.radius) > 0)).toBe(
        true
      );
      const ids = await page
        .locator("[data-kpi-row] [data-kpi]")
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("aria-labelledby"))
        );
      expect(ids).toEqual([
        "home-today",
        "home-month",
        "home-result",
        "home-ticket",
      ]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
    });
  }

  test("a 320 px com a letra de 20 px nenhum número é cortado e não há rolagem lateral", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 320 });
    await page.addInitScript(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Resultado estimado")).toContainText("R$");
    await settled(page);
    const clipped = await page
      .locator("[data-kpi-row] [data-kpi-headline]")
      .evaluateAll((areas) =>
        areas.map((area) => area.scrollWidth - area.clientWidth)
      );
    expect(clipped).toHaveLength(4);
    for (const extra of clipped) {
      expect(extra).toBeLessThanOrEqual(1);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  for (const width of [760, 1279, 1280]) {
    test(`carregando: os esqueletos ficam nos lugares dos cartões que chegam (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      const server = new FakeServer(SOLD);
      let answer: () => void = () => undefined;
      server.held.set(
        "report/periodSummary",
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      await openHome(page, server);
      await expect(
        page.locator("[data-kpi-row] [data-kpi-skeleton]")
      ).toHaveCount(4);
      const loading = await kpiGrid(page);
      answer();
      await expect(region(page, "Resultado estimado")).toContainText("R$");
      const loaded = await kpiGrid(page);
      expect(loaded.cells).toHaveLength(4);
      for (const [index, cell] of loaded.cells.entries()) {
        const waiting = loading.cells[index];
        expect(cell.left, `cartão ${index}`).toBeCloseTo(waiting?.left ?? 0, 0);
        expect(
          cell.top - (loaded.cells[0]?.top ?? 0),
          `cartão ${index}: distância do primeiro`
        ).toBeCloseTo((waiting?.top ?? 0) - (loading.cells[0]?.top ?? 0), 0);
        expect(cell.width, `cartão ${index}`).toBeCloseTo(
          waiting?.width ?? 0,
          0
        );
        expect(cell.radius).toBe(waiting?.radius);
      }
    });
  }
});
