/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertAmountsOnOneLine,
  assertNoPageScroll,
  assertNothingClipped,
  assertTextsApart,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "../reflow";
import { expectAllMono } from "../mono-face";
import {
  UPDATED_AT,
  UPDATED_NAME,
  refreshButton,
  type FixtureMonth,
  COMPLETE_MONTH,
  PARTIAL_MONTH,
  FakeReportServer,
  installServer,
  signIn,
  openDashboard,
  CARD,
  kpiCards,
  card,
  chain,
  chainRow,
  chartRegion,
  periodButton,
  choosePreset,
  chooseRange,
  chartHelp,
  placeOf,
  MonthlyReportServer,
  NOVEMBER_5,
  YEAR_AGO_TO_TODAY,
} from "./shared";

test.describe("a tela em um celular e o dia da loja (revisão do PR)", () => {
  test("a 360 px, o período é o seletor do projeto e a tabela dos dias é invisível, sem rolar de lado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeReportServer();
    await openDashboard(page, server);

    await expect(periodButton(page)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Período" })).toHaveCount(
      0
    );
    await choosePreset(page, "Mês passado");
    await expect
      .poll(() => chartHelp(page, chartRegion(page), "o período"))
      .toContain("1 a 30 de setembro");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    await choosePreset(page, "Este mês");
    await expect
      .poll(() => chartHelp(page, chartRegion(page), "o período"))
      .toContain("1 a 31 de outubro");

    // the table has a row for each day and "Depois de hoje", and nothing of it is on the screen
    const first = chartRegion(page).locator("tbody tr").first();
    await expect(first).toContainText("01/10/2026");
    await expect(chartRegion(page).locator("tfoot")).toContainText(
      "Depois de hoje: despesas R$ 30,00"
    );
    expect(
      (await placeOf(chartRegion(page).locator("[data-chart-data-table]")))
        .height
    ).toBeLessThanOrEqual(1);
    // nothing scrolls sideways
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a 320 px, o valor do cartão não quebra em duas linhas", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 320 });
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const value = card(page, CARD.netSales).locator("[data-kpi-value]");
    await expect(value).toHaveText("R$ 130,00");
    const box = await value.boundingBox();
    // one line of the display type
    expect(box?.height ?? 999).toBeLessThan(40);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("o dia da loja vem do relógio do servidor: com o aparelho em outro dia, os períodos são calculados de novo, uma vez", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    // the device is on November 2nd, the server says October 14th (NOW)
    await page.clock.install({ time: new Date("2026-11-02T12:00:00.000Z") });
    await installServer(page, server);
    await signIn(page, `user-${crypto.randomUUID()}`);

    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    await expect
      .poll(() => chartHelp(page, chartRegion(page), "o período"))
      .toContain("1 a 31 de outubro");
    // the first read named November (the device's day), the second corrected it, and none came after
    expect(server.periods).toEqual([
      { from: "2026-11-01", to: "2026-11-30" },
      { from: "2026-10-01", to: "2026-10-31" },
    ]);
    // two frames, then 500 ms of the page's clock (a third read scheduled by a timer fires), then the network idle
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await page.clock.runFor(500);
    await page.waitForLoadState("networkidle");
    expect(server.periods).toHaveLength(2);
  });
});

/**
 * The top of the first card at 360 px on this fixture with the control in two rows (the period, and below it
 * "Atualizar" with its status line); the one line has to bring it up by `ONE_LINE_RISE`.
 */
const FIRST_CARD_TOP_BEFORE_ONE_LINE = 539;

const ONE_LINE_RISE = 100;

test.describe("uma linha de controle: o período e o horário que é o botão de atualizar (L2-4)", () => {
  test("a 360 px, o primeiro cartão sobe ao menos 100 px em relação à tela de duas linhas (AC-4.1)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openDashboard(page, new FakeReportServer());
    await expect(card(page, CARD.result)).toContainText("R$ 38,50");
    const box = await card(page, CARD.result).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box?.y ?? 0)).toBeLessThanOrEqual(
      FIRST_CARD_TOP_BEFORE_ONE_LINE - ONE_LINE_RISE
    );
  });

  for (const size of [
    { fontPixels: 16, height: 740, width: 360 },
    { fontPixels: 20, height: 740, width: 320 },
  ]) {
    reflowTest(
      `período e horário cabem a ${size.width} px com a letra em ${size.fontPixels} px, sem corte nem rolagem (AC-4.4)`,
      async ({ page }) => {
        await openReflowViewport(page, size);
        await openDashboard(page, new FakeReportServer());
        const refresh = refreshButton(page);
        await expect(refresh).toHaveText(UPDATED_AT);
        await expectReflowFont(page, size.fontPixels);
        const period = await periodButton(page).boundingBox();
        const read = await refresh.boundingBox();
        expect(period).not.toBeNull();
        expect(read).not.toBeNull();
        for (const box of [period, read]) {
          expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
            size.width
          );
        }
        if (size.width === 360) {
          expect(
            read?.y ?? Number.POSITIVE_INFINITY,
            "a 360 px o horário fica na linha do período"
          ).toBeLessThan((period?.y ?? 0) + (period?.height ?? 0));
        }
        const clipped = await refresh.evaluate(
          (element) => element.scrollWidth - element.clientWidth
        );
        expect(clipped).toBeLessThanOrEqual(0);
        await assertNoPageScroll(page);
        await expect(page.locator("#dashboard-updated")).toHaveText(
          "Atualizado às 09:00"
        );
        const status = await page.locator("#dashboard-updated").boundingBox();
        expect(status?.height ?? 0).toBeLessThanOrEqual(1);
      }
    );
  }

  test("o foco anda do período para o botão de atualizar, e o nome do botão diz o horário (AC-4.5)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openDashboard(page, new FakeReportServer());
    await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
    await periodButton(page).focus();
    await page.keyboard.press("Tab");
    await expect(refreshButton(page)).toBeFocused();
  });

  test("lendo, o botão guarda o horário e o status diz Atualizando…", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(refreshButton(page)).toHaveText(UPDATED_AT);
    const release = server.hold("2026-10");
    await refreshButton(page).click();
    await expect(refreshButton(page)).toHaveAttribute("aria-busy", "true");
    await expect(refreshButton(page)).toHaveText(UPDATED_AT);
    await expect(page.locator("#dashboard-updated")).toHaveText("Atualizando…");
    release();
    await expect(refreshButton(page)).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#dashboard-updated")).toHaveText(
      "Atualizado às 09:00"
    );
  });

  test("Atualizar no mesmo período: o primeiro cartão não se move e o Atualizando… fica só na região aria-live", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(refreshButton(page)).toHaveText(UPDATED_AT);
    const status = page.locator("#dashboard-updated");
    const top = async () => (await card(page, CARD.result).boundingBox())?.y;
    const before = await top();
    const release = server.hold("2026-10");
    await refreshButton(page).click();
    await expect(refreshButton(page)).toHaveAttribute("aria-busy", "true");
    await expect(status).toHaveText("Atualizando…");
    await expect(status).toHaveAttribute("aria-live", "polite");
    expect((await status.boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
    expect(await top()).toBe(before);
    release();
    await expect(refreshButton(page)).not.toHaveAttribute("aria-busy", "true");
    expect(await top()).toBe(before);
  });

  test("com o dia da loja já outro no relógio do aparelho, o horário leva a data", async ({
    page,
  }) => {
    await openDashboard(page, new FakeReportServer());
    await expect(refreshButton(page)).toHaveText(UPDATED_AT);
    await page.clock.setFixedTime(new Date("2026-10-15T15:00:00.000Z"));
    await page.getByRole("tab", { exact: true, name: "Metas" }).click();
    await page.getByRole("tab", { exact: true, name: "Resultado" }).click();
    await expect(refreshButton(page)).toHaveText(
      "Atualizado em 14/10/2026 às 09:00"
    );
    await expect(refreshButton(page)).toHaveAccessibleName(
      "Atualizar, atualizado em 14/10/2026 às 09:00"
    );
  });
});

test.describe("o passo a passo do Resultado a 320 px com a letra do navegador em 24, 20 e 16 px", () => {
  skipOutsideChromium();

  /**
   * The chain does not roll sideways (the box of the table is as wide as its content) and the name of each line and its
   * value, whether side by side or one above the other, sit inside the box the reader sees.
   */
  async function assertChainInView(region: Locator) {
    const report = await region.evaluate((root) => {
      const box = root.querySelector<HTMLElement>(
        "[data-slot=table-container]"
      );
      if (!box) {
        return { rolls: ["no table container"], outside: [], measured: 0 };
      }
      const view = box.getBoundingClientRect();
      const outside: string[] = [];
      const cells = root.querySelectorAll<HTMLElement>("tbody th, tbody td");
      for (const cell of cells) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const text = range.getBoundingClientRect();
        if (text.right > view.right + 1 || text.left < view.left - 1) {
          outside.push((cell.textContent ?? "").trim().slice(0, 40));
        }
      }
      const rolls =
        box.scrollWidth > box.clientWidth
          ? [`${box.scrollWidth} px of table in a box of ${box.clientWidth} px`]
          : [];
      return { measured: cells.length, outside, rolls };
    });
    expect(
      report.measured,
      "no cell of the chain was measured"
    ).toBeGreaterThan(0);
    expect(report.rolls, "the chain rolls sideways").toEqual([]);
    expect(report.outside, "text of the chain outside the visible box").toEqual(
      []
    );
  }

  /** Millions of reais: the half of the chart totals is 126 px wide at this size when they sit in two fixed halves, and a value this long is wider. */
  const MILLIONS_MONTH: FixtureMonth = {
    expenses: [{ amount: 12_345, linked: false }],
    sales: [
      {
        anticipationFee: 0,
        cogs: 600_000,
        discount: 50_000,
        gross: 170_710_000,
        itemLines: 1,
        items: 3,
        processingFee: 1234,
        returns: 0,
        surcharge: 0,
      },
    ],
  };

  for (const fontPixels of [24, 20, 16]) {
    reflowTest(
      `com a letra em ${fontPixels} px, o R$ e o número de cada valor ficam na mesma linha`,
      async ({ page }) => {
        const server = new FakeReportServer();
        server.fixture = { "2026-10": MILLIONS_MONTH };
        await openReflowViewport(page, { fontPixels });
        await openDashboard(page, server);
        await expect(chainRow(page, "(=) Vendas líquidas")).toContainText(
          "R$ 1.706.600,00"
        );
        await expectReflowFont(page, fontPixels);
        await assertAmountsOnOneLine(chartRegion(page));
        await assertTextsApart(chartRegion(page), "dd", 2);
        await assertNothingClipped(chartRegion(page), {
          allowScroll: ["[data-slot=card]"],
        });
        expect(
          await assertAmountsOnOneLine(chain(page))
        ).toBeGreaterThanOrEqual(10);
        await assertNothingClipped(chain(page));
        await assertChainInView(chain(page));
      }
    );
  }

  for (const width of [360, 375]) {
    reflowTest(
      `a ${width} px com a letra em 20 px, a cadeia do mês de milhões empilha o nome acima do valor, sem rolar de lado`,
      async ({ page }) => {
        const server = new FakeReportServer();
        server.fixture = { "2026-10": MILLIONS_MONTH };
        await openReflowViewport(page, { fontPixels: 20, width });
        await openDashboard(page, server);
        await expect(chainRow(page, "(=) Vendas líquidas")).toContainText(
          "R$ 1.706.600,00"
        );
        await expectReflowFont(page, 20);
        await assertNothingClipped(chain(page));
        await assertChainInView(chain(page));
        const row = chainRow(page, "(=) Vendas líquidas");
        const [name, value] = await Promise.all([
          row.locator("th").boundingBox(),
          row.locator("td").boundingBox(),
        ]);
        expect(name, "the name of the line was not measured").not.toBeNull();
        expect(value, "the value of the line was not measured").not.toBeNull();
        expect(
          (name?.y ?? 0) + (name?.height ?? 0),
          "the name sits above the value"
        ).toBeLessThanOrEqual((value?.y ?? 0) + 1);
      }
    );
  }

  for (const fontPixels of [24, 20, 16]) {
    reflowTest(
      `com a letra em ${fontPixels} px, a cadeia de um mês comum cabe no cartão: o valor à vista, sem rolar de lado`,
      async ({ page }) => {
        const server = new FakeReportServer();
        await openReflowViewport(page, { fontPixels });
        await openDashboard(page, server);
        await expect(chainRow(page, "(=) Vendas líquidas")).toContainText(
          "R$ 130,00"
        );
        await expectReflowFont(page, fontPixels);
        await assertNothingClipped(chain(page));
        await assertChainInView(chain(page));
      }
    );
  }

  for (const fontPixels of [24, 20, 16]) {
    reflowTest(
      `com a letra em ${fontPixels} px, o gráfico lê inteiro, com a tabela dos dias invisível, sem rolagem lateral`,
      async ({ page }) => {
        const server = new FakeReportServer();
        await openReflowViewport(page, { fontPixels });
        await openDashboard(page, server);
        await expectReflowFont(page, fontPixels);
        const footer = chartRegion(page).locator("tfoot");
        await expect(footer).toContainText("Depois de hoje: despesas R$ 30,00");
        await assertNothingClipped(chartRegion(page), {
          allowScroll: ["[data-slot=card]"],
        });
        await assertNoPageScroll(page);
      }
    );
  }

  for (const fontPixels of [24, 20, 16]) {
    reflowTest(
      `com a letra em ${fontPixels} px, a leitura do dia do gráfico fica em Geist Mono e cabe no cartão, mesmo no melhor dia`,
      async ({ page }) => {
        await openReflowViewport(page, { fontPixels });
        await openDashboard(page, new FakeReportServer());
        await expectReflowFont(page, fontPixels);
        const slider = chartRegion(page).getByRole("slider");
        await slider.focus();
        await slider.press("Home");
        const line = chartRegion(page).locator("[data-chart-reading]");
        await expect(line).toContainText("· melhor dia");
        await expectAllMono(
          line.locator("span.whitespace-nowrap"),
          "os valores da leitura do dia"
        );
        await assertNothingClipped(chartRegion(page), {
          allowScroll: ["[data-slot=card]"],
        });
        await assertAmountsOnOneLine(line);
        await assertNoPageScroll(page);
      }
    );
  }
});

const HELP_OF_THE_OPEN_MONTH =
  /Vendas menos custos, taxas e despesas .*\. 1 de 5 dias ainda sem custo informado\./;

const HELP_OF_THIS_YEAR = /Janeiro: 1 de 31 dias ainda sem custo informado\./;

const HELP_OF_ANOTHER_YEAR =
  /Novembro de 2025: 1 de 26 dias ainda sem custo informado\./;

const ABOUT_BUTTON = /^Sobre /;

test.describe("o aviso dos dias sem custo com o mês nomeado tem teto: a contagem fica numa linha só e o que não cabe vai para o (i)", () => {
  skipOutsideChromium();

  const ONLY = (month: string): Record<string, FixtureMonth> => ({
    "2025-11": COMPLETE_MONTH,
    "2026-01": COMPLETE_MONTH,
    "2026-10": COMPLETE_MONTH,
    "2026-11": COMPLETE_MONTH,
    [month]: PARTIAL_MONTH,
  });

  const CASES = [
    {
      fixture: ONLY("2026-11"),
      help: HELP_OF_THE_OPEN_MONTH,
      line: "1 de 5 dias sem custo",
      name: "sem mês nomeado (mês aberto)",
      period: async () => undefined,
    },
    {
      fixture: ONLY("2026-01"),
      help: HELP_OF_THIS_YEAR,
      line: "janeiro: 1 de 31 dias sem custo",
      name: "mês do ano de hoje",
      period: (page: Page) => choosePreset(page, "Este ano"),
    },
    {
      fixture: ONLY("2025-11"),
      help: HELP_OF_ANOTHER_YEAR,
      line: null,
      name: "mês de outro ano",
      period: (page: Page) => chooseRange(page, ...YEAR_AGO_TO_TODAY),
    },
  ] as const;

  /**
   * Same rule as `unknownDaysText` and `unknownDaysFit` (`home/home-kpis.ts`), written here because importing the app's
   * modules from `e2e/` pulls the `@/` alias in, which the `tsconfig.node.json` that type-checks this folder does not have.
   * It is a copy, held to the app by `src/home/dashboard-unknown-days-guard.test.ts`: that test fails when the limit or the
   * text written here differs from the app's. The same test evaluates `AT_THE_LIMIT` below and holds it to the texts the app
   * lets stay on the line within one character of the limit, so the band cannot drift from the rule either.
   */
  const UNKNOWN_DAYS_MAX_CHARS = 34;
  const unknownDaysLine = (
    month: string,
    unknown: number,
    total: number,
    word: "custo" | "taxa"
  ) =>
    `${month}: ${unknown} de ${total} ${total === 1 ? "dia" : "dias"} sem ${word}`;

  /**
   * The widest counts the limit lets stay on the line: every month, named with and without a year, with the cost or only
   * the fee missing, every total and every count that fits at 33 or 34 characters. Each one must fit in one line.
   */
  const AT_THE_LIMIT = (() => {
    const months = Array.from({ length: 12 }, (_, month) => {
      const name = new Date(Date.UTC(2025, month, 1)).toLocaleDateString(
        "pt-BR",
        { month: "long", timeZone: "UTC" }
      );
      return [name, `${name} de 2025`];
    }).flat();
    const texts = months.flatMap((month) =>
      (["custo", "taxa"] as const).flatMap((word) =>
        Array.from({ length: 31 }, (_, index) => index + 1).flatMap((total) =>
          Array.from({ length: total }, (_, index) => index + 1).map(
            (unknown) => unknownDaysLine(month, unknown, total, word)
          )
        )
      )
    );
    return [
      ...new Set(
        texts.filter(
          (text) =>
            text.length >= UNKNOWN_DAYS_MAX_CHARS - 1 &&
            text.length <= UNKNOWN_DAYS_MAX_CHARS
        )
      ),
    ].sort();
  })();
  const MUST_STAY_AT_THE_LIMIT = "maio de 2025: 1 de 1 dia sem custo";

  for (const size of [
    { fontPixels: 20, height: 740, width: 320 },
    { fontPixels: 16, height: 740, width: 360 },
  ]) {
    reflowTest(
      `a ${size.width} px com a letra em ${size.fontPixels} px`,
      async ({ page }) => {
        const lines: Record<string, number> = {};
        for (const scenario of CASES) {
          // biome-ignore lint/performance/noAwaitInLoops: one store at a time, on the same page
          await openReflowViewport(page, size);
          const server = new MonthlyReportServer();
          server.now = NOVEMBER_5;
          server.fixture = scenario.fixture;
          await openDashboard(page, server);
          await expectReflowFont(page, size.fontPixels);
          await expect(kpiCards(page)).toHaveCount(4);
          await scenario.period(page);
          const result = card(page, CARD.result);
          const notice = result.locator("[data-kpi-note-row]");
          await expect(notice).toContainText("Incompleta");
          const unknown = notice.locator("[data-kpi-unknown]");
          if (scenario.line === null) {
            await expect(
              unknown,
              `${scenario.name}: vai para o (i)`
            ).toHaveCount(0);
          } else {
            await expect(unknown).toHaveText(scenario.line);
          }
          lines[scenario.name] = await notice.evaluate((element) =>
            Math.round(
              element.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(element).lineHeight)
            )
          );
          await result.getByRole("button", { name: ABOUT_BUTTON }).click();
          await expect(
            page.getByRole("dialog").or(page.getByRole("tooltip")).first()
          ).toContainText(scenario.help);
          await page.keyboard.press("Escape");
          await assertNoPageScroll(page);
          if (scenario.line !== null && scenario === CASES[0]) {
            expect(
              AT_THE_LIMIT,
              "a contagem singular de outro ano segue na lista"
            ).toContain(MUST_STAY_AT_THE_LIMIT);
            const wrapped = await unknown.evaluate((span, texts) => {
              const line = Number.parseFloat(getComputedStyle(span).lineHeight);
              return texts.filter((text) => {
                span.textContent = text;
                return span.getBoundingClientRect().height > line * 1.5;
              });
            }, AT_THE_LIMIT);
            expect(
              wrapped,
              "toda contagem que cabe no teto de caracteres cabe numa linha"
            ).toEqual([]);
          }
        }
        for (const [name, count] of Object.entries(lines)) {
          expect(
            count,
            `${name}: o sinal e a contagem na única linha de apoio`
          ).toBeLessThanOrEqual(1);
        }
      }
    );
  }
});
