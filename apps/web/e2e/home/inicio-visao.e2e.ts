/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  choosePeriod,
  DEVICE,
  FakeServer,
  goal,
  json,
  NOON,
  newSale,
  ORGANIZATION_ID,
  openHome,
  openWithCopy,
  PRODUCT,
  periodButton,
  periodCalls,
  RETURN_REFRESH_MS,
  readsEnded,
  region,
  SALES_PATH,
  type Scenario,
  SIZES,
  SOLD,
  serve,
  TYPE_DATES,
} from "./shared";

/** The link opens the Metas tab and the address keeps it: `aba=metas`, and no `meta=nova` (corte resultado-v2, AC-13). */
const DASHBOARD_GOALS_PATH = /\/dashboard\?aba=metas$/;

const SHIRT = /Camiseta básica/;

const PRODUCT_LINK =
  /\/products\?produto=0199c2d0-0000-7000-8000-0000000000b1$/;

/**
 * The estimate of the goal of `23/10` (v7 § 3 item 9): R$ 2.670,60 measured, plus the 7 whole days before today (16 to
 * `22/10`: R$ 1.840,00 + R$ 420,50 = R$ 2.260,50) × 8 days left ÷ 7 = R$ 2.583,428… → R$ 2.583,43 (half-up, once), so
 * R$ 5.254,03 on the 31st. Over the target of R$ 5.000,00 the phrase says the day the rhythm crosses it (the 7th day
 * would give R$ 4.931,10: the 31st, the last one, is the first above), and under a target of R$ 6.000,00 where it gets.
 */
const GOAL_PROJECTION = "No ritmo atual, a meta deve ser batida até 31/10.";

const GOAL_PROJECTION_SHORT =
  "No ritmo atual, deve chegar a R$ 5.254,03 em 31/10.";

const GOAL_PROJECTION_NO_SALES = "Sem vendas nos últimos 7 dias para estimar.";

/** The foot of the menu: in the sidebar from 760 px, in "Mais" below it. */
async function openMenuFoot(page: Page) {
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  if (await more.isVisible()) {
    await more.click();
  }
}

/** "Mais" is a modal dialog: the page behind it waits for it to close. */
async function closeMenuFoot(page: Page) {
  const panel = page.getByRole("dialog", { name: "Mais" });
  if (await panel.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
}

test.describe("loja com venda", () => {
  test("mostra Hoje, o mês pelo nome, a meta, a atenção, os mais vendidos e o gráfico, na ordem do AC-4 (360 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer({
      ...SOLD,
      goals: [
        goal({}),
        goal({
          endsOn: "2026-12-31",
          id: "0199c2d0-0000-7000-8000-000000000c02",
          name: "Meta do ano",
        }),
      ],
    });
    await openHome(page, server);

    await expect(newSale(page)).toHaveAttribute("href", "/sales");
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();

    // the KPI cards (v7 § 3): Friday `23/10` against the mean of the 4 Fridays before it (only `02/10` sold, R$ 80,00)
    const today = region(page, "Vendas hoje");
    await expect(today).toContainText("R$ 320,10");
    await expect(today).toContainText("16,0×2 vendas");
    await expect(today).not.toContainText("vs. média");
    // no date at rest: the title says it is today
    await expect(today.locator("[data-kpi-date]")).toHaveCount(0);
    // +1.500,5% is said as a multiple from +1.000% up: seen "16,0×", heard "subiu para 16,0 vezes o valor anterior"
    await expect(
      today.locator("[data-kpi-delta=up] [data-kpi-delta-text]")
    ).toHaveText("16,0×");
    await expect(today.locator("[data-kpi-delta=up]")).toHaveAttribute(
      "aria-label",
      "subiu para 16,0 vezes o valor anterior em relação à média das sextas"
    );
    // the sparkline is a reinforcement: hidden from the screen reader, with no axis; the range is its keyboard
    await expect(
      today.locator("[data-kpi-spark] [aria-hidden=true] svg")
    ).toHaveCount(1);
    await expect(today.locator("svg text")).toHaveCount(0);
    await expect(today.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Hoje: R$ 320,10"
    );

    // 1 to 23 October against 1 to 23 September: R$ 2.660,60 against R$ 170,00
    const month = region(page, "Vendas em outubro");
    await expect(month).toContainText("R$ 2.660,60");
    await expect(page.locator("[data-kpi-group]")).toHaveCount(0);
    await expect(month.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(
      month.locator("[data-kpi-delta=up] [data-kpi-delta-text]")
    ).toHaveText("15,7×");
    await expect(month.locator("[data-kpi-delta=up]")).toHaveAttribute(
      "aria-label",
      "subiu para 15,7 vezes o valor anterior em relação a 1 a 23/09"
    );
    await expect(month).toContainText("12 vendas");

    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    // this server sends no result of the day: no sparkline, no chip and no sum of the known days (AC-9)
    await expect(result.locator("[data-kpi-date]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-spark]")).toHaveCount(0);
    await expect(result.locator("[data-kpi-delta]")).toHaveCount(0);
    await expect(result.getByRole("link")).toHaveAttribute(
      "href",
      "/dashboard"
    );

    const ticket = region(page, "Ticket médio");
    await expect(ticket).toContainText("R$ 221,72");
    // nothing under the number: what it is and what it compares with are in the (i) and in the name of the chip
    await expect(ticket).not.toContainText("Média por venda");
    await expect(ticket.locator("[data-kpi-delta]")).toHaveCount(1);

    const meta = region(page, "Meta");
    await expect(meta).toContainText("Meta de outubro");
    // the store's today is `23/10`: 8 days after it up to the 31st
    await expect(meta).toContainText("1 a 31/10 · faltam 8 dias");
    // the ring (v7 § 3 item 9): an image that says it in words, the drawing of Bklit UI hidden inside it
    const ring = meta.getByRole("img");
    await expect(ring).toHaveAttribute(
      "aria-label",
      "53,4% da meta: R$ 2.670,60 de R$ 5.000,00. Atrasada: o esperado até hoje era 71%."
    );
    await expect(ring).toContainText("53,4%da meta");
    await expect(
      ring.locator("[data-ring-chart] svg:not([data-ring-marker])")
    ).toHaveAttribute("aria-hidden", "true");
    await expect(ring.locator("[data-ring-marker]")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(meta).toContainText("R$ 2.670,60de R$ 5.000,00");
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION
    );
    await expect(
      meta.getByRole("link", { name: "Ver as outras" })
    ).toHaveAttribute("href", "/dashboard?meta=lista");

    const attention = region(page, "Precisa de ação");
    await expect(attention.getByRole("link")).toHaveText([
      "1 variante sem custoInforme para as próximas vendas.",
      "3 variantes sem saldo",
    ]);
    await expect(attention.getByRole("link").first()).toHaveAttribute(
      "href",
      "/inventory?filtro=sem-custo"
    );
    await expect(attention.getByRole("link").last()).toHaveAttribute(
      "href",
      "/inventory?filtro=sem-saldo"
    );

    const top = region(page, "Mais vendidos do mês");
    await expect(top.getByRole("link")).toHaveCount(1);
    await expect(top.getByRole("link", { name: SHIRT })).toHaveAttribute(
      "href",
      `/products?produto=${PRODUCT}`
    );
    // a deleted product is listed without a link
    await expect(top).toContainText("Boné antigo");

    const chart = region(page, "Vendas por dia");
    await expect(chart.getByRole("tab")).toHaveCount(0);
    await expect(chart).toContainText("R$ 2.660,60");
    // the period it adds up (the month to today), and the peak written once, in the drawing, with its date
    await expect(chart).toContainText("1 a 23/10");
    await expect(chart).not.toContainText("Melhor dia");
    await expect(chart.locator("[data-chart-value-label]")).toHaveText(
      "18/10 · R$ 1.840,00"
    );
    await expect(chart.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Vendas líquidas por dia, de 1 a 23/10: R$ 2.660,60 no total. A tabela dia a dia está no fim deste bloco."
    );
    await expect(
      chart.getByRole("button", { name: "Ver os números" })
    ).toHaveCount(0);
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("row").nth(18)).toContainText(
      "18/10/2026R$ 1.840,00"
    );

    // the order of the parts at 360 px (AC-4), and nothing scrolls sideways
    const names = await page
      .locator('main [role="region"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector("h2")?.textContent)
      );
    expect(names).toEqual([
      "Precisa de ação",
      "Vendas hoje",
      "Vendas em outubro",
      "Resultado estimado",
      "Ticket médio",
      "Meta",
      "Vendas por dia",
      "Ritmo de vendas",
      "Mais vendidos do mês",
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("a 1280 px Nova venda, Hoje e o mês ficam acima da dobra: Hoje numa linha própria e os três do mês numa faixa de três colunas", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    for (const target of [
      newSale(page),
      region(page, "Vendas hoje"),
      region(page, "Vendas em outubro"),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one box at a time
      const box = await target.boundingBox();
      expect((box?.y ?? 900) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
    }
    const today = await region(page, "Vendas hoje").boundingBox();
    const month = await region(page, "Vendas em outubro").boundingBox();
    const result = await region(page, "Resultado estimado").boundingBox();
    const ticket = await region(page, "Ticket médio").boundingBox();
    expect((month?.y ?? 0) >= (today?.y ?? 0) + (today?.height ?? 0)).toBe(
      true
    );
    expect(today?.x).toBe(month?.x);
    expect(
      Math.abs(
        (today?.width ?? 0) -
          ((ticket?.x ?? 0) + (ticket?.width ?? 0) - (month?.x ?? 0))
      )
    ).toBeLessThanOrEqual(1);
    expect(result?.x ?? 0).toBeGreaterThan(
      (month?.x ?? 0) + (month?.width ?? 0) - 1
    );
    expect(ticket?.x ?? 0).toBeGreaterThan(
      (result?.x ?? 0) + (result?.width ?? 0) - 1
    );
    expect(result?.y).toBe(month?.y);
    expect(ticket?.y).toBe(month?.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("Nova venda leva à Venda num toque (AC-2), e a barra mantém Vender a um toque", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    await newSale(page).click();
    await page.waitForURL(SALES_PATH);
    await expect(
      page.getByRole("heading", { exact: true, name: "Nova venda" })
    ).toBeVisible();
    await page.goBack();
    await page
      .getByRole("navigation", { exact: true, name: "Destinos" })
      .getByRole("link", { name: "Vender" })
      .click();
    await page.waitForURL(SALES_PATH);
  });

  for (const width of [360, 320]) {
    test(`a linha da atenção quebra o texto em vez de cortá-lo, com a seta centrada (${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 740, width });
      await openHome(page, new FakeServer(SOLD));
      const link = region(page, "Precisa de ação").getByRole("link").first();
      await expect(link).toContainText("Informe para as próximas vendas.");
      const measure = await link.evaluate((anchor) => {
        const text = anchor.querySelector<HTMLElement>("[data-attention-text]");
        const arrow = anchor.querySelector("svg");
        if (!(text && arrow)) {
          throw new Error("a linha sem texto ou sem seta");
        }
        const line = Number.parseFloat(getComputedStyle(text).lineHeight);
        const box = anchor.getBoundingClientRect();
        const mark = arrow.getBoundingClientRect();
        return {
          arrowOffset: Math.abs(
            mark.top + mark.height / 2 - (box.top + box.height / 2)
          ),
          cut: text.scrollWidth > text.clientWidth,
          ellipsis: getComputedStyle(text).textOverflow,
          lines: Math.round(text.getBoundingClientRect().height / line),
          overflowsPage:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      expect(measure.ellipsis).toBe("clip");
      expect(measure.cut).toBe(false);
      expect(measure.lines).toBeGreaterThanOrEqual(2);
      expect(measure.arrowOffset).toBeLessThanOrEqual(1);
      expect(measure.overflowsPage).toBe(false);
    });
  }

  test("vender e voltar: o Hoje e a série já trazem a venda, sem recarregar (§ 5.1)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer({ ...SOLD, days: { ...SOLD.days } });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await newSale(page).click();
    await page.waitForURL(SALES_PATH);
    const before = periodCalls(server).length;
    // the sale confirmed on /sales: the server now counts it in today
    server.scenario.days["2026-10-23"] = [52_010, 3];
    await page
      .getByRole("navigation", { exact: true, name: "Destinos" })
      .getByRole("link", { name: "Início" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Início" })
    ).toBeVisible();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 520,10");
    await expect(region(page, "Vendas hoje")).toContainText("3 vendas");
    expect(periodCalls(server).length).toBeGreaterThan(before);
  });

  test("o gráfico deixa a página rolar na vertical: nenhum touch-action 'none' da caixa do gráfico até a página (pan-y)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const chart = region(page, "Vendas por dia");
    const area = chart.locator("[data-chart-area]");
    await expect(area.locator("svg").first()).toBeVisible();

    // the box and the drawing of the chart ask for the horizontal drag only, so a finger that starts on the chart still
    // scrolls the page: a "none" anywhere between the drawing and the document takes the vertical gesture away
    const { inside, above } = await area.evaluate((node) => {
      const value = (element: Element) => getComputedStyle(element).touchAction;
      const chain: string[] = [];
      for (
        let element: Element | null = node;
        element;
        element = element.parentElement
      ) {
        chain.push(value(element));
      }
      return {
        above: chain,
        inside: [...node.querySelectorAll("*")]
          .map(value)
          .filter((touchAction) => touchAction !== "auto"),
      };
    });
    expect(inside.length).toBeGreaterThan(1);
    expect(new Set(inside)).toEqual(new Set(["pan-y"]));
    expect(above).not.toContain("none");
  });

  test("o gráfico desenha o mês até hoje, um ponto por dia, sem as abas 7 e 30 dias", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    const chart = region(page, "Vendas por dia");
    await expect(chart.locator("[data-chart-area] svg").first()).toBeVisible();
    await expect(chart.locator('input[type="range"]')).toHaveAttribute(
      "max",
      "22"
    );
    await expect(chart.getByRole("row")).toHaveCount(24);
    await expect(chart.getByRole("tab")).toHaveCount(0);
  });
});

test.describe("o período do Início (cartões do mês, Vendas por dia e Mais vendidos)", () => {
  test("Mês passado muda os três cartões do mês, o gráfico e o ranking; Hoje e o Ritmo ficam; voltar a Este mês não lê de novo", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(periodButton(page)).toContainText("01/10 a 31/10");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    const today = await region(page, "Vendas hoje").innerText();
    const rhythm = await region(page, "Ritmo de vendas")
      .getByRole("img")
      .getAttribute("aria-label");

    await choosePeriod(page, "Mês passado");
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    const september = region(page, "Vendas em setembro");
    await expect(september).toContainText("R$ 170,00");
    await expect(region(page, "Resultado estimado")).toBeVisible();
    await expect(region(page, "Ticket médio")).toBeVisible();
    await expect(region(page, "Vendas por dia")).toContainText("1 a 30/09");
    await expect(region(page, "Vendas por dia")).toContainText("R$ 170,00");
    await expect(region(page, "Mais vendidos de setembro")).toBeVisible();
    await expect(region(page, "Mais vendidos do mês")).toHaveCount(0);
    // what is always "now" does not move
    expect(await region(page, "Vendas hoje").innerText()).toBe(today);
    expect(
      await region(page, "Ritmo de vendas")
        .getByRole("img")
        .getAttribute("aria-label")
    ).toBe(rhythm);
    expect(
      periodCalls(server).some(
        (call) =>
          call.input.from === "2026-09-01" &&
          call.input.to === "2026-09-30" &&
          call.input.topProducts === 5
      )
    ).toBe(true);

    const reads = periodCalls(server).length;
    await choosePeriod(page, "Este mês");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    await expect(region(page, "Mais vendidos do mês")).toBeVisible();
    expect(periodCalls(server).length).toBe(reads);
  });

  test("Este ano vem por mês acima de 62 dias, e o período digitado vale", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    await choosePeriod(page, "Este ano");
    await expect(periodButton(page)).toContainText("01/01 a 23/10");
    const chart = region(page, "Vendas por mês");
    await expect(chart).toBeVisible();
    await expect(chart.getByRole("row")).toHaveCount(11);
    await expect(region(page, "Mais vendidos do período")).toBeVisible();
  });

  test("escolher o período pelo teclado deixa o foco no botão do período, ao carregar e ao voltar a Este mês", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    const shortcut = (name: string) =>
      page
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name });
    for (const [name, text] of [
      ["Mês passado", "01/09 a 30/09"],
      ["Este mês", "01/10 a 31/10"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one choice after the other
      await periodButton(page).focus();
      await page.keyboard.press("Enter");
      await shortcut(name).focus();
      await page.keyboard.press("Enter");
      await expect(periodButton(page)).toContainText(text);
      await expect(
        region(
          page,
          name === "Este mês" ? "Vendas em outubro" : "Vendas em setembro"
        )
      ).toContainText("R$");
      await expect(periodButton(page)).toBeFocused();
    }
  });

  test("o cartão de Vendas diz 'do período' quando o período não é um mês inteiro, e o mês inteiro diz 'em setembro'", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(page, new FakeServer(SOLD));
    await choosePeriod(page, "Este ano");
    await expect(periodButton(page)).toContainText("01/01 a 23/10");
    await expect(region(page, "Vendas do período")).toBeVisible();
    await choosePeriod(page, "Últimos 30 dias");
    await expect(periodButton(page)).not.toContainText("01/01");
    await expect(region(page, "Vendas do período")).toBeVisible();
    await expect(region(page, "Vendas em o período")).toHaveCount(0);
    await choosePeriod(page, "Mês passado");
    await expect(region(page, "Vendas em setembro")).toBeVisible();
    await expect(region(page, "Vendas do período")).toHaveCount(0);
  });

  test("um período que falha diz o erro no lugar dos cartões do mês e Tentar novamente lê de novo; Hoje segue", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    server.broken.set("report/periodSummary", "500");
    await choosePeriod(page, "Mês passado");
    await expect(page.getByRole("alert").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    server.broken.delete("report/periodSummary");
    await page
      .getByRole("button", { name: "Tentar novamente" })
      .first()
      .click();
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
  });

  test("loja que nunca vendeu (primeiros passos) não tem o seletor: não há números do período a mostrar", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openHome(
      page,
      new FakeServer({ ...SOLD, days: {}, everSold: false })
    );
    await expect(region(page, "Primeiros passos")).toBeVisible();
    await expect(periodButton(page)).toHaveCount(0);
  });

  test("a releitura do período que falha deixa os números na tela e diz que não atualizou, com Tentar novamente", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await choosePeriod(page, "Mês passado");
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
    server.broken.set("report/periodSummary", "500");
    await page.getByRole("button", { name: "Atualizar" }).first().click();
    const retry = page.locator("[data-home-period]").getByRole("button", {
      name: "Tentar novamente",
    });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-home-period]")).toContainText(
      "Mostrando os números de"
    );
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
    server.broken.delete("report/periodSummary");
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(region(page, "Vendas em setembro")).toContainText("R$ 170,00");
  });

  test("sem conexão só Este mês e Mês passado abrem: os outros atalhos ficam apagados com o motivo, e o calendário e os campos não valem", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    await openWithCopy(page, new FakeServer(SOLD));
    // the chunk of the calendar comes with the first opening; the offline panel is the second
    await periodButton(page).click();
    await expect(
      page.locator('[role="grid"] button[data-day]').first()
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.context().setOffline(true);
    const reason = "Sem conexão: só este mês e o anterior.";
    const beside = page.locator("[data-home-period]").getByText(reason);
    await expect(beside).toBeVisible();
    await periodButton(page).click();
    const shortcuts = page.getByRole("group", { name: "Atalhos do período" });
    const off = ["Últimos 30 dias", "Este ano"].map((name) =>
      shortcuts.getByRole("button", { exact: true, name })
    );
    const on = ["Este mês", "Mês passado"].map((name) =>
      shortcuts.getByRole("button", { exact: true, name })
    );
    await Promise.all([
      ...off.map(async (button) => {
        await expect(button).toHaveAttribute("aria-disabled", "true");
        await expect(button).toHaveAccessibleDescription(reason);
      }),
      ...on.map((button) =>
        expect(button).not.toHaveAttribute("aria-disabled", "true")
      ),
    ]);
    await expect(page.getByRole("button", { name: TYPE_DATES })).toHaveCount(0);
    const days = page.locator('[role="grid"] button[data-day]');
    await expect(days.first()).toBeVisible();
    await expect(
      page.locator('[role="grid"] button[data-day]:not([aria-disabled="true"])')
    ).toHaveCount(0);
    await shortcuts
      .getByRole("button", { exact: true, name: "Este ano" })
      .click({ force: true });
    await expect(periodButton(page)).toContainText("01/10 a 31/10");
    await expect(periodButton(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.context().setOffline(false);
    await expect(beside).toBeHidden();
  });
});

/**
 * One command of this device that the server refused (as `sync.push` leaves it), written into the outbox of the runtime
 * that opened with the page, and read again on a reload: the third line of "Precisa de ação".
 */
async function leaveOneRefused(page: Page) {
  await page.evaluate(
    async ({ deviceId, organizationId }) => {
      const names = (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith("polaris-outbox-"));
      for (const name of names) {
        // biome-ignore lint/performance/noAwaitInLoops: one database, the one of this person
        await new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open(name);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const tx = opening.result.transaction(
              ["commands", "meta"],
              "readwrite"
            );
            const at = new Date().toISOString();
            tx.objectStore("commands").put({
              attempts: 1,
              baseVersion: null,
              commandId: crypto.randomUUID(),
              createdAt: at,
              deviceId,
              lastAttemptAt: at,
              lease: "lease",
              organizationId,
              payload: { name: "Bia Souza" },
              rejection: { at, code: "validation_failed" },
              seq: 1,
              status: "rejected",
              type: "customer.create",
            });
            tx.objectStore("meta").put(1, "lastSeq");
            tx.oncomplete = () => {
              opening.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    },
    { deviceId: DEVICE.id, organizationId: ORGANIZATION_ID }
  );
  await page.reload();
}

test.describe("o Início enxuto: a dobra a 360 px e a ajuda de cada bloco", () => {
  test("com três itens de ação, o número de Hoje e o título do mês ficam dentro da janela de 360 × 740 (AC-4)", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openWithCopy(page, new FakeServer(SOLD));
    await leaveOneRefused(page);
    const attention = region(page, "Precisa de ação");
    await expect(attention.getByRole("link")).toHaveCount(3, {
      timeout: 20_000,
    });
    await expect(attention).toContainText("1 registro recusado neste aparelho");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");

    const bottom = async (target: Locator) => {
      const box = await target.first().boundingBox();
      return (box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0);
    };
    expect(
      await bottom(region(page, "Vendas hoje").locator("[data-kpi-value]"))
    ).toBeLessThanOrEqual(740);
    expect(await bottom(periodButton(page))).toBeLessThanOrEqual(740);
    expect(
      await bottom(region(page, "Vendas em outubro").locator("h2"))
    ).toBeLessThanOrEqual(740);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("a 360 px o seletor de período fica entre Hoje e os cartões do mês, e Hoje, o seletor e Vendas cabem na janela", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(SOLD));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const top = async (target: Locator) =>
      (await target.first().boundingBox())?.y ?? Number.NaN;
    const picker = await top(periodButton(page));
    expect(picker).toBeGreaterThan(await top(region(page, "Vendas hoje")));
    expect(picker).toBeLessThan(await top(region(page, "Vendas em outubro")));
    const bottom = async (target: Locator) => {
      const box = await target.first().boundingBox();
      return (box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0);
    };
    expect(await bottom(region(page, "Vendas em outubro"))).toBeLessThanOrEqual(
      740
    );
  });

  test("a altura da página a 360 px com os mesmos três itens de ação", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openWithCopy(page, new FakeServer({ ...SOLD, goals: [goal({})] }));
    await leaveOneRefused(page);
    await expect(region(page, "Precisa de ação").getByRole("link")).toHaveCount(
      3,
      { timeout: 20_000 }
    );
    await expect(
      region(page, "Vendas por dia").locator("svg").first()
    ).toBeVisible();
    const height = await page.evaluate(
      () => document.documentElement.scrollHeight
    );
    testInfo.annotations.push({
      description: `scrollHeight a 360 px: ${height}`,
      type: "altura-da-pagina",
    });
    expect(height).toBeGreaterThan(740);
  });

  const HELPS: readonly [string, string][] = [
    [
      "Vendas hoje",
      "Vendas líquidas de hoje. Compara com a média das 4 sextas-feiras anteriores.",
    ],
    [
      "Vendas em outubro",
      "Vendas líquidas de 1 a 23/10. Compara com 1 a 23/09.",
    ],
    [
      "Ticket médio",
      "Vendas líquidas divididas pelo número de vendas, de 1 a 23/10. Compara com 1 a 23/09.",
    ],
    [
      "Resultado estimado",
      "Vendas menos custos, taxas e despesas do mês inteiro; não é lucro líquido nem caixa.",
    ],
    [
      "Meta",
      "Estimativa: a média dos últimos 7 dias repetida até o fim da meta.",
    ],
    [
      "Vendas por dia",
      "Vendas líquidas de cada dia do período. Toque num dia para ver o valor.",
    ],
  ];

  for (const [about, text] of HELPS) {
    test(`o (i) de "${about}" abre pelo teclado, diz o que o número é e devolve o foco ao fechar`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 1280 });
      await openHome(page, new FakeServer({ ...SOLD, goals: [goal({})] }));
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
      const help = page.getByRole("button", {
        exact: true,
        name: `Sobre ${about}`,
      });
      await help.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog");
      await expect(popup).toContainText(text);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(help).toBeFocused();
    });
  }

  test("o sinal de incompleta e os dias sem custo ficam à vista, com o (i) fechado", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(
      page,
      new FakeServer({ ...SOLD, results: { "2026-10-20": null } })
    );
    const result = region(page, "Resultado estimado");
    await expect(result).toContainText("Incompleta");
    await expect(result).toContainText("1 de 23 dias sem custo");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("loja sem venda: o checklist (AC-22, AC-23)", () => {
  const empty = (stock: Scenario["stock"]): Scenario => ({
    days: {},
    everSold: false,
    goals: [],
    soldWithoutCost: 0,
    stock,
  });

  test("sem produto, o próximo passo é cadastrar; Meta e Atenção continuam", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1023 });
    await openHome(
      page,
      new FakeServer(
        empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
      )
    );
    const checklist = region(page, "Primeiros passos");
    await expect(checklist.getByRole("listitem")).toHaveText([
      "Loja criada (feito)",
      "Cadastrar o 1º produtoNome, preço e quantas unidades você tem. Só o nome é obrigatório.Cadastrar à mãoImportar planilha",
      "Fazer a 1ª venda",
    ]);
    await expect(checklist.locator("[data-step-preview]")).toHaveCount(0);
    await expect(checklist.locator("[data-skeleton-art]")).toHaveCount(0);
    await expect(
      checklist.getByRole("heading", { name: "Primeiros passos" })
    ).toBeVisible();
    await expect(checklist).toContainText("1 de 3");
    await expect(checklist.locator("[data-progress-ring]")).toHaveCount(1);
    // no button under the steps repeats the two ways of the step
    await expect(checklist.getByRole("link")).toHaveText([
      "Cadastrar à mão",
      "Importar planilha",
    ]);
    await expect(
      checklist.getByRole("link", { name: "Cadastrar produto" })
    ).toHaveCount(0);
    // the step has its two ways (corte 2.5, T-5): by hand, or the import of a spreadsheet
    const step = checklist.getByRole("listitem").nth(1);
    await expect(
      step.getByRole("link", { name: "Cadastrar à mão" })
    ).toHaveAttribute("href", "/products?novo=1");
    await expect(
      step.getByRole("link", { name: "Importar planilha" })
    ).toHaveAttribute("href", "/products?importar=1");
    // both are buttons (size sm, 28 px with a mouse), not 14 px text links
    const boxes = await Promise.all(
      ["Cadastrar à mão", "Importar planilha"].map((name) =>
        step.getByRole("link", { name }).boundingBox()
      )
    );
    for (const box of boxes) {
      expect(box?.height).toBeGreaterThanOrEqual(28);
    }
    await expect(region(page, "Vendas hoje")).toHaveCount(0);
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(
      region(page, "Meta").getByRole("link", { name: "Definir meta" })
    ).toHaveAttribute("href", "/dashboard?meta=nova");
    // nothing to do: the block is not there, and says nothing about it
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    // the foot of the menu follows the same three steps, linked back to them
    await openMenuFoot(page);
    await expect(
      page.getByRole("link", {
        exact: true,
        name: "Primeiros passos, 1 de 3 concluídos",
      })
    ).toHaveAttribute("href", "/#home-checklist");
  });

  test("cadastrar o 1º produto em Produtos: o pé do menu diz 2 de 3 na hora, e o Início diz o mesmo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const created = {
      archivedAt: null,
      categoryId: null,
      createdAt: "2026-10-23T15:00:00.000Z",
      deletedAt: null,
      description: null,
      id: PRODUCT,
      name: "Bolsa de couro",
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: "2026-10-23T15:00:00.000Z",
      version: 1,
    };
    let registered = false;
    await page.route("**/rpc/product/list", (route) =>
      route.fulfill(json({ products: registered ? [created] : [] }))
    );
    await page.route("**/rpc/category/list", (route) =>
      route.fulfill(json({ categories: [] }))
    );
    await page.route("**/rpc/product/create", (route) => {
      registered = true;
      return route.fulfill(json(created));
    });
    const server = new FakeServer(
      empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
    );
    await openHome(page, server);
    const checklist = region(page, "Primeiros passos");
    await expect(checklist).toContainText("Cadastrar o 1º produto");
    const foot = (done: number) =>
      page.getByRole("link", {
        exact: true,
        name: `Primeiros passos, ${done} de 3 concluídos`,
      });
    await expect(foot(1)).toBeVisible();
    await checklist.getByRole("link", { name: "Cadastrar à mão" }).click();
    await page.waitForURL("**/products?novo=1");
    await page.getByLabel("Nome do produto").fill("Bolsa de couro");
    await page.getByRole("button", { name: "Cadastrar produto" }).click();
    await expect(page.getByLabel("Nome do produto")).toHaveCount(0);
    // the Início was not opened again: nothing was read, the foot follows the registration
    await expect(foot(2)).toBeVisible();
    await expect(foot(1)).toHaveCount(0);
    server.scenario.stock = {
      all: 1,
      unknownCost: 1,
      withoutStock: 1,
      withStock: 0,
    };
    await page
      .getByRole("link", { exact: true, name: "Início" })
      .first()
      .click();
    await expect(
      region(page, "Primeiros passos").getByRole("listitem").nth(1)
    ).toContainText("Cadastrar o 1º produto (feito)");
    await expect(foot(2)).toBeVisible();
  });

  test("produto sem quantidade: 'Dar entrada no estoque' abre o painel do produto", async ({
    page,
  }) => {
    await openHome(
      page,
      new FakeServer(
        empty({ all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 })
      )
    );
    const checklist = region(page, "Primeiros passos");
    await expect(checklist).toContainText("Cadastrar o 1º produto (feito)");
    await openMenuFoot(page);
    await expect(
      page.getByRole("link", {
        exact: true,
        name: "Primeiros passos, 2 de 3 concluídos",
      })
    ).toBeVisible();
    await closeMenuFoot(page);
    const step = checklist.getByRole("link", {
      name: "Dar entrada no estoque",
    });
    await expect(step).toHaveAttribute("href", `/products?produto=${PRODUCT}`);
    await page.route("**/rpc/product/**", (route) =>
      route.abort("internetdisconnected")
    );
    await step.click();
    await page.waitForURL(PRODUCT_LINK);
  });

  test("o link do pé do menu leva ao bloco, vindo de outra tela e de Mais no celular", async ({
    page,
  }) => {
    // short enough that the block starts below the fold
    await page.setViewportSize({ height: 340, width: 360 });
    const server = new FakeServer(
      empty({ all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 })
    );
    server.now = NOON;
    await page.clock.install({ time: new Date(NOON) });
    await serve(page, server);
    // a full load of the address: the block comes after the reads, so the page scrolls to it by itself
    await page.goto("/#home-checklist");
    const title = page.getByRole("heading", {
      exact: true,
      name: "Primeiros passos",
    });
    await expect(title).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(title).not.toBeInViewport();
    // on the Início itself, from "Mais": the panel closes and the page goes to the block
    await page.getByRole("button", { exact: true, name: "Mais" }).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await panel
      .getByRole("link", {
        exact: true,
        name: "Primeiros passos, 2 de 3 concluídos",
      })
      .click();
    await expect(panel).toBeHidden();
    await expect(title).toBeInViewport();
  });

  const PREVIEW_STATES = [
    [
      "sem produto",
      { all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 },
      "products",
      ["/products?novo=1", "/products?importar=1"],
      "Nome, preço e quantas unidades você tem. Só o nome é obrigatório.",
    ],
    [
      "com produto, sem saldo",
      { all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 },
      "products",
      [`/products?produto=${PRODUCT}`],
      "Diga quantas unidades você tem para poder vender.",
    ],
    [
      "com produto e saldo",
      { all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 },
      "sale",
      ["/sales"],
      "Escolha o produto, o pagamento e confirme.",
    ],
  ] as const;

  async function checkPreviewState(
    page: Page,
    [state, stock, art, links, sentence]: (typeof PREVIEW_STATES)[number]
  ) {
    await page.setViewportSize({ height: 800, width: 1024 });
    await openHome(page, new FakeServer(empty({ ...stock })));
    const checklist = region(page, "Primeiros passos");
    const preview = checklist.locator("[data-step-preview]");
    await expect(preview, state).toHaveCount(1);
    const steps = checklist.getByRole("list");
    const [stepsBox, previewBox] = await Promise.all([
      steps.boundingBox(),
      preview.boundingBox(),
    ]);
    expect(previewBox?.x ?? 0, state).toBeGreaterThanOrEqual(
      (stepsBox?.x ?? 0) + (stepsBox?.width ?? 0)
    );
    await expect(preview.locator(`[data-skeleton-art="${art}"]`)).toBeVisible();
    await expect(preview.getByText(sentence)).toBeVisible();
    await expect(checklist.getByText(sentence)).toHaveCount(1);
    expect(
      await checklist
        .getByRole("link")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
      state
    ).toEqual([...links]);
    await Promise.all(
      links.flatMap((link) => [
        expect(
          preview.locator(`a[href="${link}"]`),
          `${state}: ${link}`
        ).toHaveCount(1),
        expect(
          steps.locator(`a[href="${link}"]`),
          `${state}: ${link} fora dos passos`
        ).toHaveCount(0),
      ])
    );
    const decoration = preview.locator("svg[data-skeleton-art]");
    await expect(decoration).toHaveAttribute("aria-hidden", "true");
    await expect(preview.locator(".animate-pulse")).toHaveCount(0);
    const height = (await checklist.boundingBox())?.height ?? 0;
    await page.setViewportSize({ height: 800, width: 1023 });
    await expect(preview, state).toHaveCount(0);
    await expect(checklist.locator("[data-skeleton-art]")).toHaveCount(0);
    await expect(checklist.getByText(sentence)).toHaveCount(1);
    await expect(checklist.getByRole("link")).toHaveCount(links.length);
    return height;
  }

  test("a partir de 1024 px, passos e prévia ficam lado a lado, com um só link por destino e a mesma altura nos três passos; abaixo, uma coluna com a frase no passo atual", async ({
    page,
  }) => {
    const [first, second, third] = PREVIEW_STATES;
    const heights = [
      await checkPreviewState(page, first),
      await checkPreviewState(page, second),
      await checkPreviewState(page, third),
    ];
    for (const height of heights) {
      expect(Math.abs(height - (heights[0] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  for (const [width, tolerance] of [
    [360, 30],
    [1023, 30],
    [1024, 1],
    [1280, 1],
  ] as const) {
    test(`o esqueleto dos primeiros passos tem a altura do bloco: ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      const server = new FakeServer(
        empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
      );
      let answer: () => void = () => undefined;
      server.held.set(
        "inventory/listBalances",
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      await openHome(page, server);
      const skeleton = page
        .getByRole("status")
        .filter({ hasText: "Carregando os primeiros passos…" });
      await expect(skeleton).toBeVisible();
      const loading = (await skeleton.boundingBox())?.height ?? 0;
      answer();
      await expect(region(page, "Primeiros passos")).toBeVisible();
      await expect(skeleton).toHaveCount(0);
      const loaded =
        (await region(page, "Primeiros passos").boundingBox())?.height ?? 0;
      expect(Math.abs(loaded - loading)).toBeLessThanOrEqual(tolerance);
    });
  }

  test("a prévia segue o passo atual, não o ponteiro nem o foco", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await openHome(
      page,
      new FakeServer(
        empty({ all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 })
      )
    );
    const checklist = region(page, "Primeiros passos");
    const preview = checklist.locator("[data-step-preview]");
    await expect(preview).toHaveAttribute("data-step-preview", "product");
    const items = checklist.getByRole("listitem");
    await items.nth(2).hover();
    await items.nth(0).hover();
    await expect(preview).toHaveAttribute("data-step-preview", "product");
    await checklist.getByRole("link", { name: "Cadastrar à mão" }).focus();
    await expect(preview).toHaveAttribute("data-step-preview", "product");
    await page.keyboard.press("Tab");
    await expect(
      checklist.getByRole("link", { name: "Importar planilha" })
    ).toBeFocused();
  });

  for (const [state, stock, current] of [
    [
      "sem produto, com os dois botões do passo 2",
      { all: 0, unknownCost: 0, withoutStock: 0, withStock: 0 },
      1,
    ],
    [
      "com produto, sem os botões",
      { all: 1, unknownCost: 1, withoutStock: 1, withStock: 0 },
      2,
    ],
  ] as const) {
    for (const viewport of [
      { height: 740, width: 360 },
      { height: 800, width: 1280 },
    ]) {
      test(`o passo atual destaca um só item e não muda a altura do bloco: ${state}, ${viewport.width} px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await openHome(page, new FakeServer(empty({ ...stock })));
        const checklist = region(page, "Primeiros passos");
        const items = checklist.getByRole("listitem");
        await expect(items).toHaveCount(3);
        await expect(checklist.locator("[aria-current]")).toHaveCount(1);
        await expect(items.nth(current)).toHaveAttribute(
          "aria-current",
          "step"
        );
        const heights = async () => ({
          block: (await checklist.boundingBox())?.height ?? 0,
          rows: await Promise.all(
            [0, 1, 2].map(
              async (index) =>
                (await items.nth(index).boundingBox())?.height ?? 0
            )
          ),
        });
        const circles = await Promise.all(
          [0, 1, 2].map((index) =>
            items
              .nth(index)
              .locator("span[aria-hidden='true']")
              .first()
              .boundingBox()
          )
        );
        for (const box of circles) {
          expect(box?.width).toBeCloseTo(28, 0);
          expect(box?.width).toBeCloseTo(circles[0]?.width ?? 0, 0);
          expect(box?.height).toBeCloseTo(circles[0]?.height ?? 0, 0);
        }
        const marked = await heights();
        // the same block with the mark of the current step taken off: the mark must not take a pixel of height
        await items.nth(current).evaluate((item) => {
          item.removeAttribute("aria-current");
          const circle = item.querySelector("[aria-hidden='true']");
          circle?.classList.remove(
            "border-mark",
            "bg-mark/10",
            "text-mark-foreground"
          );
        });
        const plain = await heights();
        expect(Math.abs(marked.block - plain.block)).toBeLessThanOrEqual(1);
        for (const index of [0, 1, 2]) {
          expect(
            Math.abs((marked.rows[index] ?? 0) - (plain.rows[index] ?? 0))
          ).toBeLessThanOrEqual(1);
        }
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }

  test("com estoque, o botão vai à Venda", async ({ page }) => {
    await openHome(
      page,
      new FakeServer(
        empty({ all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 })
      )
    );
    await expect(
      region(page, "Primeiros passos").getByRole("link", {
        name: "Fazer a 1ª venda",
      })
    ).toHaveAttribute("href", "/sales");
  });

  test("a loja que já vendeu (mesmo cancelada) não vê o checklist: vê os vazios com a ação", async ({
    page,
  }) => {
    await openHome(
      page,
      new FakeServer({
        ...empty({ all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 }),
        everSold: true,
      })
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    const month = region(page, "Vendas em outubro");
    await expect(month).toContainText("Nenhuma venda ainda");
    await expect(
      month.getByRole("link", { name: "Fazer uma venda" })
    ).toHaveAttribute("href", "/sales");
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await expect(region(page, "Mais vendidos do mês")).toContainText(
      "Sem vendas no período."
    );
    await expect(region(page, "Vendas por dia")).toContainText(
      "Sem vendas no período."
    );
    // never "0%" nor an arrow over nothing
    await expect(page.locator("main")).not.toContainText("0%");
  });
});

test.describe("Vendas hoje sem base de comparação", () => {
  test("hoje sem venda, com as 4 sextas somando zero ou menos, diz que não há média e não promete comparação", async ({
    page,
  }) => {
    const returned: Scenario = {
      ...SOLD,
      days: { "2026-10-02": [5000, 1], "2026-10-09": [-5000, 1] },
    };
    await page.setViewportSize({ height: 740, width: 360 });
    await openHome(page, new FakeServer(returned));
    const today = region(page, "Vendas hoje");
    await expect(today).toContainText("Nenhuma venda ainda");
    await expect(today.locator("[data-kpi-delta]")).toHaveCount(0);

    await page.getByRole("button", { name: "Sobre Vendas hoje" }).click();
    await expect(
      page.getByText(
        "Vendas líquidas de hoje. Sem média das 4 sextas-feiras anteriores para comparar.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Compara com a média");
  });
});

test.describe("meta (AC-10, AC-11)", () => {
  test("a última encerrada nos 7 dias aparece sem ativa; pausada não tem percentual", async ({
    page,
  }) => {
    const server = new FakeServer({
      ...SOLD,
      goals: [
        goal({
          achievedValue: "5200.00",
          endsOn: "2026-10-20",
          progress: null,
          settledAt: "2026-10-21T03:05:00.000Z",
          startsOn: "2026-10-01",
          status: "completed",
        }),
      ],
    });
    await openHome(page, server);
    const meta = region(page, "Meta");
    await expect(meta).toContainText("Meta atingida");
    await expect(meta).toContainText("Chegou a R$ 5.200,00 de R$ 5.000,00.");

    server.scenario = {
      ...SOLD,
      goals: [goal({ paused: true, progress: null })],
    };
    await page.reload();
    await expect(region(page, "Meta")).toContainText(
      "Pausada pelo plano: não é medida"
    );
    await expect(region(page, "Meta")).not.toContainText("%");
  });

  test("o anel da meta: Esconder valores mascara os reais (no texto, na estimativa e no nome do anel) e deixa o percentual; sem meta, o anel tracejado e Definir meta", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openHome(page, server);
    const meta = region(page, "Meta");
    const ring = meta.getByRole("img");
    await expect(
      ring.locator("[data-ring-chart] svg path").first()
    ).toBeAttached();
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(meta).not.toContainText("2.670,60");
    await expect(meta).not.toContainText("5.000,00");
    await expect(meta).not.toContainText("5.254,03");
    // the phrase of "batida" has no amount: only the measured and the target are masked
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION
    );
    await expect(meta.locator("[data-masked-money]")).toHaveCount(2);
    await expect(ring).toHaveAttribute(
      "aria-label",
      "53,4% da meta: valor escondido de valor escondido. Atrasada: o esperado até hoje era 71%."
    );
    // the pace is not a value: the word and the mark stay with the values hidden
    await expect(meta.locator("[data-pace]")).toHaveText("Atrasada");
    await expect(meta.locator("[data-ring-marker]")).toBeAttached();
    await expect(ring).toContainText("53,4%");

    server.scenario = { ...SOLD, goals: [] };
    await page.reload();
    const empty = region(page, "Meta");
    // no goal: the title and the button, no ring; the thin strip of the wide layout has room for the sentence
    await expect(empty.locator("[data-goal-ring]")).toHaveCount(0);
    await expect(
      empty.getByText("Defina quanto quer vender no mês e acompanhe aqui.")
    ).toBeVisible();
    await expect(
      empty.getByRole("link", { name: "Definir meta" })
    ).toHaveAttribute("href", "/dashboard?meta=nova");
    // the card of a phone is the title and the button: the button says what the sentence did
    await page.setViewportSize({ height: 740, width: 360 });
    await expect(
      empty.getByText("Defina quanto quer vender no mês e acompanhe aqui.")
    ).toBeHidden();
  });

  test("a frase da estimativa: abaixo do alvo diz onde chega (e Esconder valores a mascara); sem venda nos 7 dias diz que não há o que estimar", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const short = new FakeServer({
      ...SOLD,
      goals: [goal({ target: "6000.00" })],
    });
    await openHome(page, short);
    const meta = region(page, "Meta");
    await expect(meta.locator("[data-goal-projection]")).toHaveText(
      GOAL_PROJECTION_SHORT
    );
    await page.getByRole("button", { name: "Esconder valores" }).click();
    await expect(meta).not.toContainText("5.254,03");
    await expect(meta.locator("[data-masked-money]")).toHaveCount(3);

    // nothing sold from 16 to `22/10`: a "chega a" equal to what was reached would be no estimate
    const { "2026-10-18": _, "2026-10-20": __, ...quiet } = SOLD.days;
    short.scenario = {
      ...SOLD,
      days: quiet,
      goals: [goal({ target: "6000.00" })],
    };
    await page.reload();
    const none = region(page, "Meta").locator("[data-goal-projection]");
    await expect(none).toHaveText(GOAL_PROJECTION_NO_SALES);
    await expect(none).toHaveAttribute("data-goal-projection", "sem-venda");
  });

  test("'Definir meta' abre o formulário de meta no Resultado", async ({
    page,
  }) => {
    await openHome(page, new FakeServer({ ...SOLD, goals: [] }));
    await region(page, "Meta")
      .getByRole("link", { name: "Definir meta" })
      .click();
    await expect(page.getByLabel("Indicador")).toBeFocused();
    // the link did its work: a reload is the screen as it is, not the form again
    await expect(page).toHaveURL(DASHBOARD_GOALS_PATH);
  });
});

test.describe("erro por bloco (§ 5.2): Nova venda sempre visível e levando à Venda", () => {
  for (const kind of ["500", "429", "unmarked"] as const) {
    test(`números com ${kind}: um alerta no lugar deles, e Tentar novamente`, async ({
      page,
    }) => {
      const server = new FakeServer(SOLD);
      server.broken.set("report/periodSummary", kind);
      await openHome(page, server);
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Não foi possível carregar os números da loja." });
      // a 429 at once; a 500 or no answer after the three tries (~1.5 s and ~4 s between them)
      await expect(alert).toBeVisible({ timeout: 15_000 });
      await expect(newSale(page)).toHaveAttribute("href", "/sales");
      await expect(region(page, "Meta")).toContainText("Meta");
      await expect(region(page, "Vendas hoje")).toHaveCount(0);
      server.broken.delete("report/periodSummary");
      await alert.getByRole("button", { name: "Tentar novamente" }).click();
      await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    });
  }

  test("meta e estoque quebrados: cada um diz o seu, o resto fica", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("goal/list", "500");
    server.broken.set("inventory/listBalances", "500");
    await openHome(page, server);
    await expect(region(page, "Meta")).toContainText(
      "Não foi possível carregar a meta.",
      { timeout: 15_000 }
    );
    await expect(
      page.getByText("Avisos do estoque indisponíveis agora.")
    ).toBeVisible({ timeout: 15_000 });
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    server.broken.delete("goal/list");
    await region(page, "Meta")
      .getByRole("button", { name: "Tentar novamente" })
      .click();
    await expect(
      region(page, "Meta").getByRole("link", { name: "Definir meta" })
    ).toBeVisible();
  });

  test("401: o aviso de sessão do shell, nenhum erro nos blocos", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "401");
    await openHome(page, server);
    await expect(
      page.getByRole("button", { name: "Entrar de novo" })
    ).toBeVisible();
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    await expect(region(page, "Meta")).toHaveCount(0);
    // with no answer about the stock, the block does not say that nothing needs doing
    await expect(region(page, "Precisa de ação")).toHaveCount(0);
    await expect(newSale(page)).toBeVisible();
  });

  test("/rpc lento (10 s): esqueletos com a altura guardada, e Nova venda já na tela", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "slow");
    await openHome(page, server);
    await expect(newSale(page)).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Carregando os números…" })
    ).toBeAttached();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
  });
});

test.describe("atualização (§ 5.1, relógio controlado)", () => {
  test("23:59 → 00:01 na mesma sessão: o Hoje passa ao dia novo sozinho", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    const at2359 = Date.parse("2026-10-24T02:59:00.000Z");
    await openHome(page, server, at2359);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    server.now = at2359 + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(before);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
  });

  test("31/10 → 01/11: o mês e os dois períodos mudam", async ({ page }) => {
    const server = new FakeServer(SOLD);
    const at = Date.parse("2026-11-01T02:59:00.000Z");
    await openHome(page, server, at);
    await expect(region(page, "Vendas em outubro")).toBeVisible();
    server.now = at + 2 * 60_000;
    await page.clock.runFor(2 * 60_000);
    await expect(region(page, "Vendas em novembro")).toBeVisible();
    const asked = periodCalls(server).map(
      (call) => `${call.input.from}..${call.input.to}`
    );
    expect(asked).toContain("2026-11-01..2026-11-30");
    expect(asked).toContain("2026-10-01..2026-10-31");
  });

  test("com o relógio do aparelho errado, o mês é o do servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await page.clock.install({ time: new Date("2026-09-15T15:00:00.000Z") });
    await serve(page, server);
    await page.goto("/");
    await expect(region(page, "Vendas em outubro")).toBeVisible({
      timeout: 20_000,
    });
    expect(periodCalls(server).at(-2)?.input.from).toBe("2026-10-01");
  });

  test("ao voltar à aba relê, no máximo uma vez a cada 5 min", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await readsEnded(page);
    const before = periodCalls(server).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await readsEnded(page);
    expect(periodCalls(server).length).toBe(before);
    await page.clock.runFor(4 * 60_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await readsEnded(page);
    expect(periodCalls(server).length).toBe(before);
    await page.clock.runFor(RETURN_REFRESH_MS - 4 * 60_000);
    server.scenario = {
      ...SOLD,
      days: { ...SOLD.days, "2026-10-23": [42_010, 3] },
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 420,10");
  });

  test("a página volta do histórico (pageshow persistido): relê mesmo antes dos 5 min", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await page.clock.runFor(60_000);
    server.scenario = {
      ...SOLD,
      days: { ...SOLD.days, "2026-10-23": [42_010, 3] },
    };
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true })
      )
    );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 420,10");
  });

  test("uma releitura que falha deixa na tela os números já lidos", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    const before = periodCalls(server).length;
    server.broken.set("report/periodSummary", "500");
    await page.clock.runFor(RETURN_REFRESH_MS);
    const failedRead = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/report/periodSummary") &&
        response.status() === 500
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failedRead;
    expect(periodCalls(server).length).toBeGreaterThan(before);
    // the answer was handled: the next frame has it
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve))
    );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
  });
});
