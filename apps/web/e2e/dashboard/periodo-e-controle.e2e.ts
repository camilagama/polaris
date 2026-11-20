/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  COPY_NOTICE,
  COMPLETE_MONTH,
  FIXTURE,
  FakeReportServer,
  signIn,
  openDashboard,
  CARD,
  kpiCards,
  card,
  goalsRegion,
  chartRegion,
  periodButton,
  choosePreset,
  expectPreset,
  rangeFields,
  copyNotice,
  metasTab,
  resultTab,
  search,
  SIZES,
  MonthlyReportServer,
  resultHeights,
  expectSameHeights,
} from "./shared";

const periodChoice = periodButton;

/** Reloads the page the way a person does: the lab asks who is signed in again when the page loads. */
async function reloadDashboard(page: Page, user: string) {
  await page.reload();
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", {
      exact: true,
      includeHidden: true,
      name: "Resultado",
    })
  ).toBeVisible({ timeout: 20_000 });
}

const lastPeriod = (server: FakeReportServer) => server.periods.at(-1);

const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

const LAST_30 = { from: "2026-09-15", to: "2026-10-14" };

test.describe("o período no endereço (L2-11 a, AC-3.1 a AC-3.7)", () => {
  test("o padrão não escreve nada; um atalho escreve só o nome e recarregar o mantém, sem passo novo no histórico (AC-3.1, AC-3.2, AC-3.6)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    const user = await openDashboard(page, server);
    expect(search(page).has("periodo")).toBe(false);
    expect(search(page).has("de")).toBe(false);
    const steps = await page.evaluate(() => window.history.length);

    await choosePreset(page, "Últimos 30 dias");
    await expect.poll(() => search(page).get("periodo")).toBe("30-dias");
    await choosePreset(page, "Mês passado");
    await expect.poll(() => search(page).get("periodo")).toBe("mes-passado");
    await choosePreset(page, "Últimos 30 dias");
    expect(await page.evaluate(() => window.history.length)).toBe(steps);
    expect(search(page).has("de")).toBe(false);

    await reloadDashboard(page, user);
    await expect(periodButton(page)).toBeVisible();
    await expectPreset(page, "Últimos 30 dias");
    expect(lastPeriod(server)).toEqual(LAST_30);
    expect(search(page).get("periodo")).toBe("30-dias");

    await choosePreset(page, "Este mês");
    await expect.poll(() => search(page).has("periodo")).toBe(false);
    expect(await page.evaluate(() => window.history.length)).toBe(steps);
  });

  test("um intervalo escreve as duas datas, nada mais, e recarregar o mantém (AC-3.1, AC-3.6)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    const user = await openDashboard(page, server);
    await rangeFields(page, "2026-10-05", "2026-10-12");
    await expect.poll(() => search(page).get("de")).toBe("2026-10-05");
    expect(search(page).get("ate")).toBe("2026-10-12");
    expect(search(page).has("periodo")).toBe(false);
    expect(page.url()).toContain("&de=2026-10-05&ate=2026-10-12");

    await reloadDashboard(page, user);
    await expect(periodButton(page)).toBeVisible();
    await expectPreset(page, "Período");
    expect(lastPeriod(server)).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
    expect(search(page).get("de")).toBe("2026-10-05");
    expect(search(page).get("ate")).toBe("2026-10-12");
  });

  test("o endereço de outra pessoa abre no período dele: atalho, intervalo, e o intervalo ganha quando vêm juntos (AC-3.1, AC-3.3)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&periodo=30-dias");
    await expectPreset(page, "Últimos 30 dias");
    expect(server.periods[0]).toEqual(LAST_30);

    const together = new FakeReportServer();
    await openDashboard(
      page,
      together,
      "&periodo=30-dias&de=2026-10-05&ate=2026-10-12&x=1"
    );
    await expectPreset(page, "Período");
    expect(together.periods[0]).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
    await expect.poll(() => search(page).has("periodo")).toBe(false);
    expect(search(page).get("x")).toBe("1");
  });

  test("?periodo=este-ano abre Este ano, lê de 1º de janeiro até hoje por mês e o endereço guarda o atalho (AC-3.1)", async ({
    page,
  }) => {
    const server = new MonthlyReportServer();
    server.fixture = { ...FIXTURE, "2026-01": COMPLETE_MONTH };
    await openDashboard(page, server, "&periodo=este-ano&x=1");
    await expectPreset(page, "Este ano");
    expect(server.periods[0]).toEqual({ from: "2026-01-01", to: TODAY });
    await expect(
      page.getByRole("region", { name: "Vendas × custos por mês" })
    ).toBeVisible();
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    await expect(
      card(page, CARD.netSales).getByRole("slider")
    ).toHaveAccessibleName("Vendas líquidas, acumulado por mês");
    expect(search(page).get("periodo")).toBe("este-ano");
    expect(search(page).get("x")).toBe("1");
  });

  test("?periodo=este-mes explícito abre o padrão e o endereço perde o atalho, sem acrescentar passo ao histórico (AC-3.1, AC-3.2)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&periodo=este-mes&x=1");
    await expectPreset(page, "Este mês");
    expect(server.periods[0]).toEqual(OCTOBER);
    await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
    await expect.poll(() => search(page).has("periodo")).toBe(false);
    expect(search(page).get("x")).toBe("1");
    const steps = await page.evaluate(() => window.history.length);

    const plain = await page.context().newPage();
    await openDashboard(plain, new FakeReportServer(), "&x=1");
    await expectPreset(plain, "Este mês");
    expect(await plain.evaluate(() => window.history.length)).toBe(steps);
  });

  for (const extra of [
    "&periodo=ontem",
    "&de=2026-10-14&ate=2026-10-01",
    "&de=abc&ate=def",
    "&de=2026-10-01",
    "&de=2025-01-01&ate=2026-10-14",
  ]) {
    test(`endereço com período inválido (${extra}) abre o padrão, sem tela quebrada, e o endereço volta ao válido (AC-3.3)`, async ({
      page,
    }) => {
      const server = new FakeReportServer();
      await openDashboard(page, server, `${extra}&x=1`);
      await expectPreset(page, "Este mês");
      await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
      expect(server.periods).toEqual([OCTOBER]);
      await expect
        .poll(() => [...search(page).keys()].sort())
        .toEqual(["screen", "x"]);
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  }

  test("sem internet, abrir pelo endereço é escolher no seletor: o mês lido abre pela cópia, o resto só com internet (AC-3.4)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    const user = await openDashboard(page, server);
    await choosePreset(page, "Mês passado");
    await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
    const reads = server.periods.length;

    server.networkDown = true;
    await signIn(page, user, "&periodo=mes-passado");
    await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
      timeout: 15_000,
    });
    await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
    await expectPreset(page, "Mês passado");

    await signIn(page, user, "&periodo=30-dias");
    await expect(page.getByRole("alert")).toContainText(
      "Este período só abre com internet.",
      { timeout: 15_000 }
    );
    await expect(kpiCards(page)).toHaveCount(0);
    await expectPreset(page, "Últimos 30 dias");
    expect(search(page).get("periodo")).toBe("30-dias");

    await signIn(page, user, "&de=2026-08-01&ate=2026-08-31");
    await expect(page.getByRole("alert")).toContainText(
      "Este período só abre com internet.",
      { timeout: 15_000 }
    );
    await expectPreset(page, "Período");
    expect(server.periods).toHaveLength(reads);
  });

  test("a aba Metas guarda o período no endereço, e só o Resultado o lê (AC-3.5)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&aba=metas&periodo=30-dias");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(goalsRegion(page)).toBeVisible();
    await expect(periodChoice(page)).toHaveCount(0);
    expect(search(page).get("aba")).toBe("metas");
    expect(search(page).get("periodo")).toBe("30-dias");

    await resultTab(page).click();
    await expect(periodChoice(page)).toBeVisible();
    await expectPreset(page, "Últimos 30 dias");
    expect(lastPeriod(server)).toEqual(LAST_30);
    expect(search(page).has("aba")).toBe(false);
    expect(search(page).get("periodo")).toBe("30-dias");

    await metasTab(page).click();
    expect(search(page).get("aba")).toBe("metas");
    expect(search(page).get("periodo")).toBe("30-dias");
  });

  test("o período que o Histórico leva na navegação ganha do endereço, e o endereço passa a dizê-lo (AC-3.1)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    const user = await openDashboard(page, server, "&periodo=30-dias");
    await page.evaluate(() => {
      window.history.replaceState(
        {
          ...window.history.state,
          resultPeriod: { from: "2026-10-05", to: "2026-10-12" },
        },
        ""
      );
    });
    const reads = server.periods.length;

    await reloadDashboard(page, user);
    await expect(periodButton(page)).toBeVisible();
    await expectPreset(page, "Período");
    expect(server.periods.at(reads)).toEqual({
      from: "2026-10-05",
      to: "2026-10-12",
    });
    await expect.poll(() => search(page).get("de")).toBe("2026-10-05");
    expect(search(page).get("ate")).toBe("2026-10-12");
    expect(search(page).has("periodo")).toBe(false);
  });

  test("?meta=nova com um período abre a aba Metas com o formulário e guarda aba e período (AC-3.5)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=nova&periodo=30-dias");
    await expect(page.getByRole("dialog", { name: "Nova meta" })).toBeVisible();
    await expect.poll(() => search(page).get("aba")).toBe("metas");
    expect(search(page).get("periodo")).toBe("30-dias");
    expect(search(page).has("meta")).toBe(false);
  });

  test("o link do Início para as Metas com um período no endereço abre Metas e guarda os dois (AC-3.5)", async ({
    page,
  }) => {
    const server = new FakeReportServer();
    await openDashboard(page, server, "&meta=lista&periodo=mes-passado");
    await expect(metasTab(page)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => search(page).get("aba")).toBe("metas");
    expect(search(page).get("periodo")).toBe("mes-passado");
    expect(search(page).has("meta")).toBe(false);
    await resultTab(page).click();
    await expectPreset(page, "Mês passado");
  });
});

/** The store's today at `NOW` (09:00 in São Paulo). */
const TODAY = "2026-10-14";

/** The reading of a monthly curve at rest, to today, and at the end of a range of 63 days (D1-2). */
const UNTIL_TODAY = /^Até 14\/10: /;

const UNTIL_JULY_6 = /^Até 06\/07: /;

test.describe("períodos longos por mês: trocar entre o mês, 30 dias e o ano não muda a altura dos cartões nem do gráfico", () => {
  // the same complete records at the start of every period read (the month, the 30 days from September, the year from
  // January and 63 days from May): only the granularity changes between them, not the quality nor its badge
  const fixture = {
    ...FIXTURE,
    "2026-01": COMPLETE_MONTH,
    "2026-05": COMPLETE_MONTH,
    "2026-09": COMPLETE_MONTH,
  };

  for (const size of SIZES) {
    test(`Últimos 30 dias → Este ano → Últimos 30 dias → Este ano (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const server = new MonthlyReportServer();
      server.fixture = fixture;
      await openDashboard(page, server);
      await choosePreset(page, "Últimos 30 dias");
      await expect(chartRegion(page)).toContainText("Melhor dia");
      await expect(
        card(page, CARD.netSales).getByRole("slider")
      ).toHaveAccessibleName("Vendas líquidas, acumulado por dia");
      const days = await resultHeights(page);

      await choosePreset(page, "Este ano");
      await expect(chartRegion(page)).toContainText("Melhor mês");
      expect(server.periods.at(-1)).toEqual({ from: "2026-01-01", to: TODAY });
      const sales = card(page, CARD.netSales).getByRole("slider");
      await expect(sales).toHaveAccessibleName(
        "Vendas líquidas, acumulado por mês"
      );
      await expect(sales).toHaveAttribute("max", "9");
      await expect(sales).toHaveAttribute("aria-valuetext", UNTIL_TODAY);
      // no comparison above 62 days: the chip line is empty and keeps its place
      await expect(
        card(page, CARD.netSales).locator("[data-kpi-delta]")
      ).toHaveCount(0);
      const year = await resultHeights(page);
      expectSameHeights(year, days);

      await choosePreset(page, "Últimos 30 dias");
      await expect(chartRegion(page)).toContainText("Melhor dia");
      expectSameHeights(await resultHeights(page), days);

      await choosePreset(page, "Este ano");
      await expect(chartRegion(page)).toContainText("Melhor mês");
      expectSameHeights(await resultHeights(page), year);
    });

    test(`63 dias, três meses, com a mesma altura de 30 dias (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const server = new MonthlyReportServer();
      server.fixture = fixture;
      await openDashboard(page, server);
      await choosePreset(page, "Últimos 30 dias");
      await expect(chartRegion(page)).toContainText("Melhor dia");
      const days = await resultHeights(page);

      await rangeFields(page, "2026-05-05", "2026-07-06");
      await expect(chartRegion(page)).toContainText("Melhor mês");
      const sales = card(page, CARD.netSales).getByRole("slider");
      await expect(sales).toHaveAttribute("max", "2");
      await expect(sales).toHaveAttribute("aria-valuetext", UNTIL_JULY_6);
      expectSameHeights(await resultHeights(page), days);
    });
  }
});

test.describe("o período do Resultado não tem setas de mês", () => {
  for (const [name, choose] of [
    ["com o mês inteiro", async () => undefined],
    [
      "com Mês passado",
      async (page: Page) => choosePreset(page, "Mês passado"),
    ],
    [
      "com um mês inteiro digitado",
      async (page: Page) => rangeFields(page, "2026-07-01", "2026-07-31"),
    ],
    [
      "com Últimos 30 dias",
      async (page: Page) => choosePreset(page, "Últimos 30 dias"),
    ],
  ] as const) {
    test(`${name}, só o botão do período troca o período: nenhum "Mês anterior" nem "Próximo mês" fora do painel`, async ({
      page,
    }) => {
      const server = new FakeReportServer();
      await openDashboard(page, server);
      await choose(page);
      await expect(periodButton(page)).toBeVisible();
      await expect(
        page.getByRole("button", { exact: true, name: "Mês anterior" })
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { exact: true, name: "Próximo mês" })
      ).toHaveCount(0);
      await expect(
        page.getByRole("group", { name: "Mês do período" })
      ).toHaveCount(0);
      await expect(page.locator("[data-month-live]")).toHaveCount(0);
    });
  }
});
