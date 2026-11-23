/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { axeFaults } from "../../e2e-pwa/ui-guardrails/measures";
import { expectNoTypedDates, touchDay } from "../date-pickers";
import {
  COMPLETE_MONTH,
  FIXTURE,
  FakeReportServer,
  openDashboard,
  CARD,
  kpiCards,
  card,
  goalsRegion,
  shortcut,
  chartRegion,
  periodButton,
  periodPanel,
  openPeriod,
  choosePreset,
  expectPreset,
  chooseRange,
  reading,
  METAS_TAB,
  metasTab,
  resultTab,
  search,
  chartHelp,
  SIZES,
  placeOf,
  settled,
  chartPlaces,
  expectSamePlaces,
  MonthlyReportServer,
} from "./shared";

const periodChoice = periodButton;

const ONE_UNKNOWN_DAY = /1 de 30 dias sem custo informado/;

const CHART_IMAGE = /Vendas líquidas e custos por dia, 1 a 31 de outubro/;

const YEAR_CHART_IMAGE =
  /^Vendas líquidas e custos por mês, 1 de janeiro a 14 de outubro/;

test.describe("o gráfico de vendas e custos (AC-4 a AC-12)", () => {
  test("escreve os totais, o melhor dia e a frase de apoio, e a tabela fecha com o que vem depois de hoje", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const region = chartRegion(page);
    await expect(region).toBeVisible();

    // the numbers hold without the drawing (AC-5)
    await expect(region).toContainText("Vendas líquidas");
    await expect(region).toContainText("R$ 130,00");
    await expect(region.locator("dt", { hasText: "Custos" })).toBeVisible();
    await expect(region).toContainText("R$ 96,50");
    await expect(region).toContainText("Melhor dia: 01/10, R$ 130,00");
    // the description of the card is in the two (i) of the title, not under it (AC-7.4)
    await expect(region).not.toContainText("1 a 31 de outubro");
    expect(await chartHelp(page, region, "o período")).toContain(
      "1 a 31 de outubro."
    );
    // there is a surcharge in October: the sentence does not promise that the lines differ by the result (AC-11)
    const lines = await chartHelp(page, region, "as linhas");
    expect(lines).toContain(
      "Com acréscimos nas vendas, a diferença entre as linhas não é o resultado do dia. Despesas do período entram no dia da competência."
    );
    expect(lines).not.toContain(
      "A diferença entre as duas linhas é o resultado estimado do dia."
    );
    await expect(region).not.toContainText("estimativa incompleta");
    await expect(region).not.toContainText("lucro líquido");

    // the drawing is an image named by its summary, with a legend that names both lines
    await expect(region.getByRole("img", { name: CHART_IMAGE })).toBeVisible();
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "Custos (CMV, taxas e despesas)"
    );

    // no button and no visible list: the table is invisible, tied to the drawing, a row for each day up to today and
    // the line for what comes after (AC-7.5)
    await expect(
      region.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    const table = region.locator("table");
    await expect(region.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "hidden"
    );
    const tableId = await table.getAttribute("id");
    expect(tableId).toBeTruthy();
    await expect(
      region.getByRole("img", { name: CHART_IMAGE })
    ).toHaveAttribute("aria-details", tableId ?? "");
    expect(
      await region
        .locator(
          "[data-chart-data-table] button, [data-chart-data-table] a, [data-chart-data-table] [tabindex]"
        )
        .count()
    ).toBe(0);
    expect(await table.locator("thead th").allTextContents()).toEqual([
      "Dia",
      "Vendas líquidas",
      "Custos",
      "Resultado do dia",
      "Despesas do período",
    ]);
    await expect(table.locator("tbody tr")).toHaveCount(14);
    const first = table.locator("tbody tr").first();
    await expect(first).toContainText("01/10/2026");
    await expect(first).toContainText("R$ 130,00");
    await expect(first).toContainText("R$ 66,50");
    await expect(first).toContainText("R$ 68,50");
    await expect(table.locator("tfoot")).toContainText(
      "Depois de hoje: despesas R$ 30,00"
    );
  });

  test("sem acréscimos, a frase diz que a diferença é o resultado do dia, e o dia da despesa a nomeia na leitura", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await chooseRange(page, "2026-07-01", "2026-07-31");

    const region = chartRegion(page);
    expect(await chartHelp(page, region, "o período")).toContain(
      "1 a 31 de julho."
    );
    expect(await chartHelp(page, region, "as linhas")).toContain(
      "A diferença entre as duas linhas é o resultado estimado do dia. Despesas do período entram no dia da competência."
    );
    // the day in focus is the last: it has no sale, and the rent of the month fell on it (AC-11)
    await expect(reading(page)).toHaveText(
      "31/07 · Vendas R$ 0,00 · Custos R$ 18,00 · inclui R$ 18,00 de despesas do período"
    );
    await expect(region.locator("table").locator("tbody tr")).toHaveCount(31);
    await expect(region.locator("table").locator("tfoot")).toHaveCount(0);
  });

  test("com um dia de custo desconhecido, o dia é hachurado e a linha quebra só nele; a leitura e a tabela dizem 'sem custo informado' (AC-9, emenda de 25/10)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await choosePreset(page, "Mês passado");

    const region = chartRegion(page);
    await expect(region).toContainText("estimativa incompleta");
    await expect(region).not.toContainText("lucro líquido");
    // the caveat is not in the chart: the (i) of the screen, the warning and the foot of the chain say it (AC-7.2)
    expect(await chartHelp(page, region, "o período")).toContain(
      "1 de 30 dias sem custo informado."
    );
    // September has no surcharge: the equality on the days without the hatch (AC-11)
    expect(await chartHelp(page, region, "as linhas")).toBe(
      `${(await region.getByRole("heading").first().innerText()).trim()}: as linhas A diferença entre as duas linhas é o resultado estimado do dia nos dias sem hachura. Despesas do período entram no dia da competência.`
    );
    await expect(region).not.toContainText("A linha de custos não aparece");
    // the legend names both lines and the hatch; no total of costs, never a partial sum
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "Custos (CMV, taxas e despesas)"
    );
    await expect(region.locator("[data-chart-legend]")).toContainText(
      "dia sem custo informado"
    );
    await expect(region.locator("dt", { hasText: "Custos" })).toHaveCount(0);
    // the card of the result: the badge and the count, no sparkline and no chip (AC-9)
    const result = card(page, CARD.result);
    await expect(result).toContainText("Incompleta");
    await expect(result).toContainText("1 de 30 dias sem custo");
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(
      region.getByRole("img", { name: ONE_UNKNOWN_DAY })
    ).toBeVisible();
    // the hatch on the first day only, and the cost line drawn from the second day on, never through the first
    await expect(region.locator("[data-chart-unknown-day]")).toHaveCount(1);
    await expect(region.locator("[data-chart-unknown-day]")).toHaveAttribute(
      "data-chart-unknown-day",
      "0"
    );
    await expect(region.locator("[data-chart-run]")).toHaveAttribute(
      "data-chart-run",
      "1-29"
    );

    // the reading of the unknown day says so in words
    const range = region.getByRole("slider");
    await range.focus();
    await range.press("Home");
    await expect(reading(page)).toContainText(
      "01/09 · Vendas R$ 100,00 · Custos: sem custo informado"
    );
    await expect(reading(page)).not.toContainText("R$ 0,00");

    const first = region.locator("table").locator("tbody tr").first();
    await expect(first).toContainText("01/09/2026");
    await expect(first.locator("td").nth(1)).toHaveText("sem custo informado");
    await expect(first.locator("td").nth(2)).toHaveText("sem custo informado");
  });

  test("com o pedaço do gráfico bloqueado, ficam os totais, o melhor dia e a tabela, e o texto do Início", async ({
    page,
  }) => {
    await page.route("**/assets/charts-*.js", (route) => route.abort());
    const server = new FakeReportServer();
    await openDashboard(page, server);

    const region = chartRegion(page);
    await expect(region).toContainText(
      "O gráfico não abriu. Os totais estão acima e a tabela, abaixo."
    );
    await expect(
      region.getByRole("button", { name: "Tentar novamente" })
    ).toBeVisible();
    await expect(region.getByRole("img")).toHaveCount(0);
    await expect(region).toContainText("R$ 130,00");
    await expect(region).toContainText("Melhor dia: 01/10, R$ 130,00");
    await expect(region.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "visible"
    );
    await expect(region.locator("table")).toBeVisible();
    await expect(region.locator("table").locator("tbody tr")).toHaveCount(14);
    await expect(region.locator("tfoot")).toBeVisible();
    await expect(
      region.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
  });
});

test.describe("Vendas × custos por dia: só o gráfico, com a ressalva dita uma vez (L2-7)", () => {
  test("a 360 px o cartão mede até 580 px, com os custos completos e com a estimativa incompleta (AC-7.1)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openDashboard(page, new FakeReportServer());
    await expect(chartRegion(page).getByRole("img")).toBeVisible();
    const complete = await placeOf(chartRegion(page));
    expect(complete.height).toBeLessThanOrEqual(580);

    await choosePreset(page, "Mês passado");
    await expect(chartRegion(page)).toContainText("estimativa incompleta");
    await expect(chartRegion(page).getByRole("img")).toBeVisible();
    const incomplete = await placeOf(chartRegion(page));
    expect(incomplete.height).toBeLessThanOrEqual(580);
    expect(Math.abs(incomplete.height - complete.height)).toBeLessThanOrEqual(
      1
    );
  });

  test("'lucro líquido' não aparece no cartão Resultado estimado nem no bloco do gráfico, e os selos de estimativa ficam (AC-7.2, AC-7.3)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openDashboard(page, new FakeReportServer());
    await choosePreset(page, "Mês passado");
    const region = chartRegion(page);
    await expect(region).toContainText("estimativa incompleta");
    await expect(card(page, CARD.result)).toContainText("Incompleta");
    await expect(card(page, CARD.margin)).toContainText("Incompleta");
    await expect(card(page, CARD.result)).not.toContainText("lucro líquido");
    await expect(region).not.toContainText("lucro líquido");
    await expect(region.getByText("dinheiro já recebido")).toHaveCount(0);

    // visible on the page: the footer of the chain and, when it brings it, the quality banner
    const visible = await page
      .locator("main")
      .evaluate(
        (main) =>
          (main as HTMLElement).innerText.match(/lucro líquido/g)?.length ?? 0
      );
    expect(visible).toBeLessThanOrEqual(2);
    // the (i) of the screen says it once; the two (i) of the chart say none and keep within 160 characters
    await page
      .getByRole("button", { exact: true, name: "Sobre Resultado" })
      .click();
    const screenHelp = page.getByRole("dialog", { name: "Resultado" });
    await expect(screenHelp).toBeVisible();
    expect((await screenHelp.innerText()).match(/lucro líquido/g)).toHaveLength(
      1
    );
    await page.keyboard.press("Escape");
    for (const about of ["o período", "as linhas"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one (i) is opened and closed at a time
      const text = await chartHelp(page, region, about);
      expect(text).not.toContain("lucro líquido");
      expect(
        text.slice(text.indexOf(`${about} `) + about.length + 1).length
      ).toBeLessThanOrEqual(160);
    }
  });

  test("a tabela invisível fica fora da ordem de foco e a árvore de acessibilidade a lê ligada ao gráfico (AC-7.5)", async ({
    page,
  }) => {
    await openDashboard(page, new FakeReportServer());
    const region = chartRegion(page);
    await expect(region.getByRole("img", { name: CHART_IMAGE })).toBeVisible();
    const focusables = await region
      .locator("[data-chart-data-table]")
      .evaluate(
        (box) =>
          box.querySelectorAll(
            "a[href], button, input, select, textarea, [tabindex]"
          ).length
      );
    expect(focusables).toBe(0);
    await expect(region).toMatchAriaSnapshot(`
      - heading "Vendas × custos por dia" [level=2]
      - img /Vendas líquidas e custos por dia, 1 a 31 de outubro/
      - slider "Dia"
      - table:
        - caption: Vendas e custos de cada dia do período
        - rowgroup:
          - row "Dia Vendas líquidas Custos Resultado do dia Despesas do período":
            - columnheader "Dia"
            - columnheader "Vendas líquidas"
            - columnheader "Custos"
            - columnheader "Resultado do dia"
            - columnheader "Despesas do período"
        - rowgroup:
          - row:
            - rowheader "01/10/2026"
`);
  });

  test("a 360 px a tabela invisível mantém o layout de tabela e a mesma árvore de acessibilidade", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openDashboard(page, new FakeReportServer());
    const region = chartRegion(page);
    await expect(region.getByRole("img", { name: CHART_IMAGE })).toBeVisible();
    const table = region.locator("[data-chart-data-table] table");
    await expect(table).toHaveCSS("display", "table");
    await expect(table.locator("tbody tr").first()).toHaveCSS(
      "display",
      "table-row"
    );
    await expect(table.locator("tbody td").first()).toHaveCSS(
      "display",
      "table-cell"
    );
    await expect(region).toMatchAriaSnapshot(`
      - heading "Vendas × custos por dia" [level=2]
      - img /Vendas líquidas e custos por dia, 1 a 31 de outubro/
      - slider "Dia"
      - table:
        - caption: Vendas e custos de cada dia do período
        - rowgroup:
          - row "Dia Vendas líquidas Custos Resultado do dia Despesas do período":
            - columnheader "Dia"
            - columnheader "Vendas líquidas"
            - columnheader "Custos"
            - columnheader "Resultado do dia"
            - columnheader "Despesas do período"
        - rowgroup:
          - row:
            - rowheader "01/10/2026"
`);
  });

  test("com Esconder valores ligado, a tabela, a leitura do dia e a dica do gráfico não deixam dígito de valor (AC-7.6)", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("polaris-valores", "escondidos")
    );
    await openDashboard(page, new FakeReportServer());
    const region = chartRegion(page);
    await expect(region.getByRole("img")).toBeVisible();
    const table = region.locator("[data-chart-data-table]");
    expect(
      await table.evaluate((element) => element.textContent ?? "")
    ).not.toMatch(AN_AMOUNT_DIGITS);
    expect(
      await table.evaluate((element) => (element as HTMLElement).innerText)
    ).not.toMatch(AN_AMOUNT_DIGITS);
    expect(
      await table.locator(".sr-only").allTextContents()
    ).not.toContainEqual(expect.stringMatching(AN_AMOUNT_DIGITS));
    expect(await reading(page).innerText()).not.toMatch(AN_AMOUNT_DIGITS);
    await expect(region.getByRole("slider")).not.toHaveAttribute(
      "aria-valuetext",
      AN_AMOUNT_DIGITS
    );
    expect(
      await region.getByRole("img").first().getAttribute("aria-label")
    ).not.toMatch(AN_AMOUNT_DIGITS);
    const area = region.locator("[data-chart-area]");
    await area.scrollIntoViewIfNeeded();
    const box = await area.boundingBox();
    if (!box) {
      throw new Error("o gráfico não tem caixa");
    }
    // the drawing takes its reveal before it answers the pointer: move until the tip shows
    await expect(async () => {
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
        steps: 4,
      });
      await expect(
        page.locator("[data-chart-tooltip-row]").first()
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    for (const row of await page
      .locator("[data-chart-tooltip-row]")
      .allInnerTexts()) {
      expect(row).not.toMatch(AN_AMOUNT_DIGITS);
    }
    await expect(region).toContainText("R$ ••••");
  });

  test("sem internet, com o pedaço do gráfico fora, a tabela aparece à vista com as duas frases (AC-7.8)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await page.route("**/assets/charts-*.js", (route) => route.abort());
    await openDashboard(page, new FakeReportServer());
    const region = chartRegion(page);
    await expect(region).toContainText("O gráfico não abriu.");
    await expect(region).toContainText(
      "Os totais estão acima e a tabela, abaixo."
    );
    await expect(region.locator("table")).toBeVisible();
    await expect(region.locator("tbody tr").first()).toContainText(
      "01/10/2026"
    );
    await expect(region.locator("tfoot")).toBeVisible();
    const box = region.locator("[data-chart-data-table]");
    expect(
      await box.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(0);
    await expect(
      region.locator("tbody tr").first().locator("td").first()
    ).toHaveAttribute("data-label", "Vendas líquidas");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(0);
  });

  for (const [width, rootFontSize] of [
    [360, 16],
    [320, 20],
  ] as const) {
    test(`a ${width} px com letra de ${rootFontSize} px, a legenda da tabela empilhada ocupa a largura do cartão e não quebra uma palavra por linha`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await page.route("**/assets/charts-*.js", (route) => route.abort());
      await openDashboard(page, new FakeReportServer());
      await page.addStyleTag({
        content: `html { font-size: ${rootFontSize}px; }`,
      });
      const region = chartRegion(page);
      const caption = region.locator("[data-chart-data-table] caption");
      await expect(caption).toBeVisible();
      await expect(region.locator("[data-chart-data-table] table")).toHaveCSS(
        "display",
        "block"
      );
      const measured = await region.evaluate((element) => {
        const box = element.querySelector("[data-chart-data-table]");
        const text = element.querySelector("[data-chart-data-table] caption");
        if (!(box instanceof HTMLElement && text instanceof HTMLElement)) {
          throw new Error("a tabela ou a legenda não está na região");
        }
        const style = getComputedStyle(text);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const paddingBottom = Number.parseFloat(style.paddingBottom);
        return {
          boxWidth: box.getBoundingClientRect().width,
          captionWidth: text.getBoundingClientRect().width,
          lines:
            (text.getBoundingClientRect().height - paddingBottom) / lineHeight,
        };
      });
      expect(measured.lines).toBeLessThanOrEqual(2.01);
      expect(measured.captionWidth).toBeGreaterThanOrEqual(
        measured.boxWidth - 1
      );
    });
  }

  test("com o gráfico aberto, as duas frases do estado de falha não aparecem", async ({
    page,
  }) => {
    await openDashboard(page, new FakeReportServer());
    const region = chartRegion(page);
    await expect(region.getByRole("img")).toBeVisible();
    await expect(region).not.toContainText("O gráfico não abriu.");
    await expect(region).not.toContainText("a tabela, abaixo");
  });
});

test.describe("os períodos (AC-1 a AC-3)", () => {
  test("os períodos prontos pedem as datas certas ao servidor, a partir de hoje na loja", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);

    await choosePreset(page, "Últimos 30 dias");
    await expect
      .poll(() => chartHelp(page, chartRegion(page), "o período"))
      .toContain("15 de setembro a 14 de outubro");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-15",
      to: "2026-10-14",
    });

    await choosePreset(page, "Mês passado");
    await expect
      .poll(() => chartHelp(page, chartRegion(page), "o período"))
      .toContain("1 a 30 de setembro");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });

    await chooseRange(page, "2026-10-05", "2026-10-12");
    await expectPreset(page, "Período");
    expect(server.periods.at(-1)).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
  });

  test("Este ano lê de 1º de janeiro até hoje e o gráfico mostra os meses do servidor (AC-1, AC-7)", async ({
    page,
  }) => {
    const server = new MonthlyReportServer();
    // the sales of the year fall on January 1st, the first day the year reads
    server.fixture = { ...FIXTURE, "2026-01": COMPLETE_MONTH };
    await openDashboard(page, server);
    const deltas = page.locator("[data-kpi-delta]");
    // the month compares with the month before
    await expect(deltas.first()).toBeVisible();

    await choosePreset(page, "Este ano");
    await expectPreset(page, "Este ano");
    await expect
      .poll(() => server.periods.at(-1))
      .toEqual({ from: "2026-01-01", to: "2026-10-14" });
    await expect(
      page.getByRole("region", { name: "Vendas × custos por dia" })
    ).toHaveCount(0);
    const region = page.getByRole("region", {
      name: "Vendas × custos por mês",
    });
    expect(await chartHelp(page, region, "o período")).toContain(
      "1 de janeiro a 14 de outubro."
    );
    expect(await chartHelp(page, region, "as linhas")).toContain(
      "Com acréscimos nas vendas, a diferença entre as linhas não é o resultado do mês. Despesas do período entram no dia da competência."
    );
    await expect(
      region.getByRole("img", {
        name: YEAR_CHART_IMAGE,
      })
    ).toBeVisible();
    // above 62 days the cards compare with nothing
    await expect(deltas).toHaveCount(0);

    const rows = region.locator("table").locator("tbody tr");
    await expect(rows).toHaveCount(10);
    await expect(region.locator("table thead")).toContainText("Mês");
    await expect(region.locator("table thead")).toContainText(
      "Resultado do mês"
    );
    await expect(region.locator("table thead")).not.toContainText(
      "Resultado do dia"
    );
    await expect(rows.first()).toContainText("janeiro de 2026");
    await expect(rows.first()).toContainText("R$ 130,00");
    await expect(rows.last()).toContainText("outubro de 2026");

    // a free range of a whole year is accepted too
    // the fake server reads the records of the month the range starts in
    server.fixture = { ...server.fixture, "2025-10": COMPLETE_MONTH };
    await chooseRange(page, "2025-10-15", "2026-10-14");
    await expectPreset(page, "Período");
    await expect
      .poll(() => server.periods.at(-1))
      .toEqual({ from: "2025-10-15", to: "2026-10-14" });
    const yearRegion = page.getByRole("region", {
      name: "Vendas × custos por mês",
    });
    expect(await chartHelp(page, yearRegion, "o período")).toContain(
      "15 de outubro de 2025"
    );
    await expect(yearRegion.locator("table tbody tr")).toHaveCount(13);
  });

  test("o painel não tem campo de data digitada: o dia além de 1 ano do início fica desligado e diz o motivo, e o servidor não é chamado", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    const asked = server.periods.length;

    await openPeriod(page);
    const panel = periodPanel(page);
    await expectNoTypedDates(panel);
    await touchDay(panel, "2025-10-13");
    await expect(
      panel.getByText("Início 13/10/2025. Escolha o último dia.")
    ).toBeVisible();
    await touchDay(panel, "2026-10-14", { force: true });
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('button[data-day="2026-10-14"]')
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      panel.locator('button[data-day="2026-10-14"]')
    ).toHaveAccessibleDescription("Escolha até 1 ano");
    expect(server.periods).toHaveLength(asked);
    await page.keyboard.press("Escape");
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  });

  test("abrir o painel e marcar só o 1º dia não troca o período: o atalho continua apertado e o botão diz as datas lidas", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await choosePreset(page, "Este ano");
    await expectPreset(page, "Este ano");
    await expect
      .poll(() => server.periods.at(-1))
      .toEqual({ from: "2026-01-01", to: "2026-10-14" });
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 01/01 a 14/10, editar"
    );
    const asked = server.periods.length;

    await openPeriod(page);
    await touchDay(periodPanel(page), "2025-10-13");
    await expect(shortcut(page, "Este ano")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.keyboard.press("Escape");
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 01/01 a 14/10, editar"
    );
    expect(server.periods).toHaveLength(asked);

    await choosePreset(page, "Este mês");
    await expectPreset(page, "Este mês");
  });

  test("o Resultado não tem campo de data do navegador nem o botão Ver período, e o painel tem os quatro atalhos", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 01/10 a 31/10, editar"
    );
    await openPeriod(page);
    expect(await page.locator("input[type=date]").count()).toBe(0);
    await expect(page.getByRole("button", { name: "Ver período" })).toHaveCount(
      0
    );
    await expect(
      page
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button")
    ).toHaveText(["Este mês", "Mês passado", "Últimos 30 dias", "Este ano"]);
    await expect(shortcut(page, "Este mês")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(
      periodPanel(page).getByRole("button", { name: "Limpar" })
    ).toHaveCount(0);
  });

  test("o dia além de um ano fica desligado e diz o motivo; o limite exato abre", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await openPeriod(page);
    const panel = periodPanel(page);
    // the first day marked: the calendar shows the month of that day, a year later it is a month the arrows reach
    await panel.getByRole("gridcell").first().waitFor();
    await panel.locator('button[data-day="2026-10-14"]').click();
    const previous = panel.getByRole("button", { name: "Mês anterior" });
    await Array.from({ length: 12 }).reduce<Promise<void>>(
      (done) => done.then(() => previous.click()),
      Promise.resolve()
    );
    const edge = panel.locator('button[data-day="2025-10-14"]');
    const beyond = panel.locator('button[data-day="2025-10-13"]');
    await expect(beyond).toHaveAttribute("aria-disabled", "true");
    const reason = await beyond.getAttribute("aria-describedby");
    expect(reason).not.toBeNull();
    await expect(panel.locator(`[id="${reason}"]`)).toHaveText(
      "Escolha até 1 ano"
    );
    await expect(edge).not.toHaveAttribute("aria-disabled", "true");
    await edge.click();
    await expect
      .poll(() => server.periods.at(-1))
      .toEqual({
        from: "2025-10-14",
        to: "2026-10-14",
      });
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 14/10/2025 a 14/10/2026, editar"
    );
  });

  test("pelo teclado, a seta chega ao dia além do limite, desligado e com o motivo; Enter e Space nele não aplicam, e o último dia permitido aplica", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await openPeriod(page);
    const panel = periodPanel(page);
    await panel.getByRole("gridcell").first().waitFor();
    const day = (iso: string) => panel.locator(`button[data-day="${iso}"]`);

    await day("2026-10-14").focus();
    await page.keyboard.press("Enter");
    await expect(panel).toContainText("Início 14/10. Escolha o último dia.");

    // a year back by the keys: the last day the limit allows
    await page.keyboard.press("Shift+PageUp");
    const edge = day("2025-10-14");
    await expect(edge).toBeFocused();
    await expect(edge).not.toHaveAttribute("aria-disabled", "true");
    const reason = panel.getByText("Escolha até 1 ano", { exact: true });
    await expect(reason).toBeHidden();

    // one more day back: the arrow reaches the day beyond, turned off, and the reason shows as text
    await page.keyboard.press("ArrowLeft");
    const beyond = day("2025-10-13");
    await expect(beyond).toBeFocused();
    await expect(beyond).toHaveAttribute("aria-disabled", "true");
    await expect(beyond).toHaveAccessibleDescription("Escolha até 1 ano");
    await expect(reason).toBeVisible();
    const asked = server.periods.length;
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(panel).toBeVisible();
    await expect(beyond).toBeFocused();
    await expect(panel).toContainText("Início 14/10. Escolha o último dia.");
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 01/10 a 31/10, editar"
    );
    expect(server.periods).toHaveLength(asked);

    // the arrow back leaves the turned-off day: the reason hides again
    await page.keyboard.press("ArrowRight");
    await expect(edge).toBeFocused();
    await expect(reason).toBeHidden();

    // the last day of the limit still applies by the keys
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect
      .poll(() => server.periods.slice(asked))
      .toEqual([{ from: "2025-10-14", to: "2026-10-14" }]);
  });

  test("teclado: o botão abre o painel, o foco entra nele e volta ao botão ao fechar; sem falha de axe", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await periodButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(periodPanel(page)).toBeVisible();
    expect(await axeFaults(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(periodPanel(page)).toHaveCount(0);
    await expect(periodButton(page)).toBeFocused();

    await periodButton(page).press("Space");
    await shortcut(page, "Mês passado").focus();
    await page.keyboard.press("Enter");
    await expect(periodPanel(page)).toHaveCount(0);
    await expect(periodButton(page)).toBeFocused();
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 01/09 a 30/09, editar"
    );
    expect(await axeFaults(page, "main")).toEqual([]);
  });

  test("um período livre feito nos dois toques do calendário: o Resultado lê as datas escolhidas", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await chooseRange(page, "2026-10-05", "2026-10-12");
    await expect
      .poll(() => server.periods.at(-1))
      .toEqual({ from: "2026-10-05", to: "2026-10-12" });
    await expect(periodButton(page)).toHaveAccessibleName(
      "Período: 05/10 a 12/10, editar"
    );
    await expectPreset(page, "Período");
  });

  test("enquanto lê outro período, mantém os números de antes marcados como tal, e um erro nunca deixa os de antes com o nome do novo", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

    const release = server.hold("2026-09");
    await choosePreset(page, "Mês passado");
    // still the figures of October, said so in the line beside the period (nothing is put above the figures), and
    // never under the name of September
    await expect(page.locator("#dashboard-updated")).toHaveText(
      "Mostrando 1 a 31 de outubro até o novo período carregar."
    );
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    release();
    await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
    await expect(page.getByText("Mostrando 1 a 31 de outubro")).toHaveCount(0);

    // a failure leaves no figures of the period before (the last 30 days keep no copy to stand in)
    await choosePreset(page, "Este mês");
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    server.failure = { code: "INTERNAL_SERVER_ERROR", status: 500 };
    await choosePreset(page, "Últimos 30 dias");
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível carregar o resultado. Tente novamente.",
      { timeout: 15_000 }
    );
    await expect(kpiCards(page)).toHaveCount(0);
    await expect(chartRegion(page)).toHaveCount(0);
  });
});

test.describe("as abas Resultado e Metas e o endereço (AC-13 a AC-15)", () => {
  test("abre no Resultado, e trocar de aba escreve aba=metas no endereço sem acrescentar um passo ao histórico", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    await expect(resultTab(page)).toHaveAttribute("aria-selected", "true");
    expect(search(page).get("aba")).toBeNull();
    const steps = await page.evaluate(() => window.history.length);

    await metasTab(page).click();
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    expect(search(page).get("aba")).toBe("metas");
    // the period and the chart belong to the Resultado tab only (AC-15)
    await expect(periodChoice(page)).toHaveCount(0);
    await expect(chartRegion(page)).toHaveCount(0);
    await expect(goalsRegion(page)).toBeVisible();

    await resultTab(page).click();
    expect(search(page).get("aba")).toBeNull();
    await expect(periodChoice(page)).toBeVisible();
    // the "voltar" of the browser leaves the screen: the tabs added no step
    expect(await page.evaluate(() => window.history.length)).toBe(steps);
  });

  test("a leitura do resumo não se repete ao trocar de aba, e o endereço guarda a aba", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server);
    const reads = server.periods.length;

    await metasTab(page).click();
    await resultTab(page).click();
    await metasTab(page).click();
    expect(server.periods).toHaveLength(reads);
    expect(page.url()).toContain("aba=metas");
  });

  test("?aba=metas abre a aba Metas", async ({ page }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&aba=metas");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(goalsRegion(page)).toBeVisible();
    expect(search(page).get("aba")).toBe("metas");
  });

  test("?meta=nova abre a aba Metas com o formulário, e o endereço guarda a aba e solta o link", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=nova");
    // the form is a dialog, so the tabs are under it: found by their markup
    await expect(
      page.getByRole("tab", { includeHidden: true, name: METAS_TAB })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog", { name: "Nova meta" })).toBeVisible();
    await expect(page.locator("#goal-create-kind")).toBeVisible();
    await expect.poll(() => search(page).get("aba")).toBe("metas");
    expect(search(page).get("meta")).toBeNull();
  });

  test("?meta=lista abre a aba Metas, sem o formulário", async ({ page }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=lista");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(goalsRegion(page)).toBeVisible();
    await expect(page.locator("#goal-create-kind")).toHaveCount(0);
    await expect.poll(() => search(page).get("aba")).toBe("metas");
  });

  test("os links do Início ganham do parâmetro aba quando vêm juntos", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&aba=resultado&meta=nova");
    await expect(
      page.getByRole("tab", { includeHidden: true, name: METAS_TAB })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#goal-create-kind")).toBeVisible();
  });
});

test.describe("o Resultado estimado num dia sem custo diz o porquê e não muda de altura (RES-1)", () => {
  const WIDTHS = [{ height: 740, width: 320 }, ...SIZES] as const;
  for (const size of WIDTHS) {
    test(`'sem custo neste dia' cabe numa linha, sem mexer no cartão (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openDashboard(page, new FakeReportServer());
      await choosePreset(page, "Mês passado");
      const result = card(page, CARD.result);
      await expect(result).toContainText("Incompleta");
      await settled(page);
      const rest = await placeOf(result);
      const restValue = await placeOf(result.locator("p").first());

      const slider = card(page, CARD.netSales).getByRole("slider");
      await slider.focus();
      await slider.press("Home");
      await expect(result).toContainText("sem custo neste dia");
      await expect(result).not.toContainText("sem valor");
      await settled(page);
      const unknownDay = await placeOf(result);
      expect(
        Math.abs(unknownDay.height - rest.height),
        "altura do cartão"
      ).toBeLessThanOrEqual(1);
      const text = result.getByText("sem custo neste dia", { exact: true });
      const line = await text.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()];
        const box = element.closest("[data-kpi]")?.getBoundingClientRect();
        return {
          lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
          right: Math.max(...rects.map((rect) => rect.right)),
          limit: box?.right ?? 0,
        };
      });
      expect(line.lines, "linhas do texto").toBe(1);
      expect(line.right, "texto dentro do cartão").toBeLessThanOrEqual(
        line.limit
      );
      const valueBox = await placeOf(result.locator("p").first());
      expect(
        Math.abs(valueBox.height - restValue.height),
        "altura da linha do valor"
      ).toBeLessThanOrEqual(1);

      await slider.press("End");
      await expect(result).not.toContainText("sem custo neste dia");
    });
  }
});

test.describe("Vendas × custos por dia: trocar de período não muda a altura do cartão nem o que vem depois", () => {
  // May and June are both partial estimates (no expense recorded): May has a sale to draw, June one returned whole
  const periods = [
    {
      data: ["2026-05-05", "2026-05-11"],
      empty: ["2026-06-05", "2026-06-11"],
      name: "7 dias",
    },
    {
      data: ["2026-05-05", "2026-05-14"],
      empty: ["2026-06-05", "2026-06-14"],
      name: "10 dias",
    },
  ] as const;

  for (const size of SIZES) {
    for (const { data, empty, name } of periods) {
      test(`${name}: com venda, sem venda e com venda de novo (${size.width} px)`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await openDashboard(page, new FakeReportServer());
        await chooseRange(page, data[0], data[1]);
        await expect(chartRegion(page)).toContainText("Melhor dia");
        const withSales = await chartPlaces(page);

        await chooseRange(page, empty[0], empty[1]);
        await expect(chartRegion(page)).toContainText("Sem vendas no período.");
        expectSamePlaces(await chartPlaces(page), withSales);

        await chooseRange(page, data[0], data[1]);
        await expect(chartRegion(page)).toContainText("Melhor dia");
        expectSamePlaces(await chartPlaces(page), withSales);
      });
    }
  }
});

const AN_AMOUNT_DIGITS = /R\$\s*\d|\d[\d.]*,\d{2}/;
