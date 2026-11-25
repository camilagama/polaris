/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openSaleAction } from "../../e2e-pwa/sale-detail-fixture";
import { pickDate } from "../date-pickers";
import {
  copyKeys,
  DAY,
  FakeServer,
  NOON,
  openHome,
  openWithCopy,
  periodCalls,
  RETURN_REFRESH_MS,
  refreshButton,
  region,
  SALE_ID,
  SOLD,
  UPDATED_AT,
} from "./shared";

const CANCELLED_NOTICE = /Venda cancelada\./;

/** The reads of B (the days before the month) and of the month (A) of the Início, by the period they asked for. */
const beforeReads = (server: FakeServer) =>
  periodCalls(server).filter((call) => call.input.to === "2026-09-30").length;

const monthReads = (server: FakeServer) =>
  periodCalls(server).filter((call) => call.input.from === "2026-10-01").length;

test.describe("janela anterior do Início: uma leitura por dia da loja (relógio controlado)", () => {
  test("a segunda abertura no mesmo dia lê só o mês; no dia seguinte, as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    expect([beforeReads(server), monthReads(server)]).toEqual([1, 1]);

    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(3);
    expect([beforeReads(server), monthReads(server)]).toEqual([1, 2]);

    server.now = NOON + DAY;
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText(
      "Nenhuma venda ainda"
    );
    expect(periodCalls(server)).toHaveLength(5);
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 3]);
  });

  test("voltar à aba no mesmo dia relê o mês e não a janela anterior", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => monthReads(server)).toBe(2);
    expect(beforeReads(server)).toBe(1);
  });

  test("Atualizar relê as duas, mesmo no mesmo dia", async ({ page }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(2);

    await refreshButton(page).click();

    await expect.poll(() => periodCalls(server).length).toBe(4);
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);
  });

  test("Atualizar pelo teclado: o foco fica no botão, o status diz 'Atualizando…' e depois 'atualizado às', e um segundo Enter não lê de novo", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server);
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server)).toHaveLength(2);
    const updated = page.locator("#home-updated");
    await expect(updated).toHaveAttribute("role", "status");
    await expect(updated).toContainText(UPDATED_AT);
    const busy = page.locator("[aria-busy='true']:has(#home-today)");
    await expect(busy).toHaveCount(0);

    let answer: () => void = () => undefined;
    server.held.set(
      "report/periodSummary",
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const button = refreshButton(page);
    await button.focus();
    await page.keyboard.press("Enter");

    await expect(updated).toHaveText("Atualizando…");
    await expect(busy).toHaveCount(1);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).not.toHaveAttribute("disabled");
    await expect(button).toBeFocused();
    await expect.poll(() => periodCalls(server).length).toBe(4);

    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
    expect(periodCalls(server)).toHaveLength(4);

    answer();
    await expect(updated).toHaveText(UPDATED_AT);
    await expect(busy).toHaveCount(0);
    await expect(button).not.toHaveAttribute("aria-disabled");
    await expect(button).toBeFocused();
    expect(periodCalls(server)).toHaveLength(4);
  });

  test("Tentar novamente depois de uma falha também lê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    // the month fails on the next opening, with the day's copy of B in hand
    server.broken.set("report/periodSummary", "500");
    await page.reload();
    const retry = page.getByRole("button", { name: "Tentar novamente" });
    await expect(retry.first()).toBeVisible({ timeout: 20_000 });
    server.broken.delete("report/periodSummary");
    const asked = periodCalls(server).length;

    await retry.first().click();

    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(periodCalls(server).length).toBe(asked + 2);
  });

  test("com outra janela (a virada do mês), lê as duas", async ({ page }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);

    server.now = Date.parse("2026-11-01T15:00:00.000Z");
    await page.clock.setSystemTime(new Date(server.now));
    await page.reload();
    await expect(region(page, "Vendas em novembro")).toBeVisible();

    expect(periodCalls(server)).toHaveLength(4);
    expect(
      periodCalls(server)
        .slice(2)
        .map((call) => `${call.input.from}..${call.input.to}`)
        .sort()
    ).toEqual(["2026-10-01..2026-10-31", "2026-11-01..2026-11-30"]);
  });

  test("com o relógio do aparelho um dia atrás do servidor, a cópia do dia do aparelho não serve", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openHome(page, server, NOON - DAY);
    // the eve of the server's day: nothing sold on it, and Vendas hoje has no date to say so
    await expect(region(page, "Vendas hoje")).toContainText("R$ 0,00");
    await expect.poll(() => copyKeys(page)).toHaveLength(3);
    // the copy was read on the eve of the server's day while the device clock still says that eve: the copy is
    // the device's today, not the store's, and the month's answer says so
    server.now = NOON;
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);
  });

  test("a loja recusa os números: a janela anterior guardada some junto e não volta sem o servidor", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    server.broken.set("report/periodSummary", "403");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => copyKeys(page)).toEqual([]);

    server.broken.delete("report/periodSummary");
    await page.clock.runFor(RETURN_REFRESH_MS);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect(beforeReads(server)).toBe(2);
  });
});

test.describe("janela anterior do Início: o que muda neste aparelho", () => {
  const cancelSale = async (page: Page) => {
    await page.goto(`/sales/detail?saleId=${SALE_ID}`);
    await openSaleAction(page, "Cancelar venda");
    await page.getByRole("button", { name: "Revisar cancelamento" }).click();
    await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
    await expect(page.getByText(CANCELLED_NOTICE)).toBeVisible();
  };

  test("cancelar neste aparelho uma venda de antes do mês: a próxima abertura relê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.saleOccurredOn = "2026-09-12";
    await openWithCopy(page, server);

    await cancelSale(page);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 2]);

    // read again from the server, the copy is of the day again
    await page.reload();
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    expect([beforeReads(server), monthReads(server)]).toEqual([2, 3]);
  });

  test("cancelar uma venda do mês corrente não mexe na janela anterior", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    server.saleOccurredOn = "2026-10-05";
    await openWithCopy(page, server);

    await cancelSale(page);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");

    expect([beforeReads(server), monthReads(server)]).toEqual([1, 2]);
  });
});

test.describe("janela anterior do Início: uma despesa neste aparelho", () => {
  const fillCompetence = async (page: Page, competenceOn: string) => {
    await pickDate(page, "Data de competência", competenceOn);
    await page.getByLabel("Valor (R$)").fill("80");
    await page.getByLabel("Descrição").fill("Conta de luz");
  };
  const registerExpense = async (page: Page, competenceOn: string) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { exact: true, name: "Nova despesa" })
      .click();
    const form = page.getByRole("dialog", {
      exact: true,
      name: "Nova despesa",
    });
    await expect(form).toBeVisible();
    await fillCompetence(page, competenceOn);
    await form
      .getByRole("combobox", { exact: true, name: "Categoria" })
      .click();
    await page.getByRole("option", { exact: true, name: "Aluguel" }).click();
    await page.getByRole("button", { name: "Registrar despesa" }).click();
    await expect(page.getByText("Despesa registrada.")).toBeVisible();
  };
  const editExpense = async (page: Page, competenceOn: string) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { name: "Editar despesa Conta de luz" })
      .click();
    await pickDate(page, "Data de competência", competenceOn);
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.getByText("Despesa atualizada.")).toBeVisible();
  };
  const voidExpense = async (page: Page) => {
    await page.goto("/expenses");
    await page
      .getByRole("button", { name: "Mais ações para Conta de luz" })
      .click();
    await page
      .getByRole("menuitem", { name: "Anular despesa Conta de luz" })
      .click();
    await expect(
      page.getByText("Despesa “Conta de luz” anulada.")
    ).toBeVisible();
  };
  const seeded = (competenceOn: string) => {
    const server = new FakeServer(SOLD);
    server.expenses.push({
      competenceOn,
      description: "Conta de luz",
      id: "0199c2d0-0000-7000-8000-0000000000e9",
      status: "active",
      version: 1,
    });
    return server;
  };
  /** Opens the Início again and says how many of the two windows it read: [B, A]. */
  const reopened = async (page: Page, server: FakeServer) => {
    const beforeB = beforeReads(server);
    const beforeA = monthReads(server);
    await page.goto("/");
    await expect(region(page, "Vendas hoje")).toContainText("R$ 320,10");
    return [beforeReads(server) - beforeB, monthReads(server) - beforeA];
  };

  test("registrar com competência de antes do mês: a próxima abertura relê as duas", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await registerExpense(page, "2026-09-15");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("registrar com competência do mês corrente: a janela anterior segue da cópia, só o mês é lido", async ({
    page,
  }) => {
    const server = new FakeServer(SOLD);
    await openWithCopy(page, server);
    await registerExpense(page, "2026-10-03");
    expect(await reopened(page, server)).toEqual([0, 1]);
  });

  test("editar a competência de uma despesa do mês para antes dele: relê as duas", async ({
    page,
  }) => {
    const server = seeded("2026-10-05");
    await openWithCopy(page, server);
    await editExpense(page, "2026-09-15");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("editar a competência de uma despesa de antes do mês para dentro dele: relê as duas", async ({
    page,
  }) => {
    const server = seeded("2026-09-15");
    await openWithCopy(page, server);
    await editExpense(page, "2026-10-05");
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("anular uma despesa de antes do mês: relê as duas", async ({ page }) => {
    const server = seeded("2026-09-15");
    await openWithCopy(page, server);
    await voidExpense(page);
    expect(await reopened(page, server)).toEqual([1, 1]);
  });

  test("anular uma despesa do mês corrente: a janela anterior segue da cópia", async ({
    page,
  }) => {
    const server = seeded("2026-10-05");
    await openWithCopy(page, server);
    await voidExpense(page);
    expect(await reopened(page, server)).toEqual([0, 1]);
  });
});
