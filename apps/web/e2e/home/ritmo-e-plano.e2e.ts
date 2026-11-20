/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  AN_AMOUNT,
  CONFIRMED,
  copyKeys,
  expectInvisibleTable,
  FakeServer,
  failure,
  json,
  NOON,
  newSale,
  ORGANIZATION_ID,
  openHome,
  openWithCopy,
  type Place,
  periodCalls,
  placeOf,
  RETURN_REFRESH_MS,
  RPC_PATH,
  readsEnded,
  region,
  reopenWithoutNetwork,
  SALES_PATH,
  SOLD,
  serve,
  settled,
} from "./shared";

test.describe("Ritmo de vendas (revisão de UI v7, § 3 item 10)", () => {
  // Friday `23/10`: the 26 weeks go from Sunday `26/04` to Saturday `24/10`; the days that sold are those of SOLD
  // the sentence under the map is fixed and says what only the rhythm knows; the value of a day is in the tooltip over
  // its square, opened by the pointer, the finger or the keyboard; the best day (Sunday `18/10`) is in the summary of
  // the map and in the tooltip of its day
  const READING = "Sexta, 23/10 · R$ 320,10 · 2 vendas · hoje";
  const AT_REST =
    "Poucas semanas de vendas ainda: o mapa enche conforme você vende. 6 dias com venda nas últimas 13 semanas.";
  const rhythm = (page: Page) => region(page, "Ritmo de vendas");
  const tooltip = (page: Page) =>
    rhythm(page).locator("[data-heatmap-tooltip]");
  const expectTooltip = async (page: Page, ...parts: string[]) => {
    await Promise.all(
      parts.map((part) => expect(tooltip(page)).toContainText(part))
    );
  };
  const expectTooltipRow = (page: Page, label: string, value: string) =>
    expect(
      tooltip(page)
        .locator("dl > div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator("dd")
    ).toHaveText(value);
  const atRest = (page: Page) => rhythm(page).locator("[data-rhythm-insight]");
  const dataCells = (page: Page) =>
    rhythm(page).locator(
      '[data-heatmap] rect.visx-heatmap-rect:not([pointer-events="none"])'
    );

  test("a 1280 px: 26 semanas ao lado de Mais vendidos, hoje lido e o melhor dia em linha própria, os vazios com contorno e a camada acessível nossa", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const map = rhythm(page);
    // the line says only the weeks; how to read a square is in the (i) of the block
    await expect(map).toContainText("Últimas 26 semanas");
    await expect(map).not.toContainText("um quadrado por dia");
    await map.getByRole("button", { name: "Sobre Ritmo de vendas" }).click();
    // the ranges of the four levels are in the (i), not written under the map
    await expect(
      page.getByText(
        "Cada quadrado é um dia: quanto mais escuro, mais venda. Vazio: sem venda · até R$ 80,00 · até R$ 320,10 · até R$ 420,50 · acima"
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(atRest(page)).toHaveText(AT_REST);
    await expect(tooltip(page)).toHaveCount(0);
    // one read of the series: from the first Sunday of the 26 weeks to the eve of the month (the month is A's)
    expect(
      server.calls
        .filter((call) => call.procedure === "report/dailySales")
        .map((call) => [call.input.from, call.input.to])
    ).toEqual([["2026-04-26", "2026-09-30"]]);
    // the drawing of Bklit UI is hidden; the summary is ours
    await expect(map.locator("[data-heatmap] svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(map.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas por dia nas últimas 26 semanas: 6 dias com venda. Melhor dia 18/10, R$ 1.840,00. Meses anteriores atualizados até ontem. A tabela dia a dia está no fim deste bloco."
    );
    // a cell per day of the 26 weeks; 175 known days with no sale are outlined (181 days read, 6 sold); Saturday
    // `24/10`, to come, has no outline and no fill
    await expect(dataCells(page)).toHaveCount(182);
    await expect(map.locator("[data-heatmap-empty]")).toHaveCount(175);
    await expect(map).not.toContainText("Vazio: sem venda");
    await expect(map.locator("[data-rhythm-legend]")).toHaveText("MenosMais");
    // 3 weeks with a sale: the map says it is filling up, in the sentence under it; there is no chart of the mean by weekday
    await expect(map).not.toContainText("Média por dia da semana");
    await expect(map.locator("[data-weekday-bars]")).toHaveCount(0);
    // the cells are 12 px with a gap of 3
    const first = await dataCells(page).first().boundingBox();
    expect(first?.width).toBeCloseTo(12, 0);
    // beside Mais vendidos, under the chart, with the 30 rem the map needs and the height of the pair
    const mapBox = await map.boundingBox();
    const topBox = await region(page, "Mais vendidos do mês").boundingBox();
    const chartBox = await region(page, "Vendas por dia").boundingBox();
    expect(mapBox?.width ?? 0).toBeCloseTo(480, 0);
    expect(
      Math.abs((mapBox?.height ?? 0) - (topBox?.height ?? 900))
    ).toBeLessThan(2);
    expect(Math.abs((mapBox?.y ?? 0) - (topBox?.y ?? 900))).toBeLessThan(2);
    expect((mapBox?.x ?? 900) + (mapBox?.width ?? 0)).toBeLessThan(
      topBox?.x ?? 0
    );
    expect(mapBox?.y ?? 0).toBeGreaterThan(
      (chartBox?.y ?? 900) + (chartBox?.height ?? 0)
    );
    // the drawing fits its card: no cell beyond the right edge
    const svgBox = await map.locator("[data-heatmap] svg").boundingBox();
    expect((svgBox?.x ?? 0) + (svgBox?.width ?? 0)).toBeLessThanOrEqual(
      (mapBox?.x ?? 0) + (mapBox?.width ?? 0)
    );
    // no button: the days read, newest first, are a table for assistive technology, tied to the map
    await expect(
      map.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expectInvisibleTable(map);
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
    await expect(map.getByRole("row").nth(2)).toContainText(
      "22/10/2026R$ 0,00sem venda"
    );
  });

  test("o mouse abre o tooltip do dia sob ele e, ao sair, ele fecha; a frase de baixo não muda", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await expect(atRest(page)).toHaveText(AT_REST);
    // the column of the week of `18/10` is the last, the 26th (index 25); Sunday is its 1st row
    await dataCells(page)
      .nth(25 * 7)
      .hover();
    await expectTooltip(
      page,
      "Domingo, 18/10",
      "Vendido",
      "R$ 1.840,00",
      "Vendas",
      "6",
      "melhor dia"
    );
    await expect(atRest(page)).toHaveText(AT_REST);
    await dataCells(page)
      .nth(25 * 7 + 1)
      .hover();
    await expectTooltip(page, "Segunda, 19/10", "R$ 0,00");
    await expect(tooltip(page)).not.toContainText("melhor dia");
    await page.mouse.move(5, 5);
    await expect(tooltip(page)).toHaveCount(0);
    await expect(atRest(page)).toHaveText(AT_REST);
  });

  test("pelo teclado: o foco abre o tooltip em hoje, cima e baixo andam um dia, esquerda e direita uma semana, o aria-valuetext diz a leitura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    const slider = rhythm(page).getByRole("slider", {
      name: "Dia do mapa de vendas",
    });
    await expect(slider).toHaveAttribute("aria-valuetext", READING);
    await expect(slider).toHaveValue("180");
    await expect(tooltip(page)).toHaveCount(0);
    await slider.focus();
    await expectTooltip(page, "Sexta, 23/10", "R$ 320,10", "hoje");
    await expectTooltipRow(page, "Vendas", "2");
    // the keyboard starts on today: down is Saturday `24/10`, to come, so it stays; up is the day before
    await page.keyboard.press("ArrowDown");
    await expectTooltip(page, "Sexta, 23/10", "R$ 320,10");
    await page.keyboard.press("ArrowUp");
    await expectTooltip(page, "Quinta, 22/10", "R$ 0,00");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Quinta, 22/10 · sem venda"
    );
    await page.keyboard.press("ArrowLeft");
    await expectTooltip(page, "Quinta, 15/10");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expectTooltip(page, "Terça, 13/10");
    await page.keyboard.press("ArrowRight");
    await expectTooltip(page, "Terça, 20/10", "R$ 420,50", "3");
    // a week ahead stops at today: the days to come are not read
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuetext", READING);
    await page.keyboard.press("Home");
    await expectTooltip(page, "Domingo, 26/04");
    // leaving the map, the tooltip closes
    await page.keyboard.press("Tab");
    await expect(tooltip(page)).toHaveCount(0);
    await expect(atRest(page)).toHaveText(AT_REST);
    // Escape puts the tooltip away without leaving the control
    await slider.focus();
    await expectTooltip(page, "Sexta, 23/10");
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toHaveCount(0);
  });

  test("a 360 px: tantas semanas quanto cabem (de 13 a 20), células de 12 px, nada passa da largura", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    const map = rhythm(page);
    await expect(dataCells(page).first()).toBeVisible();
    const weeks = (await dataCells(page).count()) / 7;
    await expect(map).toContainText(`Últimas ${weeks} semanas`);
    expect(weeks).toBeGreaterThanOrEqual(13);
    expect(weeks).toBeLessThanOrEqual(20);
    await expect(atRest(page)).toHaveText(AT_REST);
    const mapBox = await map.boundingBox();
    // the whole block keeps to a part of a screen, with the numbers closed
    expect(mapBox?.height ?? 999).toBeLessThanOrEqual(270);
    const svgBox = await map.locator("[data-heatmap] svg").boundingBox();
    expect((svgBox?.x ?? 0) + (svgBox?.width ?? 0)).toBeLessThanOrEqual(
      (mapBox?.x ?? 0) + (mapBox?.width ?? 0)
    );
    const cell = await dataCells(page).first().boundingBox();
    expect(cell?.width ?? 0).toBeCloseTo(12, 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("Esconder valores: o tooltip do dia, as faixas do (i) e o título da legenda escondem os reais e deixam as contagens", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await page.getByRole("button", { name: "Esconder valores" }).click();
    const map = rhythm(page);
    await dataCells(page)
      .nth(25 * 7)
      .hover();
    await expectTooltip(page, "Domingo, 18/10", "R$ ••••", "6", "melhor dia");
    await expect(tooltip(page)).not.toContainText(AN_AMOUNT);
    await expect(map).not.toContainText(AN_AMOUNT);
    await expect(map.locator("[data-rhythm-legend]")).toHaveAttribute(
      "title",
      "Vazio: sem venda · até R$ •••• · até R$ •••• · até R$ •••• · acima"
    );
    await expect(map.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas por dia nas últimas 26 semanas: 6 dias com venda. Melhor dia 18/10, valor escondido. Meses anteriores atualizados até ontem. A tabela dia a dia está no fim deste bloco."
    );
    await page.mouse.move(5, 5);
    await expect(
      map.getByRole("slider", { name: "Dia do mapa de vendas" })
    ).toHaveAttribute(
      "aria-valuetext",
      "Sexta, 23/10 · valor escondido · 2 vendas · hoje"
    );
    await map.getByRole("button", { name: "Sobre Ritmo de vendas" }).click();
    await expect(
      page.getByText(
        "Vazio: sem venda · até R$ •••• · até R$ •••• · até R$ •••• · acima",
        { exact: false }
      )
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(map).not.toContainText(AN_AMOUNT);
    await expect(map.getByRole("row").nth(1)).toContainText("2 vendas");
    // the invisible table is read by a screen reader and found by a search: no digit of an amount in any of its texts
    const table = map.getByRole("table");
    expect(await table.evaluate((node) => node.textContent)).not.toMatch(
      AN_AMOUNT
    );
    expect(
      await table.evaluate((node) => (node as HTMLElement).innerText)
    ).not.toMatch(AN_AMOUNT);
    await expect(table.getByText("R$ ••••").first()).toBeAttached();
    expect(
      await map.evaluate((node) =>
        [...node.querySelectorAll("[aria-label],[aria-valuetext]")].map(
          (element) =>
            `${element.getAttribute("aria-label")} ${element.getAttribute("aria-valuetext")}`
        )
      )
    ).not.toContainEqual(expect.stringMatching(AN_AMOUNT));
  });

  test("o gráfico não abriu: a tabela aparece à vista com o erro e Tentar novamente, e o resto do bloco fica", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.route(HEATMAP_CHUNK, (route) => route.abort());
    await openHome(page, new FakeServer(SOLD));
    const map = rhythm(page);
    await expect(map.getByText("O gráfico não abriu.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      map.getByRole("button", { name: "Tentar novamente" })
    ).toBeVisible();
    await expect(atRest(page)).toHaveText(AT_REST);
    // the numbers are on the screen, not an option: the table, newest day first, with the values
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.locator("[data-chart-data-table]")).toHaveAttribute(
      "data-chart-data-table",
      "visible"
    );
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
    await expect(
      map.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.getByRole("table")).not.toContainText(AN_AMOUNT);
  });

  for (const size of [
    { height: 740, width: 360 },
    { height: 900, width: 900 },
    { height: 800, width: 1280 },
  ]) {
    test(`lugar reservado: a caixa do carregando tem a altura do bloco pronto e ler um dia não a muda (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      let release: () => void = () => undefined;
      const server = new FakeServer(SOLD);
      server.held.set(
        "report/dailySales",
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      await openHome(page, server);
      const loading = page
        .getByRole("status")
        .filter({ hasText: "Carregando o ritmo de vendas…" });
      await expect(loading).toBeVisible();
      await settled(page);
      const reserved = (await placeOf(loading)).height;

      release();
      await expect(atRest(page)).toHaveText(AT_REST);
      await settled(page);
      const ready = await placeOf(rhythm(page));
      expect(Math.abs(ready.height - reserved)).toBeLessThanOrEqual(1);

      // the tooltip of a day read is over the map, and moves nothing
      const total = await dataCells(page).count();
      await dataCells(page)
        .nth(total - 7)
        .hover();
      await expect(tooltip(page)).toBeVisible();
      await settled(page);
      expect(
        Math.abs((await placeOf(rhythm(page))).height - ready.height)
      ).toBeLessThanOrEqual(1);
    });
  }

  for (const size of [
    { height: 740, width: 360 },
    { height: 568, width: 320 },
  ]) {
    test(`o tooltip de um dia fica inteiro dentro da tela em toda coluna do mapa (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openHome(page, new FakeServer(SOLD));
      await expect(atRest(page)).toHaveText(AT_REST);
      await settled(page);
      const columns = Math.floor((await dataCells(page).count()) / 7);
      expect(columns).toBeGreaterThanOrEqual(16);
      const panelBox = () =>
        tooltip(page).evaluate((content) => {
          const panel = content.closest(".pointer-events-none.absolute");
          const box = panel?.getBoundingClientRect();
          const map = content
            .closest("[data-heatmap]")
            ?.getBoundingClientRect();
          return box && map
            ? {
                left: box.left,
                mapLeft: map.left,
                mapRight: map.right,
                right: box.right,
                width: window.innerWidth,
              }
            : null;
        });
      for (let column = 0; column < columns; column += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one pointer, one column after the other
        await dataCells(page)
          .nth(column * 7 + 3)
          .hover();
        await expect(tooltip(page)).toBeVisible();
        await settled(page);
        const box = await panelBox();
        expect(box, `coluna ${column}`).not.toBeNull();
        expect(box?.left, `coluna ${column}`).toBeGreaterThanOrEqual(
          Math.max(0, (box?.mapLeft ?? 0) - 0.5)
        );
        expect(box?.right, `coluna ${column}`).toBeLessThanOrEqual(
          Math.min(box?.width ?? 0, (box?.mapRight ?? 0) + 0.5)
        );
      }
    });
  }

  test("cache diário (CPU-1e): duas aberturas no mesmo dia leem a série uma vez; no dia seguinte, de novo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    const dailyCalls = () =>
      server.calls
        .filter((call) => call.procedure === "report/dailySales")
        .map((call) => [call.input.from, call.input.to]);
    await openHome(page, server);
    await expect(atRest(page)).toHaveText(AT_REST);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("polaris.offline.dailySales.")
          )
        )
      )
      .toBe(true);
    const summaries = periodCalls(server).length;

    // the second opening of the day: the figures are read again, the series comes from the copy of today
    await page.reload();
    await expect(atRest(page)).toHaveText(AT_REST, { timeout: 20_000 });
    await expect
      .poll(() => periodCalls(server).length)
      .toBeGreaterThan(summaries);
    expect(dailyCalls()).toEqual([["2026-04-26", "2026-09-30"]]);

    // the next day of the store: the copy is of yesterday, the series is read again (the next 26 weeks)
    server.now = NOON + 86_400_000;
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(rhythm(page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(dailyCalls).toEqual([
      ["2026-04-26", "2026-09-30"],
      ["2026-04-26", "2026-09-30"],
    ]);
  });

  test("chamadas /rpc da abertura (loja com vendas): lista exata de procedimentos e o total", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const rpc = countRpc(page);
    await openHome(page, new FakeServer(SOLD));
    await expect(atRest(page)).toHaveText(AT_REST);
    await expect(region(page, "Meta")).toBeVisible();
    await expect(region(page, "Precisa de ação")).toBeVisible();
    await expect
      .poll(rpc.byProcedure, { message: RPC_TABLE_HINT, timeout: 20_000 })
      .toEqual(OPENING_WITH_SALES);
    await expect.poll(rpc.inFlight).toBe(0);
    expect(rpc.byProcedure(), RPC_TABLE_HINT).toEqual(OPENING_WITH_SALES);
    expect(rpc.total(), RPC_TABLE_HINT).toBe(OPENING_WITH_SALES_TOTAL);
  });

  test("chamadas /rpc da abertura (loja sem vendas, lê o checklist): lista exata de procedimentos e o total", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const rpc = countRpc(page);
    await openHome(
      page,
      new FakeServer({ ...SOLD, days: {}, everSold: false })
    );
    await expect(region(page, "Primeiros passos")).toBeVisible();
    await expect(region(page, "Meta")).toBeVisible();
    await expect
      .poll(rpc.byProcedure, { message: RPC_TABLE_HINT, timeout: 20_000 })
      .toEqual(OPENING_WITHOUT_SALES);
    await expect.poll(rpc.inFlight).toBe(0);
    expect(rpc.byProcedure(), RPC_TABLE_HINT).toEqual(OPENING_WITHOUT_SALES);
    expect(rpc.total(), RPC_TABLE_HINT).toBe(OPENING_WITHOUT_SALES_TOTAL);
  });

  test("catálogo com mais de 100 variantes: a 1ª abertura da aba lê a lista larga e as filtradas, a 2ª só as filtradas, e a tela é a mesma", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({
      ...SOLD,
      days: {},
      everSold: false,
      stock: { all: 101, unknownCost: 0, withoutStock: 101, withStock: 0 },
    });
    const wideReads = () =>
      server.calls.filter(
        (call) =>
          call.procedure === "inventory/listBalances" &&
          call.input.productStatus === "all" &&
          call.input.limit === 100
      ).length;
    const stockReads = () =>
      server.calls.filter(
        (call) =>
          call.procedure === "inventory/listBalances" &&
          call.input.stock === "without_stock"
      ).length;
    await openHome(page, server);
    const attention = region(page, "Precisa de ação");
    await expect(attention).toContainText("100 ou mais variantes sem saldo");
    await expect(region(page, "Primeiros passos")).toBeVisible();
    await expect.poll(wideReads).toBe(1);
    await expect.poll(stockReads).toBe(1);
    // the tab goes to another screen (a full load of the page) and comes back: the Início opens again, in the same tab
    await newSale(page).click();
    await page.waitForURL(SALES_PATH);
    await page.goBack();
    await expect(attention).toContainText("100 ou mais variantes sem saldo");
    await expect(region(page, "Primeiros passos")).toBeVisible();
    await expect.poll(stockReads).toBe(2);
    expect(wideReads()).toBe(1);
    // the hint is the tab's (sessionStorage), never the device's (localStorage)
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage).filter((key) =>
          key.toLowerCase().includes("largecatalog")
        ),
        session: Object.keys(sessionStorage).filter((key) =>
          key.toLowerCase().includes("largecatalog")
        ),
      }))
    ).toEqual({ local: [], session: ["polaris.home.largeCatalog"] });
  });

  test("a leitura larga falha (500): estoque diz que está indisponível, o checklist não diz 'sem produto' nem desmarca passo, e os números ficam", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({
      ...SOLD,
      days: {},
      everSold: false,
      stock: { all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 },
    });
    server.broken.set("inventory/listBalances", "500");
    await openHome(page, server);
    await expect(
      page.getByText("Avisos do estoque indisponíveis agora.")
    ).toBeVisible({ timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).toBeVisible();
    await expect(region(page, "Meta")).toBeVisible();
    // the same state the checklist had before: with no answer of the stock it is not drawn at all (never one step undone)
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(page.getByText("Cadastrar o 1º produto")).toHaveCount(0);
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    // only the wide list, tried again as any read is: no filtered read stands in for it
    const reads = server.calls.filter(
      (call) => call.procedure === "inventory/listBalances"
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.input.productStatus === "all")).toBe(
      true
    );
  });

  test("cache diário: a loja recusa os números e a série do dia não é servida de novo sem o servidor", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    const dailyCalls = () =>
      server.calls.filter((call) => call.procedure === "report/dailySales")
        .length;
    await openHome(page, server);
    await expect(atRest(page)).toHaveText(AT_REST);
    expect(dailyCalls()).toBe(1);

    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);

    // the access is back: the series of the day is asked of the server, not taken from the page or the device
    server.broken.delete("report/periodSummary");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(dailyCalls).toBe(2);
    await expect(atRest(page)).toHaveText(AT_REST);
  });

  test("a série quebrada: o bloco diz o seu erro e Tentar novamente lê só a série; o resto fica", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    server.broken.set("report/dailySales", "500");
    await openHome(page, server);
    await expect(
      page.getByText("Não foi possível carregar o ritmo de vendas.")
    ).toBeVisible({ timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas por dia")).toBeVisible();
    // never a map of zeros in the place of the unknown
    await expect(rhythm(page)).toHaveCount(0);
    const summaries = periodCalls(server).length;
    server.broken.delete("report/dailySales");
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(atRest(page)).toHaveText(AT_REST);
    expect(periodCalls(server).length).toBe(summaries);
  });

  test("sem conexão e sem o pedaço do mapa: a tabela da cópia aparece à vista, com o aviso de internet", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.route(HEATMAP_CHUNK, (route) => route.abort());
    await reopenWithoutNetwork(page, server);
    const map = rhythm(page);
    await expect(map).toContainText(
      "O gráfico abre quando a internet voltar. Os números estão abaixo.",
      { timeout: 20_000 }
    );
    await expect(map.getByRole("table")).toBeVisible();
    await expect(map.getByRole("row")).toHaveCount(182);
    await expect(map.getByRole("row").nth(1)).toContainText(
      "23/10/2026R$ 320,102 vendas"
    );
  });

  test("sem conexão: com a cópia da série, o mapa da cópia; sem ela, 'O mapa abre com internet.'", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.context().setOffline(true);
    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible();
    await expect(atRest(page)).toHaveText(AT_REST);
    await page.context().setOffline(false);

    await reopenWithoutNetwork(page, server);
    await expect(atRest(page)).toHaveText(AT_REST, { timeout: 20_000 });

    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("polaris.offline.dailySales.")) {
          localStorage.removeItem(key);
        }
      }
    });
    await reopenWithoutNetwork(page, server);
    await expect(rhythm(page)).toContainText("O mapa abre com internet.", {
      timeout: 20_000,
    });
    await expect(rhythm(page).locator("[data-heatmap]")).toHaveCount(0);
    // the rest of the copy stands
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });
});

const RPC_TABLE_HINT =
  "chamadas /rpc por procedimento na abertura do Início: cada leitura a mais ou a menos gasta consultas do banco por aba; quem muda use-home.ts ou o shell (as leituras que ele faz na abertura) atualiza esta tabela";

/** Every /rpc request of the page, by procedure, whoever answers it (the simulated server or the stubs of the shell). */
function countRpc(page: Page) {
  const counts = new Map<string, number>();
  let flying = 0;
  const isRpc = (url: string) => RPC_PATH.test(new URL(url).pathname);
  const done = (request: { url: () => string }) => {
    if (isRpc(request.url())) {
      flying -= 1;
    }
  };
  page.on("request", (request) => {
    const match = RPC_PATH.exec(new URL(request.url()).pathname);
    if (match?.[1] !== undefined) {
      flying += 1;
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    byProcedure: () => Object.fromEntries([...counts].sort()),
    inFlight: () => flying,
    total: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
  };
}

const OPENING_WITH_SALES: Record<string, number> = {
  "device/register": 1,
  "goal/list": 1,
  "inventory/listBalances": 1,
  "offline/issueLease": 1,
  "organization/listMine": 1,
  "report/dailySales": 1,
  "report/periodSummary": 2,
};

const OPENING_WITH_SALES_TOTAL = 8;

const OPENING_WITHOUT_SALES: Record<string, number> = {
  "device/register": 1,
  "goal/list": 1,
  "inventory/listBalances": 1,
  "offline/issueLease": 1,
  "organization/listMine": 1,
  "report/dailySales": 1,
  "report/periodSummary": 2,
  "sale/list": 1,
};

const OPENING_WITHOUT_SALES_TOTAL = 9;

const HEATMAP_CHUNK = "**/assets/heatmap-*.js";

/**
 * A linha do plano no fim do Início (corte aviso-limite-do-plano, item 2): "Você usa N de 50 variantes no plano Free."
 * depois de Mais vendidos, sem cartão, lida uma vez ao abrir só para o dono com o autosserviço ligado. A leitura do
 * plano que o shell faz sozinho fica fresca (guardada no início), para a conta ser só a do Início.
 */
const PLAN_LINE = "[data-near-limit]";

const PLAN_REGIONS = [
  "Vendas hoje",
  "Vendas em outubro",
  "Vendas por dia",
  "Ritmo de vendas",
  "Mais vendidos do mês",
] as const;

interface PlanServer {
  answered: number;
  gate: Promise<void> | null;
  refuse: boolean;
  reads: number;
  state: string;
  use: { images: number; variants: number };
}

const newPlanServer = (variants: number, images = 0): PlanServer => ({
  answered: 0,
  gate: null,
  refuse: false,
  reads: 0,
  state: "free",
  use: { images, variants },
});

const planView = (plan: PlanServer) => ({
  accessEndsAt: plan.state === "free" ? null : "2026-11-24T03:00:00.000Z",
  cycleMonths: plan.state === "free" ? null : 1,
  kept: { historyMonths: 3, products: 50, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: plan.state === "free" ? null : "card",
  nextCharge: null,
  offer: { methods: ["card"], prices: [{ amount: "24.90", cycleMonths: 1 }] },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: plan.state,
  trialAvailable: false,
  usage: { goals: 0, ...plan.use },
});

async function openHomeWithPlan(
  page: Page,
  server: FakeServer,
  plan: PlanServer,
  options: {
    offlineAtOpen?: boolean;
    role?: string;
    selfService?: boolean;
    waitForBlocks?: boolean;
  } = {}
) {
  if (options.offlineAtOpen) {
    await page.addInitScript(() => {
      Object.defineProperty(window, "polarisOffline", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => !("polarisOffline" in window),
      });
    });
  }
  const notice = JSON.stringify({
    accessEndsAt: null,
    nextChargeOn: null,
    organizationId: ORGANIZATION_ID,
    readAt: NOON,
    state: "free",
  });
  await page.addInitScript((value) => {
    window.sessionStorage.setItem("polaris.billing.planNotice", value);
  }, notice);
  server.now = NOON;
  await page.clock.install({ time: new Date(NOON) });
  await serve(page, server);
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(
      json({
        billingSelfService: options.selfService ?? true,
        organizations: [
          { ...server.organization, role: options.role ?? "owner" },
        ],
      })
    )
  );
  await page.route("**/rpc/billing/readPlan", async (route) => {
    plan.reads += 1;
    await plan.gate;
    await (plan.refuse
      ? route.fulfill(failure("FORBIDDEN", 403))
      : route.fulfill(json(planView(plan))));
    plan.answered += 1;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible({ timeout: 20_000 });
  if (options.role === undefined && options.waitForBlocks !== false) {
    await expect(region(page, "Mais vendidos do mês")).toBeVisible();
  }
}

async function planRegionPlaces(page: Page) {
  await settled(page);
  const places: Record<string, Place> = {};
  for (const name of PLAN_REGIONS) {
    // biome-ignore lint/performance/noAwaitInLoops: one region at a time, in the order of the page
    places[name] = await placeOf(region(page, name));
  }
  return places;
}

function expectSameRegions(
  after: Record<string, Place>,
  before: Record<string, Place>,
  when: string
) {
  for (const name of PLAN_REGIONS) {
    expect(after[name]?.top, `${when}: topo de ${name}`).toBeCloseTo(
      before[name]?.top ?? Number.NaN,
      0
    );
    expect(after[name]?.height, `${when}: altura de ${name}`).toBeCloseTo(
      before[name]?.height ?? Number.NaN,
      0
    );
  }
}

const PLAN_VIEWPORTS = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;

test.describe("a linha do plano no fim do Início (item 2 do aviso de limite)", () => {
  for (const viewport of PLAN_VIEWPORTS) {
    test(`a ${viewport.width} px a linha chega depois da leitura, no fim, e nada acima dela se move`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const plan = newPlanServer(47);
      let release: () => void = () => undefined;
      plan.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await openHomeWithPlan(page, new FakeServer(SOLD), plan);
      await expect(page.locator(PLAN_LINE)).toHaveCount(0);
      const before = await planRegionPlaces(page);
      const pageHeight = await page.evaluate(
        () => document.documentElement.scrollHeight
      );
      release();
      const line = page.locator(PLAN_LINE);
      await expect(line).toHaveText(
        "Você usa 47 de 50 variantes no plano Free. Conhecer o Pro"
      );
      expectSameRegions(await planRegionPlaces(page), before, "depois");
      const ranking = await placeOf(region(page, "Mais vendidos do mês"));
      const lineBox = await placeOf(line);
      expect(lineBox.top).toBeGreaterThanOrEqual(
        ranking.top + ranking.height - 1
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight)
      ).toBeGreaterThan(pageHeight);
      await expect(line).not.toHaveAttribute("role", "alert");
      await expect(
        page.getByRole("link", { exact: true, name: "Conhecer o Pro" })
      ).toHaveAttribute("href", "/configuracoes?aba=assinatura");
    });

    test(`a ${viewport.width} px a grade é a mesma com a linha e sem ela`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const plan = newPlanServer(10);
      await openHomeWithPlan(page, new FakeServer(SOLD), plan);
      await expect.poll(() => plan.reads).toBe(1);
      await expect(page.locator(PLAN_LINE)).toHaveCount(0);
      const without = await planRegionPlaces(page);
      plan.use = { images: 0, variants: 50 };
      await page.reload();
      await expect(page.locator(PLAN_LINE)).toHaveText(
        "Você chegou ao limite de 50 variantes do plano Free. Conhecer o Pro"
      );
      expectSameRegions(await planRegionPlaces(page), without, "no limite");
    });
  }

  test("o Início lê o plano uma vez por abertura, nem por foco nem por intervalo", async ({
    page,
  }) => {
    const plan = newPlanServer(0, 46);
    await openHomeWithPlan(page, new FakeServer(SOLD), plan);
    await expect(page.locator(PLAN_LINE)).toHaveText(
      "Você usa 46 de 50 imagens no plano Free. Conhecer o Pro"
    );
    await readsEnded(page);
    expect(plan.reads).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await readsEnded(page);
    await page.clock.runFor(4 * 60_000);
    await readsEnded(page);
    expect(plan.reads).toBe(1);
    await page.reload();
    await expect(page.locator(PLAN_LINE)).toBeVisible();
    expect(plan.reads).toBe(2);
  });

  test("sem conexão a linha some e nada é lido; a conexão de volta não lê de novo nem traz o número velho", async ({
    page,
  }) => {
    const plan = newPlanServer(47);
    await openHomeWithPlan(page, new FakeServer(SOLD), plan);
    await expect(page.locator(PLAN_LINE)).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.locator(PLAN_LINE)).toHaveCount(0);
    await page.context().setOffline(false);
    await readsEnded(page);
    await expect(page.locator(PLAN_LINE)).toHaveCount(0);
    expect(plan.reads).toBe(1);
  });

  test("aberto já sem conexão: sem linha e sem leitura do plano; a conexão que chega lê e traz a linha", async ({
    page,
  }) => {
    const plan = newPlanServer(47);
    await openHomeWithPlan(page, new FakeServer(SOLD), plan, {
      offlineAtOpen: true,
      waitForBlocks: false,
    });
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await readsEnded(page);
    await expect(page.locator(PLAN_LINE)).toHaveCount(0);
    expect(plan.reads).toBe(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(window, "polarisOffline");
      window.dispatchEvent(new Event("online"));
    });
    await expect(page.locator(PLAN_LINE)).toHaveText(
      "Você usa 47 de 50 variantes no plano Free. Conhecer o Pro",
      { timeout: 15_000 }
    );
    expect(plan.reads).toBe(1);
  });

  for (const held of ["report/periodSummary", "goal/list"] as const) {
    test(`o plano responde antes ${held === "goal/list" ? "da meta" : "dos cartões"}: a linha só aparece depois que eles carregam`, async ({
      page,
    }) => {
      const server = new FakeServer(SOLD);
      let release: () => void = () => undefined;
      server.held.set(
        held,
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      const plan = newPlanServer(47);
      await openHomeWithPlan(page, server, plan, { waitForBlocks: false });
      await expect.poll(() => plan.answered).toBe(1);
      await settled(page);
      await expect(page.locator(PLAN_LINE)).toHaveCount(0);
      release();
      await expect(region(page, "Mais vendidos do mês")).toBeVisible();
      await expect(page.locator(PLAN_LINE)).toHaveText(
        "Você usa 47 de 50 variantes no plano Free. Conhecer o Pro"
      );
      expect(plan.reads).toBe(1);
    });
  }

  test("a recusa do plano, o lojista sem a cobrança, o autosserviço desligado e o Pro: nenhuma linha e nenhum erro", async ({
    browser,
  }) => {
    const cases: Array<{
      expectedReads: number;
      name: string;
      options?: { role?: string; selfService?: boolean };
      plan: PlanServer;
    }> = [
      {
        expectedReads: 1,
        name: "recusa",
        plan: { ...newPlanServer(50), refuse: true },
      },
      {
        expectedReads: 0,
        name: "sem a cobrança",
        options: { role: "manager" },
        plan: newPlanServer(50),
      },
      {
        expectedReads: 0,
        name: "autosserviço desligado",
        options: { selfService: false },
        plan: newPlanServer(50),
      },
      {
        expectedReads: 1,
        name: "Pro",
        plan: { ...newPlanServer(50), state: "active" },
      },
    ];
    for (const item of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one store at a time, each in a context of its own
      const context = await browser.newContext();
      const page = await context.newPage();
      await openHomeWithPlan(
        page,
        new FakeServer(SOLD),
        item.plan,
        item.options
      );
      await settled(page);
      expect(item.plan.reads, item.name).toBe(item.expectedReads);
      await expect(page.locator(PLAN_LINE), item.name).toHaveCount(0);
      await expect(
        page.getByText("Não foi possível", { exact: false }),
        item.name
      ).toHaveCount(0);
      await context.close();
    }
  });
});
