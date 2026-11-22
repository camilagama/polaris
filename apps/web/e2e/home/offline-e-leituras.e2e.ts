/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { READ_PROCEDURES } from "../../src/lib/read-gate";
import {
  CONFIRMED,
  choosePeriod,
  copyKeys,
  DAY,
  FakeServer,
  goal,
  kpiGrid,
  HOUR,
  NOON,
  newSale,
  OFFLINE_KEYS,
  openHome,
  openWithCopy,
  periodButton,
  periodCalls,
  RETURN_REFRESH_MS,
  RPC_PATH,
  refreshButton,
  region,
  reopenWithoutNetwork,
  SIZES,
  SOLD,
  SYNCED,
  serve,
  UPDATED_AT,
} from "./shared";

/** The button of the menu of the store in the header: what the menu holds, then the store. */
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;

const OFFLINE_SALE = "Sem internet. A venda é enviada quando a conexão voltar.";

/** The note of each card (and of the goal) without a connection and without a copy: the reason is said once, above. */
const NO_CONNECTION = "Sem conexão";

const NO_COPY_REASON = "Sem internet. Os números";

test.describe("sem conexão (§ 7, AC-28 a AC-31)", () => {
  test("com cópia, a rede cai: os números ficam como último resultado confirmado, a meta, a linha do aparelho e os avisos só com conexão", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    const reads = server.calls.length;
    await page.context().setOffline(true);

    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible();
    await expect(page.getByText("atualizado às")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
    await expect(region(page, "Mais vendidos do mês")).toContainText(
      "Camiseta básica"
    );
    await expect(region(page, "Vendas por dia")).toBeVisible();
    await expect(region(page, "Meta")).toContainText("Meta de outubro");
    await expect(region(page, "Meta")).toContainText("53,4%");
    await expect(region(page, "Meta")).not.toContainText("Ver as outras");
    // the stock is not read without a connection, and nothing is said of it under the cards
    await expect(page.getByText("Avisos do estoque")).toHaveCount(0);
    await expect(page.getByText("sem saldo")).toHaveCount(0);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    await expect(newSale(page)).toHaveAttribute("href", "/sales");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    // the Início is no longer an online-only screen: the shell does not cover it with its notice
    await expect(
      page.getByText("Esta tela precisa de conexão.", { exact: false })
    ).toHaveCount(0);
    // no read while offline, not even when the tab comes back
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(server.calls.length).toBe(reads);
  });

  test("a rede volta: o Início lê de novo e diz 'Atualizado até', sem esqueleto", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.context().setOffline(true);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    const reads = periodCalls(server).length;
    await page.context().setOffline(false);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(reads);
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();
    await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });

  for (const viewport of [
    { height: 740, width: 360 },
    { height: 800, width: 1280 },
  ]) {
    test(`a linha de ações fica no mesmo lugar, com Atualizar desligado, sem conexão e na volta (${viewport.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = new FakeServer(SOLD);
      await openWithCopy(page, server);
      const actions = [
        refreshButton(page),
        page.getByRole("button", { name: "Esconder valores" }),
        newSale(page),
      ];
      const boxes = async () =>
        Promise.all(
          actions.map(async (action) => {
            const box = await action.boundingBox();
            expect(box).not.toBeNull();
            return box as NonNullable<typeof box>;
          })
        );
      const sameAs = (before: Awaited<ReturnType<typeof boxes>>) =>
        expect
          .poll(async () => {
            const now = await boxes();
            return Math.max(
              ...before.flatMap((ref, index) => {
                const box = now[index];
                return box
                  ? [
                      Math.abs(box.x - ref.x),
                      Math.abs(box.y - ref.y),
                      Math.abs(box.width - ref.width),
                      Math.abs(box.height - ref.height),
                    ]
                  : [Number.POSITIVE_INFINITY];
              })
            );
          })
          .toBeLessThanOrEqual(1);
      await expect(refreshButton(page)).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
      const online = await boxes();

      await page.context().setOffline(true);
      await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
      await expect(refreshButton(page)).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(refreshButton(page)).toHaveAttribute(
        "aria-describedby",
        "home-new-sale-offline"
      );
      await expect(refreshButton(page)).toHaveAccessibleDescription(
        OFFLINE_SALE
      );
      await sameAs(online);
      const reads = server.calls.length;
      await refreshButton(page).click({ force: true });
      expect(server.calls.length).toBe(reads);

      await page.context().setOffline(false);
      await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
      await expect(refreshButton(page)).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(refreshButton(page)).not.toHaveAttribute("aria-describedby");
      await sameAs(online);
    });
  }

  test("o período escolhido e a rolagem sobrevivem à queda e à volta da conexão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    const chart = region(page, "Vendas por dia");
    await choosePeriod(page, "Mês passado");
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await expect(chart).toContainText("1 a 30/09");
    await chart.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    // the blocks above the chart change height offline (the sentence under "Nova venda", the stock's lines): the
    // proof is that the page does not jump back to the top and the chart stays in view, not the exact pixel
    const kept = async () => {
      await expect(chart).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
        scrolled / 2
      );
    };

    await page.context().setOffline(true);
    await expect(page.getByText(OFFLINE_SALE)).toBeVisible();
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await expect(chart).toContainText("1 a 30/09");
    await kept();

    await page.context().setOffline(false);
    await expect(page.getByText(OFFLINE_SALE)).toHaveCount(0);
    await expect(periodButton(page)).toContainText("01/09 a 30/09");
    await kept();
  });

  test("aberto sem resposta do Worker e com navigator.onLine verdadeiro: a cópia, nunca um erro", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(
      page.getByText(CONFIRMED, {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 });
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("sem cópia: os quatro cartões no lugar com '—' e 'Sem conexão', o motivo dito uma vez sob o título, sem zeros; Nova venda continua", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(page.getByText("R$")).toHaveCount(0);
    for (const name of [
      "Vendas hoje",
      "Vendas em outubro",
      "Resultado estimado",
      "Ticket médio",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one card after the other
      await expect(region(page, name)).toContainText("—sem valor");
      await expect(region(page, name)).toContainText(NO_CONNECTION);
    }
    // the chart keeps its place and its name, so the goal beside it does not change columns
    await expect(region(page, "Vendas por dia")).toContainText(NO_CONNECTION);
    await expect(page.getByText("Ver os números")).toHaveCount(0);
    await expect(region(page, "Meta")).toContainText(NO_CONNECTION);
    await expect(region(page, "Meta")).not.toContainText("Definir meta");
    // the reason once, in the line under the title, which "Nova venda" points to: never in each card
    await expect(page.locator("#home-updated")).toContainText(NO_COPY_REASON);
    await expect(page.getByText(NO_COPY_REASON)).toHaveCount(1);
    await expect(page.getByText("Sem internet")).toHaveCount(1);
    await expect(page.locator("#home-new-sale-offline")).toHaveText(
      "A venda é enviada quando a conexão voltar."
    );
    await expect(refreshButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(refreshButton(page)).toHaveAttribute(
      "aria-describedby",
      "home-updated"
    );
    await expect(page.getByText("Avisos do estoque")).toHaveCount(0);
    await expect(newSale(page)).toHaveAttribute("href", "/sales");
  });

  for (const size of SIZES) {
    test(`o cartão de hoje tem a mesma caixa com o valor, em "Sem números de hoje" e em "Sem conexão" (${size.width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const server = new FakeServer(SOLD);
      await openWithCopy(page, server);
      const [online] = (await kpiGrid(page)).cells;
      expect(online?.height ?? 0).toBeGreaterThan(0);

      await reopenWithoutNetwork(page, server, NOON + 25 * HOUR);
      await expect(region(page, "Vendas hoje")).toContainText(
        "Sem números de hoje",
        { timeout: 20_000 }
      );
      const [stale] = (await kpiGrid(page)).cells;
      expect(stale?.height).toBeCloseTo(online?.height ?? 0, 0);

      await page.evaluate((pattern) => {
        for (const key of Object.keys(localStorage)) {
          if (new RegExp(pattern).test(key)) {
            localStorage.removeItem(key);
          }
        }
      }, OFFLINE_KEYS.source);
      await reopenWithoutNetwork(page, server);
      await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
        timeout: 20_000,
      });
      const { cells } = await kpiGrid(page);
      const [offline] = cells;
      expect(offline?.height).toBeCloseTo(online?.height ?? 0, 0);
      expect(cells).toHaveLength(4);
      for (const name of [
        "Vendas em outubro",
        "Resultado estimado",
        "Ticket médio",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: one card after the other
        await expect(region(page, name)).toContainText(NO_CONNECTION);
      }
    });
  }

  test("sem cópia e sem conexão o botão do período está desligado e a frase dos dois meses não aparece nem para o leitor de tela; com a cópia ela aparece", async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[1]);
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    const sentence = page
      .locator("[data-home-period]")
      .getByText("Sem conexão: só este mês e o anterior.");
    await page.context().setOffline(true);
    await expect(sentence).toBeVisible();
    await expect(sentence).not.toHaveAttribute("aria-hidden", "true");
    await page.context().setOffline(false);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(periodButton(page)).toBeDisabled();
    await expect(
      page.getByText("Sem conexão: só este mês e o anterior.")
    ).toHaveCount(0);
  });

  test("loja que já vendeu, sem venda no mês nem antes: aberta sem rede a partir da cópia, o checklist não aparece", async ({
    page,
  }) => {
    const server = new FakeServer({
      days: {},
      everSold: true,
      goals: [],
      soldWithoutCost: 0,
      stock: { all: 1, unknownCost: 0, withoutStock: 0, withStock: 1 },
    });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    await expect
      .poll(async () => (await copyKeys(page)).length)
      .toBeGreaterThan(0);
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await reopenWithoutNetwork(page, server);
    await expect(page.getByText(CONFIRMED, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(region(page, "Vendas em outubro")).toBeVisible();
    await expect(region(page, "Primeiros passos")).toHaveCount(0);
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
  });

  for (const [hours, stale] of [
    [23, false],
    [25, true],
  ] as const) {
    test(`cópia de ${hours} h: ${stale ? "diz que pode estar desatualizada" : "sem o aviso de idade"}, e o Hoje não é de outro dia`, async ({
      page,
    }) => {
      const server = new FakeServer(SOLD);
      await openWithCopy(page, server);
      await reopenWithoutNetwork(page, server, NOON + hours * HOUR);
      const line = page.locator("#home-updated");
      await expect(line).toContainText(CONFIRMED, { timeout: 20_000 });
      if (stale) {
        await expect(line).toContainText("pode estar desatualizado");
      } else {
        await expect(line).not.toContainText("desatualizados");
      }
      await expect(region(page, "Vendas hoje")).toContainText(
        "Sem números de hoje"
      );
      await expect(region(page, "Vendas hoje")).not.toContainText("R$ 320,10");
      // the month is still the confirmed one, said as such
      await expect(region(page, "Vendas em outubro")).toContainText(
        "R$ 2.660,60"
      );
    });
  }

  test("relógio do aparelho atrasado: a idade e o Hoje seguem o horário do servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON - 2 * DAY);
    await expect(page.locator("#home-updated")).toContainText(
      "pode estar desatualizado",
      { timeout: 20_000 }
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
  });

  test("meta guardada: no último dia em andamento, no dia seguinte 'Esta meta terminou'", async ({
    page,
  }) => {
    const server = new FakeServer({
      ...SOLD,
      goals: [goal({ endsOn: "2026-10-24", startsOn: "2026-10-18" })],
    });
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + DAY);
    await expect(region(page, "Meta")).toContainText("53,4%", {
      timeout: 20_000,
    });
    await page.clock.setSystemTime(new Date(NOON + 2 * DAY));
    await page.reload();
    await expect(region(page, "Meta")).toContainText(
      "Esta meta terminou. O resultado sai com conexão.",
      { timeout: 20_000 }
    );
    await expect(region(page, "Meta")).not.toContainText("%");
  });

  test("cópia antiga sem a série: os totais aparecem e nada da série é desenhado", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (!new RegExp(pattern).test(key)) {
          continue;
        }
        const kept = JSON.parse(localStorage.getItem(key) ?? "{}");
        if (kept.summary) {
          kept.summary.daily = undefined;
        }
        if (kept.before) {
          kept.before.daily = undefined;
        }
        localStorage.setItem(key, JSON.stringify(kept));
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60",
      {
        timeout: 20_000,
      }
    );
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
    await expect(region(page, "Vendas por dia")).toHaveCount(0);
    await expect(page.getByText("a mais que no mesmo período")).toHaveCount(0);
  });

  test("cópia malformada: descartada, vale como sem cópia (Sem conexão), e a tela não cai", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("polaris.offline.home.")) {
          localStorage.setItem(key, '{"before":{"period":1},"goal":');
        }
      }
    });
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(newSale(page)).toBeVisible();
  });

  test("troca de usuário no mesmo navegador: nenhum número de A aparece para B", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    // A's session ends with no "Sair" (it expired): B signs in on the same browser, with B's own store
    server.user = { email: "outra@exemplo.com.br", id: "outra-pessoa" };
    server.organization = {
      ...server.organization,
      id: "0199c2d0-0000-7000-8000-00000000b002",
      name: "Loja da outra pessoa",
    };
    server.scenario = { ...SOLD, days: {}, everSold: false };
    await page.reload();
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible({
      timeout: 20_000,
    });
    await page.context().setOffline(true);
    await expect(
      page
        .locator("#home-updated, #home-new-sale-offline")
        .filter({ hasText: "Sem internet" })
        .first()
    ).toBeVisible();
    await expect(page.getByText("R$ 320,10")).toHaveCount(0);
    await expect(page.getByText("R$ 2.660,60")).toHaveCount(0);
    await expect(page.getByText("Camiseta básica")).toHaveCount(0);
  });

  test("a meia-noite da loja passa com a página aberta sem rede: o Hoje da cópia deixa de valer", async ({
    page,
  }) => {
    // 23:50 of `23/10` in Brasília
    const lateEvening = Date.parse("2026-10-24T02:50:00.000Z");
    const server = new FakeServer(SOLD);
    server.now = lateEvening;
    await page.clock.install({ time: new Date(lateEvening) });
    await serve(page, server);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    await expect.poll(() => copyKeys(page)).toHaveLength(3);
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await page.context().setOffline(true);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await page.clock.runFor(15 * 60_000);
    await expect(region(page, "Vendas hoje")).toContainText(
      "Sem números de hoje"
    );
    await expect(region(page, "Vendas em outubro")).toContainText(
      "R$ 2.660,60"
    );
  });

  test("aberto sem rede, a rede volta: a cópia fica na tela até a leitura responder, sem esqueleto", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    // the network is back, and the server takes its time to answer
    server.broken.set("report/periodSummary", "slow");
    server.down = false;
    const asked = periodCalls(server).length;
    await page.clock.runFor(10_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(asked);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expect(page.getByText(CONFIRMED)).toBeVisible();
    server.broken.delete("report/periodSummary");
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("aberto sem rede, a rede volta e o estoque demora: a cópia fica até o estoque responder, com Meta, Gráfico e Ritmo", async ({
    page,
  }) => {
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await reopenWithoutNetwork(page, server, NOON + HOUR);
    const expectParts = () =>
      Promise.all(
        ["Meta", "Vendas por dia", "Ritmo de vendas"].map((name) =>
          expect(region(page, name)).toBeVisible()
        )
      );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    await expectParts();
    // the network is back: the figures answer at once, the stock's read is held
    let answerStock: () => void = () => undefined;
    server.held.set(
      "inventory/listBalances",
      new Promise((resolve) => {
        answerStock = resolve;
      })
    );
    const balances = () =>
      server.calls.filter((call) => call.procedure === "inventory/listBalances")
        .length;
    const asked = periodCalls(server).length;
    server.down = false;
    await page.clock.runFor(10_000);
    await expect.poll(() => periodCalls(server).length).toBeGreaterThan(asked);
    await expect.poll(balances).toBeGreaterThan(0);
    // the stock is asked beside the figures, and held; two frames after the figures' answer the page has rendered it
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    // between the answer of the figures and the stock's: still the copy, no skeleton, nothing leaves
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expectParts();
    answerStock();
    await expect(page.locator("#home-updated")).toContainText(UPDATED_AT);
    await expect(page.getByText("Carregando os números…")).toHaveCount(0);
    await expectParts();
  });

  test("sem cópia a 1280: a mesma grade da tela com cópia, e os cartões não trocam de lugar quando a rede volta", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer({ ...SOLD, goals: [goal({})] });
    await openWithCopy(page, server);
    await page.evaluate((pattern) => {
      for (const key of Object.keys(localStorage)) {
        if (new RegExp(pattern).test(key)) {
          localStorage.removeItem(key);
        }
      }
    }, OFFLINE_KEYS.source);
    await reopenWithoutNetwork(page, server);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION, {
      timeout: 20_000,
    });
    await expect(region(page, "Vendas em outubro")).toContainText(
      NO_CONNECTION
    );
    const places = async () => ({
      goal: await region(page, "Meta").boundingBox(),
      month: await region(page, "Vendas em outubro").boundingBox(),
      today: await region(page, "Vendas hoje").boundingBox(),
    });
    const before = await places();
    expect(before.month?.y).toBe(before.today?.y);
    expect(before.month?.x ?? 0).toBeGreaterThan(
      (before.today?.x ?? 0) + (before.today?.width ?? 0) - 1
    );
    const bottom = (before.month?.y ?? 0) + (before.month?.height ?? 0);
    expect(before.goal?.y ?? 0).toBeGreaterThan(bottom);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);

    server.down = false;
    await page.clock.runFor(10_000);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 20_000,
    });
    const after = await places();
    // the sentence under "Nova venda" goes with the connection and moves the row by a few pixels: the order does not
    expect(after.today?.x).toBe(before.today?.x);
    expect(after.month?.x).toBe(before.month?.x);
    expect(after.month?.y).toBe(after.today?.y);
  });

  test("o servidor recusa os números (FORBIDDEN): a cópia da loja é apagada e não volta sem rede", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);
    await page.context().setOffline(true);
    await expect(region(page, "Vendas hoje")).toContainText(NO_CONNECTION);
    await expect(page.getByText("R$ 320,10")).toHaveCount(0);
  });

  test("Sair apaga a cópia do Início antes de sair (A, B e a série do mapa do aparelho)", async ({
    page,
  }) => {
    // "Sair" in the menu of the store, in the header
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await page.getByRole("button", { name: STORE_MENU_NAME }).click();
    await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
    await expect.poll(() => server.signOutCalls).toBe(1);
    // the page leaves while this is asked: a question cut by the navigation is asked again
    await expect
      .poll(() => copyKeys(page).catch(() => ["navegando"]))
      .toEqual([]);
  });

  test("Sair com a leitura do mapa em voo: a resposta que chega depois não grava a série de novo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const server = new FakeServer(SOLD);
    let answerSeries: () => void = () => undefined;
    server.held.set(
      "report/dailySales",
      new Promise((resolve) => {
        answerSeries = resolve;
      })
    );
    // what the page does to the device's storage and when the series reaches it, told from inside the page: while the
    // page that "Sair" opens waits, the Início cannot be asked anything, but it still runs
    const seen: string[] = [];
    await page.exposeFunction("seenByTest", (what: string) => {
      seen.push(what);
    });
    await page.addInitScript(() => {
      const tell = (what: string) =>
        (
          window as unknown as { seenByTest: (what: string) => void }
        ).seenByTest(what);
      const { setItem } = Storage.prototype;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("polaris.offline.dailySales.")) {
          tell("kept");
        }
        setItem.call(this, key, value);
      };
      const read = window.fetch;
      window.fetch = async (...args) => {
        const answer = await read(...args);
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (url.includes("/rpc/report/dailySales")) {
          tell("answered");
        }
        return answer;
      };
    });
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(page.locator(".sync-status").first()).toContainText(SYNCED, {
      timeout: 20_000,
    });
    await expect
      .poll(() =>
        server.calls.some((call) => call.procedure === "report/dailySales")
      )
      .toBe(true);
    // the page that "Sair" opens waits: the Início stays alive, already leaving, while the series comes
    let leave: () => void = () => undefined;
    const left = new Promise<void>((resolve) => {
      leave = resolve;
    });
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) {
        await left;
      }
      await route.fallback();
    });
    await page.getByRole("button", { name: STORE_MENU_NAME }).click();
    await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
    await expect.poll(() => server.signOutCalls).toBe(1);

    answerSeries();
    await expect.poll(() => seen).toContain("answered");
    // the answer is read in the same turn; a real second more, and the copy was still not kept
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(seen).toEqual(["answered"]);
    leave();
    await expect
      .poll(() => copyKeys(page).catch(() => ["navegando"]))
      .toEqual([]);
  });
});

/** Remembers, in the page, whether the error of the figures ever showed up (even for a frame). */
async function watchFiguresError(page: Page) {
  await page.addInitScript(() => {
    const seen = () =>
      document.body?.textContent?.includes(
        "Não foi possível carregar os números da loja."
      ) === true;
    const observer = new MutationObserver(() => {
      if (seen()) {
        (window as unknown as { figuresErrorSeen: boolean }).figuresErrorSeen =
          true;
      }
    });
    document.addEventListener("DOMContentLoaded", () =>
      observer.observe(document.body, { childList: true, subtree: true })
    );
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { figuresErrorSeen?: boolean })
          .figuresErrorSeen === true
    );
}

const SLOW_READ = "Demorando mais que o normal…";

const STALE_COPY = "Não foi possível atualizar agora";

test.describe("paliativo dos 1102: leituras tentadas de novo, em fila e com freio", () => {
  test("(a) as duas primeiras respostas do periodSummary morrem por CPU: o Início abre sem 'Tentar novamente', em menos de 8 s, com o esqueleto no meio", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.diesNext.set("report/periodSummary", 2);
    const errorSeen = await watchFiguresError(page);
    const firstRead = page
      .waitForRequest((request) =>
        request.url().includes("/rpc/report/periodSummary")
      )
      .then(() => performance.now());
    await openHome(page, server);
    await expect(
      page.getByRole("status").filter({ hasText: "Carregando os números…" })
    ).toBeAttached();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 8000,
    });
    expect(performance.now() - (await firstRead)).toBeLessThan(8000);
    expect(await errorSeen()).toBe(false);
    await expect(
      page.getByRole("button", { name: "Tentar novamente" })
    ).toHaveCount(0);
    // the two that died and the two that answered: nothing more
    expect(periodCalls(server)).toHaveLength(4);
  });

  test("passados ~3 s, o esqueleto diz 'Demorando mais que o normal…', sem botão, e os números chegam sem erro", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    // the month and the days before die twice each: the third try of each answers, ~5.5 s after the first
    server.diesNext.set("report/periodSummary", 4);
    const errorSeen = await watchFiguresError(page);
    await openHome(page, server);
    const slow = page.getByRole("status").filter({ hasText: SLOW_READ });
    await expect(slow).toBeVisible({ timeout: 8000 });
    await expect(slow.getByRole("button")).toHaveCount(0);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 10_000,
    });
    await expect(slow).toHaveCount(0);
    expect(await errorSeen()).toBe(false);
    expect(periodCalls(server)).toHaveLength(6);
  });

  test("(b) três mortes seguidas, sem cópia: o erro de hoje com 'Tentar novamente', depois de três tentativas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.broken.set("report/periodSummary", "1102");
    await openHome(page, server);
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Não foi possível carregar os números da loja." });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    // two reads (the month and the days before), three tries each: the error shows with the first to give up
    await expect.poll(() => periodCalls(server).length).toBe(6);
    server.broken.delete("report/periodSummary");
    await alert.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
  });

  test("(b) três mortes seguidas, com cópia: a cópia fica, com 'Mostrando os números de' e o aviso com 'Tentar novamente'", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "1102");
    await page.reload();
    const notice = page.getByRole("status").filter({ hasText: STALE_COPY });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText(
      "Mostrando os números de 12:00. Vendas feitas depois não estão aqui."
    );
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await expect(
      page.getByText("Não foi possível carregar os números da loja.")
    ).toHaveCount(0);
    server.broken.delete("report/periodSummary");
    await notice.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(notice).toHaveCount(0);
    await expect(
      page.getByText("Sexta-feira, 23 de outubro · atualizado às 12:00")
    ).toBeVisible();
  });

  test("(c) na abertura, nunca mais de 4 leituras /rpc em voo, e o get-session antes das leituras da tela", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.latencyMs = 400;
    const flying = { all: 0, maxAll: 0, maxReads: 0, reads: 0 };
    const order: string[] = [];
    const procedureOf = (url: string) => RPC_PATH.exec(new URL(url).pathname);
    const isRead = (url: string) => {
      const match = procedureOf(url);
      return match !== null && READ_PROCEDURES.has(match[1] ?? "");
    };
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/auth/get-session")) {
        order.push("get-session:start");
      }
      if (procedureOf(url) === null) {
        return;
      }
      order.push(`rpc:${procedureOf(url)?.[1]}`);
      flying.all += 1;
      flying.maxAll = Math.max(flying.maxAll, flying.all);
      if (isRead(url)) {
        flying.reads += 1;
        flying.maxReads = Math.max(flying.maxReads, flying.reads);
      }
    });
    const done = (request: { url: () => string }) => {
      const url = request.url();
      if (url.includes("/api/auth/get-session")) {
        order.push("get-session:end");
      }
      if (procedureOf(url) === null) {
        return;
      }
      flying.all -= 1;
      if (isRead(url)) {
        flying.reads -= 1;
      }
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10", {
      timeout: 15_000,
    });
    await expect(region(page, "Meta")).toBeVisible();
    await expect(region(page, "Precisa de ação")).toBeVisible();

    expect(flying.maxReads).toBeLessThanOrEqual(4);
    // the screen's reads leave after the first session lookup ended
    const firstEnd = order.indexOf("get-session:end");
    expect(firstEnd).toBeGreaterThan(-1);
    expect(order.indexOf("rpc:report/periodSummary")).toBeGreaterThan(firstEnd);
    test.info().annotations.push({
      description: `leituras em voo no máximo: ${flying.maxReads}; todas as /rpc (escritas incluídas): ${flying.maxAll}`,
      type: "rpc-em-voo",
    });
  });
});
