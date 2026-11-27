/// <reference lib="dom" />
import type { Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  axeFaults,
  emptyIconFaults,
} from "../../e2e-pwa/ui-guardrails/measures";
import {
  UPDATED_AT,
  UPDATED_NAME,
  COPY_NOTICE,
  refreshButton,
  NO_COST_MONTH,
  FIXTURE,
  FakeReportServer,
  signIn,
  openDashboard,
  CARD,
  kpiCards,
  card,
  quality,
  chain,
  goalsRegion,
  chainRow,
  chartRegion,
  choosePreset,
  expectPreset,
  chooseRange,
  copyNotice,
} from "./shared";

const CACHE_KEY_PREFIX = "polaris.offline.periodSummary.";

/** An amount written on the screen: "R$ 130,00". */
const AN_AMOUNT = /R\$ \d/;

test("mostra os quatro cartões (v7) e o passo a passo do mês atual", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await expect(kpiCards(page)).toHaveCount(4);
  await expect(card(page, CARD.result)).toContainText("Resultado estimado");
  // the expense of the 31st is after today: the card is the server's of the whole month, as the chain says
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(card(page, CARD.result).locator("[data-kpi-delta]")).toHaveCount(
    0
  );
  await expect(card(page, CARD.netSales)).toContainText("Vendas em outubro");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.netSales)).toContainText("2 vendas");
  await expect(card(page, CARD.ticket)).toContainText("Ticket médio");
  await expect(card(page, CARD.ticket)).toContainText("R$ 65,00");
  await expect(card(page, CARD.margin)).toContainText("Margem");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  // the chips compare with the same days of September (v7 § 8): R$ 130,00 against R$ 100,00
  await expect(card(page, CARD.netSales)).toContainText("+30,0%");
  // what it compares with is said short beside the chip, in full in its name and in the (i)
  await expect(
    card(page, CARD.netSales).locator("[data-kpi-delta]")
  ).toHaveAttribute(
    "aria-label",
    "subiu 30,0 por cento em relação a setembro (1 a 14/09)"
  );
  await expect(
    card(page, CARD.netSales).locator("[data-kpi-delta]")
  ).toContainText("vs. setembro");
  // the period before is read once, by the engine, for the three chips: `dailySales` is not asked for it
  expect(server.comparisons).toEqual([
    { from: "2026-09-01", to: "2026-09-30" },
  ]);
  expect(server.salesComparisons).toEqual([]);

  // the period asked for is this month, the first to the last day, and it is the one pressed
  expect(server.periods[0]).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  await expectPreset(page, "Este mês");

  // complete data: a quiet line, no incomplete-estimate tag
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  await expect(page.getByText("estimativa incompleta")).toHaveCount(0);

  // the chain, in order, with each line's amount
  await expect(
    page.getByRole("heading", { name: "Como chegamos a este resultado" })
  ).toBeVisible();
  const labels = await chain(page).locator("tbody th").allTextContents();
  expect(labels).toEqual([
    "Vendas brutas",
    "(−) Descontos",
    "(−) Devoluções",
    "(=) Vendas líquidas",
    "(−) Custo das mercadorias vendidas (CMV)",
    "(=) Lucro bruto",
    "(+) Acréscimos e frete",
    "(−) Taxas de processamento",
    "(−) Taxas de antecipação",
    "(−) Despesas ligadas à venda",
    "(=) Margem de contribuição",
    "(−) Despesas do período (sem venda)",
    "(=) Resultado operacional estimado",
  ]);
  await expect(chainRow(page, "Vendas brutas")).toContainText("R$ 150,00");
  await expect(chainRow(page, "Descontos")).toContainText("R$ 10,00");
  await expect(chainRow(page, "Devoluções")).toContainText("R$ 10,00");
  await expect(chainRow(page, "(=) Vendas líquidas")).toContainText(
    "R$ 130,00"
  );
  await expect(chainRow(page, "(CMV)")).toContainText("R$ 60,00");
  await expect(chainRow(page, "(=) Lucro bruto")).toContainText("R$ 70,00");
  await expect(chainRow(page, "Acréscimos e frete")).toContainText("R$ 5,00");
  await expect(chainRow(page, "Taxas de processamento")).toContainText(
    "R$ 4,50"
  );
  await expect(chainRow(page, "Taxas de antecipação")).toContainText("R$ 0,00");
  await expect(chainRow(page, "ligadas à venda")).toContainText("R$ 2,00");
  await expect(chainRow(page, "Margem de contribuição")).toContainText(
    "R$ 68,50"
  );
  await expect(chainRow(page, "sem venda")).toContainText("R$ 30,00");
  await expect(chainRow(page, "Resultado operacional estimado")).toContainText(
    "R$ 38,50"
  );

  // the time of the last successful load is visible
  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
});

test("o link das despesas é discreto, fica na linha das despesas do período e não é um botão de largura toda", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await openDashboard(page, new FakeReportServer());
  const link = chain(page).getByRole("link", { name: "Ver despesas" });
  await expect(chainRow(page, "sem venda").getByRole("rowheader")).toHaveText(
    "(−) Despesas do período (sem venda)"
  );
  await expect(link).toHaveAttribute("href", "/expenses");
  const box = await link.boundingBox();
  expect(box?.width ?? 999).toBeLessThan(160);
  await expect(
    page.getByRole("link", { exact: true, name: "Despesas do período" })
  ).toHaveCount(0);
});

test("sem a leitura do dailySales, somem só os chips de Vendas e Ticket médio; o resto da tela fica", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.salesFailure = true;
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await choosePreset(page, "Mês passado");
  // the result of September cannot have a chip, so the sales chips are the ones of `dailySales`
  await expect.poll(() => server.salesComparisons.length).toBe(1);
  await expect(card(page, CARD.netSales)).toContainText("Vendas em setembro");
  await expect(
    card(page, CARD.netSales).locator("[data-kpi-delta]")
  ).toHaveCount(0);
  await expect(card(page, CARD.ticket).locator("[data-kpi-delta]")).toHaveCount(
    0
  );
  await expect(card(page, CARD.netSales)).not.toContainText("vs. ");
  await expect(chartRegion(page)).toBeVisible();
});

test("sem a leitura do período anterior pelo periodSummary, o chip de Vendas ainda aparece pelo dailySales e o de Resultado não", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.comparisonFailure = true;
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.netSales)).toContainText("+30,0%");
  await expect(card(page, CARD.netSales)).toContainText("vs. setembro");
  await expect(card(page, CARD.ticket).locator("[data-kpi-delta]")).toHaveCount(
    1
  );
  await expect(card(page, CARD.result).locator("[data-kpi-delta]")).toHaveCount(
    0
  );
  expect(server.comparisons).toEqual([
    { from: "2026-09-01", to: "2026-09-30" },
  ]);
  expect(server.salesComparisons).toEqual([
    { from: "2026-09-01", to: "2026-09-30" },
  ]);
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  await expect(chartRegion(page)).toBeVisible();
});

/**
 * The lab of the screens has no header, so no eye: the choice reaches the page as it does from another tab of the device
 * (the key of the Início and of the shell, and the `storage` event). The button is proved in the shell, in `home/cartoes-e-grafico.e2e.ts`
 * and `shell-header.e2e.ts`.
 */
const chooseHiddenValues = (page: Page, hidden: boolean) =>
  page.evaluate((escondidos) => {
    if (escondidos) {
      window.localStorage.setItem("polaris-valores", "escondidos");
    } else {
      window.localStorage.removeItem("polaris-valores");
    }
    window.dispatchEvent(
      new StorageEvent("storage", { key: "polaris-valores" })
    );
  }, hidden);

test("Esconder valores (v7 § 6): a escolha do aparelho esconde os reais dos cartões, da cadeia, das partes e do gráfico, e as porcentagens ficam", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  const main = page.locator("main");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  await chooseHiddenValues(page, true);
  await expect(card(page, CARD.netSales)).toContainText("R$ ••••");
  await expect(card(page, CARD.result)).not.toContainText("R$ 38,50");
  await expect(card(page, CARD.margin)).toContainText("52,69%");
  await expect(chainRow(page, "Vendas brutas")).not.toContainText("R$ 150,00");
  await expect(main).not.toContainText(AN_AMOUNT);
  await expect(main.getByText("valor escondido").first()).toBeAttached();

  await chooseHiddenValues(page, false);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});

test("um mês parcial mostra o aviso do que faltou e a etiqueta de estimativa incompleta", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");

  await choosePreset(page, "Mês passado");

  // the result of September is incomplete, so its chip cannot exist: the engine is not asked for August, and
  // `dailySales` still is (the chips of Vendas and Ticket)
  const august = { from: "2026-08-01", to: "2026-08-31" };
  await expect.poll(() => server.salesComparisons).toContainEqual(august);
  expect(server.comparisons).not.toContainEqual(august);

  const banner = quality(page);
  await expect(banner).toContainText("Estimativa incompleta");
  await expect(banner).toContainText(
    "2 linhas de itens vendidos sem custo conhecido: o custo delas não entrou no CMV."
  );
  await expect(banner).toContainText(
    "1 venda sem taxa de processamento conhecida: a venda entra nos totais, mas a taxa dela ficou fora do cálculo."
  );
  await expect(banner).toContainText(
    "1 venda com antecipação sem taxa conhecida: a venda entra nos totais, mas a taxa dela ficou fora do cálculo."
  );
  await expect(banner).toContainText(
    "Nenhuma despesa registrada neste período: o resultado pode estar acima do real."
  );
  await expect(banner).not.toContainText("Dados completos");

  // the result carries the tag, and the unknowns are marked on their own lines
  await expect(card(page, CARD.result)).toContainText("Incompleta");
  await expect(card(page, CARD.result)).toContainText("R$ 92,00");
  await expect(chainRow(page, "(CMV)")).toContainText(
    "Não inclui 2 itens sem custo conhecido."
  );
  // a partial cost of the goods keeps its amount and the bar of the parts, marked "incompleto"
  await expect(chainRow(page, "(CMV)")).toContainText("R$ 8,00");
  await expect(chain(page).locator("[data-parts-bar]")).toHaveCount(1);
  await expect(chain(page)).toContainText("incompleto");
  await expect(chainRow(page, "Taxas de processamento")).toContainText(
    "Não inclui 1 venda sem taxa conhecida."
  );
});

test("nenhum custo de mercadoria conhecido: o CMV é “—” com a nota, a barra das partes não aparece e os cartões do resultado e da margem são “—” (T399-3)", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.fixture = { ...FIXTURE, "2026-10": NO_COST_MONTH };
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  const result = card(page, CARD.result);
  await expect(result).toContainText(
    "Sem custo informado: não dá para estimar."
  );
  await expect(result).not.toContainText(AN_AMOUNT);
  await expect(card(page, CARD.margin)).toContainText("Sem custo informado");
  await expect(card(page, CARD.margin)).not.toContainText("%");

  const cogs = chainRow(page, "(CMV)");
  await expect(cogs).toContainText("—");
  await expect(cogs).toContainText(
    "Nenhum dos 3 itens vendidos tem custo conhecido."
  );
  await expect(cogs).not.toContainText(AN_AMOUNT);
  await expect(chainRow(page, "Vendas brutas")).toContainText("R$ 150,00");

  await expect(chain(page).locator("[data-parts-bar]")).toHaveCount(0);
  await expect(chain(page)).toContainText("sem custo conhecido");
  // the fees (3,00 + 1,50) and the expenses (2,00 + 30,00) keep their values
  await expect(chain(page)).toContainText("TaxasR$ 4,50");
  await expect(chain(page)).toContainText("DespesasR$ 32,00");
  await expect(chain(page)).toContainText(
    "Sem o custo das mercadorias, a divisão dos custos não aparece."
  );
});

test("trocar entre este mês e o mês passado carrega o período dele de novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  await choosePreset(page, "Mês passado");
  await expectPreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  expect(server.periods.at(-1)).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });

  await choosePreset(page, "Este mês");
  await expectPreset(page, "Este mês");
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(server.periods.map((period) => period.from)).toEqual([
    "2026-10-01",
    "2026-09-01",
    "2026-10-01",
  ]);
});

test("um mês sem vendas nem despesas mostra o estado vazio, sem cartões", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await chooseRange(page, "2026-03-01", "2026-03-31");

  await expect(
    page.getByText("Sem vendas nem despesas em 1 a 31 de março")
  ).toBeVisible();
  const empty = page
    .getByRole("status")
    .filter({ hasText: "Sem vendas nem despesas em 1 a 31 de março" });
  await expect(empty).toHaveCount(1);
  await expect(empty.getByRole("link", { name: "Nova venda" })).toBeVisible();
  expect(await axeFaults(page, "[data-empty-state]")).toEqual([]);
  expect(await emptyIconFaults(page, 3)).toEqual([]);
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(chain(page)).toHaveCount(0);
});

test("uma resposta atrasada nunca troca a de um mês mais novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const releaseOctober = server.hold("2026-10");
  const isOctoberRead = (request: Request) => {
    if (!request.url().includes("report/periodSummary")) {
      return false;
    }
    const body = request.postDataJSON() as {
      json?: { from?: string; topProducts?: unknown };
    } | null;
    return (
      body?.json?.from?.slice(0, 7) === "2026-10" &&
      body.json.topProducts !== undefined
    );
  };
  // the read of October ends in the browser one way or the other: the screen cancels it once September is asked
  // for (requestfailed), or its answer arrives whole (the body read to the end); both are listened to from before the read exists
  const octoberEnded = Promise.race([
    page
      .waitForResponse((response) => isOctoberRead(response.request()))
      .then((response) => response.finished()),
    page.waitForEvent("requestfailed", isOctoberRead),
  ]);
  octoberEnded.catch(() => undefined);
  await openDashboard(page, server);

  // October is still pending when September is asked for and answered
  await choosePreset(page, "Mês passado");
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");

  releaseOctober();
  await octoberEnded;
  await expect
    .poll(() => server.answered.filter((m) => m === "2026-10").length)
    .toBe(1);
  // two frames after the browser is done with the read: a late answer has been handed to the screen, where it must be ignored
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  await expectPreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  await expect(quality(page)).toContainText("Estimativa incompleta");
});

test("uma falha do servidor mostra o erro e deixa tentar de novo", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.failure = { code: "INTERNAL_SERVER_ERROR", status: 500 };
  await openDashboard(page, server);

  const alert = page.getByRole("alert");
  // three tries (~1.5 s and ~4 s between them) before the screen says it failed
  await expect(alert).toContainText(
    "Não foi possível carregar o resultado. Tente novamente.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  server.failure = null;
  await alert.getByRole("button", { name: "Tentar novamente" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
});

/** The months of the device copy of the results kept in this browser. */
const cachedMonths = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(-7))
        .sort(),
    CACHE_KEY_PREFIX
  );

test("com o servidor, a tela diz até quando está atualizada e guarda o mês para depois", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);

  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
  await expect(copyNotice(page)).toHaveCount(0);
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  await choosePreset(page, "Mês passado");
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  expect(await cachedMonths(page)).toEqual(["2026-09", "2026-10"]);
});

test("sem conexão, atualizar mostra o último resultado confirmado, dito como tal", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");

  server.networkDown = true;
  await refreshButton(page).click();

  const notice = copyNotice(page);
  await expect(notice).toContainText(COPY_NOTICE, { timeout: 15_000 });
  // nothing is waiting on the device, so no line about operations kept
  await expect(notice).not.toContainText("operações guardadas");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // the same figures the server confirmed, not recomputed
  await expect(kpiCards(page)).toHaveCount(4);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  await expect(card(page, CARD.result)).toContainText("R$ 38,50");
  await expect(quality(page)).toContainText(
    "Dados completos para este período"
  );
  // "Atualizado às" is for figures the server just gave; the copy says when it was confirmed, beside the period
  await expect(refreshButton(page)).toHaveText("Atualizar");
  const status = page.locator("#dashboard-updated");
  await expect(status).toHaveText(
    "Último resultado confirmado: 14/10/2026 09:00"
  );
  const confirmedHeight = (await status.boundingBox())?.height ?? 0;
  expect(confirmedHeight).toBeGreaterThan(1);

  // over the copy the read in progress takes the place of the confirmed-at line, in view
  server.networkDown = false;
  const release = server.hold("2026-10");
  await refreshButton(page).click();
  await expect(status).toHaveText("Atualizando…");
  const readingHeight = (await status.boundingBox())?.height ?? 0;
  expect(readingHeight).toBeGreaterThan(1);
  expect(Math.abs(readingHeight - confirmedHeight)).toBeLessThanOrEqual(0.5);
  release();
  await expect(copyNotice(page)).toHaveCount(0);
  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
});

test("sem conexão, a cópia vale só para o mês já lido, com a estimativa como estava", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await choosePreset(page, "Mês passado");
  await expect(quality(page)).toContainText("Estimativa incompleta");

  server.networkDown = true;
  // a range never read has no copy at all: it opens only with a connection (AC-16)
  await chooseRange(page, "2026-08-01", "2026-08-31");
  await expect(page.getByRole("alert")).toContainText(
    "Este período só abre com internet.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // a month that was read shows its own copy, never the one of another period
  await choosePreset(page, "Mês passado");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 100,00");
  await expect(quality(page)).toContainText("Estimativa incompleta");
  await expect(card(page, CARD.result)).toContainText("Incompleta");
  await expect(card(page, CARD.result)).toContainText("R$ 92,00");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sem conexão, um mês que nunca foi lido diz que não há números guardados, e os outros períodos só abrem com internet", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await choosePreset(page, "Mês passado");
  await expect(page.getByRole("alert")).toContainText(
    "Sem conexão e sem números guardados neste aparelho.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  // the last 30 days is a window that moves: no copy, and the screen says why
  await choosePreset(page, "Últimos 30 dias");
  await expect(page.getByRole("alert")).toContainText(
    "Este período só abre com internet.",
    { timeout: 15_000 }
  );
  await expect(kpiCards(page)).toHaveCount(0);

  // this month was read: its copy is still there
  await choosePreset(page, "Este mês");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});

test("sem conexão, Este ano só abre com internet, como os Últimos 30 dias, e o mês lido segue com a cópia (AC-1.3)", async ({
  page,
}) => {
  const server = new FakeReportServer();
  await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await choosePreset(page, "Este ano");
  await expectPreset(page, "Este ano");
  await expect(page.getByRole("alert")).toContainText(
    "Este período só abre com internet.",
    { timeout: 15_000 }
  );
  await expect(page.getByRole("alert")).not.toContainText(
    "Sem conexão e sem números guardados"
  );
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  await choosePreset(page, "Este mês");
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
});

test("abrir o painel sem rede mostra a cópia do mês, e com a rede de volta mostra o servidor", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const user = await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");

  server.networkDown = true;
  await signIn(page, user);
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  // the goals are never copied: their tab shows its own load error
  await page.getByRole("tab", { name: "Metas" }).click();
  await expect(goalsRegion(page)).toContainText(
    "Não foi possível carregar as metas."
  );

  // back on the Resultado tab, the connection returns: the figures of the server replace the copy
  await page.getByRole("tab", { exact: true, name: "Resultado" }).click();
  server.networkDown = false;
  await refreshButton(page).click();
  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
  await expect(copyNotice(page)).toHaveCount(0);
});

test("sem conexão, o mês vazio guardado mostra o estado vazio com a cópia dita como tal, e os dois botões seguem como com conexão", async ({
  page,
}) => {
  const server = new FakeReportServer();
  server.fixture = { ...FIXTURE, "2026-10": { expenses: [], sales: [] } };
  const user = await openDashboard(page, server);
  const empty = page.getByText("Sem vendas nem despesas em 1 a 31 de outubro");
  await expect(empty).toBeVisible();
  expect(await cachedMonths(page)).toEqual(["2026-10"]);
  const newSale = page.getByRole("link", { exact: true, name: "Nova venda" });
  const newExpense = page.getByRole("link", {
    exact: true,
    name: "Nova despesa",
  });
  await expect(newSale).toHaveAttribute("href", "/sales");
  await expect(newExpense).toHaveAttribute("href", "/expenses");

  server.networkDown = true;
  await signIn(page, user);
  await expect(copyNotice(page)).toContainText(COPY_NOTICE, {
    timeout: 15_000,
  });
  await expect(empty).toBeVisible();
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(newSale).toBeVisible();
  await expect(newSale).toHaveAttribute("href", "/sales");
  await expect(newExpense).toBeVisible();
  await expect(newExpense).toHaveAttribute("href", "/expenses");
});

test("uma recusa do servidor nunca cai na cópia, mas uma indisponibilidade cai", async ({
  page,
}) => {
  const server = new FakeReportServer();
  const user = await openDashboard(page, server);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  // the copy exists, but the server said the session is over
  server.failure = { code: "UNAUTHORIZED", status: 401 };
  await signIn(page, user);
  // the lab has no shell (no notice): the red box says only what did not happen
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar o resultado."
  );
  await expect(kpiCards(page)).toHaveCount(0);
  await expect(copyNotice(page)).toHaveCount(0);

  // and the session being over cleared every copy this browser held
  expect(await cachedMonths(page)).toEqual([]);

  // signed in again, the month is read and kept anew
  server.failure = null;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  expect(await cachedMonths(page)).toEqual(["2026-10"]);

  // an outage of the server is not a refusal: with the connection there, after the three tries, the copy stays
  // under "Não foi possível atualizar agora", with what it shows and "Tentar novamente" (paliativo dos 1102)
  server.failure = { code: "SERVICE_UNAVAILABLE", status: 503 };
  await refreshButton(page).click();
  const stale = page
    .getByRole("status")
    .filter({ hasText: "Não foi possível atualizar agora" });
  await expect(stale).toContainText(
    "Mostrando os números de 09:00. Vendas feitas depois não estão aqui.",
    { timeout: 15_000 }
  );
  await expect(copyNotice(page)).toHaveCount(0);
  await expect(card(page, CARD.netSales)).toContainText("R$ 130,00");
  server.failure = null;
  await stale.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(refreshButton(page)).toHaveText(UPDATED_AT);
  await expect(refreshButton(page)).toHaveAccessibleName(UPDATED_NAME);
  await expect(stale).toHaveCount(0);
});
